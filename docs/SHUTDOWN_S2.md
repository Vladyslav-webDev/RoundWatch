# Shutdown S2: production lifetime coordination

The original production shutdown P1 is closed by this implementation. The change
is uncommitted and undeployed; the running production service has not been changed.

## Required implementation report

1. **BASE and HEAD.** Both are
   `4580fd8de830900d5d91dff8599f078cc9d2a664`. Branch:
   `fix/graceful-shutdown-coordinator`. Before editing, HEAD, branch, clean working
   tree, `AGENTS.md`, `docs/SHUTDOWN_S1.md`, and all four S1 contracts were checked.

2. **Files changed.** Production code: `apps/server/app.ts`, `index.ts`,
   `roundwatch-application-lifetime.ts`, `roundwatch-facilitator.ts`,
   `roundwatch-shutdown-coordinator.ts`, and `roundwatch-startup.ts`.
   Tests: `roundwatch-application-lifetime.test.ts`,
   `roundwatch-facilitator-shutdown.test.ts`, `roundwatch-http-shutdown.test.ts`,
   `roundwatch-shutdown-coordinator.test.ts`, and `roundwatch-startup.test.ts`.
   Configuration/documentation: `apps/server/package.json`,
   `apps/server/.env.example`, and this document. S1 primitives, SQLite schema,
   dependency versions and lockfile are unchanged.

3. **Installed x402 APIs.** Exact installed `@x402/hono` and `@x402/core` versions
   are **2.25.0**. `paymentMiddleware` constructs an `x402HTTPResourceServer` and
   delegates to public `paymentMiddlewareFromHTTPServer`. Its default eager
   initialization installs a background initialization handler; setting
   `syncFacilitatorOnStart=false` suppresses that initialization. Public
   `x402HTTPResourceServer.initialize()` awaits
   `x402ResourceServer.initialize()` and validates HTTP route configuration.
   The resource server loads facilitator capabilities and validates registered
   schemes. The installed `HTTPFacilitatorClient` exposes only `url`, `timeoutMs`
   and `createAuthHeaders` configuration, with no custom fetch/transport hook.

4. **Application ownership.** `ApplicationLifetime.track()` registers ownership
   synchronously before invoking its operation and retains it through promise
   settlement. `stopAdmission()` is permanent and synchronous; `drain()` returns
   a shared promise covering all admitted operations, regardless of success.
   `ownApplicationFetch()` forwards the complete adapter argument list and owns
   the Hono invocation. After the fence, it returns a bounded HTTP 503 with
   `cache-control: no-store` before entering any application middleware.

5. **Payment initialization.** `createAppRuntime()` uses the same registered AVM
   scheme, Bazaar extension, routes and settlement hooks as `createApp()`, but
   disables automatic synchronization and exposes a shared
   `initializePayments()` promise. Production constructs/initializes the runtime
   inside application ownership and awaits initialization before creating or
   listening on the server. Ordinary `createApp()` retains its previous defaults.

6. **Facilitator attempt fence.** `RoundWatchFacilitatorClient` implements the
   supported public `FacilitatorClient` interface locally. A terminal fence sits
   immediately before every injected fetch, after auth/body/signal callbacks.
   Capability 429 retries and manually followed redirect hops cross that same
   fence. The resource server's public secondary `settlement_pending` attempt
   calls the fenced client again. No stock transport, private method, global
   fetch replacement or dependency modification is used. Public stock config/auth
   validation, timeouts, wire bodies, BigInt conversion, response normalization,
   error classes and extension sidechannels are preserved.

7. **Coordinator.** `createShutdownCoordinator()` publishes one shared shutdown
   promise before invoking supplied callbacks. Signals, startup construction,
   payment initialization, listening/server errors and worker startup failures
   converge on it. Production registers cleanup immediately after SQLite exists,
   so partial synchronous resource construction is also covered.

8. **Exact synchronous order.** Shared shutdown latch -> application admission
   stop -> facilitator admission stop -> poller stopScheduling -> reconciler
   stopScheduling -> health probe stopScheduling -> dispatcher stopScheduling ->
   runtime sampler stop -> begin server close. All fences precede every drain
   join and any asynchronous wait. Rejected queued/backoff promises can only
   resume after this synchronous sequence finishes.

9. **Exact joins.** Actual server/listener/socket close, application drain
   (including explicit payment initialization), facilitator drain (including
   auth, body consumption and capability backoff), poller drain, reconciler
   drain, health probe drain and dispatcher drain. `Promise.allSettled` waits for
   all seven boundaries. The production sampler is synchronous and is stopped
   before these joins; no additional asynchronous store owner was found.

10. **Socket completion.** `closeNodeServer()` joins Node's close callback;
    issuing `close()` is insufficient. It does not short-circuit on
    `listening=false`, which can coexist with pending socket closure. The
    already-closed/not-running callback case is successful. Unexpected callback
    errors are settled failures; a synchronous close invocation failure supplies
    no completion proof and permanently forbids SQLite closure. Repetition is
    handled by the coordinator, so production issues close once.

11. **SQLite proof.** Only the coordinator's post-join callback calls
    `store.close()`, once. The old raw server `close` handler is removed. A normal
    owner rejection contributes a nonzero exit status but cannot bypass another
    owner. Failed admission fences or synchronous drain invocations leave
    ownership unproven, so the coordinator terminates nonzero without closing
    SQLite. `RoundWatchStore.close()` itself is unchanged.

12. **Deadline.** `ROUNDWATCH_SHUTDOWN_DEADLINE_MS` defaults to **25,000 ms**,
    following the task's specified default 30-second Render allowance. It must be
    a positive safe integer within Node's timer range (at most 2,147,483,647 ms).
    The production timer remains referenced; successful drainage clears it.
    Timing and termination are injectable for tests. No deployed platform grace
    configuration was inspected or changed.

13. **Expiry.** If drainage is incomplete, the timer names unresolved owners,
    reports that SQLite remains open, returns a failure result and invokes
    `process.exit(1)` in production. A sticky completion latch prevents later
    owner settlement from closing SQLite when test termination returns. There
    is no successful graceful result on expiry. Timer installation failure also
    terminates without claiming ownership completion.

14. **Disconnect.** Tests abort the request while the actual Hono/x402 promise is
    held, and independently complete the simulated socket close boundary. The
    application drain remains pending. Neither request abortion nor listener
    closure releases application ownership.

15. **Settlement/activation.** Held settlement can return after the fence and
    persist its valid candidate before SQLite closes. A subsequent activation
    acquisition is blocked; the durable pending obligation remains recoverable.
    A lookup already dispatched before shutdown can finish and persist activation
    and its scan boundary. Both scenarios are tested with and without request
    abortion, using actual Hono/x402, SQLite, dispatcher and Indexer code with
    fake transports. No post-close store access occurs.

16. **Provider retry fence.** Tests count actual fake transport invocations:
    queued/future Indexer work never starts; dependent capability requests stop;
    facilitator 429 retry, redirect and secondary settlement attempts cannot
    start after the fence. Initialization cannot retry after shutdown. Admitted
    facilitator response-body work is still drained.

17. **Startup failures.** Initialization gates prove no early listener or worker
    startup. Initialization rejection, synchronous create/listen failure and
    asynchronous server failure use the coordinator with nonzero status and
    retain all other owned work until settlement. Individual request/clientError
    events do not use the fatal server error path. Late listening and synchronous
    worker callback reentry cannot restart workers or announce successful startup.

18. **Signals/repetition.** SIGTERM and SIGINT use persistent handlers observing
    the same coordinator promise. Repeated signals and other initiators create
    no duplicate fences, drains, socket closes or SQLite closes. No second-signal
    escalation policy is introduced.

19. **Health/Observatory.** Existing S1 markStopped and retained observation
    semantics remain intact. Administrative acquisition interruption creates no
    fabricated provider failures. The sampler stops before joining and the
    Observatory remains passive. No public draining DTO is added.

20. **S1 compatibility.** All original terminal worker/provider primitives are
    unchanged. Focused S1/F02 tests: **53/53 passed** (26 provider, 16 poller,
    11 reconciler). Already-dispatched durable results and legitimate provider
    failure handling remain permitted while SQLite is open. No work refunds or
    worker-claim freshness changes are implemented. The optional F03 test area
    was not edited.

21. **C3/B4 compatibility.** Focused C3/B4 tests: **86/86 passed**, including
    existing application, reconciler and budget-backfill regressions. The
    underlying readiness, settlement, pagination, work-claim and schema behavior
    is unchanged.

22. **Deterministic S2 count.** **78/78 passed:** application lifetime 5;
    coordinator 30; facilitator/initialization 26; HTTP settlement/activation 5;
    startup/signals 12. Promise gates, fake transports, injected timers/clocks
    and fake termination supply the ordering evidence. No correctness assertion
    depends on a sleep. Rejected joins are observed without unhandled rejections.

23. **Full server count.** `pnpm -C apps/server test`: **612/612 passed**,
    zero failures, cancellations or skips.

24. **Focused results.** S2 78/78; S1/F02 53/53; C3/B4 86/86;
    existing settlement/activation name-filtered regressions 14/14; ordinary
    `roundwatch.test.ts` 145/145 (also included in the final full run).

25. **Typechecks.** `pnpm -C apps/server run typecheck` passed.
    `pnpm typecheck` passed for server, client and Observatory.

26. **Diff check.** `git diff --check` passed. Final HEAD and branch remain as
    recorded above. New source/tests/documentation are intentionally untracked
    and existing edits unstaged. There were no commits, pushes, PRs, merges,
    deployments, production configuration changes or provider accesses.

27. **Residual findings.** The local facilitator implementation must be reviewed
    against exact source/types when x402 is upgraded, because the installed
    client has no public per-attempt hook. An owner that never settles intentionally
    takes the nonzero deadline path with SQLite open. Any future asynchronous
    application actor must register ownership before starting. A changed platform
    grace allowance requires an appropriate configured application deadline.
    These are maintenance/operational constraints, not remaining P1 lifetime gaps.

28. **P1 conclusion.** **Fully closed by the implementation and deterministic
    offline evidence.** The checkout now prevents SQLite closure under unresolved
    admitted owners and rejects new application/provider acquisition after the
    synchronous fence. Production rollout remains outside this task.

## Offline validation provenance

Node **24.14.0** and the existing bundled pnpm **11.19.0** fallback were used.
Dependencies were borrowed through ignored local junctions from
`C:\Dev\x402-audit`, whose lockfile is identical. SHA-256 of the unchanged
`pnpm-lock.yaml`:
`87F41F1184DAA5F19A9AFB997D3E24401D28244B682309E0C14A3FFC4FAD3233`.
No installation or download was performed. Offline mode and automatic dependency
installation suppression were enabled. `pnpm_config_pm_on_fail=ignore` selected
the installed fallback rather than attempting to acquire the declared 12.3.4
package-manager version. Initial local resolution attempts failed in offline mode.

Exact installed dependency sources inspected:

- `apps/server/node_modules/@x402/hono/package.json` and
  `dist/esm/index.mjs` / `index.d.mts`.
- `apps/server/node_modules/@x402/core/package.json`,
  `dist/esm/server/index.mjs` / `index.d.mts`,
  `dist/esm/chunk-RAWLCYSQ.mjs`, and
  `dist/esm/x402Client-pTJv8yPe.d.mts`.
- `apps/server/node_modules/@hono/node-server/dist/index.mjs` / `index.d.mts`;
  public `createAdaptorServer` permits error/signal wiring before `listen()`.
- The local Node `net.Server.close` implementation and offline never-listened
  Node HTTP server tests, confirming callback completion semantics.

All MainNet/TestNet references in tests are static fixtures. No network,
facilitator, Algod, Indexer, Render or other external provider was accessed.
