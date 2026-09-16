# RoundWatch live TestNet fault-injection runbook

Purpose: prove the real settlement → activation crash recovery path before any MainNet payment.

This test deliberately kills the TestNet server **after the x402 service payment has settled** but **before the SQLite activation commit**. The restarted process must recover the pending watch from on-chain evidence, then continue through the later watched-payment match.

## Safety

- TestNet only.
- Never enable `ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1` with `ROUNDWATCH_NETWORK=mainnet`; startup rejects that combination.
- Use the existing ignored local `.env` files. Never paste a mnemonic into Git, chat, logs, or documentation.
- Use a fresh SQLite file for this proof so an older pending row cannot trigger the intentional exit.

## 1. Sync the hardening branch

```powershell
git switch hardening/mainnet-readiness
git pull
pnpm install --frozen-lockfile
pnpm typecheck
pnpm -C apps/server test
```

Expected before the live run: typecheck succeeds and the focused tests pass.

## 2. Arm the TestNet-only fault

In `apps/server/.env`, keep the known-good TestNet wallet/facilitator settings and use a fresh DB path:

```text
ROUNDWATCH_NETWORK=testnet
ROUNDWATCH_DB_PATH=data/roundwatch-fault.sqlite
ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=1
```

Delete any previous local `apps/server/data/roundwatch-fault.sqlite*` files before starting this proof.

Start the server:

```powershell
pnpm dev:server
```

The startup log must include:

```text
TESTNET FAULT INJECTION ARMED
```

## 3. Trigger one real TestNet x402 settlement

In a second terminal:

```powershell
pnpm -C apps/client run spike:roundwatch:prepare
```

The client now writes `apps/client/data/roundwatch-live.json` **before** the paid retry, so the exact invoice request survives the intentional server death.

Expected behavior:

1. unpaid request returns HTTP 402;
2. the x402 payment is authorized and settled by the real TestNet facilitator;
3. server prints an `INTENTIONAL TESTNET FAULT` line containing the settlement transaction ID;
4. server exits with code `86` before `activateWatch()` writes `active` to SQLite;
5. the client reports a connection/payment-response failure because the server disappeared. That client error is expected for this test.

Do **not** run `prepare` again with a new invoice.

## 4. Restart without the fault switch

Change only:

```text
ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE=0
```

Keep the same `ROUNDWATCH_DB_PATH=data/roundwatch-fault.sqlite` and start the server again:

```powershell
pnpm dev:server
```

The reconciliation worker runs immediately. Wait for a log like:

```text
RoundWatch reconciled settled watch <WATCH_ID> from on-chain transaction <TX_ID>
```

The `<TX_ID>` must equal the settlement transaction printed immediately before the intentional crash.

## 5. Recover the client checkpoint without a second settlement

In the client terminal:

```powershell
pnpm -C apps/client run spike:roundwatch:recover
```

The recover command reuses the same idempotency key. The server must return the existing watch as HTTP 409 rather than settling another service payment. The client extracts the recovered watch ID and rewrites the local checkpoint.

Expected output includes:

```text
Recovered watch <WATCH_ID> is active; duplicate request was not settled again.
```

If it still reports `settlement_pending`, wait a few seconds for Indexer visibility and retry `recover`.

## 6. Prove the recovered watch still works

Now send the separate future TestNet USDC invoice transfer using the preserved request details:

```powershell
pnpm -C apps/client run spike:roundwatch:pay
```

Expected final chain:

```text
real x402 settlement
→ intentional process exit before activation commit
→ restart
→ on-chain reconciliation of the exact service-payment txid
→ recovered active watch
→ later exact TestNet USDC invoice payment
→ matched
```

Record:

- service-settlement transaction ID;
- recovered watch ID;
- reconciliation log line;
- later invoice transaction ID and confirmed round;
- final matched transaction ID and round.

## Pass criteria

The MainNet crash-window gate passes only if all of the following are true:

- the process actually exits after real TestNet settlement and before local activation;
- SQLite survives the restart;
- reconciliation activates the same pending watch from the exact on-chain settlement transaction;
- the recovery request does not cause a second settlement;
- the recovered watch later matches the separate exact invoice payment;
- normal focused tests and typecheck still pass afterward.
