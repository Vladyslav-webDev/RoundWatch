# RoundWatch MainNet Readiness

Status: code hardening implemented; live deployment gates remain

This document tracks production hardening required before any real MainNet payment is accepted.

## Current baseline

- RoundWatch Spike 0 lifecycle is merged into `main`.
- TestNet USDC flow is proven against GoPlausible and Algorand TestNet.
- Durable SQLite state survives a real process restart.
- Future exact USDC invoice matching is proven on TestNet.
- Explicit TestNet/MainNet configuration is implemented on `hardening/mainnet-readiness`.
- MainNet uses the SDK-provided Algorand MainNet CAIP-2 ID and Circle USDC ASA `31566704`.
- MainNet watch route is `/v1/watch`; the TestNet regression route remains `/spike/watch`.
- Production startup requires an absolute persistent SQLite path and HTTPS facilitator/Indexer URLs.
- A settlement reconciliation worker is implemented for the known settlement → SQLite activation crash window.
- A production Dockerfile, `.dockerignore`, deployment runbook, current-tree env-secret guard, and GitHub Actions verification are present.
- CI now performs a full-history Gitleaks scan from a full-depth checkout in addition to the current-tree `.env` guard.
- The operator has confirmed that both dedicated MainNet Pera accounts hold ALGO and are opted into verified USDC; the Payer also has enough USDC for the first minimal E2E.

## Settlement → activation reconciliation

The installed x402/Hono lifecycle executes the application handler before final settlement. The MainNet route therefore never treats handler execution as settlement evidence.

For MainNet, the handler now derives and persists the deterministic Algorand payment transaction ID from the already verified AVM payment transaction before the facilitator settlement call. This creates durable reconciliation identity while the watch is still `settlement_pending`.

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

This closes the design gap in code and focused tests. It is **not yet live proof**: a deliberate TestNet crash/fault-injection run must still demonstrate the recovery path against a real facilitator settlement before MainNet launch.

## Production gates

| Gate | Status | Evidence / next action |
| --- | --- | --- |
| Settlement → activation reconciliation design | Implemented | Deterministic payment txid is persisted before settlement and checked on-chain after restart |
| Focused reconciliation tests | Implemented | Pending→active recovery, mismatch fail-closed, and Indexer tx lookup tests |
| Explicit TestNet/MainNet configuration | Implemented | MainNet is never inferred implicitly; TestNet stays default |
| MainNet USDC / Indexer config | Implemented | SDK MainNet USDC constant and MainNet AlgoNode Indexer default |
| Production SQLite guard | Implemented | MainNet requires explicit absolute DB path intended for a persistent volume |
| URL / address startup validation | Implemented | Checksum-valid receiver and HTTPS production URLs required |
| Current-tree env-secret guard | Implemented | CI rejects tracked `.env` / `.env.*` other than `.env.example` |
| History-aware secret scan | Passed | CI full-depth checkout + Gitleaks v8.29.1 scanned complete git history successfully on 2026-09-15 |
| Production container | Implemented | Root Dockerfile + `.dockerignore`; CI builds the image |
| MainNet wallet funding / USDC opt-in | Ready | Human operator confirmed dedicated Payer and Receiver are funded and opted in |
| Live TestNet reconciliation fault injection | Pending | Run the prepared TestNet-only crash switch and prove restart reconciliation |
| Public HTTPS API + persistent disk | Pending | Requires hosting/DNS setup outside GitHub connector |
| Real MainNet x402 paid E2E | Pending | Human wallet signing required only after deployment preflight passes |
| MainNet transaction verification | Pending | Verify both service settlement and later watched payment on-chain |
| Bazaar / challenge discovery visibility | Pending | Verify after public MainNet settlement |

## Rules

- Never commit a mnemonic, private key, recovery phrase, wallet export, or funded `.env`.
- Never perform a MainNet payment during automated tests.
- MainNet must require an explicit configuration choice; it must never be inferred from a production hostname.
- TestNet remains the default for local development until MainNet is explicitly enabled.
- Do not merge this hardening branch solely because unit tests pass. Live TestNet fault injection and deployment preflight are still required.
- The first real MainNet payment must remain minimal and must be explicitly authorized by the human wallet owner.
- `ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1` is a TestNet-only fault switch; startup must reject it on MainNet.

## Manual wallet status

The wallet-side preparation is complete for the current first E2E plan:

- dedicated MainNet Payer has ALGO and verified Circle USDC;
- dedicated MainNet Receiver has ALGO and verified Circle USDC;
- no mnemonic or private key is stored in this repository or required by the resource server.

Do not move additional funds unless the first MainNet E2E needs them.

## Not proof until executed

Code preparation is not evidence that MainNet works. The production gate passes only after:

- CI is green, including full-history secret scan, typecheck, focused tests, current-tree secret guard, and container build;
- live TestNet fault injection proves settlement reconciliation after a real process death;
- the public HTTPS deployment is healthy and uses persistent storage;
- an unpaid public MainNet watch request advertises the intended MainNet network, USDC ASA, price, and receiver;
- a real minimal MainNet x402 settlement succeeds;
- the receiver balance and transaction are independently verified on-chain;
- the watch remains durable across restart and can match the later invoice payment;
- the resource is visible in the expected Bazaar / challenge discovery surfaces.
