# Shutdown S1: background admission and ownership

S1 supplies terminal shutdown primitives for `RoundWatchPoller`,
`SettlementReconciler`, `IndexerRequestDispatcher`, and `IndexerHealthProbe`.
It does **not** fix production shutdown ordering in `apps/server/index.ts`.
The production P1 remains open until S2 joins HTTP/payment and background work
before closing SQLite.

## APIs and ownership

All four components provide `stopScheduling(): void` and `drain(): Promise<void>`.
`stopScheduling()` synchronously sets a permanent admission fence. Repeated
calls are harmless. `drain()` also establishes that fence and returns a shared
promise that resolves when the component's owned asynchronous work has settled.
It uses promise completion, without sleeps or a polling loop.

Worker `stop()` remains an operational pause: `start()` can resume the same
worker. It does not join in-flight work. After terminal `stopScheduling()` or
`drain()`, `start()` cannot reopen admission. Stopped workers become not-ready
immediately under the existing health contract.

| Component | Work joined by `drain()` |
| --- | --- |
| Dispatcher | Started operations, observers and completion bookkeeping; queued requests are rejected and the refill timer is cleared permanently. |
| Health probe | The pending capability probe, including evidence publication/error handling and pending cleanup. |
| Poller | Every accepted direct `runOnce()` (including overlapping calls), plus the complete scheduled tick and its post-cycle probe continuation. |
| Reconciler | The admitted direct `reconcileOnce()` under its existing overlap guard, plus the complete scheduled wrapper and its post-cycle probe continuation. |

Rejected direct worker entry occurs before store access. An existing sweep
checks terminal admission before claiming another candidate. Worker guards also
prevent dependent acquisitions after terminal stop; dispatcher admission is the
primary common provider boundary, including queued requests.

Admission is rechecked after supplied clock callbacks, so synchronous callback
reentry cannot enqueue or acquire work after the fence. Dispatcher completion
diagnostics and observer error reporting cannot strand the original caller if
their logging sink throws. Diagnostic clock exceptions and non-finite values
fall back to the last valid refill value. Refill uses the same safe clock, so a
timing exception cannot break completion queue pumping or replace a provider
result. Constructor clock validation is unchanged.

## Administrative interruption and useful results

`ShutdownInterrupted`, identified with `isShutdownInterrupted`, represents
administrative admission rejection. Callers propagate it past ordinary provider
error conversion. It produces no polling failure/backoff, reconciliation
failure/defer penalty, provider-health invalidation, failure epoch, negative
capability sample, or completion telemetry for undispatched requests.

Already-dispatched requests finish normally. Validated matching transactions,
cursor advancement, returned closing checkpoints, expiry proofs and settlement
evidence can still perform their existing durable operations. A subsequent
provider acquisition is interrupted if admission is closed. Real failures from
already-dispatched provider work keep their existing failure behavior.

Interrupted poll sweeps retain the previous completed-cycle observation and do
not publish partial completion. Session pruning retains its existing generation
fences. Pagination/token rules, purpose/work claims, bounded sessions and passive
Observatory reads are unchanged. No public `draining` DTO field is added.

## S2 dependencies

S2 must synchronously fence scheduling/admission on **all four** background
components before awaiting any drain, and keep SQLite open until all four
drains and all separately owned application work settle. Draining the dispatcher
alone does not join worker durable-write continuations.

S2 still needs HTTP application lifetime ownership, server socket/application
promise joining, x402 initialization ownership, facilitator retry fencing and a
shutdown coordinator that delays `store.close()` appropriately. S1 neither
closes SQLite nor changes `index.ts`. The synchronous production runtime sampler
continues to use its existing `stop()`.

Drain deliberately waits for already-dispatched operations; a provider promise
that never settles can keep shutdown pending. No forced cancellation or new
shutdown deadline is introduced in S1.

## Deterministic regression validation

On base/HEAD `d491ba862506bfe5c35ff36f7f381b11a2a1f766`, branch
`fix/background-drain-primitives`, the final uncommitted S1 changes passed:

- `pnpm -C apps/server test`: 534/534.
- Focused S1: 53/53 (26 provider, 16 poller, 11 reconciler).
- F02: 5/5 (success/failure completion clock exceptions, combined observer/logging
  exceptions, and normal queue pumping with a failed clock).
- Focused C3/B4: 85/85.
- Complete reconciler file: 94/94, including 12 C3 and 62 B4 tests.
- `pnpm -C apps/server run typecheck` and `pnpm typecheck`.
- `git diff --check`.

The new S1 tests use promise gates and injected clocks/timers, without timing
sleeps. They assert durable rows, claim/provider counts, queue/in-flight state,
retained evidence/telemetry, direct and scheduled ownership, restart behavior,
and administrative interruption without retry or provider-health penalties.

Validation used existing local dependencies from a checkout with an identical
lockfile, Node 24.14.0 and the bundled pnpm 11.19.0 fallback. Package-manager
auto-install was disabled (`pnpm_config_verify_deps_before_run=false`) and
offline mode enabled (`pnpm_config_offline=true`). An initial unexpected
auto-install attempt was blocked by the sandbox and stopped before these checks;
no registry download or service-provider access succeeded. Dependency versions
and the lockfile stayed unchanged; the server test script registers the new
suites. No commits, pushes, PRs, merges or deployments were made.
