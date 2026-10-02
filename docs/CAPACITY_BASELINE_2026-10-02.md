# RoundWatch Capacity Baseline — 2026-10-02

Status: recorded Phase 0 baseline  
Production code under test: `main@80b4a6aa0454b3afd0a7d3f36e5703576bdd9987`  
Measurement run: GitHub Actions CI #281, workflow run `37007545692`  
Temporary measurement commit: `e847522e8aa5d570e8ae5927b18ab17ba307d719`  
Runner: `ubuntu-latest` GitHub-hosted runner  
Node: 24.14.0  
pnpm: 12.3.4

## Purpose

This document records the first repeatable Capacity Phase 0 synthetic baseline for the current single-node RoundWatch implementation.

It is a structural-work benchmark, not a production latency benchmark or SLA. The benchmark uses an in-process synthetic Indexer and the benchmark's intentionally unthrottled dispatcher defaults. No MainNet, TestNet, Render, AlgoNode, or other third-party provider was load-tested.

The temporary CI workflow change used to collect these numbers was closed without merge in PR #103. Only the results are retained here.

## Configuration

```text
watch counts:      10, 25, 50, 100
query variant:     C
profiles:
  - quiet-exact-note
  - quiet-no-note
  - hot-exact-note
  - adversarial-c-filter-collision

target coverage:   100 rounds
round window:      100 rounds
synthetic RPS:     100,000/s
synthetic burst:   100,000
dispatcher conc.:  2
```

## Results

| Profile | Watches | Elapsed ms | Requests | Scan reuse | CPU ms | Peak RSS MiB | Peak heap MiB | Mean response bytes/watch |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| quiet-exact-note | 10 | 47.8 | 11 | 1.00× | 71.7 | 167.1 | 64.5 | 74 |
| quiet-exact-note | 25 | 44.3 | 26 | 1.00× | 43.3 | 172.5 | 67.0 | 54 |
| quiet-exact-note | 50 | 80.3 | 51 | 1.00× | 79.0 | 181.5 | 71.2 | 47 |
| quiet-exact-note | 100 | 101.2 | 101 | 1.00× | 158.7 | 202.8 | 60.4 | 43 |
| quiet-no-note | 10 | 13.5 | 2 | 10.00× | 16.3 | 202.9 | 62.3 | 38 |
| quiet-no-note | 25 | 29.4 | 2 | 25.00× | 31.4 | 203.0 | 64.0 | 15 |
| quiet-no-note | 50 | 64.5 | 2 | 50.00× | 70.2 | 202.9 | 66.7 | 8 |
| quiet-no-note | 100 | 71.6 | 2 | 100.00× | 116.2 | 206.2 | 71.5 | 4 |
| hot-exact-note | 10 | 53.1 | 11 | 1.00× | 83.4 | 213.3 | 59.6 | 4,941 |
| hot-exact-note | 25 | 87.6 | 26 | 1.00× | 91.6 | 213.2 | 89.3 | 2,391 |
| hot-exact-note | 50 | 183.8 | 51 | 1.00× | 191.2 | 238.8 | 115.7 | 1,543 |
| hot-exact-note | 100 | 315.0 | 101 | 1.00× | 355.9 | 278.4 | 103.8 | 954 |
| adversarial-c-filter-collision | 10 | 163.6 | 21 | 1.00× | 189.9 | 289.9 | 104.5 | 511,988 |
| adversarial-c-filter-collision | 25 | 354.4 | 51 | 1.00× | 418.0 | 310.5 | 113.4 | 522,788 |
| adversarial-c-filter-collision | 50 | 728.9 | 101 | 1.00× | 779.4 | 335.7 | 122.5 | 526,388 |
| adversarial-c-filter-collision | 100 | 1370.6 | 201 | 1.00× | 1523.8 | 390.1 | 145.4 | 528,188 |

## 100-watch comparison

### Quiet exact-note

- elapsed: 101.2 ms
- total Indexer requests: 101
- physical scan-page requests: 100
- scan-page reuse: 1.00×
- peak RSS: 202.8 MiB
- peak heap: 60.4 MiB

Each watch has a distinct note-constrained query shape, so this baseline shows essentially no scan-page sharing.

### Quiet no-note

- elapsed: 71.6 ms
- total Indexer requests: 2
- physical scan-page requests: 1
- logical scan pages: 100
- scan-page reuse: 100.00×
- peak RSS: 206.2 MiB

All 100 watches shared one compatible physical scan page in this synthetic profile. This is the clearest baseline evidence that query shape determines whether current page sharing can collapse request amplification.

### Hot exact-note

- elapsed: 315.0 ms
- total Indexer requests: 101
- physical scan-page requests: 100
- mean transactions returned/watch: 2.8
- peak RSS: 278.4 MiB
- peak heap: 103.8 MiB

Distinct exact-note queries still prevent page reuse, while heavier synthetic responses increase CPU and memory versus quiet exact-note.

### Adversarial filter collision

- elapsed: 1370.6 ms
- sweeps: 2
- total Indexer requests: 201
- physical scan-page requests: 200
- transactions examined/watch: 1500
- mean response bytes/watch: 528,188
- peak RSS: 390.1 MiB
- peak heap: 145.4 MiB
- CPU: 1523.8 ms

This remains the most expensive baseline profile. It forces two pages per watch and 1,500 plausible-but-nonmatching transactions per watch.

## What this baseline establishes

1. **Request amplification is highly query-shape dependent.** At 100 watches, quiet exact-note required 100 physical scan-page requests while quiet no-note required one.
2. **Current within-sweep/historical page sharing can be extremely effective when watch query keys align.** The no-note profile reached 100× scan-page reuse at 100 watches.
3. **Exact-note isolation prevents that reuse in the current query strategy.** The exact-note profiles stayed at 1× reuse.
4. **Busy/collision pages move the bottleneck from request count alone toward CPU and memory.** At 100 watches, the adversarial profile reached 390.1 MiB RSS and 1523.8 ms CPU in this runner.
5. **These elapsed times must not be read as production watch latency.** Production currently uses the much lower shared Indexer dispatcher budget. The synthetic baseline intentionally removes that limiter to characterize structural work.

## Comparison discipline

Future optimization work should compare against this baseline using the same:

- query variant;
- profiles;
- watch counts;
- target/window rounds;
- benchmark code;
- Node major/minor;
- CI workflow shape where practical.

GitHub-hosted runner hardware is ephemeral, so absolute CPU/RSS measurements can vary between runs. Prefer large directional changes, request counts, scan-page reuse, pages/watch, and response-work metrics over tiny elapsed-time differences.

A future query-coalescing or local fan-out change should be considered successful only if it reduces physical requests and/or heavy page work without weakening exact matching, lifecycle correctness, fairness, work-budget bounds, or readiness semantics.

## Raw data

Machine-readable raw results are stored in:

`docs/capacity-baseline-2026-10-02.json`

## Next action

None required immediately.

Capacity Phase 0 now has:

- production backlog telemetry;
- documented scaling gates;
- a working economics benchmark;
- a repeatable synthetic baseline.

The next capacity change should be triggered by measured production lag/backlog or a concrete partner/load requirement, not by speculative scaling.
