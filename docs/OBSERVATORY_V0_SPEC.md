# RoundWatch Observatory v0.1 specification

Status: proposed compatibility contract; specification only. Written 2026-10-03 against audited `main@6112aa983d1a139851d357055175149f16945495`.

Authoritative telemetry reference: [Observatory telemetry inventory, 2026-10-02](OBSERVATORY_TELEMETRY_INVENTORY_2026-10-02.md). The audited SHA identifies inspected source, not the running Render deployment. Production values, instrumentation settings, and deployed commit have not been verified for this specification. No implementation, new collector, endpoint, or UI is delivered here.

## 1. Purpose

RoundWatch Observatory v0.1 is an internal, single-operator, read-only operational dashboard. Its first UI is a separate section/tab inside the existing FlowHUD application. It shows aggregate runtime observations with their provenance, availability, and age so the operator can distinguish worker condition, request activity, and sampled durable obligations.

```text
RoundWatch runtime
        |
        v
passively retained observations + existing cheap memory snapshots
        |
        v
versioned Observatory runtime snapshot
        |
        v
read-only internal endpoint
        |
        v
server-side FlowHUD proxy
        |
        v
FlowHUD Observatory UI
```

The governing invariant is: **Observatory observes RoundWatch. Observatory must not cause RoundWatch to perform operational work in order to be observed.** Existing MainNet and TestNet behavior, settlement safety, worker scheduling, and durable watch state remain the baseline.

## 2. Non-goals

This is not a separate public product, customer dashboard, Grafana replacement, log explorer, administrative control plane, or new observability database. It does not establish an SLA, throughput guarantee, watch TTL, quota, pricing policy, payment revenue estimate, or an assurance that the next paid admission will succeed. It does not turn the existing offline Bazaar importer in `apps/observatory` into a runtime telemetry collector.

## 3. Architectural invariants

One read is a bounded read of already-retained state and resolved safe configuration, plus clock reads, fixed-size mapping, validation, and serialization. Work and payload size must be independent of watch/customer/request count. No watch enumeration, SQL, network call, file access, subprocess, log parsing, queue traversal, or provider refresh is allowed. Visual freshness thresholds and labels belong to the consumer, not the server DTO.

Repeated Observatory reads must cause:

> Zero Indexer requests, zero facilitator requests, zero polling/reconciliation work, zero capacity SQLite scans, zero readiness probes, zero filesystem sampling, and zero sampler-baseline mutation.

They must also cause zero admission/token-bucket mutation, zero fingerprint generation, and zero operational logs merely because the dashboard was read. This applies to the full composed endpoint/proxy lifecycle, including successful responses, authentication rejections, and error responses. The eventual route must bypass or otherwise avoid ordinary request telemetry/log emission, fingerprints, mutable admission/token-bucket gates, paid readiness, and operational middleware that performs work. Wrapping a pure getter in any of these still violates the invariant. Authentication/transport may be designed later, but must preserve this boundary. Reading an unavailable or old observation never refreshes its producer.

Observatory v0.1 delivery must be uncached end-to-end. The eventual RoundWatch endpoint and FlowHUD server-side proxy must use semantics equivalent to `Cache-Control: no-store`; origin, proxy and browser caches must not store or replay responses. This does not prohibit the consumer retaining its last compatible snapshot for explicitly aged fallback display. Preserved timestamps alone cannot account for unknown proxy-cache residence. A new response receipt must not reset the age of an unchanged retained observation, and transport must not replace original provenance with receipt time.

| Existing primitive | Observatory read policy and reason |
|---|---|
| Poller/reconciler `healthSnapshot()` | Allowed: bounded memory/clock reads; derived health may change with age without mutating the tracker. |
| Dispatcher `snapshot()` | Allowed: current gauges and fixed six-purpose counters; no token refill. Map only allowlisted fields. |
| **Poller** `capacitySnapshot()` | Allowed: its name is misleading for acquisition cost; it reads retained cycle fields and cached tip/time only. |
| **Store** `store.capacitySnapshot()` | Forbidden on reads: synchronous durable aggregate/active-row SELECTs and lag sorting, O(N + A log A), not cached. Use a previously retained scheduled result. |
| Runtime sampler `sample()` | Forbidden: CPU/elapsed baseline mutation, memory observation, filesystem stats, and production capacity callback/SQL. |
| `/ready` computation / `currentReadinessSnapshot()` / store `readinessCheck()` | Forbidden: due SQLite write/rollback probe and cache mutation, filesystem headroom check, and blocked-readiness logging. A cached branch does not make the callable a safe primitive. |
| Strict paid-readiness path | Forbidden: local probes, filesystem checks, shared capability refresh/Indexer traffic, and evidence/generation checks. |
| Probe `runIfDue()` | Forbidden even when it might reuse a sample: can start provider work and mutate evidence/counters. |
| Poller `runOnce()` / reconciler `reconcileOnce()` | Forbidden: execute operational work and durable/provider activity. |
| Mutable gate snapshots, including `SignedPaymentGate.snapshot()` | Forbidden: refill tokens and advance refill state; never expose private gate objects. |
| Terminal instrumentation `finishWatch()` | Forbidden: removes instrumentation state; terminal wrappers emit logs. It is not a read accessor. |

The snapshot is a versioned projection, not an export of internal objects. Retention publishes only complete, immutable, fixed allowlisted observations; readers cannot see a partially updated sample or cycle. No raw internal object spread is the contract. All new passive retention/projection hooks must be locally failure-isolated: a telemetry exception must never mark worker failure, invalidate provider evidence, alter readiness, fail a watch turn, affect settlement/admission, or change operational control flow. Preserve the previous complete record on failure and record bounded failure metadata only where safely distinguishable. Separate sections are not a globally atomic health/database transaction: direct memory reads and older samples have different observation times.

## 4. Source model

The following source links refer to the audited checkout; the inventory supplies full acquisition-cost and call-site analysis.

| Source | Existing state and acquisition | v0.1 treatment |
|---|---|---|
| [Boot wiring](../apps/server/index.ts), [network config](../apps/server/network-config.ts) | Resolved network, ASA, instrumentation boolean and intervals exist in boot/config memory. No process epoch, monotonic snapshot observation field, or deployed SHA telemetry exists. | Explicit safe scalar projection; new identity/clock/deployment wiring as described below. |
| [Worker health](../apps/server/roundwatch-worker-health.ts), [poller](../apps/server/roundwatch-poller.ts), [reconciler](../apps/server/roundwatch-reconciler.ts) | Separate bounded health snapshots; optional event timestamps; health state is process-local. | Direct observation; do not execute workers. |
| [Dispatcher](../apps/server/roundwatch-scheduler.ts) | Memory gauges, purpose starts, overall outcomes since object creation. | Direct snapshot with fixed purpose keys. |
| Poller `capacitySnapshot()` | Latest normal `runOnce` outcome and cached sweep-tip round/time; no completion timestamp for the cycle. | Memory projection; cycle completion timestamp requires passive wiring. |
| [Store capacity](../apps/server/roundwatch-store.ts) | Counts/ages/lag derived on demand from SQLite. | Only a completed, previously retained scheduled sample. |
| [Runtime sampler](../apps/server/roundwatch-runtime-metrics.ts) | Optional immediate/start and periodic sample, default 60 s; returns/logs results, does not retain latest. Production callback includes capacity; failed acquisition can advance elapsed and CPU baselines at different points. | Retain an immutable, fixed, allowlisted projection at the existing scheduled acquisition boundary, with CPU only when baseline pairing is verified. Distinguish acquisition/projection failure from subsequent logging failure; never sample on dashboard reads. |
| [Public readiness route](../apps/server/app.ts), boot composition, [disk check](../apps/server/roundwatch-readiness.ts) | Complete readiness result computed on ordinary `/ready` use; no retained complete result/time. | Unavailable until the complete existing-path result is passively retained. |
| [Paid readiness](../apps/server/roundwatch-paid-readiness.ts), [shared probe](../apps/server/roundwatch-health-probe.ts) | Separate admission decision; private probe samples with monotonic times. | Not a v0.1 readiness data source; never trigger the decision or probe. |
| [HTTP telemetry](../apps/server/request-telemetry.ts), [economics metrics](../apps/server/roundwatch-metrics.ts), [MCP](../apps/server/mcp.ts) | Mostly emitted events; optional `freeWork` has narrow coverage; no complete external activity aggregation or event buffer. | Deferred. |

**Verification findings and ambiguities:** inventory/source review establishes the source mappings and acquisition costs. Red-team corrections below refine timestamp, sampling-failure, retention and delivery semantics; the proposed guards are not implemented. Two discrepancies already identified by the inventory remain: the worker type comment calls `consecutiveFailures` probe-only, while the getter returns the maximum of probe and systemic-cycle streaks; `docs/OPERATIONS.md` describes older 45 s/15 s readiness timings, while current boot/shared-probe defaults yield 180 s worker evidence freshness and a separate 30 s paid maximum age. This spec preserves worker implementation semantics and recommends later correction of that prose/comment outside this task.

Other naming gaps are handled explicitly: the two `capacitySnapshot()` methods have different costs; cached round is not fresh chain head; a cycle completion timestamp, `processEpoch`, and `runtime.processMonotonicMs` do not exist. Source sampler CPU deltas and generic elapsed time alone do not prove paired baselines after failure. FlowHUD location, endpoint route, transport/auth mechanism, and deployment metadata source are later implementation/design decisions. None permits guessing data or relaxing the read invariant.

## 5. Observatory DTO contract

All types below are proposed, not implemented. All listed JSON keys are required; nullable values are serialized as `null`, not omitted. The fixed discriminator is unrelated to package, MCP, or Bazaar report versions. Additive fields require deliberate compatibility review; changing meanings, units, keys, or nullability requires a new schema version. Consumers tolerate unknown fields but reject unsupported schema versions, preserving their last compatible snapshot.

```ts
type IsoUtc = string; // validated ISO 8601 UTC epoch timestamp
type Count = number;  // nonnegative safe integer
type Bytes = number;  // nonnegative safe integer
type Milliseconds = number; // finite, nonnegative; may be fractional
type Round = number; // nonnegative safe integer

type Availability =
  | 'available'
  | 'unavailable'
  | 'not_yet_sampled'
  | 'instrumentation_disabled'
  | 'collection_failed';

interface Observation<T> {
  availability: Availability;
  observedAt: IsoUtc | null; // ORIGINAL observation time, not read time
  lastCollectionFailureAt: IsoUtc | null; // known producer failure only
  data: T | null;
}

interface ObservatoryRuntimeV01 {
  schemaVersion: 'observatory-runtime-v0.1';
  observedAt: IsoUtc; // DTO assembly time, not every section's sample time
  runtime: {
    network: 'testnet' | 'mainnet';
    assetId: string; // canonical decimal ASA ID from resolved config
    economicsMetricsEnabled: boolean;
    processEpoch: string | null; // opaque process/counter-lifetime token
    processMonotonicMs: Milliseconds | null; // assembly observation clock; epoch-scoped
    deployedCommit: string | null; // verified full Git commit SHA, if wired
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

interface WorkerObservationV01 {
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

interface DispatcherObservationV01 {
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

interface PollCycleObservationV01 {
  durationMs: Milliseconds;
  attempted: Count;
  progressed: Count;
  failed: Count;
}

interface PublicReadinessObservationV01 {
  ready: boolean;
  checks:
    | {
        storage: boolean;
        poller: boolean;
        reconciler: boolean;
        backgroundWorkers: boolean;
        diskHeadroom: boolean;
      }
    | { readinessCheck: false }; // complete /ready exception outcome
}

interface CapacityObservationV01 {
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
  // Exact cached-tip provenance used for THIS sample's lag calculation:
  observedIndexerRound: Round | null;
  observedIndexerRoundAt: IsoUtc | null;
}

interface ResourceObservationV01 {
  sampledAt: IsoUtc;
  rssBytes: Bytes;
  heapUsedBytes: Bytes;
  heapTotalBytes: Bytes;
  externalBytes: Bytes;
  cpu: {
    userMicros: Count;
    systemMicros: Count;
    elapsedMs: Milliseconds; // valid elapsed duration from the paired CPU baseline
  } | null;
  sqliteBytes: Bytes | null;
  walBytes: Bytes | null;
}
```

`Observation<T>` is constrained by the rules in section 7; it does not authorize arbitrary combinations. Capacity/resource `sampledAt` must equal their envelope `observedAt`. Their duplication makes the original sample provenance explicit. Cached round uses its existing poller observation time. Poll cycle uses a new passively retained completion time. Worker event times map valid existing `...AtMs` epoch values to ISO UTC; absent values map to null. No monotonic probe time is converted to an epoch timestamp by assumption.

Capacity includes the cached round/time used at sampling, rather than borrowing a newer `indexer.observedRound` during serialization. This small provenance addition prevents old lag values from appearing based on a new tip. No dispatcher wrapper copy, `freeWork`, per-watch map, status map, metric-entry count, or cache/session structure is retained or copied from the sampler into the Observatory record. `resources.cpu=null` is a complete valid projection when CPU interval pairing is unknown; it does not make the other resource fields unavailable. Generic sampler `elapsedMs` is not exposed as a CPU denominator. There is no server DTO `freshness` or `staleAfterMs` field.

## 6. Field semantics

### Runtime and observation metadata

| Field/group | Unit, source, availability today | Lifetime/restart, freshness, interpretation limits |
|---|---|---|
| `schemaVersion` | Fixed string; new DTO constant. | Contract identity; stable across process restarts. Not application/deployment version. |
| Top-level `observedAt` | ISO UTC; comparison wall clock captured during DTO assembly, after direct source observations where practical. | Human/provenance and display-age reference only, never the denominator for reliable rates. Does not refresh older observations or prove external service reachability. |
| `runtime.network` | Network enum; `networkConfig.name`, exists. | Startup configuration, reconstructed at restart. Do not hardcode MainNet for all deployments; local default is TestNet. |
| `runtime.assetId` | Decimal ASA string; `networkConfig.usdcAssetId`, exists. | Startup configuration; MainNet baseline Circle USDC is `31566704`. Not a payment identity, amount, or ticker-based inference. |
| `runtime.economicsMetricsEnabled` | Boolean; boot `economicsInstrumentationEnabled`, exists. | Startup configuration, true only when resolved economics instrumentation is enabled. HTTP JSON telemetry is independently wired; this flag does not describe complete traffic collection. |
| `runtime.processEpoch` | Opaque string/null; absent today, required new boot/counter wiring. | New token for each process/counter lifetime; never reused after restart/reset. Null means reliable rates unavailable, not a shared epoch. Not PID, worker generation, uptime, or durable restart count. |
| `runtime.processMonotonicMs` | Finite nonnegative process-monotonic ms/null; new DTO assembly clock observation, for example `performance.now()`. | Capture adjacent to the direct dispatcher read within the same synchronous assembly, with no asynchronous operational work between them. Valid for deltas only within the same non-null `processEpoch`; resets naturally on process restart. Null until clock/epoch wiring is reliable; when epoch is null this field is null. Not an epoch timestamp, retained-sample refresh, CPU interval, or date. |
| `runtime.deployedCommit` | Full verified SHA/null; absent today, future deployment wiring. | Captured from reliably supplied metadata for the running build, reconstructed at deployment/restart. Missing/unreliable metadata stays null. Never use audited checkout SHA, package version, local Git, or a Render API call from the read path. |
| Observation metadata | Availability enum, original ISO time, optional failure ISO time; new projection/retention metadata. | Direct memory observation time is its actual read; latest samples keep producer time. Failure time is a producer/retention failure observation, not last HTTP/proxy failure or log-emission failure. No raw error text or UI age budget. Exact rules in section 7. |

### Worker health: both workers independently

All worker fields exist in the bounded getter. The DTO projection is new. State is instantaneous/process-local and resets with a newly constructed worker/process; events are latest-event timestamps, not history. In-process start/stop has narrower reset behavior described below. The envelope timestamps the getter observation, not every underlying event.

| Field | Unit/source mapping | Exact meaning and exclusions |
|---|---|---|
| `started` | Boolean; same source key. | Scheduled lifecycle started. Does not prove the worker is currently busy or healthy. |
| `running` | Boolean; same source key. | Scheduled cycle is executing, including subsequent capability-probe await. Not a progress flag. |
| `ready` | Boolean; same source key. | Started AND fresh provider evidence AND cycle not stalled AND provider health healthy. Worker observation readiness only. |
| `cycleNotStalled` | Boolean; same source key. | Idle yields true; while running, most recent valid current-cycle heartbeat/start must be within the configured silence threshold. Idle true does not prove provider health. |
| `providerHealth` | Enum; same source key. | Worker view of configured Indexer capability routes. Full successful probe establishes/recovers healthy. Systemic cycle failure immediately makes unhealthy; once healthy, first failed full probe is tolerated, second makes unhealthy. Stale healthy evidence reads as unknown. Not facilitator health or chain-wide availability. |
| `consecutiveFailures` | Count; same source key. | `max(consecutiveProbeFailures, consecutiveCycleFailures)`, not sum, lifetime errors, provider HTTP failures, or probe-only count. Full successful probe resets both; ordinary customer progress does not. |
| `lastCycleStartedAt` | ISO/null from `lastCycleStartedAtMs`. | Latest scheduled cycle start; absent before a cycle. Not cycle completion or the identity of the retained poll outcome. |
| `lastProgressAt` | ISO/null from `lastProgressAtMs`. | Successful servicing-turn callback/heartbeat, including no-op/evidence-only turns; failed turns do not heartbeat. Not a payment match or proof of coverage advance. |
| `lastProviderEvidenceAt` | ISO/null from `lastProviderEvidenceAtMs`. | Full healthy probe, or cycle evidence refresh while already healthy and without systemic failure. Not necessarily last full probe; cached/no-op work does not establish recovery. |
| `lastErrorAt` | ISO/null from `lastErrorAtMs`. | Failed probe/cycle or completion containing failed turns. Isolated terminal-watch errors can set it without making readiness false. Not an incident count. |

Worker evidence/stall threshold is `max(workerIntervalMs * 3, sharedProbe.readinessFreshnessMilliseconds())`. Shared probe freshness is `max(45_000, ceil(idleProbeIntervalMs * 1.5))`; current boot defaults yield 180 s, with 15 s active and 120 s idle probing. Use resolved policy, not an assumed deployment override or the older 45 s prose. This health threshold is separate from consumer display freshness and strict paid evidence policy; it is not an intrinsic sweep-tip freshness guarantee. Observatory does not rewrite `ready`, `providerHealth`, or other worker booleans because of new clock/age logic. Future-looking worker event timestamps may warrant a consumer clock-skew warning while those booleans preserve the existing getter semantics.

Start resets evidence/progress, provider state, and failure streaks; stop clears started/running and provider evidence/state. Last start/error timestamps are not necessarily cleared by in-process stop/start. Worker generation increments on lifecycle changes but is intentionally omitted: it is not process epoch or restart count.

### Indexer and dispatcher

| Field/group | Unit/source, exists today | Lifetime/restart/freshness and exclusions |
|---|---|---|
| `dispatcher.queued` | Logical operations, `queue.length` via snapshot. | Instantaneous process-local gauge. Submitted requests waiting for dispatch; not watch backlog, active-watch count, or unscheduled work. |
| `dispatcher.inFlight` | Logical operations; snapshot field. | Instantaneous process-local gauge; incremented at start, decremented in `finally`. Can briefly include an operation whose outcome was already counted. |
| `dispatcher.requests.*` | Started operations per exact purpose, snapshot `requests`. | Cumulative since dispatcher creation, resets with it/process. Incremented at dispatch/start, not enqueue/completion. Normalize absent **known** keys to zero: this is a verified no-starts counter, not unavailable data. No unknown keys exported. |
| `successes` | Resolved dispatched operations, snapshot field. | Process/object cumulative; allowed exact-lookup 404 can resolve successfully. Not HTTP 2xx-only, matched watches, or service payments. |
| `failures` | Rejected dispatched operations, snapshot field. | Process/object cumulative, includes transport, parse/semantic failures and timeouts. Malformed HTTP 200 can fail. Not bare HTTP status totals. |
| `timeouts` | Timeout-classified rejected operations, snapshot field. | Process/object cumulative; `AbortError`/`TimeoutError` classification. **Subset of failures**, not an extra outcome to add to completed totals. |
| `indexer.observedRound.data.round` | Rounds; poller `currentIndexerRound`. | Latest successful sweep-tip observation, process-local; absent before any observation, possibly idle indefinitely. Not guaranteed current chain head, last capability probe round, or an inferred rounds-to-seconds ETA. |
| `indexer.observedRound.observedAt` | ISO/null; poller `currentIndexerRoundObservedAt`. | Original tip observation time, not dashboard time. Can stay old through continued pagination; tip/time survive worker stop/start within the process and disappear on new process/object. |

Dispatcher ISO observation time is the direct getter time for human/provenance display. Its cumulative counters use the adjacent assembly `runtime.processMonotonicMs` for reliable rate intervals, as specified in section 8; v0.1 has no other cumulative rate source. Started totals include probes and customer work; starts need not exactly equal outcomes plus in-flight at every synchronous bookkeeping boundary. Completed total is `successes + failures`, never `successes + failures + timeouts`.

| Purpose key | Exact scope of started-operation counter |
|---|---|
| `activation` | Post-settlement exact service-transfer lookup for activation; excludes facilitator settlement calls. |
| `reconciliation` | Exact service transaction/current-round recovery checks AND synthetic capability lookup; not recovered-watch count. |
| `absence-proof` | Historical txid absence-search pages from reconciliation AND synthetic probe; success is not completed absence proof. |
| `scan-page` | Physical dispatched watch-search page operations AND representative synthetic capability scan; logical shared/cache page consumption is different. |
| `checkpoint` | Post-deadline tip and block requests AND probe block request; one closing checkpoint may dispatch multiple operations. |
| `health` | Shared poller sweep-tip and capability-probe tip requests; excludes incoming `/health` and `/ready` HTTP requests. Not pure health-probe traffic. |

There is no reliable probe/customer, foreground/background, payer, or provider-status separation in these totals. Do not subtract supposed readiness traffic using purpose names.

### Latest poll cycle

Fields below already exist in the poller's memory snapshot, independent of optional economics instrumentation. They are replaced together at normal `runOnce` completion, including a completed empty cycle. Outer failure before `finishCapacityCycle` leaves the prior values. They reset on process/new poller construction, not necessarily on worker stop/start.

| Field | Unit/source mapping | Meaning and exclusions |
|---|---|---|
| `durationMs` | Finite nonnegative ms; `lastCycleDurationMs`. | Latest completed `runOnce` duration measured with `performance.now()`, including candidate SQLite reads, queue waits, provider and servicing work. Excludes timer interval and subsequent scheduled capability-probe work. Not full scheduled tick latency or an SLA. |
| `attempted` | Turns; `watchesAttemptedLastCycle`. | Due active candidates visited. Not active fleet size, Indexer requests, or lifetime attempts. |
| `progressed` | Turns; `watchesSucceededLastCycle`. | `kind='progressed'`, including cursor advance or match. **Progressed is not matched.** |
| `failed` | Turns; `watchesFailedLastCycle`. | Caught turn failures, including isolated permanent failures. Not necessarily systemic worker health failures. |
| Envelope `observedAt` | ISO completion time; **missing today**. | Required passive timestamp at the same normal finish that publishes these fields. Never infer from worker start/heartbeat or DTO read time. |

`attempted` may exceed `progressed + failed`: residual turns combine no-op and evidence-only outcomes, which cannot be separated from current retained values. Until `lastCycleDurationMs` exists, initialized zero counts are not evidence of a completed empty cycle. Without completion-time wiring, publish this section as unavailable, not as a falsely fresh cycle. Once wired but before first completion, use not-yet-sampled. No new cycle counter/history or reconciler-cycle duration is included.

### Public readiness

The section is initially unavailable: no complete retained result/time exists today. Future passive wiring records only the complete outcome already produced by the ordinary production `/ready` path. It must not issue `/ready` requests, invoke the readiness callback, or schedule new readiness work for Observatory.

Once retention is wired, readiness may remain `not_yet_sampled` indefinitely in a deployment where nothing invokes the ordinary public readiness path. Worker cycles and strict paid-admission checks do not substitute for it. This is an accepted v0.1 state: the UI must explain the missing ordinary observation rather than manufacture health. No Observatory readiness timer, probe, or fallback is permitted.

| Field/group | Unit/source and future wiring | Meaning, lifetime, exclusions |
|---|---|---|
| `readiness.observedAt` | ISO UTC, captured when the existing readiness outcome completes. | Latest observation, process-local retention cleared on restart. Not an Observatory read timestamp. |
| `data.ready` | Boolean; existing complete public result, or false on the existing route's exception outcome. | Historical public service readiness at that observation. Not a live paid-admission authorization. |
| `checks.storage` | Boolean; existing SQLite write/rollback readiness result. | Storage check as consumed by that public result, possibly using its own 2 s cache. Does not imply a new probe at `observedAt`. |
| `checks.poller`, `checks.reconciler` | Booleans; worker `.ready` in existing composition. | Worker readiness consumed then, not necessarily equal to a later worker snapshot. |
| `checks.backgroundWorkers` | Boolean; conjunction of those two worker checks. | No additional independent health test. |
| `checks.diskHeadroom` | Boolean; existing filesystem threshold check. | Threshold outcome, not exact disk-free bytes or a new Observatory measurement. |
| `checks.readinessCheck: false` | Fixed false; existing route exception response. | Complete failure outcome when normal checks could not be composed. Do not invent missing subchecks or export exception detail. |

Retaining the route's complete exception outcome is an **available observed false readiness result**, not a telemetry collection failure. A retention/collection failure itself is separate metadata and preserves the last successful retained observation. A fallback storage-only result from non-production app wiring is not the complete production contract: leave unavailable rather than projecting absent worker/disk checks as true.

Three concepts remain separate in labeling and interpretation: public service readiness here; worker observation readiness under `workers`; strict paid-admission readiness, absent from this DTO. Strict paid admission uses local state, generation rechecks, failure-epoch validity, and 30 s default capability evidence maximum age. Public hysteresis/freshness differs. No top-level combined health/ready badge may silently collapse them.

### Capacity: retained scheduled sample only

All counts use existing store semantics; current computation is O(N + A log A), with O(A) memory, and cannot be an endpoint getter. A completed scheduled sample is durable-derived latest-sample data; the retention object itself is process-local and clears on restart. With the same database the next sample reflects surviving rows; it is not a persisted counter. Restore, retention, terminal transitions, or remediation can change counts.

| Field | Unit/source mapping | Meaning and exclusions |
|---|---|---|
| `sampledAt` | ISO UTC; future retained existing scheduled sampler's original `resources.sampledAt`. | Acquisition start time of the completed sample; store queries/ages are computed during it. Not a globally atomic database transaction or serialization time. |
| `unfinishedWatches` | Watches; same store field. | `settlement_pending` + `active` + nonterminal `settlement_unknown`. Not active-only, dispatcher queue, or paid customers. |
| `activeWatches` | Watches; same field. | Current sampled `state='active'` membership; not lifetime activations. |
| `settlementPendingWatches` | Watches; same field. | Prepared/pending-settlement membership; not evidence of money received. |
| `unresolvedSettlementUnknownWatches` | Watches; same field. | Unknown settlement with reconciliation terminal flag false. Excludes terminal unknowns; not every member is due or has serviceable legacy metadata. |
| `activeWatchesMissingScanBaseline` | Watches; same field. | Active rows with `scan_after_round IS NULL` only. Not a check of all evidence/proof/expiry metadata. |
| `watchesPastDeadlineAwaitingCoverage` | Watches; same field. | Active with finite passed deadline and missing closing round/cursor or cursor below closing checkpoint. Excludes pending/unknown. Not expired count or all overdue obligations. |
| `oldestActiveWatchAgeMs` | Ms/null; optional store field mapped to null. | Maximum zero-clamped age from valid `activated_at`, falling back to `created_at` when activation absent. Null when no valid active ages. Age continues across restarts in durable timestamps, but this retained value must not be advanced on reads. Not unresolved-settlement age. |
| `scanLagRounds` | Object/null; optional store distribution. | Null without supplied tip or valid active cursor samples. Not an empty all-zero success. |
| `scanLagRounds.samples` | Watches with valid sampled lag; same field. | Denominator for cross-watch distribution; does not include cursor-missing active watches. When distribution exists, strictly positive. |
| `scanLagRounds.p50`, `.p95`, `.max` | Rounds; same fields. | Per-row lag `max(0, min(tip, fixedClosingRound if present) - scanAfterRound)`, nearest-rank percentiles (`ceil(n*q)-1`) and max. Across watches in this sample, not over time; no seconds/ETA inference. Genuine observed zero lag is allowed. |
| `observedIndexerRound`, `observedIndexerRoundAt` | Round/ISO or paired nulls; cached poller tip/time captured for this scheduled sample. | New provenance projection, no new request. Keep together with capacity; current separate tip may be newer. Lag remains based on this original potentially stale tip. |

An empty completed database aggregate may correctly contain zero counts; absence of a sample may not. A recent capacity sample does not guarantee a recent tip. UI must show the lag input tip's age as well as capacity sample age, and label lag based on old evidence when that tip exceeds the consumer's independently chosen tip age threshold in section 11.

### Resources: retained completed runtime sample only

Raw memory/file-size values and CPU/elapsed measurements exist in the optional sampler; passive retention and verified CPU-interval projection do not. Only an immutable, fixed, allowlisted projection of a completed scheduled observation may feed this section. Memory/CPU observations are process-local; file sizes describe durable files as sampled. Retained availability/time resets on process restart, even if files survive. Null file sizes do not imply zero or storage failure; null CPU means no verified paired interval is available for that sample.

| Field | Unit/source | Meaning and exclusions |
|---|---|---|
| `sampledAt` | ISO UTC; `resources.sampledAt`. | Original sampler acquisition start timestamp, published only after sample completes; not DTO time. |
| `rssBytes` | Bytes; sampled process memory RSS. | Resident process memory; not machine/container utilization or peak RSS. |
| `heapUsedBytes`, `heapTotalBytes` | Bytes; sampled V8 heap. | Used/allocated heap gauges; not configured heap limit, total RSS, or peak heap. |
| `externalBytes` | Bytes; sampled native-bound memory. | Node/V8 external accounting; not additional independent machine memory to sum uncritically with RSS. |
| `cpu` | Nullable CPU interval; new verified projection of scheduled source measurements. | Present only when CPU deltas and elapsed duration share a known successfully paired baseline. After ambiguous/recovered acquisition failure it may be null while RSS, heap and file sizes remain available. Null is not zero CPU or by itself a whole-section collection failure. |
| `cpu.userMicros`, `cpu.systemMicros` | Microseconds; nonnegative CPU deltas from the paired interval. | Interval user/system CPU, not lifetime CPU or automatically quota-normalized percentage. Do not assume a generic sampler elapsed value validates these deltas. |
| `cpu.elapsedMs` | Finite nonnegative monotonic ms; elapsed duration from that same paired baseline. | The valid duration for this CPU interval only. Not guaranteed exactly 60 s, a wall-clock difference, the time since the last published sample, or the time between dashboard polls. |
| `sqliteBytes`, `walBytes` | Bytes/null; optional filesystem lengths mapped to null. | Missing stat or in-memory database yields null; source does not distinguish those reasons. Not live row payload, free disk, WAL work backlog, checkpoint health, or database readiness. |

Optional downstream process CPU usage is `100 * (cpu.userMicros + cpu.systemMicros) / (cpu.elapsedMs * 1000)`, only when `cpu` is non-null and its own elapsed duration is positive; otherwise usage is unavailable. This is core-equivalent process usage and may exceed 100%; container utilization requires quota data absent from v0.1. It describes only the verified retained CPU interval.

The existing sampler advances its monotonic elapsed baseline before reading CPU, and advances its CPU baseline separately afterward. An early failure can advance neither baseline or only the elapsed baseline; a later failure can advance both before publication fails. Thus the next successful acquisition is not automatically a valid CPU interval, nor necessarily measured since the preceding invocation or publication. Future passive wiring must establish pairing at the existing acquisition boundary and publish CPU only when that pairing is known. On ambiguous recovery, publish `cpu=null` until an existing scheduled acquisition establishes a usable pair; memory/file-size/capacity projection may still succeed. Do not reconstruct missing CPU intervals from ISO or DTO clocks, retain raw deltas as if paired, take repair samples, or add dashboard-driven sampling.

## 7. Availability and timestamp validity

Availability is authoritative server provenance, independent of consumer presentation freshness and observed health. An available observation with `ready=false` is a valid observed failure. A stopped worker can have available current data; a historical true public readiness result is not current admission authorization. No freshness enum or display threshold is serialized in the server DTO.

| Availability | Required representation |
|---|---|
| `available` | Non-null complete data and a syntactically valid original ISO UTC `observedAt`. Chronology may be uncertain after clock adjustment without making the timestamp malformed. |
| `unavailable` | Source/retention primitive absent, or a valid direct observation-time projection cannot be supplied; null data/time. Includes unwired deployed data via its nullable runtime field, not guessed values. |
| `not_yet_sampled` | Producer/retention wired and enabled, no completed valid observation accepted yet; null data/time. This may persist indefinitely for passive public readiness. |
| `instrumentation_disabled` | Known optional producer disabled; null data/time. This applies to scheduled economics capacity/resources in the initial design, not independently existing worker/dispatcher fields. |
| `collection_failed` | A distinguishable acquisition/projection/retention failure occurred after the latest accepted success, or before any success. Preserve prior complete data/time; if none, both are null. `lastCollectionFailureAt` is required non-null and syntactically valid. Subsequent log-emission failure is excluded. |

The latest valid successful publication replaces data/time atomically and returns availability to available. Keep the last known failure timestamp as diagnostic history of one event, not an incident count; determine success/failure order at the producer boundary, not by comparing wall timestamps that can move backward. Retention begins empty on every process/counter epoch; never reuse prior-process in-memory samples. Unwired optional sources use unavailable; once wiring can positively identify disabled instrumentation, use instrumentation-disabled. Failure must not be invented from missing data. A per-field unknown stat stays null inside otherwise available resources; no collection-failed claim is possible from the swallowed stat error alone. A null CPU interval likewise does not invalidate other successfully projected resource fields.

An available observation must contain a syntactically valid required ISO UTC `observedAt`. Malformed required timestamps, including capacity/resource `sampledAt`, reject the candidate publication rather than being serialized as available. Validate non-null optional event/provenance/failure timestamps too; absence stays null, but a malformed supplied timestamp must not masquerade as absence. At a passive producer boundary, projection rejection preserves any previous complete valid record and records failure only when a valid bounded failure timestamp can safely be supplied. If failure metadata cannot safely be recorded, preserve the previous record and state; never serialize malformed metadata or fabricate successful data.

Apply validation and local failure isolation to direct-source projection too. During read-only DTO assembly, a malformed direct section is unavailable with null data/time; do not create a cache or mutate producer/retention failure metadata merely because a dashboard read rejected that candidate. A malformed required top-level assembly timestamp rejects the DTO response instead of fabricating a valid clock. Rejected/error responses remain subject to section 3's middleware isolation and uncached delivery requirements. No validation failure may alter the operational producer.

A syntactically valid timestamp later than the DTO assembly comparison wall clock may be retained. Consumers must treat its chronology/age as uncertain and may show a clock-skew warning. This differs from malformed timestamp rejection. Capture the comparison wall clock after direct source observations where practical so assembly order does not manufacture future observations. Future-looking nested worker event times also warrant chronology caution; do not rewrite worker `ready`, `providerHealth`, or other source booleans using Observatory clock logic.

The server supplies original timestamps, not an intrinsic visual fresh/stale guarantee. The consumer's age calculations and thresholds are defined in section 11. New DTO assembly or receipt time never refreshes an older observation. No read changes source timestamps, failure metadata, or sampler baselines. End-to-end uncached delivery is required by section 3: original timestamps alone do not reveal unknown cache residence.

## 8. Counter/reset semantics

Dispatcher purpose starts and outcomes are cumulative since dispatcher/process creation; they are the only cumulative source requiring rate calculations in v0.1. Both `processEpoch` and `runtime.processMonotonicMs` are required future primitives for reliable delta/rate calculations and are absent from current telemetry. Null is permitted during incomplete wiring, but rate panels remain unavailable until both are reliably supplied. Generate an opaque boot token once, retain it, and capture it with all related observations. No new UUID per dashboard read. Capture finite nonnegative monotonic milliseconds adjacent to the direct dispatcher snapshot during synchronous DTO assembly; never use a sampler dispatcher wrapper copy as that current counter observation.

```text
same epoch:       1000 -> 1015  = +15
different epoch:  1000 -> 4     = process/reset boundary, NOT -996
```

Worker stop/start or generation change does not reset dispatcher counters and is not an epoch boundary. If future wiring reconstructs/resets a cumulative source within one process, rotate the snapshot's counter epoch and invalidate dependent retained data/delta baselines; never silently reset counters beneath the same epoch. The token is an opaque lifetime marker, not a durable restart counter.

Requests/min and similar dispatcher rates may be derived downstream only from two compatible snapshots of the same source identity/instance/network/asset, with the same non-null epoch, available dispatcher observations, finite nonnegative strictly increasing `runtime.processMonotonicMs`, and monotonic relevant counters. The reliable interval is `current.runtime.processMonotonicMs - previous.runtime.processMonotonicMs`; requests/min is `deltaRequests * 60_000 / intervalMs`. ISO `observedAt` remains human/provenance and display-age metadata only: a positive wall-clock delta does not establish a reliable rate interval, and wall-clock delta must never be substituted for missing monotonic timing.

Missing/invalid/reset intervals yield no rate; never negative traffic or clamped fake zero traffic. Counter equality over a valid positive monotonic interval can yield an observed zero rate. A long interval yields that interval's average, not a claimed last-minute rolling window. Duplicate or out-of-order snapshot observations do not advance a rate baseline; a new response receipt is not a new observation. The monotonic primitive is not an epoch timestamp, must never be displayed as a date, and is comparable only within the same non-null epoch. Clock-skew warnings from valid ISO chronology do not replace these monotonic eligibility checks.

Total starts can be the sum of the six purpose counters. Completed totals/failure ratios use successes + failures; denominator zero means unavailable ratio, not 0% success/failure. Timeout rates use the subset without double-counting. Do not apply cumulative-counter arithmetic to `consecutiveFailures`, instantaneous queues/counts, latest-cycle counts, or interval CPU deltas. No durable historical/time-series database or server-side rate series is part of v0.1.

## 9. Passive retention requirements

Passive producer retention must be bounded, in-memory, and independent of dashboard demand. Assembly-only clock metadata uses allowed bounded clock reads and does not drive a producer. Minimal future wiring is:

1. **Epoch and monotonic observation:** retain process/counter lifetime token at boot; read-only accessor, no persisted restart history. Add a bounded process-monotonic clock read during synchronous DTO assembly adjacent to dispatcher acquisition. This clock read must not mutate a sampler baseline or refresh retained data. All startup metadata must be allowlisted scalars.
2. **Scheduled capacity/resources:** retain an immutable, fixed, allowlisted projection of the completed scheduled observation, with its original acquisition-start `sampledAt`, original cached-tip/time inputs, verified nullable CPU interval, and safely known collection-failure time. Existing production sampler already performs capacity SQL and file stats when enabled. Reuse its acquisition and cadence; do not add a second sampler, repair sampling, on-read fallback, or dashboard-driven schedule. Sample disabled means these sections are disabled; a separate producer when economics is disabled needs later explicit design. The approved retained record contains only capacity/resource/provenance fields, never raw `freeWork`, per-watch metrics, status maps, dispatcher wrapper copies, metric-entry counts, cache/session structures, log contents, or other sampler output.
3. **Poll completion provenance:** add only an ISO wall-clock completion timestamp at normal `finishCapacityCycle`, published synchronously with existing four fields as one complete record. Compute and validate the candidate before replacing the retained record. It adds no operational cycle and does not change the monotonic duration calculation. This is required because source lacks a trustworthy completion timestamp; until wired, expose unavailable. Outer operational failure leaves the preceding completed record; never publish partial counts or manufacture completion in a `finally` path.
4. **Complete public readiness:** optionally retain the complete result at the ordinary existing public `/ready` response/composition boundary, including its existing exception outcome. Retain what that path already did; no readiness timers/probes/fallbacks are added by Observatory. With wiring but no ordinary result yet, not-yet-sampled is correct and may persist indefinitely. Do not reuse a strict paid decision or private storage-only cache as the complete public observation. An Observatory retention exception must not escape into the route's readiness exception handling or change its response.
5. **Deployment metadata:** optionally capture a reliably supplied full deployed SHA at startup/build wiring. Source provenance remains null if unavailable; no runtime Git command, metadata network query, filesystem read, or environment dump.

Scheduled retention is a bounded passive acquisition/projection boundary within the existing producer lifecycle, not merely a callback that retains whatever `sampleAndLog()` logs. It must distinguish successful acquisition/projection, acquisition/projection failure, and subsequent log-emission failure without parsing logs or performing additional acquisition. The current `sampleAndLog()` catch combines sampling and logging errors and does not supply this distinction by itself. A valid projected sample is eligible for publication independently of subsequent logging; logging failure after it must not mark capacity/resources as collection-failed, discard the valid record, or update collection-failure metadata.

Only a complete valid scheduled projection replaces last successful data. Capture the paired capacity/resource candidates and their provenance from the same completed scheduled observation and publish them together; `cpu=null` is a complete permitted resource projection, not a partial sample. Acquisition or projection/publication failure preserves the preceding complete record and original times, recording failure only where safely distinguishable. Resource/capacity acquisition is sequential, not transactional; expose the sampler's start time conservatively and publish after completion. CPU/elapsed baselines may already have advanced independently on failure; section 6's pairing rules apply without repair sampling.

Every new passive acquisition observer, projection or retention hook must handle its own telemetry errors locally. None may escape into poller/reconciler catches, readiness handling, provider-health logic, watch servicing, settlement or admission. A telemetry exception must never mark worker failure, invalidate provider evidence, alter readiness, fail a watch turn, affect settlement/admission, or change operational control flow. Preserve previous complete records and, where safe, bounded failure metadata; never expose exception bodies or publish partial cycle/sample records. Metadata recording must itself be failure-isolated and must not trigger retries, probes, timers or other operational work.

No readiness primitive is a prerequisite for serving the Observatory snapshot: even when service readiness is false/unknown, the endpoint should be able to return retained operational observations without invoking readiness. Endpoint availability itself is a transport concern, not a manufactured in-process liveness guarantee.

## 10. Security/privacy boundary

Use fixed, bounded allowlisted aggregates and metadata. The snapshot must never expose:

- Mnemonics, private keys, secrets, credentials, HMAC keys, or environment dumps.
- Payment headers, signed payloads, raw request/response/error bodies, or stack traces/freeform errors.
- Watch IDs, idempotency keys, payer/sender/receiver addresses, invoice notes, transaction IDs, or per-watch payment/evidence records.
- Client/watch fingerprints, raw IP addresses, raw user agents, or high-cardinality customer identifiers.
- Provider credentials/full URLs, internal filesystem/database paths, or raw queue/cache/session contents and continuation tokens.

Aggregate field selection remains necessary even for data also available through public watch APIs. No identity can be reintroduced as a label or error detail. The initial DTO has no provider URL/host field and no raw operational error field. Avoid arbitrary `Record<string, unknown>` passthroughs; readiness checks are explicitly allowlisted.

The future endpoint is internal and read-only. FlowHUD accesses it through a server-side proxy; no direct browser credential/provider access is part of this design. Endpoint route, transport/auth, credential storage, and access checks belong to the later implementation/design step and must preserve section 3's full-lifecycle isolation and end-to-end `Cache-Control: no-store` semantics, including rejected/error responses. This spec neither designs a full authentication system nor authorizes publishing a public unauthenticated endpoint. No control capability is implied by internal access.

## 11. Consumer/polling contract

These are requirements and initial presentation defaults for the eventual FlowHUD consumer, not new server scheduling behavior or fields of the backend compatibility schema. Poll cadence and visual age thresholds may change without changing the server schema or worker health semantics:

- Use an initial polling default of approximately 15 s while the Observatory view and browser page are visible; pause when the view is inactive or the tab/page is hidden. This cadence is UI policy, not an intrinsic source freshness guarantee or backend contract.
- Refresh immediately when visible again; avoid overlapping requests and unbounded retry queues.
- Retain the last successful compatible UI snapshot through transient transport/proxy failure. Mark retrieval failure separately from server-reported collection failure; continue showing each section's growing stale age.
- Display explicit server availability, consumer-computed freshness/age, units, and epoch/reset transitions. Unknown, not sampled, disabled, and failed cannot become zero, healthy, empty success, or current. Explain passive readiness that is unavailable or indefinitely not-yet-sampled. Explain null CPU independently of other available resources.
- Label cached Indexer tip, progressed turns, composite streak, sampled capacity, interval CPU, and observed public readiness according to their semantics. Show lag input tip age independently.
- Derived rates use only eligible dispatcher counters and the monotonic interval in section 8; reset on epoch change or invalid interval. Missing monotonic/epoch wiring leaves rate panels unavailable. A newer receipt timestamp never refreshes data. Unsupported schema retains last compatible data with an explicit incompatibility/staleness state.

Consumer freshness labels may be `fresh`, `stale`, `unknown`, or `not_applicable`; they are presentation state and are not server DTO fields. A valid nonnegative age within the chosen UI threshold is fresh, above it stale, suspicious chronology unknown, and no observed data/time not-applicable. Collection-failed with retained data may still have a fresh or stale display age; failed collection and observed health remain separate from age. Future-looking section or nested event timestamps require chronology caution and may show a clock-skew warning. The UI may zero-clamp a displayed negative age, but must not label that chronology fresh or override worker `ready`/`providerHealth`.

Initial configurable UI age-warning defaults, not versioned server policy:

| Observation | Consumer default and interpretation |
|---|---|
| Direct worker and dispatcher memory observations | 45,000 ms delivery-age warning. It does not replace worker evidence readiness. |
| Cached observed Indexer round, including capacity's own lag input | 180,000 ms display warning for old cached evidence. Independently chosen UI policy, not borrowed from the worker-evidence threshold or an intrinsic sweep-tip acquisition guarantee. Idle/paginating deployments can retain an old tip legitimately. |
| Latest poll-cycle completion | 45,000 ms default completion-age warning, tunable with known producer cadence. Not stalled-worker determination or full tick latency. |
| Complete public readiness | 30,000 ms historical-result age warning. Not strict paid-admission policy or a readiness schedule. |
| Scheduled capacity and resources | 180,000 ms default sample-age warning, consistent with three default 60 s scheduled intervals. Tune using trustworthy producer cadence/configuration if available; delayed/disabled producers are never refreshed by the UI. |

Source configuration/producer cadence may inform these defaults when semantically useful and reliably available, but does not turn a UI threshold into source truth. No FlowHUD cadence, display budget, or freshness label is encoded in the server DTO. In particular, changing shared-probe worker evidence policy must not automatically change the cached-tip warning policy.

For display age, use original section time relative to the DTO assembly wall clock, account conservatively for in-flight delivery duration, and continue aging with local monotonic elapsed time. Preserve the aging anchor for an unchanged retained observation in the same epoch/source across new response receipts; do not rebase it to age zero. Clock adjustment may make chronology uncertain. Proxy/browser receipt time does not replace source time, and preserved timestamps alone cannot determine unknown cache residence: end-to-end uncached delivery is mandatory. The endpoint and proxy use `Cache-Control: no-store` semantics; neither caches nor rewrites the DTO's schema, epoch, assembly monotonic observation, availability, or original timestamps.

Keep only the small number of successive observations needed for reset-aware deltas in UI memory. No arbitrary historical chart range is promised. The proxy preserves semantics and cannot call readiness/providers to fill gaps. No polling or UI code is implemented in this task.

## 12. Initial implementation slice

### A. Existing cheap memory sources

Snapshot core can project worker health getters, dispatcher getter, cached poller round/time, existing latest poll-cycle values, and resolved safe runtime configuration. Direct getters remain bounded; no private maps are enumerated. Original missing worker/tip timestamps become null. The four cycle values exist but require completion-time retention before inclusion as a timestamped available section.

### B. Minimal new passive retention primitives

Future implementation must supply both `processEpoch` and `runtime.processMonotonicMs` before enabling reliable dispatcher rates, and cycle completion provenance before presenting available poll-cycle data. Fixed DTO metadata, per-section observation wrappers, validation and monotonic clock capture are new bounded serialization wiring. Display budgets and polling defaults belong solely to the consumer.

Retaining the immutable fixed allowlisted scheduled capacity/resource projection enables those sections without on-read work. Acquisition/projection failure observation is distinct from log-emission failure, and CPU remains null without verified paired interval evidence. Retaining complete ordinary public readiness enables readiness; it may remain unavailable in the first implementation slice or indefinitely not-yet-sampled after wiring. Every passive hook is locally failure-isolated. Verified deployed commit metadata is optional and remains null without reliable wiring. These fields are declared now so unavailable states are part of the contract rather than concealed by omission. Until their producers/retention are wired, capacity/resources/readiness return no invented values.

The minimal useful implementation does not depend on all optional retained sections: metadata, workers, dispatcher and cached tip remain useful while readiness/capacity/resources are unavailable. Nothing in the unavailable sections can trigger fallback work. Follow-up endpoint, proxy and FlowHUD work must preserve this contract, the security boundary, uncached delivery and full route-lifecycle middleware isolation.

### C. Deferred telemetry systems

Full HTTP/external activity aggregation, fingerprint analytics, MCP method/tool metrics, operational event ring buffer, historical persistence/time-series, provider latency histograms, facilitator telemetry, and per-watch explorers are not required for the first implementation slice. No new telemetry database, log consumer, or provider polling system is hidden in A or B.

## 13. Deferred increments

**External activity:** current HTTP request telemetry, client/watch fingerprints, request classifications, and MCP transport activity primarily exist as logs. HTTP logs suppress successful health/readiness, while optional `freeWork` covers only selected categories and misses routes/outcomes. `freeWork` is not complete HTTP traffic. No retained MCP method/tool outcomes exist; HTTP 200 can contain tool errors. A future increment needs a bounded passive allowlisted aggregation mechanism at the actual activity boundary, with explicit coverage, counter epoch, and timing semantics. It must not replay requests/tools or expose raw fingerprints/identities.

**Recent operational events:** current events are emitted logs, with no bounded retained ring buffer/store or stable incident stream. Repeated blocked-readiness logs are not distinct incidents. A later increment may define a fixed-capacity allowlisted operational-event buffer with coarse categories, timestamps, overflow policy and no customer identities/error bodies. Raw log tailing/parsing is not v0.1 core and no event buffer is implemented here.

Other later proposals need their own justified source and privacy model: provider latency/status aggregates, narrowly scoped facilitator telemetry, scoped traffic counters, and historical observations. Neither benchmark output nor pruned per-watch economics can fill missing live fleet telemetry. Do not calculate revenue from HTTP success labels, provider p95 from sums/max, cache-hit ratios from incompatible lifetimes, or lifetime matches from retained current rows.

## 14. Explicit exclusions

- Write/control actions: restart, deploy, cancel watch, refund, or change limits/configuration.
- WebSocket/SSE, Prometheus/Grafana/Loki, Redis, a new telemetry database, or PostgreSQL migration.
- Raw log viewer, arbitrary historical time ranges, distributed tracing, or multi-instance aggregation.
- Public/customer dashboard, per-watch detail explorer, or full external-actor forensic UI.
- Full external activity, fingerprint analytics, MCP tool analytics, event ring buffer, provider latency histograms, and facilitator telemetry in the first implementation slice.
- Any application code, tests, configuration, dependencies, CI, endpoints, database schema, or UI changes in this specification-only task.

## 15. Acceptance criteria

The future implementation is acceptable only when all of the following are reviewable and verified during that later implementation task:

1. It returns the explicit `ObservatoryRuntimeV01` schema and fixed allowlisted fields, with valid units/types/nullability. No internal object, path, identity, raw error, credential, or queue/cache payload leaks through serialization.
2. Source mapping distinguishes cheap current memory observations from retained scheduled projections. The full composed endpoint/proxy lifecycle executes no provider request, worker turn, SQL query/probe, file stat, sampler call, fingerprint generation, mutable admission/gate work, paid readiness, or operational telemetry/log emission caused solely by Observatory reads. Successful, rejected and error responses are all covered. Repeated reads with operational entry points observed must demonstrate zero calls and zero watch/admission/sampler/producer-retention state mutation.
3. Read-time work is bounded projection, clock capture, validation and serialization, with no server visual freshness policy. Snapshot acquisition neither starts producers nor changes their cadence. Operational producer behavior and MainNet/TestNet settlement/watch baselines remain intact.
4. Worker field semantics match existing health getters, including composite streak, isolated errors, heartbeat meaning, stale evidence, hysteresis, and resolved thresholds. Worker readiness, public readiness, and strict admission are presented distinctly.
5. Six purpose counters are normalized, labeled since dispatcher/epoch creation, and never treated as HTTP requests, paid watches, or pure probe traffic. Timeouts remain a subset of failures; dispatcher queue is not watch backlog.
6. Cached tip retains original observation time; capacity lag retains its own input tip/time. Poll-cycle values use the passive normal-completion timestamp, never worker heartbeat or dashboard time. Before first completion there is no fabricated empty-cycle sample.
7. Capacity/resources retain only an immutable, fixed, allowlisted projection from a completed existing scheduled observation, published together with original `sampledAt` and never recomputed on reads. No raw sampler/freeWork/per-watch/status-map/dispatcher-wrapper/cache/session structures are retained. Acquisition/projection failure preserves the preceding complete record; subsequent log-emission failure does not become collection failure. Missing lag/age/file sizes stay null; sampled empty counts and genuine zero lag remain distinct from missing data. CPU is nullable and published only with a verified paired `cpu.elapsedMs`; CPU percentage uses that positive duration only, never generic sampler elapsed or dashboard timing. Ambiguous/recovered failure permits available memory/file-size observations with null CPU; no repair sampling is added.
8. Complete public readiness is unavailable until passively retained from the ordinary public readiness path, and may remain not-yet-sampled indefinitely if no ordinary caller exists. No Observatory read, timer or fallback computes `/ready` or strict paid readiness. The complete existing exception outcome can be represented without fabricated subchecks; UI explains missing observations.
9. Availability/data/time combinations follow section 7 without server freshness fields. Required/non-null supplied timestamps are validated; malformed candidates are rejected while previous valid records and safely known failure metadata are preserved. Valid-but-suspicious chronology remains distinguishable from malformed timestamps and gets consumer clock caution without rewriting worker booleans. Assembly comparison wall clock follows direct observations where practical. New serialization/receipt time never refreshes an old sample.
10. Non-null equal `processEpoch` and finite nonnegative strictly increasing `runtime.processMonotonicMs` are required for reliable dispatcher rates, with compatible source/network/asset and monotonic relevant counters. Missing wiring, restart/reset, decreasing counters, or invalid/nonpositive monotonic intervals suppress rates; valid equal counters may yield zero. Wall-clock deltas are never used for reliable rates; monotonic values are never displayed as dates. Verified deployed metadata or null is used; audit SHA is never substituted.
11. FlowHUD uses the server-side proxy with end-to-end uncached origin/proxy/browser delivery and endpoint/proxy semantics equivalent to `Cache-Control: no-store`, including rejected/error responses. Consumer polling (initial visible-only 15 s default), visual freshness thresholds, immediate visibility refresh, and retained last successful compatible data on failure are presentation policy, not server schema fields. Repeated receipt of unchanged observations preserves their aging anchors. Neither consumer nor proxy fills unavailable fields by causing operational work; preserved timestamps alone are not claimed to reveal unknown cache residence.
12. The first slice excludes external-activity/event systems, history, controls, per-watch views, and infrastructure changes. Any later increment is explicit and preserves the same observational boundary.
13. All new passive acquisition/projection/retention hooks are locally failure-isolated. Their exceptions cannot mark poller/reconciler failure, invalidate provider evidence, alter readiness, fail watch servicing, affect settlement/admission, or escape into operational control flow. Failure preserves the previous complete cycle/sample record and records bounded metadata only when safe; partial records are never published.

Documentation verification for this task is limited to inventory/source review and the one-file diff. No runtime test, production request, Indexer/facilitator call, SQLite operation, or payment is needed to create this specification.
