# RoundWatch Autonomy Foundation v0

Status: active engineering milestone.

This document defines the acceptance boundary for making RoundWatch safe and
unambiguous for autonomous x402 clients. It is intentionally narrower than the
product roadmap and should be treated as an implementation gate, not a feature
wishlist.

## Target

A compatible autonomous client may already have:

- an x402-capable signer or wallet;
- Algorand MainNet access;
- Circle USDC;
- a spend policy; and
- access to a supported Bazaar discovery root.

It must not require:

- a preconfigured RoundWatch URL;
- prior knowledge of the RoundWatch name;
- a RoundWatch SDK;
- a RoundWatch-specific MCP server;
- a README; or
- hand-written parameter mapping supplied by a human.

The target is therefore **zero RoundWatch-specific setup**, not zero
infrastructure setup.

## Baseline to preserve

Current production behavior that must remain regression-tested while this
milestone is implemented:

- MainNet resource: `POST https://roundwatch-api.onrender.com/v1/watch`;
- status resource: `GET /v1/watch/:id`;
- x402 v2 payment through the GoPlausible facilitator;
- Circle USDC ASA `31566704`;
- service price currently advertised as `0.001 USDC`;
- durable SQLite state on persistent Render storage;
- settlement reconciliation across the settlement/activation crash window;
- exact future-transfer matching by sender, receiver, asset, atomic amount, and
  optional note;
- restart-safe scan cursor;
- bounded open-watch capacity;
- 30-minute server-controlled watch lifetime;
- Bazaar discovery integration and challenge attribution.

The dated MainNet proof and transaction evidence remain documented in
[MAINNET_READINESS.md](MAINNET_READINESS.md). This milestone does not authorize
another paid MainNet transaction merely to refresh that proof.

## Invariants

The following invariants must hold before the machine contract is declared
stable.

### Payment integrity

1. A resource operation is charged at most once.
2. An idempotent replay cannot cause a second settlement.
3. A conflicting reuse of an idempotency key cannot reveal another watch.
4. A failed application operation must not be reported as a successfully
   activated paid watch.
5. Settlement ambiguity must remain recoverable when deterministic evidence
   exists.
6. Definitive settlement mismatch must fail closed.

### Watch correctness

1. A watch never becomes active without a safe confirmed-round scan baseline.
2. A valid watched transfer near the expiry boundary must not be silently
   skipped.
3. Expiry semantics must be defined in terms that can be tested against
   confirmed Algorand rounds.
4. Poll failures for one watch must not advance its cursor or starve later
   watches.
5. Restart must not lose durable state, settlement identity, or scan progress.

### Public state semantics

Every externally visible state must answer, without interpretation by a human:

- is the state terminal?
- should the client retry the same operation?
- should the client continue polling this watch?
- can a new watch safely be created?
- what evidence is available if the watch matched?

The public contract must not expose two materially different recovery situations
under one indistinguishable machine state unless an additional field makes the
difference explicit.

### Polling

The public response should provide deterministic polling guidance such as
`pollAfterMs` or an equivalent standard header/field. Clients should not need to
guess a polling cadence.

### Status confidentiality

Before expanding discovery or tooling, explicitly define:

- whether `watchId` is a bearer capability;
- which fields are safe to expose from `GET /v1/watch/:id`;
- whether any lookup by idempotency key is public;
- what information may be returned on an idempotency collision.

Authentication is not required by this milestone unless the chosen privacy model
demands it.

## x402 / AVM compatibility gate

The production server currently uses the main x402 packages together with
`@x402-avm/extensions`. Migration of the extension layer is not a goal by
itself.

Before changing the production integration:

1. reproduce the current unpaid `402` contract on TestNet;
2. validate extension metadata generation and parsing;
3. validate `verify -> handler -> settle` behavior;
4. validate settlement hooks and deterministic settlement identity;
5. validate Bazaar registration/discovery behavior;
6. run server/client tests and the existing fault-injection path;
7. run a paid TestNet E2E only if needed to prove compatibility;
8. move MainNet only after the replacement path is proven.

## Machine contract gate

Only after the lifecycle invariants above are stable should RoundWatch publish a
canonical executable machine contract.

That contract should drive, directly or by generation:

- runtime input validation;
- input schema;
- output schema;
- stable error codes;
- public lifecycle states;
- `terminal` semantics;
- `retryable` semantics;
- polling guidance;
- status location; and
- Bazaar metadata.

The live x402 `402 Payment-Required` response remains the authority for current
payment terms such as network, asset, amount, scheme, and destination.

## Bazaar qualification gate

Registered metadata is not sufficient evidence of autonomous discovery.

Qualification requires:

- external discovery of the production resource;
- useful natural-language search terms;
- correct input/output metadata;
- correct resource URL and method;
- correct network and asset context;
- discovery metadata that does not conflict with the live `402`;
- explicit handling of stale or rejected registration metadata.

## Black-box acceptance test

A test agent receives only a goal, Bazaar access, an AVM-capable x402 wallet, and
a spend limit. It receives no RoundWatch name, URL, README, SDK, or custom
parameter instructions.

It must be able to:

1. discover a suitable exact-payment observation capability;
2. select RoundWatch from the discovery results;
3. understand the request schema;
4. request the resource and inspect the live `402`;
5. enforce its own spend policy;
6. authorize and pay;
7. create the watch;
8. follow the returned status contract;
9. reach a terminal result; and
10. extract deterministic on-chain evidence for a match.

The same flow must be exercised against controlled failures:

- lost HTTP response after settlement;
- duplicate replay;
- conflicting idempotency reuse;
- process restart;
- stale discovery metadata;
- capacity exhaustion;
- settlement uncertainty;
- expiry-boundary transfer.

Success means either a correct terminal result or an explicit terminal failure,
with no duplicate service charge.

## Out of scope for v0

The following remain deliberately outside the critical path:

- TypeScript SDK;
- `waitForMatch` convenience helper;
- full MCP server;
- webhooks/push delivery;
- configurable lifetime;
- cancellation;
- multi-network support;
- horizontal scaling.

They may be added later only after the public contract they would wrap is stable.

## First implementation sequence

1. Add regression tests for the current paid/replay lifecycle.
2. Add an explicit expiry-boundary test that demonstrates the current intended
   semantics.
3. Define public recovery/terminal state mapping.
4. Define idempotency collision semantics and confidentiality behavior.
5. Define polling guidance.
6. Implement the smallest server changes required to make those tests pass.
7. Re-run the existing settlement reconciliation and persistence tests.
8. Only then begin the executable machine-contract work.
