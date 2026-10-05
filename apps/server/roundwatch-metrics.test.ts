import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';

import {
   ALGORAND_TESTNET,
   createApp,
} from './app.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { IndexerHealthProbe } from './roundwatch-health-probe.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { RoundWatchRuntimeSampler } from './roundwatch-runtime-metrics.js';
import { IndexerRequestDispatcher, type IndexerDispatchObservation } from './roundwatch-scheduler.js';
import { RoundWatchStore, type WatchRecord } from './roundwatch-store.js';

test('watch metrics aggregate per-purpose work without exporting the watch id', () => {
   const metrics = new RoundWatchEconomicsMetrics();

   metrics.recordIndexerRequest('watch-1', 'health', {
      outcome: 'success',
      responseBytes: 120,
      queueWaitMs: 4,
      wallTimeMs: 12,
   });
   metrics.recordIndexerRequest('watch-1', 'scan-page', {
      outcome: 'timeout',
      responseBytes: 0,
      queueWaitMs: 8,
      wallTimeMs: 10_000,
   });
   metrics.recordScanPage('watch-1', {
      transactionsReturned: 7,
      transactionsExamined: 3,
   });
   metrics.recordCoverage('watch-1', 100);
   metrics.recordReconciliationAttempt('watch-1');
   metrics.recordClosingRequest('watch-1');
   metrics.recordWorkUnit('watch-1');
   metrics.recordLifecycle('watch-1', {
      activeDurationMs: 30_000,
      timeToTerminalMs: 31_000,
      finalState: 'matched',
   });

   const snapshot = metrics.snapshotWatch('watch-1');
   assert.ok(snapshot);

   assert.equal('watchId' in snapshot, false);
   assert.equal(snapshot.indexer.health.attempts, 1);
   assert.equal(snapshot.indexer.health.successes, 1);
   assert.equal(snapshot.indexer.health.responseBytes, 120);
   assert.equal(snapshot.indexer.health.queueWait.totalMs, 4);
   assert.equal(snapshot.indexer['scan-page'].attempts, 1);
   assert.equal(snapshot.indexer['scan-page'].failures, 1);
   assert.equal(snapshot.indexer['scan-page'].timeouts, 1);
   assert.equal(snapshot.scanPages, 1);
   assert.equal(snapshot.transactionsReturned, 7);
   assert.equal(snapshot.transactionsExamined, 3);
   assert.equal(snapshot.roundsCovered, 100);
   assert.equal(snapshot.reconciliationAttempts, 1);
   assert.equal(snapshot.closingRequests, 1);
   assert.equal(snapshot.workUnitsClaimed, 1);
   assert.equal(snapshot.activeDurationMs, 30_000);
   assert.equal(snapshot.timeToTerminalMs, 31_000);
   assert.equal(snapshot.finalState, 'matched');

   const finished = metrics.finishWatch('watch-1');
   assert.deepEqual(finished, snapshot);
   assert.equal(metrics.snapshotWatch('watch-1'), undefined);
   assert.equal(metrics.activeWatchMetricCount(), 0);
});

test('invalid scan observations do not partially mutate counters', () => {
   const metrics = new RoundWatchEconomicsMetrics();

   assert.throws(
      () => metrics.recordScanPage('watch-2', {
         transactionsReturned: 2,
         transactionsExamined: 3,
      }),
      /transactionsExamined cannot exceed transactionsReturned/,
   );

   const snapshot = metrics.snapshotWatch('watch-2');
   assert.equal(snapshot, undefined);
});

test('free request metrics aggregate status, bytes, and latency separately from paid watch work', () => {
   const metrics = new RoundWatchEconomicsMetrics();

   metrics.recordFreeRequest('health', {
      status: 200,
      requestBytes: 0,
      responseBytes: 36,
      wallTimeMs: 2,
   });
   metrics.recordFreeRequest('health', {
      status: 200,
      requestBytes: 0,
      responseBytes: 36,
      wallTimeMs: 4,
   });
   metrics.recordFreeRequest('watch-create-402', {
      status: 402,
      requestBytes: 240,
      responseBytes: 1_024,
      wallTimeMs: 7,
   });

   const health = metrics.snapshotFreeWork('health');
   assert.equal(health.requests, 2);
   assert.equal(health.responseBytes, 72);
   assert.equal(health.wallTime.samples, 2);
   assert.equal(health.wallTime.totalMs, 6);
   assert.equal(health.wallTime.maxMs, 4);
   assert.deepEqual(health.statuses, { '200': 2 });

   const unpaid = metrics.snapshotFreeWork('watch-create-402');
   assert.equal(unpaid.requests, 1);
   assert.equal(unpaid.requestBytes, 240);
   assert.equal(unpaid.responseBytes, 1_024);
   assert.deepEqual(unpaid.statuses, { '402': 1 });

   assert.equal(metrics.snapshotWatch('watch-does-not-exist'), undefined);
});

test('free metrics keep rejected payment attempts separate from ordinary 402 challenges', () => {
   const metrics = new RoundWatchEconomicsMetrics();

   metrics.recordFreeRequest('watch-create-402', {
      status: 402,
      responseBytes: 1_000,
      wallTimeMs: 2,
   });
   metrics.recordFreeRequest('watch-create-payment-rejected', {
      status: 402,
      responseBytes: 900,
      wallTimeMs: 5,
   });

   assert.equal(metrics.snapshotFreeWork('watch-create-402').requests, 1);
   assert.equal(
      metrics.snapshotFreeWork('watch-create-payment-rejected').requests,
      1,
   );
   assert.equal(
      metrics.snapshotFreeWork('watch-create-payment-rejected').wallTime.totalMs,
      5,
   );
});

test('Indexer client attributes dispatcher timing and response bytes to one watch', async () => {
   const metrics = new RoundWatchEconomicsMetrics();
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000,
      burst: 10,
      concurrency: 1,
   });
   const body = JSON.stringify({ round: 321 });
   const fakeFetch: typeof fetch = async () =>
      new Response(body, {
         status: 200,
         headers: { 'content-type': 'application/json' },
      });

   const indexer = new AlgorandIndexerClient(
      'https://indexer.example.test',
      dispatcher,
      fakeFetch,
      1_000,
      metrics,
   );

   assert.equal(await indexer.getCurrentRound('health', 'watch-indexer'), 321);

   const snapshot = metrics.snapshotWatch('watch-indexer');
   assert.ok(snapshot);
   assert.equal(snapshot.indexer.health.attempts, 1);
   assert.equal(snapshot.indexer.health.successes, 1);
   assert.equal(snapshot.indexer.health.failures, 0);
   assert.equal(
      snapshot.indexer.health.responseBytes,
      Buffer.byteLength(body, 'utf8'),
   );
   assert.equal(snapshot.indexer.health.queueWait.samples, 1);
   assert.equal(snapshot.indexer.health.wallTime.samples, 1);
});

for (const outcome of ['success', 'failure', 'timeout'] as const) {
   test(`held Indexer ${outcome} completion cannot resurrect finished watch metrics`, async () => {
      const metrics = new RoundWatchEconomicsMetrics();
      const watchId = `watch-late-${outcome}`;
      metrics.recordWorkUnit(watchId);
      const started = deferred<void>();
      const response = deferred<Response>();
      const dispatcher = new IndexerRequestDispatcher({
         requestsPerSecond: 1_000, burst: 10, concurrency: 1,
      });
      const indexer = new AlgorandIndexerClient(
         'https://indexer.example.test', dispatcher,
         async () => { started.resolve(); return response.promise; },
         1_000, metrics,
      );
      const error = outcome === 'timeout'
         ? new DOMException('Held request timed out', 'TimeoutError')
         : new Error('Held request failed');
      const pending = indexer.getCurrentRound('activation', watchId);
      const completion = outcome === 'success'
         ? pending.then(round => assert.equal(round, 321))
         : assert.rejects(pending, candidate => candidate === error);
      await started.promise;

      metrics.recordLifecycle(watchId, {
         finalState: 'indeterminate', timeToTerminalMs: 42,
      });
      const terminal = metrics.finishWatch(watchId);
      assert.ok(terminal);
      assert.equal(terminal.workUnitsClaimed, 1);
      assert.equal(terminal.finalState, 'indeterminate');
      assert.equal(terminal.indexer.activation.attempts, 0);
      const savedTerminal = structuredClone(terminal);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      assert.equal(metrics.snapshotWatch(watchId), undefined);

      if (outcome === 'success') response.resolve(Response.json({ round: 321 }));
      else response.reject(error);
      await completion;

      assert.equal(dispatcher.snapshot().successes, outcome === 'success' ? 1 : 0);
      assert.equal(dispatcher.snapshot().failures, outcome === 'success' ? 0 : 1);
      assert.equal(dispatcher.snapshot().timeouts, outcome === 'timeout' ? 1 : 0);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      assert.equal(metrics.snapshotWatch(watchId), undefined);
      assert.equal(metrics.finishWatch(watchId), undefined);
      assert.deepEqual(terminal, savedTerminal);
   });
}

test('multiple in-flight and queued Indexer completions cannot resurrect finished metrics', async () => {
   const metrics = new RoundWatchEconomicsMetrics();
   const watchId = 'watch-multiple-late';
   metrics.recordWorkUnit(watchId);
   const started = deferred<void>();
   const release = deferred<void>();
   let fetches = 0;
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000, burst: 10, concurrency: 3,
   });
   const indexer = new AlgorandIndexerClient(
      'https://indexer.example.test', dispatcher,
      async () => {
         fetches += 1;
         if (fetches === 3) started.resolve();
         await release.promise;
         return Response.json({ round: 321 });
      },
      1_000, metrics,
   );
   const pending = Promise.all([
      indexer.getCurrentRound('activation', watchId),
      indexer.getCurrentRound('reconciliation', watchId),
      indexer.getCurrentRound('checkpoint', watchId),
      indexer.getCurrentRound('absence-proof', watchId),
   ]);
   await started.promise;
   assert.equal(dispatcher.snapshot().inFlight, 3);
   assert.equal(dispatcher.snapshot().queued, 1);
   metrics.recordLifecycle(watchId, { finalState: 'matched' });
   const terminal = metrics.finishWatch(watchId);
   assert.ok(terminal);
   const savedTerminal = structuredClone(terminal);
   assert.equal(metrics.activeWatchMetricCount(), 0);

   release.resolve();
   assert.deepEqual(await pending, [321, 321, 321, 321]);
   assert.equal(fetches, 4);
   assert.equal(dispatcher.snapshot().successes, 4);
   assert.equal(metrics.activeWatchMetricCount(), 0);
   assert.equal(metrics.snapshotWatch(watchId), undefined);
   assert.equal(metrics.finishWatch(watchId), undefined);
   assert.deepEqual(terminal, savedTerminal);
});

test('Indexer observations completed before finish remain in the single terminal snapshot', async () => {
   const metrics = new RoundWatchEconomicsMetrics();
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000, burst: 10, concurrency: 1,
   });
   const body = JSON.stringify({ round: 321 });
   const failure = new Error('Request failed');
   const timeout = new DOMException('Request timed out', 'TimeoutError');
   let attempt = 0;
   const indexer = new AlgorandIndexerClient(
      'https://indexer.example.test', dispatcher,
      async () => {
         attempt += 1;
         if (attempt === 2) throw failure;
         if (attempt === 3) throw timeout;
         return new Response(body);
      },
      1_000, metrics,
   );
   const watchId = 'watch-before-finish';
   // No pre-created entry: the first live request must still be attributed.
   assert.equal(await indexer.getCurrentRound('health', watchId), 321);
   await assert.rejects(indexer.getCurrentRound('health', watchId), failure);
   await assert.rejects(indexer.getCurrentRound('health', watchId), timeout);
   assert.equal(metrics.activeWatchMetricCount(), 1);
   metrics.recordLifecycle(watchId, { finalState: 'expired' });
   const snapshot = metrics.snapshotWatch(watchId);
   assert.ok(snapshot);
   assert.equal(snapshot.indexer.health.attempts, 3);
   assert.equal(snapshot.indexer.health.successes, 1);
   assert.equal(snapshot.indexer.health.failures, 2);
   assert.equal(snapshot.indexer.health.timeouts, 1);
   assert.equal(snapshot.indexer.health.responseBytes, Buffer.byteLength(body));
   assert.equal(snapshot.indexer.health.queueWait.samples, 3);
   assert.equal(snapshot.indexer.health.wallTime.samples, 3);
   assert.equal(snapshot.finalState, 'expired');
   assert.deepEqual(metrics.finishWatch(watchId), snapshot);
   assert.equal(metrics.finishWatch(watchId), undefined);
   assert.equal(metrics.activeWatchMetricCount(), 0);
   assert.equal(metrics.snapshotWatch(watchId), undefined);
});

test('finished recorders fence all observations and cannot affect a replacement lifecycle', () => {
   const metrics = new RoundWatchEconomicsMetrics();
   const watchId = 'watch-recorder';
   const first = metrics.captureWatch(watchId);
   const competing = metrics.captureWatch(watchId);
   first.recordWorkUnit();
   first.recordLifecycle({ finalState: 'matched' });
   const terminal = first.finishWatch();
   assert.ok(terminal);
   const savedTerminal = structuredClone(terminal);

   const observeLate = () => {
      competing.recordIndexerRequest('scan-page', { outcome: 'timeout' });
      competing.recordScanPage({ transactionsReturned: 3, transactionsExamined: 2 });
      competing.recordCoverage(100);
      competing.recordReconciliationAttempt();
      competing.recordClosingRequest();
      competing.recordWorkUnit();
      competing.recordLifecycle({ finalState: 'expired', timeToTerminalMs: 999 });
      assert.equal(competing.finishWatch(), undefined);
   };
   observeLate();
   assert.equal(metrics.activeWatchMetricCount(), 0);
   assert.equal(metrics.snapshotWatch(watchId), undefined);
   assert.equal(metrics.captureExistingWatch(watchId), undefined);

   // Production IDs are unique; identity fencing also isolates a deliberately
   // created new lifecycle using the same synthetic ID from its old recorder.
   const replacement = metrics.captureWatch(watchId);
   replacement.recordWorkUnit();
   const beforeLate = metrics.snapshotWatch(watchId);
   observeLate();
   assert.equal(metrics.activeWatchMetricCount(), 1);
   assert.deepEqual(metrics.snapshotWatch(watchId), beforeLate);
   assert.deepEqual(terminal, savedTerminal);
   assert.deepEqual(replacement.finishWatch(), beforeLate);
   assert.equal(metrics.activeWatchMetricCount(), 0);
});

test('finishing many watch lifecycles releases every active metrics entry', () => {
   const metrics = new RoundWatchEconomicsMetrics();
   for (let index = 0; index < 1_000; index += 1) {
      const watchId = `watch-finished-${index}`;
      const recorder = metrics.captureWatch(watchId);
      recorder.recordWorkUnit();
      assert.equal(metrics.activeWatchMetricCount(), 1);
      assert.ok(recorder.finishWatch());
      recorder.recordWorkUnit();
      assert.equal(metrics.activeWatchMetricCount(), 0);
      assert.equal(metrics.snapshotWatch(watchId), undefined);
   }
});

test('overlapping poller turns keep late scan metrics and terminal logs fenced', async t => {
   const now = new Date('2026-09-19T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const metrics = new RoundWatchEconomicsMetrics();
   const started = deferred<void>();
   const response = deferred<Response>();
   const logs: string[] = [];
   t.mock.method(console, 'info', (message: string) => logs.push(message));
   let tips = 0;
   let scans = 0;
   const watch = prepareMetricsWatch(store, 'poller').watch;
   store.activateWatch(watch.id, {
      transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET,
      payer: watch.expectedServicePayer!,
   }, 100);
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000, burst: 10, concurrency: 2,
   });
   const indexer = new AlgorandIndexerClient(
      'https://indexer.example.test', dispatcher,
      async input => {
         const url = new URL(String(input));
         if (url.pathname === '/health') {
            tips += 1;
            if (tips === 1) { started.resolve(); return response.promise; }
            return Response.json({ round: 110 });
         }
         assert.equal(url.pathname, `/v2/assets/${watch.assetId}/transactions`);
         scans += 1;
         return Response.json({
            'current-round': 110,
            transactions: [{
               id: 'A'.repeat(51) + 'Q', sender: watch.expectedSender,
               'tx-type': 'axfer', 'confirmed-round': 105,
               'round-time': now.getTime() / 1_000,
               'asset-transfer-transaction': {
                  'asset-id': watch.assetId, amount: Number(watch.atomicAmount),
                  receiver: watch.expectedReceiver,
               },
            }],
         });
      },
      1_000, metrics,
   );
   const poller = new RoundWatchPoller(store, indexer, 5_000, 100, () => now, metrics, 0);
   try {
      const heldTurn = poller.runOnce();
      await started.promise;
      await poller.runOnce();
      assert.equal(store.getWatch(watch.id)?.state, 'matched');
      assert.equal(logs.length, 1);
      const terminal = JSON.parse(logs[0]!.replace('RoundWatch economics watch-terminal ', ''));
      assert.equal(terminal.finalState, 'matched');
      assert.equal(terminal.workUnitsClaimed, 2);
      assert.equal(terminal.scanPages, 1);
      assert.equal(terminal.transactionsReturned, 1);
      assert.equal(terminal.transactionsExamined, 1);
      assert.equal(terminal.indexer['scan-page'].successes, 1);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      const savedLogs = [...logs];

      response.resolve(Response.json({ round: 110 }));
      await heldTurn;
      assert.equal(scans, 2); // The stale turn starts another request after finish.
      assert.deepEqual(logs, savedLogs);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      assert.equal(metrics.snapshotWatch(watch.id), undefined);
   } finally {
      store.close();
   }
});

test('late reconciler continuation keeps follow-up requests and terminal logs fenced', async t => {
   const now = new Date('2026-09-19T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const metrics = new RoundWatchEconomicsMetrics();
   const started = deferred<void>();
   const response = deferred<Response>();
   const logs: string[] = [];
   t.mock.method(console, 'info', (message: string) => logs.push(message));
   let lookups = 0;
   let followUps = 0;
   const watch = prepareMetricsWatch(store, 'reconciler').watch;
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 1_000, burst: 10, concurrency: 2,
   });
   const indexer = new AlgorandIndexerClient(
      'https://indexer.example.test', dispatcher,
      async input => {
         const url = new URL(String(input));
         if (url.pathname === `/v2/transactions/${watch.expectedServiceTransaction}`) {
            lookups += 1;
            if (lookups === 1) { started.resolve(); return response.promise; }
            return Response.json({ transaction: {
               id: watch.expectedServiceTransaction, sender: watch.expectedServicePayer,
               'tx-type': 'axfer', 'confirmed-round': 100,
               'round-time': now.getTime() / 1_000,
               'asset-transfer-transaction': {
                  'asset-id': watch.serviceAssetId, amount: 1_000,
                  receiver: watch.expectedServicePayer, // Mismatched immutable terms.
               },
            } });
         }
         followUps += 1;
         if (url.pathname === '/health') return Response.json({ round: 200 });
         assert.equal(url.pathname, '/v2/transactions');
         return Response.json({ 'current-round': 200, transactions: [] });
      },
      1_000, metrics,
   );
   const config = { network: ALGORAND_TESTNET, intervalMilliseconds: 5_000, now: () => now };
   try {
      const heldTurn = new SettlementReconciler(store, indexer, config, metrics).reconcileOnce();
      await started.promise;
      await new SettlementReconciler(store, indexer, config, metrics).reconcileOnce();
      assert.equal(logs.length, 1);
      const terminal = JSON.parse(logs[0]!.replace('RoundWatch economics watch-terminal ', ''));
      assert.equal(terminal.finalState, 'settlement_unknown');
      assert.equal(terminal.workUnitsClaimed, 2);
      assert.equal(terminal.reconciliationAttempts, 2);
      assert.equal(terminal.indexer.reconciliation.successes, 1);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      const savedLogs = [...logs];

      response.resolve(new Response(null, { status: 404 }));
      await heldTurn;
      assert.equal(followUps, 2);
      assert.deepEqual(logs, savedLogs);
      assert.equal(metrics.activeWatchMetricCount(), 0);
      assert.equal(metrics.snapshotWatch(watch.id), undefined);
   } finally {
      store.close();
   }
});

test('watch IDs are UUID lifecycle identifiers preserved by idempotent recovery', () => {
   const store = new RoundWatchStore(':memory:');
   try {
      const first = prepareMetricsWatch(store, 'identity-first');
      store.activateWatch(first.watch.id, {
         transaction: first.watch.expectedServiceTransaction!, network: ALGORAND_TESTNET,
         payer: first.watch.expectedServicePayer!,
      }, 100);
      store.markMatched(first.watch.id, 'A'.repeat(51) + 'Q', 105);
      const recovered = prepareMetricsWatch(store, 'identity-first');
      assert.equal(recovered.created, false);
      assert.equal(recovered.watch.id, first.watch.id);
      assert.equal(recovered.watch.state, 'matched');
      const second = prepareMetricsWatch(store, 'identity-second', '7'.repeat(51) + 'A');
      assert.equal(second.created, true);
      assert.notEqual(second.watch.id, first.watch.id);
      for (const id of [first.watch.id, second.watch.id]) {
         assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
   } finally {
      store.close();
   }
});

for (const workUnitBudget of [1, 2]) {
   test(`a stale reconciler candidate cannot restart finished metrics with budget ${workUnitBudget}`, async t => {
      const now = new Date('2026-09-19T12:00:00.000Z');
      const store = new RoundWatchStore(':memory:', { now: () => now, workUnitBudget });
      const metrics = new RoundWatchEconomicsMetrics();
      const first = prepareMetricsWatch(store, 'stale-first').watch;
      const second = prepareMetricsWatch(store, 'stale-second', '7'.repeat(51) + 'A').watch;
      let selections = 0;
      t.mock.method(store, 'listSettlementReconciliationCandidates', () =>
         ++selections === 1 ? [first, second] : [second]);
      const logs: string[] = [];
      t.mock.method(console, 'info', (message: string) => logs.push(message));
      const started = deferred<void>();
      const response = deferred<Response>();
      let secondLookups = 0;
      const indexer = new AlgorandIndexerClient(
         'https://indexer.example.test',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 }),
         async input => {
            const url = new URL(String(input));
            if (url.pathname === `/v2/transactions/${first.expectedServiceTransaction}`) {
               started.resolve();
               return response.promise;
            }
            if (url.pathname === '/health') return Response.json({ round: 100 });
            assert.equal(url.pathname, `/v2/transactions/${second.expectedServiceTransaction}`);
            secondLookups += 1;
            return Response.json({ transaction: {
               id: second.expectedServiceTransaction, sender: second.expectedServicePayer,
               'tx-type': 'axfer', 'confirmed-round': 100, 'round-time': now.getTime() / 1_000,
               'asset-transfer-transaction': {
                  'asset-id': second.serviceAssetId, amount: 1_000,
                  receiver: second.expectedServicePayer,
               },
            } });
         },
         1_000, metrics,
      );
      const config = { network: ALGORAND_TESTNET, intervalMilliseconds: 5_000, now: () => now };
      try {
         const sweep = new SettlementReconciler(store, indexer, config, metrics).reconcileOnce();
         await started.promise;
         await new SettlementReconciler(store, indexer, config, metrics).reconcileOnce();
         assert.equal(store.getWatch(second.id)?.settlementReconciliationTerminal, true);
         assert.equal(metrics.snapshotWatch(second.id), undefined);
         assert.equal(logs.length, 1);
         const savedLogs = [...logs];

         response.resolve(new Response(null, { status: 404 }));
         await sweep;
         assert.equal(secondLookups, workUnitBudget); // Existing settlement behavior is preserved.
         assert.equal(metrics.snapshotWatch(second.id), undefined);
         assert.deepEqual(logs, savedLogs);
         assert.equal(metrics.activeWatchMetricCount(), 1); // Only the unfinished first watch.
         assert.equal(metrics.snapshotWatch(first.id)?.reconciliationAttempts, 1);
         metrics.finishWatch(first.id);
         assert.equal(metrics.activeWatchMetricCount(), 0);
      } finally {
         store.close();
      }
   });
}

test('B3 telemetry capture failure does not abort a permanent-error poller sweep or recapture after await', async t => {
   const now = new Date('2026-09-19T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', { now: () => now });
   const metrics = new RoundWatchEconomicsMetrics();
   const first = prepareMetricsWatch(store, 'capture-error-first').watch;
   const second = prepareMetricsWatch(store, 'capture-error-second', '7'.repeat(51) + 'A').watch;
   for (const [watch, round] of [[first, 100], [second, 101]] as const) {
      store.activateWatch(watch.id, {
         transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET,
         payer: watch.expectedServicePayer!,
      }, round);
   }
   const telemetryError = new Error('synthetic terminal capture failure');
   metrics.captureWatch(first.id).recordWorkUnit();
   const captureWatch = metrics.captureWatch.bind(metrics);
   t.mock.method(metrics, 'captureWatch', (id: string) => {
      if (id === first.id) throw telemetryError;
      return captureWatch(id);
   });
   const capture = metrics.captureExistingWatch.bind(metrics);
   let recaptures = 0;
   t.mock.method(metrics, 'captureExistingWatch', (id: string) => {
      recaptures += 1;
      if (id === first.id) throw telemetryError;
      return capture(id);
   });
   const warnings: string[] = [];
   t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
   const probe = new IndexerHealthProbe({
      probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
   }, first.assetId);
   let scans = 0;
   const indexer = new AlgorandIndexerClient('https://indexer.example.test',
      new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
      async input => {
         const url = new URL(String(input));
         if (url.pathname === '/health') return Response.json({ round: 110 });
         scans += 1;
         if (url.searchParams.get('min-round') === '101') {
            return Response.json({
               message: 'invalid input: searching transactions by zero address with asset sender role is not supported',
            }, { status: 400 });
         }
         return Response.json({ 'current-round': 110, transactions: [] });
      }, 1_000, metrics);
   try {
      const result = await new RoundWatchPoller(store, indexer, 5_000, 100, () => now,
         metrics, 0, 0, probe).runOnce();
      assert.equal(result.attempted, 2);
      assert.equal(result.failed, 1);
      assert.equal(result.succeeded, 1);
      assert.equal(scans, 2);
      assert.equal(recaptures, 0, 'the failed turn must keep its pre-await binding');
      assert.equal(store.getWatch(first.id)?.state, 'indeterminate');
      assert.equal(metrics.snapshotWatch(first.id), undefined);
      assert.equal(store.getWatch(second.id)?.scanAfterRound, 110);
      assert.equal(probe.currentFailureEpoch(), 0, 'telemetry failure is not a provider failure');
      assert.ok(warnings.some(message => message.includes('economics') && message.includes(telemetryError.message)));
   } finally {
      store.close();
   }
});

for (const outcome of ['success', 'failure', 'timeout'] as const) {
   test(`B3 telemetry disabled poller recorder blocks late ${outcome} fallback`, async t => {
      const now = new Date('2026-09-19T12:00:00.000Z');
      const store = new RoundWatchStore(':memory:', { now: () => now, workUnitBudget: 1 });
      const metrics = new RoundWatchEconomicsMetrics();
      const watch = prepareMetricsWatch(store, `disabled-${outcome}`).watch;
      store.activateWatch(watch.id, {
         transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET,
         payer: watch.expectedServicePayer!,
      }, 100);
      const capture = metrics.captureWatch.bind(metrics);
      let captures = 0;
      t.mock.method(metrics, 'captureWatch', (id: string) => {
         captures += 1;
         if (captures === 1) throw new Error('synthetic initial capture failure');
         return capture(id);
      });
      const started = deferred<void>();
      const response = deferred<Response>();
      const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
      const probe = new IndexerHealthProbe({
         probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
      }, watch.assetId);
      const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher,
         async input => {
            if (new URL(String(input)).pathname === '/health') { started.resolve(); return response.promise; }
            if (outcome === 'failure') throw new Error('synthetic scan failure');
            if (outcome === 'timeout') throw new DOMException('synthetic scan timeout', 'TimeoutError');
            return Response.json({ 'current-round': 110, transactions: [] });
         }, 1_000, metrics);
      const poller = new RoundWatchPoller(store, indexer, 5_000, 100, () => now, metrics, 0, 0, probe);
      let pending: ReturnType<typeof poller.runOnce> | undefined;
      try {
         pending = poller.runOnce();
         await started.promise;
         assert.equal(probe.currentFailureEpoch(), 0, 'initial capture failure does not invalidate provider health');
         await poller.runOnce();
         assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');
         assert.equal(metrics.activeWatchMetricCount(), 0);
         response.resolve(Response.json({ round: 110 }));
         const result = await pending;
         assert.equal(result.failed, outcome === 'success' ? 0 : 1);
         assert.equal(dispatcher.snapshot().timeouts, outcome === 'timeout' ? 1 : 0);
         assert.equal(captures, 2, 'late request must not retry capture after another worker finished the lifecycle');
         assert.equal(metrics.activeWatchMetricCount(), 0);
         assert.equal(metrics.snapshotWatch(watch.id), undefined);
      } finally {
         response.resolve(Response.json({ round: 110 }));
         await pending;
         store.close();
      }
   });
}

for (const terminal of ['mismatch', 'absence', 'budget'] as const) {
   for (const entry of ['existing', 'partial-capture', 'cleanup-error'] as const) {
      test(`B3 terminal cleanup reconciler ${terminal} after ${entry} capture failure`, async t => {
         let now = new Date('2026-09-19T12:00:00.000Z');
         const store = new RoundWatchStore(':memory:', { now: () => now, workUnitBudget: terminal === 'budget' ? 1 : 10 });
         const metrics = new RoundWatchEconomicsMetrics();
         const watch = prepareMetricsWatch(store, `terminal-${terminal}-${entry}`).watch;
         const logs: string[] = [];
         const warnings: string[] = [];
         t.mock.method(console, 'info', (message: string) => logs.push(message));
         t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
         const probe = new IndexerHealthProbe({
            probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
         }, watch.assetId);
         let warmup = true;
         let requests = 0;
         const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
         const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, async input => {
            requests += 1;
            const url = new URL(String(input));
            if (url.pathname === '/health') return Response.json({ round: warmup ? 100 : 200 });
            if (url.pathname === '/v2/transactions') return Response.json({ 'current-round': 200, transactions: [] });
            assert.equal(url.pathname, `/v2/transactions/${watch.expectedServiceTransaction}`);
            return !warmup && terminal === 'mismatch'
               ? metricsSettlementTransferResponse(watch, false)
               : new Response(null, { status: 404 });
         }, 1_000, metrics);
         const reconciler = new SettlementReconciler(store, indexer, {
            network: ALGORAND_TESTNET, intervalMilliseconds: 5_000, now: () => now,
         }, metrics, probe);
         try {
            if (entry !== 'partial-capture') {
               assert.equal((await reconciler.reconcileOnce()).failed, 0);
               assert.equal(store.getWatch(watch.id)?.state, 'settlement_pending');
               assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, 1);
               assert.equal(metrics.snapshotWatch(watch.id)?.indexer.reconciliation.successes, 2);
            } else if (terminal === 'budget') {
               assert.equal(store.claimWorkUnit(watch.id), 'claimed');
            }
            warmup = false;
            requests = 0;
            now = new Date(now.getTime() + 2_000);
            const capture = metrics.captureWatch.bind(metrics);
            let captures = 0;
            t.mock.method(metrics, 'captureWatch', (id: string) => {
               captures += 1;
               if (entry === 'partial-capture') {
                  assert.equal(metrics.snapshotWatch(id), undefined);
                  capture(id).recordWorkUnit();
               }
               assert.ok(metrics.snapshotWatch(id));
               throw new Error('synthetic terminal capture failure');
            });
            const bindRelease = metrics.bindWatchRelease.bind(metrics);
            let cleanups = 0;
            t.mock.method(metrics, 'bindWatchRelease', (id: string) => {
               const release = bindRelease(id);
               if (!release) return;
               return () => {
                  cleanups += 1;
                  release();
                  if (entry === 'cleanup-error') throw new Error('synthetic terminal cleanup failure');
               };
            });
            const result = await reconciler.reconcileOnce();
            const persisted = store.getWatch(watch.id)!;
            assert.equal(persisted.state, terminal === 'budget' ? 'indeterminate' : 'settlement_unknown');
            assert.equal(persisted.settlementReconciliationTerminal, true);
            if (terminal === 'budget') assert.equal(persisted.terminalReason, 'work_budget_exhausted');
            assert.equal(result.failed, 0, 'telemetry failure must not become a provider failure');
            assert.equal(terminal === 'budget' ? result.noOp : result.succeeded, 1);
            assert.equal(requests, terminal === 'budget' ? 0 : terminal === 'mismatch' ? 1 : 3);
            assert.equal(probe.currentFailureEpoch(), 0);
            assert.equal(dispatcher.snapshot().failures, 0);
            assert.equal(captures, 1, 'terminal cleanup and Indexer must not retry capture');
            assert.equal(metrics.activeWatchMetricCount(), 0);
            assert.equal(metrics.snapshotWatch(watch.id), undefined);
            assert.equal(cleanups, 1);
            assert.deepEqual(logs, [], 'fallback must not publish an incomplete terminal snapshot');
            if (entry === 'cleanup-error') {
               assert.ok(warnings.some(message => message.includes('economics') && message.includes('synthetic terminal cleanup failure')));
            }
            assert.equal((await reconciler.reconcileOnce()).attempted, 0);
            assert.equal(cleanups, 1, 'a finished lifecycle must not emit or clean up twice');
         } finally {
            store.close();
         }
      });
   }
}

for (const outcome of ['valid', 'unconfirmed'] as const) {
   test(`B3 terminal cleanup reconciler preserves live metrics after ${outcome} capture failure`, async t => {
      const store = new RoundWatchStore(':memory:');
      const metrics = new RoundWatchEconomicsMetrics();
      const watch = prepareMetricsWatch(store, `live-${outcome}`).watch;
      const recorder = metrics.captureWatch(watch.id);
      recorder.recordWorkUnit();
      let captures = 0;
      t.mock.method(metrics, 'captureWatch', () => {
         captures += 1;
         throw new Error('synthetic live capture failure');
      });
      const logs: string[] = [];
      t.mock.method(console, 'info', (message: string) => logs.push(message));
      const indexer = new AlgorandIndexerClient('https://indexer.example.test',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
         async input => new URL(String(input)).pathname === '/health'
            ? Response.json({ round: 100 })
            : outcome === 'valid' ? metricsSettlementTransferResponse(watch) : new Response(null, { status: 404 }),
         1_000, metrics);
      try {
         const result = await new SettlementReconciler(store, indexer, {
            network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
         }, metrics).reconcileOnce();
         assert.equal(result.failed, 0);
         assert.equal(store.getWatch(watch.id)?.state, outcome === 'valid' ? 'active' : 'settlement_pending');
         assert.equal(store.getWatch(watch.id)?.settlementReconciliationTerminal, false);
         assert.equal(captures, 1, 'failed capture must not trigger Indexer fallback');
         assert.equal(metrics.activeWatchMetricCount(), 1);
         recorder.recordWorkUnit();
         assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, 2);
         assert.deepEqual(logs, []);
      } finally {
         store.close();
      }
   });
}

for (const captureFails of [true, false]) {
   test(`B3 terminal cleanup reconciler rejects stale mismatch intent with capture failure=${captureFails}`, async t => {
      const store = new RoundWatchStore(':memory:');
      const metrics = new RoundWatchEconomicsMetrics();
      const watch = prepareMetricsWatch(store, `stale-live-${captureFails}`).watch;
      const recorder = metrics.captureWatch(watch.id);
      recorder.recordWorkUnit();
      if (captureFails) t.mock.method(metrics, 'captureWatch', () => { throw new Error('synthetic stale capture failure'); });
      const logs: string[] = [];
      t.mock.method(console, 'info', (message: string) => logs.push(message));
      const started = deferred<void>();
      const response = deferred<Response>();
      const indexer = new AlgorandIndexerClient('https://indexer.example.test',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
         async () => { started.resolve(); return response.promise; }, 1_000, metrics);
      let pending: Promise<unknown> | undefined;
      try {
         pending = new SettlementReconciler(store, indexer, {
            network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
         }, metrics).reconcileOnce();
         await started.promise;
         store.activateWatch(watch.id, {
            transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET, payer: watch.expectedServicePayer!,
         }, 100);
         const snapshot = metrics.snapshotWatch(watch.id)!;
         response.resolve(metricsSettlementTransferResponse(watch, false));
         await pending;
         assert.equal(store.getWatch(watch.id)?.state, 'active');
         assert.equal(store.getWatch(watch.id)?.settlementReconciliationTerminal, false);
         assert.equal(metrics.activeWatchMetricCount(), 1);
         assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, snapshot.workUnitsClaimed);
         recorder.recordWorkUnit();
         assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, snapshot.workUnitsClaimed + 1);
         assert.deepEqual(logs, []);
      } finally {
         response.resolve(metricsSettlementTransferResponse(watch));
         await pending;
         store.close();
      }
   });
}

for (const order of ['observer-first', 'finish-first'] as const) {
   for (const outcome of ['success', 'failure', 'timeout'] as const) {
      test(`B3 followup F4 ${order} preserves ${outcome} at completion boundary`, async t => {
         const metrics = new RoundWatchEconomicsMetrics();
         const watchId = `observer-${order}-${outcome}`;
         const recorder = metrics.captureWatch(watchId);
         const operationStarted = deferred<void>();
         const operationGate = deferred<void>();
         const observed = deferred<IndexerDispatchObservation>();
         const apiGate = deferred<void>();
         let monotonic = 0;
         const dispatcher = new IndexerRequestDispatcher({
            requestsPerSecond: 1_000, burst: 10, concurrency: 1, now: () => monotonic,
         });
         const dispatch = dispatcher.dispatch.bind(dispatcher);
         t.mock.method(dispatcher, 'dispatch', async (...args: Parameters<typeof dispatch>) => {
            try {
               const result = await dispatch(args[0], args[1], observation => {
                  args[2]?.(observation);
                  observed.resolve(observation);
               });
               await apiGate.promise;
               return result;
            } catch (error) {
               await apiGate.promise;
               throw error;
            }
         });
         const body = JSON.stringify({ round: 321 });
         let providerError: unknown = new Error('synthetic provider failure');
         const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, async (_input, init) => {
            operationStarted.resolve();
            await operationGate.promise;
            if (outcome === 'timeout') {
               return new Promise<Response>((_resolve, reject) => {
                  const signal = init!.signal!;
                  const timeout = () => { clearTimeout(keepAlive); monotonic = 13; providerError = signal.reason; reject(providerError); };
                  const keepAlive = setTimeout(() => reject(new Error('timeout signal did not fire')), 500);
                  if (signal.aborted) timeout();
                  else signal.addEventListener('abort', timeout, { once: true });
               });
            }
            monotonic = 7;
            if (outcome === 'failure') throw providerError;
            return new Response(body);
         }, 20, metrics);
         let apiSettled = false;
         const pending = indexer.getCurrentRound('activation', watchId, recorder).then(
            value => { apiSettled = true; return { value }; },
            error => { apiSettled = true; return { error }; },
         );
         let terminal: ReturnType<typeof metrics.finishWatch>;
         try {
            await operationStarted.promise;
            if (order === 'finish-first') terminal = recorder.finishWatch();
            operationGate.resolve();
            const observation = await observed.promise;
            assert.equal(apiSettled, false, 'public API stays held after the real dispatcher observer');
            assert.equal(observation.outcome, outcome);
            if (order === 'observer-first') terminal = recorder.finishWatch();
            assert.ok(terminal);
            const before = structuredClone(terminal);
            const request = terminal.indexer.activation;
            assert.equal(request.attempts, order === 'observer-first' ? 1 : 0);
            assert.equal(request.successes, order === 'observer-first' && outcome === 'success' ? 1 : 0);
            assert.equal(request.failures, order === 'observer-first' && outcome !== 'success' ? 1 : 0);
            assert.equal(request.timeouts, order === 'observer-first' && outcome === 'timeout' ? 1 : 0);
            assert.equal(request.responseBytes, order === 'observer-first' && outcome === 'success' ? Buffer.byteLength(body) : 0);
            assert.equal(request.queueWait.samples, order === 'observer-first' ? 1 : 0);
            assert.equal(request.queueWait.totalMs, 0);
            assert.equal(request.wallTime.totalMs, order === 'observer-first' ? outcome === 'timeout' ? 13 : 7 : 0);
            apiGate.resolve();
            const result = await pending;
            if (outcome === 'success') assert.deepEqual(result, { value: 321 });
            else assert.equal('error' in result && result.error, providerError);
            if (outcome === 'timeout') assert.equal((providerError as Error).name, 'TimeoutError');
            assert.deepEqual(terminal, before);
            assert.equal(metrics.activeWatchMetricCount(), 0);
            assert.equal(metrics.snapshotWatch(watchId), undefined);
         } finally {
            operationGate.resolve(); apiGate.resolve(); await pending;
         }
      });
   }
}

for (const scenario of ['invalid-json', 'protocol', 'accepted-404', 'dispatch-rejection', 'record-throw'] as const) {
   test(`B3 followup F4 counts ${scenario} exactly once and preserves provider result`, async t => {
      const metrics = new RoundWatchEconomicsMetrics();
      const watchId = `observer-case-${scenario}`;
      const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 });
      const rejection = new Error('synthetic pre-observer dispatch rejection');
      if (scenario === 'dispatch-rejection') t.mock.method(dispatcher, 'dispatch', () => Promise.reject(rejection));
      let records = 0;
      const record = metrics.recordIndexerRequest.bind(metrics);
      t.mock.method(metrics, 'recordIndexerRequest', (...args: Parameters<typeof record>) => {
         records += 1;
         record(...args);
         if (scenario === 'record-throw') throw new Error('synthetic partial observation write');
      });
      if (scenario === 'record-throw') t.mock.method(console, 'warn', () => { throw new Error('synthetic observer warning sink'); });
      const body = scenario === 'invalid-json' ? '{' : JSON.stringify({ round: scenario === 'protocol' ? 'invalid' : 321 });
      const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher,
         async () => scenario === 'accepted-404' ? new Response(null, { status: 404, headers: { 'content-length': '17' } }) : new Response(body),
         1_000, metrics);
      if (scenario === 'accepted-404') assert.equal(await indexer.lookupAssetTransfer('A'.repeat(52), 'activation', watchId), undefined);
      else if (scenario === 'dispatch-rejection') await assert.rejects(indexer.getCurrentRound('activation', watchId), error => error === rejection);
      else if (scenario === 'invalid-json') await assert.rejects(indexer.getCurrentRound('activation', watchId), /Indexer activation response was not valid JSON/);
      else if (scenario === 'protocol') await assert.rejects(indexer.getCurrentRound('activation', watchId), /health round is not a non-negative safe integer/);
      else assert.equal(await indexer.getCurrentRound('activation', watchId), 321);
      const request = metrics.finishWatch(watchId)!.indexer.activation;
      assert.equal(records, 1, 'observer failure must not trigger a second write from the continuation');
      assert.equal(request.attempts, 1);
      assert.equal(request.successes, scenario === 'accepted-404' || scenario === 'record-throw' ? 1 : 0);
      assert.equal(request.failures, scenario === 'accepted-404' || scenario === 'record-throw' ? 0 : 1);
      assert.equal(request.responseBytes, scenario === 'dispatch-rejection' ? 0 : scenario === 'accepted-404' ? 17 : Buffer.byteLength(body));
      assert.equal(request.queueWait.samples, 1);
      assert.equal(request.wallTime.samples, 1);
   });
}

test('B3 followup F4 queued and in-flight observers precede all held public continuations', async t => {
   const metrics = new RoundWatchEconomicsMetrics();
   const watchId = 'observers-many';
   const gate = deferred<void>();
   const allObserved = deferred<void>();
   const dispatcher = new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 2 });
   const dispatch = dispatcher.dispatch.bind(dispatcher);
   let observers = 0;
   t.mock.method(dispatcher, 'dispatch', async (...args: Parameters<typeof dispatch>) => {
      const result = await dispatch(args[0], args[1], observation => {
         args[2]?.(observation);
         if (++observers === 4) allObserved.resolve();
      });
      await gate.promise;
      return result;
   });
   const body = JSON.stringify({ round: 321 });
   const indexer = new AlgorandIndexerClient('https://indexer.example.test', dispatcher, async () => new Response(body), 1_000, metrics);
   const pending = Promise.all(Array.from({ length: 4 }, () => indexer.getCurrentRound('activation', watchId)));
   try {
      assert.equal(dispatcher.snapshot().inFlight, 2);
      assert.equal(dispatcher.snapshot().queued, 2);
      await allObserved.promise;
      const terminal = metrics.finishWatch(watchId)!;
      assert.equal(terminal.indexer.activation.attempts, 4);
      assert.equal(terminal.indexer.activation.responseBytes, 4 * Buffer.byteLength(body));
      const saved = structuredClone(terminal);
      gate.resolve();
      assert.deepEqual(await pending, [321, 321, 321, 321]);
      assert.deepEqual(terminal, saved);
      assert.equal(metrics.activeWatchMetricCount(), 0);
   } finally { gate.resolve(); await pending; }
});

const terminalFaults = ['record', 'finish-before', 'finish-after', 'log', 'warning'] as const;
type TerminalFault = typeof terminalFaults[number];

for (const path of ['match', 'permanent-error'] as const) {
   for (const fault of terminalFaults) {
      test(`B3 followup F1 poller ${path} contains ${fault}`, async t => {
         const now = new Date('2026-09-19T12:00:00.000Z');
         const store = new RoundWatchStore(':memory:', { now: () => now });
         const metrics = new RoundWatchEconomicsMetrics();
         const first = prepareMetricsWatch(store, `fault-first-${path}-${fault}`).watch;
         const second = prepareMetricsWatch(store, `fault-second-${path}-${fault}`, '7'.repeat(51) + 'A').watch;
         for (const [watch, round] of [[first, 100], [second, 101]] as const) {
            store.activateWatch(watch.id, {
               transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET, payer: watch.expectedServicePayer!,
            }, round);
         }
         const earlier = metrics.captureWatch(first.id);
         earlier.recordWorkUnit();
         const logs = injectTerminalFault(t, metrics, fault, first.id);
         const probe = new IndexerHealthProbe({
            probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
         }, first.assetId);
         const revision = probe.currentRevision();
         let scans = 0;
         const indexer = new AlgorandIndexerClient('https://indexer.example.test',
            new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
            async input => {
               const url = new URL(String(input));
               if (url.pathname === '/health') return Response.json({ round: 110 });
               scans += 1;
               if (url.searchParams.get('min-round') === '101') {
                  if (path === 'permanent-error') return permanentWatchErrorResponse();
                  return Response.json({ 'current-round': 110, transactions: [{
                     id: 'A'.repeat(51) + 'Q', sender: first.expectedSender, 'tx-type': 'axfer',
                     'confirmed-round': 105, 'round-time': now.getTime() / 1_000,
                     'asset-transfer-transaction': {
                        'asset-id': first.assetId, amount: Number(first.atomicAmount), receiver: first.expectedReceiver,
                     },
                  }] });
               }
               return Response.json({ 'current-round': 110, transactions: [] });
            }, 1_000, metrics);
         try {
            const poller = new RoundWatchPoller(store, indexer, 5_000, 100, () => now, metrics, 0, 0, probe);
            const result = await poller.runOnce();
            assert.equal(result.attempted, 2);
            assert.equal(result.failed, path === 'match' ? 0 : 1);
            assert.equal(result.isolatedFailures ?? 0, path === 'match' ? 0 : 1);
            assert.equal(result.succeeded, path === 'match' ? 2 : 1);
            assert.equal(probe.currentFailureEpoch(), 0);
            assert.equal(probe.currentRevision(), revision);
            assert.notEqual(poller.healthSnapshot().providerHealth, 'unhealthy');
            assert.equal(store.getWatch(first.id)?.state, path === 'match' ? 'matched' : 'indeterminate');
            if (path === 'match') assert.equal(store.getWatch(first.id)?.pollingFailureCount, 0);
            assert.equal(store.getWatch(second.id)?.scanAfterRound, 110);
            assert.equal(scans, 2);
            assert.equal(metrics.snapshotWatch(first.id), undefined);
            earlier.recordWorkUnit();
            assert.equal(metrics.snapshotWatch(first.id), undefined);
            assert.deepEqual(logs, [], 'damaged recording/finish/log must not publish a complete snapshot');
         } finally { store.close(); }
      });
   }
}

for (const fault of terminalFaults) {
   test(`B3 followup F3 reconciler contains ${fault}`, async t => {
      const store = new RoundWatchStore(':memory:');
      const metrics = new RoundWatchEconomicsMetrics();
      const watch = prepareMetricsWatch(store, `reconciler-fault-${fault}`).watch;
      const earlier = metrics.captureWatch(watch.id);
      earlier.recordWorkUnit();
      const logs = injectTerminalFault(t, metrics, fault, watch.id);
      const probe = new IndexerHealthProbe({
         probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
      }, watch.assetId);
      const indexer = new AlgorandIndexerClient('https://indexer.example.test',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
         async () => metricsSettlementTransferResponse(watch, false), 1_000, metrics);
      try {
         const result = await new SettlementReconciler(store, indexer, {
            network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
         }, metrics, probe).reconcileOnce();
         assert.equal(result.failed, 0);
         assert.equal(result.succeeded, 1);
         assert.equal(probe.currentFailureEpoch(), 0);
         assert.equal(store.getWatch(watch.id)?.settlementReconciliationTerminal, true);
         assert.equal(metrics.snapshotWatch(watch.id), undefined);
         earlier.recordWorkUnit();
         assert.equal(metrics.activeWatchMetricCount(), 0);
         assert.deepEqual(logs, []);
      } finally { store.close(); }
   });
}

for (const capture of ['normal', 'failed-existing', 'partial-existing', 'disabled-empty'] as const) {
   test(`B3 followup F2 late poller error preserves replacement with ${capture}`, async t => {
      const now = new Date('2026-09-19T12:00:00.000Z');
      const store = new RoundWatchStore(':memory:', { now: () => now });
      const metrics = new RoundWatchEconomicsMetrics();
      const watch = prepareMetricsWatch(store, `replacement-${capture}`).watch;
      store.activateWatch(watch.id, {
         transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET, payer: watch.expectedServicePayer!,
      }, 100);
      const originalCapture = metrics.captureWatch.bind(metrics);
      const earlier = capture === 'disabled-empty' ? undefined : originalCapture(watch.id);
      earlier?.recordWorkUnit();
      let captures = 0;
      t.mock.method(metrics, 'captureWatch', (id: string) => {
         captures += 1;
         if (capture === 'normal') return originalCapture(id);
         if (capture === 'partial-existing') originalCapture(id);
         throw new Error('synthetic capture failure');
      });
      let recaptures = 0;
      const existing = metrics.captureExistingWatch.bind(metrics);
      t.mock.method(metrics, 'captureExistingWatch', (id: string) => { recaptures += 1; return existing(id); });
      const logs: string[] = [];
      t.mock.method(console, 'info', (message: string) => logs.push(message));
      const started = deferred<void>();
      const response = deferred<Response>();
      const probe = new IndexerHealthProbe({
         probeReadinessCapabilities: async () => ({ polling: true, reconciliation: true }),
      }, watch.assetId);
      const indexer = new AlgorandIndexerClient('https://indexer.example.test',
         new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
         async input => {
            if (new URL(String(input)).pathname === '/health') return Response.json({ round: 110 });
            started.resolve(); return response.promise;
         }, 1_000, metrics);
      let pending: Promise<unknown> | undefined;
      try {
         pending = new RoundWatchPoller(store, indexer, 5_000, 100, () => now, metrics, 0, 0, probe).runOnce();
         await started.promise;
         earlier?.finishWatch();
         assert.equal(metrics.activeWatchMetricCount(), 0);
         const replacement = originalCapture(watch.id);
         replacement.recordWorkUnit();
         replacement.recordCoverage(123);
         const snapshot = metrics.snapshotWatch(watch.id);
         response.resolve(permanentWatchErrorResponse());
         const result = await pending as { failed: number; isolatedFailures?: number };
         assert.equal(result.failed, 1);
         assert.equal(result.isolatedFailures, 1);
         assert.equal(store.getWatch(watch.id)?.state, 'indeterminate');
         assert.equal(probe.currentFailureEpoch(), 0);
         assert.deepEqual(metrics.snapshotWatch(watch.id), snapshot);
         assert.equal(metrics.activeWatchMetricCount(), 1);
         assert.equal(captures, 1);
         assert.equal(recaptures, 0, 'error continuation must retain the original binding');
         assert.deepEqual(logs, []);
         replacement.recordWorkUnit();
         assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, 2);
      } finally {
         response.resolve(permanentWatchErrorResponse());
         await pending;
         store.close();
      }
   });
}

test('B3 followup F2 inactive stale poller candidates never capture metrics', async t => {
   const store = new RoundWatchStore(':memory:');
   const metrics = new RoundWatchEconomicsMetrics();
   const watch = prepareMetricsWatch(store, 'inactive-candidate').watch;
   const stale = store.activateWatch(watch.id, {
      transaction: watch.expectedServiceTransaction!, network: ALGORAND_TESTNET, payer: watch.expectedServicePayer!,
   }, 100);
   store.markMatched(watch.id, 'A'.repeat(51) + 'Q', 105);
   t.mock.method(store, 'listPollingCandidates', () => [stale]);
   let captures = 0;
   t.mock.method(metrics, 'captureWatch', () => { captures += 1; throw new Error('stale capture'); });
   const indexer = new AlgorandIndexerClient('https://indexer.example.test', new IndexerRequestDispatcher(),
      async () => { throw new Error('inactive watch must not query Indexer'); }, 1_000, metrics);
   try {
      const result = await new RoundWatchPoller(store, indexer, 5_000, 100, () => new Date(), metrics).runOnce();
      assert.equal(result.failed, 0);
      assert.equal(captures, 0);
      assert.equal(metrics.activeWatchMetricCount(), 0);
   } finally { store.close(); }
});

function permanentWatchErrorResponse(): Response {
   return Response.json({ message: 'invalid input: searching transactions by zero address with asset sender role is not supported' }, { status: 400 });
}

test('B3 followup F2 failed reconciler capture cannot release a replacement after await', async t => {
   const store = new RoundWatchStore(':memory:');
   const metrics = new RoundWatchEconomicsMetrics();
   const watch = prepareMetricsWatch(store, 'reconciler-replacement').watch;
   const capture = metrics.captureWatch.bind(metrics);
   const earlier = capture(watch.id);
   earlier.recordWorkUnit();
   t.mock.method(metrics, 'captureWatch', () => { throw new Error('synthetic original capture failure'); });
   const logs: string[] = [];
   t.mock.method(console, 'info', (message: string) => logs.push(message));
   const started = deferred<void>();
   const response = deferred<Response>();
   const indexer = new AlgorandIndexerClient('https://indexer.example.test',
      new IndexerRequestDispatcher({ requestsPerSecond: 1_000, burst: 10, concurrency: 1 }),
      async () => { started.resolve(); return response.promise; }, 1_000, metrics);
   let pending: Promise<unknown> | undefined;
   try {
      pending = new SettlementReconciler(store, indexer, {
         network: ALGORAND_TESTNET, intervalMilliseconds: 5_000,
      }, metrics).reconcileOnce();
      await started.promise;
      earlier.finishWatch();
      const replacement = capture(watch.id);
      replacement.recordWorkUnit();
      const snapshot = metrics.snapshotWatch(watch.id);
      response.resolve(metricsSettlementTransferResponse(watch, false));
      await pending;
      assert.equal(store.getWatch(watch.id)?.settlementReconciliationTerminal, true);
      assert.deepEqual(metrics.snapshotWatch(watch.id), snapshot);
      assert.deepEqual(logs, []);
      replacement.recordWorkUnit();
      assert.equal(metrics.snapshotWatch(watch.id)?.workUnitsClaimed, 2);
   } finally { response.resolve(metricsSettlementTransferResponse(watch)); await pending; store.close(); }
});

test('B3 followup F3 independent release is non-creating, identity-bound and snapshot-free', async t => {
   const metrics = new RoundWatchEconomicsMetrics();
   const releaseMetrics = metrics as RoundWatchEconomicsMetrics & { bindWatchRelease(id: string): (() => void) | undefined };
   assert.equal(typeof releaseMetrics.bindWatchRelease, 'function');
   assert.equal(releaseMetrics.bindWatchRelease('absent'), undefined);
   assert.equal(metrics.activeWatchMetricCount(), 0);
   const original = metrics.captureWatch('release-identity');
   const release = releaseMetrics.bindWatchRelease('release-identity')!;
   original.finishWatch();
   const replacement = metrics.captureWatch('release-identity');
   replacement.recordWorkUnit();
   const snapshot = metrics.snapshotWatch('release-identity');
   release(); release();
   assert.deepEqual(metrics.snapshotWatch('release-identity'), snapshot);
   const releaseReplacement = releaseMetrics.bindWatchRelease('release-identity')!;
   t.mock.method(metrics, 'snapshotWatch', () => { throw new Error('broken snapshot cannot block release'); });
   releaseReplacement(); releaseReplacement();
   original.recordWorkUnit(); replacement.recordWorkUnit();
   assert.equal(metrics.activeWatchMetricCount(), 0);

   // Explicit limit: if the primitive itself fails before deletion, containment
   // and one attempt are guaranteed, but absolute cleanup cannot be promised.
   const store = new RoundWatchStore(':memory:');
   try {
      const watch = prepareMetricsWatch(store, 'broken-release').watch;
      store.markSettlementInvalid(watch.id);
      metrics.captureWatch(watch.id);
      const repairRelease = releaseMetrics.bindWatchRelease(watch.id)!;
      let attempts = 0;
      t.mock.method(metrics, 'bindWatchRelease', () => () => { attempts += 1; throw new Error('synthetic base release failure'); });
      const { captureWatchEconomicsTurn, finishWatchEconomicsTurn } = await import('./roundwatch-metrics.js');
      const turn = captureWatchEconomicsTurn(metrics, watch.id);
      assert.doesNotThrow(() => finishWatchEconomicsTurn(turn, store.getWatch(watch.id)));
      assert.equal(attempts, 1);
      assert.equal(store.getWatch(watch.id)?.settlementReconciliationTerminal, true);
      assert.equal(metrics.activeWatchMetricCount(), 1, 'a broken primitive may retain the entry');
      repairRelease();
      assert.equal(metrics.activeWatchMetricCount(), 0);
   } finally { store.close(); }
});

function injectTerminalFault(t: TestContext, metrics: RoundWatchEconomicsMetrics, fault: TerminalFault, watchId: string): string[] {
   const record = metrics.recordLifecycle.bind(metrics);
   t.mock.method(metrics, 'recordLifecycle', (id: string, observation: Parameters<typeof record>[1]) => {
      if (id === watchId && fault === 'record') throw new Error('synthetic lifecycle recording failure');
      return record(id, observation);
   });
   const finish = metrics.finishWatch.bind(metrics);
   t.mock.method(metrics, 'finishWatch', (id: string) => {
      if (id === watchId && (fault === 'finish-before' || fault === 'warning')) throw new Error('synthetic finish before delete');
      const snapshot = finish(id);
      if (id === watchId && fault === 'finish-after') throw new Error('synthetic finish after delete');
      return snapshot;
   });
   const logs: string[] = [];
   t.mock.method(console, 'info', (message: string) => {
      if (!message.startsWith('RoundWatch economics watch-terminal ')) return;
      if (fault === 'log') throw new Error('synthetic terminal log failure');
      logs.push(message);
   });
   if (fault === 'warning') t.mock.method(console, 'warn', () => { throw new Error('synthetic warning sink failure'); });
   return logs;
}

function metricsSettlementTransferResponse(watch: WatchRecord, matches = true): Response {
   return Response.json({ transaction: {
      id: watch.expectedServiceTransaction, sender: watch.expectedServicePayer,
      'tx-type': 'axfer', 'confirmed-round': 100, 'round-time': 1_800_000_000,
      'asset-transfer-transaction': {
         'asset-id': watch.serviceAssetId, amount: Number(watch.serviceAtomicAmount) + (matches ? 0 : 1),
         receiver: watch.serviceReceiver,
      },
   } });
}

function prepareMetricsWatch(store: RoundWatchStore, suffix: string, transaction = 'A'.repeat(52)) {
   const sender = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
   const receiver = 'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
   return store.prepareWatch({
      idempotencyKey: `metrics-${suffix}`, expectedSender: sender,
      expectedReceiver: receiver, assetId: 10458941, atomicAmount: '1',
   }, {
      expectedTransaction: transaction, network: ALGORAND_TESTNET, payer: sender,
      receiver, assetId: 10458941, atomicAmount: '1000', firstValid: 90, lastValid: 190,
   });
}

function deferred<T>() {
   let resolve!: (value: T | PromiseLike<T>) => void;
   let reject!: (reason?: unknown) => void;
   const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
   });
   return { promise, resolve, reject };
}

test('runtime sampler reports interval CPU, memory, disk, dispatcher, and free-work totals', () => {
   const metrics = new RoundWatchEconomicsMetrics();
   metrics.recordFreeRequest('health', {
      status: 200,
      responseBytes: 32,
      wallTimeMs: 2,
   });

   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: 4,
      burst: 4,
      concurrency: 2,
   });

   const monotonic = [1_000, 2_250];
   const cpu = [
      { user: 100, system: 50 },
      { user: 600, system: 250 },
   ];

   const sampler = new RoundWatchRuntimeSampler(
      metrics,
      dispatcher,
      '/data/roundwatch.sqlite',
      {
         now: () => new Date('2026-09-19T12:00:00.000Z'),
         monotonicNow: () => monotonic.shift() ?? 2_250,
         cpuUsage: () => cpu.shift() ?? { user: 600, system: 250 },
         memoryUsage: () => ({
            rss: 150_000_000,
            heapTotal: 40_000_000,
            heapUsed: 25_000_000,
            external: 2_000_000,
            arrayBuffers: 500_000,
         }),
         fileSize: path => path.endsWith('-wal') ? 4_096 : 65_536,
         capacitySnapshot: () => ({
            unfinishedWatches: 3,
            activeWatches: 2,
            settlementPendingWatches: 1,
            unresolvedSettlementUnknownWatches: 0,
            activeWatchesMissingScanBaseline: 0,
            watchesPastDeadlineAwaitingCoverage: 1,
            oldestActiveWatchAgeMs: 60_000,
            currentIndexerRound: 150,
            scanLagRounds: {
               samples: 2,
               p50: 3,
               p95: 7,
               max: 7,
            },
            lastCycleDurationMs: 25,
            watchesAttemptedLastCycle: 2,
            watchesSucceededLastCycle: 2,
            watchesFailedLastCycle: 0,
            currentIndexerRoundObservedAt:
               '2026-09-19T11:59:59.000Z',
         }),
         log: () => {},
      },
   );

   const snapshot = sampler.sample();

   assert.equal(snapshot.resources.sampledAt, '2026-09-19T12:00:00.000Z');
   assert.equal(snapshot.resources.elapsedMs, 1_250);
   assert.equal(snapshot.resources.cpuUserMicros, 500);
   assert.equal(snapshot.resources.cpuSystemMicros, 200);
   assert.equal(snapshot.resources.rssBytes, 150_000_000);
   assert.equal(snapshot.resources.heapUsedBytes, 25_000_000);
   assert.equal(snapshot.resources.sqliteBytes, 65_536);
   assert.equal(snapshot.resources.walBytes, 4_096);
   assert.equal(snapshot.resources.dispatcher.queued, 0);
   assert.equal(snapshot.activeWatchMetrics, 0);
   assert.equal(snapshot.freeWork.health.requests, 1);
   assert.equal(snapshot.freeWork.health.responseBytes, 32);
   assert.equal(snapshot.capacity?.unfinishedWatches, 3);
   assert.equal(snapshot.capacity?.scanLagRounds?.p95, 7);
   assert.equal(snapshot.capacity?.lastCycleDurationMs, 25);
});

test('capacity snapshot reports durable obligation counts and chain lag', () => {
   let now = new Date('2026-09-19T12:00:00.000Z');
   const store = new RoundWatchStore(':memory:', {
      now: () => now,
   });
   const receiver =
      'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
   const sender =
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';

   const prepare = (suffix: string) => store.prepareWatch(
      {
         idempotencyKey: `capacity-${suffix}`,
         expectedSender: sender,
         expectedReceiver: receiver,
         assetId: 10458941,
         atomicAmount: '1',
      },
      {
         expectedTransaction: `SERVICE_CAPACITY_${suffix}`,
         network: ALGORAND_TESTNET,
         payer: `PAYER_CAPACITY_${suffix}`,
         receiver,
         assetId: 10458941,
         atomicAmount: '1000',
         firstValid: 1,
         lastValid: 1_000,
      },
   );

   try {
      const first = prepare('first');
      store.activateWatch(
         first.watch.id,
         {
            transaction: 'SERVICE_CAPACITY_first',
            network: ALGORAND_TESTNET,
            payer: 'PAYER_CAPACITY_first',
         },
         100,
      );
      assert.equal(store.advanceScanRound(first.watch.id, 100, 110), true);

      now = new Date('2026-09-19T12:10:00.000Z');
      const second = prepare('second');
      store.activateWatch(
         second.watch.id,
         {
            transaction: 'SERVICE_CAPACITY_second',
            network: ALGORAND_TESTNET,
            payer: 'PAYER_CAPACITY_second',
         },
         120,
      );

      now = new Date('2026-09-19T12:20:00.000Z');
      prepare('pending');

      now = new Date('2026-09-19T12:35:00.000Z');
      const snapshot = store.capacitySnapshot(150);

      assert.equal(snapshot.unfinishedWatches, 3);
      assert.equal(snapshot.activeWatches, 2);
      assert.equal(snapshot.settlementPendingWatches, 1);
      assert.equal(snapshot.unresolvedSettlementUnknownWatches, 0);
      assert.equal(snapshot.activeWatchesMissingScanBaseline, 0);
      assert.equal(snapshot.watchesPastDeadlineAwaitingCoverage, 1);
      assert.equal(snapshot.oldestActiveWatchAgeMs, 35 * 60_000);
      assert.equal(snapshot.currentIndexerRound, 150);
      assert.deepEqual(snapshot.scanLagRounds, {
         samples: 2,
         p50: 30,
         p95: 40,
         max: 40,
      });
   } finally {
      store.close();
   }
});

test('HTTP instrumentation separates health, public status, and unpaid watch creation', async () => {
   const metrics = new RoundWatchEconomicsMetrics();
   const store = new RoundWatchStore(':memory:');
   const receiver =
      'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';

   try {
      const app = createApp({
         avmAddress: receiver,
         facilitatorClient: {
            getSupported: async () => ({
               kinds: [
                  {
                     x402Version: 2,
                     scheme: 'exact',
                     network: ALGORAND_TESTNET,
                  },
               ],
               extensions: [],
               signers: {},
            }),
         } as unknown as FacilitatorClient,
         store,
         indexer: {} as never,
         economicsMetrics: metrics,
      });

      const health = await app.request('/health');
      assert.equal(health.status, 200);
      await health.text();

      const missingStatus = await app.request(
         '/spike/watch/00000000-0000-0000-0000-000000000000',
      );
      assert.equal(missingStatus.status, 404);
      await missingStatus.text();

      const unpaidBody = JSON.stringify({
         idempotencyKey: ['economics', 'unpaid', '001'].join('-'),
         expectedSender:
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ',
         expectedReceiver: receiver,
         atomicAmount: '1',
      });
      const unpaid = await app.request('/spike/watch', {
         method: 'POST',
         headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(unpaidBody, 'utf8')),
         },
         body: unpaidBody,
      });
      assert.equal(unpaid.status, 402);
      await unpaid.text();

      const free = metrics.snapshotAllFreeWork();
      assert.equal(free.health.requests, 1);
      assert.equal(free['watch-status'].requests, 1);
      assert.deepEqual(free['watch-status'].statuses, { '404': 1 });
      assert.equal(free['watch-create-402'].requests, 1);
      assert.deepEqual(free['watch-create-402'].statuses, { '402': 1 });
      assert.equal(
         free['watch-create-402'].requestBytes,
         Buffer.byteLength(unpaidBody, 'utf8'),
      );
      assert.ok(free.health.responseBytes > 0);
      assert.ok(free['watch-status'].responseBytes > 0);
      assert.ok(free['watch-create-402'].responseBytes > 0);
   } finally {
      store.close();
   }
});
