import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import type { TransactionIdPage } from './roundwatch-indexer.js';
import { IndexerHealthProbe, type IndexerCapabilityEvidence } from './roundwatch-health-probe.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   SettlementReconciler,
   type IndexedAssetTransfer,
   type SettlementLookupIndexer,
} from './roundwatch-reconciler.js';
import { RoundWatchStore, type SettlementIntent, type WatchRecord, type WatchSpec } from './roundwatch-store.js';
import { ShutdownInterrupted, isShutdownInterrupted } from './roundwatch-shutdown.js';
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

test('C3 reconciliation sessions are reclaimed through terminal churn even with an empty due set', async () => {
   const now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   indexer.round = 901;
   const worker = reconciler(store, indexer, () => now);
   const sessions = absenceProofSessions(worker);
   const states = ['settlement_unknown', 'active', 'matched', 'expired', 'indeterminate'] as const;
   try {
      for (let i = 0; i < 25; i += 1) {
         const transaction = `C3_CHURN_${i}`;
         const watch = store.prepareWatch(
            { ...SPEC, idempotencyKey: `c3-reconcile-churn-${i}` }, terms(transaction),
         ).watch;
         indexer.pages.push({ transactions: [], currentRound: 901, nextToken: `page-${i}` });
         await worker.reconcileOnce();
         assert.equal(sessions.size, 1);
         assert.equal(sessions.get(watch.id)?.nextToken, `page-${i}`);
         const state = states[i % states.length]!;
         if (state === 'settlement_unknown') store.markSettlementInvalid(watch.id);
         else {
            store.activateWatch(watch.id, { transaction, network: ALGORAND_TESTNET, payer: PAYER }, 850);
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
         assert.equal(store.listSettlementReconciliationCandidates().length, 0);
         const requests = indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls;
         assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
         assert.equal(sessions.size, 0, `retained session after churn watch ${i}`);
         assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, requests);
         assert.deepEqual(store.getWatch(watch.id), before);
         if (state === 'active') store.markMatched(watch.id, 'INVOICE', 851);
      }
      assert.equal(indexer.lookupCalls, 25);
      assert.equal(indexer.currentRoundCalls, 25);
      assert.equal(indexer.pageCalls, 25);
   } finally { store.close(); }
});

for (const missing of ['watch', 'expected transaction'] as const) {
   test(`C3 absence-session pruning uses its retained ID point lookup when ${missing} is missing`, async t => {
      const now = new Date('2026-09-18T10:00:00Z');
      const store = new RoundWatchStore(':memory:', { now: () => now });
      const indexer = new FakeLookup();
      indexer.round = 901;
      const worker = reconciler(store, indexer, () => now);
      const sessions = absenceProofSessions(worker);
      try {
         const watch = store.prepareWatch(SPEC, terms('C3_MISSING')).watch;
         indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'page-2' });
         await worker.reconcileOnce();
         assert.equal(sessions.size, 1);
         const getWatch = store.getWatch.bind(store);
         const { expectedServiceTransaction: _transaction, ...withoutTransaction } = getWatch(watch.id)!;
         // Simulate the durable point-read result for a removed/legacy row.
         const pointReads = t.mock.method(store, 'getWatch', (id: string) => {
            assert.equal(id, watch.id);
            return missing === 'watch' ? undefined : withoutTransaction;
         });
         assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
         assert.equal(sessions.size, 0);
         assert.equal(pointReads.mock.callCount(), 1);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.equal(indexer.pageCalls, 1);
      } finally { store.close(); }
   });
}

for (const state of ['settlement_pending', 'settlement_unknown'] as const) {
   test(`C3 live ${state} absence pagination survives backoff and resumes its token and minimum coverage`, async () => {
      let now = new Date('2026-09-18T10:00:00Z');
      const store = new RoundWatchStore(':memory:', { now: () => now });
      const indexer = new FakeLookup();
      indexer.round = 901;
      const worker = reconciler(store, indexer, () => now);
      const sessions = absenceProofSessions(worker);
      try {
         const watch = store.prepareWatch(SPEC, terms('C3_BACKOFF')).watch;
         if (state === 'settlement_unknown') store.markSettlementUnknown(watch.id);
         indexer.pages.push(
            { transactions: [], currentRound: 901, nextToken: 'page-2' },
            { transactions: [], currentRound: 903, nextToken: 'page-3' },
            { transactions: [], currentRound: 902 },
         );
         await worker.reconcileOnce();
         const session = sessions.get(watch.id)!;
         assert.equal(session.nextToken, 'page-2');
         assert.equal(session.coverage, 901);
         assert.deepEqual([...session.seenTokens], ['page-2']);
         const deferred = store.getWatch(watch.id)!;
         assert.equal(deferred.state, state);
         assert.equal(deferred.reconciliationNextAttemptAt, '2026-09-18T10:00:01.000Z');
         assert.equal(deferred.workUnitsUsed, 1);
         assert.equal(store.listSettlementReconciliationCandidates().length, 0);
         assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
         assert.equal(sessions.get(watch.id), session);
         assert.deepEqual(store.getWatch(watch.id), deferred);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.deepEqual(indexer.pageTokens, [undefined]);

         now = new Date('2026-09-18T10:00:01Z');
         const continued = await worker.reconcileOnce();
         assert.deepEqual(continued, {
            attempted: 1, succeeded: 0, failed: 0, providerEvidenceOnly: 1, providerEvidence: 1,
         });
         assert.equal(sessions.get(watch.id), session);
         assert.equal(session.nextToken, 'page-3');
         assert.equal(session.coverage, 901);
         assert.deepEqual([...session.seenTokens], ['page-2', 'page-3']);
         assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 2);

         now = new Date('2026-09-18T10:00:03Z');
         const completed = await worker.reconcileOnce();
         assert.deepEqual(completed, { attempted: 1, succeeded: 1, failed: 0, providerEvidence: 1 });
         assert.equal(sessions.size, 0);
         const terminal = store.getWatch(watch.id)!;
         assert.equal(terminal.state, 'settlement_unknown');
         assert.equal(terminal.settlementReconciliationTerminal, true);
         assert.equal(terminal.workUnitsUsed, 3);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.deepEqual(indexer.pageTokens, [undefined, 'page-2', 'page-3']);
         assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, 5);
      } finally { store.close(); }
   });
}

for (const failure of ['stalled', 'repeated'] as const) {
   test(`C3 retained absence pagination still rejects ${failure} tokens and releases its session`, async () => {
      const store = new RoundWatchStore(':memory:');
      const indexer = new FakeLookup();
      indexer.round = 901;
      const worker = reconciler(store, indexer);
      const sessions = absenceProofSessions(worker);
      try {
         const watch = store.prepareWatch(SPEC, terms('C3_BAD_TOKEN')).watch;
         indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'page-2' });
         if (failure === 'repeated') {
            indexer.pages.push({ transactions: [], currentRound: 902, nextToken: 'page-3' });
         }
         indexer.pages.push({ transactions: [], currentRound: 903, nextToken: 'page-2' });
         await worker.reconcileOnce();
         if (failure === 'repeated') {
            store.recordReconciliationFailure(watch.id, new Date(0));
            await worker.reconcileOnce();
         }
         assert.equal(sessions.size, 1);
         store.recordReconciliationFailure(watch.id, new Date(0));
         assert.deepEqual(await worker.reconcileOnce(), { attempted: 1, succeeded: 0, failed: 1 });
         assert.equal(sessions.size, 0);
         const unresolved = store.getWatch(watch.id)!;
         assert.equal(unresolved.state, 'settlement_pending');
         assert.equal(unresolved.settlementReconciliationTerminal, false);
         assert.equal(unresolved.workUnitsUsed, failure === 'stalled' ? 2 : 3);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.deepEqual(indexer.pageTokens, failure === 'stalled'
            ? [undefined, 'page-2'] : [undefined, 'page-2', 'page-3']);
      } finally { store.close(); }
   });
}

for (const transition of ['terminalized', 'activated'] as const) {
   test(`C3 retained absence session cannot authorize a stale ${transition} candidate`, async t => {
      const now = new Date('2026-09-18T10:00:00Z');
      const store = new RoundWatchStore(':memory:', { now: () => now });
      const indexer = new FakeLookup();
      indexer.round = 901;
      const worker = reconciler(store, indexer, () => now);
      const sessions = absenceProofSessions(worker);
      try {
         const watch = store.prepareWatch(SPEC, terms('C3_STALE_SESSION')).watch;
         indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'page-2' });
         await worker.reconcileOnce();
         assert.equal(sessions.size, 1);
         store.recordReconciliationFailure(watch.id, new Date(0));
         const listCandidates = store.listSettlementReconciliationCandidates.bind(store);
         let before: WatchRecord | undefined;
         t.mock.method(store, 'listSettlementReconciliationCandidates', () => {
            const candidates = listCandidates();
            assert.equal(candidates.length, 1);
            if (transition === 'terminalized') store.markSettlementInvalid(watch.id);
            else store.activateWatch(watch.id, {
               transaction: 'C3_STALE_SESSION', network: ALGORAND_TESTNET, payer: PAYER,
            }, 850);
            before = store.getWatch(watch.id)!;
            return candidates;
         });
         assert.deepEqual(await worker.reconcileOnce(), { attempted: 1, succeeded: 0, failed: 0, noOp: 1 });
         assert.equal(sessions.size, 0);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.equal(indexer.pageCalls, 1);
         assert.deepEqual(store.getWatch(watch.id), before);
      } finally { store.close(); }
   });
}

test('C3 an absence session created by a stopped turn is pruned on the next sweep after activation', async t => {
   const now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   indexer.round = 901;
   const worker = reconciler(store, indexer, () => now);
   const sessions = absenceProofSessions(worker);
   let releasePage!: (page: TransactionIdPage) => void;
   const pageResult = new Promise<TransactionIdPage>(resolve => { releasePage = resolve; });
   let signalAwaited!: () => void;
   const awaited = new Promise<void>(resolve => { signalAwaited = resolve; });
   t.mock.method(indexer, 'searchTransactionPage', async () => {
      indexer.pageCalls += 1;
      signalAwaited();
      return pageResult;
   });
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   try {
      const watch = store.prepareWatch(SPEC, terms('C3_IN_FLIGHT')).watch;
      sweep = worker.reconcileOnce();
      await awaited;
      assert.equal(sessions.size, 1);
      worker.stop();
      const active = store.activateWatch(watch.id, {
         transaction: 'C3_IN_FLIGHT', network: ALGORAND_TESTNET, payer: PAYER,
      }, 850);
      releasePage({ transactions: [], currentRound: 901, nextToken: 'page-2' });
      assert.deepEqual(await sweep, {
         attempted: 1, succeeded: 0, failed: 0, providerEvidenceOnly: 1, providerEvidence: 1,
      });
      assert.equal(sessions.size, 1);
      assert.deepEqual(store.getWatch(watch.id), active);
      assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, 3);
      assert.equal(worker.healthSnapshot().started, false);
      assert.equal(worker.healthSnapshot().generation, 1);
      assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
      assert.equal(sessions.size, 0);
   } finally {
      releasePage({ transactions: [], currentRound: 901, nextToken: 'page-2' });
      await sweep;
      worker.stop();
      store.close();
   }
});

test('C3 P3 stopped reconciler skips final retained-session reads after SQLite closes', async t => {
   const now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   indexer.round = 901;
   const worker = reconciler(store, indexer, () => now);
   const sessions = absenceProofSessions(worker);
   let release!: (value: IndexedAssetTransfer) => void;
   const lookup = new Promise<IndexedAssetTransfer>(resolve => { release = resolve; });
   let entered!: () => void;
   const requested = new Promise<void>(resolve => { entered = resolve; });
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   let closed = false;
   let readsBeforeClose = 0;
   try {
      const watch = store.prepareWatch(SPEC, terms('C3_P3_RETAINED')).watch;
      indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'retained-page' });
      await worker.reconcileOnce();
      const session = sessions.get(watch.id);
      assert.ok(session);
      store.prepareWatch({ ...SPEC, idempotencyKey: 'c3-p3-awaiting' }, terms('AWAITING'));
      t.mock.method(indexer, 'lookupAssetTransfer', () => {
         indexer.lookupCalls += 1;
         entered();
         return lookup;
      });
      const reads = t.mock.method(store, 'getWatch');
      sweep = worker.reconcileOnce(() => {
         // Reconciliation has existing post-provider writes; close only once those
         // finish, so this test isolates the new C3 final read from undrained writes.
         readsBeforeClose = reads.mock.callCount();
         store.close();
         closed = true;
      });
      await requested;
      worker.stop();
      const stoppedHealth = worker.healthSnapshot();
      release(transfer('AWAITING'));
      assert.deepEqual(await sweep, { attempted: 1, succeeded: 1, failed: 0, providerEvidence: 1 });
      assert.ok(closed);
      assert.equal(reads.mock.callCount(), readsBeforeClose);
      assert.equal(sessions.get(watch.id), session);
      assert.deepEqual(worker.healthSnapshot(), stoppedHealth);
      assert.equal(indexer.lookupCalls, 2);
      assert.equal(indexer.pageCalls, 1);
   } finally {
      release(transfer('AWAITING'));
      try { await sweep; } finally {
         worker.stop();
         if (!closed) store.close();
      }
   }
});

test('C3 P3 valid-generation final reconciliation pruning errors remain visible', async t => {
   const now = new Date('2026-09-18T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   indexer.round = 901;
   const worker = reconciler(store, indexer, () => now);
   try {
      const watch = store.prepareWatch(SPEC, terms('C3_P3_PRUNING_FAILURE')).watch;
      indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'retained-page' });
      await worker.reconcileOnce();
      const getWatch = store.getWatch.bind(store);
      const failure = new Error('final reconciliation pruning store failure');
      const health = worker.healthSnapshot();
      let reads = 0;
      const pruning = t.mock.method(store, 'getWatch', (id: string) => {
         reads += 1;
         if (reads === 2) throw failure;
         return getWatch(id);
      });
      await assert.rejects(worker.reconcileOnce(), error => error === failure);
      assert.equal(reads, 2);
      assert.deepEqual(worker.healthSnapshot(), health);
      assert.equal(absenceProofSessions(worker).size, 1);
      pruning.mock.restore();
      assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 }, 'failure releases the running flag');
      assert.equal(indexer.lookupCalls, 1);
      assert.equal(indexer.pageCalls, 1);
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

test('S1 terminal reconciliation rejects direct work before store access and cannot restart', async t => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup();
   const worker = reconciler(store, indexer);
   try {
      const reads = t.mock.method(store, 'getWatch');
      const candidates = t.mock.method(store, 'listSettlementReconciliationCandidates');
      const claims = t.mock.method(store, 'claimWorkUnit');
      worker.stopScheduling();
      const stopped = worker.healthSnapshot();
      await assert.rejects(worker.reconcileOnce(), isShutdownInterrupted);
      worker.start();
      worker.stopScheduling();
      const drained = worker.drain();
      assert.equal(worker.drain(), drained);
      await drained;
      assert.equal(reads.mock.callCount(), 0);
      assert.equal(candidates.mock.callCount(), 0);
      assert.equal(claims.mock.callCount(), 0);
      assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, 0);
      assert.deepEqual(worker.healthSnapshot(), stopped);
      assert.equal(stopped.ready, false);
      assert.equal(stopped.started, false);
   } finally { store.close(); }
});

test('S1 reconciliation drain owns direct work and preserves dispatched activation while fencing the next candidate', async t => {
   const now = new Date('2026-10-06T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   const response = shutdownGate<IndexedAssetTransfer | undefined>();
   const requested = shutdownGate<void>();
   t.mock.method(indexer, 'lookupAssetTransfer', async (transaction: string) => {
      indexer.lookupCalls += 1;
      assert.equal(transaction, 'S1_FIRST');
      requested.resolve();
      return response.promise;
   });
   const worker = reconciler(store, indexer, () => now);
   let sweep: Promise<unknown> | undefined;
   let drained: Promise<void> | undefined;
   try {
      const first = store.prepareWatch(SPEC, terms('S1_FIRST')).watch;
      const second = store.prepareWatch({ ...SPEC, idempotencyKey: 's1-second' }, terms('S1_SECOND')).watch;
      const claims = t.mock.method(store, 'claimWorkUnit');
      const retries = t.mock.method(store, 'recordReconciliationFailure');
      sweep = worker.reconcileOnce();
      const interrupted = assert.rejects(sweep, isShutdownInterrupted);
      await requested.promise;
      const claimed = store.getWatch(first.id)!;
      // The overlap guard remains a no-op and does not claim another unit.
      assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
      worker.stopScheduling();
      const stopped = worker.healthSnapshot();
      let drainSettled = false;
      drained = worker.drain();
      void drained.then(() => { drainSettled = true; });
      await Promise.resolve();
      assert.equal(drainSettled, false);
      assert.equal(claims.mock.callCount(), 1);
      response.resolve(transfer('S1_FIRST'));
      await interrupted;
      await drained;
      assert.deepEqual(store.getWatch(first.id), {
         ...claimed, state: 'active', serviceTransaction: 'S1_FIRST',
         serviceNetwork: ALGORAND_TESTNET, servicePayer: PAYER,
         activationRound: 850, activatedAt: now.toISOString(), scanAfterRound: 850,
      });
      assert.deepEqual(store.getWatch(second.id), second);
      assert.equal(retries.mock.callCount(), 0);
      assert.equal(claims.mock.callCount(), 1);
      assert.equal(indexer.lookupCalls, 1);
      assert.equal(indexer.currentRoundCalls + indexer.pageCalls, 0);
      assert.deepEqual(worker.healthSnapshot(), stopped);
   } finally {
      response.resolve(transfer('S1_FIRST'));
      await sweep?.catch(() => {});
      await drained;
      await worker.drain();
      store.close();
   }
});

for (const boundary of ['lookup', 'tip'] as const) {
   test(`S1 absent reconciliation ${boundary} cannot acquire its dependent request after stop or persist a retry`, async t => {
      const store = new RoundWatchStore(':memory:');
      const indexer = new FakeLookup();
      const requested = shutdownGate<void>();
      const lookupResponse = shutdownGate<IndexedAssetTransfer | undefined>();
      const tipResponse = shutdownGate<number>();
      if (boundary === 'lookup') {
         t.mock.method(indexer, 'lookupAssetTransfer', async () => {
            indexer.lookupCalls += 1;
            requested.resolve();
            return lookupResponse.promise;
         });
      } else {
         t.mock.method(indexer, 'getCurrentRound', async () => {
            indexer.currentRoundCalls += 1;
            requested.resolve();
            return tipResponse.promise;
         });
      }
      const probe = new IndexerHealthProbe({
         async probeReadinessCapabilities() { return { polling: true, reconciliation: true }; },
      }, TESTNET_USDC_ASSET_ID);
      const worker = new SettlementReconciler(store, indexer, {
         network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
      }, undefined, probe);
      let sweep: Promise<unknown> | undefined;
      try {
         const watch = store.prepareWatch(SPEC, terms('S1_DEPENDENT')).watch;
         const retries = t.mock.method(store, 'recordReconciliationFailure');
         const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
         sweep = worker.reconcileOnce();
         const interrupted = assert.rejects(sweep, isShutdownInterrupted);
         await requested.promise;
         const claimed = store.getWatch(watch.id)!;
         worker.stopScheduling();
         const stopped = worker.healthSnapshot();
         lookupResponse.resolve(undefined);
         tipResponse.resolve(901);
         await interrupted;
         await worker.drain();
         assert.deepEqual(store.getWatch(watch.id), claimed);
         assert.equal(claimed.workUnitsUsed, watch.workUnitsUsed + 1);
         assert.equal(retries.mock.callCount(), 0);
         assert.equal(invalidations.mock.callCount(), 0);
         assert.equal(probe.currentFailureEpoch(), 0);
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, boundary === 'tip' ? 1 : 0);
         assert.equal(indexer.pageCalls, 0);
         assert.deepEqual(worker.healthSnapshot(), stopped);
      } finally {
         lookupResponse.resolve(undefined);
         tipResponse.resolve(901);
         await sweep?.catch(() => {});
         await worker.drain();
         store.close();
      }
   });
}

for (const result of ['confirmed', 'absent', 'pagination'] as const) {
   test(`S1 already-dispatched reconciliation search may persist valid ${result} evidence after terminal stop`, async t => {
      const now = new Date('2026-10-06T10:00:00Z');
      const store = new RoundWatchStore(':memory:', { now: () => now });
      const indexer = new FakeLookup();
      indexer.round = 901;
      const response = shutdownGate<TransactionIdPage>();
      const requested = shutdownGate<void>();
      t.mock.method(indexer, 'searchTransactionPage', async () => {
         indexer.pageCalls += 1;
         requested.resolve();
         return response.promise;
      });
      const page: TransactionIdPage = result === 'confirmed'
         ? { transactions: [transfer('S1_PAGE')], currentRound: 901 }
         : { transactions: [], currentRound: 901, ...(result === 'pagination' ? { nextToken: 'next-page' } : {}) };
      const worker = reconciler(store, indexer, () => now);
      let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
      try {
         const watch = store.prepareWatch(SPEC, terms('S1_PAGE')).watch;
         sweep = worker.reconcileOnce();
         await requested.promise;
         const claimed = store.getWatch(watch.id)!;
         worker.stopScheduling();
         const stopped = worker.healthSnapshot();
         const drained = worker.drain();
         response.resolve(page);
         const outcome = await sweep;
         await drained;
         assert.equal(outcome.attempted, 1);
         assert.equal(outcome.failed, 0);
         assert.equal(outcome.providerEvidence, 1);
         if (result === 'confirmed') {
            assert.deepEqual(store.getWatch(watch.id), {
               ...claimed, state: 'active', serviceTransaction: 'S1_PAGE',
               serviceNetwork: ALGORAND_TESTNET, servicePayer: PAYER,
               activationRound: 850, activatedAt: now.toISOString(), scanAfterRound: 850,
            });
            assert.equal(absenceProofSessions(worker).size, 0);
         } else if (result === 'absent') {
            assert.deepEqual(store.getWatch(watch.id), {
               ...claimed, state: 'settlement_unknown', settlementReconciliationTerminal: true,
            });
            assert.equal(absenceProofSessions(worker).size, 0);
         } else {
            assert.deepEqual(store.getWatch(watch.id), {
               ...claimed, reconciliationAttempts: claimed.reconciliationAttempts + 1,
               reconciliationNextAttemptAt: new Date(now.getTime() + 1_000).toISOString(),
            });
            const session = absenceProofSessions(worker).get(watch.id)!;
            assert.equal(session.nextToken, 'next-page');
            assert.equal(session.coverage, 901);
            assert.deepEqual([...session.seenTokens], ['next-page']);
         }
         assert.equal(indexer.lookupCalls, 1);
         assert.equal(indexer.currentRoundCalls, 1);
         assert.equal(indexer.pageCalls, 1);
         assert.deepEqual(worker.healthSnapshot(), stopped);
      } finally {
         response.resolve(page);
         await sweep;
         await worker.drain();
         store.close();
      }
   });
}

test('S1 dispatcher interruption during reconciliation preserves pagination and durable retry state', async t => {
   const now = new Date('2026-10-06T10:00:00Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const indexer = new FakeLookup();
   indexer.round = 901;
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities() { return { polling: true, reconciliation: true }; },
   }, TESTNET_USDC_ASSET_ID);
   const worker = new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000, now: () => now,
   }, undefined, probe);
   try {
      const watch = store.prepareWatch(SPEC, terms('S1_QUEUED_PAGE')).watch;
      indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'retained-page' });
      await worker.reconcileOnce();
      store.recordReconciliationFailure(watch.id, new Date(0));
      const before = store.getWatch(watch.id)!;
      const session = absenceProofSessions(worker).get(watch.id)!;
      const health = worker.healthSnapshot();
      const retries = t.mock.method(store, 'recordReconciliationFailure');
      const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
      const errors = t.mock.method(console, 'error', () => {});
      t.mock.method(indexer, 'searchTransactionPage', async () => {
         throw new ShutdownInterrupted();
      });
      await assert.rejects(worker.reconcileOnce(), isShutdownInterrupted);
      assert.deepEqual(store.getWatch(watch.id), { ...before, workUnitsUsed: before.workUnitsUsed + 1 });
      assert.equal(absenceProofSessions(worker).get(watch.id), session);
      assert.equal(session.nextToken, 'retained-page');
      assert.equal(session.coverage, 901);
      assert.equal(retries.mock.callCount(), 0);
      assert.equal(invalidations.mock.callCount(), 0);
      assert.equal(errors.mock.callCount(), 0);
      assert.deepEqual(worker.healthSnapshot(), health);
   } finally { await worker.drain(); store.close(); }
});

test('S1 reconciler drain owns the complete scheduled wrapper while its health probe is pending', async t => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup();
   const response = shutdownGate<IndexerCapabilityEvidence>();
   const requested = shutdownGate<void>();
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities() { requested.resolve(); return response.promise; },
   }, TESTNET_USDC_ASSET_ID);
   const worker = new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
   }, undefined, probe);
   try {
      const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
      const errors = t.mock.method(console, 'error', () => {});
      worker.start();
      await requested.promise;
      worker.stopScheduling();
      const stopped = worker.healthSnapshot();
      let drainSettled = false;
      const drained = worker.drain();
      void drained.then(() => { drainSettled = true; });
      await Promise.resolve();
      assert.equal(drainSettled, false, 'the direct sweep is done but the scheduled probe is still owned');
      response.reject(new ShutdownInterrupted());
      await drained;
      assert.equal(invalidations.mock.callCount(), 0);
      assert.equal(probe.currentFailureEpoch(), 0);
      assert.equal(probe.currentSample(), undefined);
      assert.equal(errors.mock.callCount(), 0);
      assert.deepEqual(worker.healthSnapshot(), stopped);
      assert.equal(indexer.lookupCalls + indexer.currentRoundCalls + indexer.pageCalls, 0);
   } finally {
      response.resolve({ polling: true, reconciliation: true });
      await worker.drain();
      store.close();
   }
});

test('S1 scheduled reconciliation interruption makes no defer or provider-failure observation', async t => {
   const store = new RoundWatchStore(':memory:');
   const indexer = new FakeLookup();
   const response = shutdownGate<IndexedAssetTransfer | undefined>();
   const requested = shutdownGate<void>();
   t.mock.method(indexer, 'lookupAssetTransfer', async () => {
      indexer.lookupCalls += 1;
      requested.resolve();
      return response.promise;
   });
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities() { throw new Error('interrupted sweep must not probe'); },
   }, TESTNET_USDC_ASSET_ID);
   const worker = new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
   }, undefined, probe);
   try {
      const watch = store.prepareWatch(SPEC, terms('S1_SCHEDULED')).watch;
      const retries = t.mock.method(store, 'recordReconciliationFailure');
      const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
      const errors = t.mock.method(console, 'error', () => {});
      worker.start();
      await requested.promise;
      const claimed = store.getWatch(watch.id)!;
      worker.stopScheduling();
      const stopped = worker.healthSnapshot();
      response.reject(new ShutdownInterrupted());
      await worker.drain();
      assert.deepEqual(store.getWatch(watch.id), claimed);
      assert.equal(retries.mock.callCount(), 0);
      assert.equal(invalidations.mock.callCount(), 0);
      assert.equal(errors.mock.callCount(), 0);
      assert.equal(probe.currentFailureEpoch(), 0);
      assert.deepEqual(worker.healthSnapshot(), stopped);
   } finally {
      response.resolve(undefined);
      await worker.drain();
      store.close();
   }
});

test('S1 ordinary reconciler stop still allows operational restart', async () => {
   const store = new RoundWatchStore(':memory:');
   const worker = reconciler(store, new FakeLookup());
   try {
      worker.start();
      const started = worker.healthSnapshot();
      worker.stop();
      assert.equal(worker.healthSnapshot().started, false);
      worker.start();
      const restarted = worker.healthSnapshot();
      assert.equal(restarted.started, true);
      assert.equal(restarted.generation, started.generation! + 2);
   } finally { await worker.drain(); store.close(); }
});

function shutdownGate<T>(): {
   promise: Promise<T>;
   resolve: (value: T) => void;
   reject: (error: unknown) => void;
} {
   let resolve!: (value: T) => void;
   let reject!: (error: unknown) => void;
   const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
   });
   return { promise, resolve, reject };
}

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
   pageTokens: (string | undefined)[] = [];
   async lookupAssetTransfer(transactionId: string): Promise<IndexedAssetTransfer | undefined> {
      this.lookupCalls += 1;
      if (this.throwFor.has(transactionId)) throw new Error('synthetic lookup failure');
      return this.lookups.get(transactionId);
   }
   async getCurrentRound(): Promise<number> {
      this.currentRoundCalls += 1;
      return this.round;
   }
   async searchTransactionPage(_transactionId: string, nextToken?: string): Promise<TransactionIdPage> {
      this.pageCalls += 1;
      this.pageTokens.push(nextToken);
      const page = this.pages.shift(); if (!page) throw new Error('missing fake absence page'); return page;
   }
}

function absenceProofSessions(worker: SettlementReconciler): Map<string, {
   nextToken?: string;
   seenTokens: Set<string>;
   coverage?: number;
}> {
   return (worker as unknown as {
      absenceProofSessions: Map<string, { nextToken?: string; seenTokens: Set<string>; coverage?: number }>;
   }).absenceProofSessions;
}
