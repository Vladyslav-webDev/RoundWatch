# AGENTS.md

## Project status

This repository contains RoundWatch, a live x402-paid durable Algorand
payment-observation service.

The production MainNet flow has been proven end-to-end:

```text
HTTP 402
→ locally signed MainNet USDC service payment
→ GoPlausible verification and on-chain settlement
→ durable SQLite watch activation
→ later exact MainNet USDC invoice match
→ persisted result available through the status API
```

The production API runs on Render at `https://roundwatch-api.onrender.com`.
MainNet uses Circle USDC ASA `31566704`; TestNet remains the safe default for
local development, regression testing, and fault injection.

Treat the live-proven MainNet path and the known-good TestNet payment path as
baselines. Preserve their behavior unless the current task explicitly requires
a change. `README.md` and the current operational documents under `docs/` define
the implemented product; historical research and spike documents do not define
the current API contract.

## Core principles

- Preserve working behavior unless the current task explicitly requires changing it.
- Do not expose, print, commit, or otherwise leak mnemonics, private keys, or secrets.
- Do not make a MainNet payment without explicit human authorization for that exact spend.
- Keep wallet signing in the client boundary; the server must not receive a mnemonic or private key.
- Preserve persistent production watch state and fail-closed settlement behavior.
- Prefer minimal, reversible changes.
- Avoid speculative abstractions that are not required by the current task.
- Distinguish verified facts from inference and hypotheses.
- Prefer primary sources for research and technical claims.
- Record important sources/URLs in research outputs.

## Agent autonomy

You may:
- inspect the entire repository;
- run tests, typechecks, and diagnostic commands;
- research external sources;
- create or update documentation requested by the task;
- identify flaws in the current architecture or assumptions;
- recommend changes outside the task scope when they materially affect the project.

Do not silently avoid a useful finding because it is outside the current task.
Document it as a recommendation instead of implementing it unless implementation
is explicitly requested.

## Infrastructure baseline

Current baseline:

- TypeScript
- Node.js
- Hono
- x402 v2
- Algorand AVM
- GoPlausible hosted facilitator
- Bazaar discovery
- challenge attribution
- Algorand MainNet production with Circle USDC ASA `31566704`
- Algorand TestNet development and regression environment
- durable SQLite state in WAL mode
- Algorand Indexer-backed exact future-payment matching
- in-process watch poller and settlement reconciler
- single-instance Render deployment with a persistent disk mounted at `/data`

Changes to this baseline are allowed only when:
1. the current task explicitly requests them, or
2. a verified technical issue makes the current approach invalid.

If a baseline change appears necessary, explain the reason before making a broad
architectural change.

Do not infer that the current single-instance design provides arbitrary scale,
an SLA, a watch TTL, a quota, or a final pricing policy. Those remain product and
operational decisions.

## Scope discipline

Follow the current task as the primary source of scope.

Do not expand a narrowly scoped task into unrelated product development.

However, do not suppress important:
- security risks;
- competition risks;
- technical blockers;
- incorrect assumptions;
- high-value opportunities.

Surface them clearly in the requested deliverable.

## Research standard

For research tasks:

- map the landscape before recommending a winner;
- compare alternatives using explicit criteria;
- identify crowded and underserved areas;
- examine pricing, demand signals, differentiation, and technical feasibility;
- evaluate whether x402 is essential to the idea or merely decorative;
- challenge weak premises;
- provide a ranked shortlist when the evidence supports one.

Do not optimize for novelty alone.
Prefer ideas that combine real demand, x402-native value, feasible execution,
and strong challenge differentiation.

Treat dated research, competitor observations, leaderboard positions, pricing
hypotheses, callbacks, and proposed TTLs as historical analysis unless current
implementation or operational documentation independently confirms them.
