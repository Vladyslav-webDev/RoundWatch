# RoundWatch MainNet readiness

Status: production API, paid MainNet E2E, durable invoice match, historical Bazaar discovery, challenge attribution, correctness/resource hardening, bounded-work economics controls, and the post-economics production deployment are proven. Current Bazaar catalog visibility is being requalified after a 2026-09-24 full-catalog probe no longer found the exact resource URL.

This is a dated evidence record, not an availability or performance guarantee.

## Current production baseline

| Property | Verified value |
| --- | --- |
| API | `https://roundwatch-api.onrender.com` |
| Network | Algorand MainNet |
| CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Circle USDC | ASA `31566704` |
| Watch route | `POST /v1/watch` |
| Status route | `GET /v1/watch/:id` |
| Service price | `0.02 USDC` (`20000` atomic units) |
| Service receiver | `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY` |
| Facilitator | `https://facilitator.goplausible.xyz` |
| Hosting | Render with persistent SQLite disk mounted at `/data` |
| Durable work budget | `500` background work turns per watch; exhaustion is terminal `indeterminate` |
| Health response | `{ "status": "ok", "network": "mainnet" }` |

The production server has no mnemonic or private key. The dedicated payer signs locally.

Economics v1 is live at `0.02 USDC` (`20000` atomic units). On 2026-09-20, an external unsigned production `POST /v1/watch` received HTTP `402` and verified the exact MainNet resource contract: `exact` scheme, ASA `31566704`, amount `20000`, approved service receiver, and `x402-global-challenge` tag. The historical paid E2E below remains evidence of the earlier `1000`-atomic contract and is intentionally unchanged.

## Production hardening and current release

The initial production-readiness audit identified failure-path issues around
activation baselines, ambiguous settlement recovery, definitive settlement
mismatches, and per-watch poll isolation. Those fixes were followed by a broader
correctness/resource hardening pass that is now merged to `main` and live on
Render.

The principal production hardening merge is:

```text
18e8712431bc02a904dd5a3f227b2f5a49e9f6f7
```

That release establishes the current correctness model:

- MainNet persists the deterministic service-payment transaction identity and
  immutable signed purchase terms before settlement;
- normal and recovery activation use the **exact confirmed service-payment
  round**, not an unrelated current Indexer tip;
- only confirmed invoice transfers with `confirmedRound > activationRound`
  are eligible, so same-round transfers remain excluded;
- the 30-minute value is an exclusive creation-based **eligibility deadline**,
  not a wall-clock state transition;
- after the deadline, RoundWatch fixes a chain checkpoint at or after that
  deadline and reaches `expired` only after complete validated coverage through
  the resulting closing round;
- all Indexer work passes through one finite dispatcher with bounded rate,
  burst, and aggregate concurrency;
- scans use finite round windows, strict page/watermark validation, and never
  advance the durable cursor when coverage is incomplete;
- each poll sweep gives every active watch at most one bounded servicing turn,
  preventing a busy pagination session or one failing watch from monopolizing
  progress;
- settlement reconciliation remains retryable when evidence is incomplete and
  fail-closed when a definitive mismatch is proven;
- admission is transactionally capped at 50 unfinished obligations globally and
  5 per verified service payer, with capacity rejection before settlement; and
- legacy rows never receive fabricated proof fields, deadlines, or coverage.

CI for the hardening release passed the full-history secret scan, tracked-env
guard, typecheck, RoundWatch focused tests, MainNet client safety tests, and
production container build. Render then auto-deployed the exact merge commit and
free production smoke checks confirmed MainNet health, unpaid x402 behavior, and
status retrieval without an additional MainNet spend.

A follow-up discovery fix was squash-merged as:

```text
d05fabaea6124ed5658dd13cf06167a885aefeb0
```

It replaced an invalid Bazaar example receiver with a checksum-valid Algorand
address and added regression coverage that decodes the x402
`payment-required` header and validates both discovery example addresses. The
follow-up deploy reached `live` on Render. An external post-deploy GitHub
Actions smoke then issued an unpaid production `POST /v1/watch`, received HTTP
`402`, decoded the live header, and verified the production URL, MainNet
network, `exact` scheme, ASA `31566704`, amount `1000`, and both Bazaar
example addresses.

No second paid MainNet E2E was performed after these hardening releases, and
this document does not imply one. The paid MainNet proof below remains the
known-good pre-hardening baseline; the current hardened release is covered by
free production regression checks.

Economics v1 was later squash-merged and deployed as:

```text
80ed94c746f2eac4a784a3738c6dbe8306ecfa3e
```

That release added the immutable 500-turn per-watch work budget and terminal
`indeterminate` outcome for budget exhaustion, bounded signed-payment
pre-settlement verification, retained the measured storage model, and changed
the live service price to `0.02 USDC` (`20000` atomic units). Render reported the
exact commit live, and the external unpaid `402` smoke described above confirmed
the new price from outside the service without a MainNet spend.

## Settlement and activation recovery

The x402/Hono lifecycle runs the application handler before final settlement. MainNet therefore persists the deterministic service-payment transaction ID from the verified AVM payload while the watch is still `settlement_pending`.

Normal path:

```text
verified payment authorization
→ persist pending watch, deterministic service-payment identity, and signed validity terms
→ facilitator settles
→ settlement hook records the successful transaction ID
→ exact Indexer lookup confirms that service-payment transaction
→ activate using its confirmed round as both activation baseline and initial scan cursor
```

Recovery path:

```text
persist pending watch and deterministic service-payment identity
→ settlement succeeds or may have succeeded
→ activation commit is absent
→ reconciler looks up that exact transaction ID
→ receiver / ASA / amount / payer checks pass
→ activate using the transaction's confirmed round
```

If no transaction is found, the outcome stays recoverable. If the exact transaction is found but payment-critical fields do not match, reconciliation becomes terminal and the watch remains fail-closed as `settlement_unknown`. A watch is never activated without a scan baseline.

The crash-window path was proven live on TestNet on **2026-09-16**: the facilitator settled, the process intentionally exited before the activation commit, restart reconciliation recovered the exact transaction without a duplicate settlement, and a later separate TestNet invoice transfer matched.

## MainNet paid E2E evidence

On **2026-09-16**, the production deployment completed one explicitly authorized MainNet service purchase and matched a later, separate MainNet USDC invoice transfer.

| Evidence | Value |
| --- | --- |
| Service settlement transaction | `OJMUUHJPZVXS6MNW4TISXXAZIHAPNYNM446DAFY35OAJOBDDOPYA` |
| Service settlement confirmed round | `65095955` |
| Activated watch | `7c606f02-0257-4dfd-b59c-a13b61f480f0` |
| Later invoice transaction | `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA` |
| Invoice confirmed round | `65096073` |
| RoundWatch matched transaction | `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA` |
| RoundWatch matched round | `65096073` |

Before signing, the guarded runner performed a read-only unpaid preflight and rejected any mismatch in resource URL, network, asset, receiver, amount, or challenge tag. The service purchase spent `0.001 USDC`. The later invoice used `1` atomic unit (`0.000001 USDC`) plus Algorand network fees.

Independent MainNet Indexer verification confirmed both transactions were Algorand asset transfers using Circle USDC ASA `31566704`, with sender `3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ` and receiver `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY`. The service amount was `1000` atomic units at round `65095955`; the watched invoice amount was `1` atomic unit at round `65096073`.

The matched watch persisted across multiple Render redeploys, including the correctness-hardening deployment.

## Bazaar and challenge evidence

On **2026-09-16**, GoPlausible Bazaar discovery returned:

- HTTPS resource `https://roundwatch-api.onrender.com/v1/watch`;
- method `POST`;
- Algorand MainNet CAIP-2 network;
- Circle USDC ASA `31566704`;
- amount `1000` atomic units (`0.001 USDC`);
- receiver `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY`;
- challenge tag `x402-global-challenge`;
- `settleCount: 1`; and
- machine-readable request/response discovery metadata.

The GoPlausible merchant leaderboard also contained RoundWatch with `bazaar: true`, `challenge: true`, `settles: 1`, and `volume: 0.001`. Its observed rank was 145 among 147 merchant entries at the time queried. That rank is a dated observation and may change.

On **2026-09-24**, a fresh read-only qualification decoded a valid live `402` with the expected Bazaar metadata, then completed all 23 catalog pages reported by the same facilitator: 2,230 resources total, exact RoundWatch resource URL not present. The optional `/discovery/search` endpoint returned HTTP 404. This establishes a current distribution/catalog visibility defect without implying a payment-runtime failure.

The x402 Bazaar flow catalogs discovery metadata when a paying client echoes the extension in a `PaymentPayload` processed by the facilitator. A guarded one-payment MainNet recatalog proof is provided in `apps/client/bazaar-recatalog.ts`; the paid mode remains disabled unless a human explicitly authorizes that exact spend.

## Readiness gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Explicit network configuration | Passed | TestNet is the safe default; MainNet requires explicit selection |
| MainNet CAIP-2 and Circle USDC | Passed | Full MainNet identifier and ASA `31566704` are fixed in network config |
| Persistent production state | Passed | MainNet requires an absolute path; Render uses `/data/roundwatch.sqlite` |
| URL and address startup validation | Passed | Checksum-valid receiver and HTTPS production endpoints required |
| Settlement crash reconciliation | Passed | Focused tests plus live TestNet fault injection |
| Exact activation baseline | Passed | Normal and recovery activation use the confirmed service-payment transaction round |
| Chain-time expiry proof | Passed | Deadline passage alone cannot expire; complete validated coverage through a fixed closing round is required |
| Ambiguous/invalid settlement handling | Passed | Ambiguous outcomes retry; definitive mismatch is terminal/fail-closed |
| Bounded Indexer work | Passed | Shared finite rate/burst/concurrency dispatcher covers scans, retries, activation, recovery, and checkpoint work |
| Fair poll servicing | Passed | Each active watch receives at most one bounded turn per rotated sweep |
| Bounded open obligations | Passed | 30-minute eligibility deadline, 50 global and 5 per-payer caps, transactional pre-settlement rejection |
| Pagination and coverage integrity | Passed | Finite windows, strict watermarks/filters, continuation without premature cursor advance |
| Server test suite | Passed | Request, persistence, poller, scheduler, Indexer, and reconciliation coverage |
| MainNet client safety suite | Passed | Runtime, checkpoint, payment-critical, and response guards |
| History-aware secret scan | Passed | Full-depth checkout plus Gitleaks complete-history scan |
| Tracked environment guard | Passed | CI rejects tracked `.env` files except examples |
| Production container | Passed | CI builds the root Dockerfile |
| Public HTTPS API | Passed | Render deployment and free health/preflight checks |
| Paid MainNet service purchase | Passed | Settlement transaction and active watch recorded below |
| Later exact invoice match | Passed | Same invoice txid and round recorded by Indexer and RoundWatch |
| Persistence through redeploy | Passed | Existing matched watch unchanged after multiple redeploys |
| Bazaar discovery metadata | Passed; catalog visibility needs refresh | Live `402` metadata is valid; historical listing was proven on 2026-09-16, but a complete 2026-09-24 catalog scan did not contain the exact resource URL |
| Challenge attribution | Passed | Merchant entry reported `challenge: true` |

## Current release state

- The repository is public and MIT licensed.
- The correctness/resource hardening is merged to `main` and deployed on
  Render.
- The current production source is
  `d05fabaea6124ed5658dd13cf06167a885aefeb0`.
- Routine release validation should remain free: health, unpaid `402`, existing
  watch status, logs, and discovery metadata checks.
- A new paid MainNet E2E is **not** required merely to validate documentation,
  deployment, or discovery changes. Any additional spend remains an explicitly
  authorized evidence-collection action.
- Challenge submission/leaderboard state is operationally separate from this
  technical readiness record and may change independently.

## Product and operational limitations

RoundWatch now defines a challenge-release safety policy of a 30-minute eligibility deadline, 50 global unfinished obligations, and 5 unfinished obligations per verified service payer. It still has no cancellation operation, SLA, long-term pricing policy, or horizontally coordinated worker design. The current single-instance SQLite deployment uses bounded fair in-process servicing and a shared finite Indexer dispatcher, but it is not a claim of arbitrary-scale operation; the release limits are operational bounds rather than a commercial service commitment.
