# x402 Opportunity Map

## Decision

**Preferred direction: RoundWatch — a prepaid, bounded wait for a future Algorand USDC invoice payment, with a durable result and authenticated callback.** An agent buys one watch, exits, and resumes when the precisely identified payment arrives or the monitoring window ends.

This is a **conditional product recommendation, with medium-low confidence in demand**, not a claim of uncontested whitespace. General Algorand webhooks already exist. Prepaid market alerts and a Base transaction-watch preview also exist. The opportunity is a small, operationally complete invoice-wait product: no service account provisioning, explicit maximum cost, invoice-level matching, recovery after interruption, and an honest distinction between payment observed, observation incomplete, and callback delivered.

The first BUILD run should implement a narrow TestNet proof and validate it with prospective buyers, not a general automation platform. Proceed to a challenge launch only after confirming eligibility, obtaining two independent integration commitments, and proving safe payment-to-job activation. If those gates fail, do not build this merely to create transactions.

Research snapshot: **11 September 2026, approximately 12:40–12:50 UTC**. Assumed resources: one experienced TypeScript developer, 7–10 working days for a narrow MVP, followed by integration and reliability work. Estimates exclude legal review, organizer responses, and partner acquisition. All proposed prices and adoption targets below are hypotheses.

## Evidence conventions and limits

- **VERIFIED FACT:** directly inspected repository code, primary documentation, or a public API response. A verified publication can still contain unverified vendor claims.
- **OBSERVATION:** a result in the retrieved sample, with its limits. A directory listing proves that the directory advertises a service, not that it works.
- **INFERENCE:** an analytical conclusion from evidence; not a measured market fact.
- **HYPOTHESIS:** proposed demand, pricing, implementation effort, or product behavior requiring validation.

The investigation covered official challenge rules and guides, GoPlausible's live discovery and leaderboard APIs, competing product documentation, public repositories, underlying Algorand tooling, and conventional substitutes. No third-party paid endpoint was purchased, no competitor account was created, and no customer interview was conducted. Therefore, paid functionality, customer retention, and willingness to pay remain unverified. No claim of comprehensive global coverage is made.

## Repository baseline

**VERIFIED FACT — local inspection.** `AGENTS.md`, `README.md`, both application entry points, all three package manifests, workspace configuration, and the existing documentation were read. `ARCHITECTURE.md`, `SECURITY.md`, and this opportunity map contained no substantive text before this run.

| Already implemented | Reuse in the product |
|---|---|
| Hono resource server on port 4021; free `GET /health` | Keep operational health separate from paid service delivery |
| Protected `GET /demo`, priced at 0.005 TestNet USDC | Preserve as a regression fixture; add product routes in a later build |
| x402 v2 exact AVM scheme and hosted GoPlausible client | Reuse payment verification and settlement |
| Bazaar declaration and `x402-global-challenge` attribution | Describe the actual purchased watch, including bounded input and output |
| Payer CLI: unpaid request, automatic signing/retry, settlement decode | Adapt into a bounded watch-purchase example without exposing its signer |
| Explicit full TestNet network identifier | Preserve known-good compatibility until separately verified |
| No database, auth, worker, UI, or product | Add only the persistence and worker required for durable waiting |

The repository records a successfully executed TestNet payment flow. That historical milestone is accepted as the baseline; this research did not rerun a funded transaction. The client pins x402 packages at 2.25.0; the server uses compatible ranges and a separately packaged Bazaar extension with a double type assertion. Neither the package versions nor the payment flow were changed.

## Challenge constraints that change the strategy

**VERIFIED FACT — current rules, §§5–8 and 14.** Initial registration ended September 1; final project information is due September 29; shortlisting runs September 30–October 8, notification October 9, and the final is virtual on November 2. Top-50 leaderboard placement plus project information is required for finalist consideration. Volume, use-case quality, sustained potential, and innovation are evenly weighted. Artificial volume, wash activity, and repeated self-payments can be excluded. [Official rules, September 3 revision](https://algorand.co/hubfs/Hackathon%20Terms%20and%20conditions/x402%20competition%20Official%20Rules_Sep3rd26_.pdf).

**Conflict:** the landing page still invites registration and uses a broader July–early October build timeline. The July guide describes an in-person final, superseded by the revised rules. Confirm existing registration and the team's eligibility with the organizer before spending for competition purposes; do not infer an extension from marketing copy. [Challenge page](https://algorand.co/global-x402-challenge), [July submission guide](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry).

The published entry path requires public HTTPS on MainNet, GoPlausible, Bazaar, the challenge tag, and a real settlement. TestNet success alone does not qualify. Standard, composite, and orchestrator entry types are supported. RoundWatch should start as a standard service; downstream payments are unnecessary. [Challenge page](https://algorand.co/global-x402-challenge).

**INFERENCE:** the practical objective is legitimate recurring purchases plus an understandable useful action, not the most endpoints or the highest loop frequency. A narrow service integrated into two real workflows can be stronger than hundreds of near-identical utilities. The current calendar favors existing data and standard infrastructure over new datasets, hardware networks, or a two-sided marketplace.

## Live landscape

### Catalog method and sample quality

Two read-only requests to GoPlausible discovery used `limit=1000`, offsets 0 and 1000, and `includeTestnets=false`. The combined response contained **1,982 records and 1,973 distinct resource URL strings**. It included duplicate method/URL variants, HTTP and HTTPS variants, a malformed `null/summary` URL, and TestNet offers despite the requested filter. Therefore 1,982 is not the number of live MainNet products or challenge entrants. [Catalog page 1](https://facilitator.goplausible.xyz/discovery/resources?includeTestnets=false&limit=1000&offset=0), [catalog page 2](https://facilitator.goplausible.xyz/discovery/resources?includeTestnets=false&limit=1000&offset=1000).

There were 1,795 records advertising Algorand MainNet USDC ASA 31566704. The largest host counts were Agent402 604, Sikho AI 279, VEAD 188, and Algorand Tracker 171. These four account for about 69% of that subset. Host aggregation is an imperfect proxy for provider identity. This is strong evidence of catalog concentration and route proliferation, not evidence of four dominant businesses.

For each of those 1,795 records, taking the first MainNet USDC offer and converting atomic units at six decimals gave a **listed median of $0.02**, minimum $0.0001, maximum $370. The maximum was a certificate batch offer, not a typical individual API call. These are record-weighted advertised prices, not transaction-weighted realized prices; duplicates and large catalogs affect the result. No claim about the ecosystem's typical realized transaction is justified from this alone.

### Challenge leaderboard snapshot

The query was `cat=merchants`, `range=all`, `env=mainnet`, `src=x402-global-challenge`, `limit=50`. It returned a total of 94 merchant rows and reported three hidden local rows. No explicit chain or currency filter was supplied; use the exact query to reproduce this view, and do not interpret it as the organizer's final project ranking. The displayed volume field is reproduced below, rounded for readability. [Live leaderboard API](https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&limit=50&range=all&env=mainnet&src=x402-global-challenge).

| Rank | Label or identifying host | Reported volume | Settlements | Interpretation |
|---:|---|---:|---:|---|
| 1 | x402-quant-signals.onrender.com | 14,388.80 | 143,959 | Signal APIs already attract recorded activity |
| 2 | ProofMint | 4,170.00 | 10 | A few large purchases can dominate volume |
| 3 | Syra | 3,555.50 | 20,440 | Broad intelligence competitor |
| 5 | One Step Chess | 962.12 | 525,529 | Many tiny payments; volume and count diverge |
| 6 | AgentMesh | 870.83 | 880 | Agent coordination is already represented |
| 8 | AgentHub | 636.37 | 7,530 | Algorand risk/decoding is already represented |
| 10 | HelixBox | 556.50 | 2,227 | Paid compute/session access is represented |
| 14 | TENDRIL | 471.10 | 694 | Compute rental is not an empty category |
| 19 | CANIX402 | 47.03 | 1,979 | Algorand DeFi execution/data competitor |
| 24 | IoMarkets Topup | 15.81 | 2 | External-world fulfillment is represented |
| 37 | 402Signal | 1.48 | 174 | Pre-purchase routing checks already exist |
| 47 | pkgproof | 0.45 | 9 | Package verification is already represented |
| 50 | AgentWork | 0.33 | 6 | Web evidence is already represented |

**OBSERVATION:** this view has a long tail, duplicate brands at different addresses, and very different purchase sizes. Do not treat the current rank-50 value as a qualification target: measurement window, grouping, filters, and organizer review can change it. The snapshot cannot establish whether payers are independent, purchases are useful, or volume will survive review. No competitor is accused of manipulation.

### Competitive coverage and prices

Prices in the following table are catalog observations unless a first-party product page is identified. Endpoint links identify the advertised service; the two catalog URLs above are the evidence where the endpoint was not independently inspected. MainNet and TestNet are distinguished where material. Most catalog capabilities were not exercised.

| Category / products | Publicly advertised offer | Strategic consequence |
|---|---|---|
| Search, extraction, browsers: Browserbase; Scrape402; AgentWork | Browserbase advertises $0.12/browser-hour and $0.01 search/fetch. AgentWork lists $0.005 web reads/changes and $0.01 digital-PDF extraction. [Browserbase](https://x402.browserbase.com/), [AgentWork read](https://api.agentwork.run/v1/web/read) | Basic access and parsing are crowded; wrapping a browser is weak differentiation |
| General tool collections: Agent402, Sikho, VEAD, NetIntel | Hundreds of small utilities; inference, arithmetic, web/security helpers and bundled workflows in the catalog | A larger menu is not an advantage for this repository |
| DeFi: CANIX402 | Listed positions $0.005, opportunity queries $0.01, execution quotes $0.10, swap transaction construction $0.005, prepaid session $0.25. [CANIX402](https://canix402-api.compx.io) | Generic Algorand DeFi discovery duplicates an established integration surface |
| Risk and transaction decoding: AgentHub; Arbiter | AgentHub website lists wallet risk $0.10, decoding $0.08; catalog descriptions contain lower, conflicting prices whose chronology was not established. Arbiter lists unsigned-transaction preflight at $0.002. [AgentHub](https://agenthub-production-8c75.up.railway.app/), [Arbiter route](https://arbiter-hs23.onrender.com/v1/judge/transaction) | Risk heuristics and rekey/close checks cannot be pitched as new; live 402 terms outrank conflicting prose |
| Supply-chain checks: pkgproof; Validex; Sachet | pkgproof lists eight npm verification checks at $0.05. Validex advertises engineering/OSV analysis, with TestNet offers observed. [pkgproof route](https://x402-algo.pkgproof.net/v1/verify) | A package-advisory wrapper is already represented and competes with free local tooling |
| Verification/reputation: 402Signal; 402audit; Recourse; Second Opinion | Routing checks, endpoint scoring, bonded SLA demos, and adversarial claim research. Second Opinion lists $0.20 researched and $0.03 quick checks. [402audit API](https://402audit.com/api-docs), [Second Opinion](https://secondopinionx402.com/v1/verify) | “Trust for agents” is crowded; provider signatures do not independently establish truth |
| Compute: TENDRIL; HelixBox | TENDRIL lists a $0.05 rental gate, subsequent credit billing at $12/hour for the advertised machine, and $1 jobs. HelixBox lists $0.25/hour session access. [TENDRIL](https://tendrilhq.com), [HelixBox route](https://helixbox-manager.onrender.com/v2/x402/cli/hour) | Scarce-resource payment is natural, but isolation, utilization, and competing capacity are hard |
| Content/certificates: ProofMint; AlgoFile; Authen | Certificate batch jobs, storage and provenance. ProofMint's sampled $370 offer buys a batch; its description includes rendering, pinning, minting and emailing. [ProofMint](https://proofmint.app/api/x402/certificates/bulk) | Generic timestamping or certificate minting would duplicate visible products |
| External actions: IoMarkets | Catalog advertises top-ups/eSIMs/payouts with quoted orders and delivered/refunded states; the observed offer was $15.31. [IoMarkets orders](https://iomarkets.app/v1/orders) | Higher order value helps volume, but fulfillment rights, support, fraud and compliance dominate |
| Games/coordination: One Step Chess; AgentMesh | Chess move purchase; agent coordination services. [Chess route](https://onestepchess.xyz/api/v1/moves), [AgentMesh](https://www.agent-mesh.app) | Easy repeated transactions do not alone establish durable demand |
| Vertical data: AgriIntellect; proptech.watch; Pacific data | Agriculture/logistics, French property comparables, and explicitly synthetic Pacific stock data occur in the catalog | Domain knowledge and rights matter more than payment novelty; synthetic data is not a commercial advantage |
| Travel | Foundation flight-search agent demo already exists. [Repository](https://github.com/algorandfoundation/x402-flight-search-demo) | Travel search alone is an example, not a differentiated submission |

The various sites using “Bazaar” in their names are not interchangeable with GoPlausible's catalog or the protocol's discovery extension. A listing in an unrelated marketplace does not establish challenge attribution. Discovery is useful distribution infrastructure, but is not proof that agents will autonomously find and buy the product. [Official Bazaar explanation](https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer).

### Closest competitors to the proposed winner

1. **FalconHook is the strongest substitute.** Its site describes Algorand transaction filters, signed callbacks, retries and dead letters; documentation uses registered accounts, JWT/API keys and managed rules. This verifies the product offer, not its latency or reliability. No current paid plan price was established. RoundWatch cannot claim to invent Algorand webhooks. Its proposed advantage must be purchase-per-invoice, terminal wait semantics, and no service-account provisioning. [Product](https://falconhook.com/), [API documentation](https://falconhook.com/docs).
2. **WhaleTape already sells bounded x402 alerts on Algorand.** Its own machine documentation advertises a $0.99, up-to-seven-day signal webhook product, with an Algorand mirror. These are market-signal subscriptions, not evidence that generic invoice matching is supported. The same documentation advertises paid settlement measurements, weakening a canary-monitoring alternative. [WhaleTape machine documentation](https://whaletape.xyz/llms.txt).
3. **WAKE402 / TXWAKE is close on lifecycle.** Primary machine documentation advertises $0.002 Base wakeups and a separate Base transaction-confirmation preview. It explicitly says external revenue is unproven and availability has no SLA. RoundWatch must solve an invoice whose transaction ID does not yet exist, rather than copy a timer or confirmation watcher onto another chain. [WAKE402 machine documentation](https://wake402.agentwake.workers.dev/llms.txt).
4. **AlgoKit Subscriber plus a queue is the strongest build-it-yourself alternative.** The official MIT-licensed TypeScript library already provides filtering, watermarks, recovery and inner-transaction support. Use it rather than reinvent block indexing; sell operation of a bounded job. [Repository](https://github.com/algorandfoundation/algokit-subscriber-ts).
5. **Conventional scheduling is very cheap.** QStash advertises $1 per 100,000 messages and a 1,000-message/day free tier. This is a delivery-cost reference, not a full blockchain-monitoring cost or permission to resell the provider. [QStash pricing](https://upstash.com/pricing/qstash).

### What appears underserved

**INFERENCE:** the weaker coverage is at operational boundaries: associating a payment with exactly one business action, retaining the obligation through process failure, stating what was and was not observed, and delivering a result to a short-lived agent. This is narrower than “observability” or “agent infrastructure.” The products above already solve portions of it.

The strongest x402 use is acquisition of a real bounded resource or action by a wallet-equipped caller without a billing relationship: compute time, a licensed data unit, external fulfillment, or an operated wait. A paid JSON wrapper over arithmetic, static metadata, or public data with no operational value is easy to replace. Subscriptions are usually better for known customers with continuous high-volume usage; x402 is most helpful for variable, cross-organizational, task-scoped purchases.

Algorand adds useful low-cost settlement and finality, and for RoundWatch is also the source of the event being watched. The meaningful advantage is a workflow entirely within one chain's asset/round semantics. It is not a claim that other chains cannot do the same job. The protocol's normal minimum fee is 0.001 ALGO per transaction, not zero; fee pooling/group structure and facilitator policy determine actual payer costs. USDC opt-in increases minimum balance by 0.1 ALGO. [Fees](https://dev.algorand.co/concepts/transactions/fees/), [asset operations](https://dev.algorand.co/concepts/assets/asset-operations/).

## Candidate generation before selection

The funnel considered 18 directions. Eight survived long enough for explicit scoring; ten were rejected as the first product.

| Direction | Initial rationale | Disposition |
|---|---|---|
| Invoice-specific bounded payment watches | Operated waiting for an agent that can stop running | Shortlist #1 |
| Paid purchase-path acceptance tests | Pay a real endpoint and inspect delivery, not just its 402 | Shortlist #2 |
| AVM simulation against explicit spend policy | Machine-readable effects before an agent signs | Shortlist #3 |
| Merchant-owned data licensing per result | Original supply and permissioned access can justify payment | Shortlist #4, only with a data partner |
| Bounded sandbox compute jobs | Clear scarce-resource unit and repeat use | Scored, not shortlisted |
| Multi-provider researched claim verification | Buy an independent challenge to a claim | Scored, not shortlisted |
| Receipt-backed external-world orders | Useful fulfillment and larger tickets | Scored, not shortlisted |
| Paid package-install preflight | Frequent developer-agent decision | Scored, not shortlisted |
| Generic scraper/browser/screenshot API | Valuable underlying action | Reject: incumbents and existing x402 providers |
| Another tool marketplace/router | Open discovery | Reject: cold start, listings already abundant |
| Wallet reputation score | Pre-payment screening | Reject: AgentHub/Arbiter overlap; weak labels and Sybil resistance |
| Generic receipt/notarization API | Portable records | Reject: existing extensions and provenance products; signature is not truth |
| General cron/wakeup service | Agent runtime persistence | Reject: WAKE402 and very cheap conventional schedulers |
| Weather/price/news wrapper | Easy integration and repeat calls | Reject: crowded, free substitutes, resale rights |
| LLM proxy or summarizer | Metered compute | Reject: supplier dependency and little margin/differentiation |
| On-chain game move economy | Many payments, vivid demo | Reject: paid repetition can obscure absence of real demand |
| Full agent orchestration platform | Multiple paid capabilities | Reject: scope and reliability; AgentMesh/Agent402 overlap |
| Hardware/physical-resource reservation | Truly scarce access | Reject for this window: no verified supply or integration partner |

### Serious-candidate economics and buyer fit

All price ranges here are **HYPOTHESES**, expressed in USDC-equivalent dollars; TestNet tokens have no revenue significance.

| Candidate | Buyer and paid unit | Why per-unit / repeat demand | x402 versus API key/subscription | Why Algorand |
|---|---|---|---|---|
| RoundWatch | Merchant's agent or job runtime; one invoice wait, $0.02/1h or $0.10/24h | Each invoice creates a separate bounded obligation; new invoices drive repeat purchases | Makes ad hoc provisioning machine-payable; standing merchant accounts may prefer FalconHook | Native USDC payment matching, finalized rounds, same-chain service purchase |
| Purchase-path testing | Seller's CI agent or integrator; $0.05–$0.25 service fee plus bounded downstream cost | Each release/integration warrants another acceptance test | Purchase funds a real downstream paid test; known teams can use Checkly + a signer | AVM settlement and delivery verification; existing payer code reusable |
| AVM policy simulation | Wallet/transaction-building agent; $0.01–$0.05 per unsigned group | New proposed actions require fresh simulation | Frictionless external verifier; frequent integrators can run algod themselves | AVM-specific groups, rekeys, close fields and asset effects |
| Licensed original data | Procurement/research agent; $0.10–$2 per permitted data result | Fresh, exclusive observations have recurring utility | One-off access across publishers; subscriptions better for systematic extraction | Low-value settlement and publisher receipts, but little exclusive chain advantage |
| Sandbox compute | Coding/analysis agent; $0.02–$0.50 per bounded job | Each execution consumes capacity | Strong task-level payment fit; subscriptions win with predictable utilization | Small payments and clear settlement; compute itself is chain-agnostic |
| Claim verification | Research agent; $0.10–$0.50 per bounded claim | New claims create new verification work | Ad hoc independent supplier purchase; fixed teams can call models directly | Cheap payment; little unique Algorand value |
| External orders | Agent acting for a principal; cost plus $0.10–$1 fee | Every top-up or product is a genuine order | Strong machine purchase fit; identity/fulfillment auth remains necessary | Stablecoin settlement; provider acceptance and legal constraints dominate |
| Package preflight | Coding agent; $0.01–$0.05 per package/version | New installs/upgrades create checks | No onboarding, but free local policy tooling is often better | Micropayment transport only; weak chain-specific reason |

| Candidate | Required external dependency | Hardest engineering | Commercial weakness / toy-dismissal risk |
|---|---|---|---|
| RoundWatch | Reliable algod access and persistent hosting | Activation after settlement, complete catch-up, expiry and delivery recovery | Tiny reachable buyer base; “FalconHook with a paywall” unless invoice workflow is proven |
| Purchase-path testing | Cooperating target endpoints, operating wallet, chain read service | SSRF protection, spend bounds, ambiguous settlements, meaningful output assertions | Competes with free probes; instrumentation should not be sold as organic ecosystem demand |
| AVM simulation | Simulation-capable algod and verified policy fixtures | Effects of groups/inner calls; stale state and conservative verdicts | Existing preflight products; inaccurate “safe” verdict destroys credibility |
| Licensed original data | Publisher rights and genuinely useful changing supply | Provenance, freshness, access control and allowed redistribution | No partner identified; an invented/synthetic dataset is not a business |
| Sandbox compute | Isolated execution provider or owned compute | Tenant isolation, execution limits, egress control, scheduling | Cost/utilization and incumbent scale; arbitrary code execution is expensive to secure |
| Claim verification | Search and model APIs | Provenance and consistent abstention under ambiguity | Second Opinion already offers it; verdict quality is hard to evaluate |
| External orders | Contracted fulfillment provider and applicable permissions | Delivery/refund reconciliation and abuse controls | IoMarkets overlap; little chance to establish operations in a short sprint |
| Package preflight | Registries/advisory feeds with acceptable usage terms | False negatives, stale results, scripts and provenance | pkgproof exists; paid OSV lookup alone is easily dismissed |

## Comparison matrix

Scores are coarse **1–10 judgments**, not measured forecasts. Higher is better throughout; **dependency score means lower dependency risk**. Feasibility and speed assume this repository and the short build window. Demand refers to reachable demand for this version, not the size of the broader industry. Differences of one point are weak evidence.

| Candidate | Demand | x402 need | Difference | Algo fit | Pricing | Repeat | Feasible | Speed | Demo | Judge clarity | Dependency | Defense |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| RoundWatch | 5 | 7 | 6 | 9 | 7 | 8 | 7 | 7 | 9 | 9 | 7 | 4 |
| Purchase-path testing | 6 | 8 | 5 | 8 | 7 | 7 | 6 | 7 | 8 | 8 | 5 | 4 |
| AVM policy simulation | 6 | 5 | 4 | 10 | 6 | 9 | 6 | 6 | 9 | 8 | 6 | 5 |
| Licensed original data | 4 | 7 | 7 | 5 | 7 | 8 | 5 | 3 | 7 | 8 | 2 | 8 |
| Sandbox compute | 7 | 8 | 3 | 5 | 7 | 9 | 4 | 3 | 9 | 9 | 4 | 3 |
| Claim verification | 6 | 5 | 3 | 4 | 5 | 7 | 6 | 7 | 7 | 8 | 4 | 3 |
| External orders | 6 | 9 | 4 | 6 | 8 | 8 | 3 | 2 | 10 | 10 | 2 | 5 |
| Package preflight | 6 | 3 | 3 | 3 | 5 | 8 | 8 | 9 | 7 | 9 | 7 | 3 |

No weighted decimal total is used. Selection prioritizes an actual operated service, reachable build scope and Algorand relevance, then differentiation and repeat use. Acquisition uncertainty prevents any demand score from being high for an unlaunched offering.

**Score rationale:** RoundWatch's strongest scores come from a visible end-to-end action, repeated invoices and native chain state; its weak scores reflect unproven buyers and easy copying. Purchase-path testing makes x402 essential to the test itself, but supplier dependence and instrumentation-related challenge risk lower it. Simulation is exceptionally chain-specific, yet free native simulation and multiple preflight competitors reduce x402 necessity and difference. Licensed data has potential defensibility only if exclusive supply is secured; the current absence of a partner explains poor speed and dependency scores.

Compute has established category demand and clear metering but would require an isolation/operations stack this repository lacks. Claim verification can be built quickly but has direct competition and costly quality assurance. Real-world orders have the clearest commercial act, but partner, legal and refund operations are unrealistic here. Package checks are fast to ship and frequently needed, yet free tools and pkgproof make both payment necessity and defensibility poor.

**Sensitivity:** with a signed, usable data agreement and committed buyer, licensed data could become #1. With a team experienced in AVM simulation and wallet partners, simulation could outrank RoundWatch. If invoice buyers already use managed webhooks and decline per-wait purchasing, RoundWatch loses its reason to exist. The ranking is not robust to those changes, and should not pretend otherwise.

## Adversarial review of the shortlist

| Attack | RoundWatch | Purchase-path testing | AVM policy simulation | Licensed original data |
|---|---|---|---|---|
| Demand | Agents usually have an existing backend that can wait for free | Serious sellers may already test payment themselves | Wallets may implement checks locally | Neither supplier nor buyer secured |
| Economics | One-cent prices cannot support manual incident handling | Tests consume downstream funds even when the report is negative | Free RPC compresses willingness to pay | Licensing and support may exceed small-ticket margin |
| Differentiation | FalconHook + WhaleTape + TXWAKE cover much of the story | probe402, WhaleTape and manual audits cover real paid tests | AgentHub/Arbiter/preflight overlap | Depends on supply, not the payment code |
| Feasibility | Durable observation and payment/job reconciliation are nontrivial | Untrusted endpoints and uncertain charges require strict controls | Unknown contracts and incomplete state create uncertain results | Data normalization and rights are not solved by an API wrapper |
| Reliability / latency | Node outage cannot be reported as “invoice unpaid” | Timeout is not proof of non-settlement or bad seller | Simulation may be stale before execution | Stale or wrong data can be worse than no data |
| Dependency | Public-node fair-use limits; persistent hosting required | Facilitator, target and chain must all cooperate | Provider must expose adequate simulation capabilities | Publisher can change price, rights or availability |
| Legal / licensing | Minimize invoice metadata; no custodial funds; obtain terms/privacy review appropriate to operation | Need permission for side-effectful tests; don't resell protected response bodies | Avoid financial-safety guarantees and unsupported risk claims | Explicit resale/redistribution rights are a hard gate |
| Abuse | Callback SSRF/spam, guessed invoice identifiers, fraudulent matching | Wallet draining via malicious quotes; SSRF; misleading ratings | CPU-heavy groups; users interpreting “pass” as guarantee | Bulk exfiltration, unauthorized personal data resale |
| Demo / judges | Looks like a cron unless crash recovery and invoice identity are visible | Looks like infrastructure testing, and transactions are instrumentation | Dramatic blocked-drain demo can hide weak general coverage | Mock data makes the value claim collapse |
| x402 / Algorand | API-key subscriptions are better for a permanent merchant | Payment native, but chain specialization alone is easy to copy | x402 not needed for local simulation | x402 valuable for access; Algorand mostly a payment rail |
| Build time | 7–10 working days for bounded MVP; production readiness longer | 5–8 days for an allowlisted prototype; public arbitrary targets much longer | 7–12 days for limited group classes; not a general audit engine | 4–7 engineering days after supply is legally and technically ready |

Two particularly strong disconfirming sources: probe402 already separates unpaid collectors from a paid settlement instrument, and a manual purchase-path audit competitor explicitly reports zero audits delivered. An advertised service and a real problem do not establish a market. [probe402 method](https://probe402.com/method), [10x402 audit](https://10x402.com/audit). Conventional multistep monitoring is another substitute. [Checkly pricing and capabilities](https://www.checklyhq.com/pricing/).

## Ranked shortlist

### 1. RoundWatch: prepaid invoice wait

**Definition:** operate one precisely scoped Algorand USDC invoice watch until payment or timeout, then retain and deliver the outcome. **Buyer:** merchant automation or an agent runtime acting for it. **Paid action:** a one-hour or one-day watch. **x402 role:** purchase a bounded execution obligation without opening a billing account. **Algorand role:** source of the observed payment and settlement of the watch fee.

**MVP:** one expected sender/receiver pair, canonical USDC, exact atomic amount, random invoice note, one terminal event, authenticated callback, free authenticated status, durable recovery. **Price hypothesis:** $0.02/1h, $0.10/24h. **Dependency:** algod plus persistent storage/hosting. **Advantage:** operationally useful and chain-specific without contracts or custody. **Weakness:** narrow demand and strong general webhook substitutes. **Could win:** two independent products visibly purchase it for real invoices and demonstrate recovery. **Could fail:** it is merely a paid replacement for a few lines in a backend that already exists.

### 2. Paid purchase-path acceptance tests

**Definition:** an on-demand CI check that actually purchases an allowlisted x402 response and tests settlement plus a buyer-supplied output contract. **Buyer:** sellers and integrators through CI agents. **Paid action:** one bounded test report. **x402 role:** both funding the test and making the real downstream purchase. **Algorand role:** exact AVM settlement inspection. **Price hypothesis:** $0.05–$0.25 plus a disclosed maximum downstream cost.

**MVP:** two cooperating read-only endpoints, pinned seller/asset/network/price, response schema and freshness assertions, redacted evidence, no arbitrary URL execution. **Dependency:** target cooperation and a capped operational wallet. **Advantage:** directly tests a failure that free health checks miss. **Weakness:** existing canaries and difficult interpretation of paid measurement activity. **Could win:** prevents documented revenue-impacting regressions. **Could fail:** all demand is challenge participants buying tests to inflate activity; no durable customer remains. Explicitly disclose and separate instrumented purchases from organic downstream demand.

### 3. AVM intent-constrained simulation

**Definition:** simulate an unsigned transaction group and compare its effects to the caller's explicit asset, recipient and spending policy. **Buyer:** wallet and transaction-building agents. **Paid action:** a bounded simulation report. **x402 role:** pay an independent analysis service per proposed action. **Algorand role:** AVM groups and effects are the product. **Price hypothesis:** $0.01–$0.05/group.

**MVP:** payment/ASA transfers plus one documented application integration; checks for rekey/close, unexpected recipients and budget violations; return inconclusive for unsupported behavior. **Dependency:** algod simulate endpoint. **Advantage:** deterministic policy failures make a strong demo. **Weakness:** native simulation is already available and preflight competitors exist. **Could win:** explicit effect constraints outperform generic risk scores. **Could fail:** misleading “safe” output, unsupported contracts, or a wallet integrates the same logic locally. [Official simulation API](https://dev.algorand.co/reference/rest-api/algod/operations/simulatetransaction/).

### 4. Licensed original operational data

**Definition:** a publisher sells a fresh, rights-cleared unit of operational data to an agent, with provenance and a permitted-use record. **Buyer:** research/procurement software. **Paid action:** one result or small batch. **x402 role:** ad hoc paid access across organizations. **Algorand role:** small settlement and payment evidence. **Price hypothesis:** $0.10–$2/result, negotiated against actual supply cost.

**MVP:** one publisher, one schema, freshness rules and a real buyer workflow; no marketplace. **Dependency:** a rights holder willing to supply and permit resale. **Advantage:** owned supply can be defensible. **Weakness:** no such partner was established. **Could win:** authentic data access beats generic wrappers. **Could fail:** public substitutes, resale restrictions or synthetic demonstration data. Do not start engineering this direction before the supply agreement exists.

## Winner blueprint: RoundWatch

Everything in this section is a **proposed design**, except where an external or local fact is explicitly cited. It is sufficiently concrete for a build, but does not certify production safety.

### Product and exact boundary

**Pitch:** “Your agent pays once to wait for an Algorand invoice, then leaves; RoundWatch records the result and wakes your workflow.”

Target a small merchant/job platform already using Algorand USDC but lacking persistent per-invoice orchestration. The first buyer is its software agent, funded and authorized by that business. Do not target every chatbot, consumers without wallets, or merchants already happy with a standing webhook provider.

The problem is waiting for a **future separate invoice payment whose transaction ID is unknown**. It is not waiting for confirmation of the watch purchase itself: x402 already returns settlement information for that. The fee pays for operated monitoring, recovery, retention and bounded delivery attempts. The invoice principal goes directly from the invoice payer to the merchant; RoundWatch receives only its service fee.

x402 is essential to the proposed no-account acquisition flow, not mathematically necessary for monitoring. The same service could use prepaid API keys. If callers already have persistent service accounts and wallets add more friction than they remove, that falsifies the target segment. Avoid claiming “no authentication”: purchase and retrieval still require authorization and capability protection.

### Payment and commercial contract

- **MVP tiers:** $0.02 for up to one hour; $0.10 for up to 24 hours. Fixed price, one invoice condition, one terminal outcome, at most five callback attempts, result retention seven days after termination. Introduce only the one-hour tier in the first integration proof if time is tight.
- The unpaid prepare step validates the specification and available capacity. An x402 payment then purchases that immutable watch. Price is for operating the wait, even if the expected invoice never arrives; no pay-per-poll charges.
- Each new invoice or explicitly requested new window is a new purchase. There is no auto-renewal, stored customer balance, transferable credit or custody of invoice funds.
- Match/expiry stops monitoring; no unbounded recurring subscription. A new watch cannot reuse an old invoice identifier at the same merchant.
- A callback recipient's outage consumes the disclosed retry allowance and does not change whether payment was observed. Operator failure to observe the promised window produces `observation_incomplete`, not `expired_unpaid`. Before accepting real customers, publish a remedy for operator failure; for the pilot, manually refund the service fee from a separately controlled operator wallet, logging the refund transaction. No automatic refund hot key is required in the resource server.

### Conceptual API

| Route | Payment / auth | Purpose |
|---|---|---|
| `GET /health` | Free/public | Process health; separate readiness fields for node lag, worker and storage |
| `GET /v1/capabilities` | Free/public | Supported networks, asset, limits, tiers, receipt key and delivery contract |
| `POST /v1/watch-intents` | Free, rate-limited; payer-signed specification with client nonce | Validate and freeze an invoice watch; return intent ID, watch ID, scoped status/cancel capabilities, spec hash, price and expiry |
| `POST /v1/watch-intents/:id/purchase` | x402; matching signed intent authorization | Buy the frozen watch; successful response acknowledges purchase, not invoice payment |
| `GET /v1/watches/:id` | No additional payment; scoped bearer capability | Purchase state, observation state, delivery state and terminal evidence |
| `POST /v1/watches/:id/cancel` | No additional payment; cancel capability | Stop future observation; cancellation does not imply a refund |
| `GET /.well-known/roundwatch-key.json` | Free/public | Public verification key and key ID; no wallet secret |

Intent specification, conceptually:

```json
{
  "watchNetwork": "algorand-testnet",
  "assetId": "10458941",
  "expectedSender": "<invoice payer public address>",
  "receiver": "<merchant public address>",
  "amountAtomic": "12500000",
  "invoiceNonce": "<random 128-bit-or-longer public reference>",
  "tier": "one_hour",
  "callbackUrl": "https://merchant.example/events/roundwatch",
  "servicePayer": "<watch buyer public address>"
}
```

MVP matching is deliberately narrow: canonical USDC, ordinary top-level asset transfer, exact sender, receiver, amount and note bytes `roundwatch:v1:<invoiceNonce>`. Reject clawback transfers and unsupported transaction classes rather than treating them as ordinary invoice payments. No partial payments, aggregated installments, “at least this amount,” internal application transfers, cross-chain invoices, AML verdicts or payer-identity claims. The expected sender is a wallet address, not proof of the person behind it. The invoice reference is public and must contain no personal data.

Expose the corresponding MainNet asset only in a separately authorized launch. Do not use floating-point amounts. A canonical machine descriptor should advertise the full verified network identifier; the short names above are explanatory request aliases resolved by the server, not CAIP-2 replacements.

Prepare authenticates the caller's specification and client nonce; purchase signs the server-returned immutable intent. The purchase authorization must bind a domain separator, service origin, intent/spec hash, service payer, callback, tier, invoice condition, quoted service-fee amount/asset/network/payTo and expiry. Verify it independently of payment verification. Use the same frozen specification for the initial 402 and paid retry; reject altered content and conflicting idempotency keys. This is an application authorization envelope, not a new payment scheme. Acceptance testing must prove request binding with the installed AVM signer before MainNet. Never assume a transfer signature alone authorizes arbitrary request-body substitutions.

The buyer must durably save the watch ID and scoped capabilities from prepare **before paying**. They permit status/recovery of that dormant watch but never activate it. Do not rely on receiving a new secret only in the paid HTTP response: that response can be lost. Tokens belong in headers, not callback URLs, public receipts or logs. Recovering a lost prepare response uses a fresh challenge signed by the same service payer; an unverified idempotency key alone must not reveal capabilities.

Successful purchase response:

```json
{
  "watchId": "w_...",
  "purchaseState": "settled",
  "observationState": "watching",
  "deliveryState": "not_due",
  "startRound": "<first covered round>",
  "expiresAt": "<fixed timestamp>",
  "statusUrl": "/v1/watches/w_...",
  "authentication": "use capability saved before purchase",
  "specHash": "<sha256>",
  "servicePaymentTxId": "<settlement transaction>"
}
```

Terminal result contains `matched`, `expired_unpaid`, `cancelled`, or `observation_incomplete`, the covered round range, last fully processed round, specification hash, and, if matched, transaction ID and exact matching fields. Delivery state is separate: pending, retrying, acknowledged, or exhausted. “Acknowledged” means the callback returned 2xx, not that a business action completed. A server signature authenticates our report; it is not a trustless proof of monitoring completeness or legal payment finality.

### State, ordering and recovery

**Minimum database:** yes. Use SQLite on persistent disk for the single-instance MVP, with transactions and unique constraints. An in-memory map cannot sell a durable wait. Suggested tables are `intents`, `purchases`, `watches`, `chain_cursor`, `outbox`, and `delivery_attempts`; these can be consolidated if invariants remain clear. Store hashes of bearer capabilities, not plaintext tokens. Store only the minimum public invoice fields, settlement evidence and redacted operational records.

Purchase progression: `prepared → settlement_pending → settled`, with explicit `settlement_unknown` and `failed` branches. Handler execution can prepare a dormant record, but **only confirmed settlement may activate observation or emit a callback**. Persist the exact payment attempt/transaction identity before a crash can make it unrecoverable. Enforce unique settlement consumption, purchase idempotency, and one active logical watch per invoice specification. Payment identifiers help retries but do not replace authorization. [Payment-Identifier extension](https://docs.x402.org/extensions/payment-identifier).

There is no atomic transaction spanning GoPlausible settlement and SQLite. Therefore reconcile pending/unknown purchases against retained exact settlement evidence and the chain, checking network, sender, receiver, asset and amount. Never ask the buyer to sign a fresh payment merely because the HTTP response disappeared. A confirmed charge with a lost activation must recover the original watch. Unknown settlement leaves the watch dormant and status explicit until resolved. Proven absent/expired payment can fail; timeout alone is insufficient evidence.

Observation progression: `watching → matched | expired_unpaid | cancelled | observation_incomplete`. Establish `startRound` from the purchase settlement round and cover from that round inclusively so a fast subsequent invoice cannot fall into an activation gap. Fix expiration at that block's timestamp plus the purchased duration; retries and delayed recovery must not extend it. Reject invoice transfers before the service-purchase transaction within the same block. Deduplicate any match by transaction identity. Reject a new purchase that tries to reuse a consumed invoice nonce. Cancellation and matching race through one database transaction so only one terminal outcome wins.

Use one shared chain follower and locally index active filters by receiver and invoice note. Do not poll the chain separately for every watch. Persist progress and any resulting outbox event together before advancing the durable watermark. Restart from the last committed round and replay safely; never select a subscriber mode that silently skips missed blocks. A fresh purchase may require catch-up from its settlement round even if the global worker advanced before activation.

For expiry, scan through the first finalized block whose timestamp exceeds the promised deadline, but only match transfers in covered blocks timestamped at or before the deadline. If the node is unavailable or history is missing, delay a definitive expiry result and expose lag; if coverage cannot be recovered within a disclosed one-hour recovery allowance after the deadline, terminate as `observation_incomplete`. “No match found in the blocks inspected” is not “the invoice was never paid.”

**Delivery:** at-least-once with a stable event ID and a transactional outbox. Sign `timestamp + raw JSON body` using a service Ed25519 key and publish the public key; callers verify freshness, watch ID, spec hash and deduplicate the event ID. Retry transport failures, 408, 429 and 5xx using a bounded schedule, for example immediately, 10 seconds, one minute, five minutes and 30 minutes; honor a bounded Retry-After. Other non-2xx responses exhaust delivery. A lost acknowledgment can produce another callback. Never advertise exactly-once business execution.

Require callback endpoint ownership verification before purchase: a bounded challenge-response to a public HTTPS destination, tied to the signed intent. Pin validated public destinations for each connection; reject localhost, private/link-local/metadata ranges, redirects, userinfo, unsupported ports and unsafe DNS rebinding. Use a fixed event body, capped response bytes and short timeouts. Rate-limit free prepare/verification and cap global pending intents. Payment alone does not make a callback safe.

### Dependencies, caching and deployment

Keep TypeScript, Node, Hono, AVM x402, GoPlausible and Bazaar. Add a worker, persistence and a small invoice adapter in the subsequent implementation task. Reuse official AlgoKit Subscriber where compatible; pin the chosen version after a focused compatibility check. No smart contract, token, custom facilitator, general queue platform, marketplace, LLM or browser service is necessary.

The sample settled response requires an adapter that assembles the final purchase acknowledgment after settlement and durable activation, or returns an explicit pending state resolved through status. The current pre-settlement handler cannot truthfully manufacture `purchaseState: settled` or the settlement transaction ID. Prove the relevant lifecycle hooks in a focused TestNet experiment before choosing that integration; do not replace the known-good middleware speculatively.

Use Nodely/public algod for a bounded technical pilot under its stated fair-use requirements; agree suitable production capacity or operate a node if scale warrants it. Its documentation requests caching, exponential backoff and fetching only changes. It provides no verified commercial capacity commitment for this proposal. [Nodely documentation](https://nodely.io/docs/), [quickstart](https://nodely.io/docs/free/start/).

Cache immutable processed blocks/results, not mutable “unpaid” conclusions. Cap catch-up batches and retain only enough block-derived data to prove the watch's recorded outcome; use archival access for recovery if needed. Keep the paid HTTP response small because the current Hono middleware buffers it. Run on a persistent process with persistent disk; an ephemeral request-only serverless deployment would require a separate durable worker/store and a revised design.

The resource server still needs no invoice payer private key or merchant receiving key. A distinct service receipt-signing key is needed for authenticated callbacks. Buyer signing stays in the buyer process. The pilot can use separate disposable TestNet accounts; MainNet wallet custody, balance management and funding remain a later explicitly authorized operational step.

### Unit economics and volume reality

For the one-hour $0.02 tier, define variable contribution as:

`price − allocated node/compute/storage cost − callback cost − facilitator/chain cost borne by us − failure/remedy reserve`.

Illustrative assumptions, not measured costs: $0.003 infrastructure allocation, $0.001 combined payment/delivery allowance, and $0.001 remedy reserve produce $0.015 contribution per watch before labor, tax and acquisition. At $0.01 total variable cost the margin is only $0.01; at $0.02 there is none. At 1,000 purchases/day, gross revenue is $20/day—approximately $600 over 30 days—so manual support must be exceptional. A $30/month fixed hosting bill requires 2,000 purchases/month at $0.015 contribution to cover hosting alone. Do not count the fixed bill twice if it is already included in allocation.

The $0.10 day tier does not automatically have five times the margin: it covers 24 times the monitoring window. Measure its active-watch-hour cost and price accordingly. Shared block ingestion matters: a per-watch query every ten seconds would create 8,640 node calls for each day-long watch and scale badly. Price tiers must reflect capacity and storage, not merely competitor stickers.

No live ALGO/USD quote is assumed. If the service bears a payment group containing `n` minimum-fee transactions, the base chain-cost sensitivity is `n × 0.001 × ALGO/USD`, plus any facilitator fee. GoPlausible's live `/supported` advertises a fee payer, but that does not establish a permanent free-service commitment. Confirm actual charges before launch. [Supported schemes](https://facilitator.goplausible.xyz/supported).

For challenge volume, 1,000 real one-hour purchases represent $20 in service revenue/volume, not the sum of invoices being watched. Invoice principal is never RoundWatch revenue. Fifty thousand real $0.02 watches would generate $1,000; this is arithmetic, not an acquisition forecast or a target to manufacture. Do not repeatedly renew watches, split jobs, or route invoice funds through the service to inflate metrics.

### Minimum implementation sequence

1. **Before engineering expansion:** confirm eligibility and obtain two prospective integrators who have actual invoice-wait workflows. Show the exact contract and $0.02/$0.10 prices; ask them to choose against their current webhook/queue solution. No outreach was sent during this run.
2. **Days 1–2:** one-hour watch schema, signed immutable intent, persistent purchase state, fixture-based matching and lifecycle invariants. Check actual SDK hooks and settlement behavior. Keep `/demo` intact.
3. **Days 3–4:** shared chain follower, durable cursor, strict invoice matcher, transactional outbox, replay and expiry logic. Prove correct handling of a payment immediately after purchase.
4. **Days 5–6:** callback ownership checks, SSRF controls, authenticated delivery, capped retries, status capabilities and cancellation. Demonstrate process restart without loss.
5. **Days 7–8:** settlement-to-job reconciliation, lost-response and duplicate-purchase tests, two independent TestNet integrations, latency/cost measurements and a compact demo view.
6. **Days 9–10 / launch gate:** fix observed failures; add the day tier only if measured costs support it. MainNet, deployment credentials, real funds and challenge submission are separate authorized steps. Do not silently upgrade the baseline to achieve a research recommendation.

**Must not build yet:** arbitrary event predicates, multichain, trading execution, partial invoice payments, generic workflow DAGs, a marketplace, customer credit balances, custom contracts, fraud scoring, mobile apps, social messaging integrations, broad dashboards, or a claim of financial/legal assurance.

### Judge-facing demo

Show one real merchant job waiting to release a digital result after a future invoice transfer. The callback only resumes the merchant's own authorized workflow; it does not itself authorize delivery to an unknown party.

1. The merchant agent creates an invoice with a fresh public nonce and asks to buy a one-hour wait. Show the 402 quote and its bounded delivery contract.
2. The agent checks its budget, automatically signs the watch fee, receives the settled purchase response, and exits. Show the watch purchase transaction on Algorand.
3. Restart the RoundWatch worker. Its persisted cursor and dormant/purchased records recover. The invoice payer then makes the separate USDC invoice transfer with the exact note.
4. Show the matching transaction and covered round. Make the merchant callback temporarily return 503, restore it, and show authenticated redelivery under the same event ID.
5. The merchant processes that event once and releases the result. Its dashboard distinguishes service fee, invoice payment, observation result and delivery acknowledgment.
6. Show a pre-recorded or clearly labeled accelerated TestNet fixture for wrong sender, wrong amount, wrong note, duplicate callback, no payment, and node outage. Never label a fixture as a live commercial purchase.

Target a three-minute explanation. The memorable point is “the buying agent stopped, the service restarted, and the correct invoice still resumed the job once,” not a wall of blockchain transaction counters.

### Validation and success metrics

These are proposed go/no-go thresholds, not accomplishments:

- **Within two days:** two independent teams identify a real invoice workflow and agree to integrate at the proposed price. If both prefer a standing webhook account, revisit the thesis before further build work.
- **Before MainNet:** every deterministic fixture passes: wrong party/asset/amount/note, close/clawback exclusion, stale payment, duplicate invoice identity, modified intent, settlement failure/uncertainty, worker crash, lost acknowledgment and expired window with lag. No callback before confirmed service-fee settlement.
- **Reliability pilot:** at least 100 controlled watch lifecycles, including injected failures; zero false paid conclusions, zero unacknowledged lost obligations, zero duplicate business actions at the reference consumer. This sample is not a production SLA proof.
- **Latency goal:** p95 under ten seconds from node-visible finalized matching block to the first callback attempt while healthy. Record chain/provider lag separately. Deadline handling must favor truthful incompleteness over a false negative.
- **Commercial pilot before submission:** aim for three independent paying organizations, 100 genuinely purchased watches, and at least two organizations purchasing again on a later day without operator reimbursement. Wallet count is not organization count. Report failures and refunds alongside successes.
- **Economics:** measure cost per watch and active watch-hour, callback attempts, storage retention and operational incidents. One-hour variable cost must remain below $0.01, preferably below $0.005, without relying on unlimited free infrastructure.
- **Challenge evidence:** invoice use with consenting partners, repeated service purchases, functioning public discovery and attribution, clear separation of test activity, and retained settlement IDs. A small amount of genuine revenue is more useful evidence than an internally funded transaction loop.

## Infrastructure / Strategy Findings

| Finding | Evidence | Severity | Recommended action for a later run |
|---|---|---|---|
| Registration/timeline conflict | September 3 rules versus landing page and July guide | Critical to challenge strategy | Verify existing registration and organizer position; no assumption of extension |
| Handler execution is not always post-settlement | Installed `@x402/hono/dist/esm/index.mjs`: payment-verified branch calls `await next()` around line 216; normal settlement occurs around line 267; support for earlier settlement is also present | High for durable jobs or external side effects; harmless timestamp demo does not prove those safe | Persist dormant work, activate only with confirmed settlement, reconcile uncertainty; inspect configured scheme behavior rather than generalize |
| Demo client is not a production purchasing policy | `apps/client/index.ts` wraps fetch with a signer but contains no explicit maximum price/recipient/aggregate budget policy | High if expanded to model-selected URLs; current URL is fixed localhost | Add explicit allowlist, asset/network/payTo and spending limits before autonomous external purchasing |
| Durable idempotency is not implemented in application code | No purchase ledger or recovery state in either entry point | High for charging for future obligations | Add application authorization, payment-attempt deduplication and crash recovery; do not assume middleware alone provides it |
| Full CAIP identifier workaround remains relevant | Current code and live GoPlausible `/supported` agree on full TestNet identifier | Medium compatibility concern | Preserve now; retest both networks before upgrading packages |
| Bazaar metadata presence is not registration/usage proof | Official troubleshooting guide requires checking catalog and source attribution after settlement | Medium | Verify actual catalog and filtered leaderboard entry when launching. [Guide](https://algorand.co/blog/is-your-x402-endpoint-showing-up-in-the-facilitator-leaderboard-how-to-troubleshoot-if-not) |
| Extension integration bypasses type checking | `bazaarResourceServerExtension as unknown as ResourceServerExtension` in server | Low current / medium upgrade risk | Add a focused interoperability check when changing versions; do not refactor the working baseline during research |
| Catalog metadata is inconsistent | TestNet records despite requested filter; duplicate URLs; website/catalog price disagreement | Medium research/discovery risk | Validate actual payment offers; no blanket “verified directory” claim |
| Typecheck command environment limitation | Root `pnpm typecheck` attempted dependency reconciliation and stopped with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | Low for this documentation change | Do not enable a dependency purge just for research; both installed compilers ran `--noEmit` successfully in their app directories |

No infrastructure fix was implemented. Application code, manifests, lockfile and workspace configuration remain unchanged. The transient pnpm store index created by the failed root command was removed; it is not a deliverable. Existing `.env` contents were not read. No mnemonic, private key, paid call or MainNet operation was required.

## Source register

Primary sources were checked on September 11, 2026 unless a publication date is stated. Live APIs were read directly where page extraction failed. The selected observations and query parameters above are the durable snapshot; the linked APIs will change.

| Source | Material use / qualification |
|---|---|
| [Algorand official rules, September 3 revision](https://algorand.co/hubfs/Hackathon%20Terms%20and%20conditions/x402%20competition%20Official%20Rules_Sep3rd26_.pdf) | Schedule, finalist gate, criteria and integrity rules; supersedes older final-location copy |
| [Challenge landing page](https://algorand.co/global-x402-challenge) | Entry types, public MainNet path and marketing timeline |
| [Submission guide, July 21](https://algorand.co/blog/the-x402-global-challenge-is-live-how-to-build-submit-your-entry) | Launch context; older final-location claim treated as superseded |
| [Leaderboard troubleshooting, August 13](https://algorand.co/blog/is-your-x402-endpoint-showing-up-in-the-facilitator-leaderboard-how-to-troubleshoot-if-not) | Public API routes and attribution/discovery distinction |
| [GoPlausible discovery](https://facilitator.goplausible.xyz/discovery/resources?includeTestnets=false&limit=1000&offset=0) | Two-page catalog snapshot; metadata, not functionality certification |
| [GoPlausible leaderboard](https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&limit=50&range=all&env=mainnet&src=x402-global-challenge) | Reported rankings, counts and volume; not independent demand verification |
| [GoPlausible supported schemes](https://facilitator.goplausible.xyz/supported) | Full network identifiers and advertised fee payer |
| [Browserbase gateway](https://x402.browserbase.com/) | First-party pay-per-use browser/search/fetch prices |
| [AgentHub](https://agenthub-production-8c75.up.railway.app/) | Risk/decoding offers and website/catalog price conflict |
| [FalconHook](https://falconhook.com/) and [docs](https://falconhook.com/docs) | Strongest conventional Algorand webhook substitute |
| [WhaleTape machine documentation](https://whaletape.xyz/llms.txt) | Prepaid alert and paid-measurement competition |
| [WAKE402 machine documentation](https://wake402.agentwake.workers.dev/llms.txt) | Wakeup and TXWAKE preview, explicit adoption/availability limitations |
| [402audit API](https://402audit.com/api-docs) | Endpoint-scoring competition |
| [probe402 method](https://probe402.com/method) | Distinction between passive discovery and paid measurement |
| [10x402 audit](https://10x402.com/audit) | Purchase-path service and explicit lack of delivered audits |
| [Checkly](https://www.checklyhq.com/pricing/) | Conventional multistep monitoring substitute |
| [QStash](https://upstash.com/pricing/qstash) | Message-delivery price anchor; not full watch economics |
| [AlgoKit Subscriber repository](https://github.com/algorandfoundation/algokit-subscriber-ts) | Existing chain following, recovery and filter capabilities |
| [Algorand simulate API](https://dev.algorand.co/reference/rest-api/algod/operations/simulatetransaction/) | Native simulation alternative and technical feasibility |
| [Algorand fees](https://dev.algorand.co/concepts/transactions/fees/) and [asset operations](https://dev.algorand.co/concepts/assets/asset-operations/) | Fee/minimum-balance mechanics |
| [Nodely](https://nodely.io/docs/) and [quickstart](https://nodely.io/docs/free/start/) | Public node access and operational usage expectations |
| [x402 payment identifiers](https://docs.x402.org/extensions/payment-identifier) | Retry/idempotency mechanism, not complete application authorization |
| [x402 offers and receipts](https://docs.x402.org/extensions/offer-receipt) | Existing signed-interaction primitive; generic receipts are not novel |
| [Foundation flight demo](https://github.com/algorandfoundation/x402-flight-search-demo) | Travel orchestration already demonstrated |
| Local `AGENTS.md`, README, entry points/manifests and installed Hono distribution | Baseline and middleware lifecycle; no production regression asserted |

## Final decision, strongest objections and invalidation gates

**Ranked choice:** 1. RoundWatch invoice waits; 2. paid purchase-path acceptance tests; 3. AVM intent-constrained simulation; 4. licensed original data with a secured publisher.

**Recommended winner: RoundWatch, conditional on buyer and eligibility validation.** Its MVP is one precisely identified future USDC invoice, a fixed-duration paid watch, durable settlement-to-job activation, an honest terminal outcome and authenticated retryable delivery. It reuses the existing payment backbone and adds a useful service rather than another generic paid lookup.

**The strongest reasons not to choose it:** FalconHook already solves most monitoring operations; WhaleTape and TXWAKE weaken novelty; many agents already run on durable platforms; micro-priced watches need substantial volume to fund support; and the hardest code concerns billing/observation failure, which a happy-path demo can conceal. There is no verified buyer for this exact product. A reliable integration with an existing provider may be commercially better than building it.

**Invalidate or pause this recommendation if any of the following occurs:**

1. The team cannot participate under the current rules and the sole objective remains this competition.
2. Two prospective integrators cannot identify a real invoice-wait use, or prefer their existing backend/FalconHook after seeing the proposed price and contract.
3. A closer competitor already supplies no-account invoice-specific paid waits, correct negative outcomes and recovery at a better price; a chain port alone is insufficient differentiation.
4. Partners cannot add the required invoice nonce/expected sender information, making reliable matching impossible within the bounded MVP.
5. The worker cannot prove complete coverage before issuing an unpaid-expiry result, or payment/job recovery can lose obligations or charge twice.
6. Sustainable node capacity, permissions or hosting costs exceed the unit economics; public free access is not an unlimited business model.
7. Real usage consists mostly of our own test loops, incentives or repeated self-payments instead of independent repeat purchases.
8. The buyer can adopt the service only by introducing more wallet, signature and callback work than the persistence it removes.

The evidence supports this as the best **next product experiment**, not a proven business or a guaranteed winning entry. The minimum remaining uncertainty reduction is eligibility confirmation, two price-aware integration commitments, and a TestNet crash-recovery proof. If these fail, do not automatically promote a lower-ranked idea: revisit the buyer or supply constraint that failed.
