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


The second production run, after adding the `payTo` filter and completeness
tracking, reported a catalog total of 2,225 resources while the probe still had
a 2,000-resource safety cap. It therefore correctly returned
`overall: "inconclusive"` rather than claiming absence. This also showed that
the filter did not make the result set small enough for the original cap; the
probe cannot infer from that alone whether the facilitator ignored the optional
filter or legitimately returned that many matching rows.

The probe now allows up to 10,000 catalog resources. That comfortably covers
the observed 2,225-resource catalog while preserving a bounded external scan.
If a future catalog exceeds that cap before an exact RoundWatch match is found,
the result remains `inconclusive`.

## Third live run — confirmed catalog visibility defect

The third production run on 2026-09-24 completed the full catalog reported by
the facilitator: 23 pages, 2,230 resources, `complete: true`. The exact
RoundWatch production resource URL was not present, so the resulting
`overall: "fail"` is now a real distribution finding rather than a probe
artifact.

At the same time, the live unpaid RoundWatch response remained valid: HTTP 402,
x402 v2, expected MainNet payment terms, `serviceName: "RoundWatch"`, the
expected discovery tags, and the Bazaar HTTP input/output declaration were all
present. The problem is therefore current catalog visibility, not missing live
resource metadata.

The x402 Bazaar flow catalogs a resource when the facilitator processes a
paying client's echoed Bazaar extension. Historical RoundWatch evidence shows
that this happened successfully on 2026-09-16, but the current catalog no longer
contains the resource. The next proof step is a single deliberately authorized
MainNet service settlement using the current metadata, followed by another
read-only catalog qualification.

The x402 `EXTENSION-RESPONSES` channel is facilitator-to-resource-server
internal metadata. It is intentionally stripped from the buyer-facing
`PAYMENT-RESPONSE`, so the paying client must not treat absence of that header
as a Bazaar failure. RoundWatch now logs any future Bazaar sidechannel outcome
from the server-side settle hook instead.

Use the guarded helper:

```bash
pnpm -C apps/client probe:bazaar-recatalog preflight
```

The preflight is free and cannot sign or settle. The paid mode is intentionally
blocked unless the exact MainNet spend has been explicitly approved and
`--confirm-mainnet` is supplied:

```bash
pnpm -C apps/client probe:bazaar-recatalog settle --confirm-mainnet
```

That paid command creates one normal RoundWatch obligation and spends exactly
one current service payment of 0.02 USDC plus the Algorand network fee. It does
not send the watched invoice payment.

## Paid recatalog settlement

A deliberately authorized production settlement was completed on
2026-09-24 using the current 0.02 USDC service contract:

- HTTP 200 from the paid resource;
- settlement succeeded on Algorand MainNet;
- service transaction:
  `VC5DYV4VC2PXPX66YX6GBGDA2Y2AWRURXQ6KKPBZNRTV6YAFMAHA`;
- durable watch:
  `73296bbf-9429-4512-8caa-30a09cfc320b`.

The buyer-facing response did not contain `EXTENSION-RESPONSES`. That is the
protocol-correct behavior: the sidechannel is server-internal and is not
forwarded to buyers. The original recatalog helper incorrectly expected buyer
visibility; that diagnostic assumption was corrected before drawing any Bazaar
conclusion from the missing header.

The next evidence point is therefore a fresh full catalog qualification after
this settlement.

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
