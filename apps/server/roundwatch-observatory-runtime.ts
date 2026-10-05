import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { IndexerDispatcherSnapshot } from './roundwatch-scheduler.js';
import type { PollerCapacitySnapshot } from './roundwatch-poller.js';
import type { WorkerHealthSnapshot } from './roundwatch-worker-health.js';
import type {
   DispatcherObservationV01,
   IsoUtc,
   Observation,
   ObservatoryRuntimeV01,
   PollCycleObservationV01,
   WorkerObservationV01,
} from './roundwatch-observatory-types.js';

export interface CachedIndexerTip {
   currentIndexerRound?: number;
   currentIndexerRoundObservedAt?: string;
}

/** Only resolved scalars and bounded, read-only memory getters belong here. */
export interface ObservatoryRuntimeSources {
   network: 'testnet' | 'mainnet';
   assetId: string;
   economicsMetricsEnabled: boolean;
   pollerHealthSnapshot: () => WorkerHealthSnapshot;
   reconcilerHealthSnapshot: () => WorkerHealthSnapshot;
   dispatcherSnapshot: () => IndexerDispatcherSnapshot;
   cachedIndexerTip: () => CachedIndexerTip;
   pollCycleSnapshot?: () => PollerCapacitySnapshot;
}

export interface ObservatoryClocks {
   epochMilliseconds: () => number;
   processMonotonicMilliseconds: () => number;
}

/**
 * Construct once alongside the dispatcher at boot. Reconstruct this builder if
 * that counter source is replaced/reset. Reads never generate an epoch, retain
 * observations, refresh producers, or invoke an operational fallback.
 */
export function createObservatoryRuntimeSnapshotBuilder(
   sources: ObservatoryRuntimeSources,
   clocks: ObservatoryClocks = {
      epochMilliseconds: () => Date.now(),
      processMonotonicMilliseconds: () => performance.now(),
   },
   generateProcessEpoch: () => string = randomUUID,
): () => ObservatoryRuntimeV01 {
   const {
      network, assetId, economicsMetricsEnabled,
      pollerHealthSnapshot, reconcilerHealthSnapshot,
      dispatcherSnapshot, cachedIndexerTip, pollCycleSnapshot,
   } = sources;
   const { epochMilliseconds, processMonotonicMilliseconds } = clocks;
   const processEpoch = initializeProcessEpoch(generateProcessEpoch);

   return () => {
      const poller = directObservation(
         pollerHealthSnapshot, projectWorker, epochMilliseconds,
      );
      const reconciler = directObservation(
         reconcilerHealthSnapshot, projectWorker, epochMilliseconds,
      );
      let processMonotonicMs: number | null = null;
      const dispatcher = directObservation(
         () => {
            const snapshot = dispatcherSnapshot();
            // Adjacent synchronous observation; no sampling or async work.
            processMonotonicMs = processEpoch === null
               ? null
               : monotonicObservation(processMonotonicMilliseconds);
            return snapshot;
         },
         projectDispatcher,
         epochMilliseconds,
      );
      if (dispatcher.availability !== 'available') processMonotonicMs = null;
      const observedRound = cachedRoundObservation(cachedIndexerTip);
      const pollCycle = completedPollCycleObservation(pollCycleSnapshot);
      // Comparison wall clock follows direct observations; never dates the tip.
      const observedAt = epochToIsoUtc(epochMilliseconds());
      const optionalAvailability = economicsMetricsEnabled
         ? 'unavailable'
         : 'instrumentation_disabled';

      return {
         schemaVersion: 'observatory-runtime-v0.1',
         observedAt,
         runtime: {
            network,
            assetId,
            economicsMetricsEnabled,
            processEpoch,
            processMonotonicMs,
            deployedCommit: null,
         },
         workers: { poller, reconciler },
         indexer: { dispatcher, observedRound },
         pollCycle,
         readiness: emptyObservation('unavailable'),
         capacity: emptyObservation(optionalAvailability),
         resources: emptyObservation(optionalAvailability),
      };
   };
}

function initializeProcessEpoch(generate: () => string): string | null {
   try {
      return generate();
   } catch {
      // Optional Observatory identity must never abort operational startup.
      // Keep rates disabled for this lifetime; do not log, retry, or substitute.
      return null;
   }
}

function emptyObservation<T>(
   availability: 'unavailable' | 'not_yet_sampled' | 'instrumentation_disabled',
): Observation<T> {
   return { availability, observedAt: null, lastCollectionFailureAt: null, data: null };
}

function availableObservation<T>(data: T, observedAt: IsoUtc): Observation<T> {
   return { availability: 'available', observedAt, lastCollectionFailureAt: null, data };
}

function directObservation<S, T>(
   getter: () => S,
   project: (source: S) => T,
   now: () => number,
): Observation<T> {
   try {
      const source = getter();
      const observedAt = epochToIsoUtc(now());
      return availableObservation(project(source), observedAt);
   } catch {
      // Read-time rejection must not mutate worker or collection-failure state.
      return emptyObservation('unavailable');
   }
}

function projectWorker(source: WorkerHealthSnapshot): WorkerObservationV01 {
   if (!['unknown', 'healthy', 'unhealthy'].includes(source.providerHealth)) {
      throw new Error('Invalid worker provider health');
   }
   return {
      started: booleanValue(source.started),
      running: booleanValue(source.running),
      ready: booleanValue(source.ready),
      cycleNotStalled: booleanValue(source.cycleNotStalled),
      providerHealth: source.providerHealth,
      consecutiveFailures: countValue(source.consecutiveFailures),
      lastCycleStartedAt: optionalEpochToIsoUtc(source.lastCycleStartedAtMs),
      lastProgressAt: optionalEpochToIsoUtc(source.lastProgressAtMs),
      lastProviderEvidenceAt: optionalEpochToIsoUtc(source.lastProviderEvidenceAtMs),
      lastErrorAt: optionalEpochToIsoUtc(source.lastErrorAtMs),
   };
}

function projectDispatcher(source: IndexerDispatcherSnapshot): DispatcherObservationV01 {
   const requests = source.requests;
   if (requests === null || typeof requests !== 'object' || Array.isArray(requests)) {
      throw new Error('Invalid dispatcher purpose counters');
   }
   const purposeCount = (key: keyof DispatcherObservationV01['requests']) => {
      return Object.hasOwn(requests, key) ? countValue(requests[key]) : 0;
   };
   const failures = countValue(source.failures);
   const timeouts = countValue(source.timeouts);
   if (timeouts > failures) throw new Error('Dispatcher timeouts exceed failures');
   return {
      queued: countValue(source.queued),
      inFlight: countValue(source.inFlight),
      requests: {
         activation: purposeCount('activation'),
         reconciliation: purposeCount('reconciliation'),
         'absence-proof': purposeCount('absence-proof'),
         'scan-page': purposeCount('scan-page'),
         checkpoint: purposeCount('checkpoint'),
         health: purposeCount('health'),
      },
      successes: countValue(source.successes),
      failures,
      // Already a subset of failures; do not add or subtract it from outcomes.
      timeouts,
   };
}

function cachedRoundObservation(getter: () => CachedIndexerTip): Observation<{ round: number }> {
   try {
      const source = getter();
      if (source === null || typeof source !== 'object' || Array.isArray(source)) {
         return emptyObservation('unavailable');
      }
      const round = source.currentIndexerRound;
      const observedAt = source.currentIndexerRoundObservedAt;
      if (round === undefined && observedAt === undefined) {
         // The existing poller cache is wired but has never observed a sweep tip.
         return emptyObservation('not_yet_sampled');
      }
      if (!isIsoUtc(observedAt)) return emptyObservation('unavailable');
      return availableObservation({ round: countValue(round) }, observedAt);
   } catch {
      return emptyObservation('unavailable');
   }
}

function booleanValue(value: unknown): boolean {
   if (typeof value !== 'boolean') throw new Error('Invalid boolean');
   return value;
}

function completedPollCycleObservation(
   getter: ObservatoryRuntimeSources['pollCycleSnapshot'],
): Observation<PollCycleObservationV01> {
   if (getter === undefined) return emptyObservation('unavailable');
   try {
      const source = getter();
      const observedAt = source.lastCycleCompletedAt;
      const durationMs = source.lastCycleDurationMs;
      const data = {
         attempted: countValue(source.watchesAttemptedLastCycle),
         progressed: countValue(source.watchesSucceededLastCycle),
         failed: countValue(source.watchesFailedLastCycle),
      };
      if (observedAt === undefined && durationMs === undefined &&
         data.attempted === 0 && data.progressed === 0 && data.failed === 0) {
         return emptyObservation('not_yet_sampled');
      }
      if (!isIsoUtc(observedAt) || typeof durationMs !== 'number' ||
         !Number.isFinite(durationMs) || durationMs < 0) {
         return emptyObservation('unavailable');
      }
      return availableObservation({
         durationMs,
         attempted: data.attempted,
         progressed: data.progressed,
         failed: data.failed,
      }, observedAt);
   } catch {
      return emptyObservation('unavailable');
   }
}

function countValue(value: unknown): number {
   if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid nonnegative safe integer');
   }
   return value;
}

function epochToIsoUtc(value: number): IsoUtc {
   if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Invalid Observatory epoch timestamp');
   }
   // toISOString also rejects finite epoch values outside the Date range.
   return new Date(value).toISOString();
}

function optionalEpochToIsoUtc(value: number | null | undefined): IsoUtc | null {
   return value === undefined || value === null ? null : epochToIsoUtc(value);
}

function isIsoUtc(value: unknown): value is IsoUtc {
   if (typeof value !== 'string') return false;
   // Bounded UTC syntax, with calendar round-trip validation (no date rollover).
   const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
   if (!match) return false;
   const parsed = new Date(value);
   return Number.isFinite(parsed.getTime()) &&
      parsed.toISOString() === `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
}

function monotonicObservation(now: () => number): number | null {
   try {
      const value = now();
      return typeof value === 'number' && Number.isFinite(value) && value >= 0
         ? value
         : null;
   } catch {
      return null;
   }
}
