import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type {
   FreeRequestCategory,
   FreeWorkSnapshot,
   RoundWatchEconomicsMetrics,
   RuntimeResourceSample,
} from './roundwatch-metrics.js';
import type { IndexerRequestDispatcher } from './roundwatch-scheduler.js';

export const DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS = 60_000;

export interface EconomicsRuntimeSnapshot {
   resources: RuntimeResourceSample;
   activeWatchMetrics: number;
   freeWork: Record<FreeRequestCategory, FreeWorkSnapshot>;
}

export interface EconomicsRuntimeSamplerOptions {
   intervalMilliseconds?: number;
   now?: () => Date;
   monotonicNow?: () => number;
   memoryUsage?: () => NodeJS.MemoryUsage;
   cpuUsage?: () => NodeJS.CpuUsage;
   fileSize?: (path: string) => number | undefined;
   log?: (snapshot: EconomicsRuntimeSnapshot) => void;
}

export class RoundWatchRuntimeSampler {
   private readonly intervalMilliseconds: number;
   private readonly now: () => Date;
   private readonly monotonicNow: () => number;
   private readonly memoryUsage: () => NodeJS.MemoryUsage;
   private readonly cpuUsage: () => NodeJS.CpuUsage;
   private readonly fileSize: (path: string) => number | undefined;
   private readonly log: (snapshot: EconomicsRuntimeSnapshot) => void;
   private timer: NodeJS.Timeout | undefined;
   private previousCpu: NodeJS.CpuUsage;
   private previousMonotonic: number;

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
      this.log = options.log ?? (snapshot => {
         console.info(
            `RoundWatch economics runtime ${JSON.stringify(snapshot)}`,
         );
      });

      this.previousCpu = this.cpuUsage();
      this.previousMonotonic = finiteNumber(
         this.monotonicNow(),
         'monotonicNow',
      );
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

      const currentCpu = this.cpuUsage();
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

      return {
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
      };
   }

   private sampleAndLog(): void {
      try {
         this.log(this.sample());
      } catch (error) {
         console.warn(
            'RoundWatch economics runtime sample failed:',
            error instanceof Error ? error.message : 'Unknown metrics error',
         );
      }
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
   if (!Number.isFinite(value)) {
      throw new Error(`${name} must be finite`);
   }
   return value;
}
