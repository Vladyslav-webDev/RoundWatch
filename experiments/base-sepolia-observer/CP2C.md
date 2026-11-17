# Base Sepolia CP2C · Finalized coverage proof feasibility

**Offline feasibility demonstrated. Live verified coverage BLOCKED.** The minimum evidence for an eligible block is an independently authenticated canonical finalized header plus either a negative test of a required Bloom element or a complete ordered receipt set that reproduces the header's `receiptsRoot`. A negative watch result additionally needs a contiguous chain from an authenticated pre-opening anchor to the first authenticated block at or after the exclusive deadline, with zero qualifying occurrences. CP2C tests those conditions against a trusted synthetic chain and exposes `negativeEligible` only inside the fixture experiment.

## A. Header trust and finality

| Evidence about an L2 header | What it establishes |
| --- | --- |
| `eth_getBlockByNumber("finalized", false)` | An execution RPC provider reports its current finalized view. |
| Agreement between independently operated RPCs | Both operators report the same view at the sampled height. Common upstreams, implementation defects and omissions remain possible. |
| Locally recomputed header hash and parent links | Fork-aware canonical RLP binds `logsBloom`, `receiptsRoot`, timestamp and `transactionsRoot` to the header hash. Parent links tie consecutive headers to a particular branch. A self-consistent branch can still be fabricated if its tip is unauthenticated. The RPC's `hash` string alone does not bind its other fields. |
| Independent canonical finalized history | An independent Base derivation and execution verifier supplies the header, or a trusted finalized descendant authenticates it through a continuous, locally hashed ancestry. The anchor ultimately rests on Ethereum Sepolia consensus and the Base Sepolia genesis and active protocol rules. |

The strongest path available in principle is to run a Base Sepolia verifier from independently validated Ethereum Sepolia inputs. Use the following procedure.

1. Pin the Sepolia L1 network and an authenticated weak-subjectivity checkpoint, then run a local L1 consensus and execution client pair to validate canonical history and finality. An L1 light-client alternative must verify the appropriate fork's committee updates, finality and execution commitment, and authenticate the execution bodies, receipts and blob data needed by derivation. A beacon RPC's claimed finalized slot by itself supplies no such provenance. [Ethereum weak subjectivity](https://ethereum.github.io/consensus-specs/specs/phase0/weak-subjectivity/) · [Consensus light-client protocol](https://github.com/ethereum/consensus-specs/blob/master/specs/capella/light-client/sync-protocol.md).
2. Pin a compatible Base consensus and execution verifier, Base Sepolia genesis and L1/L2 chain IDs, rollup configuration and fork schedule. Derive and execute the chain from verified genesis or an independently authenticated L2 starting state. Consume canonical L1 execution and data-availability inputs, including authenticated batch calldata or blobs, deposits, and system-configuration updates. Use derivation mode with local L1 inputs, and require validation of L2 execution and the L1 finality signal that covers each block's actual derivation inputs. The L1 epoch origin alone can precede the L1 block that carried a required batch. [Base node setup](https://docs.base.org/specifications/node-operators/run-a-node) · [Base derivation](https://docs.base.org/specifications/base-protocol/consensus/derivation) · [Base Sepolia chain config, v1.5.5](https://github.com/base/base/blob/v1.5.5/crates/common/chains/src/config.rs#L490-L530) · [Base derivation actor](https://github.com/base/base/blob/main/crates/consensus/service/src/actors/derivation/actor.rs) · [EIP-4844](https://eips.ethereum.org/EIPS/eip-4844).
3. Read headers and the ordered transaction body from that verifier at or below its derived finalized head. If using an external RPC for retrieval, start from the verifier's authenticated finalized block hash and recompute the fork-aware RLP header hashes along the continuous parent chain to the target. For receipt attribution, obtain ordered transaction hashes from the independently validated execution body or reconstruct `transactionsRoot` from all ordered consensus-encoded transactions and derive their hashes locally. Pin and journal the chain configuration, anchor and provenance. Require the same assurance for the deadline block. [Ethereum block and trie specification](https://ethereum.github.io/yellowpaper/paper.pdf) · [Typed transaction and receipt commitments](https://eips.ethereum.org/EIPS/eip-2718).

L2 derivation finality concerns irreversible L1 inputs and correct local execution. L1 dispute or proof settlement for posted L2 outputs has a separate trust model. An output-based path would need to validate the chain-specific proof or dispute result on finalized L1, verify the committed block hash and prove ancestry from it. CP2C used neither a live derivation verifier nor an output-based verifier. Its local trust boundary is an immutable fixture with independently supplied header projections, ordered transaction hashes and receipt rules, assumed canonical and finalized. Hash equality is checked alongside the actual fields in those projections. [Base derivation and output finality](https://docs.base.org/specifications/base-protocol/consensus/derivation#about-reorgs-post-merge).

## B. Bloom exclusion

For the 256-byte block `logsBloom`, compute legacy Keccak-256 over the 20-byte token address and separately over each of the three 32-byte topics (`Transfer` signature, padded sender and padded recipient). For each input use the low 11 bits of the first three big-endian 16-bit words, then test bit `1 << (bit & 7)` of byte `255 - (bit >> 3)`. Any missing bit excludes the qualifying event from a consensus-valid block once its Bloom is authenticated. Positive bits can come from different logs, incorrect topic positions or collisions. The bloom also omits the data field, so even a genuine token-and-party match may have a different amount. [Ethereum Yellow Paper §4.4.1](https://ethereum.github.io/yellowpaper/paper.pdf) · [go-ethereum Bloom implementation](https://github.com/ethereum/go-ethereum/blob/v1.16.7/core/types/bloom9.go) · [ERC-20 Transfer](https://eips.ethereum.org/EIPS/eip-20#transfer).

The offline vectors pin the go-ethereum Bloom benchmark digest and the `Transfer` topic hash. They detect SHA3-256, reversed byte order and reversed bit order, and show a positive query with no matching event. [go-ethereum Bloom fixture](https://github.com/ethereum/go-ethereum/blob/master/core/types/bloom9_test.go).

## C. Complete receipts

`eth_getBlockReceipts` can return an entire ordered set in one read. A fallback may request `eth_getTransactionReceipt` for every transaction in independently validated block order, within the predeclared transaction, byte and request budgets. The root comparison is the same for either acquisition mode. A provider's candidate-only receipt reads or a partial fallback leave the block unresolved. [Execution API method and schema](https://ethereum.github.io/execution-apis/api/methods/eth_getBlockReceipts/) · [Base public endpoint documentation](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getBlockReceipts).

The offline verifier requires an exact count and one position-checked receipt per transaction, with block-wide log indices in order. It encodes status, cumulative gas, receipt Bloom and ordered logs using RLP. The untyped legacy list is a trie value directly, while a typed value is `typeByte || rlp(payload)`. The hexary Merkle Patricia Trie uses RLP-encoded receipt indices starting at zero, compact nibble paths and Ethereum's inline-or-hashed child references. Keccak-256 of the encoded root must equal `receiptsRoot`. The verifier recomputes each receipt Bloom and the gate compares the resulting block Bloom to the authenticated one. Receipt payloads commit to log addresses, topics and data in order. RPC transaction hashes and log indices are metadata, so they are cross-checked against the authenticated ordered body and recomputed positions. [EIP-2718](https://eips.ethereum.org/EIPS/eip-2718) · [EIP-658](https://eips.ethereum.org/EIPS/eip-658) · [Ethereum Yellow Paper Appendix B and D](https://ethereum.github.io/yellowpaper/paper.pdf).

The implemented shapes are status-bearing legacy (`0x0`), access list (`0x1`), dynamic fee (`0x2`), set code (`0x4`) and deposit (`0x7e`) under an explicit Canyon v1 rule. With that rule, the consensus payload appends `depositNonce` and `depositReceiptVersion` equal to 1. In Regolith before Canyon, RPC may expose the nonce even though the consensus receipt root omits it. Pre-Canyon deposit encoding, unknown types, absent type tags, ambiguous rules and malformed extensions fail closed. Base v1.5.5 pins Sepolia Canyon at Unix second `1699981200` and implements the Regolith exception. A live verifier must pin the supported network and release rules for the sample, including later upgrades. An observed version field does not select the fork. [OP Stack deposit receipt](https://specs.optimism.io/protocol/deposits.html#deposit-receipt) · [Base v1.5.5 root calculation](https://github.com/base/base/blob/v1.5.5/crates/execution/consensus/src/proof.rs#L10-L38) · [Base v1.5.5 deposit encoding](https://raw.githubusercontent.com/base/base/v1.5.5/crates/common/consensus/src/receipts/deposit.rs).

The mixed synthetic vector has legacy, EIP-1559 and Canyon deposit receipts and a fixed root computed independently with ethers RLP and Keccak and a hand-derived trie shape. Additional vectors cover empty and single-leaf roots, branch and extension paths, and the Base client's exact Canyon deposit receipt bytes. The failure tests exercise count and order errors, forged enumeration, corrupted log data, receipt metadata and unknown shapes. The local verifier inherits the 128-transaction cap and limits block-wide receipt logs to 256 with at most 4,096 data bytes per log. Receipt sets exceeding those caps are unresolved. [Base v1.5.5 Canyon receipt vector](https://github.com/base/base/blob/v1.5.5/crates/common/consensus/src/receipts/deposit.rs#L483-L506).

## D. Coverage gate

| Classification | Meaning | Cursor advances |
| --- | --- | --- |
| `OBSERVED_ONLY` | A source reported logs or a candidate. | No |
| `RECEIPT_INCLUSION` | CP2B-style receipt-backed occurrence at a checked position. The label does not imply a cryptographic inclusion proof. Even a true inclusion proof for one receipt leaves other receipts unchecked. | No |
| `PROVIDER_CORROBORATED` | Provider observations agree within the sampled scope, including a possible agreed empty result. | No |
| `VERIFIED_COMPLETE` | The independent header trust condition and the applicable exclusion or full-scan condition hold for this contiguous height. A verified out-of-window timestamp suffices at a height that cannot contain an eligible occurrence. | Yes |
| `UNRESOLVED` | Required evidence is missing, invalid, conflicting or unsupported. | No |

The three weak labels are diagnostic inputs to the fixture gate. No such label can supply header trust or bypass proof checks. A proposed next block must be present, one height after the cursor, linked by parent hash, nondecreasing in timestamp, and identical to the canonical projection including commitments and the ordered transaction list. The anchor itself is pinned before `opensAtSec`. At an eligible height, a Bloom exclusion suffices when receipts were not supplied. When receipts are supplied, a missing entry, invalid encoding, root mismatch or Bloom mismatch blocks progress without falling back to the Bloom path. A complete receipt set is scanned for the exact USDC token, sender, recipient and positive atomic amount using the existing filter. The proof counts all qualifying occurrences.

The first consecutive authenticated block with `timestamp >= deadlineSec` closes `[opensAtSec, deadlineSec)` without scanning its receipts. This excludes the entire deadline second even if multiple blocks share that timestamp. The last committed row determines the cursor and whether it reached the boundary. SQLite WAL with `synchronous=FULL` and `BEGIN IMMEDIATE` commits each accepted header, proof method and its qualifying logs together. The watch and trusted projections are immutable across reopen. The process-exit tests verify both sides of the commit. Stored receipt decisions retain the authenticated commitments and accepted logs. Full raw witnesses would be needed to replay the root verification from the database alone.

The fixture uses a synthetic pre-opening anchor and an offline eligibility window. A live implementation still needs to establish the existing arming and exclusive height-floor semantics with canonical history. CP2C does not connect its store or `negativeEligible` to CP2B. The CP2B live observer continues to emit nonterminal observations.

## E. Finite live qualification

The read-only capability CLI uses `https://sepolia.base.org` and an allowlisted secondary, `publicnode` or `onfinality`. Both network-enabled invocations used PublicNode (`https://base-sepolia-rpc.publicnode.com`) and together queried two distinct heights including the tags. Each invocation requests `eth_chainId([])`, `eth_getBlockByNumber(["finalized", false])` and `eth_getBlockByNumber([height, false])` at the lower provider-reported finalized height or its immediate predecessor. Once those checks pass it sends `eth_getBlockReceipts([height])` and, if that read fails and the block has at most eight transactions, sequential `eth_getTransactionReceipt([hash])` reads in block order.

The per-provider limits are 12 attempts, 20 seconds per session, 3 seconds per request, 512 request JSON bytes per call, 256 KiB decoded per response and 1 MiB decoded per session. There are no redirects, automatic retries or recurring calls. The reported response size counts decoded bytes consumed within the cap and excludes HTTP headers and wire overhead. Non-2xx bodies are discarded unread.

```powershell
node experiments/base-sepolia-observer/cp2c-probe.ts publicnode head
node experiments/base-sepolia-observer/cp2c-probe.ts publicnode predecessor
```

| 17 November 2026, CET | Numbered sample | Attempts / request bytes / decoded response bytes | Result |
| --- | ---: | ---: | --- |
| 15:07:03.450 | — | 2 / 118 / 0 | Sandbox DNS returned `ENOTFOUND` for both chain-ID reads. [Capture](cp2c-probe-publicnode-sandbox-2026-11-17.json) |
| 15:07:15.976 | 60,006,032 (`0x3939e90`) | 8 / 616 / 534,085 | Both batch reads returned HTTP 200 and hit the 262,144-byte ceiling before parsing a complete envelope. The nine-transaction block exceeded the fallback cap. `BLOCKED`. [Capture](cp2c-probe-publicnode-2026-11-17.json) |
| 15:09:41.486 | 60,006,031 (`0x3939e8f`) | 8 / 616 / 30,294 | Both batch reads returned HTTP 200 and three ordered receipts. Both sets reproduced the same provider-reported root. `CAPABILITY_SAMPLE`, with verified coverage `BLOCKED`. [Capture](cp2c-probe-publicnode-predecessor-2026-11-17.json) |

On the predecessor, the Base and PublicNode batch bodies measured 10,665 and 10,664 decoded bytes respectively. Each had one `0x2` and two `0x7e` receipts, both deposits carrying a nonce and a version. The recomputed root was `0xd4bae5d465e13dc7d72703800f5a72aa8a47607f14c764d90d8df951467fe2cc`. The probe uses the pinned Base v1.5.5 Canyon encoding as a consistency check on provider data. The header and ordered body themselves have provider provenance. Base's method page documents HTTP 403 on its public endpoints. The successful response establishes availability for this sample. [Base batch-receipt documentation](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_getBlockReceipts).

No live fallback receipts were acquired in CP2C. CP2B observed successful individual receipt reads from both endpoints, and CP2C's offline probe tests cover full bounded fallback, an incomplete fallback and method errors. Full live per-transaction enumeration remains **NOT_VERIFIED**. [CP2B live results](CP2B.md#measured-live-costs) · [CP2C probe tests](cp2c-probe.test.ts).

## Blockers, findings and notes

- **BLOCKED — independent live finality.** No independently validated Ethereum Sepolia inputs and Base Sepolia derivation/execution history were obtained in this experiment. Cross-provider agreement cannot advance verified coverage.
- **NOT_VERIFIED — live negative result.** No authenticated live eligible window, receipt solution for all Bloom-positive blocks or exclusive deadline boundary was verified. The fixture flag remains offline.
- **FINDING — Bloom exclusion is the lower-cost sound path conditional on header trust.** It needs the header and exact filter only. Positive Blooms require complete receipts for classifying the block, even if both log responses are empty.
- **FINDING — full receipt verification is possible for the supported data and rules.** The root protects against a correlated omission if the root itself is authenticated. Receipt caps, unavailable history and unsupported receipt types affect feasibility, and always leave unresolved coverage.
- **NOTE — scope.** The experiment covers occurrence evidence for a transfer tuple. A matching transfer provides no unique invoice attribution when an application reuses a tuple. Range throughput, head latency, receipt data sizes beyond the samples, and cost at scale remain unmeasured.

## Local validation and independent-review handoff

The initial working directory was clean on `experiment/base-sepolia-observer-cp2c` at `3823d13052737c0bc6734d6040268cd155b26a4f`. Review [cp2c-complete.diff](cp2c-complete.diff) against that baseline. The patch includes all changed and added files except the patch artifact itself.

```powershell
npm --prefix experiments/base-sepolia-observer ci
node --test experiments/base-sepolia-observer/*.test.ts
pnpm -C apps/server exec tsc -p ../../experiments/base-sepolia-observer/tsconfig.json
git diff --check
```

All 123 focused tests passed on Node.js 24.14.0, including the 93 CP1/CP2A/CP2B regressions. The experiment typecheck passed using the existing CP1 checkout's TypeScript 7.0.2 and `@types/node` 22.20.2 because this checkout has no server dependencies installed. The experiment's standalone lock pins the same `@noble/hashes` 2.4.0 already present in the workspace lock. The local runs used that pinned library from the CP1 checkout. Whitespace and forward-apply checks passed for the complete patch against an isolated index loaded with the baseline.

```powershell
$cp1ServerModules = 'C:\Dev\x402-audit-base-sepolia-cp1\apps\server\node_modules'
& "$cp1ServerModules\.bin\tsc.CMD" -p experiments/base-sepolia-observer/tsconfig.json --typeRoots "$cp1ServerModules\@types"
```

1. Inspect [the coverage gate](cp2c-coverage.ts) and [its tests](cp2c-coverage.test.ts). Try a single missing height, an agreed empty receipt set, and a forged header carrying the correct hash but altered commitments. Confirm that evidence stays unresolved below the boundary and that a failed check cannot commit a row.
2. Cross-check Bloom bit arithmetic and known vectors in [the Bloom tests](cp2c-bloom.test.ts). In [the receipt verifier](cp2c-receipts.ts), verify index-zero RLP, branch and leaf paths, typed envelopes and deposit fields against the pinned sources. Check that transaction-hash attribution rests on the independently authenticated body.
3. Review [the CLI](cp2c-probe.ts), [transport additions](rpc.ts) and the captures. Confirm that cutoffs, missing consensus fields and RPC errors leave the strongest live class at `PROVIDER_CORROBORATED` or `UNRESOLVED`. Check that there is no import or database transition from the live command to the fixture store.
4. Verify every patch path is under `experiments/base-sepolia-observer/` and the patch applies to a clean baseline. Review the restart subprocesses for a trigger exit after the insert before `COMMIT`, and for an exit after a successful `COMMIT` before database close.
