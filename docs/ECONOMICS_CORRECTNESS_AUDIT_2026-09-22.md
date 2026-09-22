# RoundWatch Economics & Correctness Audit — 2026-09-22

Status: source-level audit of production `main` at `e1a1b9b5363426df1b53a5989385871ba610b3fd`. This document does not authorize a production deployment or a paid MainNet transaction.

## Executive conclusion

The original open question was whether one purchased watch could create effectively unbounded service work while preserving RoundWatch's no-false-expiry correctness guarantee. Production `main` already contains the correctness-preserving answer shipped by Economics v1: every watch has an immutable 500-turn durable background-work budget, and exhaustion terminates as `indeterminate` with `terminalReason=work_budget_exhausted`, never as `expired`.

The remaining audit therefore concerns two things: whether the adversarial collision model is structurally real, and whether cross-sweep historical page reuse is sound under the upstream Algorand Indexer semantics. The source review below supports both conclusions, subject to the explicit provider assumptions.

## 1. Durable work envelope already exists

`RoundWatchStore.claimWorkUnit()` durably increments `work_units_used` only for an unfinished obligation. When the persisted budget is exhausted, the next servicing attempt atomically moves the watch to `indeterminate` and records `work_budget_exhausted`.

`RoundWatchPoller` claims a work unit before active polling. The most expensive current active turn can perform four Indexer requests: closing-tip lookup, closing block lookup, shared sweep tip lookup, and one scan page. `SettlementReconciler` also claims a unit first and currently performs at most three Indexer requests in one turn.

Therefore the current 500-turn contract implies a conservative ceiling of 2,000 background Indexer requests per purchased watch, plus the separately bounded purchase/activation path. This bound is derived from the current code shape. If future code adds Indexer calls inside a turn, this proof and its tests must be revisited.

Important semantic detail: turn 500 is allowed to execute. If it does not reach a terminal result, the following servicing attempt observes exhaustion and moves the watch to `indeterminate`. A crash after a work-unit claim can only consume budget conservatively; it cannot increase the service obligation.

## 2. Query-C collision is a real structural adversarial case

Runtime query variant C filters by sender, ASA, round range, exact amount, and, when supplied, note prefix. It does not filter by expected receiver. `matchesWatch()` then performs the exact receiver check locally and, when a note exists, requires the decoded note to equal the requested note exactly.

That means a transaction can deliberately pass the provider-side query while failing RoundWatch's exact local match. A simple construction is:

- same sender as the watch;
- same USDC ASA and exact amount;
- same exact note when the watch uses a note;
- one different USDC-opted-in receiver;
- distinct validity windows so every transaction body is different.

In current `go-algorand` source, `MaxTxnLife` is 1,000 rounds and validation permits `LastValid - FirstValid <= MaxTxnLife`. For any target inclusion round `R`, choose `FirstValid = R - a`, where `a` ranges from 0 through 1,000. For each such `FirstValid`, choose any `LastValid` from `R` through `FirstValid + 1,000`. Every pair contains round `R` and is protocol-valid.

The number of distinct validity pairs is:

`sum(a=0..1000, 1000-a+1) = 501,501`.

So validity fields alone provide far more unique transaction bodies than are needed to saturate one block with query-C collisions. This does not mean such an attack is cheap or likely: the sender still pays network fees and needs sufficient balances, and network/mempool policy can further constrain practical submission. It does prove that collision uniqueness does not require thousands of receiver accounts or arbitrary notes.

`go-algorand` raises `MaxTxnBytesPerBlock` to `5 * 1024 * 1024` in v33, and later v34 through v42 definitions inherit that value. The local transaction-size probe's 203-byte no-note `SignedTxnInBlock` model implies 25,826 such modeled transactions per full block. Treat that exact 203-byte figure as a model until it is byte-for-byte checked against the Go canonical codec; the safety of the 500-turn service bound does not depend on the exact per-block count.

## 3. Cross-sweep historical cache is supported by upstream Indexer semantics

RoundWatch caches a page only when `page.currentRound >= maxRound` for that exact query URL.

Upstream `algorand/indexer` gives that condition stronger meaning than the OpenAPI sentence alone suggests:

- `Transactions()` opens a PostgreSQL read-only `REPEATABLE READ` transaction.
- Inside that same database snapshot it computes `round = getMaxRoundAccounted(...)` and executes the transaction query.
- The API returns that `round` as `current-round` together with the rows from the same query snapshot.
- `AddBlock()` advances import state sequentially, and its source explicitly notes that transaction and participation tables can only be ahead of, not behind, the other indexed state if the outer transaction fails.

Therefore, for a conforming upstream Indexer database, a transaction-search response with `current-round >= maxRound` was computed from a snapshot that had accounted through the requested historical range. Combined with Algorand finality, that fixed `minRound..maxRound` transaction set should not gain a later canonical transaction.

Pagination is also positional rather than a server-side snapshot handle. Upstream `TransactionFilter.NextToken` is documented as a pointer to the last returned object, and the PostgreSQL backend decodes it into `(round, intra)` and resumes from that position. RoundWatch's address-filtered query is ordered by this historical position. Once the queried range is complete, replaying a cached page and its continuation token in a later sweep is therefore compatible with the upstream paging model.

### Cache assumptions

This proof assumes the configured provider preserves upstream Algorand Indexer query semantics. A provider-specific implementation that fabricates `current-round`, mutates already-finalized historical rows, or gives different semantics to continuation tokens would invalidate the proof. The existing `ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES=0` rollback remains the correct fail-safe if provider behavior is ever in doubt.

Cluster/read-replica lag by itself is not a counterexample: the upstream documentation explicitly warns clients to use `current-round` to detect stale readers, and RoundWatch only promotes a page into the historical cache after that reader has reached the requested `maxRound`.

## 4. Correct terminal contract

The production state model is already the required correctness-preserving one:

- `matched` is positive transaction evidence;
- `expired` requires complete validated coverage through the fixed closing checkpoint;
- `indeterminate/work_budget_exhausted` means the purchased resource envelope ended before either proof could be completed.

A page cap, request cap, or turn cap must never be translated into `expired`. Production `main` currently respects that distinction.

## 5. Economics at the live $0.02 contract

With the supplied fixed hosting assumption of about $7.25/month, fixed-cost break-even before future variable provider charges is about 363 watches/month, or 12.1 watches/day.

At the conservative 2,000-background-request ceiling, an Indexer price of $10 per million requests would consume the full $0.02 service revenue in Indexer request charges alone. A 50% pre-fixed-cost contribution margin at that absolute ceiling corresponds to $5 per million requests. Normal measured watches are far below the ceiling, so this is a safety-envelope calculation rather than expected unit cost.

## 6. Follow-up status

1. Resolved after this audit: production hardening now bounds the historical cross-sweep LRU by both 16 entries and 8 MiB of serialized retained page payload by default.
2. Resolved after this audit: active polling and settlement reconciliation now enforce runtime per-turn Indexer request ceilings of four and three respectively, with regression coverage. The default 500-turn contract therefore retains a conservative 2,000 logical background-request ceiling.
3. Source-validated after this audit: `docs/COLLISION_CAPACITY_PROOF.md` traces the probe fixture through `BlockHeader.EncodeSignedTxn`, generated `SignedTxnInBlock.MarshalMsg`, and the JS SDK canonical MsgPack encoder. The 203-byte no-note fixture is now a source-equivalent capacity estimate. An executable Go byte-for-byte fixture remains optional cross-language regression coverage, not a prerequisite for the service safety bound.
4. Still operational: production economics should be revisited using independent payer count, repeat buyers, terminal-state distribution, p95 work-unit usage, and actual provider charges. Synthetic benchmarks cannot substitute for those observations.

## Upstream source anchors

- `algorand/go-algorand` `config/consensus.go`: `MaxTxnLife = 1000`; v33 sets `MaxTxnBytesPerBlock = 5 * 1024 * 1024`; v34-v42 inherit from prior versions.
- `algorand/go-algorand` `data/transactions/transaction.go`: validity rejects `LastValid < FirstValid` and spans greater than `MaxTxnLife`.
- `algorand/indexer` `idb/postgres/postgres.go`: repeatable-read transaction query snapshot, `getMaxRoundAccounted`, sequential import state, and positional pagination.
- `algorand/indexer` `idb/idb.go`: `NextToken` is the pointer to the last returned object of the previous query.
- `algorand/indexer` README: clustered readers may lag; clients are instructed to inspect `current-round` and retry stale queries.

Source versions inspected during this audit: `algorand/go-algorand` master around `1f4ad10fd780a66a043e15b2e692079aede69b6a`; `algorand/indexer` main around `f84ad3e337a2e6eb111ac548f21dc65df8cc5e70`.