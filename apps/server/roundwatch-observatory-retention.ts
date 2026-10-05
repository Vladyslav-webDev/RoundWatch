import type {
   EconomicsRuntimeSnapshot,
   RuntimeCpuInterval,
   ScheduledRuntimeSampleObserver,
} from './roundwatch-runtime-metrics.js';
import type {
   CapacityObservationV01,
   Observation,
   ResourceObservationV01,
} from './roundwatch-observatory-types.js';

/** One fixed-size pair; this is the only sampled source the builder receives. */
export interface RetainedRuntimeSample {
   capacity: Observation<CapacityObservationV01>;
   resources: Observation<ResourceObservationV01>;
}

export interface ObservatorySampleRetention {
   observer: ScheduledRuntimeSampleObserver;
   snapshot: () => RetainedRuntimeSample;
}

export function createObservatorySampleRetention(
   now: () => Date = () => new Date(),
): ObservatorySampleRetention {
   let retained = freezePair({
      capacity: emptyObservation('not_yet_sampled'),
      resources: emptyObservation('not_yet_sampled'),
   });

   const collectionFailed = (): undefined => {
      try {
         const failedAt = timestamp(now().toISOString());
         const next = freezePair({
            capacity: {
               availability: 'collection_failed',
               observedAt: retained.capacity.observedAt,
               lastCollectionFailureAt: failedAt,
               data: retained.capacity.data,
            },
            resources: {
               availability: 'collection_failed',
               observedAt: retained.resources.observedAt,
               lastCollectionFailureAt: failedAt,
               data: retained.resources.data,
            },
         });
         retained = next;
      } catch {
         // No valid failure time/copy: preserve the complete prior state.
      }
   };

   const sampleCompleted = (source: EconomicsRuntimeSnapshot, cpu: RuntimeCpuInterval | null): undefined => {
      try {
         const rawResources = source.resources;
         const rawCapacity = source.capacity;
         if (rawCapacity === undefined) throw new Error('Missing sampled capacity');
         const sampledAt = timestamp(rawResources.sampledAt);
         // Explicit field selection: raw wrappers, maps and errors never survive.
         const capacity = projectCapacity({
            sampledAt,
            unfinishedWatches: rawCapacity.unfinishedWatches,
            activeWatches: rawCapacity.activeWatches,
            settlementPendingWatches: rawCapacity.settlementPendingWatches,
            unresolvedSettlementUnknownWatches: rawCapacity.unresolvedSettlementUnknownWatches,
            activeWatchesMissingScanBaseline: rawCapacity.activeWatchesMissingScanBaseline,
            watchesPastDeadlineAwaitingCoverage: rawCapacity.watchesPastDeadlineAwaitingCoverage,
            oldestActiveWatchAgeMs: rawCapacity.oldestActiveWatchAgeMs ?? null,
            scanLagRounds: rawCapacity.scanLagRounds ?? null,
            observedIndexerRound: rawCapacity.currentIndexerRound ?? null,
            observedIndexerRoundAt: rawCapacity.currentIndexerRoundObservedAt ?? null,
         });
         const resources = projectResources({
            sampledAt,
            rssBytes: rawResources.rssBytes,
            heapUsedBytes: rawResources.heapUsedBytes,
            heapTotalBytes: rawResources.heapTotalBytes,
            externalBytes: rawResources.externalBytes,
            cpu,
            sqliteBytes: rawResources.sqliteBytes ?? null,
            walBytes: rawResources.walBytes ?? null,
         });
         const lastCollectionFailureAt = retained.capacity.lastCollectionFailureAt;
         const next = freezePair({
            capacity: { availability: 'available', observedAt: sampledAt, lastCollectionFailureAt, data: capacity },
            resources: { availability: 'available', observedAt: sampledAt, lastCollectionFailureAt, data: resources },
         });
         // All validation, copying and nested freezing precede this one write.
         retained = next;
      } catch {
         collectionFailed();
      }
   };

   return { observer: { sampleCompleted, collectionFailed }, snapshot: () => retained };
}

/** Validate/copy one memory read. Rejection never writes producer metadata. */
export function readRetainedRuntimeSample(
   getter: (() => RetainedRuntimeSample) | undefined,
   enabled: boolean,
): RetainedRuntimeSample {
   const empty = (availability: 'unavailable' | 'instrumentation_disabled'): RetainedRuntimeSample => ({
      capacity: emptyObservation(availability), resources: emptyObservation(availability),
   });
   if (!enabled) return empty('instrumentation_disabled');
   if (getter === undefined) return empty('unavailable');
   try {
      const source = getter();
      const capacity = copyObservation(source.capacity, projectCapacity);
      const resources = copyObservation(source.resources, projectResources);
      if (capacity.availability !== resources.availability ||
         capacity.observedAt !== resources.observedAt ||
         capacity.lastCollectionFailureAt !== resources.lastCollectionFailureAt ||
         (capacity.data === null) !== (resources.data === null)) {
         throw new Error('Incoherent sampled pair');
      }
      return { capacity, resources };
   } catch {
      return empty('unavailable');
   }
}

function copyObservation<T extends { sampledAt: string }>(
   source: Observation<T>, project: (data: T) => T,
): Observation<T> {
   const availability = source.availability;
   const failure = source.lastCollectionFailureAt === null
      ? null : timestamp(source.lastCollectionFailureAt);
   if (availability === 'not_yet_sampled') {
      if (source.data !== null || source.observedAt !== null || failure !== null) {
         throw new Error('Invalid empty sampled observation');
      }
      return emptyObservation(availability);
   }
   if (availability !== 'available' && availability !== 'collection_failed') {
      throw new Error('Invalid retained availability');
   }
   if (availability === 'collection_failed' && failure === null) {
      throw new Error('Missing collection failure time');
   }
   if (source.data === null) {
      if (availability !== 'collection_failed' || source.observedAt !== null) {
         throw new Error('Invalid missing sampled data');
      }
      return { availability, observedAt: null, lastCollectionFailureAt: failure, data: null };
   }
   const data = project(source.data);
   const observedAt = timestamp(source.observedAt);
   if (observedAt !== data.sampledAt) throw new Error('Invalid sampled provenance');
   return { availability, observedAt, lastCollectionFailureAt: failure, data };
}

function projectCapacity(source: CapacityObservationV01): CapacityObservationV01 {
   const round = source.observedIndexerRound === null ? null : count(source.observedIndexerRound);
   const roundAt = source.observedIndexerRoundAt === null ? null : timestamp(source.observedIndexerRoundAt);
   if ((round === null) !== (roundAt === null)) throw new Error('Unpaired sampled tip');
   const lag = source.scanLagRounds;
   const scanLagRounds = lag === null ? null : {
      samples: count(lag.samples), p50: count(lag.p50), p95: count(lag.p95), max: count(lag.max),
   };
   if (scanLagRounds !== null && (round === null || scanLagRounds.samples === 0 ||
      scanLagRounds.p50 > scanLagRounds.p95 || scanLagRounds.p95 > scanLagRounds.max)) {
      throw new Error('Invalid sampled lag distribution');
   }
   return {
      sampledAt: timestamp(source.sampledAt),
      unfinishedWatches: count(source.unfinishedWatches),
      activeWatches: count(source.activeWatches),
      settlementPendingWatches: count(source.settlementPendingWatches),
      unresolvedSettlementUnknownWatches: count(source.unresolvedSettlementUnknownWatches),
      activeWatchesMissingScanBaseline: count(source.activeWatchesMissingScanBaseline),
      watchesPastDeadlineAwaitingCoverage: count(source.watchesPastDeadlineAwaitingCoverage),
      oldestActiveWatchAgeMs: source.oldestActiveWatchAgeMs === null ? null : milliseconds(source.oldestActiveWatchAgeMs),
      scanLagRounds, observedIndexerRound: round, observedIndexerRoundAt: roundAt,
   };
}

function projectResources(source: ResourceObservationV01): ResourceObservationV01 {
   const interval = source.cpu;
   const cpu = interval === null ? null : {
      userMicros: count(interval.userMicros), systemMicros: count(interval.systemMicros),
      elapsedMs: milliseconds(interval.elapsedMs),
   };
   if (cpu !== null && cpu.elapsedMs === 0) throw new Error('Unmeasurable CPU interval');
   return {
      sampledAt: timestamp(source.sampledAt),
      rssBytes: count(source.rssBytes), heapUsedBytes: count(source.heapUsedBytes),
      heapTotalBytes: count(source.heapTotalBytes), externalBytes: count(source.externalBytes),
      cpu,
      sqliteBytes: source.sqliteBytes === null ? null : count(source.sqliteBytes),
      walBytes: source.walBytes === null ? null : count(source.walBytes),
   };
}

function freezePair(pair: RetainedRuntimeSample): RetainedRuntimeSample {
   const capacity = pair.capacity.data;
   const resources = pair.resources.data;
   if (capacity !== null) {
      if (capacity.scanLagRounds !== null) Object.freeze(capacity.scanLagRounds);
      Object.freeze(capacity);
   }
   if (resources !== null) {
      if (resources.cpu !== null) Object.freeze(resources.cpu);
      Object.freeze(resources);
   }
   Object.freeze(pair.capacity);
   Object.freeze(pair.resources);
   return Object.freeze(pair);
}

function emptyObservation<T>(
   availability: 'unavailable' | 'instrumentation_disabled' | 'not_yet_sampled',
): Observation<T> {
   return { availability, observedAt: null, lastCollectionFailureAt: null, data: null };
}

function count(value: unknown): number {
   if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Invalid sampled count/bytes/round');
   }
   return value;
}

function milliseconds(value: unknown): number {
   if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('Invalid sampled milliseconds');
   }
   return value;
}

function timestamp(value: unknown): string {
   if (typeof value !== 'string') throw new Error('Invalid sampled timestamp');
   const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
   if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !==
      `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`) {
      throw new Error('Invalid sampled timestamp');
   }
   return value;
}
