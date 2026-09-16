# RoundWatch MainNet Readiness

Status: public MainNet deployment and paid E2E proven; final discovery / submission gates remain

This document tracks production hardening and live evidence for RoundWatch MainNet readiness.

## Current baseline

- RoundWatch Spike 0 lifecycle is merged into `main`.
- TestNet USDC flow is proven against GoPlausible and Algorand TestNet.
- Durable SQLite state survives a real process restart.
- Future exact USDC invoice matching is proven on TestNet.
- Explicit TestNet/MainNet configuration is implemented on `hardening/mainnet-readiness`.
- MainNet uses the facilitator-compatible full Algorand CAIP-2 network ID and Circle USDC ASA `31566704`.
- MainNet watch route is `/v1/watch`; the TestNet regression route remains `/spike/watch`.
- Production startup requires an absolute persistent SQLite path and HTTPS facilitator/Indexer URLs.
- A settlement reconciliation worker is implemented for the known settlement → SQLite activation crash window.
- A production Dockerfile, `.dockerignore`, deployment runbook, current-tree env-secret guard, and GitHub Actions verification are present.
- CI performs a full-history Gitleaks scan from a full-depth checkout in addition to the current-tree `.env` guard.
- Dedicated MainNet Payer and Receiver accounts hold ALGO and are opted into verified Circle USDC.
- RoundWatch is publicly deployed on Render at `https://roundwatch-api.onrender.com` with a 1 GB persistent disk mounted at `/data`.
- Public `/health` returns `{ "status": "ok", "network": "mainnet" }`.
- Public unpaid `/v1/watch` preflight advertises HTTPS resource URL, Algorand MainNet, USDC ASA `31566704`, the intended receiver, `$0.001` service price, and challenge tag `x402-global-challenge`.

## Settlement → activation reconciliation

The installed x402/Hono lifecycle executes the application handler before final settlement. The MainNet route therefore never treats handler execution as settlement evidence.

For MainNet, the handler derives and persists the deterministic Algorand payment transaction ID from the already verified AVM payment transaction before the facilitator settlement call. This creates durable reconciliation identity while the watch is still `settlement_pending`.

Normal path:

```text
verified payment authorization
→ persist pending watch + deterministic service payment txid
→ facilitator settles
→ onAfterSettle receives success evidence
→ SQLite watch becomes active
```

Crash-window recovery path:

```text
verified payment authorization
→ persist pending watch + deterministic service payment txid
→ facilitator settles on-chain
→ process dies before activation commit
→ fresh process reloads pending watch
→ reconciliation worker looks up that exact txid
→ exact receiver / ASA / amount / payer checks pass
→ watch becomes active
```

If an on-chain transaction exists for the prepared txid but its service-payment fields do not match, the row fails closed to `settlement_unknown`.

The recovery path was proven live on TestNet on 2026-09-16: a real facilitator settlement completed, the process intentionally exited before SQLite activation, restart reconciliation recovered the exact transaction, duplicate recovery did not settle again, and a later separate TestNet invoice transfer was matched.

## MainNet live E2E evidence

On 2026-09-16 the public Render deployment completed the first explicitly authorized MainNet RoundWatch purchase and later matched a separate MainNet USDC invoice transfer.

- Service settlement transaction: `OJMUUHJPZVXS6MNW4TISXXAZIHAPNYNM446DAFY35OAJOBDDOPYA`
- Activated watch: `7c606f02-0257-4dfd-b59c-a13b61f480f0`
- Later watched invoice transaction: `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA`
- Invoice confirmed round: `65096073`
- RoundWatch matched transaction: `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA`
- RoundWatch matched round: `65096073`

The local MainNet runner performed a read-only unpaid preflight before spending and refused mismatched network, asset, receiver, amount, challenge tag, or resource URL. The service purchase spent `0.001 USDC`; the later watched invoice transfer used `1` atomic unit of MainNet USDC (`0.000001 USDC`) plus Algorand network fees.

## Production gates

| Gate | Status | Evidence / next action |
| --- | --- | --- |
| Settlement → activation reconciliation design | Implemented | Deterministic payment txid is persisted before settlement and checked on-chain after restart |
| Focused reconciliation tests | Passed | Pending→active recovery, mismatch fail-closed, and Indexer tx lookup tests |
| Explicit TestNet/MainNet configuration | Passed | MainNet is never inferred implicitly; TestNet stays default |
| MainNet USDC / Indexer config | Passed | MainNet USDC `31566704`; MainNet AlgoNode Indexer |
| Production SQLite guard | Passed | MainNet requires explicit absolute DB path on persistent storage |
| URL / address startup validation | Passed | Checksum-valid receiver and HTTPS production URLs required |
| Current-tree env-secret guard | Passed | CI rejects tracked `.env` / `.env.*` other than `.env.example` |
| History-aware secret scan | Passed | CI full-depth checkout + Gitleaks v8.29.1 scans complete git history |
| Production container | Passed | Root Dockerfile + `.dockerignore`; CI builds the image |
| MainNet wallet funding / USDC opt-in | Passed | Dedicated Payer and Receiver funded and opted in |
| Live TestNet reconciliation fault injection | Passed | Real settlement → intentional crash → restart reconciliation → duplicate-safe recovery → later invoice match |
| Public HTTPS API + persistent disk | Passed | Render Frankfurt; Docker; `/data/roundwatch.sqlite`; 1 GB persistent disk |
| Public unpaid MainNet preflight | Passed | HTTPS resource, MainNet CAIP-2, USDC ASA `31566704`, receiver, `$0.001`, challenge tag all confirmed |
| Real MainNet x402 paid E2E | Passed | Service settlement `OJMUUHJPZVXS6MNW4TISXXAZIHAPNYNM446DAFY35OAJOBDDOPYA`; watch activated |
| Later MainNet invoice match | Passed | `VZKWYELPR4HHXPXM476NRLNU4JUKAEUUD4HGHFNAHDRD5IBFB2MA` matched at round `65096073` |
| Independent MainNet transaction verification | Pending | Query a public explorer / Indexer for both transaction IDs and record fields |
| Bazaar / challenge discovery visibility | Pending | Verify catalog / challenge surfaces after MainNet settlement |

## Rules

- Never commit a mnemonic, private key, recovery phrase, wallet export, or funded `.env`.
- Never perform a MainNet payment during automated tests.
- MainNet must require an explicit configuration choice; it must never be inferred from a production hostname.
- TestNet remains the default for local development until MainNet is explicitly enabled.
- `ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1` is a TestNet-only fault switch; startup must reject it on MainNet.
- MainNet paid runner requires the explicit `--confirm-mainnet` flag and validates payment requirements before signing.
- Do not remove or replace the production persistent disk without deliberate database backup / migration planning.

## Manual wallet status

The wallet-side preparation and first live E2E are complete:

- dedicated MainNet Payer has ALGO and verified Circle USDC;
- dedicated MainNet Receiver has ALGO and verified Circle USDC;
- no mnemonic or private key is stored in this repository or required by the resource server;
- the first production service settlement and later invoice transfer both completed on MainNet.

Do not move additional funds unless a later explicitly reviewed test requires them.

## Remaining proof / launch work

Core payment and observation behavior is now live-proven. Remaining launch work is operational and discovery-oriented:

- independently query the public MainNet transaction records for both recorded transaction IDs;
- verify the x402 Bazaar / GoPlausible challenge discovery surfaces contain the public RoundWatch resource;
- complete repository-publication and challenge-submission requirements only after the final secret/history review;
- merge the hardening PR only after the remaining launch checks are recorded.
