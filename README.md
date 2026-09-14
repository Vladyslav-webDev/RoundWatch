# Algorand x402 Challenge

Minimal x402 v2 payment infrastructure for the Algorand Global x402 Challenge.

The current milestone intentionally focuses only on proving the complete payment flow on Algorand TestNet:

```text
HTTP 402
→ payment requirements
→ signed TestNet USDC payment
→ GoPlausible verification
→ on-chain settlement
→ HTTP 200
```

The final product/use case is intentionally not implemented yet.

## Stack

- TypeScript
- Node.js
- pnpm workspace
- Hono
- x402 v2
- Algorand AVM
- TestNet USDC
- hosted GoPlausible facilitator
- Bazaar discovery extension

## Repository structure

```text
x402-challenge/
├─ apps/
│  ├─ server/
│  ├─ client/
│  └─ landing/
├─ docs/
│  ├─ ARCHITECTURE.md
│  ├─ SECURITY.md
│  └─ X402_OPPORTUNITY_MAP.md
├─ .gitignore
├─ README.md
├─ package.json
├─ pnpm-lock.yaml
└─ pnpm-workspace.yaml
```

## Current endpoints

### `GET /health`

Free endpoint used to verify that the resource server is running.

Expected response:

```json
{
  "status": "ok"
}
```

### `GET /demo`

x402-protected TestNet endpoint.

Price:

```text
$0.005 TestNet USDC
```

An unpaid request returns:

```text
HTTP 402 Payment Required
```

After a valid payment is verified and settled:

```json
{
  "ok": true,
  "message": "x402 payment verified",
  "timestamp": "<ISO timestamp>"
}
```

## TestNet configuration

Algorand TestNet USDC:

```text
ASA ID: 10458941
```

Facilitator:

```text
https://facilitator.goplausible.xyz
```

Challenge attribution:

```text
x402-global-challenge
```

## Requirements

- Node.js 24+
- pnpm
- two Algorand TestNet accounts:
  - payer
  - receiver
- TestNet ALGO on both accounts
- TestNet USDC opt-in on both accounts
- TestNet USDC available to the payer

## Install

From the repository root:

```bash
pnpm install
```

## Environment configuration

### Server

Copy:

```text
apps/server/.env.example
```

to:

```text
apps/server/.env
```

Configure:

```env
AVM_ADDRESS=<receiver Algorand address>
FACILITATOR_URL=https://facilitator.goplausible.xyz
```

`AVM_ADDRESS` is the public receiver address.

The server does not require the receiver private key.

### Client

Copy:

```text
apps/client/.env.example
```

to:

```text
apps/client/.env
```

Configure:

```env
AVM_MNEMONIC="<25-word TestNet payer mnemonic>"
```

The payer mnemonic must be a disposable TestNet credential.

Never commit `.env` files.

## Typecheck

From the repository root:

```bash
pnpm typecheck
```

This checks the resource server, payer client, and browser landing page.

## RoundWatch landing

`apps/landing` is the separate Vite/React/TypeScript public product site for
`roundwatch.observer`. The existing `apps/client` remains a Node payment client.
The page describes the verified Algorand TestNet observer prototype documented in
[ROUNDWATCH_SPIKE.md](docs/ROUNDWATCH_SPIKE.md). Its interactive demo is an
illustrative workflow replay and makes no payment or backend request.

Use Node 24 and the repository-pinned pnpm 12.3.4:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run dev:landing
corepack pnpm run typecheck:landing
corepack pnpm run build:landing
corepack pnpm -C apps/landing run preview
```

The `corepack` prefix selects the correct version if another pnpm shim is on PATH.
Netlify settings are in `netlify.toml`: repository-root build command
`corepack pnpm run build:landing`, publish directory `apps/landing/dist`.
No environment variables are needed. Deployment and domain configuration remain
separate from this implementation.

See the [landing specification](docs/landing/LANDING_SPEC.md) and
[validation report](docs/landing/VALIDATION.md) for design, factual boundaries,
and review instructions. The baseline milestone inventory below refers to the
original payment skeleton; it predates the observer spike and this static site.

## Run the server

From the repository root:

```bash
pnpm dev:server
```

Expected:

```text
x402 Resource Server listening at http://localhost:4021
```

## Verify the free endpoint

```bash
curl -i http://localhost:4021/health
```

Expected:

```text
HTTP/1.1 200 OK
```

## Verify unpaid x402 access

```bash
curl -i http://localhost:4021/demo
```

Expected:

```text
HTTP/1.1 402 Payment Required
```

The response contains the x402 payment requirements including:

- Algorand TestNet network
- TestNet USDC asset
- payment amount
- receiver address
- facilitator fee payer
- Bazaar discovery metadata
- challenge attribution tag

## Run the payer client

Keep the server running.

In another terminal:

```bash
pnpm dev:client
```

The client:

1. performs a plain request and verifies HTTP 402;
2. restores the TestNet payer from `AVM_MNEMONIC`;
3. creates the AVM signer;
4. signs the TestNet USDC payment;
5. retries the resource request through x402;
6. prints settlement information;
7. prints the paid JSON response.

A successful run ends with:

```text
Plain response: 402 Payment Required

Paid response: 200 OK
```

and a successful settlement containing an Algorand transaction ID.

## Verified TestNet milestone

The complete payment flow has been executed successfully:

```text
plain GET /demo
→ 402

payer client
→ reads payment requirements
→ signs 0.005 TestNet USDC payment
→ retries request

GoPlausible
→ verifies
→ settles

Algorand TestNet
→ USDC transferred on-chain to receiver

server
→ 200 JSON
```

## CAIP-2 compatibility note

During implementation with `@x402/avm@2.25.0`, the exported Algorand TestNet identifier did not match the full network identifier advertised by the live GoPlausible `/supported` endpoint.

The implementation therefore currently uses the full TestNet identifier explicitly:

```text
algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=
```

This workaround should be re-evaluated when the AVM package is upgraded.

## Security

- `.env` files are ignored by Git.
- Mnemonics and private keys must never be committed.
- TestNet credentials should be disposable.
- The resource server requires only the receiver public address.
- MainNet credentials are explicitly out of scope for the current milestone.

See:

```text
docs/SECURITY.md
```

## Current scope

Implemented:

- x402 v2 resource server
- GoPlausible hosted facilitator
- TestNet USDC settlement
- Bazaar discovery metadata
- challenge attribution
- payer CLI client
- complete TestNet end-to-end payment flow

Not implemented yet:

- final product/use case
- MainNet
- production wallet
- database
- authentication
- UI
- dashboard
- custom facilitator
- smart contracts

The next product decision is intentionally separated from the infrastructure milestone.
