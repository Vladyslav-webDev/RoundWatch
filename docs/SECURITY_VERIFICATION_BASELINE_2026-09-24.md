# Security verification baseline — 2026-09-24

This document records the security-remediation checkpoint that concluded on
2026-09-24. It is an evidence record for one exact revision, not a claim of
formal verification, perpetual security, or immunity from future regressions.

## Verified revision

- Repository: `Vladyslav-webDev/RoundWatch`
- Branch: `main`
- Exact commit: `4e291168ffee803ce663833608caa4fd1ea771f7`
- Production service: `roundwatch-api`
- Production platform: Render
- Render health-check path at verification time: `/ready`

The targeted verifier confirmed that the exact commit above was live on
`main` and that Render was monitoring `/ready`.

## Verification result

The final targeted verification re-ran only the previously demonstrated release
blockers after the remediation sequence.

| Area | Status | Verified result |
| --- | --- | --- |
| Malformed excluded transaction trees | FIXED | All five reproduced blocker cases preserved cursor/coverage and prevented false expiration. |
| Worker readiness | FIXED | Fully failed work became unready, successful work recovered readiness, and isolated failures preserved independent work. |
| Long healthy sweep | FIXED | A 36.8-second productive sweep remained ready; genuinely stalled workers became unready. |
| Production readiness | FIXED | Target revision was live on `main`, Render used `/ready`, and `/health` remained liveness-only. |

Verifier summary:

- malformed-tree checks: 19/19 passed;
- server test suite: 89/89 passed;
- client test suite: 7/7 passed;
- server typecheck: passed;
- client typecheck: passed;
- final targeted conclusion: **ALL PREVIOUS RELEASE BLOCKERS VERIFIED CLOSED**.

This conclusion is deliberately narrower than "the software is secure". It
means the concrete release blockers previously reproduced by the independent
verification cycle were subsequently remediated and re-tested on this exact
revision.

## Remediation chain

The final remediation sequence after the earlier verification findings was:

- PR #52 — fail closed on malformed excluded transaction trees;
- PR #53 — make worker readiness reflect actual failures and live progress;
- Render configuration — change platform health check from `/health` to
  `/ready`;
- PR #54 — document the production readiness/liveness boundary and the Render
  operational setting.

Earlier remediation PRs #48–#51 addressed the preceding payment admission,
evidence classification, eligibility, MCP, recovery, and Indexer cleanup
findings.

## Audit artifacts

The local audit bundle used during this cycle should be retained together,
outside transient build directories, with this baseline:

- `SECURITY_AUDIT_V1.md`
- `SECURITY_REMEDIATION_REVIEW_V1.md`
- `SECURITY_REMEDIATION_FINAL_VERIFICATION.md`
- `SECURITY_REMEDIATION_FINAL_EVIDENCE.zip`
- `SECURITY_BLOCKER_TARGETED_VERIFICATION.md`
- `SECURITY_BLOCKER_TARGETED_EVIDENCE.zip`

At the time this baseline was recorded, the later Astra-generated reports and
evidence bundles existed under the operator-local
`C:\Dev\roundwatch-local-artifacts\` directory and were not automatically
available to the repository automation. Archive them intentionally rather than
silently reconstructing or paraphrasing the original evidence files.

## Critical-core change policy

The verified revision is the reference point for payment/evidence/readiness
behavior. Changes to the following boundaries require an explicit reason and
targeted regression review:

- x402 payment admission, verification, settlement, or recovery;
- transaction/evidence classification and coverage advancement;
- activation, expiry, cursor, or absence-proof semantics;
- durable SQLite state or migration behavior;
- poller/reconciler worker-health semantics;
- `/ready`, paid-traffic readiness gating, or Render health-check behavior.

Ordinary documentation, discovery, integration examples, and distribution work
should not modify those boundaries incidentally.

## When to run another broad security review

Do not schedule a broad clean-room audit simply because time passed. Run a new
broad review when the threat model or architecture materially changes, for
example:

- support for another chain, settlement backend, or payment scheme;
- replacement of the x402/facilitator integration;
- shared durable storage, horizontal workers, or multi-instance coordination;
- new authentication/authorization or private customer data;
- material changes to settlement, evidence, recovery, or expiry semantics;
- a wider production release where the expected impact justifies another
  clean-room review.

Until one of those triggers occurs, prefer focused regression verification for
changes touching an already verified critical boundary.
