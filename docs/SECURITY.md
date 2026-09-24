# RoundWatch security model

This document describes the implemented boundaries and controls. It is not a claim of formal verification, an SLA, or unlimited production capacity.

## Verification baseline

The remediation cycle completed on 2026-09-24 with an independent targeted
re-test of the previously reproduced release blockers against exact commit
`4e291168ffee803ce663833608caa4fd1ea771f7`. All previously identified release
blockers in that targeted scope were verified closed. The exact scope, test
counts, operational Render readiness state, critical-core change policy, and
future audit triggers are recorded in
[SECURITY_VERIFICATION_BASELINE_2026-09-24.md](SECURITY_VERIFICATION_BASELINE_2026-09-24.md).

That verification is a revision-specific evidence checkpoint, not a claim that
future revisions inherit the result automatically.

## Wallet and signer boundary

RoundWatch never needs the payer's mnemonic or private key. The payer restores and uses its signer in the client process, then sends only the signed x402 payment payload. The server is configured with its public Algorand receiver address (`AVM_ADDRESS`) and does not sign wallet transactions.

The guarded MainNet utility under `apps/client` is an operator tool, not server runtime code. Production hosting must not receive `AVM_MNEMONIC`, a recovery phrase, a wallet export, or a private key.

## Secret handling

- Never commit mnemonics, private keys, recovery phrases, wallet exports, API secrets, or funded environment files.
- Root and workspace `.gitignore` rules exclude `.env` and `.env.*` while allowing `.env.example`.
- CI rejects any tracked `.env` or `.env.*` file except `.env.example`.
- CI checks out full Git history and runs Gitleaks v8.29.1 over that history with redaction enabled.
- CI uses read-only repository permissions, pins third-party GitHub Actions and the Gitleaks container by immutable revisions, and audits production dependencies for High/Critical advisories.
- Dependabot monitors npm/pnpm dependencies and GitHub Actions for updates.
- Examples contain public addresses and transaction IDs only. Public blockchain identifiers are not secrets.
- Client `.env` files should use the minimum-funded, network-appropriate account and remain local.

Passing the current-tree check is not a substitute for history scanning: a secret removed from the latest tree can still exist in an earlier commit. Both controls are intentional.

## Explicit network and startup guards

Local omission of `ROUNDWATCH_NETWORK` defaults to `testnet`. MainNet is entered only by setting `ROUNDWATCH_NETWORK=mainnet`; the server does not infer it from the host or receiver.

Startup validates:

- `AVM_ADDRESS` is a checksum-valid Algorand address;
- `ROUNDWATCH_NETWORK` is exactly `testnet` or `mainnet` when supplied;
- MainNet `ROUNDWATCH_DB_PATH` is present and absolute;
- MainNet facilitator and Indexer URLs use HTTPS;
- MainNet `ROUNDWATCH_PUBLIC_BASE_URL` is present, absolute, HTTPS, free of credentials/query/fragment, and non-loopback;
- a MainNet Indexer URL does not visibly point at TestNet; and
- watch TTL, round-window, dispatcher rate/burst/concurrency, and global/per-payer capacity values are finite positive values; and
- `ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1` is rejected on MainNet.

These guards reduce accidental cross-network or ephemeral production operation. They do not authenticate the configured external services or prove that an arbitrary URL serves the intended network; operators must still review configuration.

## Durable storage requirement

MainNet requires an explicit absolute SQLite path on persistent storage. Production uses `/data/roundwatch.sqlite` on a Render persistent disk. The database, `-wal`, and `-shm` files must remain on the same persistent filesystem.

An ephemeral or lost database can lose paid watch obligations. A rolled-back database can also rewind scan cursors. Backups, restore tests, disk monitoring, and controlled migrations are operator responsibilities. The concrete challenge-release procedure is documented in [OPERATIONS.md](OPERATIONS.md); copying only the live main SQLite file while WAL data exists is explicitly not considered a valid backup.

## Service-payment verification and reconciliation

The x402 resource server delegates authorization verification and settlement to the configured GoPlausible facilitator. The application handler executes before final settlement, so RoundWatch does not treat handler execution as proof of payment.

For MainNet, the handler must successfully decode the verified AVM payment and persist its deterministic Algorand transaction ID, network, and payer before it prepares the watch. Missing or malformed settlement identity fails closed.

After facilitator settlement:

1. the settlement transaction, network, and payer are checked against the prepared identity;
2. the exact settled transaction must be confirmed by the Indexer; and
3. that transaction's confirmed round becomes both the activation round and initial scan cursor.

If the process stops or the round lookup fails, the watch remains non-active and recoverable. The reconciler looks up only the prepared transaction ID and activates only when all applicable fields match:

- transaction ID;
- configured network;
- service receiver;
- network-selected USDC ASA;
- exact `20000` atomic-unit service amount; and
- prepared payer, when available.

An absent transaction remains an ambiguous, retryable outcome. A found on-chain transfer with a definitive mismatch is marked terminal and remains fail-closed in public state `settlement_unknown`. Public watch records expose `settlementReconciliationTerminal`, so callers can distinguish a retryable unknown from a final reconciliation outcome without relying on a private database flag.

## Future-payment matching

An active watch has a safe `scanAfterRound` baseline. RoundWatch considers only confirmed **top-level direct USDC asset-transfer transactions** in later rounds. A match requires exact equality across:

- sender;
- receiver;
- server-selected asset ID;
- decimal-free atomic amount string; and
- decoded UTF-8 invoice note, if the watch specified one.

Inner asset transfers, clawback transfers (`asset-transfer-transaction.sender`), and asset close-out transfers (`close-to`) are outside the RoundWatch payment contract and never count as a match. Indexer search may return a parent transaction when an inner transaction satisfies the query; structurally valid parent results are therefore ignored deliberately instead of being misclassified as direct payments. Search requests also set `exclude-close-to=true` so close destinations are not treated as ordinary receivers.

The request parser accepts only checksum-valid addresses and positive integer amounts no larger than `Number.MAX_SAFE_INTEGER`. Notes are limited to 128 UTF-8 bytes. Each Indexer HTTP response body is capped at 8 MiB before JSON parsing, and continuation tokens are capped at 4 KiB before they can enter pagination/session state. Declared-oversize, allowed-404, and other non-OK responses explicitly cancel any unconsumed body before the dispatcher slot is released; streamed overflow already cancels its reader. Each Indexer page requires typed transactions, an adequate `current-round`, in-range confirmed rounds, well-formed classification fields, and a non-stalling continuation token before it can contribute coverage. A malformed envelope, oversized body/token, or unexplained non-`axfer` result fails closed and cannot advance coverage.

If any page, checkpoint, or watermark validation fails, the cursor is not advanced. Pagination tokens are process-local; restart replays the unfinished finite round window. Conditional cursor updates prevent stale work from moving coverage backward or skipping a range.

Each new watch persists `expiresAt = createdAt + 30 minutes`. The 30-minute duration is advertised before purchase, and `createdAt` is fixed when the durable watch is prepared before x402 settlement completes. Settlement delay therefore consumes part of the advertised eligibility window. Eligibility has two strict chain boundaries: `confirmed-round > activationRound` and `round-time < expiresAt`. Therefore a watched invoice in the service-payment activation round is ineligible, and a block timestamp exactly equal to `expiresAt` is also ineligible. These rules are published in OpenAPI/x402 metadata, llms.txt, MCP service/preparation metadata, and the x402 challenge description. This is an exclusive chain-time eligibility boundary, not a wall-clock state transition. Expiry requires a fixed indexed block timestamped at or after the deadline plus complete validated coverage through that closing round. Status/idempotency reads have no expiry side effects, and Indexer lag or failure leaves the watch unresolved.

Every Indexer HTTP attempt, including pagination, activation, reconciliation, absence proof, health, block lookup, failure, and timeout, passes through one finite token bucket and aggregate concurrency gate. Tokens are capped at the configured burst, so delayed timers and restart cannot accumulate unlimited capacity. Dispatcher token exhaustion only delays work and never proves absence, coverage, expiry, or nonpayment.

Separately, each purchased watch has an immutable durable budget of 500 background work turns. A turn is claimed before polling or reconciliation work. If that per-watch budget is exhausted before a match or complete expiry proof, the store atomically terminates the watch as `indeterminate` with `terminalReason=work_budget_exhausted`. This is a bounded-obligation safety outcome, not evidence that the watched payment did not occur.

## Idempotency and duplicate-purchase protection

Each watch requires an 8–128 character idempotency key, stored under a SQLite unique constraint. A repeated key returns HTTP `409` with the existing public watch. Because the handler response is an error, the normal x402 lifecycle does not settle another service payment for that duplicate request; this behavior is covered by the recovery workflow and tests.

Idempotency keys are global to the database and are not authentication credentials. The API returns the existing record for the key rather than replacing it or proving that a later caller owns it. Clients should use unguessable, obligation-specific values and retain their checkpoint locally.

## Capacity admission

The challenge-release limits are 50 open obligations globally and 5 per verified service payer. Open means `settlement_pending`, `active`, or non-terminal `settlement_unknown`; `matched`, `expired`, `indeterminate`, and definitive terminal mismatches do not count. The payer key comes from the deterministic verified AVM transaction identity, never a caller-supplied body field.

Capacity checks and insertion run synchronously at the SQLite boundary under an immediate transaction. Exhaustion returns HTTP `429` before the handler can return success. These limits and the Indexer dispatcher bound persistent and external work; they are not an SLA.

## MainNet client guard

The repository's MainNet runner is deliberately narrow:

- it accepts only the approved production base URL and HTTPS Algod URL;
- it validates checkpoint network, asset, receiver, sender, amount, invoice note, UUIDs, and watch response;
- it checks the unpaid x402 preflight and independently revalidates the fresh challenge selected at the actual payment-creation boundary for resource URL, exact scheme, MainNet CAIP-2, amount, asset, payee, challenge tag, and authorization flow before signing;
- it caps the x402 client itself at the approved `0.02 USDC` service spend;
- it refuses to start a second paid watch while its checkpoint exists;
- `recover` uses a free existing-watch lookup, does not load a wallet signer, and cannot create or settle a new watch; exact unresolved matches return explicit retryable/terminal reconciliation metadata without disclosing a watch ID; and
- only modes that can spend (`start` and `pay`) require `--confirm-mainnet`. `status` and `recover` are non-spending.

This runner is for explicitly authorized evidence collection, not routine health checking or CI. Automated tests use synthetic data and must never make MainNet payments.

## Availability and privacy assumptions

- `GET /health` is a liveness signal only. `GET /ready` is the paid-traffic readiness signal. Storage readiness is a cached real SQLite write/rollback probe rather than a read-only schema query; production readiness also requires fresh successful poller/reconciler cycles and a configured database-filesystem free-space floor. New paid watch creation fails with HTTP 503 before x402 verification while readiness is red.
- Watch-specific HTTP responses use `Cache-Control: no-store` so intermediary/browser caches are not asked to retain evolving payment metadata.
- The current service is a single instance with in-process workers and local SQLite. It has no multi-instance leader election or distributed queue.
- Availability depends on Render, its persistent disk, GoPlausible, the configured AlgoNode Indexer, and Algorand MainNet.
- The current 30-minute eligibility deadline, 500-turn work budget, and 50-global/5-per-payer admission limits are challenge-release operational policy, not an SLA or final commercial capacity policy.
- Watch status is unauthenticated. Anyone who knows a UUID can retrieve its record, including addresses, amounts, optional notes, settlement metadata, and transaction IDs.
- Algorand transfers and public addresses are already public, but an invoice note can add application-specific information. Do not place confidential or personal data in it.
- There is no cancellation or deletion API. The documented challenge-release retention policy is to keep terminal rows until deliberate operator maintenance; a finite commercial retention/deletion policy remains future work.
- Polling isolates individual failures but remains sequential within one process; this does not establish capacity for arbitrary load.
- Anonymous MCP and free recovery POSTs have independent process-local rate/concurrency admission before body parsing. Body byte caps remain separate from upstream/proxy connection timeouts.
- MCP dispatch rejects malformed request IDs/params/_meta, conflicting version signals, unsupported explicit versions, and tool arguments that violate the advertised object schemas. Modern unsupported-version requests use MCP error code `-32022` with requested/supported version data; JSON-RPC notifications never receive a JSON-RPC result body.

## Operational rules

- Keep production on a persistent database path and verify that the volume remains mounted after every deployment.
- Treat `/health` as liveness only and require `/ready` before directing paid traffic.
- Use free `/health`, `/ready`, unpaid HTTP 402, and existing-watch status checks for routine smoke testing.
- Follow [OPERATIONS.md](OPERATIONS.md) for consistent backup/restore drills, disk monitoring, retention, and incident handling.
- Do not run a paid MainNet test without explicit human authorization for that exact spend.
- Review payment requirements before signing; do not trust environment configuration alone.
- Treat database backup and restore as security-relevant because the database represents paid obligations and scan progress.
- Investigate repeated `settlement_unknown`, reconciliation mismatch, Indexer, or missing-baseline logs rather than forcing state transitions manually.
