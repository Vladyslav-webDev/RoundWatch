import type { IndexerDispatcherSnapshot, IndexerRequestPurpose } from './roundwatch-scheduler.js';
import type { WatchRecord, WatchState } from './roundwatch-store.js';

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

/** A recorder bound to one process-local watch metrics lifecycle. */
export interface WatchEconomicsRecorder {
   recordIndexerRequest(
      purpose: IndexerRequestPurpose,
      observation: IndexerRequestObservation,
   ): void;
   recordScanPage(observation: ScanPageObservation): void;
   recordCoverage(roundsCovered: number): void;
   recordReconciliationAttempt(): void;
   recordClosingRequest(): void;
   recordWorkUnit(): void;
   recordLifecycle(observation: WatchLifecycleObservation): void;
   finishWatch(): WatchWorkSnapshot | undefined;
}

/** Explicitly disabled telemetry: a supplied recorder suppresses ID fallback. */
export const INERT_WATCH_ECONOMICS_RECORDER: WatchEconomicsRecorder = Object.freeze({
   recordIndexerRequest: () => {},
   recordScanPage: () => {},
   recordCoverage: () => {},
   recordReconciliationAttempt: () => {},
   recordClosingRequest: () => {},
   recordWorkUnit: () => {},
   recordLifecycle: () => {},
   finishWatch: () => undefined,
});

/** A single turn's recorder and independent release, both bound before await. */
export interface WatchEconomicsTurn {
   readonly recorder: WatchEconomicsRecorder;
   readonly release: (() => void) | undefined;
}

export function warnWatchMetricFailure(context: string, error: unknown): void {
   // A failed diagnostic sink must not escape into provider handling. Do not
   // attempt to log its own failure, which could recurse indefinitely.
   try {
      console.warn(context, error instanceof Error ? error.message : 'Unknown metrics error');
   } catch {}
}

export function captureWatchEconomicsTurn(
   metrics: RoundWatchEconomicsMetrics | undefined,
   watchId: string,
   existingOnly = false,
): WatchEconomicsTurn | undefined {
   if (!metrics) return;
   const bindRelease = () => {
      try { return metrics.bindWatchRelease(watchId); }
      catch (error) { warnWatchMetricFailure('RoundWatch economics release binding failed:', error); }
   };
   // Preserve an existing identity even if capture itself partially fails.
   let release = bindRelease();
   let recorder = INERT_WATCH_ECONOMICS_RECORDER;
   try {
      recorder = (existingOnly ? metrics.captureExistingWatch(watchId) : metrics.captureWatch(watchId)) ?? recorder;
   } catch (error) {
      warnWatchMetricFailure('RoundWatch economics capture metric failed:', error);
   }
   // Capture may have created the first entry and then thrown. This is a
   // synchronous, non-creating release binding, never a later ID fallback.
   release ??= bindRelease();
   return { recorder, release };
}

export function finishWatchEconomicsTurn(
   turn: WatchEconomicsTurn | undefined,
   watch: WatchRecord | undefined,
   now: () => number = Date.now,
): void {
   if (!turn || !watch) return;
   const terminal = watch.state === 'matched' || watch.state === 'expired' ||
      watch.state === 'indeterminate' ||
      (watch.state === 'settlement_unknown' && watch.settlementReconciliationTerminal);
   if (!terminal) return;

   let recorded = false;
   let snapshot: WatchWorkSnapshot | undefined;
   if (turn.recorder !== INERT_WATCH_ECONOMICS_RECORDER) {
      try {
         const timestamp = now();
         const createdAt = Date.parse(watch.createdAt);
         const activatedAt = watch.activatedAt ? Date.parse(watch.activatedAt) : NaN;
         turn.recorder.recordLifecycle({
            finalState: watch.state,
            ...(Number.isFinite(createdAt) ? { timeToTerminalMs: Math.max(0, timestamp - createdAt) } : {}),
            ...(Number.isFinite(activatedAt) ? { activeDurationMs: Math.max(0, timestamp - activatedAt) } : {}),
         });
         recorded = true;
      } catch (error) { warnWatchMetricFailure('RoundWatch economics lifecycle metric failed:', error); }
      if (recorded) {
         try { snapshot = turn.recorder.finishWatch(); }
         catch (error) { warnWatchMetricFailure('RoundWatch economics finish metric failed:', error); }
      }
   }
   // Independent of recording and snapshot construction; exactly one bounded
   // attempt, identity-fenced and idempotent even if finish removed the entry.
   try { turn.release?.(); }
   catch (error) { warnWatchMetricFailure('RoundWatch economics release metric failed:', error); }
   if (snapshot) {
      try { console.info(`RoundWatch economics watch-terminal ${JSON.stringify(snapshot)}`); }
      catch (error) { warnWatchMetricFailure('RoundWatch economics terminal log failed:', error); }
   }
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
 *
 * Watch IDs are durable randomUUID() primary keys, not reusable job names.
 * ID-based record methods start/record live work synchronously. Async callers
 * must capture a recorder before awaiting and carry it through the whole turn,
 * including subsequent requests and terminal handling. A captured recorder
 * becomes inert when its entry is removed, even if the ID is later reused.
 * Restart recovery starts fresh process-local metrics only for unfinished work;
 * no historical finished-ID state is retained here.
 */
export class RoundWatchEconomicsMetrics {
   private readonly watches = new Map<string, MutableWatchWork>();
   private readonly freeWork = new Map<FreeRequestCategory, MutableFreeWork>();

   captureWatch(watchId: string): WatchEconomicsRecorder {
      return this.recorder(watchId, this.watch(watchId));
   }

   captureExistingWatch(watchId: string): WatchEconomicsRecorder | undefined {
      const metric = this.watches.get(watchId);
      return metric ? this.recorder(watchId, metric) : undefined;
   }

   bindWatchRelease(watchId: string): (() => void) | undefined {
      const metric = this.watches.get(watchId);
      if (!metric) return;
      return () => {
         if (this.watches.get(watchId) === metric) this.watches.delete(watchId);
      };
   }

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

   private recorder(
      watchId: string,
      metric: MutableWatchWork,
   ): WatchEconomicsRecorder {
      // Identity, rather than ID alone, fences every late observation. These
      // closures belong to outstanding work; the accumulator retains no handle
      // or tombstone after finishWatch deletes the entry.
      const record = <Args extends unknown[]>(operation: (...args: Args) => void) =>
         (...args: Args): void => {
            if (this.watches.get(watchId) === metric) operation(...args);
         };

      return {
         recordIndexerRequest: record((purpose, observation) =>
            this.recordIndexerRequest(watchId, purpose, observation)),
         recordScanPage: record(observation => this.recordScanPage(watchId, observation)),
         recordCoverage: record(rounds => this.recordCoverage(watchId, rounds)),
         recordReconciliationAttempt: record(() => this.recordReconciliationAttempt(watchId)),
         recordClosingRequest: record(() => this.recordClosingRequest(watchId)),
         recordWorkUnit: record(() => this.recordWorkUnit(watchId)),
         recordLifecycle: record(observation => this.recordLifecycle(watchId, observation)),
         finishWatch: () => this.watches.get(watchId) === metric
            ? this.finishWatch(watchId)
            : undefined,
      };
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
