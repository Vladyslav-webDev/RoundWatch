# RoundWatch production deployment runbook

RoundWatch is currently deployed on Render at `https://roundwatch-api.onrender.com`. This runbook separates the already-proven production baseline from the procedure for deploying a new version. It does not authorize a paid MainNet action.

## Proven production baseline

As of **2026-09-16**:

- Render serves the API over HTTPS;
- `ROUNDWATCH_NETWORK=mainnet` selects Algorand MainNet and Circle USDC ASA `31566704`;
- SQLite is stored at `/data/roundwatch.sqlite` on a persistent disk;
- `GET /health` returns `{ "status": "ok", "network": "mainnet" }`;
- unpaid `POST /v1/watch` advertises the correct MainNet x402 requirements;
- one explicitly authorized `0.001 USDC` service purchase settled on MainNet;
- its durable watch later matched a separate exact MainNet invoice transfer;
- Bazaar and challenge attribution were observed; and
- correctness-hardening merge commit `69afd9dc070a7f9c12206b038f117cc1f2b3fdb3` auto-deployed successfully, with the pre-existing matched watch unchanged afterward.

No second paid E2E was run after the correctness patch. Routine deployment verification should remain free.

## Container and process model

The root `Dockerfile` uses Node 24.14.0 and pnpm 12.3.4, installs the frozen workspace lockfile, and starts `apps/server` through `tsx`. The container exposes port 4021 and has an internal `/health` health check.

The hosting platform terminates HTTPS and supplies `PORT`. One application process runs the API, settlement reconciler, watch poller, and local SQLite connection. Do not scale this image horizontally without first designing shared durable state and worker coordination.

## Required MainNet environment

```env
ROUNDWATCH_NETWORK=mainnet
AVM_ADDRESS=EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY
FACILITATOR_URL=https://facilitator.goplausible.xyz
ROUNDWATCH_PUBLIC_BASE_URL=https://roundwatch-api.onrender.com
ALGORAND_INDEXER_URL=https://mainnet-idx.algonode.cloud
ROUNDWATCH_DB_PATH=/data/roundwatch.sqlite
ROUNDWATCH_POLL_INTERVAL_MS=5000
ROUNDWATCH_RECONCILE_INTERVAL_MS=5000
ROUNDWATCH_WATCH_TTL_MS=1800000
ROUNDWATCH_MAX_OPEN_WATCHES=50
ROUNDWATCH_MAX_OPEN_WATCHES_PER_PAYER=5
ROUNDWATCH_WORK_UNIT_BUDGET=500
ROUNDWATCH_INDEXER_REQUESTS_PER_SECOND=4
ROUNDWATCH_INDEXER_BURST=4
ROUNDWATCH_INDEXER_CONCURRENCY=2
ROUNDWATCH_SCAN_ROUND_WINDOW=100
ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES=16
ROUNDWATCH_SCAN_PAGE_CACHE_BYTES=8388608
ROUNDWATCH_SCAN_QUERY_VARIANT=C
ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=0
PORT=<platform-provided port or 4021>
```

`ALGORAND_INDEXER_URL`, worker intervals, watch TTL, capacity/work limits, dispatcher rate/burst/concurrency, finite scan round window, historical cache entry/payload-byte limits, scan strategy, fault switch, and port have code defaults, but production should keep intended values explicit and reviewable. Dispatcher/window/cache values are operational tuning, not public SLAs.

Never set `AVM_MNEMONIC`, a private key, a recovery phrase, or a wallet export on the server. The resource server receives the signed x402 payload and needs only its public receiver address.

## Startup guards

MainNet startup fails closed when:

- `AVM_ADDRESS` is absent or not a checksum-valid Algorand address;
- `ROUNDWATCH_NETWORK` is neither `mainnet` nor `testnet`;
- `ROUNDWATCH_DB_PATH` is absent or relative;
- the facilitator or Indexer URL is not absolute HTTPS;
- `ROUNDWATCH_PUBLIC_BASE_URL` is absent, non-HTTPS, loopback, or contains credentials, a query, or a fragment;
- the configured MainNet Indexer URL visibly names TestNet; or
- the watch TTL, round window, dispatcher settings, or either capacity limit is not finite and positive; or
- the TestNet-only exit-after-settlement fault switch is enabled.

The default network is TestNet. Production must set MainNet explicitly; hostnames do not select a network.

## Persistent disk

Mount a persistent disk at `/data` and set:

```text
ROUNDWATCH_DB_PATH=/data/roundwatch.sqlite
```

SQLite WAL mode is enabled. Keep `roundwatch.sqlite`, `roundwatch.sqlite-wal`, and `roundwatch.sqlite-shm` on the same filesystem. Replacing, detaching, rolling back, or mounting an empty disk can lose paid obligations or scan progress.

Before a storage change:

1. identify the exact production database and disk;
2. stop writes or otherwise obtain a consistent SQLite backup;
3. retain a recoverable copy;
4. restore into the intended persistent path; and
5. verify existing watch IDs before resuming normal operation.

## Routes

Production exposes:

```text
GET  /health
POST /v1/watch
GET  /v1/watch/:id
GET  /demo
```

Production `/v1/watch` is priced at `0.02 USDC` (`20000` atomic units), advertises MainNet Circle USDC ASA `31566704`, and includes Bazaar discovery metadata with challenge tag `x402-global-challenge`. This contract was externally confirmed after the 2026-09-20 Economics v1 deployment with an unsigned HTTP `402` preflight.

The challenge-release policy gives each accepted watch a chain-time eligibility deadline 30 minutes from durable creation and an immutable 500-turn durable background work budget, with at most 50 unfinished obligations globally and 5 per verified service payer. Wall time alone does not expire it; validated chain coverage through a fixed closing checkpoint does. Work-budget exhaustion terminates as `indeterminate`, never as a fabricated `expired`. Capacity exhaustion returns HTTP `429` before x402 settlement. These values are operational safeguards, not a commercial SLA.

TestNet is a separate configuration and uses `/spike/watch`. Do not use a TestNet route or asset as a production smoke-test substitute.

## Deploying a new version safely

### 1. Verify the candidate locally or in CI

Confirm the exact commit and run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm -C apps/server test
pnpm -C apps/client test
docker build -t roundwatch-candidate .
```

Also require the repository CI checks: full-history Gitleaks, tracked `.env` rejection, typechecks, server tests, client safety tests, and container build.

None of these commands needs a wallet or makes a payment.

### 2. Review production configuration

Before deployment, verify:

- the network is explicitly `mainnet`;
- the receiver, facilitator, public base URL, Indexer, ASA implied by network config, and service price match the approved production values;
- the watch TTL is `1800000`, durable work budget is `500`, global capacity is `50`, and per-payer capacity is `5`;
- `/data` is still mounted and the database path has not changed;
- the deployment remains single-instance; and
- no mnemonic/private key has been added to the service environment.

If the release changes persisted fields or storage behavior, take a consistent backup and document the migration/rollback plan before rollout.

### 3. Deploy without replacing the disk

Deploy the reviewed image or commit through Render's normal deployment path. Preserve the existing service, region, persistent disk mount, environment variables, and single-instance topology unless a separately reviewed infrastructure change requires otherwise.

Observe startup logs for the selected network, USDC ASA, Indexer URL, and SQLite path. Investigate startup failures; do not bypass the guards.

Schema migrations are idempotent. Legacy rows retain evidence version 0: missing validity ranges, purchase terms, deadlines, closing checkpoints, and coverage are not fabricated. Historical matched rows remain unchanged; ambiguous legacy rows remain unresolved. Preserve a consistent database backup before deployment and verify the known matched watch afterward.

### 4. Run free post-deploy smoke checks

Health:

```bash
curl -i https://roundwatch-api.onrender.com/health
```

Expected body:

```json
{
  "status": "ok",
  "network": "mainnet"
}
```

Unpaid x402 preflight:

```bash
curl -i -X POST https://roundwatch-api.onrender.com/v1/watch \
  -H "content-type: application/json" \
  --data '{"idempotencyKey":"smoke-readonly-20260916","expectedSender":"3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ","expectedReceiver":"EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY","atomicAmount":"1"}'
```

Do not attach a payment signature. The expected production result is HTTP `402` with requirements for the exact HTTPS resource URL, Algorand MainNet CAIP-2, `exact` scheme, ASA `31566704`, amount `20000`, approved service receiver, and `x402-global-challenge` tag. A response advertising a different amount is a production-contract regression and should block release acceptance.

Also decode the `payment-required` header and inspect the Bazaar discovery example. Both `expectedSender` and `expectedReceiver` must be checksum-valid Algorand addresses. The current receiver example is `AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI`. Discovery examples are not payment authority, but malformed examples can break autonomous clients before they ever reach settlement.

Persistence check:

```bash
curl -i https://roundwatch-api.onrender.com/v1/watch/7c606f02-0257-4dfd-b59c-a13b61f480f0
```

Confirm the known watch remains `matched` with transaction `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA` at round `65096073`. This is a free read and verifies the expected persistent database is mounted.

Finally, inspect logs for reconciliation mismatches, missing scan baselines, repeated Indexer failures, or database errors.

## Paid MainNet verification policy

Do not make a payment for routine deployment verification. The production path already has dated paid evidence, while health, unpaid 402 inspection, and existing-watch retrieval cover normal smoke testing without spending funds.

A new paid MainNet run requires explicit human authorization for that exact run. Before authorizing it, record why existing evidence and free checks are insufficient, review the maximum spend and network fees, and use the dedicated minimum-funded payer.

The repository runner enforces `--confirm-mainnet` for `start`, `recover`, and `pay`, restricts the production URL and expected receiver, validates payment requirements before signing, and validates its durable checkpoint. The flag is a final acknowledgement, not a replacement for human review.

If an authorized run occurs, record the service transaction, watch ID, later invoice transaction, confirmed rounds, and independent Indexer verification. Never paste or log the mnemonic.

## Settlement recovery operations

The reconciler automatically handles a process stop between on-chain settlement and SQLite activation. It looks up the deterministic prepared transaction ID and activates only when receiver, ASA, amount, network, and payer checks pass. It uses the confirmed settlement round as the safe scan baseline.

Operational response:

- if a transaction is not found, allow normal reconciliation retries and check Indexer health;
- if a definitive mismatch is logged, preserve the database and logs for investigation; do not force the row active;
- if a watch lacks a scan baseline, the poller intentionally refuses to scan it; and
- do not delete an idempotency row to retry a purchase without first determining whether settlement occurred.

## Rollback

Application rollback must preserve the current persistent disk. Verify that the target version can read the existing schema and retains the settlement-reconciliation fields before deploying it. After rollback, repeat all free smoke checks, including retrieval of the known matched watch.

Do not restore an older database snapshot merely to match older code without accounting for every watch and scan cursor created since that snapshot.
