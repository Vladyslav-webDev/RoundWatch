import type { Observation, PublicReadinessObservationV01 } from './roundwatch-observatory-types.js';

/** Synchronous producer only; undefined return excludes async observers. */
export interface PublicReadinessObserver {
   outcomeCompleted: (outcome: PublicReadinessObservationV01, observedAt?: string) => undefined;
   collectionFailed: () => undefined;
}

export interface ObservatoryReadinessRetention {
   observer: PublicReadinessObserver;
   snapshot: () => Observation<PublicReadinessObservationV01>;
}

/** Called only after the ordinary public response has been determined. */
export function observePublicReadinessOutcome(
   observer: PublicReadinessObserver | undefined,
   outcome: unknown,
): void {
   if (observer === undefined) return;
   try {
      // Never pass the raw public response/check map to the retention observer.
      const returned: unknown = observer.outcomeCompleted(projectReadiness(outcome));
      if (containUnsupportedPromise(returned)) notifyFailure(observer);
   } catch {
      notifyFailure(observer);
   }
}

function notifyFailure(observer: PublicReadinessObserver): void {
   try { containUnsupportedPromise(observer.collectionFailed()); } catch { /* Keep the completed response. */ }
}

/** Runtime misuse is classified synchronously; rejection never writes later metadata. */
function containUnsupportedPromise(returned: unknown): boolean {
   if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') &&
      typeof (returned as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(returned).catch(() => {});
      return true;
   }
   return false;
}

export function createObservatoryReadinessRetention(
   now: () => Date = () => new Date(),
): ObservatoryReadinessRetention {
   let retained = freezeObservation(emptyObservation('not_yet_sampled'));

   const collectionFailed = (): undefined => {
      try {
         const failedAt = timestamp(now().toISOString());
         const next = freezeObservation({
            availability: 'collection_failed',
            observedAt: retained.observedAt,
            lastCollectionFailureAt: failedAt,
            data: retained.data,
         });
         retained = next;
      } catch {
         // A failed clock/conversion/publication preserves the entire prior record.
      }
   };

   const outcomeCompleted: PublicReadinessObserver['outcomeCompleted'] = (outcome, suppliedTime) => {
      try {
         const observedAt = timestamp(suppliedTime === undefined ? now().toISOString() : suppliedTime);
         const data = projectReadiness(outcome);
         const next = freezeObservation({
            availability: 'available', observedAt,
            lastCollectionFailureAt: retained.lastCollectionFailureAt, data,
         });
         // Validate, independently project and freeze before the single replacement.
         // Publication order is execution order, independent of wall-clock chronology.
         retained = next;
      } catch {
         collectionFailed();
      }
   };

   return { observer: { outcomeCompleted, collectionFailed }, snapshot: () => retained };
}

/** Exactly one retained-memory read; rejection never mutates producer metadata. */
export function readRetainedPublicReadiness(
   getter: (() => Observation<PublicReadinessObservationV01>) | undefined,
): Observation<PublicReadinessObservationV01> {
   if (getter === undefined) return emptyObservation('unavailable');
   try {
      const source = getter();
      const availability = source.availability;
      const failure = source.lastCollectionFailureAt === null
         ? null : timestamp(source.lastCollectionFailureAt);
      if (availability === 'not_yet_sampled') {
         if (source.data !== null || source.observedAt !== null || failure !== null) {
            throw new Error('Invalid empty readiness observation');
         }
         return emptyObservation(availability);
      }
      if (availability !== 'available' && availability !== 'collection_failed') {
         throw new Error('Invalid retained readiness availability');
      }
      if (availability === 'collection_failed' && failure === null) {
         throw new Error('Missing readiness collection failure time');
      }
      if (source.data === null) {
         if (availability !== 'collection_failed' || source.observedAt !== null) {
            throw new Error('Invalid missing readiness data');
         }
         return { availability, observedAt: null, lastCollectionFailureAt: failure, data: null };
      }
      return {
         availability, observedAt: timestamp(source.observedAt),
         lastCollectionFailureAt: failure, data: projectReadiness(source.data),
      };
   } catch {
      return emptyObservation('unavailable');
   }
}

function projectReadiness(source: unknown): PublicReadinessObservationV01 {
   const outcome = record(source);
   const ready = boolean(ownData(outcome, 'ready'));
   const checks = record(ownData(outcome, 'checks'));
   if (Object.hasOwn(checks, 'readinessCheck')) {
      if (ready !== false || boolean(ownData(checks, 'readinessCheck')) !== false ||
         ['storage', 'poller', 'reconciler', 'backgroundWorkers', 'diskHeadroom']
            .some(key => Object.hasOwn(checks, key))) {
         throw new Error('Invalid readiness exception outcome');
      }
      return { ready: false, checks: { readinessCheck: false } };
   }
   return {
      ready,
      checks: {
         storage: boolean(ownData(checks, 'storage')), poller: boolean(ownData(checks, 'poller')),
         reconciler: boolean(ownData(checks, 'reconciler')),
         backgroundWorkers: boolean(ownData(checks, 'backgroundWorkers')),
         diskHeadroom: boolean(ownData(checks, 'diskHeadroom')),
      },
   };
}

function record(value: unknown): Record<string, unknown> {
   if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid readiness object');
   }
   // Reject own or inherited serialization hooks without invoking accessors.
   if ('toJSON' in value) throw new Error('Custom readiness serialization');
   return value as Record<string, unknown>;
}

function ownData(source: Record<string, unknown>, key: string): unknown {
   const property = Object.getOwnPropertyDescriptor(source, key);
   // JSON omits inherited/non-enumerable fields and may invoke getters differently.
   if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) {
      throw new Error('Invalid readiness property');
   }
   return property.value;
}

function boolean(value: unknown): boolean {
   if (typeof value !== 'boolean') throw new Error('Invalid readiness boolean');
   return value;
}

function timestamp(value: unknown): string {
   if (typeof value !== 'string') throw new Error('Invalid readiness timestamp');
   const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
   if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !==
      `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`) {
      throw new Error('Invalid readiness timestamp');
   }
   return value;
}

function freezeObservation(
   observation: Observation<PublicReadinessObservationV01>,
): Observation<PublicReadinessObservationV01> {
   if (observation.data !== null) {
      Object.freeze(observation.data.checks);
      Object.freeze(observation.data);
   }
   return Object.freeze(observation);
}

function emptyObservation(
   availability: 'unavailable' | 'not_yet_sampled',
): Observation<PublicReadinessObservationV01> {
   return { availability, observedAt: null, lastCollectionFailureAt: null, data: null };
}
