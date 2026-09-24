<p align="center">
  <img src="https://roundwatch.observer/roundwatch-og.jpg" alt="RoundWatch — durable Algorand payment monitoring" width="900" />
</p>

<h1 align="center">RoundWatch</h1>

<p align="center">
  <strong>Durable Algorand USDC payment monitoring for autonomous x402 workflows.</strong>
</p>

<p align="center">
  <a href="https://roundwatch.observer/">Website</a> ·
  <a href="https://roundwatch.observer/start">Quickstart</a> ·
  <a href="https://roundwatch.observer/algorand-payment-monitoring-api">Technical guide</a> ·
  <a href="https://roundwatch-api.onrender.com/">Live API</a> ·
  <a href="https://roundwatch-api.onrender.com/openapi.json">OpenAPI</a> ·
  <a href="https://roundwatch-api.onrender.com/llms.txt">llms.txt</a> ·
  <a href="server.json">MCP Registry</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a>
</p>

<p align="center">
  <a href="https://github.com/Vladyslav-webDev/RoundWatch/actions/workflows/ci.yml">
    <img src="https://github.com/Vladyslav-webDev/RoundWatch/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" />
  </a>
  <img src="https://img.shields.io/badge/Algorand-MainNet-000000" alt="Algorand MainNet" />
  <img src="https://img.shields.io/badge/x402-v2-6f42c1" alt="x402 v2" />
  <img src="https://img.shields.io/badge/USDC-ASA%2031566704-2775CA" alt="Circle USDC ASA 31566704" />
  <img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT license" />
</p>

RoundWatch watches **one exact future Algorand MainNet USDC payment when no transaction ID exists yet**. A caller defines the expected payment, pays a one-time x402 service fee, receives a durable watch ID, and can exit. RoundWatch persists the obligation and scan progress, then exposes verified on-chain evidence for later retrieval.

**Production:** Algorand MainNet · Circle USDC · x402 v2 · GoPlausible facilitator · Bazaar metadata live (catalog visibility under requalification) · remote MCP endpoint · durable restart recovery.

## What it solves

A short-lived agent, job, or service may need to know whether a particular payment arrives after the caller has stopped running. Keeping that caller alive to poll an Algorand Indexer is unnecessary if a durable observer can own the wait instead.

RoundWatch lets a caller define the expected payment, purchase one watch through x402, and exit. The service persists the obligation, continues scanning Algorand, and records the matching transaction for later retrieval.

A backend that already operates durable Indexer or subscriber infrastructure may reasonably implement this itself. RoundWatch is for callers that do not want to own that operational component.

## Lifecycle

1. The client submits the exact expected sender, receiver, atomic amount, and optional invoice note.
2. x402 returns payment requirements and the client signs the service payment locally.
3. GoPlausible verifies and settles the service payment.
4. RoundWatch activates the persisted watch only after the exact service-payment transaction is confirmed; that transaction's confirmed round becomes the scan baseline.
5. The caller may exit while RoundWatch polls the Algorand Indexer.
6. The watch becomes `matched` when an exact future USDC asset transfer appears.
7. The caller reads the durable result with `GET /v1/watch/:id`.

See [Architecture](docs/ARCHITECTURE.md) for the normal, recovery, and matching paths.

See [Operations](docs/OPERATIONS.md) for readiness, backup/restore, retention, and incident procedures.

See [Roadmap](ROADMAP.md) for the current product direction and prioritization.

## Live production service

| Property | Current value |
| --- | --- |
| API | `https://roundwatch-api.onrender.com` |
| Create a watch | `POST /v1/watch` |
| Read a watch | `GET /v1/watch/:id` |
| Liveness | `GET /health` |
| Readiness | `GET /ready` |
| Network | Algorand MainNet |
| CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Asset | Circle USDC, ASA `31566704` |
| Service price | `0.02 USDC` (`20000` atomic units) |
| Service receiver | `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY` |
| Facilitator | `https://facilitator.goplausible.xyz` |
| Hosting | Render, with persistent SQLite storage mounted at `/data` |
| Eligibility deadline | 30 minutes from durable creation; terminal `expired` requires complete validated chain coverage through a fixed closing checkpoint |
| Work budget | 500 durable background work turns per watch; exhaustion terminates as `indeterminate`, never as `expired` |
| Open-obligation capacity | 50 globally; 5 per verified service payer |

The production server does not contain or need a wallet mnemonic or private key.

> Economics v1 is live in production as of 2026-09-20 at `80ed94c746f2eac4a784a3738c6dbe8306ecfa3e`. An external unsigned `POST /v1/watch` received HTTP `402` and verified MainNet, `exact`, ASA `31566704`, the approved receiver, challenge tag, and amount `20000`. The historical paid MainNet proof below remains evidence of the earlier `0.001 USDC` contract.

## API

### Health and readiness

`GET /health` is liveness only. Use `GET /ready` to decide whether the durable service is ready for paid traffic. Render's platform health check must target `/ready`; `/health` must remain a lightweight process-liveness endpoint and must not be used as the paid-traffic readiness signal.

```http
GET /health
```

Production response:

```json
{
  "status": "ok",
  "purpose": "liveness",
  "network": "mainnet"
}
```

Readiness:

```http
GET /ready
```

A ready production instance returns HTTP 200:

```json
{
  "status": "ready",
  "network": "mainnet",
  "checks": {
    "storage": true,
    "backgroundWorkers": true
  }
}
```

### Create a watch

```http
POST /v1/watch
Content-Type: application/json
```

Example body:

```json
{
  "idempotencyKey": "invoice-2026-09-16-001",
  "expectedSender": "3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ",
  "expectedReceiver": "EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY",
  "atomicAmount": "1",
  "invoiceNote": "roundwatch:invoice-2026-09-16-001"
}
```

An ordinary request receives `402 Payment Required`. An x402-capable client reads the payment requirements, signs the advertised service payment, and retries the same request. RoundWatch returns success only after settlement and durable activation succeed:

```json
{
  "watchId": "f5d2fb6f-b224-4aae-989c-87a5418fd2ae",
  "workUnitBudget": 500,
  "eligibilityTtlMs": 1800000,
  "expiresAt": "2026-09-16T12:30:00.000Z",
  "message": "The watch is returned only if x402 settlement and durable activation succeed"
}
```

Request fields:

| Field | Required | Rules |
| --- | --- | --- |
| `idempotencyKey` | Yes | String, 8–128 characters. It is globally unique in the service database. Reuse returns HTTP `409` with the existing public watch record and does not activate a second watch. |
| `expectedSender` | Yes | Checksum-valid 58-character Algorand address. |
| `expectedReceiver` | Yes | Checksum-valid 58-character Algorand address. It is the receiver of the future invoice payment, not necessarily the RoundWatch service receiver. |
| `atomicAmount` | Yes | Positive integer string, at most JavaScript's maximum safe integer (`9007199254740991`). For six-decimal USDC, `1000` means `0.001 USDC`. |
| `invoiceNote` | No | Exact UTF-8 note to match, 1–128 bytes when present. |

The watched asset is not a request field. The server selects the USDC ASA from its explicit network configuration: MainNet ASA `31566704` or TestNet ASA `10458941`.

The server controls the lifetime, work budget, and admission policy. Before purchase, RoundWatch advertises the 30-minute eligibility window and 500-turn background work budget. The eligibility clock starts when the durable obligation is prepared, before x402 settlement completes, so settlement delay consumes part of that 30-minute window. Callers cannot override either bound. Passing the wall-clock deadline does not itself expire a watch; proof requires complete chain coverage through a closing checkpoint. If the work budget is exhausted first, the watch terminates as `indeterminate` with `terminalReason=work_budget_exhausted`, never as a false `expired`. At most 50 unfinished obligations may be open globally and at most 5 may be open for the verified service payer. Capacity exhaustion returns HTTP `429` before settlement.

### Read a watch

```http
GET /v1/watch/f5d2fb6f-b224-4aae-989c-87a5418fd2ae
```

The response is `{ "watch": ... }`. This abridged matched example shows the stable consumer-facing fields; the live record also exposes settlement and scan metadata when available:

```json
{
  "watch": {
    "id": "f5d2fb6f-b224-4aae-989c-87a5418fd2ae",
    "state": "matched",
    "expectedSender": "3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ",
    "expectedReceiver": "EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY",
    "assetId": 31566704,
    "atomicAmount": "1",
    "invoiceNote": "roundwatch:invoice-2026-09-16-001",
    "createdAt": "2026-09-16T12:00:00.000Z",
    "expiresAt": "2026-09-16T12:30:00.000Z",
    "matchedTransaction": "VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA",
    "matchedRound": 65096073
  }
}
```

Unknown IDs return HTTP `404`.

### Watch states

| State | Meaning |
| --- | --- |
| `settlement_pending` | The watch specification and deterministic service-payment identity are persisted, but activation is not yet proven. Reconciliation can recover a settlement/activation crash window. |
| `active` | The exact service-payment transaction is confirmed; its confirmed round is the activation baseline and initial scan cursor. The poller is looking for the future invoice payment. |
| `matched` | An exact matching future asset transfer was found. The matching transaction ID and confirmed round are stored. |
| `settlement_unknown` | Settlement did not produce an immediately usable activation. `settlementReconciliationTerminal=false` means exact reconciliation may still recover it; `true` means reconciliation reached a final fail-closed outcome and will not retry. |
| `expired` | The deadline's complete eligible chain range was scanned through a fixed closing checkpoint with no exact match. The terminal record remains readable. |
| `indeterminate` | The durable per-watch work budget was exhausted before a positive match or complete expiry proof. The record is terminal and does not claim absence. |

### Exact matching

A transaction matches only when all configured properties agree:

- sender;
- receiver;
- network-selected USDC ASA;
- atomic amount; and
- invoice note, when the request supplied one.

Only confirmed **top-level direct** asset transfers strictly after the confirmed service-payment round are considered. The exact eligibility boundaries are `confirmed-round > activationRound` and `round-time < expiresAt`: a same-round invoice is ineligible, and a block timestamp exactly equal to the deadline is also ineligible. Sender, receiver, ASA, atomic amount, and optional note must match. Inner transactions, clawback transfers, and asset close-out transfers are explicitly outside the current RoundWatch matching contract and do not count as invoice payments. Processing time does not affect eligibility.

## x402 payment and recovery

The Hono resource server uses x402 v2 and the hosted GoPlausible facilitator. Before settlement, RoundWatch persists the deterministic Algorand service-payment transaction ID and immutable receiver, ASA, atomic amount, payer, `FirstValid`, and `LastValid` terms derived from the verified signed payload. After settlement, an exact Indexer lookup supplies the confirmed service-payment round, which becomes both the activation baseline and initial cursor.

If the process stops after on-chain settlement but before activation is committed, the reconciliation worker looks up that exact transaction under persisted exponential backoff. It activates only when the original immutable terms agree. A bare 404 is retryable; only a sufficiently covered post-`LastValid` historical absence search can establish terminal nonpayment. A definitive confirmed mismatch fails closed. The free recovery-without-ID lookup preserves the watch-ID disclosure boundary while returning explicit `retryable`/`terminal`, stable reason, and next-action metadata for an exact unresolved checkpoint.

All Indexer calls share one token-bucket/concurrency dispatcher. Scans use finite round windows and page-level validation; each page and retry consumes capacity. Each durable work turn is additionally guarded to at most four logical Indexer request opportunities for active polling or three for settlement reconciliation, so the default 500-turn contract has a conservative 2,000-background-request ceiling. Indexer response bodies are capped at 8 MiB before JSON parsing and continuation tokens are capped at 4 KiB, so a malformed or hostile upstream cannot allocate unbounded parser/token memory. Any response body that is not consumed because of a declared-size rejection, allowed 404, or other non-OK status is explicitly cancelled before the dispatcher slot is released. Validated historical scan pages may be reused across sweeps, but the process-local LRU is bounded by both entry count and serialized payload bytes. Pagination tokens stay in memory, so restart replays the unfinished window from its durable cursor. When the deadline has passed, RoundWatch fixes an indexed block whose timestamp is at or after the deadline as `closingRound`; only complete validated coverage through that round can produce `expired`. Status reads never manufacture expiry from wall time.

## Local development

Requirements:

- Node.js 24;
- pnpm 12.3.4 (declared by the workspace); and
- a TestNet account only if you intentionally exercise a paid local flow.

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Copy `apps/server/.env.example` to `apps/server/.env` and configure a public TestNet receiver address:

```env
ROUNDWATCH_NETWORK=testnet
AVM_ADDRESS=<public TestNet receiver address>
FACILITATOR_URL=https://facilitator.goplausible.xyz
ROUNDWATCH_DB_PATH=data/roundwatch.sqlite
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
ROUNDWATCH_MIN_FREE_DISK_BYTES=67108864
PORT=4021
```

Then start the server:

```bash
pnpm dev:server
```

Free checks:

```bash
curl -i http://localhost:4021/health
curl -i http://localhost:4021/ready
curl -i -X POST http://localhost:4021/spike/watch \
  -H "content-type: application/json" \
  --data '{"idempotencyKey":"local-invoice-001","expectedSender":"3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ","expectedReceiver":"EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY","atomicAmount":"1"}'
```

The readiness request must return HTTP `200` before a paid watch can be admitted. It is backed by a cached SQLite write/rollback probe, poller and reconciler progress/error freshness in production, and a filesystem free-space floor. A non-ready service returns HTTP `503` from watch creation before x402 verification. The final request should return HTTP `402` before any payment. The server's default local route is `/spike/watch`, not the production `/v1/watch` route.

Paid TestNet utilities use `apps/client/.env` and keep signing in the client process. Never use a funded MainNet mnemonic for local development and never commit an `.env` file. The automated test suite does not require a wallet or make payments.

## TestNet and MainNet separation

| Configuration | TestNet | MainNet |
| --- | --- | --- |
| Selection | Default when omitted, or `ROUNDWATCH_NETWORK=testnet` | Must set `ROUNDWATCH_NETWORK=mainnet` |
| Watch route | `/spike/watch` | `/v1/watch` |
| USDC ASA | `10458941` | `31566704` |
| CAIP-2 | `algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=` | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Discovery tag | `roundwatch-spike-0` | `x402-global-challenge` |
| Public base URL | Optional | Required, HTTPS, and non-loopback |
| Database path | Local default allowed | Explicit absolute persistent path required |

See [Deployment](docs/DEPLOYMENT.md) before operating MainNet.

## Tests and CI

Run the local verification suite:

```bash
pnpm typecheck
pnpm -C apps/server test
pnpm -C apps/client test
docker build -t roundwatch-local .
```

GitHub Actions runs with read-only repository permissions, pins third-party actions and the Gitleaks image by immutable revisions, performs a full-depth history scan, rejects tracked `.env` files other than examples, installs from the frozen lockfile, audits production dependencies for High/Critical advisories, typechecks both workspaces, runs server and MainNet safety tests, and builds the production image. Dependabot monitors both npm/pnpm dependencies and GitHub Actions. Tests are synthetic/read-only and do not authorize MainNet spending.

## Security model

- Wallet signing belongs to the client; the resource server needs only its public receiver address.
- MainNet startup validates the network, receiver address, HTTPS endpoints, public base URL, and persistent database path.
- Service settlement is reconciled against exact on-chain fields before recovery activation.
- Future invoice matching is exact, and activation never starts without a safe round cursor.
- SQLite uniqueness on the idempotency key prevents duplicate watch creation.
- Transactional global/per-payer admission and the shared finite Indexer dispatcher bound persistent and external work; capacity rejection happens before settlement.
- MCP and free recovery POSTs have independent anonymous request admission before body parsing; MCP version/envelope/tool-argument validation follows the supported modern/legacy contract instead of permissive coercion.
- `.env` files and wallet material must never be committed; CI enforces tracked-env and full-history secret checks.

The status API is not an authenticated vault: anyone who knows a watch ID can query its public record. Status and other watch-specific responses use `Cache-Control: no-store`. Do not put sensitive information in `invoiceNote` or use RoundWatch metadata as a secret store. `/health` is liveness only; use `/ready` to check durable storage and background-worker readiness before directing paid traffic. The challenge release retains terminal rows until deliberate operator maintenance; there is no public deletion API. See [Security](docs/SECURITY.md) and [Operations](docs/OPERATIONS.md) for trust boundaries and operational procedures.

## MainNet proof

The production flow was executed successfully on **2026-09-16**:

- x402 service settlement: `OJMUUHJPZVXS6MNW4TISXXAZIHAPNYNM446DAFY35OAJOBDDOPYA`, confirmed round `65095955`;
- durable watch: `7c606f02-0257-4dfd-b59c-a13b61f480f0`;
- later invoice transfer: `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA`, confirmed round `65096073`;
- RoundWatch reported the same invoice transaction as matched at round `65096073`.

Independent MainNet Indexer verification confirmed both transfers used Circle USDC ASA `31566704`, the expected sender and receiver, and atomic amounts `1000` for the service payment and `1` for the watched invoice. The matched watch persisted across multiple Render redeploys.

After the initial MainNet proof, the production service received a larger correctness/resource hardening merge at `18e8712431bc02a904dd5a3f227b2f5a49e9f6f7`. That release replaced wall-clock-only expiry with chain-time eligibility plus a fixed closing checkpoint, activated watches from the exact confirmed service-payment round, bounded all Indexer work through a shared dispatcher, added fair bounded servicing across watches, and strengthened settlement reconciliation and pagination validation. Render deployed that merge successfully and free production smoke checks returned the expected MainNet health, x402 `402`, and status behavior.

A follow-up production fix at `d05fabaea6124ed5658dd13cf06167a885aefeb0` replaced an invalid Bazaar example receiver with a checksum-valid Algorand address and added regression coverage. A post-deploy external `402` smoke decoded the live `payment-required` header and verified the production URL, MainNet network, `exact` scheme, ASA `31566704`, amount `1000`, and checksum-valid Bazaar example addresses. No second paid MainNet E2E was performed after these hardening releases or is implied.

GoPlausible Bazaar had discovered the production resource on 2026-09-16 with the correct URL, network, asset, amount, receiver, challenge tag, and `settleCount: 1`. The merchant leaderboard entry then showed `bazaar: true`, `challenge: true`, `settles: 1`, and `volume: 0.001`. That is historical evidence, not a permanent catalog guarantee.

A fresh full-catalog qualification on 2026-09-24 scanned all 2,230 resources returned by the configured GoPlausible discovery endpoint and did not find the exact current RoundWatch resource URL. The live unpaid `402` still carries valid x402/Bazaar metadata. Current catalog visibility is therefore being requalified separately from the payment and runtime contract.

Detailed evidence is in [MainNet Readiness](docs/MAINNET_READINESS.md).

## Current limitations

- The current challenge-release policy is a 30-minute eligibility deadline, a 500-turn durable work budget, 50 global open obligations, and 5 open obligations per verified service payer. These are operational safety bounds, not a commercial SLA or final pricing/capacity policy.
- There is no cancellation operation, SLA, or long-term pricing policy.
- The current deployment is a single application instance with an in-process poller/reconciler and local persistent SQLite. It is not a horizontally coordinated worker system.
- Each poll sweep gives every active watch at most one bounded servicing turn; pagination yields between sweeps, and FIFO Indexer dispatch enforces the global request bound. The tuning values are not an SLA or arbitrary-scale claim.
- Results are retrieved by polling; there is no webhook or push-notification API.
- Watch status is readable without authentication by anyone who knows the watch ID.

## Repository structure

```text
.
├── apps/
│   ├── server/              # Hono API, x402 integration, SQLite, Indexer workers
│   └── client/              # TestNet utilities and guarded MainNet verification runner
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DEPLOYMENT.md
│   ├── MAINNET_READINESS.md
│   ├── OPERATIONS.md
│   ├── SECURITY.md
│   ├── FAULT_INJECTION.md
│   └── ROUNDWATCH_SPIKE.md
├── .github/workflows/ci.yml
├── Dockerfile
└── README.md
```

Historical TestNet development evidence remains in [RoundWatch Spike](docs/ROUNDWATCH_SPIKE.md) and [Fault Injection](docs/FAULT_INJECTION.md). The current product and production contract are described here and in the four operational documents linked above.
