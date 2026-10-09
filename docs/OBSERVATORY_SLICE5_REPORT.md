# RoundWatch Observatory Slice 5 implementation report

Implemented and locally verified on 2026-10-08. No commit or deployment.

The original implementation record below is retained as history. The **Correction 01** addendum at the end records the current corrections, validation results and final working-tree statistics, and supersedes the original final test counts/statistics.

## Repository identity

- Repository: `C:\Dev\x402-audit-observatory-s5`
- Required and final branch: `feat/observatory-protected-endpoint`
- Exact baseline and final HEAD: `667e6b3e112edc7d5e993ebae2ef6c20644f04d9`
- Branch, HEAD and empty `git status --porcelain=v1` were verified before editing.
- Read `AGENTS.md`, `README.md`, the Observatory specification (including sections 1, 3, 5, 7, 8, 10, 11 and 12), production HTTP/startup/lifetime composition, and existing Observatory/shutdown tests.

## Changed and created files

| File | Change |
| --- | --- |
| `apps/server/index.ts` | Capture optional token; isolate optional builder initialization; wire the production dispatch helper into the existing adapter. |
| `apps/server/.env.example` | Empty, disabled-by-default token configuration and provisioning guidance. |
| `apps/server/package.json` | Include the endpoint suite in the full server test command. |
| `apps/server/roundwatch-observatory-transport.ts` | Dedicated protected transport and production HTTP composition helper. |
| `apps/server/roundwatch-observatory-serialization.ts` | Fixed DTO allowlist validation and serialization. |
| `apps/server/roundwatch-observatory-transport.test.ts` | 33 deterministic authentication, isolation, compatibility and lifetime tests. |
| `docs/OBSERVATORY_SLICE5_REPORT.md` | Configuration, behavior, verification, findings and complete change report. |

## HTTP dispatch and middleware isolation

The single existing `createAdaptorServer` now uses `createRoundWatchHttpFetch`:

```text
existing Node adapter
  -> existing ownApplicationFetch / ApplicationLifetime
     -> reserved Observatory namespace dispatch
        -> auth -> existing snapshot builder -> fixed DTO serialization
     -> ordinary appRuntime.app.fetch for all other requests
```

The dispatch helper reserves `/internal/observatory` and descendants before calling Hono. Case, repeated-slash, backslash and percent-encoded aliases are reserved but rejected. Both the normalized Fetch pathname and Node adapter's original `incoming.url` are classified. The original target prevents dot-segment requests such as `/internal/observatory/../../ready` from escaping to operational middleware after Fetch URL normalization. Only the canonical original and normalized path serves data; query strings do not supply authentication.

Successful, unauthorized, disabled, unsupported-method, malformed-path and failed internal requests never invoke Hono. Therefore they bypass its actual request telemetry, request-ID/fingerprint generation, economics free-request recording, permissive CORS, payment/MCP/recovery gates, body parsing, readiness and payment handling. No generic administration router or second listener was added. All adapter arguments are forwarded unchanged for ordinary requests.

## Authentication and fail-closed startup

`ROUNDWATCH_OBSERVATORY_TOKEN` is captured once during startup. Valid configuration is exactly 64 hexadecimal characters, representing a dedicated 32-byte secret. Provision it using a cryptographically secure generator outside this task and keep it server-side. Whitespace is not trimmed into valid configuration. Token characters are case-sensitive; the Bearer scheme is case-insensitive.

Missing, empty, wrong-size, non-hex or whitespace-containing configuration disables the endpoint. Missing builder wiring or an exception during optional builder/transport construction also disables it silently, without preventing operational startup. The token and snapshot getter are captured, so later option mutation cannot enable or rekey the running transport. Rotation requires restart.

Only `Authorization: Bearer <token>` authenticates. Query strings, cookies and bodies are not credential sources. Missing, malformed and incorrect bounded headers are checked using SHA-256 digests and `timingSafeEqual` on two 32-byte buffers, including differently sized submitted tokens. There is no comparison-length shortcut against the configured secret. Authorization values over the public 1,024-character cap are rejected before hashing. Authentication succeeds before the snapshot getter executes.

No environment dump, Authorization echo, token logging, discovery exposure or production token generation occurs. The example configuration remains empty. Synthetic credentials exist only in deterministic tests.

## Response and failure semantics

| Condition, in evaluation order | Status | Body / relevant header |
| --- | --- | --- |
| Lifetime stopped | 503 | Existing `Service is shutting down` response. |
| Disabled endpoint / failed optional initialization | 404 | `{"error":"not_found"}` |
| Reserved noncanonical or unexpected path | 404 | `{"error":"not_found"}` |
| Canonical path with a method other than GET | 405 | `{"error":"method_not_allowed"}`; `Allow: GET` |
| Canonical GET without correct Bearer authentication | 401 | `{"error":"unauthorized"}`; `WWW-Authenticate: Bearer` |
| Authenticated canonical GET | 200 | Existing `observatory-runtime-v0.1` JSON DTO. |
| Snapshot/serialization/optional dispatch exception | 500 | `{"error":"observatory_unavailable"}` |

Every response uses `Cache-Control: no-store`. Transport responses use `application/json; charset=utf-8`; the unchanged lifetime shutdown response retains its existing text semantics. No transport response adds CORS headers. No failure escapes to Hono's error handler, logs raw implementation errors, probes providers, invokes readiness, or substitutes a healthy snapshot.

The existing snapshot builder remains the only snapshot generator. Serialization walks fixed schema keys and validates bounded scalar values and observation envelopes. It preserves schema version, assembly time, original section/failure timestamps, epoch, monotonic time, booleans, all numbers/units and nulls. It does not acquire or repair observations. It ignores unknown raw extras and never executes raw `toJSON` hooks or contract-field accessors. Fixed schema size bounds serialization independently of watch/customer/request count. The DTO types and producer implementations were not changed.

## Lifecycle ownership

`ownApplicationFetch` remains the outer owner, unchanged. Stopped admission rejects internal and ordinary requests before dispatch. An admitted internal request is registered before its snapshot getter runs and stays owned until response construction or generic failure handling finishes, even if its socket/request is aborted. Existing coordinator draining therefore waits for it before store closure. Existing workers, sampler, facilitator, dispatcher, shutdown deadlines and listener ownership are unchanged.

## Noninterference and privacy evidence

Tests use the production-used composition helper with real `createAppRuntime`, Hono telemetry, economics metrics, SQLite store, worker objects, dispatcher, facilitator/Indexer clients and retention primitives. There is no alternate test-only HTTP implementation.

Guarded requests assert zero calls at the following real boundaries:

- SQLite `prepare`/`exec` and prepared-statement `all`/`get`/`run`/`iterate`, store readiness and capacity acquisition.
- Facilitator supported/verify/settle, Indexer methods/transport, global network fetch and dispatcher dispatch.
- Sync/async filesystem stat, statfs and reads; named built-in imports are synchronized with the guards.
- Public/strict-paid readiness, worker readiness, poller turns, reconciliation, capability probing and runtime sampler acquisition.
- Mutable signed-payment/MCP/recovery/body gates through their actual shared gate prototype.
- Telemetry request-ID/time/log callbacks, economics request recording and all five console logging methods.
- Timers, CPU acquisition and memory sampling.

Fifty authenticated reads per network preserve the exact DTO and retained records, counters, worker state and economics state. Fifty synchronous and fifty asynchronous failures also produce zero operational work/logs. Authentication, disabled configuration, all unsupported methods, malformed aliases, original Node dot-segment targets and shutdown rejections are separately covered. Auth tests directly assert that each bounded credential attempt compares 32-byte digests.

Privacy tests inject raw token/watch/address/provider extras, private getters and `toJSON` hooks and verify that only approved DTO fields serialize. Invalid schema/timestamps/numbers/envelopes and contract accessors return a bounded generic error. Ordinary MainNet/TestNet health, ready, watch, MCP, recovery and discovery responses match direct Hono responses. Actual strict paid admission still fails closed without Observatory refreshing evidence or consuming tokens. In-flight success and failure tests exercise existing shutdown coordinator draining after request abortion.

## Local verification and substitution

The working checkout had no `node_modules`. No package manager installation or download was performed. Existing project-local binaries/dependencies from `C:\Dev\x402-audit-c5` were reused through temporary filesystem junctions in a separate source copy. Its lockfile SHA-256 exactly matches this checkout: `87F41F1184DAA5F19A9AFB997D3E24401D28244B682309E0C14A3FFC4FAD3233`.

Validation directory: `<local-validation-directory>`.

Tools: Node.js `v24.14.0`, installed `tsx 4.23.13`, installed TypeScript `7.0.2`. Commands used the local `.cmd` binaries directly; `pnpm`, `npx` and dependency installation were unnecessary. The full test list was taken from the updated server package script. All 101 application source files were compared with the validation copy; they are byte-identical except for the documented baseline LF normalization. No repository dependency link or lockfile modification was made.

| Check | Result |
| --- | --- |
| Focused `tsx --test roundwatch-observatory-transport.test.ts` | **33/33 passed**, no failures/skips/cancellations. |
| Initial full suite with verbatim Windows CRLF source, before two extra edge-case tests | **735/736 passed**; one unchanged LF-sensitive mutation-test failure, described below. |
| Final complete server suite with exact Git LF content for that unchanged source file | **738/738 passed**, no failures/skips/cancellations. |
| Server `tsc --noEmit`, after final code changes | Passed. |
| Client `tsc --noEmit` | Passed. |
| Observatory `tsc --noEmit` | Passed. |
| `git diff --check` | Passed. |
| Untracked-file whitespace checks | Passed. |

The existing `roundwatch-observatory-readiness.test.ts` test named `regression detects removal of the observer failure-isolation boundary` searches its source for an exact LF marker. This checkout has `core.autocrlf=true`, with index LF / working-tree CRLF for `roundwatch-observatory-readiness.ts`. The first full run failed with `Mutation target must exist` before exercising its intended mutant. Both the test and producer file are unchanged from baseline. Only the validation copy's producer line endings were normalized; its resulting Git blob hash is exactly baseline `43b70a2b3002e276a7ee1f57ea411fa00f2852c3`. The final full suite then passed. No test was skipped, patched or weakened; repository line endings were left untouched.

## Residual findings and scope confirmations

- The unchanged mutation test remains LF-sensitive in this Windows checkout. A separate follow-up should normalize its input before marker matching or make its marker tolerate CRLF. That fix was not added to this transport task.
- Token validation verifies representation and size; no validator can prove that an operator chose cryptographically random material. Secure provisioning remains required. Runtime credential rotation is intentionally restart-scoped.
- Verification was local, against copied source and existing lockfile-matching dependencies. Production configuration and deployment were not inspected or changed. Direct test execution in this checkout still needs its dependencies restored; production enablement remains a separate action.
- No FlowHUD integration, UI, proxy, operational acquisition, sampler, timer, schema migration, DTO change, payment/pricing/watch/reconciliation change or external observability infrastructure was added.
- No endpoint is enabled without a valid configured secret and a wired existing builder. No production credential was created or installed.
- Existing MainNet/TestNet operational behavior is preserved; all existing operational application and lifetime code paths retain their behavior.
- No live production/provider/payment request or actual payment was performed. All provider/payment fixtures were local and mocked.
- No commit, push, PR, deployment or external resource modification occurred. Work stopped after implementation and local verification.

## Complete final Git status

```text
 M apps/server/.env.example
 M apps/server/index.ts
 M apps/server/package.json
?? apps/server/roundwatch-observatory-serialization.ts
?? apps/server/roundwatch-observatory-transport.test.ts
?? apps/server/roundwatch-observatory-transport.ts
?? docs/OBSERVATORY_SLICE5_REPORT.md
```

## Diff statistics including untracked files

Untracked new-file additions are included explicitly; nothing was staged for measurement.

| File | Additions | Deletions |
| --- | ---: | ---: |
| `apps/server/.env.example` | 5 | 0 |
| `apps/server/index.ts` | 28 | 17 |
| `apps/server/package.json` | 1 | 1 |
| `apps/server/roundwatch-observatory-serialization.ts` | 110 | 0 |
| `apps/server/roundwatch-observatory-transport.test.ts` | 634 | 0 |
| `apps/server/roundwatch-observatory-transport.ts` | 114 | 0 |
| `docs/OBSERVATORY_SLICE5_REPORT.md` | 146 | 0 |
| **Total: 7 files** | **1,038** | **18** |

## Correction 01 — R-01 and R-02

Implemented and locally verified on 2026-10-09. Scope was the explicitly authorized correction prompt; the independent review Markdown and ZIP were supporting evidence. No subagents were used.

### Identity and preservation

- Initial and final branch: `feat/observatory-protected-endpoint`.
- Initial and final HEAD: `667e6b3e112edc7d5e993ebae2ef6c20644f04d9`.
- Initial status contained the same seven modified/untracked Slice 5 files listed below. No reset or clean-tree requirement was imposed.
- This correction edits only `roundwatch-observatory-transport.ts`, `roundwatch-observatory-serialization.ts`, `roundwatch-observatory-transport.test.ts` and this report.
- The existing changes to `apps/server/index.ts`, `.env.example` and `package.json` were retained without further editing. Their baseline diff remains 34 additions / 18 deletions.
- Lockfiles, dependencies, credentials, DTO/version, readiness producers, public `/ready`, operational routing and application lifetime implementations were not edited.

### R-01: explicit classification budget and policy

The classifier returns `normal`, `reserved` or `rejected`. The complete Fetch URL and original adapter request target each have an **8,192 UTF-16 code-unit** limit, including authority, query and fragment when present. Length is checked before this helper parses the URL or strips/splits the raw target. Both extracted paths have the same limit.

Each path uses at most **four percent-decoding replacements and five classification rounds**. Each round performs only fixed linear scans over a capped, non-growing string: backslash/slash normalization, case conversion, reserved-prefix comparison and percent detection. The two paths together therefore permit at most eight decoding replacements / ten classification rounds; cost no longer grows with encoding depth. Raw-path rejection stops before the normalized classifier. URL parsing and target extraction also receive bounded inputs. This bounds the helper's own work; Fetch/adapter processing before the helper is outside this correction.

Remaining escapes after four passes, malformed escapes that cannot decode, and oversized targets return the same generic **404 `{"error":"not_found"}`**, with `Cache-Control: no-store`, no CORS, no Hono dispatch, no snapshot acquisition and no operational logging. Recognized reserved aliases still return the existing generic 404. This protection applies with the endpoint enabled or disabled. Ordinary canonical targets within the limit still forward their original request and adapter arguments unchanged.

The deliberate compatibility policy rejects pathological ordinary encoded targets as well as hidden reserved targets. It also rejects any complete target beyond the limit, even if the excess is only authority/query content. Supported shallow aliases remain reserved and rejected; at the four-pass boundary ordinary encodings still forward. Canonical Observatory authentication/success and original-target dot-segment protection remain unchanged.

The two enabled/disabled deterministic regressions cover reserved and ordinary tails at depths 4, 32, 128, 4,000 and 7,500, with raw-only, normalized-only and combined targets: **60 rejection cases total**. In-budget nested cases use exactly four decoding passes; oversized depth-7,500 cases use zero. Further cases cover oversized paths/authorities/queries and ambiguous escapes, and shallow boundary cases verify adapter argument forwarding. Operational guards assert zero Hono, getter, SQL, filesystem, provider, gate, sampler, timer, fingerprint and logging work for rejected requests. Existing shutdown/admission, aborted in-flight ownership and canonical route/authentication tests still pass.

Isolated regression evidence uses the old candidate modules extracted from the supplied ZIP, stored only in the validation directory. The same new classifier regression tests with only their module import redirected to the old transport fail **2/2**, enabled and disabled: five passes where four were asserted at the first depth-4 input. No worktree implementation was temporarily reverted.

An additional deterministic depth-128 probe records:

| Classifier | Configuration | Reserved passes / result | Ordinary passes / result |
| --- | --- | --- | --- |
| Old | Disabled | 129 / 404 | 260 / 200, operational handler called once |
| Old | Enabled | 129 / 404 | 260 / 200, operational handler called once |
| Corrected | Disabled | 4 / 404 | 4 / 404, zero operational calls |
| Corrected | Enabled | 4 / 404 | 4 / 404, zero operational calls |

All four corrected probe responses have no-store, no CORS and zero snapshot calls. No latency threshold or production timing claim is used.

### R-02: validate complete readiness before encoding

The serializer validates the own data `ready` field with the checks variant. Exception encoding requires `ready:false`, an own data `readinessCheck:false`, and no own normal-check key (`storage`, `poller`, `reconciler`, `backgroundWorkers`, `diskHeadroom`). Mixed variants are rejected even when a normal key is non-enumerable or an accessor. Complete normal variants still require all five boolean checks. The serializer does not repair or derive booleans, enumerate private extras, call accessors/toJSON, or modify source data.

The malformed-readiness regression exercises **15 DTOs**: both mixed complete variants, ten mixed individual normal-key accessor cases, contradictory true readiness with exception checks, an invalid true exception flag, and an exception accessor. Every case returns the existing generic **500 `{"error":"observatory_unavailable"}` / no-store**, without error details, CORS, operational work/logging or fallback acquisition. Each attempted read calls its supplied snapshot getter exactly once; source descriptors and retained observations remain unchanged.

The preservation regression exercises positive, negative and exception observations with private extras, private getters and custom toJSON hooks. Each returns 200 and preserves every approved field, boolean, availability, original observation/failure timestamp and null verbatim. Source data/check descriptors remain unchanged. The same malformed regression redirected to the isolated old serializer fails **1/1**, returning 200 where 500 is required.

### Correction validation environment and actual commands

No dependencies were installed. Installed dependencies from `C:\Dev\x402-audit-c5` were reused through junctions only in a source copy. Both lockfiles have SHA-256 `87F41F1184DAA5F19A9AFB997D3E24401D28244B682309E0C14A3FFC4FAD3233`. Tools were Node `v24.14.0`, tsx `4.23.13`, TypeScript `7.0.2`; no pnpm/npx/download was needed.

Persistent validation root: `<local-validation-directory>`. The copy contains `source/apps` and root package/workspace/lock files, with dependency junctions to the existing root/server/client/observatory node_modules. Sandbox junction creation was denied, and per-command sandbox temporary paths did not persist; the copy was recreated in the persistent host temporary directory with approved escalation. Those setup attempts did not execute tests. No dependency junction was added to the repository.

Commands ran from the copied `apps/server` unless stated otherwise:

```powershell
# Focused integration suite
& .\node_modules\.bin\tsx.cmd --test roundwatch-observatory-transport.test.ts

# Exact full server script file list, verbatim source and then LF validation copy
$script = (Get-Content package.json -Raw | ConvertFrom-Json).scripts.test
$tests = $script.Split(' ') | Select-Object -Skip 2
& .\node_modules\.bin\tsx.cmd --test @tests

# Run once from each copied apps/server, apps/client and apps/observatory
& .\node_modules\.bin\tsc.cmd --noEmit

# Isolated old-module regressions, same assertions with redirected import
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern='nested reserved and ordinary targets obey a fixed decode budget' __old-classifier.test.ts
& .\node_modules\.bin\tsx.cmd --test --test-name-pattern='mixed and contradictory readiness variants fail' __old-readiness.test.ts
& .\node_modules\.bin\tsx.cmd __classifier-probe.ts

# Repository identity, state, line endings and tracked whitespace/statistics
git branch --show-current
git rev-parse HEAD
git status --porcelain=v1 --untracked-files=all
git ls-files --eol apps/server/roundwatch-observatory-readiness.ts apps/server/roundwatch-observatory-readiness.test.ts
git diff --check
git diff --numstat
# For each of the four untracked files, also:
git -c core.autocrlf=false diff --no-index --check -- NUL <file>
git -c core.autocrlf=false diff --no-index --numstat -- NUL <file>
```

| Check | Correction 01 result |
| --- | --- |
| First focused run | 38/40; two new assertion failures used an incorrect 8,000 cutoff for the intended 8,192 limit. Test assertion corrected; implementation unchanged. |
| Final focused run | **40/40 passed**. Seven regressions added to the original 33 tests. |
| Full server suite, byte-verbatim source copy | **744/745 passed**, one unchanged CRLF-sensitive readiness mutation-test failure. |
| Full server suite, LF-normalized validation copy | **745/745 passed**. |
| Server/client/Observatory package typechecks | **All three passed**. |
| Old classifier regression | **2/2 expected failures**, both configurations detect old behavior. |
| Old serializer regression | **1/1 expected failure**, detects malformed DTO accepted as 200. |
| Source/config parity after restoring copied readiness line endings | **97/97 `.ts`/`.json` application files byte-identical** to the worktree; isolated harness files are additional validation-only files. |
| Tracked/untracked whitespace checks | **Passed**, no whitespace diagnostics. |

Every test run reports zero skipped/cancelled/todo tests. These are separate runs for specific failures/substitutions, not a claim of repeated-run stability. Logs are `focused.tap` (initial run), `focused-final.tap`, `full-verbatim.tap`, `full-lf.tap`, `old-classifier-regression.tap`, `old-readiness-regression.tap` and `classifier-probe.json` in the validation root.

Tracked whitespace checking exits 0. Each untracked `--no-index --check` exits 1 because the file differs from `NUL`, with zero diagnostic lines; no whitespace errors are present. The per-command `core.autocrlf=false` affects only measurement, not repository configuration or source line endings.

The verbatim failure remains `regression detects removal of the observer failure-isolation boundary`: its baseline mutation marker requires LF, but the worktree producer has CRLF. Only the copied `roundwatch-observatory-readiness.ts` was normalized for the LF full-suite run; its hash is exactly baseline Git blob `43b70a2b3002e276a7ee1f57ea411fa00f2852c3`. It was restored byte-verbatim afterward. The producer and CRLF-sensitive test in the repository remain unchanged. **745/745 does not describe a verbatim-worktree full-suite pass.**

### Final working-tree status and complete statistics

```text
 M apps/server/.env.example
 M apps/server/index.ts
 M apps/server/package.json
?? apps/server/roundwatch-observatory-serialization.ts
?? apps/server/roundwatch-observatory-transport.test.ts
?? apps/server/roundwatch-observatory-transport.ts
?? docs/OBSERVATORY_SLICE5_REPORT.md
```

Statistics below are against HEAD, including all existing Slice 5 work and all four untracked files. Nothing was staged to measure them.

| File | Additions | Deletions |
| --- | ---: | ---: |
| `apps/server/.env.example` | 5 | 0 |
| `apps/server/index.ts` | 28 | 17 |
| `apps/server/package.json` | 1 | 1 |
| `apps/server/roundwatch-observatory-serialization.ts` | 118 | 0 |
| `apps/server/roundwatch-observatory-transport.test.ts` | 778 | 0 |
| `apps/server/roundwatch-observatory-transport.ts` | 130 | 0 |
| `docs/OBSERVATORY_SLICE5_REPORT.md` | 280 | 0 |
| **Total: 7 files** | **1340** | **18** |

### Remaining limits and next step

The existing Windows/LF mutation-test portability caveat remains. All execution used copied source and installed dependencies; direct execution in the dependency-free checkout was not substituted with a claimed success. Complete-target caps and rejection of unresolved/malformed ordinary encodings are the deliberate R-01 routing-policy changes. No other valid routing, authentication, lifetime, DTO or producer behavior was changed, and no operational acquisition was added.

Local tests/probes do not establish production intermediary limits, production performance or repeated-run stability. Production/provider/payment access, credential changes, dependency installation, staging, commit, push, PR and deployment were not performed. Work stops after this correction and local validation. The next gate is a targeted independent review of R-01/R-02.
