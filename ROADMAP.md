# RoundWatch Roadmap

RoundWatch is a live x402-paid service for durably observing one exact future
Algorand USDC payment.

This roadmap describes product direction, not delivery dates. Items may move
between stages as production evidence, ecosystem changes, and operational
constraints improve our understanding of what is worth building.

## Product principle

RoundWatch should stay narrow:

`one exact expected payment -> durable observation -> deterministic on-chain evidence`

The product should not absorb generic monitoring, workflow orchestration, or
notification features unless real usage shows that those capabilities belong in
the settlement-observer boundary.

Correctness, payment integrity, security, and recovery semantics take priority
over feature demand. New product capabilities should be justified by evidence;
correctness work should not wait for demand.

## Shipped

The current production baseline includes:

- Algorand MainNet production API;
- x402 v2 service payment through the GoPlausible facilitator;
- Bazaar discovery integration and challenge attribution;
- one durable watch for one exact future Circle USDC payment;
- exact matching of sender, receiver, asset, atomic amount, and optional invoice
  note;
- persistent SQLite state on a mounted Render disk;
- restart-safe watch state and scan progress;
- deterministic service-payment identity persisted before settlement;
- settlement reconciliation across the settlement/activation crash window;
- activation from the exact confirmed service-payment round;
- same-round invoice exclusion and a fixed activation baseline;
- a 30-minute creation-based eligibility deadline whose passage alone does not
  manufacture expiry;
- terminal expiry only after complete validated chain coverage through a fixed
  closing checkpoint;
- finite round windows, strict page/watermark validation, and no durable cursor
  advance on incomplete scans;
- a shared finite Indexer dispatcher with bounded rate, burst, and aggregate
  concurrency;
- fair bounded poll sweeps so one busy or failing watch cannot monopolize the
  service loop;
- an immutable 500-turn durable work budget per watch, with exhaustion terminating
  as `indeterminate` rather than fabricating an expiry proof;
- bounded open-obligation capacity: 50 globally and 5 per verified service
  payer;
- admission before settlement when capacity is unavailable;
- public status retrieval through `GET /v1/watch/:id`;
- checksum-valid Bazaar discovery examples covered by regression tests;
- a post-deploy external production `402` smoke that verifies the live URL,
  MainNet network, exact scheme, Circle USDC ASA, price, and Bazaar examples;
- MainNet paid end-to-end proof from the pre-hardening production baseline; and
- public MIT-licensed repository and technical documentation.

The shipped Bazaar integration is not the same claim as proven autonomous
discoverability. A compatible client can inspect the live machine-readable
contract, but black-box discovery by an unknown agent remains a separate
milestone below.

## Now — Autonomy Foundation v0

The immediate priority is to make the payment and watch lifecycle unambiguous,
recoverable, and safe for autonomous clients before adding more convenience
layers.

### Production baseline and autonomy boundary

The current MainNet baseline is now captured and regression-tested:

- production resource: `POST /v1/watch`;
- status resource: `GET /v1/watch/:id`;
- live `402 Payment-Required` terms for URL, network, scheme, asset, amount,
  and service receiver;
- checksum-valid Bazaar examples in the live discovery metadata;
- a preserved paid MainNet proof for comparison; and
- a free external post-deploy smoke for the current hardened release.

The target remains **zero RoundWatch-specific setup**, not zero infrastructure
setup. An autonomous client may already have an x402-capable signer or wallet,
Algorand MainNet access, USDC, a spend policy, and access to a supported Bazaar
discovery root. It should not require a preconfigured RoundWatch URL, SDK,
README, MCP server, or hand-written parameter mapping.

### Remaining lifecycle and public-contract work

The correctness baseline is hardened; the remaining work is primarily about
making that behavior explicit and ergonomic for autonomous clients:

- define stable machine-readable error codes across validation, capacity,
  settlement uncertainty, idempotency conflicts, and status reads;
- distinguish safe idempotent replay from conflicting reuse of an idempotency
  key without risking duplicate settlement;
- decide whether a watch ID is intentionally a bearer capability and document
  which returned fields are safe for public retrieval;
- expose stable `terminal` and `retryable` semantics;
- expose polling guidance such as `pollAfterMs` and an explicit `statusUrl`;
- ensure status reads and recovery states are easy for an automated client to
  interpret without knowing implementation details; and
- keep every retry path incapable of turning recovery into a second service
  charge.

The chain-time expiry, exact activation baseline, bounded Indexer work,
pre-settlement admission, recovery semantics, and no-wall-clock-side-effect
rules are implemented production invariants rather than roadmap items.

### x402 / AVM compatibility

The current production path mixes the main x402 packages with the older
`@x402-avm/extensions` integration. Before changing that boundary:

- test the current official x402 extension path with AVM on TestNet;
- validate Bazaar metadata generation and parsing;
- validate the full `402 -> verify -> handler -> settle` lifecycle;
- validate discovery behavior after settlement;
- run a small paid TestNet end-to-end flow;
- only then migrate the MainNet production integration if the replacement is
  proven compatible.

Do not upgrade the payment/discovery stack in production merely to remove an
awkward type cast.

## Cross-cutting — operational observability

Maintain enough privacy-preserving telemetry to understand and debug the x402
and watch lifecycle while the autonomy work proceeds.

Useful signals include:

- request correlation across `402 issued -> paid retry -> watch created -> settled`;
- watch transitions such as `active`, `matched`, `expired`, `indeterminate`, and
  recovery states;
- route, timestamp, latency, HTTP status, and bounded safe client metadata;
- settlement, reconciliation, poller, capacity, and discovery failures;
- classification such as known internal test, known discovery probe, known
  external integration, or unknown when the evidence supports it.

Do not infer genuine customer demand from settlement counts or weak client
fingerprints alone.

## Next — Agent Discovery v1

Once the autonomy foundation is stable, make RoundWatch discoverable and
self-describing enough for an unknown compatible agent to use it correctly.

### Executable machine contract

Define one executable contract as the source of truth for:

- runtime input validation;
- input and output schemas;
- stable error codes;
- public lifecycle states;
- `terminal` and `retryable` semantics;
- `pollAfterMs` or equivalent polling guidance;
- status location / `statusUrl` behavior;
- Bazaar discovery metadata.

Avoid maintaining separate hand-written versions of the same contract for the
handler, documentation, Bazaar, and future tooling.

The API contract describes the operation. The live x402 `402 Payment-Required`
response remains the authority for the current price, network, asset, payment
scheme, and payment destination.

### Bazaar qualification

Improve and then test discovery rather than assuming that registered metadata is
sufficient:

- publish precise capability, input, output, and failure metadata;
- use clear search vocabulary around Algorand, USDC, invoice/payment observation,
  exact transfer matching, and durable watch behavior;
- validate descriptions, tags, examples, and schemas as seen by the discovery
  client;
- test several natural-language discovery queries;
- verify registration, refresh, and rejection behavior;
- treat Bazaar metadata as discovery information, not as authoritative current
  payment terms.

### Black-box autonomous agent test

The milestone is complete only when a compatible agent that is not given the
RoundWatch name, URL, README, SDK, or custom instructions can:

1. discover an appropriate payment-observation capability;
2. identify RoundWatch from the discovery results;
3. understand the required input and output contract;
4. request the resource and inspect the live `402`;
5. apply its own spend policy;
6. authorize and pay through x402;
7. create a watch;
8. follow the returned status contract;
9. reach and correctly interpret a terminal result;
10. extract deterministic on-chain evidence for a match.

Then repeat the flow under controlled failures, including:

- lost HTTP response after settlement;
- duplicate request / idempotency replay;
- service restart;
- stale discovery metadata;
- capacity exhaustion;
- settlement uncertainty and recovery;
- payment close to the watch expiry boundary.

The target is a correct result or an explicit terminal failure without duplicate
charging.

## Next — Adoption and developer experience

Only after the public machine contract is stable should convenience layers encode
it.

Planned work:

- publish focused HTTP/x402 integration examples;
- publish agent integration examples built from the proven black-box flow;
- add OpenAPI and lightweight LLM-oriented discovery documentation where useful;
- evaluate an MCP surface only if it materially improves distribution or
  ergonomics beyond the proven Bazaar + HTTP x402 path;
- keep a single payment boundary if an MCP surface is added;
- add a small TypeScript SDK if repeated integration cost justifies it;
- provide typed helpers for creating and reading watches;
- add an optional bounded-polling `waitForMatch` helper;
- expose the same typed lifecycle and error semantics as the public API;
- add `CONTRIBUTING.md` and a concrete contributor workflow.

The SDK, MCP surface, and documentation must remain thin consumers of the public
contract rather than independent sources of truth.

## Later — lifecycle and delivery

Consider only when user evidence justifies the additional surface area:

- webhook or push delivery as an alternative to polling;
- cancellation where the economics and settlement semantics are clear;
- authenticated/private watch status if bearer-style watch IDs are insufficient;
- longer or configurable eligibility windows;
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

Correctness, security, payment integrity, and recovery issues move forward when
they are discovered, regardless of customer demand.

Product capabilities may move forward when one or more of these signals appear:

1. repeated requests from independent users;
2. independent paid usage tied to a real workflow;
3. a recurring integration cost that tooling can remove;
4. production evidence that an existing interface is causing avoidable failures;
5. ecosystem changes that materially affect x402 or Algorand integration.

Attractive features should remain unbuilt when the evidence is only speculative.

## Contributing

The repository is public and MIT licensed. A formal contributor guide and scoped
contribution workflow are part of the adoption/developer-experience milestone.

Until then, focused issues and pull requests that preserve the documented product
and security boundaries are easier to evaluate than broad rewrites. Work touching
payment, settlement, idempotency, expiry, or watch-state semantics should be
scoped against the current invariants before implementation.

See [README](README.md), [Architecture](docs/ARCHITECTURE.md), and
[Security](docs/SECURITY.md) for the current implemented contract and trust
boundaries.
