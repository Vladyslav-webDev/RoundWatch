import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
   ALGORAND_TESTNET,
   TESTNET_USDC_ASSET_ID,
} from './app.js';
import { AlgorandIndexerClient } from './roundwatch-indexer.js';
import {
   INDEXER_REQUEST_PURPOSES,
   RoundWatchEconomicsMetrics,
   type WatchWorkSnapshot,
} from './roundwatch-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { RoundWatchRuntimeSampler } from './roundwatch-runtime-metrics.js';
import { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import {
   RoundWatchStore,
   type SettlementIntent,
   type WatchSpec,
} from './roundwatch-store.js';

type ActivityProfile = 'quiet' | 'hot';

interface BenchmarkProfile {
   name: string;
   activity: ActivityProfile;
   withNote: boolean;
   transactionsPerWindow: number;
}

interface ScenarioResult {
   profile: string;
   activity: ActivityProfile;
   withNote: boolean;
   activeWatches: number;
   targetRounds: number;
   transactionsPerWindow: number;
   sweeps: number;
   elapsedMs: number;
   totalRequests: number;
   requestsPerWatch: Distribution;
   pagesPerWatch: Distribution;
   transactionsReturnedPerWatch: Distribution;
   transactionsExaminedPerWatch: Distribution;
   responseBytesPerWatch: Distribution;
   queueWaitMsPerWatch: Distribution;
   indexerWallMsPerWatch: Distribution;
   roundsCoveredPerWatch: Distribution;
   requestsByPurpose: Record<string, number>;
   cpuUserMs: number;
   cpuSystemMs: number;
   peakRssBytes: number;
   peakHeapUsedBytes: number;
   sqliteBytes: number;
   walBytes: number;
}

interface Distribution {
   mean: number;
   p50: number;
   p95: number;
   max: number;
}

const EXPECTED_SENDER =
   'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';
const EXPECTED_RECEIVER =
   'AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI';
const NON_MATCHING_RECEIVER = 'BENCH_NON_MATCHING_RECEIVER';
const BASE_ROUND = 1_000;
const ROUND_WINDOW = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_ROUND_WINDOW', 100),
   'ROUNDWATCH_BENCH_ROUND_WINDOW',
);
const TARGET_ROUNDS = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_TARGET_ROUNDS', 300),
   'ROUNDWATCH_BENCH_TARGET_ROUNDS',
);
const QUIET_TX_PER_WINDOW = nonNegativeInteger(
   envNumber('ROUNDWATCH_BENCH_QUIET_TX_PER_WINDOW', 5),
   'ROUNDWATCH_BENCH_QUIET_TX_PER_WINDOW',
);
const HOT_TX_PER_WINDOW = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_HOT_TX_PER_WINDOW', 1_500),
   'ROUNDWATCH_BENCH_HOT_TX_PER_WINDOW',
);
const SYNTHETIC_RPS = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_REQUESTS_PER_SECOND', 100_000),
   'ROUNDWATCH_BENCH_REQUESTS_PER_SECOND',
);
const SYNTHETIC_BURST = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_BURST', 100_000),
   'ROUNDWATCH_BENCH_BURST',
);
const DISPATCH_CONCURRENCY = positiveInteger(
   envNumber('ROUNDWATCH_BENCH_DISPATCH_CONCURRENCY', 2),
   'ROUNDWATCH_BENCH_DISPATCH_CONCURRENCY',
);
const ACTIVE_WATCH_COUNTS = parseWatchCounts(
   process.env.ROUNDWATCH_BENCH_WATCH_COUNTS ?? '1,5,20,50',
);

if (TARGET_ROUNDS % ROUND_WINDOW !== 0) {
   throw new Error(
      'ROUNDWATCH_BENCH_TARGET_ROUNDS must be divisible by ROUNDWATCH_BENCH_ROUND_WINDOW',
   );
}

const PROFILES: BenchmarkProfile[] = [
   {
      name: 'quiet-exact-note',
      activity: 'quiet',
      withNote: true,
      transactionsPerWindow: QUIET_TX_PER_WINDOW,
   },
   {
      name: 'quiet-no-note',
      activity: 'quiet',
      withNote: false,
      transactionsPerWindow: QUIET_TX_PER_WINDOW,
   },
   {
      name: 'hot-exact-note',
      activity: 'hot',
      withNote: true,
      transactionsPerWindow: HOT_TX_PER_WINDOW,
   },
   {
      name: 'hot-no-note',
      activity: 'hot',
      withNote: false,
      transactionsPerWindow: HOT_TX_PER_WINDOW,
   },
];

const results: ScenarioResult[] = [];

console.log(
   [
      'RoundWatch Economics Benchmark v1',
      'query variant: A (current sender + asset + round range)',
      `target coverage: ${TARGET_ROUNDS} rounds / watch`,
      `scan window: ${ROUND_WINDOW} rounds`,
      `synthetic dispatcher: ${SYNTHETIC_RPS}/s burst=${SYNTHETIC_BURST} concurrency=${DISPATCH_CONCURRENCY}`,
      'This is a structural-work benchmark, not a production latency/SLA benchmark.',
   ].join('\n'),
);

for (const profile of PROFILES) {
   for (const activeWatches of ACTIVE_WATCH_COUNTS) {
      const result = await runScenario(profile, activeWatches);
      results.push(result);
      console.log(
         `BENCH_RESULT ${JSON.stringify(result)}`,
      );
   }
}

console.table(
   results.map(result => ({
      profile: result.profile,
      watches: result.activeWatches,
      sweeps: result.sweeps,
      'req/watch': round(result.requestsPerWatch.mean),
      'pages/watch': round(result.pagesPerWatch.mean),
      'tx/watch': round(result.transactionsReturnedPerWatch.mean),
      'MB/watch': round(
         result.responseBytesPerWatch.mean / (1024 * 1024),
         3,
      ),
      'covered/watch': round(result.roundsCoveredPerWatch.mean),
      'elapsed ms': round(result.elapsedMs),
      'CPU ms': round(result.cpuUserMs + result.cpuSystemMs),
      'peak RSS MB': round(result.peakRssBytes / (1024 * 1024), 1),
   })),
);

console.log(
   'BENCH_SUMMARY ' +
      JSON.stringify({
         queryVariant: 'A',
         targetRounds: TARGET_ROUNDS,
         roundWindow: ROUND_WINDOW,
         quietTransactionsPerWindow: QUIET_TX_PER_WINDOW,
         hotTransactionsPerWindow: HOT_TX_PER_WINDOW,
         syntheticDispatcher: {
            requestsPerSecond: SYNTHETIC_RPS,
            burst: SYNTHETIC_BURST,
            concurrency: DISPATCH_CONCURRENCY,
         },
         results,
      }),
);

async function runScenario(
   profile: BenchmarkProfile,
   activeWatches: number,
): Promise<ScenarioResult> {
   const directory = mkdtempSync(
      join(tmpdir(), 'roundwatch-economics-bench-'),
   );
   const databasePath = join(directory, 'roundwatch.sqlite');
   const benchmarkNow = new Date('2026-09-19T12:00:00.000Z');
   const tip = BASE_ROUND + TARGET_ROUNDS;
   const metrics = new RoundWatchEconomicsMetrics();
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: SYNTHETIC_RPS,
      burst: SYNTHETIC_BURST,
      concurrency: DISPATCH_CONCURRENCY,
   });
   const fakeFetch = createSyntheticIndexerFetch(profile, tip);
   const indexer = new AlgorandIndexerClient(
      'https://synthetic-indexer.invalid',
      dispatcher,
      fakeFetch,
      10_000,
      metrics,
   );
   const store = new RoundWatchStore(databasePath, {
      maxOpenWatches: Math.max(50, activeWatches),
      maxOpenWatchesPerPayer: 1,
      now: () => benchmarkNow,
   });
   const poller = new RoundWatchPoller(
      store,
      indexer,
      5_000,
      ROUND_WINDOW,
      () => benchmarkNow,
      metrics,
   );
   const sampler = new RoundWatchRuntimeSampler(
      metrics,
      dispatcher,
      databasePath,
      { log: () => {} },
   );

   const watchIds: string[] = [];

   try {
      for (let index = 0; index < activeWatches; index += 1) {
         const idempotencyKey =
            `bench-${profile.name}-${activeWatches}-${String(index).padStart(3, '0')}`;
         const expectedServiceTransaction =
            `SERVICE_${profile.name}_${activeWatches}_${index}`;
         const servicePayer =
            `BENCH_SERVICE_PAYER_${profile.name}_${activeWatches}_${index}`;

         const spec: WatchSpec = {
            idempotencyKey,
            expectedSender: EXPECTED_SENDER,
            expectedReceiver: EXPECTED_RECEIVER,
            assetId: TESTNET_USDC_ASSET_ID,
            atomicAmount: '1',
            ...(profile.withNote
               ? { invoiceNote: `bench-invoice-${index}` }
               : {}),
         };
         const intent: SettlementIntent = {
            expectedTransaction: expectedServiceTransaction,
            network: ALGORAND_TESTNET,
            payer: servicePayer,
            receiver: EXPECTED_RECEIVER,
            assetId: TESTNET_USDC_ASSET_ID,
            atomicAmount: '1000',
            firstValid: BASE_ROUND - 100,
            lastValid: BASE_ROUND + 100,
         };
         const prepared = store.prepareWatch(spec, intent);
         if (!prepared.created) {
            throw new Error('Synthetic benchmark watch unexpectedly collided');
         }

         store.activateWatch(
            prepared.watch.id,
            {
               transaction: expectedServiceTransaction,
               network: ALGORAND_TESTNET,
               payer: servicePayer,
            },
            BASE_ROUND,
         );
         watchIds.push(prepared.watch.id);
      }

      let sweeps = 0;
      const maxSweeps =
         Math.ceil(profile.transactionsPerWindow / 1_000) *
            (TARGET_ROUNDS / ROUND_WINDOW) +
         10;

      let peakRssBytes = 0;
      let peakHeapUsedBytes = 0;
      let cpuUserMicros = 0;
      let cpuSystemMicros = 0;

      const startedAt = performance.now();
      const originalLog = console.log;
      const originalDebug = console.debug;
      try {
         console.log = () => {};
         console.debug = () => {};

         while (!coverageComplete(store, watchIds, tip)) {
            if (sweeps >= maxSweeps) {
               throw new Error(
                  `Benchmark exceeded max sweeps (${maxSweeps}) for ${profile.name}`,
               );
            }

            await poller.runOnce();
            sweeps += 1;

            const sample = sampler.sample();
            peakRssBytes = Math.max(
               peakRssBytes,
               sample.resources.rssBytes,
            );
            peakHeapUsedBytes = Math.max(
               peakHeapUsedBytes,
               sample.resources.heapUsedBytes,
            );
            cpuUserMicros += sample.resources.cpuUserMicros;
            cpuSystemMicros += sample.resources.cpuSystemMicros;
         }
      } finally {
         console.log = originalLog;
         console.debug = originalDebug;
      }
      const elapsedMs = performance.now() - startedAt;

      const snapshots = watchIds.map(id => {
         const snapshot = metrics.snapshotWatch(id);
         if (!snapshot) {
            throw new Error(`Missing metrics snapshot for watch ${id}`);
         }
         return snapshot;
      });

      const totalRequestsPerWatch = snapshots.map(totalIndexerRequests);
      const pagesPerWatch = snapshots.map(item => item.scanPages);
      const transactionsReturnedPerWatch = snapshots.map(
         item => item.transactionsReturned,
      );
      const transactionsExaminedPerWatch = snapshots.map(
         item => item.transactionsExamined,
      );
      const responseBytesPerWatch = snapshots.map(totalResponseBytes);
      const queueWaitMsPerWatch = snapshots.map(totalQueueWaitMs);
      const indexerWallMsPerWatch = snapshots.map(totalIndexerWallMs);
      const roundsCoveredPerWatch = snapshots.map(
         item => item.roundsCovered,
      );

      return {
         profile: profile.name,
         activity: profile.activity,
         withNote: profile.withNote,
         activeWatches,
         targetRounds: TARGET_ROUNDS,
         transactionsPerWindow: profile.transactionsPerWindow,
         sweeps,
         elapsedMs,
         totalRequests: totalRequestsPerWatch.reduce(sum, 0),
         requestsPerWatch: distribution(totalRequestsPerWatch),
         pagesPerWatch: distribution(pagesPerWatch),
         transactionsReturnedPerWatch: distribution(
            transactionsReturnedPerWatch,
         ),
         transactionsExaminedPerWatch: distribution(
            transactionsExaminedPerWatch,
         ),
         responseBytesPerWatch: distribution(responseBytesPerWatch),
         queueWaitMsPerWatch: distribution(queueWaitMsPerWatch),
         indexerWallMsPerWatch: distribution(indexerWallMsPerWatch),
         roundsCoveredPerWatch: distribution(roundsCoveredPerWatch),
         requestsByPurpose: sumRequestsByPurpose(snapshots),
         cpuUserMs: cpuUserMicros / 1_000,
         cpuSystemMs: cpuSystemMicros / 1_000,
         peakRssBytes,
         peakHeapUsedBytes,
         sqliteBytes: fileSize(databasePath),
         walBytes: fileSize(`${databasePath}-wal`),
      };
   } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
   }
}

function createSyntheticIndexerFetch(
   profile: BenchmarkProfile,
   tip: number,
): typeof fetch {
   return async input => {
      const url = requestUrl(input);

      if (url.pathname === '/health') {
         return jsonResponse({ round: tip });
      }

      if (
         /^\/v2\/assets\/\d+\/transactions$/.test(url.pathname)
      ) {
         const minRound = requiredIntegerQuery(url, 'min-round');
         const maxRound = requiredIntegerQuery(url, 'max-round');
         const limit = requiredIntegerQuery(url, 'limit');
         const offset = optionalIntegerQuery(url, 'next') ?? 0;
         const total = profile.transactionsPerWindow;
         const end = Math.min(total, offset + limit);
         const transactions = [];

         for (let index = offset; index < end; index += 1) {
            const round =
               minRound + (index % (maxRound - minRound + 1));
            transactions.push({
               id: `BENCH_TX_${minRound}_${maxRound}_${index}`,
               sender: EXPECTED_SENDER,
               note: Buffer.from(
                  `noise-${profile.name}-${index}`,
                  'utf8',
               ).toString('base64'),
               'confirmed-round': round,
               'round-time': Math.floor(
                  new Date('2026-09-19T12:01:00.000Z').getTime() / 1_000,
               ),
               'asset-transfer-transaction': {
                  amount: 999_999,
                  receiver: NON_MATCHING_RECEIVER,
                  'asset-id': TESTNET_USDC_ASSET_ID,
               },
            });
         }

         return jsonResponse({
            transactions,
            'current-round': tip,
            ...(end < total ? { 'next-token': String(end) } : {}),
         });
      }

      return new Response(
         JSON.stringify({ error: `Unexpected synthetic URL ${url.pathname}` }),
         {
            status: 500,
            headers: { 'content-type': 'application/json' },
         },
      );
   };
}

function coverageComplete(
   store: RoundWatchStore,
   watchIds: string[],
   tip: number,
): boolean {
   return watchIds.every(id => {
      const watch = store.getWatch(id);
      return watch?.scanAfterRound !== undefined &&
         watch.scanAfterRound >= tip;
   });
}

function totalIndexerRequests(snapshot: WatchWorkSnapshot): number {
   return INDEXER_REQUEST_PURPOSES.reduce(
      (total, purpose) => total + snapshot.indexer[purpose].attempts,
      0,
   );
}

function totalResponseBytes(snapshot: WatchWorkSnapshot): number {
   return INDEXER_REQUEST_PURPOSES.reduce(
      (total, purpose) =>
         total + snapshot.indexer[purpose].responseBytes,
      0,
   );
}

function totalQueueWaitMs(snapshot: WatchWorkSnapshot): number {
   return INDEXER_REQUEST_PURPOSES.reduce(
      (total, purpose) =>
         total + snapshot.indexer[purpose].queueWait.totalMs,
      0,
   );
}

function totalIndexerWallMs(snapshot: WatchWorkSnapshot): number {
   return INDEXER_REQUEST_PURPOSES.reduce(
      (total, purpose) =>
         total + snapshot.indexer[purpose].wallTime.totalMs,
      0,
   );
}

function sumRequestsByPurpose(
   snapshots: WatchWorkSnapshot[],
): Record<string, number> {
   return Object.fromEntries(
      INDEXER_REQUEST_PURPOSES.map(purpose => [
         purpose,
         snapshots.reduce(
            (total, snapshot) =>
               total + snapshot.indexer[purpose].attempts,
            0,
         ),
      ]),
   );
}

function distribution(values: number[]): Distribution {
   if (values.length === 0) {
      return { mean: 0, p50: 0, p95: 0, max: 0 };
   }

   const sorted = [...values].sort((a, b) => a - b);
   return {
      mean: sorted.reduce(sum, 0) / sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted[sorted.length - 1]!,
   };
}

function percentile(sorted: number[], quantile: number): number {
   const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(sorted.length * quantile) - 1),
   );
   return sorted[index]!;
}

function requestUrl(input: RequestInfo | URL): URL {
   if (input instanceof URL) return input;
   if (typeof input === 'string') return new URL(input);
   return new URL(input.url);
}

function jsonResponse(body: unknown): Response {
   return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
   });
}

function requiredIntegerQuery(url: URL, name: string): number {
   const value = optionalIntegerQuery(url, name);
   if (value === undefined) {
      throw new Error(`Synthetic Indexer query missing ${name}`);
   }
   return value;
}

function optionalIntegerQuery(
   url: URL,
   name: string,
): number | undefined {
   const raw = url.searchParams.get(name);
   if (raw === null) return undefined;
   const value = Number(raw);
   if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Synthetic Indexer query ${name} is invalid`);
   }
   return value;
}

function parseWatchCounts(value: string): number[] {
   const counts = value.split(',').map(item => positiveInteger(
      Number(item.trim()),
      'ROUNDWATCH_BENCH_WATCH_COUNTS',
   ));
   if (counts.length === 0) {
      throw new Error('ROUNDWATCH_BENCH_WATCH_COUNTS must not be empty');
   }
   return counts;
}

function envNumber(name: string, fallback: number): number {
   const raw = process.env[name]?.trim();
   return raw ? Number(raw) : fallback;
}

function fileSize(path: string): number {
   try {
      return statSync(path).size;
   } catch {
      return 0;
   }
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
   }
   return value;
}

function nonNegativeInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
   }
   return value;
}

function sum(left: number, right: number): number {
   return left + right;
}

function round(value: number, digits = 2): number {
   const scale = 10 ** digits;
   return Math.round(value * scale) / scale;
}
