import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ALGORAND_TESTNET, TESTNET_USDC_ASSET_ID } from './app.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import type { TransactionIdPage } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   SettlementReconciler,
   type IndexedAssetTransfer,
   type SettlementLookupIndexer,
} from './roundwatch-reconciler.js';
import {
   RoundWatchStore,
   type SettlementIntent,
   type WatchRecord,
   type WatchSpec,
} from './roundwatch-store.js';

const PAYER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const RECEIVER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAR7CWY';
const START = Date.parse('2026-10-07T10:00:00Z');
const SPEC: WatchSpec = {
   idempotencyKey: 'c5-reconciliation', expectedSender: PAYER,
   expectedReceiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID, atomicAmount: '1',
};
const terms = (transaction: string): SettlementIntent => ({
   expectedTransaction: transaction, network: ALGORAND_TESTNET,
   payer: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', firstValid: 800, lastValid: 900,
});
const confirmed = (transaction: string): IndexedAssetTransfer => ({
   transaction, sender: PAYER, receiver: RECEIVER, assetId: TESTNET_USDC_ASSET_ID,
   atomicAmount: '1000', round: 850,
});

for (const change of ['future retry only', 'future defer', 'attempts while due'] as const) {
   test(`C5 reconciliation rejects ${change} imposed before the selected target claim`, async t => {
      const fixture = createFixture();
      const { store, indexer, worker, metrics, probe, clock } = fixture;
      const waiting = gate<IndexedAssetTransfer | undefined>();
      const entered = gate<void>();
      let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
      try {
         const first = prepare(store, 'FIRST');
         clock.time += 1;
         const target = prepare(store, 'TARGET');
         indexer.lookup = async transaction => {
            if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
            return confirmed(transaction);
         };
         const retryWrites = t.mock.method(store, 'recordReconciliationFailure');
         const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
         const metricCaptures = t.mock.method(metrics, 'captureWatch');
         sweep = worker.reconcileOnce();
         await entered.promise;
         assert.equal(store.getWatch(first.id)?.workUnitsUsed, 1);
         if (change === 'future retry only') {
            // Isolate the due predicate from the separate attempts fence.
            database(store).prepare(`UPDATE roundwatch_watches
               SET reconciliation_next_attempt_at = ? WHERE id = ?`).run(
               new Date(clock.time + 60_000).toISOString(), target.id,
            );
         } else {
            store.recordReconciliationFailure(target.id,
               new Date(clock.time + (change === 'future defer' ? 60_000 : -1)));
         }
         const newer = store.getWatch(target.id)!;
         const writesBeforeRelease = retryWrites.mock.callCount();
         waiting.resolve(confirmed('FIRST'));
         assert.deepEqual(await sweep, {
            attempted: 2, succeeded: 1, failed: 0, noOp: 1, providerEvidence: 1,
         });
         assert.deepEqual(store.getWatch(target.id), newer);
         assert.equal(newer.workUnitsUsed, 0);
         assert.equal(indexer.requests.filter(request => request.watchId === target.id).length, 0);
         assert.equal(retryWrites.mock.callCount(), writesBeforeRelease);
         assert.equal(invalidations.mock.callCount(), 0);
         assert.equal(probe.currentFailureEpoch(), 0);
         assert.equal(metrics.snapshotWatch(target.id), undefined);
         assert.deepEqual(metricCaptures.mock.calls.map(call => call.arguments[0]), [first.id]);
      } finally {
         waiting.resolve(confirmed('FIRST'));
         await sweep;
         await worker.drain();
         store.close();
      }
   });
}

for (const change of ['future retry only', 'attempts while due'] as const) {
   test(`C5 stale exhausted reconciliation ${change} cannot terminalize the selected obligation`, async () => {
      const { store, indexer, worker, metrics, clock } = createFixture(1);
      const waiting = gate<IndexedAssetTransfer | undefined>();
      const entered = gate<void>();
      let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
      try {
         prepare(store, 'FIRST');
         clock.time += 1;
         const target = prepare(store, 'TARGET');
         assert.equal(store.claimWorkUnit(target.id, {
            purpose: 'reconciliation', expectedServiceTransaction: 'TARGET',
            expectedReconciliationAttempts: target.reconciliationAttempts,
         }), 'claimed');
         indexer.lookup = async transaction => {
            if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
            return confirmed(transaction);
         };
         sweep = worker.reconcileOnce();
         await entered.promise;
         if (change === 'future retry only') {
            database(store).prepare(`UPDATE roundwatch_watches
               SET reconciliation_next_attempt_at = ? WHERE id = ?`).run(
               new Date(clock.time + 60_000).toISOString(), target.id,
            );
         } else store.recordReconciliationFailure(target.id, new Date(clock.time - 1));
         const newer = store.getWatch(target.id)!;
         waiting.resolve(confirmed('FIRST'));
         await sweep;
         assert.deepEqual(store.getWatch(target.id), newer);
         assert.equal(newer.state, 'settlement_pending');
         assert.equal(newer.settlementReconciliationTerminal, false);
         assert.equal(newer.terminalReason, undefined);
         assert.equal(newer.workUnitsUsed, 1);
         assert.equal(indexer.requests.filter(request => request.watchId === target.id).length, 0);
         assert.equal(metrics.snapshotWatch(target.id), undefined);
      } finally {
         waiting.resolve(confirmed('FIRST'));
         await sweep;
         await worker.drain();
         store.close();
      }
   });
}

test('C5 terminalization while a selected reconciliation candidate waits retains B4 inactivity', async t => {
   const { store, indexer, worker, metrics, clock } = createFixture();
   const waiting = gate<IndexedAssetTransfer | undefined>();
   const entered = gate<void>();
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   try {
      prepare(store, 'FIRST');
      clock.time += 1;
      const target = prepare(store, 'TARGET');
      indexer.lookup = async transaction => {
         if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
         return confirmed(transaction);
      };
      const retryWrites = t.mock.method(store, 'recordReconciliationFailure');
      sweep = worker.reconcileOnce();
      await entered.promise;
      store.markSettlementInvalid(target.id);
      const terminal = store.getWatch(target.id)!;
      waiting.resolve(confirmed('FIRST'));
      await sweep;
      assert.deepEqual(store.getWatch(target.id), terminal);
      assert.equal(terminal.workUnitsUsed, 0);
      assert.equal(indexer.requests.filter(request => request.watchId === target.id).length, 0);
      assert.equal(metrics.snapshotWatch(target.id), undefined);
      assert.equal(retryWrites.mock.callCount(), 0);
   } finally {
      waiting.resolve(confirmed('FIRST'));
      await sweep;
      await worker.drain();
      store.close();
   }
});

test('C5 pending to nonterminal unknown before reconciliation claim remains the same eligible obligation', async () => {
   const { store, indexer, worker, metrics, clock } = createFixture();
   const waiting = gate<IndexedAssetTransfer | undefined>();
   const entered = gate<void>();
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   try {
      prepare(store, 'FIRST');
      clock.time += 1;
      const target = prepare(store, 'TARGET');
      indexer.lookup = async transaction => {
         if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
         return confirmed(transaction);
      };
      sweep = worker.reconcileOnce();
      await entered.promise;
      store.markSettlementUnknown(target.id);
      waiting.resolve(confirmed('FIRST'));
      assert.deepEqual(await sweep, { attempted: 2, succeeded: 2, failed: 0, providerEvidence: 2 });
      const active = store.getWatch(target.id)!;
      assert.equal(active.state, 'active');
      assert.equal(active.activationRound, 850);
      assert.equal(active.workUnitsUsed, 1);
      assert.deepEqual(indexer.requests.filter(request => request.watchId === target.id), [
         { kind: 'lookup', transaction: 'TARGET', watchId: target.id },
      ]);
      assert.equal(metrics.snapshotWatch(target.id)?.workUnitsClaimed, 1);
   } finally {
      waiting.resolve(confirmed('FIRST'));
      await sweep;
      await worker.drain();
      store.close();
   }
});

for (const transition of ['activation', 'terminalization'] as const) {
   test(`C5 ${transition} after a legitimate reconciliation claim preserves its charge and newer state`, async () => {
      const { store, indexer, worker, metrics } = createFixture();
      const waiting = gate<IndexedAssetTransfer | undefined>();
      const entered = gate<void>();
      let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
      try {
         const target = prepare(store, 'TARGET');
         indexer.currentRound = 850;
         indexer.lookup = async () => { entered.resolve(); return waiting.promise; };
         sweep = worker.reconcileOnce();
         await entered.promise;
         assert.equal(store.getWatch(target.id)?.workUnitsUsed, 1);
         assert.equal(metrics.snapshotWatch(target.id)?.workUnitsClaimed, 1);
         if (transition === 'activation') {
            store.activateWatch(target.id, {
               transaction: 'TARGET', network: ALGORAND_TESTNET, payer: PAYER,
            }, 850);
         } else store.markSettlementInvalid(target.id);
         const newer = store.getWatch(target.id)!;
         waiting.resolve(undefined);
         assert.deepEqual(await sweep, {
            attempted: 1, succeeded: 0, failed: 0, providerEvidenceOnly: 1, providerEvidence: 1,
         });
         assert.deepEqual(store.getWatch(target.id), newer);
         assert.equal(newer.workUnitsUsed, 1);
         assert.equal(newer.reconciliationAttempts, 0);
         assert.equal(newer.reconciliationNextAttemptAt, undefined);
         assert.equal(metrics.snapshotWatch(target.id)?.workUnitsClaimed, 1);
         assert.equal(indexer.requests.length, 2);
      } finally {
         waiting.resolve(undefined);
         await sweep;
         await worker.drain();
         store.close();
      }
   });
}

for (const change of ['future backoff', 'attempts while due'] as const) {
   test(`C5 retained absence session survives pre-claim ${change} and resumes token and minimum coverage`, async t => {
      const { store, indexer, worker, metrics, clock } = createFixture();
      const waiting = gate<IndexedAssetTransfer | undefined>();
      const entered = gate<void>();
      let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
      try {
         const first = prepare(store, 'FIRST');
         store.recordReconciliationFailure(first.id, new Date(START + 1_000));
         clock.time += 1;
         const target = prepare(store, 'TARGET');
         indexer.pages.push(
            { transactions: [], currentRound: 901, nextToken: 'target-page-2' },
            { transactions: [], currentRound: 903, nextToken: 'target-page-3' },
            { transactions: [], currentRound: 902 },
         );
         await worker.reconcileOnce();
         const session = sessions(worker).get(target.id)!;
         assert.equal(session.expectedTransaction, 'TARGET');
         assert.equal(session.coverage, 901);
         assert.equal(session.nextToken, 'target-page-2');
         clock.time = START + 1_001;
         indexer.lookup = async transaction => {
            if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
            return undefined;
         };
         const retryWrites = t.mock.method(store, 'recordReconciliationFailure');
         sweep = worker.reconcileOnce();
         await entered.promise;
         store.recordReconciliationFailure(target.id,
            new Date(clock.time + (change === 'future backoff' ? 60_000 : -1)));
         const newer = store.getWatch(target.id)!;
         const requestsBeforeRelease = indexer.requests.filter(request => request.watchId === target.id);
         const metricsBeforeRelease = metrics.snapshotWatch(target.id);
         const writesBeforeRelease = retryWrites.mock.callCount();
         waiting.resolve(confirmed('FIRST'));
         await sweep;
         assert.deepEqual(store.getWatch(target.id), newer);
         assert.deepEqual(indexer.requests.filter(request => request.watchId === target.id), requestsBeforeRelease);
         assert.deepEqual(metrics.snapshotWatch(target.id), metricsBeforeRelease);
         assert.equal(retryWrites.mock.callCount(), writesBeforeRelease);
         assert.equal(sessions(worker).get(target.id), session);
         assert.equal(session.nextToken, 'target-page-2');
         assert.equal(session.coverage, 901);
         assert.deepEqual([...session.seenTokens], ['target-page-2']);

         if (change === 'future backoff') {
            assert.deepEqual(await worker.reconcileOnce(), { attempted: 0, succeeded: 0, failed: 0 });
            assert.deepEqual(store.getWatch(target.id), newer);
            assert.equal(sessions(worker).get(target.id), session);
            assert.deepEqual(metrics.snapshotWatch(target.id), metricsBeforeRelease);
            clock.time = Date.parse(newer.reconciliationNextAttemptAt!);
         }
         await worker.reconcileOnce();
         assert.equal(sessions(worker).get(target.id), session);
         assert.equal(session.nextToken, 'target-page-3');
         assert.equal(session.coverage, 901);
         assert.deepEqual([...session.seenTokens], ['target-page-2', 'target-page-3']);
         assert.equal(store.getWatch(target.id)?.workUnitsUsed, newer.workUnitsUsed + 1);
         clock.time = Date.parse(store.getWatch(target.id)!.reconciliationNextAttemptAt!);
         await worker.reconcileOnce();
         assert.equal(sessions(worker).size, 0);
         assert.equal(store.getWatch(target.id)?.settlementReconciliationTerminal, true);
         assert.equal(store.getWatch(target.id)?.workUnitsUsed, newer.workUnitsUsed + 2);
         const targetRequests = indexer.requests.filter(request => request.watchId === target.id);
         assert.deepEqual(targetRequests.map(request => request.kind), ['lookup', 'tip', 'page', 'page', 'page']);
         assert.deepEqual(targetRequests.filter(request => request.kind === 'page').map(request => request.nextToken),
            [undefined, 'target-page-2', 'target-page-3']);
      } finally {
         waiting.resolve(confirmed('FIRST'));
         await sweep;
         await worker.drain();
         store.close();
      }
   });
}

test('C5 retained reconciliation session is discarded when durable transaction identity changes before claim', async () => {
   const { store, indexer, worker, clock } = createFixture();
   const waiting = gate<IndexedAssetTransfer | undefined>();
   const entered = gate<void>();
   let sweep: ReturnType<SettlementReconciler['reconcileOnce']> | undefined;
   try {
      const first = prepare(store, 'FIRST');
      store.recordReconciliationFailure(first.id, new Date(START + 1_000));
      clock.time += 1;
      const target = prepare(store, 'TARGET');
      indexer.pages.push({ transactions: [], currentRound: 901, nextToken: 'old-obligation-token' });
      await worker.reconcileOnce();
      assert.equal(sessions(worker).size, 1);
      clock.time = START + 1_001;
      indexer.lookup = async transaction => {
         if (transaction === 'FIRST') { entered.resolve(); return waiting.promise; }
         return confirmed(transaction);
      };
      sweep = worker.reconcileOnce();
      await entered.promise;
      // Current public APIs keep this immutable. Exercise the defensive identity
      // fence directly against the actual SQLite row, without a copied claim.
      database(store).prepare(`UPDATE roundwatch_watches
         SET expected_service_transaction = 'NEW_TARGET' WHERE id = ?`).run(target.id);
      const newer = store.getWatch(target.id)!;
      waiting.resolve(confirmed('FIRST'));
      await sweep;
      assert.deepEqual(store.getWatch(target.id), newer);
      assert.equal(sessions(worker).size, 0);
      assert.deepEqual(indexer.requests.filter(request => request.watchId === target.id).map(request => request.kind),
         ['lookup', 'tip', 'page']);
      await worker.reconcileOnce();
      assert.equal(store.getWatch(target.id)?.state, 'active');
      assert.deepEqual(indexer.requests.filter(request => request.watchId === target.id).at(-1),
         { kind: 'lookup', transaction: 'NEW_TARGET', watchId: target.id });
   } finally {
      waiting.resolve(confirmed('FIRST'));
      await sweep;
      await worker.drain();
      store.close();
   }
});

function createFixture(workUnitBudget = 10) {
   const clock = { time: START };
   const now = () => new Date(clock.time);
   const store = new RoundWatchStore(':memory:', { now, workUnitBudget });
   const indexer = new FakeIndexer();
   const metrics = new RoundWatchEconomicsMetrics();
   const probe = new IndexerHealthProbe({
      async probeReadinessCapabilities() { return { polling: true, reconciliation: true }; },
   }, TESTNET_USDC_ASSET_ID);
   const worker = new SettlementReconciler(store, indexer, {
      network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
      baseBackoffMilliseconds: 1_000, maxBackoffMilliseconds: 4_000, now,
   }, metrics, probe);
   return { store, indexer, worker, metrics, probe, clock };
}

function prepare(store: RoundWatchStore, transaction: string): WatchRecord {
   return store.prepareWatch({ ...SPEC, idempotencyKey: `c5-${transaction}` }, terms(transaction)).watch;
}

type Request = {
   kind: 'lookup' | 'tip' | 'page';
   watchId?: string;
   transaction?: string;
   nextToken?: string;
};

class FakeIndexer implements SettlementLookupIndexer {
   currentRound = 901;
   readonly requests: Request[] = [];
   readonly pages: TransactionIdPage[] = [];
   lookup: (transaction: string) => Promise<IndexedAssetTransfer | undefined> = async () => undefined;

   async lookupAssetTransfer(transaction: string, _purpose?: 'activation' | 'reconciliation', watchId?: string) {
      this.requests.push({ kind: 'lookup', transaction, watchId });
      return this.lookup(transaction);
   }

   async getCurrentRound(_purpose?: 'reconciliation', watchId?: string): Promise<number> {
      this.requests.push({ kind: 'tip', watchId });
      return this.currentRound;
   }

   async searchTransactionPage(transaction: string, nextToken?: string, watchId?: string): Promise<TransactionIdPage> {
      this.requests.push({ kind: 'page', transaction, nextToken, watchId });
      const page = this.pages.shift();
      assert.ok(page, 'unexpected absence-proof request');
      return page;
   }
}

function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
   let resolve!: (value: T) => void;
   const promise = new Promise<T>(complete => { resolve = complete; });
   return { promise, resolve };
}

function database(store: RoundWatchStore): DatabaseSync {
   return (store as unknown as { database: DatabaseSync }).database;
}

function sessions(worker: SettlementReconciler): Map<string, {
   expectedTransaction: string; nextToken?: string; seenTokens: Set<string>; coverage?: number;
}> {
   return (worker as unknown as { absenceProofSessions: ReturnType<typeof sessions> }).absenceProofSessions;
}
