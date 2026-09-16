# RoundWatch security model

This document describes the implemented boundaries and controls. It is not a claim of formal verification, an SLA, or unlimited production capacity.

## Wallet and signer boundary

RoundWatch never needs the payer's mnemonic or private key. The payer restores and uses its signer in the client process, then sends only the signed x402 payment payload. The server is configured with its public Algorand receiver address (`AVM_ADDRESS`) and does not sign wallet transactions.

The guarded MainNet utility under `apps/client` is an operator tool, not server runtime code. Production hosting must not receive `AVM_MNEMONIC`, a recovery phrase, a wallet export, or a private key.

## Secret handling

- Never commit mnemonics, private keys, recovery phrases, wallet exports, API secrets, or funded environment files.
- Root and workspace `.gitignore` rules exclude `.env` and `.env.*` while allowing `.env.example`.
- CI rejects any tracked `.env` or `.env.*` file except `.env.example`.
- CI checks out full Git history and runs Gitleaks v8.29.1 over that history with redaction enabled.
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
- watch TTL and global/per-payer capacity values are finite positive integers; and
- `ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1` is rejected on MainNet.

These guards reduce accidental cross-network or ephemeral production operation. They do not authenticate the configured external services or prove that an arbitrary URL serves the intended network; operators must still review configuration.

## Durable storage requirement

MainNet requires an explicit absolute SQLite path on persistent storage. Production uses `/data/roundwatch.sqlite` on a Render persistent disk. The database, `-wal`, and `-shm` files must remain on the same persistent filesystem.

An ephemeral or lost database can lose paid watch obligations. A rolled-back database can also rewind scan cursors. Backups, restore tests, disk monitoring, and controlled migrations are operator responsibilities.

## Service-payment verification and reconciliation

The x402 resource server delegates authorization verification and settlement to the configured GoPlausible facilitator. The application handler executes before final settlement, so RoundWatch does not treat handler execution as proof of payment.

For MainNet, the handler must successfully decode the verified AVM payment and persist its deterministic Algorand transaction ID, network, and payer before it prepares the watch. Missing or malformed settlement identity fails closed.

After facilitator settlement:

1. the settlement transaction, network, and payer are checked against the prepared identity;
2. an Indexer round must be acquired before normal activation; and
3. that round becomes both the activation round and initial scan cursor.

If the process stops or the round lookup fails, the watch remains non-active and recoverable. The reconciler looks up only the prepared transaction ID and activates only when all applicable fields match:

- transaction ID;
- configured network;
- service receiver;
- network-selected USDC ASA;
- exact `1000` atomic-unit service amount; and
- prepared payer, when available.

An absent transaction remains an ambiguous, retryable outcome. A found on-chain transfer with a definitive mismatch is marked terminal and remains fail-closed in public state `settlement_unknown`.

## Future-payment matching

An active watch has a safe `scanAfterRound` baseline. RoundWatch considers only confirmed USDC asset transfers in later rounds. A match requires exact equality across:

- sender;
- receiver;
- server-selected asset ID;
- decimal-free atomic amount string; and
- decoded UTF-8 invoice note, if the watch specified one.

The request parser accepts only checksum-valid addresses and positive integer amounts no larger than `Number.MAX_SAFE_INTEGER`. Notes are limited to 128 UTF-8 bytes. The Indexer client also rejects malformed or non-integer transaction data before comparison.

If a poll lookup fails, that watch's cursor is not advanced. The error is isolated so later watches are still evaluated. If a watch somehow lacks a scan baseline, the poller refuses cursorless scanning.

Each new watch persists a server-controlled `expiresAt` equal to `createdAt + 30 minutes`. Elapsed unfinished watches transition to terminal state `expired` through SQLite before active or reconciliation lists are returned and before later state changes are accepted. They remain readable but cannot generate further Indexer work. A successful `matched` result and a definitive terminal settlement mismatch are not overwritten by expiry.

## Idempotency and duplicate-purchase protection

Each watch requires an 8–128 character idempotency key, stored under a SQLite unique constraint. A repeated key returns HTTP `409` with the existing public watch. Because the handler response is an error, the normal x402 lifecycle does not settle another service payment for that duplicate request; this behavior is covered by the recovery workflow and tests.

Idempotency keys are global to the database and are not authentication credentials. The API returns the existing record for the key rather than replacing it or proving that a later caller owns it. Clients should use unguessable, obligation-specific values and retain their checkpoint locally.

## Capacity admission

The challenge-release limits are 50 open obligations globally and 5 per verified service payer. Open means `settlement_pending`, `active`, or non-terminal `settlement_unknown`; `matched`, `expired`, and definitive terminal mismatches do not count. The payer key comes from the deterministic verified AVM transaction identity, never a caller-supplied body field.

Expiry, capacity checks, and insertion run synchronously at the SQLite boundary, with the check and insert protected by an immediate transaction. Exhaustion returns HTTP `429` before the handler can return success. The installed after-handler x402 flow therefore cancels settlement and does not charge for the rejected watch. These limits bound the current persistent polling liability; they are not an SLA or a claim of arbitrary load capacity.

## MainNet client guard

The repository's MainNet runner is deliberately narrow:

- it accepts only the approved production base URL and HTTPS Algod URL;
- it validates checkpoint network, asset, receiver, sender, amount, invoice note, UUIDs, and watch response;
- it checks unpaid x402 requirements for resource URL, exact scheme, MainNet CAIP-2, amount, asset, payee, and challenge tag before signing;
- it refuses to start a second paid watch while its checkpoint exists; and
- every mode that may sign or spend (`start`, `recover`, or `pay`) requires `--confirm-mainnet`. `status` is read-only.

This runner is for explicitly authorized evidence collection, not routine health checking or CI. Automated tests use synthetic data and must never make MainNet payments.

## Availability and privacy assumptions

- The current service is a single instance with in-process workers and local SQLite. It has no multi-instance leader election or distributed queue.
- Availability depends on Render, its persistent disk, GoPlausible, the configured AlgoNode Indexer, and Algorand MainNet.
- The current 30-minute TTL and 50-global/5-per-payer admission limits are challenge-release operational policy, not an SLA or final commercial capacity policy.
- Watch status is unauthenticated. Anyone who knows a UUID can retrieve its record, including addresses, amounts, optional notes, settlement metadata, and transaction IDs.
- Algorand transfers and public addresses are already public, but an invoice note can add application-specific information. Do not place confidential or personal data in it.
- There is no cancellation or deletion API and no documented retention policy.
- Polling isolates individual failures but remains sequential within one process; this does not establish capacity for arbitrary load.

## Operational rules

- Keep production on a persistent database path and verify that the volume remains mounted after every deployment.
- Use free `/health`, unpaid HTTP 402, and existing-watch status checks for routine smoke testing.
- Do not run a paid MainNet test without explicit human authorization for that exact spend.
- Review payment requirements before signing; do not trust environment configuration alone.
- Treat database backup and restore as security-relevant because the database represents paid obligations and scan progress.
- Investigate repeated `settlement_unknown`, reconciliation mismatch, Indexer, or missing-baseline logs rather than forcing state transitions manually.
