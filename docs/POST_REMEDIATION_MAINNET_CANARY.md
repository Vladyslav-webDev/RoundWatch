# Post-remediation MainNet canary

This runbook validates the current production purchase and matching path after the
first external-watch remediation work. It is intentionally narrow: one x402
service purchase, one exact watched transfer, and no production restart.

## Goal

Prove the current production sequence:

1. production readiness is healthy;
2. an unpaid `POST /v1/watch` returns the approved MainNet x402 requirement;
3. the paid retry settles exactly `0.10 USDC` to the approved RoundWatch receiver;
4. a durable watch is returned in `active` state with a nonzero exact sender;
5. a separate `0.000001 USDC` MainNet transfer confirms after activation;
6. RoundWatch exact-matches sender, receiver, USDC ASA 31566704, amount, and note;
7. the durable watch reaches `matched` and exposes the matched transaction and round.

This canary does **not** test horizontal scaling, webhook delivery, arbitrary
receivers, or a forced production restart.

## Safety boundary

The runner is pinned to:

- server: `https://roundwatch-api.onrender.com`
- network: Algorand MainNet
- asset: Circle USDC ASA `31566704`
- service receiver: `EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY`
- service payment: exactly `0.10 USDC`
- watched invoice: exactly one USDC atomic unit (`0.000001 USDC`)

`start` and `pay` require the explicit `--confirm-mainnet` path embedded in
the package scripts. The client payment policy rejects any changed network,
asset, amount, receiver, resource URL, challenge tag, or x402 version.

Never expose, paste, commit, or screen-share `AVM_MNEMONIC`.

## Before the paid run

From `apps/client`:

```powershell
pnpm run mainnet:preflight
```

Pass criteria:

- `ROUNDWATCH MAINNET PREFLIGHT PASSED`
- production readiness is `ready`
- Algod connectivity is `ok`
- unpaid create-watch returns and validates HTTP 402
- no transaction is constructed, signed, or broadcast

If an existing checkpoint is reported, preserve it before starting a fresh
canary. Do not delete the old checkpoint until it has been copied somewhere
outside `apps/client/data/roundwatch-mainnet-live.json` and deliberately
reviewed.

A fresh canary must start with no file at:

```text
apps/client/data/roundwatch-mainnet-live.json
```

Also verify in Pera Wallet that the payer account has enough MainNet USDC and
ALGO for `0.100001 USDC` plus network fees.

## Paid phase 1: create the durable watch

From `apps/client`:

```powershell
pnpm run mainnet:start
```

Expected evidence:

```text
MainNet unpaid preflight passed. No payment has been sent yet.
MAINNET SERVICE SETTLEMENT: <service transaction id>
MAINNET WATCH ACTIVE: <watch id>
MainNet checkpoint written to ...roundwatch-mainnet-live.json
```

Stop immediately if the command reports a safety stop, non-ready production,
unexpected payment requirement, unsuccessful settlement, or a watch state other
than `active`.

Before paying the watched invoice, inspect the checkpoint read-only:

```powershell
pnpm run mainnet:status
```

The watch must still be `active`, with the exact nonzero payer address as
`expectedSender`.

## Paid phase 2: make the watched transfer

```powershell
pnpm run mainnet:pay
```

Expected evidence:

```text
MAINNET INVOICE PAYMENT: <invoice transaction id> at round <n>
MAINNET MATCHED: <same invoice transaction id> at round <same n>
```

The service settlement transaction and watched invoice transaction must be
different transactions. The matched round must be strictly greater than the
watch activation round.

## Post-run evidence

Run:

```powershell
pnpm run mainnet:status
```

Preserve:

- production commit/deploy identifier;
- checkpoint JSON;
- watch ID;
- service settlement transaction ID;
- activation round;
- watched invoice transaction ID;
- matched round;
- final watch state;
- Render logs covering the complete canary window.

Production log acceptance for the canary window:

- no `roundwatch_readiness_blocked`;
- no Indexer timeout;
- no unexplained Indexer failure;
- no payment-rejected event for the authorized canary;
- one successful paid watch creation;
- final watch state `matched`.

## Stop conditions

Do not retry with a new idempotency key after an ambiguous paid response.
Preserve the checkpoint and use:

```powershell
pnpm run mainnet:recover
```

Recovery is read-only with respect to payment: it cannot sign or settle a new
service purchase.

If the service payment settled but activation is uncertain, do not pay the
watched invoice until the exact existing watch has been recovered and verified.
