import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AlgorandIndexerClient, type RoundWatchIndexer, type TransactionPage } from './roundwatch-indexer.js';
import { IndexerHealthProbe, type IndexerCapabilityEvidence } from './roundwatch-health-probe.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { createPaidAdmissionReadinessCheck } from './roundwatch-paid-readiness.js';
import { SettlementReconciler, type SettlementLookupIndexer } from './roundwatch-reconciler.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { RoundWatchStore, type WatchRecord } from './roundwatch-store.js';
import { WorkerHealthTracker } from './roundwatch-worker-health.js';

const ADDRESS = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const OTHER = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const ASSET = 10458941;
const NETWORK = 'algorand:testnet';
const service = (id: string) => ({ expectedTransaction: id, network: NETWORK, payer: ADDRESS,
   receiver: OTHER, assetId: ASSET, atomicAmount: '1000', firstValid: 80, lastValid: 120 });

function active(store: RoundWatchStore, key: string, round = 100): WatchRecord {
   const watch = store.prepareWatch({ idempotencyKey: key, expectedSender: ADDRESS,
      expectedReceiver: OTHER, assetId: ASSET, atomicAmount: '1' }, service(key)).watch;
   return store.activateWatch(watch.id, { transaction: key, network: NETWORK, payer: ADDRESS }, round);
}

function fakeIndexer(overrides: Partial<RoundWatchIndexer> = {}): RoundWatchIndexer & { calls: string[] } {
   const calls: string[] = [];
   return {
      calls,
      async getCurrentRound() { calls.push('tip'); return 101; },
      async lookupAssetTransfer() { calls.push('lookup'); return undefined; },
      async getBlock(round) { calls.push('block'); return { round, timestamp: 0 }; },
      async searchWatchPage() { calls.push('scan'); return { transactions: [], currentRound: 101 }; },
      async searchTransactionPage() { calls.push('absence'); return { transactions: [], currentRound: 101 }; },
      ...overrides,
   };
}

async function until(condition: () => boolean): Promise<void> {
   for (let i = 0; i < 200; i += 1) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
   }
   assert.fail('timed out waiting for worker cycle');
}

test('R01: exhausted retry makes no provider request and cannot recover health', async () => {
   let now = new Date('2026-09-28T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', { workUnitBudget: 1, now: () => now });
   try {
      const watch = active(store, 'r01');
      const indexer = fakeIndexer({ async getCurrentRound() { indexer.calls.push('tip'); throw new Error('outage'); } });
      const poller = new RoundWatchPoller(store, indexer, 5_000, 100, () => now);
      const tracker = new WorkerHealthTracker(() => now.getTime());
      tracker.markStarted();
      tracker.markProbeResult(true);
      tracker.markCycleStarted();
      tracker.markCycleCompleted(await poller.runOnce());
      assert.equal(tracker.snapshot(45_000).ready, false);
      const calls = indexer.calls.length;
      const retryAt = store.getWatch(watch.id)!.pollingRetryAt!;
      now = new Date(Date.parse(retryAt) + 1);
      tracker.markCycleStarted();
      const exhausted = await poller.runOnce();
      tracker.markCycleCompleted(exhausted);
      assert.equal(exhausted.noOp, 1);
      assert.equal(exhausted.providerEvidence, undefined);
      assert.equal(indexer.calls.length, calls);
      assert.equal(tracker.snapshot(45_000).ready, false);
      assert.equal(store.getWatch(watch.id)?.workUnitsUsed, 1);
   } finally { store.close(); }
});

test('R02: restart in durable cooldown starts unknown and probes without charging customer work', async () => {
   const directory = mkdtempSync(join(tmpdir(), 'roundwatch-health-restart-'));
   const path = join(directory, 'watch.sqlite');
   let now = new Date('2026-09-28T12:00:00.000Z');
   let first: RoundWatchStore | undefined;
   let restarted: RoundWatchStore | undefined;
   try {
      first = new RoundWatchStore(path, { now: () => now });
      const watch = active(first, 'r02');
      const failing = fakeIndexer({ async getCurrentRound() { throw new Error('outage'); } });
      await new RoundWatchPoller(first, failing, 5_000, 100, () => now).runOnce();
      const before = first.getWatch(watch.id)!;
      assert.ok(before.pollingRetryAt);
      first.close(); first = undefined;

      restarted = new RoundWatchStore(path, { now: () => now });
      let probeNow = 1_000;
      let healthy = false;
      let probeCalls = 0;
      const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
         probeCalls += 1; return { polling: healthy, reconciliation: healthy };
      } }, ASSET, () => probeNow);
      const indexer = fakeIndexer();
      const poller = new RoundWatchPoller(restarted, indexer, 5, 100, () => now,
         undefined, undefined, undefined, probe);
      assert.equal(poller.healthSnapshot().providerHealth, 'unknown');
      poller.start();
      try {
         await until(() => poller.healthSnapshot().providerHealth === 'unhealthy');
         assert.equal(poller.readinessCheck(), false);
         assert.equal(indexer.calls.length, 0);
         assert.equal(storeRecord(restarted, watch.id).workUnitsUsed, before.workUnitsUsed);
         assert.equal(storeRecord(restarted, watch.id).pollingRetryAt, before.pollingRetryAt);
         assert.deepEqual(storeRecord(restarted, watch.id), before);
         healthy = true; probeNow += 15_000;
         await until(() => poller.readinessCheck());
         assert.equal(probeCalls, 2);
         assert.equal(indexer.calls.length, 0);
         assert.equal(storeRecord(restarted, watch.id).workUnitsUsed, before.workUnitsUsed);
         assert.deepEqual(storeRecord(restarted, watch.id), before);
      } finally { poller.stop(); }
   } finally { first?.close(); restarted?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('empty startup shares one bounded probe and stop/start requires fresh evidence', async () => {
   const store = new RoundWatchStore(':memory:');
   let probeNow = 1_000;
   let evidence: IndexerCapabilityEvidence = { polling: false, reconciliation: false };
   let calls = 0;
   const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      calls += 1; return evidence;
   } }, ASSET, () => probeNow);
   const indexer = fakeIndexer();
   const poller = new RoundWatchPoller(store, indexer, 5, 100, undefined,
      undefined, undefined, undefined, probe);
   const reconciler = new SettlementReconciler(store, indexer as SettlementLookupIndexer,
      { network: NETWORK, intervalMilliseconds: 5 }, undefined, probe);
   try {
      // No customer candidate exists; this also covers empty startup.
      poller.start(); reconciler.start();
      await until(() => poller.healthSnapshot().providerHealth === 'unhealthy' &&
         reconciler.healthSnapshot().providerHealth === 'unhealthy');
      assert.equal(calls, 1);
      assert.equal(store.listPollingCandidates().length, 0);
      assert.equal(store.listSettlementReconciliationCandidates().length, 0);
      evidence = { polling: true, reconciliation: true };
      probeNow += 15_000;
      await until(() => poller.readinessCheck() && reconciler.readinessCheck());
      assert.equal(calls, 2);
      assert.equal(indexer.calls.length, 0);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(calls, 2);
      poller.stop(); reconciler.stop();
      assert.equal(poller.readinessCheck(), false);
      assert.equal(reconciler.readinessCheck(), false);
      poller.start(); reconciler.start();
      assert.equal(poller.readinessCheck(), false);
      assert.equal(reconciler.readinessCheck(), false);
      await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(calls, 2);
      probeNow += 15_000;
      await until(() => poller.readinessCheck() && reconciler.readinessCheck());
      assert.equal(calls, 3);
   } finally { poller.stop(); reconciler.stop(); store.close(); }
});

test('R03: terminal final polling watch leaves a bounded recovery path', async () => {
   const store = new RoundWatchStore(':memory:');
   const watch = active(store, 'r03');
   let probeNow = 1_000;
   let recovered = false;
   let probeCalls = 0;
   const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      probeCalls += 1; return { polling: recovered, reconciliation: recovered };
   } }, ASSET, () => probeNow);
   const indexer = fakeIndexer({ async searchWatchPage() { throw new Error('scan outage'); } });
   const poller = new RoundWatchPoller(store, indexer, 5, 100, undefined,
      undefined, undefined, undefined, probe);
   try {
      poller.start();
      await until(() => poller.healthSnapshot().providerHealth === 'unhealthy');
      store.recordPollingFailure(watch.id, { code: 'isolated_terminal', disposition: 'permanent' });
      assert.equal(store.listPollingCandidates().length, 0);
      const terminal = store.getWatch(watch.id)!;
      await until(() => probeCalls === 1);
      assert.equal(poller.readinessCheck(), false);
      recovered = true; probeNow += 15_000;
      await until(() => poller.readinessCheck());
      assert.deepEqual(store.getWatch(watch.id), terminal);
   } finally { poller.stop(); store.close(); }
});

test('R05: final reconciliation candidate can activate and idle reconciler can recover', async () => {
   const store = new RoundWatchStore(':memory:');
   const watch = store.prepareWatch({ idempotencyKey: 'r05', expectedSender: ADDRESS,
      expectedReceiver: OTHER, assetId: ASSET, atomicAmount: '1' }, service('r05')).watch;
   let probeNow = 1_000;
   let recovered = false;
   let probeCalls = 0;
   const probe = new IndexerHealthProbe({ async probeReadinessCapabilities() {
      probeCalls += 1; return { polling: recovered, reconciliation: recovered };
   } }, ASSET, () => probeNow);
   const indexer = fakeIndexer({ async lookupAssetTransfer() { throw new Error('lookup outage'); } });
   const reconciler = new SettlementReconciler(store, indexer,
      { network: NETWORK, intervalMilliseconds: 5 }, undefined, probe);
   try {
      reconciler.start();
      await until(() => reconciler.healthSnapshot().providerHealth === 'unhealthy');
      store.activateWatch(watch.id, { transaction: 'r05', network: NETWORK, payer: ADDRESS }, 100);
      assert.equal(store.listSettlementReconciliationCandidates().length, 0);
      const activated = store.getWatch(watch.id)!;
      await until(() => probeCalls === 1);
      assert.equal(reconciler.readinessCheck(), false);
      recovered = true; probeNow += 15_000;
      await until(() => reconciler.readinessCheck());
      assert.deepEqual(store.getWatch(watch.id), activated);
   } finally { reconciler.stop(); store.close(); }
});

test('R06: tip-only watch cannot mask another watch scan failure', async () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const failing = active(store, 'r06-a', 100);
      active(store, 'r06-b', 101);
      const indexer = fakeIndexer({ async searchWatchPage(watch): Promise<TransactionPage> {
         indexer.calls.push(`scan:${watch.id}`);
         if (watch.id === failing.id) throw new Error('scan HTTP 503');
         return { transactions: [], currentRound: 101 };
      } });
      const poller = new RoundWatchPoller(store, indexer);
      const tracker = new WorkerHealthTracker();
      tracker.markStarted(); tracker.markProbeResult(true);
      tracker.markCycleStarted();
      const outcome = await poller.runOnce();
      tracker.markCycleCompleted(outcome);
      assert.equal(outcome.failed, 1);
      assert.equal(outcome.noOp, 1);
      assert.equal(outcome.succeeded, 0);
      assert.equal(indexer.calls.filter(call => call.startsWith('scan:')).length, 1);
      assert.equal(tracker.snapshot(45_000).ready, false);
   } finally { store.close(); }
});

test('functional probe requires scan, checkpoint block, and both reconciliation routes', async () => {
   for (const failedRoute of ['scan', 'block', 'lookup', 'absence', 'none'] as const) {
      const paths: string[] = [];
      const client = new AlgorandIndexerClient('https://indexer.invalid',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
         async input => {
            const url = new URL(String(input)); paths.push(url.pathname);
            if (url.pathname === '/health') return Response.json({ round: 101 });
            if (url.pathname.includes('/assets/')) return failedRoute === 'scan'
               ? Response.json({}, { status: 503 })
               : Response.json({ transactions: [], 'current-round': 101 });
            if (url.pathname.startsWith('/v2/blocks/')) return failedRoute === 'block'
               ? Response.json({}, { status: 503 })
               : Response.json({ round: 101, timestamp: 1_000 });
            if (url.pathname.startsWith('/v2/transactions/')) return failedRoute === 'lookup'
               ? Response.json({}, { status: 503 })
               : Response.json({}, { status: 404 });
            if (url.pathname === '/v2/transactions') return failedRoute === 'absence'
               ? Response.json({}, { status: 503 })
               : Response.json({ transactions: [], 'current-round': 101 });
            throw new Error('unexpected path');
         });
      const result = await client.probeReadinessCapabilities(ASSET);
      assert.equal(result.polling, failedRoute !== 'scan' && failedRoute !== 'block');
      assert.equal(result.reconciliation, failedRoute !== 'lookup' && failedRoute !== 'absence');
      assert.ok(paths.includes('/health'));
      assert.ok(paths.some(path => path.includes('/assets/')));
      if (failedRoute !== 'scan') assert.ok(paths.includes('/v2/blocks/101'));
      assert.ok(paths.length <= 5);
   }
});

test('checkpoint 503 keeps an idle poller unready until that route recovers', async () => {
   const store = new RoundWatchStore(':memory:');
   let blockHealthy = false;
   let probeNow = 1_000;
   let blockCalls = 0;
   const client = new AlgorandIndexerClient('https://indexer.invalid',
      new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
      async input => {
         const path = new URL(String(input)).pathname;
         if (path === '/health') return Response.json({ round: 101 });
         if (path.startsWith('/v2/assets/')) return Response.json({ transactions: [], 'current-round': 101 });
         if (path === '/v2/blocks/101') {
            blockCalls += 1;
            return blockHealthy
               ? Response.json({ round: 101, timestamp: 1_000 })
               : Response.json({}, { status: 503 });
         }
         if (path.startsWith('/v2/transactions/')) return Response.json({}, { status: 404 });
         if (path === '/v2/transactions') return Response.json({ transactions: [], 'current-round': 101 });
         throw new Error(`unexpected path ${path}`);
      });
   const probe = new IndexerHealthProbe(client, ASSET, () => probeNow);
   const poller = new RoundWatchPoller(store, client, 5, 100, undefined,
      undefined, undefined, undefined, probe);
   try {
      poller.start();
      await until(() => poller.healthSnapshot().providerHealth === 'unhealthy');
      assert.equal(poller.readinessCheck(), false);
      assert.equal(blockCalls, 1);
      assert.equal(store.listActiveWatches().length, 0);
      blockHealthy = true;
      probeNow += 15_000;
      await until(() => poller.readinessCheck());
      assert.equal(blockCalls, 2);
      assert.equal(store.listActiveWatches().length, 0);
   } finally { poller.stop(); store.close(); }
});

test('established readiness tolerates one transient probe failure but not two consecutive failures', () => {
   let now = 1_000;
   const tracker = new WorkerHealthTracker(() => now);
   tracker.markStarted();
   tracker.markProbeResult(true);
   assert.equal(tracker.snapshot(45_000).ready, true);

   now += 1_000;
   tracker.markProbeResult(false);
   let snapshot = tracker.snapshot(45_000);
   assert.equal(snapshot.ready, true);
   assert.equal(snapshot.providerHealth, 'healthy');
   assert.equal(snapshot.consecutiveFailures, 1);

   now += 1_000;
   tracker.markProbeResult(false);
   snapshot = tracker.snapshot(45_000);
   assert.equal(snapshot.ready, false);
   assert.equal(snapshot.providerHealth, 'unhealthy');
   assert.equal(snapshot.consecutiveFailures, 2);

   now += 1_000;
   tracker.markProbeResult(true);
   snapshot = tracker.snapshot(45_000);
   assert.equal(snapshot.ready, true);
   assert.equal(snapshot.consecutiveFailures, 0);
});

test('idle capability evidence is cached longer, unhealthy evidence accelerates retry, and concurrent callers single-flight', async () => {
   let now = 1_000;
   let evidence: IndexerCapabilityEvidence = {
      polling: true,
      reconciliation: true,
   };
   let calls = 0;
   const probe = new IndexerHealthProbe(
      {
         async probeReadinessCapabilities() {
            calls += 1;
            await Promise.resolve();
            return evidence;
         },
      },
      ASSET,
      () => now,
      15_000,
      120_000,
   );

   assert.throws(
      () => probe.runIfDue(14_999),
      /at least the active probe interval/,
   );

   const [first, shared] = await Promise.all([
      probe.runIfDue(probe.idleIntervalMilliseconds()),
      probe.runIfDue(probe.idleIntervalMilliseconds()),
   ]);
   assert.equal(calls, 1);
   assert.equal(first.revision, shared.revision);

   now += 30_000;
   const cached = await probe.runIfDue(probe.idleIntervalMilliseconds());
   assert.equal(calls, 1);
   assert.equal(cached.revision, first.revision);

   now += 90_000;
   evidence = { polling: false, reconciliation: false };
   const failed = await probe.runIfDue(probe.idleIntervalMilliseconds());
   assert.equal(calls, 2);
   assert.equal(failed.evidence.polling, false);

   now += 14_000;
   await probe.runIfDue(probe.idleIntervalMilliseconds());
   assert.equal(calls, 2);

   now += 1_000;
   evidence = { polling: true, reconciliation: true };
   const recovered = await probe.runIfDue(probe.idleIntervalMilliseconds());
   assert.equal(calls, 3);
   assert.equal(recovered.evidence.polling, true);
});

test('systemic poller and reconciler failures invalidate the shared provider epoch', async () => {
   for (const worker of ['poller', 'reconciler'] as const) {
      const store = new RoundWatchStore(':memory:');
      let probeNow = 1_000;
      const probe = new IndexerHealthProbe(
         {
            async probeReadinessCapabilities() {
               return { polling: true, reconciliation: true };
            },
         },
         ASSET,
         () => probeNow,
         1_000,
         1_000,
      );
      const before = probe.currentFailureEpoch();

      try {
         if (worker === 'poller') {
            active(store, 'failure-epoch-poller');
            const failing = fakeIndexer({
               async getCurrentRound() {
                  throw new Error('systemic poller outage');
               },
            });
            const poller = new RoundWatchPoller(
               store,
               failing,
               5,
               100,
               undefined,
               undefined,
               undefined,
               undefined,
               probe,
            );
            poller.start();
            try {
               await until(() => probe.currentFailureEpoch() > before);
            } finally {
               poller.stop();
            }
         } else {
            store.prepareWatch(
               {
                  idempotencyKey: 'failure-epoch-reconciler',
                  expectedSender: ADDRESS,
                  expectedReceiver: OTHER,
                  assetId: ASSET,
                  atomicAmount: '1',
               },
               service('failure-epoch-reconciler'),
            );
            const failing = fakeIndexer({
               async lookupAssetTransfer() {
                  throw new Error('systemic reconciler outage');
               },
            });
            const reconciler = new SettlementReconciler(
               store,
               failing,
               { network: NETWORK, intervalMilliseconds: 5 },
               undefined,
               probe,
            );
            reconciler.start();
            try {
               await until(() => probe.currentFailureEpoch() > before);
            } finally {
               reconciler.stop();
            }
         }

         assert.ok(probe.currentFailureEpoch() > before);
         probeNow += 1_000;
      } finally {
         store.close();
      }
   }
});

test('paid readiness refreshes after a newer provider-failure epoch instead of reusing cached success', async () => {
   let now = 0;
   let healthy = true;
   let probeCalls = 0;
   const probe = new IndexerHealthProbe(
      {
         async probeReadinessCapabilities() {
            probeCalls += 1;
            return { polling: healthy, reconciliation: healthy };
         },
      },
      ASSET,
      () => now,
      15_000,
      120_000,
   );

   const workerHealth = {
      healthSnapshot: () => ({
         started: true,
         running: false,
         ready: true,
         cycleNotStalled: true,
         providerHealth: 'healthy' as const,
         consecutiveFailures: 0,
         generation: 1,
      }),
   };
   const paid = createPaidAdmissionReadinessCheck({
      storageReady: () => true,
      diskHeadroom: () => true,
      poller: workerHealth,
      reconciler: workerHealth,
      healthProbe: probe,
      maximumEvidenceAgeMilliseconds: 30_000,
   });

   assert.equal((await paid()).ready, true);
   assert.equal(probeCalls, 1);

   now = 1_000;
   healthy = false;
   probe.invalidateForProviderFailure();

   const degraded = await paid();
   assert.equal(degraded.ready, false);
   assert.equal(degraded.checks.capabilityEvidenceFresh, true);
   assert.equal(probeCalls, 2, 'newer failure epoch must force a fresh probe');
});

test('provider failure during an in-flight probe invalidates that sample and the next caller refreshes', async () => {
   let now = 0;
   let resolveFirst!: (value: IndexerCapabilityEvidence) => void;
   let calls = 0;
   const probe = new IndexerHealthProbe(
      {
         probeReadinessCapabilities() {
            calls += 1;
            if (calls === 1) {
               return new Promise<IndexerCapabilityEvidence>(resolve => {
                  resolveFirst = resolve;
               });
            }
            return Promise.resolve({ polling: true, reconciliation: true });
         },
      },
      ASSET,
      () => now,
      15_000,
      120_000,
   );

   const first = probe.runIfDue(30_000);
   probe.invalidateForProviderFailure();
   resolveFirst({ polling: true, reconciliation: true });
   const stale = await first;

   assert.equal(probe.isSampleFreshForAdmission(stale, 30_000), false);
   const recovered = await probe.runIfDue(30_000);
   assert.equal(calls, 2);
   assert.equal(probe.isSampleFreshForAdmission(recovered, 30_000), true);
});

test('paid readiness rejects a probe whose aggregate duration exceeds its evidence-age policy', async () => {
   let now = 0;
   let release!: () => void;
   const gate = new Promise<void>(resolve => { release = resolve; });
   const probe = new IndexerHealthProbe(
      {
         async probeReadinessCapabilities() {
            await gate;
            return { polling: true, reconciliation: true };
         },
      },
      ASSET,
      () => now,
      15_000,
      120_000,
   );
   const workerHealth = {
      healthSnapshot: () => ({
         started: true,
         running: false,
         ready: true,
         cycleNotStalled: true,
         providerHealth: 'healthy' as const,
         consecutiveFailures: 0,
         generation: 1,
      }),
   };
   const paid = createPaidAdmissionReadinessCheck({
      storageReady: () => true,
      diskHeadroom: () => true,
      poller: workerHealth,
      reconciler: workerHealth,
      healthProbe: probe,
      maximumEvidenceAgeMilliseconds: 30_000,
   });

   const decision = paid();
   now = 40_000;
   release();
   const result = await decision;

   assert.equal(result.ready, false);
   assert.equal(result.checks.capabilityEvidenceFresh, false);
});

test('paid readiness resamples storage, disk and worker generation after awaiting provider evidence', async () => {
   let now = 0;
   let storage = true;
   let disk = true;
   let generation = 1;
   let release!: () => void;
   const gate = new Promise<void>(resolve => { release = resolve; });
   const probe = new IndexerHealthProbe(
      {
         async probeReadinessCapabilities() {
            await gate;
            return { polling: true, reconciliation: true };
         },
      },
      ASSET,
      () => now,
      15_000,
      120_000,
   );
   const workerHealth = {
      healthSnapshot: () => ({
         started: true,
         running: false,
         ready: true,
         cycleNotStalled: true,
         providerHealth: 'healthy' as const,
         consecutiveFailures: 0,
         generation,
      }),
   };
   const paid = createPaidAdmissionReadinessCheck({
      storageReady: () => storage,
      diskHeadroom: () => disk,
      poller: workerHealth,
      reconciler: workerHealth,
      healthProbe: probe,
      maximumEvidenceAgeMilliseconds: 30_000,
   });

   const decision = paid();
   storage = false;
   disk = false;
   generation += 1;
   release();

   const result = await decision;
   assert.equal(result.ready, false);
   assert.equal(result.checks.storage, false);
   assert.equal(result.checks.diskHeadroom, false);
});

test('customer success cannot reset consecutive complete-probe failures', () => {
   let now = 1_000;
   const tracker = new WorkerHealthTracker(() => now);
   tracker.markStarted();
   tracker.markProbeResult(true);

   now += 1_000;
   tracker.markProbeResult(false);
   tracker.markCycleStarted();
   tracker.markCycleCompleted({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      providerEvidence: 1,
   });
   assert.equal(tracker.snapshot(45_000).consecutiveFailures, 1);
   assert.equal(tracker.snapshot(45_000).ready, true);

   now += 1_000;
   tracker.markProbeResult(false);
   const snapshot = tracker.snapshot(45_000);
   assert.equal(snapshot.consecutiveFailures, 2);
   assert.equal(snapshot.providerHealth, 'unhealthy');
   assert.equal(snapshot.ready, false);
});

test('health evidence ages out; empty, no-op, and isolated cycles cannot renew it', () => {
   let now = 1_000;
   const tracker = new WorkerHealthTracker(() => now);
   tracker.markStarted(); tracker.markProbeResult(true);
   for (let i = 0; i < 100; i += 1) {
      tracker.markCycleStarted();
      tracker.markCycleCompleted({ attempted: 1, succeeded: 0, failed: 0, noOp: 1 });
   }
   now = 46_001;
   assert.equal(tracker.snapshot(45_000).ready, false);
   tracker.markCycleStarted();
   tracker.markCycleCompleted({ attempted: 1, succeeded: 0, failed: 1, isolatedFailures: 1 });
   assert.equal(tracker.snapshot(45_000).ready, false);
   tracker.markProbeResult(true);
   assert.equal(tracker.snapshot(45_000).ready, true);
});

test('missing-proof and inactive polling turns expose no provider evidence', async () => {
   const missing = { id: 'legacy', evidenceVersion: 0 } as WatchRecord;
   const inactive = { id: 'stale', evidenceVersion: 1, scanAfterRound: 100,
      expiresAt: '2100-01-01T00:00:00.000Z' } as WatchRecord;
   let claims = 0;
   const store = {
      listPollingCandidates: () => [missing, inactive],
      claimWorkUnit: () => { claims += 1; return 'inactive'; },
   } as unknown as RoundWatchStore;
   const indexer = fakeIndexer();
   const outcome = await new RoundWatchPoller(store, indexer).runOnce();
   assert.deepEqual(outcome, { attempted: 2, succeeded: 0, failed: 0, noOp: 2 });
   assert.equal(claims, 1);
   assert.equal(indexer.calls.length, 0);
});

test('mixed progress and isolated failure stays healthy; systemic failure wins', () => {
   const tracker = new WorkerHealthTracker();
   tracker.markStarted(); tracker.markProbeResult(true);
   tracker.markCycleStarted();
   tracker.markCycleCompleted({ attempted: 2, succeeded: 1, failed: 1,
      isolatedFailures: 1, providerEvidence: 1 });
   assert.equal(tracker.snapshot(45_000).ready, true);
   tracker.markCycleStarted();
   tracker.markCycleCompleted({ attempted: 2, succeeded: 1, failed: 1,
      providerEvidence: 1 });
   assert.equal(tracker.snapshot(45_000).ready, false);
});

function storeRecord(store: RoundWatchStore, id: string): WatchRecord {
   return store.getWatch(id)!;
}
