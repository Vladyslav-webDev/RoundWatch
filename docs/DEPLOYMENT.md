# RoundWatch deployment runbook

This runbook is for the first controlled Algorand MainNet deployment. It does not authorize a real payment by itself.

## Container

The repository root contains a `Dockerfile` for the RoundWatch API server. The container runs Node 24 and the server workspace directly through `tsx`.

The hosting platform must provide HTTPS in front of the container and a persistent volume mounted at an absolute path such as `/data`.

## Required MainNet environment

```text
ROUNDWATCH_NETWORK=mainnet
AVM_ADDRESS=<public MainNet receiver address>
FACILITATOR_URL=https://facilitator.goplausible.xyz
ROUNDWATCH_PUBLIC_BASE_URL=https://roundwatch-api.onrender.com
ALGORAND_INDEXER_URL=https://mainnet-idx.algonode.cloud
ROUNDWATCH_DB_PATH=/data/roundwatch.sqlite
ROUNDWATCH_POLL_INTERVAL_MS=5000
ROUNDWATCH_RECONCILE_INTERVAL_MS=5000
PORT=<platform port or 4021>
```

Never configure a mnemonic, recovery phrase, wallet export, or private key on the RoundWatch resource server. The server receives payments; it does not sign as the user wallet.

## Startup guards

MainNet startup fails closed when:

- `AVM_ADDRESS` is not a checksum-valid Algorand address;
- `ROUNDWATCH_DB_PATH` is missing or relative;
- the facilitator or Indexer URL is not HTTPS;
- `ROUNDWATCH_PUBLIC_BASE_URL` is missing, is not HTTPS, or points at localhost/loopback;
- the configured MainNet Indexer URL visibly points at TestNet;
- `ROUNDWATCH_NETWORK` is not explicitly `mainnet` or `testnet`.

## Persistent state

Mount persistent storage at `/data` (or another platform-specific persistent path) and set:

```text
ROUNDWATCH_DB_PATH=/data/roundwatch.sqlite
```

SQLite WAL mode is enabled. The `.sqlite`, `.sqlite-wal`, and `.sqlite-shm` files belong on the same persistent filesystem. Do not place the database on an ephemeral container filesystem for MainNet.

## Routes

MainNet exposes the production watch route:

```text
POST /v1/watch
GET  /v1/watch/:id
GET  /health
GET  /demo
```

The TestNet regression route remains `/spike/watch` so the known-good spike behavior can be exercised without changing its public contract.

The MainNet watch price is currently `$0.001` USDC and uses Circle USDC ASA `31566704`. The route carries the `x402-global-challenge` tag and Bazaar discovery metadata.

## Settlement crash reconciliation

Before settlement, the handler persists the deterministic Algorand payment transaction ID derived from the already verified AVM `paymentGroup[paymentIndex]` transaction.

If the process dies after the facilitator settles but before SQLite activation commits, the reconciliation worker repeatedly looks up that exact transaction ID in the selected Algorand Indexer. A pending watch is activated only when the on-chain transfer exactly matches:

- the prepared transaction ID;
- the configured RoundWatch receiver;
- the configured USDC ASA;
- the exact service payment amount;
- the prepared payer when available.

Mismatched on-chain evidence fails closed to `settlement_unknown`.

This removes the known "settled externally, not activated locally" blind spot in the design, but it still requires a deliberate TestNet crash/fault-injection run before MainNet launch.

## Pre-payment deployment checks

After deployment and before any real payment:

1. `GET /health` returns HTTP 200 with `network: "mainnet"`.
2. An unpaid `POST /v1/watch` returns HTTP 402.
3. The `PAYMENT-REQUIRED` response advertises Algorand MainNet, USDC ASA `31566704`, the intended public receiver, and the expected price.
4. Restart the service and confirm the health endpoint returns normally with the same persistent volume mounted.
5. Confirm the receiver account is opted in to ASA `31566704`.

Only after these checks should the human operator authorize the first minimal MainNet x402 payment.

## First real E2E

Use a dedicated funded Payer account with a very small USDC balance. The intended sequence is:

```text
unpaid POST /v1/watch -> 402
signed x402 retry -> MainNet settlement
SQLite watch -> active
server restart -> active watch recovered
later exact invoice payment -> matched
```

Record both MainNet transaction IDs and independently verify them on-chain. Then verify Bazaar / challenge discovery visibility.
