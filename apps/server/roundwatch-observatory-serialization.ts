import type { ObservatoryRuntimeV01 } from './roundwatch-observatory-types.js';

// A fixed transport allowlist, not a collector or a second snapshot builder.
// Traverse schema keys only: raw extras, accessors and toJSON hooks are never read.
type Scalar = string | number | boolean | null;
type Json = Scalar | { [key: string]: Json };
type Codec = (value: unknown) => Json;
type Shape = { [key: string]: Codec };
const invalid = (): never => { throw new Error('Invalid Observatory DTO'); };
const boolean: Codec = value => typeof value === 'boolean' ? value : invalid();
const count: Codec = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid();
const milliseconds: Codec = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
const nullable = (codec: Codec): Codec => value => value === null ? null : codec(value);
const enumeration = (...values: Scalar[]): Codec => value => values.includes(value as Scalar) ? value as Scalar : invalid();
const text = (pattern: RegExp, maximum: number): Codec => value =>
   typeof value === 'string' && value.length <= maximum && pattern.test(value) ? value : invalid();
const isoUtc: Codec = value => {
   if (typeof value !== 'string' || value.length > 40) return invalid();
   const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
   if (!match) return invalid();
   const parsed = new Date(value);
   if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !==
      `${match[1]}.${(match[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`) return invalid();
   return value;
};

function field(value: unknown, key: string): unknown {
   if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
   const descriptor = Object.getOwnPropertyDescriptor(value, key);
   if (!descriptor || !Object.hasOwn(descriptor, 'value')) return invalid();
   return descriptor.value;
}

function object(shape: Shape): Codec {
   const entries = Object.entries(shape); // Fixed schema work, once at module initialization.
   return value => {
      const result: { [key: string]: Json } = Object.create(null);
      for (const [key, codec] of entries) result[key] = codec(field(value, key));
      return result;
   };
}

function observation(data: Codec, sampled = false): Codec {
   const encode = object({
      availability: enumeration('available', 'unavailable', 'not_yet_sampled', 'instrumentation_disabled', 'collection_failed'),
      observedAt: nullable(isoUtc), lastCollectionFailureAt: nullable(isoUtc), data: nullable(data),
   });
   return value => {
      const result = encode(value) as { [key: string]: Json };
      const present = result.data !== null;
      if (present !== (result.observedAt !== null)) return invalid();
      if (result.availability === 'available' && !present) return invalid();
      if (result.availability === 'collection_failed') {
         if (result.lastCollectionFailureAt === null) return invalid();
      } else if (result.availability !== 'available' && present) return invalid();
      if (sampled && present && (result.data as { [key: string]: Json }).sampledAt !== result.observedAt) return invalid();
      return result;
   };
}

const worker = observation(object({
   started: boolean, running: boolean, ready: boolean, cycleNotStalled: boolean,
   providerHealth: enumeration('unknown', 'healthy', 'unhealthy'), consecutiveFailures: count,
   lastCycleStartedAt: nullable(isoUtc), lastProgressAt: nullable(isoUtc),
   lastProviderEvidenceAt: nullable(isoUtc), lastErrorAt: nullable(isoUtc),
}));
const normalReadinessChecks = object({
   storage: boolean, poller: boolean, reconciler: boolean, backgroundWorkers: boolean, diskHeadroom: boolean,
});
const exceptionReadinessChecks = object({ readinessCheck: enumeration(false) });
const readiness: Codec = value => {
   const ready = boolean(field(value, 'ready'));
   const checks = field(value, 'checks');
   // The only two contract variants; never copy arbitrary readiness labels.
   if (checks !== null && typeof checks === 'object' && Object.hasOwn(checks, 'readinessCheck')) {
      if (ready !== false || ['storage', 'poller', 'reconciler', 'backgroundWorkers', 'diskHeadroom']
         .some(key => Object.hasOwn(checks, key))) return invalid();
      return { ready, checks: exceptionReadinessChecks(checks) };
   }
   return { ready, checks: normalReadinessChecks(checks) };
};
const runtime = object({
   schemaVersion: enumeration('observatory-runtime-v0.1'), observedAt: isoUtc,
   runtime: object({
      network: enumeration('testnet', 'mainnet'), assetId: text(/^(?:0|[1-9]\d*)$/, 20),
      economicsMetricsEnabled: boolean, processEpoch: nullable(text(/^[\s\S]*$/, 128)),
      processMonotonicMs: nullable(milliseconds), deployedCommit: nullable(text(/^[0-9a-fA-F]{40}$/, 40)),
   }),
   workers: object({ poller: worker, reconciler: worker }),
   indexer: object({
      dispatcher: observation(object({
         queued: count, inFlight: count,
         requests: object({ activation: count, reconciliation: count, 'absence-proof': count, 'scan-page': count, checkpoint: count, health: count }),
         successes: count, failures: count, timeouts: count,
      })),
      observedRound: observation(object({ round: count })),
   }),
   pollCycle: observation(object({ durationMs: milliseconds, attempted: count, progressed: count, failed: count })),
   readiness: observation(readiness),
   capacity: observation(object({
      sampledAt: isoUtc, unfinishedWatches: count, activeWatches: count,
      settlementPendingWatches: count, unresolvedSettlementUnknownWatches: count,
      activeWatchesMissingScanBaseline: count, watchesPastDeadlineAwaitingCoverage: count,
      oldestActiveWatchAgeMs: nullable(milliseconds),
      scanLagRounds: nullable(object({ samples: count, p50: count, p95: count, max: count })),
      observedIndexerRound: nullable(count), observedIndexerRoundAt: nullable(isoUtc),
   }), true),
   resources: observation(object({
      sampledAt: isoUtc, rssBytes: count, heapUsedBytes: count, heapTotalBytes: count, externalBytes: count,
      cpu: nullable(object({ userMicros: count, systemMicros: count, elapsedMs: milliseconds })),
      sqliteBytes: nullable(count), walBytes: nullable(count),
   }), true),
});

/** Preserve every approved scalar and null verbatim; never stringify raw state. */
export function serializeObservatoryRuntime(snapshot: ObservatoryRuntimeV01): string {
   return JSON.stringify(runtime(snapshot));
}
