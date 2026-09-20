import assert from 'node:assert/strict';
import test from 'node:test';
import type { FacilitatorClient } from '@x402/core/server';

import {
   ALGORAND_TESTNET,
   createApp,
} from './app.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import { RoundWatchRuntimeSampler } from './roundwatch-runtime-metrics.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { RoundWatchStore } from './roundwatch-store.js';

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
         idempotencyKey: 'economics-unpaid-001',
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
