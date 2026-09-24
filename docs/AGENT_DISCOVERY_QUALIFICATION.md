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
3. queries the facilitator's `GET /discovery/resources` catalog using the
   x402-standard `payTo` filter for the RoundWatch service receiver, then
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
- `inconclusive`: the challenge is valid but the catalog pagination limit was
  reached before the facilitator proved the filtered result set complete.
- `fail`: the live challenge is wrong, the exact resource is absent from a
  complete filtered catalog result, or a supported search endpoint returns no
  RoundWatch hit for all qualification queries.

A failed search qualification is a distribution problem, not automatically a
payment/security defect. Do not change payment or evidence code merely to chase
search ranking.


## First live run and probe correction

The first production run on 2026-09-24 produced a valid live 402 contract, but
the original catalog probe scanned exactly 20 pages / 2,000 entries and then hit
its own hard page cap without finding RoundWatch. Because that scan had not
proved that the catalog was exhausted, treating the result as a definite
catalog absence was a probe bug rather than evidence that RoundWatch had been
removed from Bazaar.

The corrected probe uses the standard `payTo` filter first and records whether
pagination is actually complete. A capped incomplete scan is now
`inconclusive`, never a false absence proof.

The same first run also showed HTTP 404 for all four
`/discovery/search` requests. That means the currently configured GoPlausible
facilitator does not expose that optional endpoint at the probed path; it does
not make a valid catalog listing fail by itself.

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
