# Base Sepolia observer CP1

This offline experiment observes synthetic Circle USDC transfers on Base Sepolia (`eip155:84532`, contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Node.js 24 provides SQLite and runs the TypeScript directly.

From the repository root, run:

```powershell
pnpm -C experiments/base-sepolia-observer test
pnpm -C apps/server exec tsc -p ../../experiments/base-sepolia-observer/tsconfig.json
pnpm -C experiments/base-sepolia-observer demo
```

The typecheck uses the repository's existing TypeScript and Node types. The demo opens `cp1-demo.sqlite` beside the script and prints the watch, cursor, cutoff, outcome, candidate receipt evidence and per-source work counts as JSON. Running it again reopens the same database. The tests create and clean up their own databases.

## Evidence contract

- Admission freezes the sampled latest header, finalized anchor, exact sender/recipient/positive atomic amount, `[opensAtSec, deadlineSec)` and work cap. The fixture supplies the arming time and sampled headers. A watch becomes visible after its SQLite insert commits. The sampled latest height is an exclusive floor even when its hash is replaced. The anchor and all later accepted headers must agree with the finalized fixture history.
- Each step handles one height after the durable cursor. The observer verifies both finalized tags against numbered headers and the canonical fixture oracle, rechecks prior checkpoints and verifies the next header's parent and timestamp. Blocks outside the eligibility window require header evidence only. The first finalized block at or after the deadline closes the window. Every block stamped with the deadline second is excluded.
- For each eligible height, two fixture views return logs for the exact contract and indexed `Transfer` parties. They must agree after normalization and deduplication. The observer compares their entire filtered set with the fixture oracle's complete ordered receipts, including successful status and matching block, transaction and log positions. Matching uses indexed event parties and exact `uint256` units, so transfers initiated through another contract can qualify.
- The SQLite transaction records the coverage basis, finalized checkpoints, source IDs, exact filter and log-set digest where applicable, plus candidate evidence and the next cursor. At cutoff, that transaction also records `expired` for zero occurrences, `matched` for one, or `ambiguous` for more. A gap, conflicting evidence or exhausted budget leaves the watch `unresolved`. SQLite write errors propagate and the last committed state remains readable once storage recovers.
- The overlap reservation rejects a second watch on the same normalized tuple with intersecting time windows, including after resolution. The occurrence key `(chain_id, block_hash, log_index)` is unique across the experiment database. Identical logs returned twice collapse, while distinct logs in a transaction count separately.
- Each source read attempt is charged durably before the call, including failures and replay. Work is capped at admission. A crash can consume a debit without executing the read. A replay starts at the last durable cursor and spends new debits. Exhaustion requires intervention outside this experiment.

## Independent review handoff

Review against `8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5` on `experiment/base-sepolia-observer-cp1`. All additions are under this directory. Start with `evidence.ts` for the exact predicate and `observer.ts` for the durable state transitions. Run the three commands above and check these failure paths in `observer.test.ts`.

1. Hide all or part of the filtered log set from both views. The oracle must prevent cursor advancement and both single-candidate matching and expiry. Repeat with a missing middle header after a candidate has been persisted.
2. Review the sampled-height and whole-second boundaries on the replacement fork. Check that the original log position never becomes a candidate and that the retained finalized checkpoint blocks regression or conflicting history.
3. Verify the four subprocess exits immediately before and after the candidate/cursor and terminal commits. Check rollback on SQLite statement failure, uniqueness across replay and budget persistence when the database reopens.

On Windows with `core.autocrlf=true`, the existing server mutation test in `apps/server/roundwatch-observatory-readiness.test.ts` can report `Mutation target must exist`. It searches for literal LF sequences in a CRLF checkout. This failure reproduced in isolation.

`matched` attests to an observed qualifying transfer. The ordinary transfer tuple cannot prove business invoice identity, and a later watch reusing a tuple can still see a late payment for an earlier obligation. The deterministic receipt oracle and canonical headers are trusted fixture inputs. The log views simulate faults independently, using the same synthetic chain data. The digest records agreement within that model and supplies no cryptographic receipt proof. A fault shared by all evidence inputs can defeat this model. The fixture arming clock does not exercise live sampling or commit latency. One-height scans, fixed fixture limits and logical read counts establish no live-RPC behavior, capacity, economics or commercial demand.
