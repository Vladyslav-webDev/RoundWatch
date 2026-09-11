# AGENTS.md

## Project status

This repository contains a verified Algorand TestNet x402 v2 payment skeleton.

The following flow has been proven end-to-end:

HTTP 402
→ signed TestNet USDC payment
→ GoPlausible verification
→ on-chain settlement
→ HTTP 200

Treat this working payment path as a known-good baseline.

## Core principles

- Preserve working behavior unless the current task explicitly requires changing it.
- Do not expose, print, commit, or otherwise leak mnemonics, private keys, or secrets.
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
- Algorand TestNet
- TestNet USDC

Changes to this baseline are allowed only when:
1. the current task explicitly requests them, or
2. a verified technical issue makes the current approach invalid.

If a baseline change appears necessary, explain the reason before making a broad
architectural change.

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