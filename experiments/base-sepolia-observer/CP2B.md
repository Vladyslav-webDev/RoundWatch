# Base Sepolia CP2B

The 17 November 2026 live experiment wrote one receipt-backed Circle USDC occurrence for blocks **59,923,384–59,923,386**. The disposable database returned the same observation after close and reopen. The outcome remained `unresolved` with reason `receipt_inclusion_only`, zero verified coverage and a null verified cursor. A preceding live attempt over the same range failed its finality recheck and wrote only the pinned plan, work debits and diagnostic.

## Reproduce the live sample

Run from the repository root with Node.js 24. The CLI allows an optional `onfinality` argument to select OnFinality instead of PublicNode. Exit 0 means the nonterminal observation committed and reopened. Exit 1 reports an unresolved acquisition or local failure. Exit 2 reports invalid arguments.

```powershell
node experiments/base-sepolia-observer/live.ts publicnode
```

| Operator | Allowlisted HTTPS endpoint | CP2B use |
| --- | --- | --- |
| Base | `https://sepolia.base.org` | Both real runs |
| PublicNode (Allnodes) | `https://base-sepolia-rpc.publicnode.com` | Both real runs |
| OnFinality | `https://base-sepolia.api.onfinality.io/public` | Optional secondary |

Both chain ID gates must pass before either endpoint can supply block evidence. The CLI queries the Circle USDC contract at `0x036cbd53842c5426634e7929541ec2318f3dcf7e` and uses ERC-20 `Transfer` topic `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`. Each operator has a separate ID, work journal and normalized result digests. [Base network documentation](https://docs.base.org/get-started/connect-to-base), [Circle contract addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet), [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20), [PublicNode operator page](https://base.publicnode.com/), [OnFinality endpoint documentation](https://www.onfinality.io/en/rpc-assistant/base-public-rpc-url-and-dev-tools).

### Requests and ceilings

| JSON-RPC method | Exact parameters and use | Calls per provider |
| --- | --- | ---: |
| `eth_chainId` | `[]`. Require `0x14a34` (84532). | 1 |
| `eth_getBlockByNumber` | `["finalized", false]` before and after acquisition. Fetch `["0x…", false]` for the common finalized height, the range predecessor, and the other two sampled heights. Read the same numbered anchor again before commit. | Up to 7 |
| `eth_getLogs` | One inclusive three-block range, then three single-height queries with `fromBlock` equal to `toBlock`. Use `address` equal to Circle USDC and `topics: [Transfer]`. The offline exact-tuple entry point also filters the indexed sender and recipient. Check block and transaction position, normalize and compare both providers and query modes. | Up to 4 |
| `eth_getTransactionReceipt` | `["0x…transactionHash"]` for each distinct transaction that returned a candidate for the selected tuple. Check status `0x1`, block and transaction hash and position, log order, token, parties and exact atomic amount. Compare the receipt logs in scope with the query results for that transaction and compare both normalized receipts. | Up to 4 |

The first agreed finalized tag must match its numbered header. The sampled predecessor and three scanned blocks must agree on headers and ordered transaction hashes, with linked parents and nondecreasing timestamps. The client rejects tags more than 3,600 seconds old or 30 seconds ahead of the host clock. It checks any direct finalized successor's parent, rejects regressions and replacements, and reads the exact pinned anchor again before commit. A later tag beyond the direct successor serves as a monotonicity check. The four-height budget does not establish ancestry from that later tag. [Base block method](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getBlockByNumber), [Base log method](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getLogs), [Base receipt method](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getTransactionReceipt), [Ethereum execution receipt schema](https://github.com/ethereum/execution-apis/blob/main/src/schemas/receipt.yaml).

Each invocation queries at most four distinct numbered heights including the predecessor. It plans at most 16 calls per provider and 32 total. Hard transport ceilings are 24 attempts per provider, 30 seconds per provider session, 4 seconds per request, 512 request JSON bytes per call, 256 KiB decoded per response and 1 MiB decoded per provider. Sessions run concurrently with one request at a time per provider. Transport ceilings imply 48 attempts, 24 KiB request JSON and 2 MiB decoded responses in aggregate. There are no HTTP redirects or automatic retries. The observer also caps normalized headers at 128 transactions, transfer rows at 128 and parsed receipt logs at 256 per receipt. The run's 64 durable debits also bound explicit replay using a reopened handle.

### Measured live costs

Times are UTC on 17 November 2026. Request bytes are prepared JSON body bytes. Response bytes count decoded bytes consumed and exclude HTTP headers and transport overhead. Summed call time includes overlapping calls, while elapsed time includes SQLite. No priced RPC usage was measured.

| Start | Provider | Chain / block / log / receipt calls | Request / decoded response bytes | Summed call time |
| --- | --- | ---: | ---: | ---: |
| 09:29:14.708 | Base | 1 / 0 / 0 / 0 | 59 / 0 | 89.33 ms |
| 09:29:14.708 | PublicNode | 1 / 0 / 0 / 0 | 59 / 0 | 43.78 ms |
| 09:29:34.073 | Base | 1 / 6 / 4 / 1 | 1,677 / 16,785 | 1,679.10 ms |
| 09:29:34.073 | PublicNode | 1 / 6 / 4 / 1 | 1,677 / 16,788 | 812.26 ms |
| 09:30:48.313 | Base | 1 / 7 / 4 / 1 | 1,763 / 18,939 | 1,731.81 ms |
| 09:30:48.313 | PublicNode | 1 / 7 / 4 / 1 | 1,763 / 18,944 | 640.43 ms |

- The sandboxed invocation ended in 134.13 ms. DNS returned `ENOTFOUND` for both endpoints before either received an HTTP response. The diagnostic survived SQLite reopen.
- The first network-enabled invocation ended in 1,731.62 ms with `finality_regression`. Both providers returned range logs, single-height logs and one candidate receipt. The finality recheck prevented commit. This capture identifies the stage and omits the regressing provider and its returned tag. The source is now included in finality diagnostics. [Unresolved run capture](live-publicnode-2026-11-17.json).
- A separately invoked repeat ended in 1,789.02 ms. Both providers agreed on linked headers, log sets and normalized receipts. Height `59,923,386` had timestamp `09:09:06` UTC, about 21 minutes and 42 seconds before the repeat. The run used 26 attempts, 3,526 request bytes and 37,883 decoded response bytes. SQLite returned an identical snapshot with one candidate and zero verified coverage. [Accepted nonterminal run capture](live-publicnode-repeat-2026-11-17.json).

## Findings and evidence strength

| Evidence | Strength established by CP2B |
| --- | --- |
| Transfer inclusion | Two provider receipts corroborate the same successful `Transfer` at an exact position in the agreed finalized block. This is provider-backed evidence. |
| Operational agreement | Separate operators, linked numbered headers, matching range and single-height sets and matching normalized candidate receipts for this sample. |
| Complete finalized historical coverage | Unproven. The probe reads receipts only for identified candidate transactions and does not verify receipt roots against independently authenticated finalized headers. The verified cursor remains null. |
| Business invoice attribution | Unproven. The CLI selects the first positive non-mint, non-burn, non-self tuple from agreed historical logs. That retrospective sample has no prior invoice binding or live arming height. |

The live strategy shares the fixture observer's SQLite WAL/FULL transaction primitives, header normalization and exact tuple rules. It stores its pin, work, observations and occurrence reservations in a disposable CP2B database. Each RPC attempt is charged to its source before the call. A short run may persist a pin and a diagnostic before it can accept an observation. Linked headers, source digests, the selected tuple and globally unique occurrence rows commit together. The exact tuple reservation rejects overlaps even after an observation is recorded. A committed sample is idempotent on reopen. An interrupted attempt replays the same numbered heights once pinned and spends fresh debits. The CLI creates a fresh database, checks reopen and removes it at exit. The store's internal replay API accepts a generated experiment handle for process restart and derives the fixed temp database path from it.

## Blockers and residual risks

- Providers can share an upstream or omit the same transfers in both query modes. A correlated omission can survive every query comparison. A queried receipt can catch a missing log inside its own transaction. An agreed empty sample can never expire a watch.
- Rate limits, pruned history (`4444`), unavailable blocks, stale tags, regressed finality, missing receipts and disagreeing evidence all leave the observation unresolved. The regression above demonstrates that HTTP 200 alone is insufficient. The live run did not reproduce the older historical archive errors. [CP2A qualification](QUALIFICATION.md), [Ethereum execution API block errors](https://github.com/ethereum/execution-apis/blob/main/src/eth/block.yaml).
- Freshness relies on the host clock. Abrupt termination can leave a disposable database for restart while an ordinary CLI exit removes it. The successful sample provides no throughput, availability, production-readiness, economic or customer evidence.

## Independent review handoff

Review `cp2b-complete.diff` against baseline `d55634d98b5d12bd1353664222506e9ec7fc8d99` on `experiment/base-sepolia-observer-cp2b`. The patch includes new source files, tests and run captures. Confirm that the experiment-directory boundary holds and audit the following paths.

1. `rpc.ts`, `live-observer.ts` and `live.ts` cover chain gates, independent endpoint IDs, inclusive heights, byte and work accounting, normalized receipt checks and the finalized-anchor recheck. Confirm that a false-empty, correlated omission or receipt mismatch cannot write verified coverage.
2. `live-store.ts` and `sqlite.ts` cover handle validation, transactional occurrence reservations, immutable plans and durable work. In `live-store.test.ts`, inspect the process exits before and after the observation commit and confirm that a replay can claim an occurrence only once.
3. `live-cli.test.ts` and `live-observer.test.ts` inject deterministic RPC responses. Confirm that offline tests require no network and both recorded real invocations respect the bounds. Run the CP1 and CP2 demos twice on the corresponding local demo files to check reopen.

```powershell
node --test experiments/base-sepolia-observer/*.test.ts
pnpm -C apps/server exec tsc -p ../../experiments/base-sepolia-observer/tsconfig.json
node experiments/base-sepolia-observer/demo.ts
node experiments/base-sepolia-observer/demo.ts --cp2
git diff --check
```

Local validation passed all 93 focused tests on Node.js 24.14.0. The tests include process exits on both sides of the live observation commit, followed by reopen through the store's token API. CP1 and CP2 fixture demos each reported `matched` with six covered blocks and one occurrence, using 93 and 34 logical reads respectively. Both produced identical snapshots after reopen. `git diff --check`, the untracked source and capture checks, and a forward apply check against an isolated index loaded with the baseline all passed.

The worktree had no installed dependencies and pnpm's registry verification encountered DNS errors. The experiment typecheck passed using installed TypeScript 7.0.2 and `@types/node` 22.20.2 from the CP1 checkout.

```powershell
$cp1ServerModules = 'C:\Dev\x402-audit-base-sepolia-cp1\apps\server\node_modules'
& "$cp1ServerModules\.bin\tsc.CMD" -p experiments/base-sepolia-observer/tsconfig.json --typeRoots "$cp1ServerModules\@types"
```

## Changed-file inventory

| Change | Files |
| --- | --- |
| Shared observer internals | `evidence.ts`, `observer.ts`, `sqlite.ts` (new) |
| RPC transport and CP2A endpoint refactor | `rpc.ts`, `rpc.test.ts`, `qualification.ts` |
| CP2B acquisition, persistence and CLI | `live-observer.ts`, `live-store.ts`, `live.ts` (new) |
| Offline CP2B tests | `live-observer.test.ts`, `live-store.test.ts`, `live-cli.test.ts` (new) |
| Documentation and measurements | `README.md`, `CP2B.md` (new), `live-publicnode-2026-11-17.json` (new), `live-publicnode-repeat-2026-11-17.json` (new) |
| Review artifact | `cp2b-complete.diff` (new, contains every other change) |
