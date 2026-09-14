# RoundWatch Ultra pass — validation

Date: 2026-09-15. Branch: `feat/roundwatch-landing`.
Approved baseline: `bdf3629fea9140fb24a64d7adc04adddbcffda76`, tag
`landing-v1-before-ultra`. This report supersedes the motion behavior described
in the run 1 specification; the approved visual system remains the baseline.

## Baseline preservation

Read AGENTS.md, README, the observer spike, landing specification, reference image,
landing source and Netlify configuration before editing. Inspected the deployed
page in Chromium before implementation and compared its desktop/mobile composition
with the local production build. Three bounded review tracks covered motion,
accessibility/responsiveness/performance, and brand/deployment hardening.

Palette, font families, type scale, H1, section headings/order/numbering, audiences,
buttons, dotted field, hero planes and curved leads remain intact. The only
responsive geometry fix removes a small headline/first-SVG-label collision at
761–900px. The mobile state stack was already visible and was preserved.
The inspector metadata and ribbon relationship labels are the requested additions.
The no-JavaScript notice now mentions interactive diagrams as well as replay.

## Implemented behavior

- **Orbital Charge:** header, footer and the architecture's RoundWatch identity
  use a fixed ring and an orange orbiting point. Native Web Animations maintain
  rotation phase: 10 seconds per idle revolution, capped at 0.9 revolutions/second.
  One shared temporary requestAnimationFrame loop eases velocity, trail, ring
  warmth and glow; it ends once velocity settles. A restrained 3.2-second pulse
  gains opacity near full charge. Each instance has independent input/state and
  stops when offscreen, the document is hidden, motion is paused or reduced.
  All listeners, native animations, observers and pending frames clean up.
- **Hero:** five staggered pulses follow the existing curved leads, briefly
  emphasize their axis junctions and precede one unified downward continuation.
  Ten-second cycle, fixed small signal count, no particle system.
- **Product:** native buttons inside the existing H3s make each whole row an
  inspection target. Observe emphasizes acquisition/crosshair, Verify moves the
  signal inward, Persist resolves it into the durable center. Touch selection
  remains visible. Supporting text remains available in every state.
- **Flow:** existing four buttons and rail remain; selection emphasizes the rail
  and reveals stage/status/boundary/next metadata with the original explanation.
  A stable grid reserves the tallest panel's height. Inactive text hides before
  the incoming text fades in, avoiding an overlapping crossfade.
- **Technology:** existing stages and continuation have native inspection
  buttons, adjacent connector emphasis and related-capability emphasis. Inactive
  opacity is limited to 0.94 to preserve small subtitle contrast (approximately
  4.66:1 against the dark panel). The separate future reasoning note is unchanged.
- **Replay:** first meaningful entry plays once, shows all six existing events
  sequentially, evolves Waiting/Payment/Detected/Verified/Persisted/Ready, and
  ends. Explicit Replay restarts; Pause/Resume preserves remaining step time.
  Offscreen/global/hidden-document suspension preserves progress. Under global
  pause, Show all events provides a static reading option; Replay also shows
  completion immediately. User interaction takes precedence over autoplay.
- **Resilience:** first meaningful entry plays expected → saved → offline →
  starting → restored → resumed → matched once. The process rail fades at the
  stop while the durable bridge remains; recovery reconnects progress. All
  timeline labels remain readable throughout.
- **Audiences/ribbon:** audiences gain border/rail emphasis on hover and keyboard
  focus without links or movement of the panels. The 42-second ribbon retains
  equal repeated groups, edge fade and hover pause. Text identities carry precise
  relationship labels; the duplicate remains hidden from assistive technology.

## Browser QA

Tested the production build in the Codex Chromium browser at
`http://localhost:4173`, with the exact headers parsed from `netlify.toml`.
Screenshots were actually viewed during inspection, including a complete desktop
composition and individual mobile sections. No screenshot assets were added to
the repository. No production deployment was used for testing the new code.

| Viewport    | Observed result                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1440 × 1000 | Approved split hero and full section composition retained; Product, Flow, Technology, replay and restart inspected with active/focus states                    |
| 1024 × 900  | Split hero and all five planes remain visible; horizontal Flow, architecture and replay terminal fit                                                           |
| 820 × 1000  | Fixed the original approximately 5px H1/SVG-label overlap; final measured gap is 14.75px                                                                       |
| 390 × 900   | Full five-plane stack retained (331 × 340px SVG); Product, vertical Flow/inspector, architecture, replay, restart, audiences, ribbon, CTA and footer inspected |

The browser reserves a 15px scrollbar. Corresponding document client widths and
scroll widths matched at 1425, 1009, 805 and 375px: no horizontal page overflow.
No measured heading, panel, inspector, terminal or footer escaped those bounds.

Specific interaction checks:

- Header brand focus accelerates progressively. Diagnostic native animation rate
  reached 8.737 (0.8737 rev/s) at 5.1s; after blur it decayed to 1.384
  (0.1384 rev/s). Native currentTime advanced from 33,391ms to 54,622ms across
  this interval, confirming phase was preserved instead of resetting. Subsequent
  resting style returned to orange with zero trail/glow. Other marks remained
  independently paused at idle rate when offscreen.
- Product Verify/Persist, all Flow choices and architecture inspection respond
  to native keyboard Enter/Tab and pointer selection. Pressed states, selected
  explanation and capability emphasis match. All anchors target real sections.
- Mobile Menu opens, Tab reaches Product first, Escape closes and returns focus
  to Menu, and choosing a section closes the disclosure. Focus outlines were
  visually inspected on identity links, Product rows, Flow nodes, architecture,
  audiences and footer links.
- Global pause reports every `.ambient` animation paused; native orbital
  animations also report paused. Pending section reveals are removed.
- Replay completes automatically and stays complete on return to the section.
  Explicit pause held at 00 events; resume advanced; leaving the viewport held
  at 01 events across separate checks. Global pause and Show all events worked.
- Read-only diagnostics recorded every restart phase in order, ending with
  `story-running=false`; replay likewise ended with `replay-running=false`.
- Ribbon groups measured identically (1089.03125px each at mobile); duration was
  42s and pointer inspection paused the track. Reduced motion shows five static
  wordmarks in one wrapping group.
- No console warnings/errors, hydration failures or CSP violations were reported
  in the production or reduced-motion pages. No obvious animation jank was seen.
  Local diagnostic frame samples showed no gaps over 50ms during the observed
  interval; this virtual-browser sample is not a hardware performance benchmark.

## Reduced motion and JavaScript fallback

The browser API does not expose native media emulation. The reproducible
`qa-fixtures.mjs` generator creates **local synthetic fixtures** inside ignored
`dist`: one forces the reduced CSS conditions plus the same matchMedia value
before hydration; another removes the JavaScript module entirely. The underlying
production bundle and CSP remain unchanged. This checks the actual branches in a
real browser without claiming an OS-level preference test.

Reduced fixture results: all ambient CSS animation names were `none`; all three
orbital marks were stopped; all six replay events were visible before and after
Replay; resilience was matched; smooth scrolling was off; no hidden reveals
remained; the duplicate ribbon group had `display:none`. The static mobile ribbon
fit without overflow. No micro-duration animation workaround remains.

No-module fixture: zero scripts, one H1, ten main sections, all six replay events
and no hidden sections. The complete public content and anchor destinations remain
available. Automatic replay announces only completion; explicit replay uses a
polite status. Decorative SVGs and duplicate ribbon text stay out of the
accessibility tree. This is focused Chromium QA, not a full screen-reader or
cross-browser accessibility certification.

## Validation commands

Commands executed from the repository root with repository-pinned pnpm 12.3.4:

| Command                                                | Result                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `corepack pnpm run build:landing`                      | Passed TypeScript, Vite production build and static prerender                                |
| `corepack pnpm run typecheck`                          | Passed server, client and landing                                                            |
| `corepack pnpm -C apps/server test`                    | 3 passed, 0 failed; existing SQLite experimental warning only                                |
| `node --check apps/landing/scripts/preview-secure.mjs` | Passed                                                                                       |
| `node --check apps/landing/scripts/qa-fixtures.mjs`    | Passed                                                                                       |
| `node apps/landing/scripts/preview-secure.mjs`         | Served final build with Netlify headers; 13 HTTP transport/security cases passed             |
| `node apps/landing/scripts/qa-fixtures.mjs`            | Generated no-JS, reduced and diagnostics fixtures; scripts/HTTP/CSP/ignore integrity checked |
| `corepack pnpm dlx prettier@3.8.1 --write …`           | Formatted changed/new source without adding a dependency                                     |
| `git diff --check`                                     | Passed                                                                                       |

Final assets: JavaScript **257.06kB / 79.14kB gzip**, CSS **43.82kB / 10.02kB gzip**;
fonts unchanged at **52.53kB** combined. Prerendered application HTML:
**37,714 bytes**. Versus v1, compressed JavaScript adds about 2.92kB. No framework,
animation dependency, tracker, external font, API call or backend behavior was added.

See [hardening details and primary sources](ULTRA_HARDENING.md) for the header
policy, its inline-style requirement, and local preview/fixture reproduction.

## Product truth and remaining human work

All claims retain the Algorand TestNet prototype boundary and the replay disclaimer.
No MainNet volume, public live activity, customers, invented transactions/balances,
or runtime Astra verification was introduced. Astra remains development tooling
outside the deterministic chain. The existing spike's production limitations
remain unchanged and are not solved by this landing pass.

Verified legal operator/contact details are unavailable; human assessment and
real details are required before creating any applicable Impressum/privacy page.
No placeholder legal pages were invented. Final social/gallery/video assets remain
the separately planned human pass. Future production header delivery needs a
post-deploy check after human review; this run performs no deployment.

Only landing source, local QA/preview tooling, this report, hardening notes and
Netlify static headers belong to the commit. The baseline tag and reference image,
payment applications, lockfile and dependencies are unchanged. Generated `dist`
fixtures are removed by the final clean production build. No secrets, environment
files, runtime data or unrelated changes are included. One local commit; no push,
merge, branch switch, history rewrite, DNS, Cloudflare or Product Hunt operation.
