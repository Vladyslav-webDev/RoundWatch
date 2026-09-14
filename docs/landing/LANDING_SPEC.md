# RoundWatch landing — production run 1

Public identity: **RoundWatch**, <https://roundwatch.observer/>. This document
preserves the approved brief and implementation decisions for a later independent
polish/QA pass. The website is a production static artifact; the payment observer
it describes remains a verified, narrow **Algorand TestNet prototype**.

## Scope and repository boundaries

- Implement only `apps/landing`, a Vite + React + TypeScript static browser app.
- Preserve `apps/client` (Node payment/lifecycle client) and `apps/server` (Hono
  payment infrastructure). No runtime changes, broad dependency upgrades, new
  payment flows, public API, signup, forms, analytics, authentication, or demo backend.
- Stay on `feat/roundwatch-landing`; keep the repository private. One coherent
  implementation commit. No push, merge, history rewrite, deployment, DNS,
  Cloudflare, Netlify login, or domain operations in this run.
- Use pnpm **12.3.4** exclusively. Root `packageManager` remains the authority.
  `corepack pnpm` is used here because the environment's plain `pnpm` shim reports
  11.19.0. Never create npm/yarn lockfiles or commit environment/runtime data.
- Preserve the approved `docs/landing/reference.png`. It sets visual quality,
  composition, palette, technical graphics, and atmosphere, not current copy,
  claims, destinations, navigation, or live status.

## Product truth and evidence

The problem: completed agent work does not by itself prove payment settlement.
RoundWatch observes payment settlement, advances state from successful settlement
evidence, and persists evidence and observation progress so a workflow has a
trustworthy boundary for its next action.

**Deterministic infrastructure establishes settlement. An LLM never decides whether
the payment actually settled.** No claim of automated LLM continuation, runtime
Astra integration, arbitrary blockchain event matching, MainNet readiness,
unlimited reliability, callbacks, or complete production crash reconciliation.

Reviewed evidence:

| Public capability | Local support |
| --- | --- |
| Settlement lifecycle observation; successful evidence controls activation | `apps/server/app.ts`: `onAfterSettle`, guarded activation, durable-response guard |
| Durable persistent state | `apps/server/roundwatch-store.ts`: SQLite-backed watch and settlement records |
| Persisted scan/observation cursor | `roundwatch-store.ts` and `roundwatch-poller.ts`: stored `scanAfterRound` |
| Restart recovery and future-payment detection | `docs/ROUNDWATCH_SPIKE.md`: real process restart and later separate TestNet transfer; focused regression tests |
| Exact expected transfer observation | `roundwatch-indexer.ts`: sender, receiver, asset, amount and optional note matching |

`AGENTS.md`, `README.md`, both existing package manifests, the workspace manifest,
and `docs/ROUNDWATCH_SPIKE.md` were inspected before implementation. The spike
document is newer and more precise than the baseline README for observer behavior.
The landing adds no secret, public wallet address, transaction ID, amount, live
balance, or sensitive implementation configuration.

The spike documents real production limitations: settlement and SQLite are not
atomic; a crash after settlement but before persistence has no reconciliation;
failure to capture an activation round can miss an early transfer. Scaling,
authorization, API hardening, and MainNet remain unproven. The site describes
the validated scope, not a guarantee that these gaps are solved.

## Astra and challenge boundary

No runtime OpenAI/Astra integration exists in the inspected client/server code or
package manifests. GPT-6 Astra appears as the tool used to build/evolve RoundWatch
and as challenge context. A separate, explicitly **future** reasoning concept
shows verified evidence → intelligent reasoning → next action. It is not an
active step in the deterministic execution diagram or replay.

The user-provided challenge marker is **GPT-6 Astra Challenge — Product Hunt ·
September 18, 2026**. Its date and association come from the task brief; no external
endorsement, official partnership, or already-published launch is asserted.
Product Hunt is the intended launch platform, never the runtime provider.

## Page architecture and canonical copy

1. Compact sticky header: original RoundWatch ring/signal SVG; Product,
   How it works, Technology, Demo; View demo CTA. Mobile disclosure menu.
2. Hero eyebrow: **AI AGENTS × PAYMENTS × VERIFIED CONTINUITY**.
   H1: **Agents do the work. We prove they got paid.** Supporting copy:
   “RoundWatch observes agent payments, verifies settlement, and preserves durable
   evidence so autonomous workflows can safely keep moving.” See the demo and
   How it works anchor CTAs. TestNet proof note and ambient-motion control.
3. Four proof items: On-chain verification / REAL SETTLEMENTS; Persistent state /
   SURVIVES RESTARTS; Restart-safe / AGENTS KEEP GOING; Built for agentic workflows /
   OPEN STANDARDS. These are product direction grounded in the qualified prototype.
4. `#product` — **01 / PRODUCT**, “Reliable continuity for autonomous work.”
   Open observation-ring composition and Observe / Verify / Persist rows using
   the supplied factual descriptions. Expected payment → verified evidence → next action.
5. `#how-it-works` — **02 / THE FLOW**, “From completed work to what’s next.”
   Four connected nodes: Agent performs work; x402 payment initiated; RoundWatch
   observes; Verified & continue. Selecting a node explains its trust boundary.
6. `#technology` — **03 / TECHNOLOGY**, “Deterministic where it matters.
   Intelligent where it helps.” Core sequence: Agent → x402 payment → Algorand
   settlement → RoundWatch → verified durable evidence → workflow continuation.
   Six verified capabilities, explicit TestNet-prototype qualifier, separate future
   reasoning concept, and the principle “Reason over verified evidence — never replace it.”
7. `#demo` — **04 / DEMO**, “Watch a payment become trusted state.” A clearly labelled
   **WORKFLOW REPLAY**, initialized with the completed example for useful first viewing.
   Six illustrative events: task completed; x402 payment initiated; transaction
   detected; settlement verified; evidence persisted; continuation unlocked.
   Supplied 10:24 timestamps are illustrative. Replay, pause/resume, current-event
   emphasis, progress, and accessible status. No payment or network request occurs.
8. **05 / RESILIENCE**, “Restart the server. Keep the truth.” Timeline: payment
   expected → scan progress saved → server stops → server starts → state restored →
   observation resumes → future payment detected. Visually show the process break
   and the durable-state bridge. Qualify with the actual TestNet restart proof.
9. **06 / WHY IT MATTERS**, “A more reliable agent economy.” Three spacious audience
   panels: agents (evidence to continue), services (clear settlement boundary),
   developers (durable state instead of volatile memory).
10. Full-width ecosystem ribbon: PRODUCT HUNT, OPENAI, GPT-6 ASTRA, ALGORAND, x402.
    Typographic wordmarks; no proprietary logos have been reconstructed.
11. Restrained Astra build/challenge block below the main product story.
12. Final CTA: “Watch autonomous work complete the loop.” View demo and How it works.
13. Footer: brand, domain identity, “Reliable settlement evidence for autonomous
    work.” The same four working section links and Back to top.

No Pricing, About, Careers, Blog, fake Docs/Contact, Talk to us, early access,
signup, public GitHub CTA, fake live activity, or dead destinations.

## Visual system

- Premium dark infrastructure with editorial typography, strong negative space,
  asymmetric hero, fine dividers, sparse panels, and technical diagrams.
- Black = environment; warm white = information; orange = event/signal/state.
  Base `#0A0A0A`, warm white `#F5F3EE`, surfaces around `#111214`, neutral gray,
  signal orange tuned to `#FF642D`, subtle orange glow only around signals.
- Required CSS radial-gradient dots, never a raster texture. Stronger local dots
  in the resilience diagram. The grid must not compete with text.
- Self-hosted **Geist Variable** and **Geist Mono Variable**, Latin WOFF2 only,
  two font files, `font-display: swap`. No font CDN or external runtime dependency.
- Working content width up to 1328px plus 56px desktop outer padding; 22px mobile
  gutters. Hero desktop roughly 72–83px; mobile roughly 40–66px, with a smaller
  fallback below 370px to preserve the first sentence on one line.
  Headings use tight leading/tracking; mono is reserved for annotations and state.
- Original observation ring with an interrupted arc and a white signal point,
  reused in header/footer, diagrams, and SVG favicon.
- Hero is genuine SVG with five state planes, labels, fine connectors, and a
  downward travelling signal: AGENT WORK, PAYMENT INITIATED, SETTLEMENT VERIFIED,
  STATE PERSISTED, CONTINUE WORKING. No raster hero.
- No stock/people photography, crypto/trading/game styling, generic AI globe or
  sphere, random 3D, WebGL, glass-card proliferation, rainbow gradients, or video.

## Motion and interaction

- Consistent `cubic-bezier(.16, 1, .3, 1)` easing. Restrained, smooth, no flashes,
  bounces, scroll hijacking, or per-word animation.
- IntersectionObserver reveals: 26px translate + opacity over 800ms, once on entry.
  Only offscreen sections are opted into hiding after the observer is available.
  Content is visible by default; cleanup/reduced motion restores it. The complete
  page is rendered into static HTML at build time, then hydrated by React. All
  public content and anchor destinations survive failed/disabled browser JS. A
  noscript notice explains replay controls and offers mobile navigation links.
- Primary orange and secondary outlined capsules share an asymmetric curved fill
  wipe toward warm white over 650ms, with subtle arrow movement. Keyboard focus
  triggers the same fill treatment and has an obvious outline.
- CSS state-axis pulse (7s), orbit (24s), and process pulses (5s per segment).
  Moving signals use transforms and opacity, not layout-property animation.
  Mobile pulses travel downward. Node hover and focus emphasize both node/segment.
- Ambient animation can be paused/resumed from the hero. It does not alter the
  illustrative replay, whose explicit controls manage its own playback.
- Ribbon consists of two equal-width, zero-gap groups, each at least one viewport
  wide; each word owns its trailing
  spacing, so translating the combined track -50% is seamless. 42s linear motion,
  transform only, edge mask, hover pause/resume. Duplicate group is aria-hidden.
- Replay is user-initiated, 1.25s between events, and reserves all row space to
  avoid layout shifts. Pause/resume and restart work. Reduced-motion users step
  explicitly through events with Next event instead of timed playback.
- `prefers-reduced-motion` disables CSS animation, reveals, smooth scrolling and
  wipes; ribbon becomes a wrapping static wordmark list with only one copy.

## Responsive and accessibility expectations

Verify at 1440, 1024, 390, and intermediate widths. Desktop uses a split hero and
horizontal rail; mobile stacks the hero artwork and uses a genuinely vertical
connected process rail. Technology remains a legible vertical architecture, the
replay splits timestamp/source/message into readable rows, and audience panels
stack. Avoid horizontal page overflow and tiny diagram annotations.

Use semantic header/main/sections/footer, one H1, logical H2/H3, native buttons and
anchor links, skip link, visible focus, adequate contrast, and informative labels.
Mobile navigation closes on selection, Escape, outside click, focus departure, or
desktop resize. Escape returns focus to the menu trigger. Decorative SVGs are
aria-hidden; the state visual has a meaningful figure label. Only displayed replay
events enter the accessibility tree; status changes are polite. Do not advertise
WCAG certification without a comprehensive audit.

## Build, SEO, deployment and performance

- New app dependencies are isolated; no existing client/server importer changes.
  Root scripts: `dev:landing`, `build:landing`, `typecheck:landing`. Root typecheck
  retains server/client checks and appends the landing.
- A small `scripts/prerender.mjs` uses Vite's existing module loader and React's
  server renderer during the build. It writes the one page into `dist/index.html`
  and closes Vite. No runtime SSR server, extra framework, or dependency is added.
- Page title: “RoundWatch — Verifiable settlement for autonomous agents”.
  Description, canonical, viewport, theme color, SVG favicon, Open Graph,
  social title/description, robots.txt, sitemap.xml. No invented account/address
  or organization structured data. A social raster card is not part of this run.
- Static publish directory: **`apps/landing/dist`**. Repository-root build command:
  **`corepack pnpm run build:landing`** (equivalent to `pnpm run build:landing`
  when the correct pnpm shim is active). `netlify.toml` pins Node 24 and pnpm 12.3.4.
  Build base stays at repository root. No secrets or environment variables needed.
- No router or catch-all rewrite: all destinations are same-page anchors.
  No deployment, domain setup, or repository visibility change is authorized.
- No heavy UI or animation libraries; CSS/SVG, native APIs, and small React state.
  No continuous JavaScript animation loops. Two local font requests only.

Implementation references, checked against primary docs:
- Vite static output and local preview: <https://vite.dev/guide/static-deploy.html>
- Vite module loading and prerendering: <https://vite.dev/guide/ssr.html>
- Netlify config: <https://docs.netlify.com/build/configure-builds/file-based-configuration/>

## Completion checks

Run landing typecheck, production build, root typecheck, and the inexpensive existing
server tests. Inspect browser rendering and interactions, then the final Git diff.
Preserve the reference, exclude dist/node_modules/secrets/runtime data, and commit
the coherent implementation. Detailed observed results belong in `VALIDATION.md`.
