# RoundWatch MainNet readiness

Status: production API, paid MainNet E2E, durable invoice match, Bazaar discovery, challenge attribution, and correctness hardening are proven. Repository publication, the hardening-to-`main` merge, and challenge submission remain human-controlled steps.

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
| Service price | `0.001 USDC` (`1000` atomic units) |
| Service receiver | `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY` |
| Facilitator | `https://facilitator.goplausible.xyz` |
| Hosting | Render with persistent SQLite disk mounted at `/data` |
| Health response | `{ "status": "ok", "network": "mainnet" }` |

The production server has no mnemonic or private key. The dedicated payer signs locally.

## Final audit and correctness hardening

A final read-only public-readiness audit was completed. It identified failure-path issues around activation baselines, ambiguous settlement recovery, definitive settlement mismatches, and per-watch poll isolation. The fixes were tested, merged into `hardening/mainnet-readiness`, and deployed.

Production hardening merge commit:

```text
69afd9dc070a7f9c12206b038f117cc1f2b3fdb3
```

The deployed hardening includes:

- no cursorless activation when activation-round acquisition fails;
- exact on-chain settlement reconciliation establishing the safe initial scan baseline;
- retryable recovery for ambiguous settlement outcomes;
- terminal fail-closed handling for a definitive on-chain settlement mismatch;
- per-watch poll failure isolation so one watch does not starve later watches;
- mandatory valid HTTPS `ROUNDWATCH_PUBLIC_BASE_URL` on MainNet;
- guarded MainNet checkpoint, runtime, receiver, asset, amount, note, and response validation;
- full-history Gitleaks CI and tracked `.env` rejection;
- server correctness/reconciliation tests and client MainNet safety tests; and
- production Docker build validation.

Correctness-hardening CI passed. The history-aware secret scan is part of that CI: checkout uses full depth and Gitleaks v8.29.1 scans complete Git history with redaction enabled.

Render successfully auto-deployed the merge commit. A free post-deploy smoke check passed, `/health` continued to report MainNet, and the pre-existing matched watch `7c606f02-0257-4dfd-b59c-a13b61f480f0` survived the migration/redeploy unchanged.

No second paid MainNet E2E was performed after this patch, and this document does not imply one. The free health and persisted-watch checks were sufficient to verify the deployed change without another spend.

## Bounded-capacity release candidate

The final publication candidate adds a server-controlled 30-minute expiry, a global cap of 50 open obligations, and a cap of 5 open obligations per deterministic verified service payer. Capacity rejection occurs in the application handler before x402 settlement and returns HTTP `429`. Persisted expiry removes elapsed unfinished watches from polling, reconciliation, and capacity while retaining their public `expired` record.

The SQLite migration transactionally adds the new state constraint and expiry column. Legacy unfinished rows receive a full configured TTL from the first upgraded startup; the known historical matched watch remains matched and may have no `expiresAt` because it predates the field. This candidate is locally tested but is not described as deployed until the human-controlled merge and Render branch switch occur. No additional MainNet payment is required for deployment validation.

## Settlement and activation recovery

The x402/Hono lifecycle runs the application handler before final settlement. MainNet therefore persists the deterministic service-payment transaction ID from the verified AVM payload while the watch is still `settlement_pending`.

Normal path:

```text
verified payment authorization
→ persist pending watch and deterministic service-payment identity
→ facilitator settles
→ settlement hook records evidence
→ acquire current Indexer round
→ activate with that round as the initial scan cursor
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

## Readiness gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Explicit network configuration | Passed | TestNet is the safe default; MainNet requires explicit selection |
| MainNet CAIP-2 and Circle USDC | Passed | Full MainNet identifier and ASA `31566704` are fixed in network config |
| Persistent production state | Passed | MainNet requires an absolute path; Render uses `/data/roundwatch.sqlite` |
| URL and address startup validation | Passed | Checksum-valid receiver and HTTPS production endpoints required |
| Settlement crash reconciliation | Passed | Focused tests plus live TestNet fault injection |
| Safe activation baseline | Passed | Normal and reconciliation activation store a confirmed Indexer round |
| Ambiguous/invalid settlement handling | Passed | Ambiguous outcomes retry; definitive mismatch is terminal/fail-closed |
| Poll failure isolation | Passed | One watch failure neither advances its cursor nor starves later watches |
| Bounded open obligations | Candidate passed | Persisted 30-minute expiry, 50 global and 5 per-payer caps, pre-settlement rejection, restart and migration tests |
| Server test suite | Passed | Request, persistence, poller, and reconciliation coverage |
| MainNet client safety suite | Passed | Runtime, checkpoint, payment-critical, and response guards |
| History-aware secret scan | Passed | Full-depth checkout plus Gitleaks complete-history scan |
| Tracked environment guard | Passed | CI rejects tracked `.env` files except examples |
| Production container | Passed | CI builds the root Dockerfile |
| Public HTTPS API | Passed | Render deployment and free health/preflight checks |
| Paid MainNet service purchase | Passed | Settlement transaction and active watch recorded above |
| Later exact invoice match | Passed | Same invoice txid and round recorded by Indexer and RoundWatch |
| Persistence through redeploy | Passed | Existing matched watch unchanged after multiple redeploys |
| Bazaar discovery | Passed | Correct resource metadata and `settleCount: 1` |
| Challenge attribution | Passed | Merchant entry reported `challenge: true` |

## Remaining human-controlled steps

- The repository is still private. Do not describe it as publicly released until a human changes its visibility.
- The final hardening-to-`main` merge has not been performed. Merge only after the documentation/publication review is accepted.
- Complete the challenge-submission process and any required Electric Capital submission path after repository publication.
- Do not move funds or repeat a paid MainNet test unless a separately reviewed need receives explicit human authorization.

## Product and operational limitations

RoundWatch now defines a challenge-release safety policy of a 30-minute watch lifetime, 50 global open obligations, and 5 open obligations per verified service payer. It still has no cancellation operation, SLA, long-term pricing policy, or horizontally coordinated worker design. The current single-instance SQLite deployment and sequential in-process poller are not a claim of arbitrary-scale operation, and the release limits are operational bounds rather than a commercial service commitment.
