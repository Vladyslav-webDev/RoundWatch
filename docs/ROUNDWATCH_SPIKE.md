# RoundWatch Spike 0

Date: 2026-09-14

Network: Algorand TestNet

Asset: TestNet USDC ASA 10458941

## Result

The narrow lifecycle hypothesis passed:

```text
HTTP 402
→ x402 service payment confirms
→ SQLite watch changes from settlement_pending to active
→ server stops
→ server restarts and reloads the active row
→ a separate future TestNet USDC transfer confirms
→ the recovered watch changes to matched
```

This is a technical spike, not a production RoundWatch implementation.

## What was tested

The spike adds a paid `POST /spike/watch` route and a free
`GET /spike/watch/:id` inspection route. A request describes exactly one future
transfer using:

- expected sender;
- expected receiver;
- fixed TestNet USDC ASA 10458941;
- exact atomic amount;
- optional exact UTF-8 note;
- an idempotency key.

The existing `GET /demo` price, network, discovery extension, response, and x402
configuration remain the regression baseline.

## Installed x402 lifecycle observed

The behavior below was verified against the installed packages, not inferred
from general documentation:

- `@x402/hono` 2.25.0;
- `@x402/core` 2.25.0;
- `@x402/avm` 2.25.0;
- `@x402-avm/extensions` 2.6.1;
- Hono 4.13.7.

The inspected `@x402/avm` server scheme declares `authorization` as the default
flow. In the installed `@x402/hono` middleware, a paid request is processed in
this order:

1. `processHTTPRequest` verifies the payment authorization.
2. Hono calls `await next()`, which executes the application handler.
3. The middleware rejects/cancels settlement if the handler throws or returns a
   status of 400 or greater.
4. For a successful handler response, the middleware buffers the response and
   calls `processSettlement`.
5. Only after successful settlement does it add `PAYMENT-RESPONSE` and return
   through outer middleware.

The installed core calls resource-server `onAfterSettle` hooks only after the
facilitator returns a settlement result with `success: true`. It calls
`onSettleFailure` for failed or thrown settlement outcomes. Hook exceptions are
logged and swallowed by the SDK, which matters to the activation design.

The relevant installed source inspected locally was:

- `apps/server/node_modules/@x402/hono/dist/esm/index.mjs`;
- `apps/server/node_modules/@x402/core/dist/esm/chunk-RAWLCYSQ.mjs`;
- `apps/server/node_modules/@x402/avm/dist/esm/exact/server/index.mjs`.

Therefore, handler execution is not trustworthy settlement evidence. The
successful `SettleResponse` supplied to `onAfterSettle`, including its
transaction ID and network, is the first trustworthy evidence available inside
this installed server lifecycle.

## Activation guard

The route handler validates the watch and inserts only a
`settlement_pending` row. It places the generated watch ID in an internal
response header so the settlement hook can correlate the result with that row.

The resource server's `onAfterSettle` hook:

1. checks that the transport context is `POST /spike/watch`;
2. reads the correlated watch ID;
3. records the successful service settlement transaction, network, payer, and
   current Indexer round when available;
4. changes the row to `active` with a guarded SQL update that only accepts
   `settlement_pending`.

An outer Hono middleware resumes after the x402 middleware completes and checks
the SQLite row. It does not return the successful resource response unless the
row is durably `active` (or already `matched`). If the SDK swallowed an
activation-hook error, this guard returns HTTP 500 while preserving the x402
settlement response headers.

Settlement failures change a still-pending row to `settlement_unknown`; they
never activate it. A unique idempotency key and unique service settlement
transaction prevent duplicate active rows. A retry using an existing key gets
HTTP 409 from the handler, so this authorization flow does not perform a second
settlement.

Invariant: no code path changes a watch to `active` before a successful x402
settlement result exists.

## Persistence and restart behavior

`RoundWatchStore` uses Node 24's built-in synchronous `node:sqlite` API and a
single table. SQLite WAL mode is enabled. The default file is
`apps/server/data/roundwatch.sqlite` when the server is launched through its
workspace script. No ORM or external database is used.

At startup, the poller queries the database for every `active` watch. There is
no in-memory-only registration to reconstruct, so a fresh process resumes from
the persisted `scan_after_round` value.

Node 24.14.0 still emits an experimental warning for `node:sqlite` in this
runtime. That is acceptable for the spike but must be reconsidered for a
production dependency decision.

## Algorand observation approach

The watcher polls an Algorand TestNet Indexer. At activation it records the
Indexer's current round. Each poll searches only later rounds for asset-transfer
transactions involving the expected sender, then locally requires all of:

- top-level transaction sender equals the expected sender;
- asset-transfer receiver equals the expected receiver;
- asset ID equals 10458941;
- atomic amount is exactly equal;
- decoded note is exactly equal when a note was requested.

The scan uses bounded `min-round` and `max-round` filters and follows Indexer
pagination tokens before advancing the durable cursor. Algorand's primary API
reference documents the asset transaction endpoint, round filters, address-role
filter, pagination, and oldest-to-newest ordering:

- <https://dev.algorand.co/reference/rest-api/indexer/operations/lookupassettransactions/>
- <https://dev.algorand.co/reference/rest-api/indexer/operations/searchfortransactions/>

This is intentionally one exact ASA-transfer matcher, not a general event
engine.

## Automated test procedure

From the repository root:

```powershell
pnpm -C apps/server test
pnpm typecheck
```

The focused tests verify:

- an unpaid spike request returns HTTP 402 and creates no row;
- the handler-created row is still `settlement_pending` when the facilitator's
  settle function begins;
- a successful settlement activates exactly one row;
- a duplicate idempotency key returns 409 without a second settle call;
- closing and reopening the SQLite database recovers the active watch;
- a poll with no match keeps the row active and advances its cursor;
- a later match changes the recovered row to `matched`;
- Indexer results with a wrong receiver or amount do not match;
- the exact sender, receiver, ASA, amount, and note do match;
- an unpaid `/demo` request still returns HTTP 402.

The facilitator and Indexer are controlled fakes in the focused tests so that
ordering and negative cases are deterministic. The live procedure below covers
the real installed AVM client, hosted facilitator, TestNet settlement, process
restart, Algorand node, and Indexer.

## Live TestNet procedure and observed evidence

The split verification client deliberately creates a restart checkpoint that
contains only public watch data, never a mnemonic or private key.

Terminal 1:

```powershell
pnpm dev:server
```

Terminal 2:

```powershell
pnpm -C apps/client run spike:roundwatch:prepare
```

After the prepare command reports an active durable watch, stop Terminal 1,
start `pnpm dev:server` again, and then run:

```powershell
pnpm -C apps/client run spike:roundwatch:pay
```

The live run on 2026-09-14 observed:

- unpaid spike request: HTTP 402;
- service settlement transaction:
  `VHIPEH5UT2SL4MQI3DHRJXOD6IS4ZZCXGOPBE74GGWF3CMGGP2MA`;
- the first server process was stopped after the watch became active;
- a fresh server process read the existing SQLite database;
- separate 1-atomic-unit TestNet USDC invoice transaction:
  `DSAIDN5PR4BJII7K276D5ZANL7B22NQNTFLR63UESYM4ENCXEIEQ`;
- invoice confirmation round: `67293978`;
- the restarted watcher changed the recovered row to `matched` with that same
  transaction ID and round.

No MainNet transaction or real-value payment was performed.

## What was proven

- The installed middleware does execute the handler before final settlement.
- A handler can safely prepare durable state without activating it.
- Successful settlement can activate the correlated row using confirmed
  settlement evidence.
- The row and its scan cursor survive a real process stop/restart.
- A separate later TestNet USDC transfer can be detected after restart.
- Exact negative/positive matching and duplicate-row behavior work in focused
  tests.
- The full narrow chain works against the hosted GoPlausible facilitator and
  Algorand TestNet.

## What was not proven and production risks

- External chain settlement and the SQLite commit are not atomic. A crash after
  the facilitator settles but before the hook commits can leave
  `settlement_pending`. This spike deliberately fails closed; it does not store
  enough signed-payment data to reconcile that crash window on restart.
- If the Indexer round lookup fails during activation, the row is active without
  a scan cursor. The first successful poll establishes a current-round baseline,
  which can miss a transfer made between activation and that baseline.
- Indexer lag, outages, reorg behavior, archival retention, and adversarial
  pagination volume were not stress-tested.
- The poller is a single-process timer with sequential scans. Concurrency,
  leasing, horizontal replicas, backpressure, and operational monitoring were
  not tested.
- Address validation is deliberately lightweight for the spike and is not a
  substitute for production Algorand checksum validation.
- Authentication, authorization, privacy controls, API hardening, callbacks,
  retries, refunds, MainNet behavior, and every other stated product non-goal
  remain unimplemented.

## Viability conclusion

RoundWatch's core lifecycle appears technically viable on the existing x402 and
Algorand baseline. The narrow hypothesis passes because activation can be tied
to confirmed settlement, persisted, recovered, and used to match a separate
future transfer. Production viability still requires explicit reconciliation
for the settlement/SQLite crash window and a durable observation architecture;
this spike does not claim to solve either.
