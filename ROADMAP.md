# RoundWatch Roadmap

RoundWatch is a live x402-paid service for durably observing one exact future
Algorand USDC payment.

This roadmap describes product direction, not delivery dates. Items may move
between stages as production evidence, user feedback, ecosystem changes, and
operational constraints improve our understanding of what is worth building.

## Product principle

RoundWatch should stay narrow:

`one exact expected payment -> durable observation -> deterministic on-chain evidence`

The product should not absorb generic monitoring, workflow orchestration, or
notification features unless real users show that those capabilities belong in
the settlement-observer boundary.

## Shipped

The current production baseline includes:

- Algorand MainNet production API;
- x402 v2 service payment through the GoPlausible facilitator;
- Bazaar discovery and challenge attribution;
- one durable watch for one exact future Circle USDC payment;
- exact matching of sender, receiver, asset, atomic amount, and optional invoice
  note;
- persistent SQLite state on a mounted Render disk;
- restart-safe watch state and scan progress;
- settlement reconciliation across the settlement/activation crash window;
- safe activation from a confirmed Algorand round;
- durable matched transaction ID and confirmed round;
- 30-minute server-controlled watch lifetime;
- bounded open-obligation capacity;
- public status retrieval through `GET /v1/watch/:id`;
- MainNet paid end-to-end proof;
- public MIT-licensed repository and technical documentation.

## Now — observability and real usage evidence

The immediate priority is to understand how RoundWatch is actually discovered
and used without collecting unnecessary sensitive data.

Planned work:

- correlate requests across the x402 flow;
- distinguish `402 issued -> paid retry -> watch created -> settled`;
- track watch outcomes such as `matched`, `expired`, and recovery states;
- record route, timestamp, latency, status, and safe client metadata where useful;
- separate probes, automated discovery, controlled tests, and genuine external
  usage as far as the available evidence permits;
- expose a small operational funnel suitable for product decisions;
- preserve the current privacy and signer boundaries.

Settlement counts alone must not be treated as customer demand.

## Next — developer experience

Make the existing API easier to consume without hiding its trust model.

Planned work:

- define and publish a stable machine-readable API contract;
- add a small TypeScript SDK rather than a large framework;
- provide typed helpers for creating and reading watches;
- add an optional `waitForMatch` helper with bounded polling behavior;
- expose clear typed error states for payment, expiry, capacity, and settlement
  uncertainty;
- publish focused integration examples;
- add `CONTRIBUTING.md` and a concrete contributor workflow.

The SDK should remain a thin layer over the public API. The API contract remains
the source of truth.

## Next — agent-native consumption

Make RoundWatch understandable and usable by autonomous clients with minimal
human setup.

Planned work:

- improve capability, pricing, input, and output metadata for machine discovery;
- keep Bazaar discovery aligned with the live API contract;
- provide an MCP tool/server surface where it adds real value;
- publish examples showing an agent discovering RoundWatch, understanding the
  schema and price, paying through x402, and consuming the result;
- make failure and recovery states explicit enough for automated reasoning.

Deterministic settlement and payment matching remain outside the language-model
decision boundary.

## Later — lifecycle and delivery

Consider only when user evidence justifies the additional surface area:

- webhook or push delivery as an alternative to polling;
- cancellation where the economics and settlement semantics are clear;
- authenticated/private watch status where public watch IDs are insufficient;
- longer or configurable watch lifetimes;
- renewal or standing-watch models;
- stronger operational reporting.

These are not current commitments.

## Later — scale and reliability

The current single-instance SQLite design is intentional for the challenge
release and current traffic level. Scale work should follow measured need.

Possible future work:

- coordinated background workers;
- a database architecture suitable for multiple application instances;
- horizontal scaling and queue-backed observation;
- load and failure testing against explicit capacity targets;
- operational SLOs and, only when supportable, an external SLA.

Do not introduce distributed infrastructure merely to make the architecture look
larger than the workload.

## Exploring

These ideas are intentionally uncommitted:

- support for additional assets;
- support for additional networks;
- longer-running settlement obligations;
- higher-level workflow integrations;
- use cases beyond exact future-payment observation.

Expansion should follow verified demand and preserve the core product boundary.

## How priorities change

A roadmap item may move forward when one or more of these signals appear:

1. repeated requests from independent users;
2. independent paid usage tied to a real workflow;
3. a recurring integration cost that the SDK/tooling layer can remove;
4. a production reliability issue in the current architecture;
5. ecosystem changes that materially affect x402 or Algorand integration.

Conversely, attractive features should remain unbuilt when the evidence is only
speculative.

## Contributing

The repository is public and MIT licensed. A formal contributor guide and scoped
contribution workflow are part of the developer-experience milestone.

Until then, focused issues and pull requests that preserve the documented product
and security boundaries are easier to evaluate than broad rewrites.

See [README](README.md), [Architecture](docs/ARCHITECTURE.md), and
[Security](docs/SECURITY.md) for the current implemented contract and trust
boundaries.
