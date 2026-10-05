import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type {
   FreeRequestCategory,
   FreeWorkSnapshot,
   RoundWatchEconomicsMetrics,
   RuntimeResourceSample,
} from './roundwatch-metrics.js';
import type { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import type { PollerCapacitySnapshot } from './roundwatch-poller.js';
import type { RoundWatchCapacitySnapshot } from './roundwatch-store.js';

export const DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS = 60_000;

export type CapacityRuntimeSnapshot =
   RoundWatchCapacitySnapshot & PollerCapacitySnapshot;

export interface EconomicsRuntimeSnapshot {
   resources: RuntimeResourceSample;
   activeWatchMetrics: number;
   freeWork: Record<FreeRequestCategory, FreeWorkSnapshot>;
   capacity?: CapacityRuntimeSnapshot;
}

/** Proven interval, separate from the legacy economics elapsed/delta fields. */
export interface RuntimeCpuInterval {
   userMicros: number;
   systemMicros: number;
   elapsedMs: number;
}

export interface ScheduledRuntimeSampleObserver {
   // Synchronous publication only; unlike void, undefined rejects async callbacks.
   sampleCompleted(snapshot: EconomicsRuntimeSnapshot, cpu: RuntimeCpuInterval | null): undefined;
   collectionFailed(): undefined;
}

export interface EconomicsRuntimeSamplerOptions {
   intervalMilliseconds?: number;
   now?: () => Date;
   monotonicNow?: () => number;
   memoryUsage?: () => NodeJS.MemoryUsage;
   cpuUsage?: () => NodeJS.CpuUsage;
   fileSize?: (path: string) => number | undefined;
   log?: (snapshot: EconomicsRuntimeSnapshot) => void;
   capacitySnapshot?: () => CapacityRuntimeSnapshot;
   observer?: ScheduledRuntimeSampleObserver;
}

export class RoundWatchRuntimeSampler {
   private readonly intervalMilliseconds: number;
   private readonly now: () => Date;
   private readonly monotonicNow: () => number;
   private readonly memoryUsage: () => NodeJS.MemoryUsage;
   private readonly cpuUsage: () => NodeJS.CpuUsage;
   private readonly fileSize: (path: string) => number | undefined;
   private readonly log: (snapshot: EconomicsRuntimeSnapshot) => void;
   private readonly capacitySnapshot?: () => CapacityRuntimeSnapshot;
   private readonly observer?: ScheduledRuntimeSampleObserver;
   private timer: NodeJS.Timeout | undefined;
   private previousCpu: NodeJS.CpuUsage;
   private previousMonotonic: number;
   private pairedCpuBaseline?: { user: number; system: number; monotonicMs: number };

   constructor(
      private readonly metrics: RoundWatchEconomicsMetrics,
      private readonly dispatcher: IndexerRequestDispatcher,
      private readonly databasePath: string,
      options: EconomicsRuntimeSamplerOptions = {},
   ) {
      this.intervalMilliseconds = positiveInteger(
         options.intervalMilliseconds ?? DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS,
         'intervalMilliseconds',
      );
      this.now = options.now ?? (() => new Date());
      this.monotonicNow = options.monotonicNow ?? (() => performance.now());
      this.memoryUsage = options.memoryUsage ?? (() => process.memoryUsage());
      this.cpuUsage = options.cpuUsage ?? (() => process.cpuUsage());
      this.fileSize = options.fileSize ?? safeFileSize;
      this.capacitySnapshot = options.capacitySnapshot;
      try {
         this.observer = options.observer;
      } catch {
         // Optional passive wiring must not abort operational startup.
      }
      this.log = options.log ?? (snapshot => {
         console.info(
            `RoundWatch economics runtime ${JSON.stringify(snapshot)}`,
         );
      });

      this.previousCpu = cpuTotals(this.cpuUsage());
      this.previousMonotonic = finiteNumber(
         this.monotonicNow(),
         'monotonicNow',
      );
      this.pairedCpuBaseline = {
         ...this.previousCpu, monotonicMs: this.previousMonotonic,
      };
   }

   start(): void {
      if (this.timer) return;

      this.sampleAndLog();
      this.timer = setInterval(
         () => this.sampleAndLog(),
         this.intervalMilliseconds,
      );
      this.timer.unref();
   }

   stop(): void {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
   }

   sample(): EconomicsRuntimeSnapshot {
      // Public/manual acquisition still advances legacy baselines, but cannot
      // silently shorten the next scheduled Observatory CPU interval.
      return this.acquire(false).snapshot;
   }

   private acquire(scheduled: boolean): {
      snapshot: EconomicsRuntimeSnapshot;
      cpu: RuntimeCpuInterval | null;
   } {
      const baseline = this.pairedCpuBaseline;
      // Every acquisition failure, early or late, leaves confidence cleared.
      this.pairedCpuBaseline = undefined;
      const sampledAt = this.now().toISOString();
      const currentMonotonic = finiteNumber(
         this.monotonicNow(),
         'monotonicNow',
      );
      const elapsedMs = Math.max(
         0,
         currentMonotonic - this.previousMonotonic,
      );
      this.previousMonotonic = currentMonotonic;

      const currentCpu = cpuTotals(this.cpuUsage());
      const cpuUserMicros = Math.max(
         0,
         currentCpu.user - this.previousCpu.user,
      );
      const cpuSystemMicros = Math.max(
         0,
         currentCpu.system - this.previousCpu.system,
      );
      this.previousCpu = currentCpu;

      const memory = this.memoryUsage();
      const sqliteBytes = this.databasePath === ':memory:'
         ? undefined
         : this.fileSize(this.databasePath);
      const walBytes = this.databasePath === ':memory:'
         ? undefined
         : this.fileSize(`${this.databasePath}-wal`);

      const snapshot: EconomicsRuntimeSnapshot = {
         resources: {
            sampledAt,
            elapsedMs,
            rssBytes: nonNegativeInteger(memory.rss, 'rssBytes'),
            heapUsedBytes: nonNegativeInteger(
               memory.heapUsed,
               'heapUsedBytes',
            ),
            heapTotalBytes: nonNegativeInteger(
               memory.heapTotal,
               'heapTotalBytes',
            ),
            externalBytes: nonNegativeInteger(
               memory.external,
               'externalBytes',
            ),
            cpuUserMicros: nonNegativeInteger(
               cpuUserMicros,
               'cpuUserMicros',
            ),
            cpuSystemMicros: nonNegativeInteger(
               cpuSystemMicros,
               'cpuSystemMicros',
            ),
            ...(sqliteBytes === undefined ? {} : { sqliteBytes }),
            ...(walBytes === undefined ? {} : { walBytes }),
            dispatcher: this.dispatcher.snapshot(),
         },
         activeWatchMetrics: this.metrics.activeWatchMetricCount(),
         freeWork: this.metrics.snapshotAllFreeWork(),
         ...(this.capacitySnapshot === undefined
            ? {}
            : { capacity: this.capacitySnapshot() }),
      };
      const pairedElapsed = baseline === undefined
         ? null
         : currentMonotonic - baseline.monotonicMs;
      const cpu = scheduled && baseline !== undefined &&
         pairedElapsed !== null && Number.isFinite(pairedElapsed) && pairedElapsed > 0 &&
         currentCpu.user >= baseline.user && currentCpu.system >= baseline.system
         ? {
            userMicros: currentCpu.user - baseline.user,
            systemMicros: currentCpu.system - baseline.system,
            elapsedMs: pairedElapsed,
         }
         : null;
      if (scheduled) {
         // Only completed acquisition establishes the next scheduled pair.
         // Projection/publication/logging cannot invalidate this evidence.
         this.pairedCpuBaseline = { ...currentCpu, monotonicMs: currentMonotonic };
      }
      return { snapshot, cpu };
   }

   private sampleAndLog(): void {
      let acquired: ReturnType<RoundWatchRuntimeSampler['acquire']>;
      try {
         acquired = this.acquire(true);
      } catch (error) {
         this.notifyCollectionFailed();
         this.warnSampleFailure(error);
         return;
      }
      try {
         const returned: unknown = this.observer?.sampleCompleted(acquired.snapshot, acquired.cpu);
         if (containUnsupportedPromise(returned)) this.notifyCollectionFailed();
      } catch {
         // Observer failure must neither suppress logging nor stop the cadence.
         this.notifyCollectionFailed();
      }
      try {
         this.log(acquired.snapshot);
      } catch (error) {
         this.warnSampleFailure(error);
      }
   }

   private notifyCollectionFailed(): void {
      try {
         containUnsupportedPromise(this.observer?.collectionFailed());
      } catch { /* Passive hook only; never notify recursively. */ }
   }

   private warnSampleFailure(error: unknown): void {
      console.warn(
         'RoundWatch economics runtime sample failed:',
         error instanceof Error ? error.message : 'Unknown metrics error',
      );
   }
}

function safeFileSize(path: string): number | undefined {
   try {
      return statSync(path).size;
   } catch {
      return undefined;
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

function finiteNumber(value: number, name: string): number {
   if (typeof value !== 'number' || !Number.isFinite(value) ||
      value < 0 || value > Number.MAX_SAFE_INTEGER) {
      throw new Error(`${name} must be finite, non-negative and safely measurable`);
   }
   return value;
}

/** Contain unsupported Promise/thenable returns without awaiting any work.
 * Failure is classified at invocation time. Settlement only consumes rejection:
 * it must never notify retention later and overwrite a newer observation.
 * This cannot cancel asynchronous work started inside the callback.
 */
function containUnsupportedPromise(returned: unknown): boolean {
   if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
      typeof (returned as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(returned).catch(() => {});
      return true;
   }
   return false;
}

function cpuTotals(value: NodeJS.CpuUsage): NodeJS.CpuUsage {
   // Validate operands BEFORE subtraction/clamping; copy injected objects too.
   return {
      user: nonNegativeInteger(value.user, 'cpu user total'),
      system: nonNegativeInteger(value.system, 'cpu system total'),
   };
}
