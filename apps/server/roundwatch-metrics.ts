import type { IndexerDispatcherSnapshot, IndexerRequestPurpose } from './roundwatch-scheduler.js';
import type { WatchState } from './roundwatch-store.js';

export const INDEXER_REQUEST_PURPOSES = [
   'activation',
   'reconciliation',
   'absence-proof',
   'scan-page',
   'checkpoint',
   'health',
] as const satisfies readonly IndexerRequestPurpose[];

export type IndexerRequestOutcome = 'success' | 'failure' | 'timeout';

export interface TimingMetricSnapshot {
   samples: number;
   totalMs: number;
   maxMs: number;
}

export interface IndexerPurposeMetricSnapshot {
   attempts: number;
   successes: number;
   failures: number;
   timeouts: number;
   responseBytes: number;
   queueWait: TimingMetricSnapshot;
   wallTime: TimingMetricSnapshot;
}

export interface WatchWorkSnapshot {
   indexer: Record<IndexerRequestPurpose, IndexerPurposeMetricSnapshot>;
   scanPages: number;
   transactionsReturned: number;
   transactionsExamined: number;
   roundsCovered: number;
   reconciliationAttempts: number;
   closingRequests: number;
   workUnitsClaimed: number;
   activeDurationMs?: number;
   timeToTerminalMs?: number;
   finalState?: WatchState;
}

export interface IndexerRequestObservation {
   outcome: IndexerRequestOutcome;
   responseBytes?: number;
   queueWaitMs?: number;
   wallTimeMs?: number;
}

export interface ScanPageObservation {
   transactionsReturned: number;
   transactionsExamined: number;
}

export interface WatchLifecycleObservation {
   activeDurationMs?: number;
   timeToTerminalMs?: number;
   finalState?: WatchState;
}

export const FREE_REQUEST_CATEGORIES = [
   'health',
   'watch-status',
   'watch-create-402',
   'watch-create-rejected',
   'watch-create-payment-rejected',
   'other',
] as const;

export type FreeRequestCategory =
   (typeof FREE_REQUEST_CATEGORIES)[number];

export interface FreeRequestObservation {
   status: number;
   requestBytes?: number;
   responseBytes?: number;
   wallTimeMs?: number;
}

export interface FreeWorkSnapshot {
   requests: number;
   requestBytes: number;
   responseBytes: number;
   wallTime: TimingMetricSnapshot;
   statuses: Record<string, number>;
}

export interface RuntimeResourceSample {
   sampledAt: string;
   elapsedMs: number;
   rssBytes: number;
   heapUsedBytes: number;
   heapTotalBytes: number;
   externalBytes: number;
   cpuUserMicros: number;
   cpuSystemMicros: number;
   sqliteBytes?: number;
   walBytes?: number;
   dispatcher: IndexerDispatcherSnapshot;
}

interface MutableTimingMetric {
   samples: number;
   totalMs: number;
   maxMs: number;
}

interface MutableIndexerPurposeMetric {
   attempts: number;
   successes: number;
   failures: number;
   timeouts: number;
   responseBytes: number;
   queueWait: MutableTimingMetric;
   wallTime: MutableTimingMetric;
}

interface MutableWatchWork {
   indexer: Record<IndexerRequestPurpose, MutableIndexerPurposeMetric>;
   scanPages: number;
   transactionsReturned: number;
   transactionsExamined: number;
   roundsCovered: number;
   reconciliationAttempts: number;
   closingRequests: number;
   workUnitsClaimed: number;
   activeDurationMs?: number;
   timeToTerminalMs?: number;
   finalState?: WatchState;
}

interface MutableFreeWork {
   requests: number;
   requestBytes: number;
   responseBytes: number;
   wallTime: MutableTimingMetric;
   statuses: Map<number, number>;
}

/**
 * In-memory economics instrumentation accumulator.
 *
 * This class intentionally stores no addresses, notes, idempotency keys,
 * transaction IDs, request bodies, or response bodies. The watch ID is used
 * only as the process-local map key and is not included in exported snapshots.
 *
 * It is not wired into production behavior by defining it. Callers are
 * responsible for flushing/recording a terminal snapshot and then releasing
 * the corresponding watch entry.
 */
export class RoundWatchEconomicsMetrics {
   private readonly watches = new Map<string, MutableWatchWork>();
   private readonly freeWork = new Map<FreeRequestCategory, MutableFreeWork>();

   recordIndexerRequest(
      watchId: string,
      purpose: IndexerRequestPurpose,
      observation: IndexerRequestObservation,
   ): void {
      const metric = this.watch(watchId).indexer[purpose];
      metric.attempts += 1;

      if (observation.outcome === 'success') metric.successes += 1;
      if (observation.outcome === 'failure') metric.failures += 1;
      if (observation.outcome === 'timeout') {
         metric.failures += 1;
         metric.timeouts += 1;
      }

      metric.responseBytes += nonNegativeInteger(
         observation.responseBytes ?? 0,
         'responseBytes',
      );

      if (observation.queueWaitMs !== undefined) {
         recordTiming(metric.queueWait, observation.queueWaitMs, 'queueWaitMs');
      }

      if (observation.wallTimeMs !== undefined) {
         recordTiming(metric.wallTime, observation.wallTimeMs, 'wallTimeMs');
      }
   }

   recordScanPage(watchId: string, observation: ScanPageObservation): void {
      const returned = nonNegativeInteger(
         observation.transactionsReturned,
         'transactionsReturned',
      );
      const examined = nonNegativeInteger(
         observation.transactionsExamined,
         'transactionsExamined',
      );

      if (examined > returned) {
         throw new Error('transactionsExamined cannot exceed transactionsReturned');
      }

      const metric = this.watch(watchId);
      metric.scanPages += 1;
      metric.transactionsReturned += returned;
      metric.transactionsExamined += examined;
   }

   recordCoverage(watchId: string, roundsCovered: number): void {
      this.watch(watchId).roundsCovered += nonNegativeInteger(
         roundsCovered,
         'roundsCovered',
      );
   }

   recordReconciliationAttempt(watchId: string): void {
      this.watch(watchId).reconciliationAttempts += 1;
   }

   recordClosingRequest(watchId: string): void {
      this.watch(watchId).closingRequests += 1;
   }

   recordWorkUnit(watchId: string): void {
      this.watch(watchId).workUnitsClaimed += 1;
   }

   recordLifecycle(
      watchId: string,
      observation: WatchLifecycleObservation,
   ): void {
      const metric = this.watch(watchId);

      if (observation.activeDurationMs !== undefined) {
         metric.activeDurationMs = nonNegativeNumber(
            observation.activeDurationMs,
            'activeDurationMs',
         );
      }

      if (observation.timeToTerminalMs !== undefined) {
         metric.timeToTerminalMs = nonNegativeNumber(
            observation.timeToTerminalMs,
            'timeToTerminalMs',
         );
      }

      if (observation.finalState !== undefined) {
         metric.finalState = observation.finalState;
      }
   }

   snapshotWatch(watchId: string): WatchWorkSnapshot | undefined {
      const metric = this.watches.get(watchId);
      return metric ? snapshotWatch(metric) : undefined;
   }

   finishWatch(watchId: string): WatchWorkSnapshot | undefined {
      const snapshot = this.snapshotWatch(watchId);
      this.watches.delete(watchId);
      return snapshot;
   }

   activeWatchMetricCount(): number {
      return this.watches.size;
   }

   recordFreeRequest(
      category: FreeRequestCategory,
      observation: FreeRequestObservation,
   ): void {
      const metric = this.freeMetric(category);
      const status = positiveInteger(observation.status, 'status');

      metric.requests += 1;
      metric.requestBytes += nonNegativeInteger(
         observation.requestBytes ?? 0,
         'requestBytes',
      );
      metric.responseBytes += nonNegativeInteger(
         observation.responseBytes ?? 0,
         'responseBytes',
      );
      metric.statuses.set(status, (metric.statuses.get(status) ?? 0) + 1);

      if (observation.wallTimeMs !== undefined) {
         recordTiming(metric.wallTime, observation.wallTimeMs, 'wallTimeMs');
      }
   }

   snapshotFreeWork(category: FreeRequestCategory): FreeWorkSnapshot {
      const metric = this.freeWork.get(category) ?? emptyFreeWork();

      return {
         requests: metric.requests,
         requestBytes: metric.requestBytes,
         responseBytes: metric.responseBytes,
         wallTime: snapshotTiming(metric.wallTime),
         statuses: Object.fromEntries(
            [...metric.statuses.entries()].map(([status, count]) => [
               String(status),
               count,
            ]),
         ),
      };
   }

   snapshotAllFreeWork(): Record<FreeRequestCategory, FreeWorkSnapshot> {
      return Object.fromEntries(
         FREE_REQUEST_CATEGORIES.map(category => [
            category,
            this.snapshotFreeWork(category),
         ]),
      ) as Record<FreeRequestCategory, FreeWorkSnapshot>;
   }

   private watch(watchId: string): MutableWatchWork {
      if (watchId.length === 0) throw new Error('watchId must not be empty');

      let metric = this.watches.get(watchId);
      if (!metric) {
         metric = emptyWatchWork();
         this.watches.set(watchId, metric);
      }
      return metric;
   }

   private freeMetric(category: FreeRequestCategory): MutableFreeWork {
      let metric = this.freeWork.get(category);
      if (!metric) {
         metric = emptyFreeWork();
         this.freeWork.set(category, metric);
      }
      return metric;
   }
}

function emptyWatchWork(): MutableWatchWork {
   return {
      indexer: Object.fromEntries(
         INDEXER_REQUEST_PURPOSES.map(purpose => [
            purpose,
            emptyIndexerPurposeMetric(),
         ]),
      ) as Record<IndexerRequestPurpose, MutableIndexerPurposeMetric>,
      scanPages: 0,
      transactionsReturned: 0,
      transactionsExamined: 0,
      roundsCovered: 0,
      reconciliationAttempts: 0,
      closingRequests: 0,
      workUnitsClaimed: 0,
   };
}

function emptyIndexerPurposeMetric(): MutableIndexerPurposeMetric {
   return {
      attempts: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      responseBytes: 0,
      queueWait: emptyTiming(),
      wallTime: emptyTiming(),
   };
}

function emptyFreeWork(): MutableFreeWork {
   return {
      requests: 0,
      requestBytes: 0,
      responseBytes: 0,
      wallTime: emptyTiming(),
      statuses: new Map(),
   };
}

function emptyTiming(): MutableTimingMetric {
   return { samples: 0, totalMs: 0, maxMs: 0 };
}

function recordTiming(
   metric: MutableTimingMetric,
   value: number,
   name: string,
): void {
   const milliseconds = nonNegativeNumber(value, name);
   metric.samples += 1;
   metric.totalMs += milliseconds;
   metric.maxMs = Math.max(metric.maxMs, milliseconds);
}

function snapshotWatch(metric: MutableWatchWork): WatchWorkSnapshot {
   return {
      indexer: Object.fromEntries(
         INDEXER_REQUEST_PURPOSES.map(purpose => [
            purpose,
            {
               ...metric.indexer[purpose],
               queueWait: snapshotTiming(metric.indexer[purpose].queueWait),
               wallTime: snapshotTiming(metric.indexer[purpose].wallTime),
            },
         ]),
      ) as Record<IndexerRequestPurpose, IndexerPurposeMetricSnapshot>,
      scanPages: metric.scanPages,
      transactionsReturned: metric.transactionsReturned,
      transactionsExamined: metric.transactionsExamined,
      roundsCovered: metric.roundsCovered,
      reconciliationAttempts: metric.reconciliationAttempts,
      closingRequests: metric.closingRequests,
      workUnitsClaimed: metric.workUnitsClaimed,
      ...(metric.activeDurationMs === undefined
         ? {}
         : { activeDurationMs: metric.activeDurationMs }),
      ...(metric.timeToTerminalMs === undefined
         ? {}
         : { timeToTerminalMs: metric.timeToTerminalMs }),
      ...(metric.finalState === undefined
         ? {}
         : { finalState: metric.finalState }),
   };
}

function snapshotTiming(metric: MutableTimingMetric): TimingMetricSnapshot {
   return {
      samples: metric.samples,
      totalMs: metric.totalMs,
      maxMs: metric.maxMs,
   };
}

function nonNegativeInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
   }
   return value;
}

function positiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
   }
   return value;
}

function nonNegativeNumber(value: number, name: string): number {
   if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
   }
   return value;
}
