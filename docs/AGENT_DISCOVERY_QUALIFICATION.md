# Agent discovery qualification v0

This is the first distribution-phase probe after the 2026-09-24 security
remediation baseline.

Its purpose is deliberately narrow: determine whether the current production
resource can be found and interpreted through the x402 Bazaar discovery surface
without signing, paying, or mutating production state.

## What the probe checks

The client-side probe at `apps/client/discovery-qualification.ts` performs only
free/read-only network operations:

1. sends one unpaid `POST` to the production RoundWatch resource and requires
   HTTP `402` plus a decodable `PAYMENT-REQUIRED` header;
2. validates the live x402 v2 resource identity, MainNet payment requirement,
   provider metadata, tags, and Bazaar HTTP input/output declaration;
3. pages through the facilitator's `GET /discovery/resources` catalog and
   requires the exact public RoundWatch resource URL to be present;
4. if the facilitator implements `GET /discovery/search`, runs several
   natural-language searches that do not use the RoundWatch product name and
   records whether the resource appears and at what position.

The probe never constructs a payment payload, loads a signer, signs a
transaction, calls settlement, or creates a watch.

## Run

From the repository root:

```bash
pnpm -C apps/client probe:discovery
```

Optional overrides:

```bash
ROUNDWATCH_DISCOVERY_FACILITATOR_URL=https://facilitator.example ROUNDWATCH_DISCOVERY_RESOURCE_URL=https://api.example/v1/watch pnpm -C apps/client probe:discovery
```

The default production targets are:

- facilitator: `https://facilitator.goplausible.xyz`
- resource: `https://roundwatch-api.onrender.com/v1/watch`

## Result semantics

The command prints one JSON report.

- `pass`: the live unpaid challenge is structurally correct, the exact resource
  is cataloged, and the facilitator supports natural-language search with at
  least one RoundWatch hit.
- `partial`: the live challenge and catalog listing are correct, but this
  facilitator does not expose the optional natural-language search endpoint.
- `fail`: the live challenge is wrong, the exact resource is absent from the
  catalog, or a supported search endpoint returns no RoundWatch hit for all
  qualification queries.

A failed search qualification is a distribution problem, not automatically a
payment/security defect. Do not change payment or evidence code merely to chase
search ranking.

## Why this comes before an autonomous paid-agent test

The final black-box milestone is stronger: an unknown compatible agent should
discover the capability, choose it, inspect the live 402, apply its own spend
policy, pay, create a watch, follow status, and interpret deterministic evidence.

Running that full flow before confirming basic catalog visibility would mix two
different failures:

- "the agent could not find us"; and
- "the agent found us but could not use us."

This probe isolates the first boundary cheaply and repeatably.

## Current ecosystem references

The x402 v2 Bazaar extension defines machine-readable HTTP and MCP discovery
metadata, optional provider-level `serviceName` / `tags` / `iconUrl`, and
optional facilitator discovery endpoints including natural-language
`/discovery/search`.

Primary references:

- https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md
- https://github.com/x402-foundation/x402/blob/main/docs/extensions/bazaar.mdx
- https://github.com/GoPlausible/.github/blob/main/profile/algorand-x402-documentation/typescript/x402-avm-extensions-examples.md

The production server still uses the existing AVM extension package boundary.
This qualification probe does not migrate packages. Any migration to the newer
official extension path remains a separate TestNet-first compatibility task.
