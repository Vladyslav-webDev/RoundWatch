import { createObservatorySampleRetention, type ObservatorySampleRetention } from './roundwatch-observatory-retention.js';
import { RoundWatchRuntimeSampler, type EconomicsRuntimeSamplerOptions } from './roundwatch-runtime-metrics.js';
import type { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import type { IndexerRequestDispatcher } from './roundwatch-scheduler.js';
import { createObservatoryReadinessRetention, type ObservatoryReadinessRetention } from './roundwatch-observatory-readiness.js';

/** Optional passive readiness retention must not abort operational startup. */
export function initializeObservatoryReadinessRetention(
   factory: () => ObservatoryReadinessRetention = createObservatoryReadinessRetention,
): ObservatoryReadinessRetention | undefined {
   try {
      return factory();
   } catch {
      return undefined;
   }
}

/** Optional passive construction must not abort operational startup. */
export function initializeObservatorySampleRetention(
   factory: () => ObservatorySampleRetention = createObservatorySampleRetention,
): ObservatorySampleRetention | undefined {
   try {
      return factory();
   } catch {
      return undefined;
   }
}

/** Preserve the existing economics gate and lifecycle; construction starts no timer. */
export function createObservatoryRuntimeSampler(
   metrics: RoundWatchEconomicsMetrics | undefined,
   dispatcher: IndexerRequestDispatcher,
   databasePath: string,
   samples: ObservatorySampleRetention | undefined,
   options: Omit<EconomicsRuntimeSamplerOptions, 'observer'>,
): RoundWatchRuntimeSampler | undefined {
   return metrics === undefined ? undefined : new RoundWatchRuntimeSampler(
      metrics, dispatcher, databasePath, {
         ...options,
         observer: samples === undefined ? undefined : {
            sampleCompleted: (snapshot, cpu) => samples.observer.sampleCompleted(snapshot, cpu),
            collectionFailed: () => samples.observer.collectionFailed(),
         },
      },
   );
}
