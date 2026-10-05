// Frozen JSON contract: docs/OBSERVATORY_V0_SPEC.md, sections 5–7.
export type IsoUtc = string;
export type Count = number; // nonnegative safe integer
export type Bytes = number; // nonnegative safe integer
export type Milliseconds = number; // finite, nonnegative
export type Round = number; // nonnegative safe integer

export type Availability =
   | 'available'
   | 'unavailable'
   | 'not_yet_sampled'
   | 'instrumentation_disabled'
   | 'collection_failed';

export interface Observation<T> {
   availability: Availability;
   observedAt: IsoUtc | null;
   lastCollectionFailureAt: IsoUtc | null;
   data: T | null;
}

export interface ObservatoryRuntimeV01 {
   schemaVersion: 'observatory-runtime-v0.1';
   observedAt: IsoUtc;
   runtime: {
      network: 'testnet' | 'mainnet';
      assetId: string;
      economicsMetricsEnabled: boolean;
      processEpoch: string | null;
      processMonotonicMs: Milliseconds | null;
      deployedCommit: string | null;
   };
   workers: {
      poller: Observation<WorkerObservationV01>;
      reconciler: Observation<WorkerObservationV01>;
   };
   indexer: {
      dispatcher: Observation<DispatcherObservationV01>;
      observedRound: Observation<{ round: Round }>;
   };
   pollCycle: Observation<PollCycleObservationV01>;
   readiness: Observation<PublicReadinessObservationV01>;
   capacity: Observation<CapacityObservationV01>;
   resources: Observation<ResourceObservationV01>;
}

export interface WorkerObservationV01 {
   started: boolean;
   running: boolean;
   ready: boolean;
   cycleNotStalled: boolean;
   providerHealth: 'unknown' | 'healthy' | 'unhealthy';
   consecutiveFailures: Count;
   lastCycleStartedAt: IsoUtc | null;
   lastProgressAt: IsoUtc | null;
   lastProviderEvidenceAt: IsoUtc | null;
   lastErrorAt: IsoUtc | null;
}

export interface DispatcherObservationV01 {
   queued: Count;
   inFlight: Count;
   requests: {
      activation: Count;
      reconciliation: Count;
      'absence-proof': Count;
      'scan-page': Count;
      checkpoint: Count;
      health: Count;
   };
   successes: Count;
   failures: Count;
   timeouts: Count;
}

export interface PollCycleObservationV01 {
   durationMs: Milliseconds;
   attempted: Count;
   progressed: Count;
   failed: Count;
}

export interface PublicReadinessObservationV01 {
   ready: boolean;
   checks:
      | {
           storage: boolean;
           poller: boolean;
           reconciler: boolean;
           backgroundWorkers: boolean;
           diskHeadroom: boolean;
        }
      | { readinessCheck: false };
}

export interface CapacityObservationV01 {
   sampledAt: IsoUtc;
   unfinishedWatches: Count;
   activeWatches: Count;
   settlementPendingWatches: Count;
   unresolvedSettlementUnknownWatches: Count;
   activeWatchesMissingScanBaseline: Count;
   watchesPastDeadlineAwaitingCoverage: Count;
   oldestActiveWatchAgeMs: Milliseconds | null;
   scanLagRounds: {
      samples: Count;
      p50: Round;
      p95: Round;
      max: Round;
   } | null;
   observedIndexerRound: Round | null;
   observedIndexerRoundAt: IsoUtc | null;
}

export interface ResourceObservationV01 {
   sampledAt: IsoUtc;
   rssBytes: Bytes;
   heapUsedBytes: Bytes;
   heapTotalBytes: Bytes;
   externalBytes: Bytes;
   cpu: {
      userMicros: Count;
      systemMicros: Count;
      elapsedMs: Milliseconds;
   } | null;
   sqliteBytes: Bytes | null;
   walBytes: Bytes | null;
}
