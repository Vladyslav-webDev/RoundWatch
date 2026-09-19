import assert from 'node:assert/strict';
import test from 'node:test';

import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';

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
