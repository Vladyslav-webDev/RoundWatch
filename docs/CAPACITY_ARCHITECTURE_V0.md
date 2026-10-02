# RoundWatch Capacity Architecture V0

Status: Phase 0 measurement contract  
Date: 2026-10-02  
Scope: current single-node RoundWatch; no scaling redesign in this document.

## Current architecture

- one API process;
- one SQLite database on one persistent disk;
- one poller;
- one settlement reconciler;
- one shared Indexer dispatcher;
- default dispatcher: 4 requests/second, burst 4, concurrency 2;
- default open-obligation capacity: 50 globally and 5 per service payer.

Admission limits are policy guards. Raising them does not increase processing capacity.

## Phase 0 goal

Make backlog observable before changing storage, worker topology, or provider strategy.

When economics instrumentation is enabled, the runtime snapshot includes a `capacity` object.

### Durable obligations

- `unfinishedWatches`
- `activeWatches`
- `settlementPendingWatches`
- `unresolvedSettlementUnknownWatches`
- `activeWatchesMissingScanBaseline`
- `watchesPastDeadlineAwaitingCoverage`
- `oldestActiveWatchAgeMs`

### Chain backlog

After the poller has observed an Indexer tip:

- `currentIndexerRound`
- `currentIndexerRoundObservedAt`
- `scanLagRounds.samples`
- `scanLagRounds.p50`
- `scanLagRounds.p95`
- `scanLagRounds.max`

For each active watch:

```text
lag =
min(current Indexer round, closing round when fixed)
-
durable scanAfterRound
```

The value is clamped at zero. A watch with a fixed closing round therefore does not appear to fall behind chain rounds outside its eligible window.

### Poll-cycle work

- `lastCycleDurationMs`
- `watchesAttemptedLastCycle`
- `watchesSucceededLastCycle`
- `watchesFailedLastCycle`

Existing dispatcher telemetry remains authoritative for queued requests, in-flight requests, request counts, failures, and timeouts.

## Why dispatcher queue depth is not backlog

The queue contains requests that already reached the request scheduler. It does not count watches waiting for a turn, incomplete pagination, or durable chain coverage not yet scanned.

Scan lag is therefore the primary Phase 0 backlog signal.

## Initial characterization

A local synthetic pass on 2026-10-02 established engineering observations, not production sizing or an SLA:

- the default global unfinished-watch cap is 50;
- 100 quiet synthetic watches at the default 4 req/s dispatcher required about 24.27 seconds for 101 requests;
- request-budget lower bounds are about 249 seconds for 1,000 and 2,499 seconds for 10,000 distinct one-page queries;
- an unthrottled 1,000-watch collision workload reached roughly 627 MiB sampled RSS and about 5.24 seconds for its first collision cycle;
- the 10,000-watch collision run was intentionally stopped before execution because extrapolated memory use could reach several GiB.

The first scaling constraints are therefore request amplification and provider request budget, not raw CPU alone.

## Standard local benchmark baseline

Do not point the economics benchmark at production or third-party infrastructure for load testing.

```powershell
$env:ROUNDWATCH_BENCH_WATCH_COUNTS='10,25,50,100'
$env:ROUNDWATCH_BENCH_QUERY_VARIANTS='C'
$env:ROUNDWATCH_BENCH_PROFILES='quiet-exact-note,quiet-no-note,hot-exact-note,adversarial-c-filter-collision'
$env:ROUNDWATCH_BENCH_TARGET_ROUNDS='100'
$env:ROUNDWATCH_BENCH_ROUND_WINDOW='100'

pnpm -C apps/server run benchmark:economics
```

Record elapsed time, requests/watch, pages/watch, scan reuse, CPU, peak RSS, response bytes, and rounds covered.

The normal CI smoke test only protects benchmark/parser schema compatibility; it is not a capacity benchmark.

## Scaling gates

### Gate A — pilot scale

Typical load: up to roughly 5 concurrent real watches.

Keep the current architecture and observe scan lag/provider health.

### Gate B — optimize one node

Trigger examples:

- sustained 10–25 active watches;
- materially rising p95 scan lag while provider health is normal;
- poll-cycle duration approaching the user-visible latency target.

Investigate query sharing, page reuse, scan coalescing, local fan-out matching, and fairness for busy watches before adding workers.

### Gate C — prepare shared durable state

Trigger examples:

- the 50-global cap becomes a real business constraint;
- a tuned single node remains CPU/RAM constrained;
- one process cannot meet the measured scan-lag target.

Likely direction: shared relational storage, explicit leases/work claims, and preserved idempotent state transitions. This gate does not authorize an automatic migration.

### Gate D — multiple observation workers

Prerequisites:

- shared durable state;
- safe lease/ownership semantics;
- provider-aware global rate limiting;
- worker-loss recovery tests;
- duplicate processing cannot create duplicate state transitions.

### Gate E — provider/topology scaling

Only after worker scaling is justified: multiple providers, partitioning, multi-region placement, or autoscaling.

More workers against one fixed provider quota can reduce reliability instead of increasing capacity.

## Known hazards

- duplicate work across workers;
- exactly-once assumptions instead of idempotent at-least-once processing;
- provider quotas becoming the system-wide bottleneck;
- busy-address pages dominating CPU, RAM, and work budgets;
- backlog consuming eligibility time before complete coverage;
- per-sweep page retention increasing memory pressure;
- raising admission caps without raising observation capacity;
- treating synthetic benchmark results as SLA evidence.

## Phase 0 exit criteria

Phase 0 is complete when:

1. runtime logs expose durable obligation counts, scan lag, and cycle duration;
2. the standard synthetic baseline is repeatable;
3. a production canary shows the telemetry adds no meaningful Indexer traffic or readiness instability;
4. scaling decisions are driven by measured lag/backlog rather than active-watch count alone.

No shared database or multi-worker implementation is part of Phase 0.
