import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import type { TransactionIdPage } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   SettlementReconciler,
   type IndexedAssetTransfer,
   type SettlementLookupIndexer,
} from './roundwatch-reconciler.js';
import { RoundWatchStore, type SettlementIntent, type WatchRecord, type WatchSpec } from './roundwatch-store.js';
import { MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN } from './roundwatch-work-budget.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY';
const SPEC: WatchSpec = { idempotencyKey: 'reconcile-1', expectedSender: PAYER,
   expectedReceiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '1' };
const terms = (tx: string): SettlementIntent => ({ expectedTransaction: tx, network: ALGORAND_TESTNET,
   payer: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', firstValid: 800, lastValid: 900 });
const transfer = (tx: string, overrides: Partial<IndexedAssetTransfer> = {}): IndexedAssetTransfer => ({
   transaction: tx, sender: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', round: 850, ...overrides,
});

test('confirmed exact service transaction establishes the activation baseline from its round', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.lookups.set('SERVICE', transfer('SERVICE'));
   try {
      const watch = store.prepareWatch(SPEC, terms('SERVICE')).watch;
      await reconciler(store, indexer).reconcileOnce();
      const active = store.getWatch(watch.id);
      assert.equal(active?.state, 'active');
      assert.equal(active?.activationRound, 850);
      assert.equal(active?.scanAfterRound, 850);
      assert.equal(active?.serviceAtomicAmount, '1000');
   } finally { store.close(); }
});

test('one candidate error is isolated and a later due candidate still progresses', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.throwFor.add('FAIL'); indexer.lookups.set('GOOD', transfer('GOOD'));
   try {
      const failed = store.prepareWatch(SPEC, terms('FAIL')).watch;
      const good = store.prepareWatch({ ...SPEC, idempotencyKey: 'reconcile-2' }, terms('GOOD')).watch;
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(failed.id)?.state, 'settlement_pending');
      assert.equal(store.getWatch(failed.id)?.reconciliationAttempts, 1);
      assert.equal(store.getWatch(good.id)?.state, 'active');
   } finally { store.close(); }
});

test('ordinary 404 within validity remains recoverable with persisted capped-backoff state', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-backoff-'));
   const path = join(directory, 'watch.sqlite');
   let now = new Date('2026-09-18T10:00:00Z');
   try {
      const store = new RoundWatchStore(path, { now: () => now });
      const watch = store.prepareWatch(SPEC, terms('MISSING')).watch;
      const indexer = new FakeLookup(); indexer.round = 850;
      await reconciler(store, indexer, () => now).reconcileOnce();
      const deferred = store.getWatch(watch.id)!;
      assert.equal(deferred.state, 'settlement_pending');
      assert.equal(deferred.reconciliationAttempts, 1);
      assert.equal(deferred.reconciliationNextAttemptAt, '2026-09-18T10:00:01.000Z');
      store.close();
      const restarted = new RoundWatchStore(path, { now: () => now });
      assert.equal(restarted.listSettlementReconciliationCandidates().length, 0);
      now = new Date('2026-09-18T10:00:01Z');
      assert.equal(restarted.listSettlementReconciliationCandidates().length, 1);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('restart after settlement candidate persistence activates without another payment', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-activation-'));
   const path = join(directory, 'watch.sqlite');
   try {
      const first = new RoundWatchStore(path);
      const watch = first.prepareWatch(SPEC, terms('RECOVER_AFTER_RESTART')).watch;
      first.recordSettlementCandidate(watch.id, {
         transaction: 'RECOVER_AFTER_RESTART', network: ALGORAND_TESTNET, payer: PAYER,
      });
      first.close();
      const restarted = new RoundWatchStore(path);
      const indexer = new FakeLookup();
      indexer.lookups.set('RECOVER_AFTER_RESTART', transfer('RECOVER_AFTER_RESTART', { round: 875 }));
      await reconciler(restarted, indexer).reconcileOnce();
      assert.equal(restarted.getWatch(watch.id)?.activationRound, 875);
      assert.equal(indexer.lookups.size, 1);
      restarted.close();
   } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('covered historical absence after LastValid terminalizes nonpayment but inadequate coverage does not', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.round = 901;
   try {
      const unresolved = store.prepareWatch(SPEC, terms('ABSENT')).watch;
      indexer.pages.push({ transactions: [], currentRound: 900 });
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(unresolved.id)?.state, 'settlement_pending');
      const next = store.getWatch(unresolved.id)!;
      store.recordReconciliationFailure(unresolved.id, new Date(0));
      indexer.pages.push({ transactions: [], currentRound: 901 });
      await reconciler(store, indexer).reconcileOnce();
      assert.equal(store.getWatch(unresolved.id)?.state, 'settlement_unknown');
      assert.ok(next.reconciliationAttempts >= 1);
   } finally { store.close(); }
});

test('one settlement-reconciliation work turn cannot exceed the three-request invariant', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup();
   indexer.round = 901;

   try {
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'reconcile-max-turn' },
         terms('RECONCILE_MAX_TURN'),
      ).watch;
      indexer.pages.push({
         transactions: [],
         currentRound: 901,
      });

      await reconciler(store, indexer).reconcileOnce();

      const requests =
         indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls;
      assert.equal(
         requests,
         MAX_INDEXER_REQUESTS_PER_RECONCILIATION_WORK_TURN,
      );
      assert.equal(store.getWatch(watch.id)?.state, 'settlement_unknown');
   } finally {
      store.close();
   }
});

test('reconciliation pagination consumes bounded work units and exhausts indeterminate', async () => {
   const store = new RoundWatchStore(':memory:', {
      workUnitBudget: 1,
   });
   const indexer = new FakeLookup();
   indexer.round = 901;

   try {
      const watch = store.prepareWatch(
         { ...SPEC, idempotencyKey: 'reconcile-budget-1' },
         terms('BUDGETED_ABSENCE'),
      ).watch;

      indexer.pages.push({
         transactions: [],
         currentRound: 901,
         nextToken: 'page-2',
      });

      await reconciler(store, indexer).reconcileOnce();

      const afterFirst = store.getWatch(watch.id);
      assert.equal(afterFirst?.state, 'settlement_pending');
      assert.equal(afterFirst?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls, 1);

      store.recordReconciliationFailure(watch.id, new Date(0));
      await reconciler(store, indexer).reconcileOnce();

      const exhausted = store.getWatch(watch.id);
      assert.equal(exhausted?.state, 'indeterminate');
      assert.equal(exhausted?.terminalReason, 'work_budget_exhausted');
      assert.equal(exhausted?.workUnitsUsed, 1);
      assert.equal(indexer.pageCalls, 1);
      assert.equal(
         store.listSettlementReconciliationCandidates().length,
         0,
      );
   } finally {
      store.close();
   }
});

test('confirmed incompatible immutable terms fail closed and runtime values cannot rewrite the purchase', async () => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup(); indexer.lookups.set('WRONG', transfer('WRONG', { atomicAmount: '9999' }));
   try {
      const watch = store.prepareWatch(SPEC, terms('WRONG')).watch;
      await reconciler(store, indexer).reconcileOnce();
      const failed = store.getWatch(watch.id);
      assert.equal(failed?.state, 'settlement_unknown');
      assert.equal(failed?.serviceAtomicAmount, '1000');
      assert.equal(store.listSettlementReconciliationCandidates().length, 0);
   } finally { store.close(); }
});

test('legacy candidate lacking immutable evidence stays unresolved instead of receiving fabricated proof', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = store.prepareWatch(SPEC).watch;
      store.recordSettlementCandidate(watch.id, { transaction: 'LEGACY', network: ALGORAND_TESTNET, payer: PAYER });
      // Simulate a pre-hardening record by leaving immutable service terms absent.
      await reconciler(store, new FakeLookup()).reconcileOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'settlement_pending');
   } finally { store.close(); }
});

for (const workUnitBudget of [1, 2]) {
   for (const exhausted of [false, true]) {
      const used = exhausted ? workUnitBudget : workUnitBudget - 1;
      test(`B4 terminal unknown reconciliation claim is inactive with budget ${workUnitBudget}, used ${used}`, () => {
         const store = new RoundWatchStore(':memory:', { workUnitBudget });
         try {
            const watch = store.prepareWatch(SPEC, terms('TERMINAL')).watch;
            for (let i = 0; i < used; i += 1) {
               assert.equal(store.claimWorkUnit(watch.id, 'reconciliation'), 'claimed');
            }
            store.markSettlementInvalid(watch.id);
            const before = store.getWatch(watch.id)!;
            assert.equal(before.state, 'settlement_unknown');
            assert.equal(before.settlementReconciliationTerminal, true);
            assert.equal(store.claimWorkUnit(watch.id, 'reconciliation'), 'inactive');
            assert.deepEqual(store.getWatch(watch.id), before);
         } finally { store.close(); }
      });

      for (const terminalState of ['matched', 'expired', 'indeterminate', 'settlement_unknown'] as const) {
         for (const purpose of ['reconciliation', 'polling'] as const) {
            test(`B4 terminal matrix ${terminalState} rejects ${purpose} with budget ${workUnitBudget}, used ${used}`, () => {
               const store = new RoundWatchStore(':memory:', { workUnitBudget });
               try {
                  const watch = store.prepareWatch(SPEC, terms('MATRIX')).watch;
                  if (terminalState === 'settlement_unknown') {
                     for (let i = 0; i < used; i += 1) {
                        assert.equal(store.claimWorkUnit(watch.id, 'reconciliation'), 'claimed');
                     }
                     store.markSettlementInvalid(watch.id);
                  } else {
                     store.activateWatch(watch.id, {
                        transaction: 'MATRIX', network: ALGORAND_TESTNET, payer: PAYER,
                     }, 850);
                     for (let i = 0; i < used; i += 1) {
                        assert.equal(store.claimWorkUnit(watch.id, 'polling'), 'claimed');
                     }
                     if (terminalState === 'matched') store.markMatched(watch.id, 'INVOICE', 851);
                     else if (terminalState === 'expired') {
                        store.setClosingRound(watch.id, 850);
                        assert.equal(store.markExpired(watch.id, 850, 850), true);
                     } else {
                        store.recordPollingFailure(watch.id, {
                           code: 'synthetic_permanent_failure', disposition: 'permanent',
                        });
                     }
                  }
                  const before = store.getWatch(watch.id)!;
                  assert.equal(before.state, terminalState);
                  assert.equal(before.workUnitsUsed, used);
                  assert.equal(store.claimWorkUnit(watch.id, purpose), 'inactive');
                  assert.deepEqual(store.getWatch(watch.id), before);
               } finally { store.close(); }
            });
         }
      }

      for (const transition of ['terminalized', 'activated'] as const) {
         test(`B4 stale reconciler ${transition} after selection with budget ${workUnitBudget}, used ${used}`, async t => {
            const store = new RoundWatchStore(':memory:', { workUnitBudget });
            const indexer = new FakeLookup();
            indexer.lookups.set('STALE', transfer('STALE'));
            const metrics = new RoundWatchEconomicsMetrics();
            try {
               const watch = store.prepareWatch(SPEC, terms('STALE')).watch;
               for (let i = 0; i < used; i += 1) {
                  assert.equal(store.claimWorkUnit(watch.id, 'reconciliation'), 'claimed');
               }
               metrics.captureWatch(watch.id).recordWorkUnit();
               const listCandidates = store.listSettlementReconciliationCandidates.bind(store);
               let before: WatchRecord | undefined;
               let beforeMetrics: ReturnType<typeof metrics.snapshotWatch>;
               t.mock.method(store, 'listSettlementReconciliationCandidates', () => {
                  const candidates = listCandidates();
                  assert.equal(candidates.length, 1);
                  assert.equal(candidates[0]!.settlementReconciliationTerminal, false);
                  if (transition === 'terminalized') {
                     store.markSettlementInvalid(watch.id);
                     metrics.finishWatch(watch.id);
                  } else {
                     store.activateWatch(watch.id, {
                        transaction: 'STALE', network: ALGORAND_TESTNET, payer: PAYER,
                     }, 850);
                  }
                  before = store.getWatch(watch.id)!;
                  beforeMetrics = metrics.snapshotWatch(watch.id);
                  return candidates;
               });
               const worker = new SettlementReconciler(store, indexer, {
                  network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
               }, metrics);
               const outcome = await worker.reconcileOnce();
               assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, 0);
               assert.deepEqual(outcome, { attempted: 1, succeeded: 0, failed: 0, noOp: 1 });
               assert.ok(before);
               assert.equal(before.state, transition === 'terminalized' ? 'settlement_unknown' : 'active');
               assert.deepEqual(store.getWatch(watch.id), before);
               assert.deepEqual(metrics.snapshotWatch(watch.id), beforeMetrics);
               assert.equal(metrics.activeWatchMetricCount(), transition === 'terminalized' ? 0 : 1);
            } finally { store.close(); }
         });
      }
   }

   for (const state of ['settlement_pending', 'settlement_unknown', 'active'] as const) {
      const purpose = state === 'active' ? 'polling' : 'reconciliation';
      const wrongPurpose = state === 'active' ? 'reconciliation' : 'polling';
      test(`B4 live ${state} claims only ${purpose} and exhausts budget ${workUnitBudget}`, () => {
         const store = new RoundWatchStore(':memory:', { workUnitBudget });
         try {
            const watch = store.prepareWatch(SPEC, terms('LIVE')).watch;
            if (state === 'active') {
               store.activateWatch(watch.id, {
                  transaction: 'LIVE', network: ALGORAND_TESTNET, payer: PAYER,
               }, 850);
            } else if (state === 'settlement_unknown') store.markSettlementUnknown(watch.id);
            for (let i = 0; i < workUnitBudget; i += 1) {
               const before = store.getWatch(watch.id)!;
               assert.equal(store.claimWorkUnit(watch.id, wrongPurpose), 'inactive');
               assert.deepEqual(store.getWatch(watch.id), before);
               assert.equal(store.claimWorkUnit(watch.id, purpose), 'claimed');
               assert.deepEqual(store.getWatch(watch.id), { ...before, workUnitsUsed: i + 1 });
            }
            const beforeExhaustion = store.getWatch(watch.id)!;
            assert.equal(store.claimWorkUnit(watch.id, wrongPurpose), 'inactive');
            assert.deepEqual(store.getWatch(watch.id), beforeExhaustion);
            assert.equal(store.claimWorkUnit(watch.id, purpose), 'exhausted');
            const terminal = store.getWatch(watch.id)!;
            assert.deepEqual(terminal, {
               ...beforeExhaustion, state: 'indeterminate',
               terminalReason: 'work_budget_exhausted', settlementReconciliationTerminal: true,
            });
            assert.equal(store.claimWorkUnit(watch.id, purpose), 'inactive');
            assert.deepEqual(store.getWatch(watch.id), terminal);
         } finally { store.close(); }
      });
   }

   for (const state of ['settlement_pending', 'settlement_unknown'] as const) {
      test(`B4 live reconciler preserves ${state} work and request budget ${workUnitBudget}`, async () => {
         const store = new RoundWatchStore(':memory:', { workUnitBudget });
         const indexer = new FakeLookup();
         indexer.round = 850; // Ordinary absence within validity remains recoverable.
         try {
            const watch = store.prepareWatch(SPEC, terms('RECOVERABLE')).watch;
            if (state === 'settlement_unknown') store.markSettlementUnknown(watch.id);
            const worker = reconciler(store, indexer);
            for (let i = 0; i < workUnitBudget; i += 1) {
               store.recordReconciliationFailure(watch.id, new Date(0));
               const outcome = await worker.reconcileOnce();
               assert.equal(outcome.attempted, 1);
               assert.equal(outcome.failed, 0);
               const current = store.getWatch(watch.id)!;
               assert.equal(current.state, state);
               assert.equal(current.settlementReconciliationTerminal, false);
               assert.equal(current.workUnitsUsed, i + 1);
               assert.equal(indexer.lookupCalls, i + 1);
               assert.equal(indexer.currentRoundCalls, i + 1);
               assert.equal(indexer.pageCalls, 0);
            }
            store.recordReconciliationFailure(watch.id, new Date(0));
            const outcome = await worker.reconcileOnce();
            assert.deepEqual(outcome, { attempted: 1, succeeded: 0, failed: 0, noOp: 1 });
            const terminal = store.getWatch(watch.id)!;
            assert.equal(terminal.state, 'indeterminate');
            assert.equal(terminal.terminalReason, 'work_budget_exhausted');
            assert.equal(terminal.settlementReconciliationTerminal, true);
            assert.equal(terminal.workUnitsUsed, workUnitBudget);
            assert.equal(indexer.lookupCalls, workUnitBudget);
            assert.equal(indexer.currentRoundCalls, workUnitBudget);
            assert.equal(indexer.pageCalls, 0);
         } finally { store.close(); }
      });
   }
}

for (const state of ['active', 'matched', 'expired', 'indeterminate', 'settlement_unknown'] as const) {
   test(`B4 follow-up retry metadata is unchanged for ${state}`, () => {
      const store = new RoundWatchStore(':memory:');
      try {
         const watch = store.prepareWatch(SPEC, terms('RETRY_MATRIX')).watch;
         store.recordReconciliationFailure(watch.id, new Date(0));
         if (state === 'settlement_unknown') store.markSettlementInvalid(watch.id);
         else {
            store.activateWatch(watch.id, {
               transaction: 'RETRY_MATRIX', network: ALGORAND_TESTNET, payer: PAYER,
            }, 850);
            if (state === 'matched') store.markMatched(watch.id, 'INVOICE', 851);
            else if (state === 'expired') {
               store.setClosingRound(watch.id, 850);
               assert.equal(store.markExpired(watch.id, 850, 850), true);
            } else if (state === 'indeterminate') {
               store.recordPollingFailure(watch.id, {
                  code: 'synthetic_permanent_failure', disposition: 'permanent',
               });
            }
         }
         const before = store.getWatch(watch.id)!;
         assert.equal(before.state, state);
         assert.equal(before.settlementReconciliationTerminal, state === 'settlement_unknown');
         if (state === 'indeterminate') assert.equal(before.terminalReason, 'indexer_permanent_failure');
         store.recordReconciliationFailure(watch.id, new Date('2026-09-18T10:00:01.000Z'));
         assert.deepEqual(store.getWatch(watch.id), before);
      } finally { store.close(); }
   });
}

for (const state of ['settlement_pending', 'settlement_unknown'] as const) {
   test(`B4 follow-up live ${state} writes exactly one retry metadata update`, () => {
      const store = new RoundWatchStore(':memory:');
      try {
         const watch = store.prepareWatch(SPEC, terms('LIVE_RETRY')).watch;
         if (state === 'settlement_unknown') store.markSettlementUnknown(watch.id);
         const before = store.getWatch(watch.id)!;
         assert.equal(before.state, state);
         assert.equal(before.settlementReconciliationTerminal, false);
         const nextAttemptAt = new Date('2026-09-18T10:00:01.000Z');
         store.recordReconciliationFailure(watch.id, nextAttemptAt);
         assert.deepEqual(store.getWatch(watch.id), {
            ...before,
            reconciliationAttempts: before.reconciliationAttempts + 1,
            reconciliationNextAttemptAt: nextAttemptAt.toISOString(),
         });
      } finally { store.close(); }
   });
}

test('B4 follow-up stale reconciler defer after claimed work and awaited activation preserves the complete active record', async t => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup();
   let releaseRound!: (round: number) => void;
   const roundResult = new Promise<number>(resolve => { releaseRound = resolve; });
   let signalAwaited!: () => void;
   const awaited = new Promise<void>(resolve => { signalAwaited = resolve; });
   t.mock.method(indexer, 'getCurrentRound', async () => {
      indexer.currentRoundCalls += 1;
      signalAwaited();
      return roundResult;
   });
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   try {
      const watch = store.prepareWatch(SPEC, terms('STALE_RETRY')).watch;
      store.recordReconciliationFailure(watch.id, new Date(0));
      const beforeClaim = store.getWatch(watch.id)!;
      const failure = t.mock.method(store, 'recordReconciliationFailure');
      sweep = reconciler(store, indexer).reconcileOnce();
      await awaited;
      assert.equal(store.getWatch(watch.id)?.state, 'settlement_pending');
      assert.equal(store.getWatch(watch.id)?.workUnitsUsed, beforeClaim.workUnitsUsed + 1);
      assert.equal(indexer.lookupCalls, 1);
      assert.equal(indexer.currentRoundCalls, 1);
      assert.equal(failure.mock.callCount(), 0);
      const active = store.activateWatch(watch.id, {
         transaction: 'STALE_RETRY', network: ALGORAND_TESTNET, payer: PAYER,
      }, 850);
      assert.equal(active.state, 'active');
      assert.equal(active.settlementReconciliationTerminal, false);
      assert.equal(active.reconciliationAttempts, beforeClaim.reconciliationAttempts);
      assert.equal(active.reconciliationNextAttemptAt, beforeClaim.reconciliationNextAttemptAt);

      releaseRound(850); // Absence within validity resumes the real defer() path.
      const outcome = await sweep;
      assert.equal(outcome.attempted, 1);
      assert.equal(outcome.failed, 0);
      assert.equal(outcome.providerEvidenceOnly, 1);
      assert.equal(failure.mock.callCount(), 1);
      assert.deepEqual(store.getWatch(watch.id), active);
      assert.equal(indexer.pageCalls, 0);
   } finally {
      releaseRound(850);
      await sweep;
      store.close();
   }
});

function reconciler(store: RoundWatchStore, indexer: SettlementLookupIndexer, now = () => new Date('2026-09-18T10:00:00Z')): SettlementReconciler {
   return new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
      baseBackoffMilliseconds: 1_000, maxBackoffMilliseconds: 4_000, now,
   });
}

class FakeLookup implements SettlementLookupIndexer {
   round = 0;
   lookups = new Map<string, IndexedAssetTransfer>();
   throwFor = new Set<string>();
   pages: TransactionIdPage[] = [];
   lookupCalls = 0;
   currentRoundCalls = 0;
   pageCalls = 0;
   async lookupAssetTransfer(transactionId: string): Promise<IndexedAssetTransfer | undefined> {
      this.lookupCalls += 1;
      if (this.throwFor.has(transactionId)) throw new Error('synthetic lookup failure');
      return this.lookups.get(transactionId);
   }
   async getCurrentRound(): Promise<number> {
      this.currentRoundCalls += 1;
      return this.round;
   }
   async searchTransactionPage(): Promise<TransactionIdPage> {
      this.pageCalls += 1;
      const page = this.pages.shift(); if (!page) throw new Error('missing fake absence page'); return page;
   }
}
