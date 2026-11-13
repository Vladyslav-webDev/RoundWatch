# Base Sepolia observer CP2A

This experiment scans synthetic Circle USDC transfers on Base Sepolia (`eip155:84532`, contract `0x036CbD53842c5426634e7929541eC2318f3dCF7e`) and separately qualifies a small set of historical RPC reads. Node.js 24 provides SQLite and runs the TypeScript directly.

From the repository root, run:

```powershell
node --test experiments/base-sepolia-observer/*.test.ts
pnpm -C apps/server exec tsc -p ../../experiments/base-sepolia-observer/tsconfig.json
node experiments/base-sepolia-observer/demo.ts --cp2
node experiments/base-sepolia-observer/demo.ts
```

The typecheck uses the repository's existing TypeScript and Node types. The demos print the watch, cursor, cutoff, outcome, candidate receipt evidence and per-source work counts. `--cp2` uses `cp2-demo.sqlite`; the original CP1 demo uses `cp1-demo.sqlite`. Running either again reopens its own database. On the fresh demo fixture, CP2 resolves the same six covered heights and one candidate in one step and 34 charged reads; CP1 takes six steps and 93 charged reads. The log reads fall from six single-height calls to two range calls; both versions read three fixture receipt sets. These are local logical reads, not RPC benchmarks.

Local validation passed 52 tests, both demos and their reopens, the experiment typecheck, and `git diff --check`. The fresh checkout had no installed packages and pnpm's registry lookup failed in the sandbox. The typecheck used the existing CP1 checkout's pinned TypeScript 7.0.2 and `@types/node` 22.20.2 with this experiment's `tsconfig.json`.

## Evidence contract

- Admission freezes the sampled latest header, finalized anchor, exact sender/recipient/positive atomic amount, `[opensAtSec, deadlineSec)` and work cap. The fixture supplies the arming time and sampled headers. A watch becomes visible after its SQLite insert commits. The sampled latest height is an exclusive floor even when its hash is replaced. The anchor and all later accepted headers must agree with the finalized fixture history.
- `Observer.stepRange` handles at most 16 consecutive heights after the durable cursor, limited by the lower finalized head and the first block at or after the deadline. Callers can choose a smaller range. The observer verifies both finalized tags against numbered headers and the canonical fixture oracle, rechecks prior checkpoints, and verifies parent links and nondecreasing timestamps. Blocks outside the eligibility window require header evidence only. Every block stamped with the deadline second is excluded. `Observer.step` retains the original single-height CP1 behavior.
- Each fixture view supplies one inclusive log response for the contiguous eligible part of the range, filtered by exact contract and indexed `Transfer` parties. The observer rejects missing or oversized responses and logs outside that range. It compares both normalized log sets block by block with the fixture oracle's complete ordered receipts, including successful status and matching block, transaction and log positions. Matching uses indexed event parties and exact `uint256` units, so transfers initiated through another contract can qualify.
- One SQLite transaction records all coverage rows, their finalized checkpoints, source IDs, exact filter and log-set digests where applicable, plus candidate evidence and the next cursor. At cutoff, that transaction also records `expired` for zero occurrences, `matched` for one, or `ambiguous` for more. A gap, conflict, exhausted budget or failed write commits none of the proposed coverage or candidates. Previously validated finality checkpoints and work debits can survive a failed range. SQLite write errors propagate and the last committed state remains readable once storage recovers.
- The overlap reservation rejects a second watch on the same normalized tuple with intersecting time windows, including after resolution. The occurrence key `(chain_id, block_hash, log_index)` is unique across the experiment database. Identical logs returned twice collapse, while distinct logs in a transaction count separately.
- Each source read attempt is charged durably before the call, including failures and replay. Work is capped at admission. A crash can consume a debit without executing the read. A replay starts at the last durable cursor and spends new debits. Exhaustion requires intervention outside this experiment.

## Read-only RPC qualification

[QUALIFICATION.md](QUALIFICATION.md) records the actual providers, ranges, methods, ceilings, measurements and failures. The finite CLI compares a range response with the same provider's single-height responses and with a separately operated provider. It checks chain ID, finalized tags against numbered headers, parent links, and log block/transaction positions. Its output is measurement evidence only: it does not open SQLite or advance watches. Missing or conflicting evidence from either endpoint leaves that range unresolved. Even an agreed result cannot exclude omissions shared by providers or by their underlying infrastructure; it supplies no authenticated proof of receipt completeness or absence.

## Independent review handoff

Review the complete local `cp2a-complete.diff` against `4e68cc8c89e9ab04f1095ab7ed691e49638adbc9` on `experiment/base-sepolia-observer-cp2`. The patch includes newly added files and can be checked with `git apply --check` from a clean baseline. All changes are under this directory. Start with `observer.ts` for the durable transitions, `evidence.ts` for the exact predicate, and `rpc.ts` and `qualification.ts` for live-read isolation and ceilings. Run the focused tests and typecheck above.

1. In `range.test.ts`, check the 16-height cap, finality and deadline boundaries, and the two reads for one eligible range. Verify that a missing middle header, missing range, out-of-range log, false-empty response or shared truncation leaves the entire proposed range uncommitted.
2. Check the SQLite failure midway through a range, the four subprocess exits around candidate and terminal range commits, and restart with an exhausted work budget. Confirm that coverage, occurrences, cursor and terminal outcome move together. The CP1 tests still exercise replacement forks, overlap reservations, exact units and uniqueness across replay.
3. In `rpc.test.ts`, check that the allowlist, Base Sepolia chain gate and request/time/body ceilings fail closed. In the qualification report, review each observed range separately, and distinguish savings on log calls from total catch-up costs. The report and code do not establish whether the providers share infrastructure.

On Windows with `core.autocrlf=true`, the existing server mutation test in `apps/server/roundwatch-observatory-readiness.test.ts` can report `Mutation target must exist`. It searches for literal LF sequences in a CRLF checkout. This failure reproduced in isolation.

`matched` attests to an observed qualifying transfer in the fixture model. The ordinary transfer tuple cannot prove business invoice identity, and a later watch reusing a tuple can still see a late payment for an earlier obligation. The receipt oracle and canonical headers are trusted fixture inputs. A fault shared by all fixture inputs can defeat the model. The fixture arming clock does not exercise live sampling or commit latency.
