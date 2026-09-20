# RoundWatch Economics Audit v1

Status: measured on `feat/economics-instrumentation-v1`. Pricing below is a launch recommendation, not a statement that the current production deployment has already been repriced.

## Objective

Measure normal, p95, and adversarial work for one purchased watch; bound worst-case service work without weakening correctness; measure unpaid abuse and retained storage; then choose a launch price from explicit volume assumptions rather than from the original challenge placeholder.

## Current contract after the audit

- One watch observes one exact future Algorand USDC transfer.
- Eligibility begins only after the exact RoundWatch service settlement is confirmed.
- The creation-based eligibility interval remains 30 minutes.
- `matched` is positive transaction evidence.
- `expired` still requires complete validated chain coverage through the fixed closing checkpoint.
- A purchased watch has an immutable durable work budget of 500 background work turns.
- Work-budget exhaustion terminates as `indeterminate` with `terminalReason=work_budget_exhausted`; it must never be reported as `expired`.
- One Indexer response page is rejected if it contains more than the requested 1,000 transactions.
- The current active/reconciliation paths therefore have a finite service-side work envelope rather than an unbounded paid obligation.

## Paid-work measurements

The production runtime uses scan query variant C: sender + exact amount, plus the exact note prefix when a watch has an invoice note.

Representative production-style 50-watch runs over 300 synthetic rounds:

| Workload | Physical requests/watch | Scan pages/watch | Transactions examined/watch | Response bytes/watch |
| --- | ---: | ---: | ---: | ---: |
| hot exact-note | 6 | 3 | 13.8 mean, 66 p95 | 4,326 mean, 19,941 p95 |
| hot no-note | 6 | 3 | 450 | 135,963 |

The no-note path is intentionally more expensive because variant C cannot add the note filter when the buyer did not supply a note.

A unique adversarial collision sweep demonstrated linear pagination. At 75,000 returned candidates over 300 rounds, one watch required 75 scan pages and about 24.35 MB of synthetic Indexer response data. After removing synthetic-backend generation cost from the harness, the benchmark process consumed about 0.56 seconds of CPU for that case. These CPU figures are structural benchmark observations, not a Render SLA.

The consensus block-byte limit provides a finite per-round collision ceiling, but the 30-minute chain-time contract did not provide a protocol-derived finite total-round ceiling. The durable 500-turn work budget closes that service-side economic gap without turning incomplete coverage into a false negative.

With the current implementation a work turn is claimed before background Indexer work. Active polling performs at most four Indexer requests in one turn; reconciliation performs at most three. The conservative service-side request ceiling is therefore at most 2,000 background Indexer requests for the 500-turn budget, plus the bounded initial purchase/activation path.

## Free-work audit

A 5,000-request, concurrency-50 in-process benchmark covered health, status reads, unpaid creation, malformed payment headers, and syntactically valid but rejected x402 payments.

The first run exposed two real unpaid-work vectors:

1. malformed `PAYMENT-SIGNATURE` values reached x402 middleware and generated large stack-trace log amplification;
2. a syntactically valid rejected payment caused one facilitator verification call per unpaid request.

The hardened path now:

- rejects malformed or oversized payment headers locally before x402 middleware;
- caps payment-signature header size at 16 KiB;
- places signed pre-settlement verification behind a token/concurrency gate;
- defaults to 10 signed-payment attempts/second, burst 20, concurrency 4;
- returns HTTP 429 with `Retry-After` when that verification capacity is exhausted;
- does not throttle ordinary unsigned 402 discovery.

The repeated 5,000-request benchmark reduced malformed-header CPU to about 0.059 ms/request with all requests rejected locally as HTTP 400 and zero facilitator calls. The signed rejection flood produced 22 facilitator verifications and 4,978 HTTP 429 responses, matching the configured burst/refill envelope.

The ordinary free paths remained small in this in-process benchmark, roughly 0.05-0.16 ms CPU/request. These figures describe relative application work, not public internet throughput or a hosting SLA.

## Storage and retention

No terminal-row retention policy existed before this audit. Terminal rows preserve public status/evidence and idempotency, so deletion is not economically free even if disk space is.

Measured durable SQLite size after close/checkpoint:

| State | 5,000-row DB | Approx. bytes/row |
| --- | ---: | ---: |
| settlement_pending | 3,653,632 B | 731 B |
| active | 4,165,632 B | 833 B |
| matched | 4,866,048 B | 973 B |
| expired | 4,169,728 B | 834 B |
| indeterminate | 4,894,720 B | 979 B |

All measured scenarios had `freelist_count=0`. Outstanding WAL settled around 4.1 MB in the larger runs; that file size is not cumulative write amplification.

At current row sizes, 100,000 retained watches are on the order of 0.08-0.10 GB and one million are on the order of 0.8-1.0 GB. Storage is therefore not currently a material per-watch cost. Terminal rows should remain durable until scale or policy requirements justify a compact archive/tombstone design.

## Cost model

Use:

`monthly_profit(V) = V * price - fixed_infra - indexer_cost(Q) - facilitator_cost(V) - storage_cost(S) - bandwidth_cost(B) - other_variable_costs`

and:

`fully_loaded_cost_per_watch(V) = total_monthly_cost(V) / V`

The currently observed deployment has approximately $7.25/month of fixed hosting cost. This is a deployment assumption supplied for the audit, not a provider price guarantee. Current external provider pricing/quotas can change and must be rechecked before treating them as long-term zero-cost inputs.

Storage contributes approximately one kilobyte or less per retained watch and is immaterial at the present scale.

Because fixed infrastructure dominates the currently measured cash cost, there is no volume-independent "true" price.

### Fixed-cost break-even before future variable provider charges

| Price/watch | Watches/month to cover $7.25 | Watches/day |
| --- | ---: | ---: |
| $0.005 | 1,450 | 48.3 |
| $0.010 | 725 | 24.2 |
| $0.020 | 363 | 12.1 |
| $0.050 | 145 | 4.8 |
| $0.100 | 73 | 2.4 |

These are break-even counts for fixed infrastructure only. They are not profit forecasts and do not include future paid Indexer/facilitator plans, taxes, operator time, or payment-network costs borne by buyers.

At the hard 2,000-background-request ceiling, a $0.02 watch could absorb an Indexer price of $10 per million requests before Indexer requests alone consume the full service revenue; a 50% pre-fixed-cost contribution margin would require an effective Indexer price no higher than $5 per million at that absolute ceiling. Normal watches should consume far less than the ceiling.

## Launch pricing decision

The original `$0.001` price is a challenge/proof-of-payment placeholder, not an economically justified commercial price.

Implemented release-candidate price: **$0.02 USDC per 30-minute watch** (`20000` atomic units). This becomes the live contract only after deployment and an unpaid MainNet `402` preflight confirms the advertised amount.

Rationale:

- $0.01 still requires about 725 watches/month merely to cover the present fixed hosting assumption.
- $0.02 lowers fixed-cost break-even to about 363 watches/month while remaining a two-cent machine payment.
- The 500-turn budget now prevents one purchased watch from becoming an unlimited service obligation.
- Free signed-payment amplification is bounded before settlement.
- Storage is negligible at current scale, so no retention surcharge is justified.
- $0.02 leaves materially more room for a future metered Indexer than $0.005-$0.01 without introducing pricing tiers before demand exists.

This is a launch recommendation, not proof that 363 monthly purchases will occur. At very low demand the service will still operate below cash break-even. Price must be revisited with real independent payer, repeat-buyer, completion, indeterminate-rate, and provider-cost data.

## Repricing triggers

Revisit price or contract when any of the following becomes material:

- paid Indexer or facilitator fees create a measurable variable cost per watch;
- p95 work-unit consumption approaches the 500-turn contract;
- `indeterminate` becomes more than an exceptional safety outcome;
- independent buyer conversion materially changes after repricing;
- retained rows approach the persistent-disk operating threshold;
- longer-duration or higher-work watch products are introduced.

Do not create pricing tiers merely to mirror internal implementation details. A tier should correspond to a buyer-visible difference in duration, work budget, delivery mechanism, or guarantee.
