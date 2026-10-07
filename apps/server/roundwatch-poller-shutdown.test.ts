import assert from 'node:assert/strict';
import test from 'node:test';

import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import {
   AlgorandIndexerClient,
   type IndexedWatchTransaction,
   type RoundWatchIndexer,
   type TransactionPage,
} from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { ShutdownInterrupted, isShutdownInterrupted } from './roundwatch-shutdown.js';
import { RoundWatchStore, type WatchRecord } from './roundwatch-store.js';

const NOW = new Date('2026-10-06T10:00:00.000Z');
const PAYER = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const RECEIVER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const ASSET = 10458941;
const NETWORK = 'algorand:testnet';

function gate<T>() {
   let resolve!: (value: T) => void;
   let reject!: (error: unknown) => void;
   const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
   return { promise, resolve, reject };
}

function active(store: RoundWatchStore, key: string): WatchRecord {
   const watch = store.prepareWatch({
      idempotencyKey: key, expectedSender: PAYER, expectedReceiver: RECEIVER,
      assetId: ASSET, atomicAmount: '1',
   }, {
      expectedTransaction: key, network: NETWORK, payer: PAYER, receiver: RECEIVER,
      assetId: ASSET, atomicAmount: '1000', firstValid: 80, lastValid: 120,
   }).watch;
   return store.activateWatch(watch.id, { transaction: key, network: NETWORK, payer: PAYER }, 100);
}

function invoice(): IndexedWatchTransaction {
   return { transaction: 'SHUTDOWN_INVOICE', sender: PAYER, receiver: RECEIVER,
      assetId: ASSET, atomicAmount: '1', round: 101, roundTime: NOW.getTime() / 1_000 };
}

function indexer(overrides: Partial<RoundWatchIndexer> = {}): RoundWatchIndexer {
   return {
      async getCurrentRound() { return 105; },
      async getBlock(round) { return { round, timestamp: NOW.getTime() / 1_000 }; },
      async lookupAssetTransfer() { assert.fail('Unexpected lookup acquisition'); },
      async searchTransactionPage() { assert.fail('Unexpected absence acquisition'); },
      async searchWatchPage() { return { transactions: [], currentRound: 105 }; },
      ...overrides,
   };
}

async function assertPending(promise: Promise<void>): Promise<void> {
   let settled = false;
   void promise.then(() => { settled = true; });
   // Check the promise queue while the operation remains held by a promise gate.
   await Promise.resolve();
   await Promise.resolve();
   assert.equal(settled, false, 'Drain resolved before its held owner settled');
}

function assertNoHealthFailure(poller: RoundWatchPoller): void {
   const health = poller.healthSnapshot();
   assert.equal(health.ready, false);
   assert.equal(health.consecutiveFailures, 0);
   assert.equal(health.lastErrorAtMs, undefined);
   assert.notEqual(health.providerHealth, 'unhealthy');
}

test('S1 poller stops before claiming the second selected watch and retains the preceding complete cycle', async t => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   const entered = gate<void>();
   const page = gate<TransactionPage>();
   const claims: string[] = [];
   const poller = new RoundWatchPoller(store, indexer({
      searchWatchPage() { entered.resolve(); return page.promise; },
   }), 60_000, 100, () => NOW);
   try {
      await poller.runOnce();
      const first = active(store, 'shutdown-first');
      const second = active(store, 'shutdown-second');
      const claim = store.claimWorkUnit.bind(store);
      t.mock.method(store, 'listPollingCandidates', () => [first, second]);
      t.mock.method(store, 'claimWorkUnit', (id: string, purpose: 'polling' | 'reconciliation') => {
         claims.push(id); return claim(id, purpose);
      });
      const sweep = poller.runOnce();
      const interrupted = assert.rejects(sweep, isShutdownInterrupted);
      await entered.promise;
      const preceding = poller.capacitySnapshot();
      poller.stopScheduling();
      const draining = poller.drain();
      await assertPending(draining);
      page.resolve({ transactions: [invoice()], currentRound: 105 });
      await interrupted;
      await draining;
      assert.deepEqual(claims, [first.id]);
      assert.deepEqual(store.getWatch(first.id), {
         ...first, state: 'matched', matchedTransaction: 'SHUTDOWN_INVOICE', matchedRound: 101,
         workUnitsUsed: 1,
      });
      assert.deepEqual(store.getWatch(second.id), second);
      assert.deepEqual(poller.capacitySnapshot(), preceding);
      assertNoHealthFailure(poller);
   } finally { page.resolve({ transactions: [], currentRound: 105 }); await poller.drain(); store.close(); }
});

for (const result of ['match', 'cursor', 'expiry', 'continuation'] as const) {
   test(`S1 poller already-dispatched ${result} page completes its validated operation after terminal stop`, async () => {
      const store = new RoundWatchStore(':memory:', { now: () => NOW });
      const entered = gate<void>();
      const page = gate<TransactionPage>();
      let calls = 0;
      const poller = new RoundWatchPoller(store, indexer({
         searchWatchPage() { calls += 1; entered.resolve(); return page.promise; },
      }), 60_000, 100, () => NOW);
      try {
         await poller.runOnce();
         let watch = active(store, `shutdown-page-${result}`);
         if (result === 'expiry') {
            store.setClosingRound(watch.id, 105);
            watch = store.getWatch(watch.id)!;
         }
         const sweep = poller.runOnce();
         await entered.promise;
         const preceding = poller.capacitySnapshot();
         poller.stopScheduling();
         const draining = poller.drain();
         await assertPending(draining);
         page.resolve({
            transactions: result === 'match' ? [invoice()] : [], currentRound: 105,
            ...(result === 'continuation' ? { nextToken: 'retained-next-page' } : {}),
         });
         const outcome = await sweep;
         await draining;
         assert.equal(outcome.failed, 0);
         assert.equal(calls, 1);
         const expected = { ...watch, workUnitsUsed: 1 };
         if (result === 'match') Object.assign(expected, {
            state: 'matched', matchedTransaction: 'SHUTDOWN_INVOICE', matchedRound: 101,
         });
         if (result === 'cursor' || result === 'expiry') expected.scanAfterRound = 105;
         if (result === 'expiry') expected.state = 'expired';
         assert.deepEqual(store.getWatch(watch.id), expected);
         if (result === 'continuation') {
            const sessions = (poller as unknown as { sessions: Map<string, { nextToken?: string }> }).sessions;
            assert.equal(sessions.get(watch.id)?.nextToken, 'retained-next-page');
         }
         assert.deepEqual(poller.capacitySnapshot(), preceding);
         assertNoHealthFailure(poller);
      } finally { page.resolve({ transactions: [], currentRound: 105 }); await poller.drain(); store.close(); }
   });
}

for (const boundary of ['worker', 'dispatcher'] as const) {
   for (const held of ['scan-tip', 'checkpoint-tip', 'checkpoint-block'] as const) {
      test(`S1 poller ${boundary} stop blocks new acquisition after held ${held} without failure metadata or telemetry`, async t => {
         let now = NOW;
         const store = new RoundWatchStore(':memory:', { now: () => now, watchTtlMilliseconds: 1_000 });
         const response = gate<Response>();
         const entered = gate<void>();
         const paths: string[] = [];
         const metrics = new RoundWatchEconomicsMetrics();
         const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
         const client = new AlgorandIndexerClient('https://indexer.invalid', dispatcher, async input => {
            const path = new URL(String(input)).pathname;
            paths.push(path);
            if ((held !== 'checkpoint-block' && path === '/health') ||
                (held === 'checkpoint-block' && path === '/v2/blocks/105')) {
               entered.resolve(); return response.promise;
            }
            if (path === '/health') return Response.json({ round: 105 });
            assert.fail(`Unexpected provider dispatch after admission stop: ${path}`);
         }, 10_000, metrics);
         const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
            return { polling: true, reconciliation: true };
         } }, ASSET, () => 1_000);
         const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
         const errors = t.mock.method(console, 'error', () => {});
         const poller = new RoundWatchPoller(store, client, 60_000, 100, () => now,
            metrics, 0, 0, probe);
         try {
            const sample = await probe.runIfDue();
            await poller.runOnce();
            const watch = active(store, `shutdown-${boundary}-${held}`);
            if (held !== 'scan-tip') now = new Date(NOW.getTime() + 2_000);
            const sweep = poller.runOnce();
            const interrupted = assert.rejects(sweep, isShutdownInterrupted);
            await entered.promise;
            const preceding = poller.capacitySnapshot();
            if (boundary === 'worker') poller.stopScheduling();
            dispatcher.stopScheduling();
            response.resolve(held === 'checkpoint-block'
               ? Response.json({ round: 105, timestamp: now.getTime() / 1_000 })
               : Response.json({ round: 105 }));
            await interrupted;
            await poller.drain();
            await dispatcher.drain();
            assert.deepEqual(paths, held === 'checkpoint-block' ? ['/health', '/v2/blocks/105'] : ['/health']);
            assert.deepEqual(store.getWatch(watch.id), {
               ...watch, workUnitsUsed: 1,
               ...(held === 'checkpoint-block' ? { closingRound: 105 } : {}),
            });
            const dispatch = dispatcher.snapshot();
            assert.equal(dispatch.queued, 0);
            assert.equal(dispatch.inFlight, 0);
            assert.equal(dispatch.successes, paths.length);
            assert.equal(dispatch.failures, 0);
            assert.equal(dispatch.timeouts, 0);
            const work = metrics.snapshotWatch(watch.id)!;
            assert.equal(work.workUnitsClaimed, 1);
            assert.equal(work.indexer.checkpoint.attempts, held === 'scan-tip' ? 0 : paths.length);
            assert.equal(work.indexer['scan-page'].attempts, 0);
            for (const purpose of Object.values(work.indexer)) {
               assert.equal(purpose.failures, 0);
               assert.equal(purpose.timeouts, 0);
            }
            // Scan-tip success is a real retained tip observation; cycle completion stays retained.
            const capacity = poller.capacitySnapshot();
            assert.equal(capacity.lastCycleCompletedAt, preceding.lastCycleCompletedAt);
            assert.equal(capacity.lastCycleDurationMs, preceding.lastCycleDurationMs);
            assert.equal(capacity.watchesAttemptedLastCycle, preceding.watchesAttemptedLastCycle);
            assert.equal(capacity.watchesSucceededLastCycle, preceding.watchesSucceededLastCycle);
            assert.equal(capacity.watchesFailedLastCycle, preceding.watchesFailedLastCycle);
            assert.equal(invalidations.mock.callCount(), 0);
            assert.equal(errors.mock.callCount(), 0);
            assert.equal(probe.currentSample(), sample);
            assert.equal(probe.currentFailureEpoch(), 0);
            assertNoHealthFailure(poller);
         } finally {
            response.resolve(Response.json({ round: 105, timestamp: now.getTime() / 1_000 }));
            await poller.drain(); await dispatcher.drain(); store.close();
         }
      });
   }
}

test('S1 direct poller entry and start are terminally fenced before store or provider access', async () => {
   let accesses = 0;
   const forbidden = () => { accesses += 1; assert.fail('Terminal worker accessed an operational dependency'); };
   const store = new Proxy({} as RoundWatchStore, { get: forbidden });
   const provider = new Proxy({} as RoundWatchIndexer, { get: forbidden });
   const poller = new RoundWatchPoller(store, provider);
   poller.stopScheduling();
   poller.stopScheduling();
   poller.start();
   await assert.rejects(poller.runOnce(), isShutdownInterrupted);
   const first = poller.drain();
   await first;
   await poller.drain();
   assert.equal(accesses, 0);
   assert.equal(poller.healthSnapshot().started, false);
   assertNoHealthFailure(poller);
});

test('S1 poller drain owns all overlapping direct sweeps until both held pages settle', async () => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   const entered = [gate<void>(), gate<void>()];
   const pages = [gate<TransactionPage>(), gate<TransactionPage>()];
   let calls = 0;
   const poller = new RoundWatchPoller(store, indexer({
      searchWatchPage() {
         const i = calls++; entered[i]!.resolve(); return pages[i]!.promise;
      },
   }), 60_000, 100, () => NOW);
   try {
      const watch = active(store, 'shutdown-overlap');
      const first = poller.runOnce();
      await entered[0]!.promise;
      const second = poller.runOnce();
      await entered[1]!.promise;
      poller.stopScheduling();
      const draining = poller.drain();
      pages[0]!.resolve({ transactions: [], currentRound: 105 });
      await first;
      await assertPending(draining);
      assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 2);
      pages[1]!.resolve({ transactions: [], currentRound: 105 });
      await second;
      await draining;
      assert.equal(calls, 2);
      assert.equal(store.getWatch(watch.id)?.scanAfterRound, 105);
      assertNoHealthFailure(poller);
   } finally {
      for (const page of pages) page.resolve({ transactions: [], currentRound: 105 });
      await poller.drain(); store.close();
   }
});

test('S1 scheduled poller drain includes its post-cycle probe and publishes no administrative health failure', async t => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   const entered = gate<void>();
   const evidence = gate<{ polling: boolean; reconciliation: boolean }>();
   let now = 1_000;
   let calls = 0;
   const probe = new IndexerHealthProbe({ probeReadinessCapabilities() {
      calls += 1;
      if (calls === 1) return Promise.resolve({ polling: true, reconciliation: true });
      entered.resolve(); return evidence.promise;
   } }, ASSET, () => now);
   const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
   const errors = t.mock.method(console, 'error', () => {});
   const poller = new RoundWatchPoller(store, indexer(), 60_000, 100, () => NOW,
      undefined, undefined, undefined, probe);
   try {
      const retained = await probe.runIfDue();
      now += 15_000;
      poller.start();
      await entered.promise;
      const preceding = poller.capacitySnapshot();
      assert.ok(preceding.lastCycleCompletedAt, 'The sweep completed before the held probe');
      poller.stopScheduling();
      probe.stopScheduling();
      const draining = poller.drain();
      const probeDraining = probe.drain();
      await assertPending(draining);
      await assertPending(probeDraining);
      evidence.reject(new ShutdownInterrupted());
      await draining;
      await probeDraining;
      assert.equal(calls, 2);
      assert.equal(probe.currentSample(), retained);
      assert.equal(probe.currentFailureEpoch(), 0);
      assert.equal(invalidations.mock.callCount(), 0);
      assert.equal(errors.mock.callCount(), 0);
      assert.deepEqual(poller.capacitySnapshot(), preceding);
      assertNoHealthFailure(poller);
   } finally {
      evidence.resolve({ polling: true, reconciliation: true });
      await poller.drain(); await probe.drain(); store.close();
   }
});

test('S1 scheduled sweep interruption neither persists a failure nor starts its post-cycle probe', async t => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   const entered = gate<void>();
   const tip = gate<number>();
   let pageCalls = 0;
   let probeCalls = 0;
   const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      probeCalls += 1; return { polling: true, reconciliation: true };
   } }, ASSET);
   const invalidations = t.mock.method(probe, 'invalidateForProviderFailure');
   const errors = t.mock.method(console, 'error', () => {});
   const poller = new RoundWatchPoller(store, indexer({
      getCurrentRound() { entered.resolve(); return tip.promise; },
      async searchWatchPage() { pageCalls += 1; return { transactions: [], currentRound: 105 }; },
   }), 60_000, 100, () => NOW, undefined, undefined, undefined, probe);
   try {
      await poller.runOnce();
      const watch = active(store, 'shutdown-scheduled');
      poller.start();
      await entered.promise;
      const preceding = poller.capacitySnapshot();
      poller.stopScheduling();
      const draining = poller.drain();
      await assertPending(draining);
      tip.resolve(105);
      await draining;
      assert.deepEqual(store.getWatch(watch.id), { ...watch, workUnitsUsed: 1 });
      assert.equal(pageCalls, 0);
      assert.equal(probeCalls, 0);
      assert.equal(invalidations.mock.callCount(), 0);
      assert.equal(errors.mock.callCount(), 0);
      const retained = poller.capacitySnapshot();
      assert.equal(retained.lastCycleCompletedAt, preceding.lastCycleCompletedAt);
      assert.equal(retained.lastCycleDurationMs, preceding.lastCycleDurationMs);
      assert.equal(retained.watchesAttemptedLastCycle, preceding.watchesAttemptedLastCycle);
      assertNoHealthFailure(poller);
   } finally { tip.resolve(105); await poller.drain(); await probe.drain(); store.close(); }
});

test('S1 ordinary poller stop/start still restarts and scheduled timers end at terminal shutdown', async t => {
   const store = new RoundWatchStore(':memory:', { now: () => NOW });
   const scheduled = [gate<void>(), gate<void>()];
   const timerHandles: NodeJS.Timeout[] = [];
   let cycles = 0;
   t.mock.method(globalThis, 'setTimeout', () => {
      const handle = { unref() {} } as NodeJS.Timeout;
      timerHandles.push(handle);
      scheduled[timerHandles.length - 1]!.resolve();
      return handle;
   });
   const cleared = t.mock.method(globalThis, 'clearTimeout', () => {});
   const poller = new RoundWatchPoller(store, indexer(), 60_000, 100, () => NOW);
   const realRunOnce = poller.runOnce.bind(poller);
   t.mock.method(poller, 'runOnce', async () => { cycles += 1; return realRunOnce(); });
   try {
      poller.start();
      await scheduled[0]!.promise;
      poller.stop();
      assert.equal(poller.healthSnapshot().started, false);
      poller.start();
      await scheduled[1]!.promise;
      assert.equal(cycles, 2);
      assert.equal(poller.healthSnapshot().started, true);
      poller.stopScheduling();
      await poller.drain();
      poller.start();
      await Promise.resolve();
      assert.equal(cycles, 2);
      assert.equal(timerHandles.length, 2);
      assert.equal(cleared.mock.callCount(), 2);
      assert.equal(poller.healthSnapshot().started, false);
      assertNoHealthFailure(poller);
   } finally { await poller.drain(); store.close(); }
});
