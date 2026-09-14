# Landing run 1 — validation

Date: 2026-09-14. Branch: `feat/roundwatch-landing`.

## Engineering checks

Executed from the repository root, using Node **24.14.0** and pnpm **12.3.4**:

| Command | Result |
| --- | --- |
| `corepack pnpm --version` | 12.3.4; the plain system shim was 11.19.0, so Corepack was used throughout installation/builds |
| `corepack pnpm install` | Passed; only landing dependencies added, existing client/server dependency entries preserved |
| `corepack pnpm run typecheck:landing` | Passed |
| `corepack pnpm run build:landing` | Passed: TypeScript, Vite production build, then static HTML rendering |
| `corepack pnpm run typecheck` | Passed for server, client, and landing |
| `corepack pnpm -C apps/server test` | 3 passed, 0 failed; settlement activation, persistence/restart/later matching, exact Indexer matching |
| `corepack pnpm -C apps/landing run preview --port 4387 --strictPort` | Served the production artifact for browser QA |
| `git diff --check` | Passed |

Prettier 3.8.1 was run through `corepack pnpm dlx` on new landing source files;
it was not added as a project dependency. An initial nonexistent font CSS import
was corrected to explicit local Latin WOFF2 faces. All final build checks pass.
The server tests retain the existing Node `node:sqlite` experimental warning.
No live payment, wallet, facilitator, or backend process was needed for this run.

Final build: JavaScript **247.32 kB / 76.22 kB gzip**, CSS **33.18 kB / 7.99 kB
gzip**, two fonts **52.53 kB** combined. The prerendered HTML is **32,081 bytes /
6,525 bytes gzip**. There is no animation framework, UI kit, raster hero, external
font request, or continuous JavaScript animation loop.

## Browser QA

Inspected the production build in the Codex Chromium browser. Screenshots were
viewed during iteration, not just generated. Saved evidence:

- [1440px hero](qa/desktop-1440.png)
- [Full desktop page](qa/desktop-full.png)
- [1024px hero](qa/tablet-1024.png)
- [390px hero](qa/mobile-390.png)
- [390px demo](qa/mobile-demo.png)

The screenshot tool includes a desktop scrollbar even at mobile dimensions.
Layout measurements therefore use `documentElement.clientWidth` as the available
width (e.g. 375px for a 390px viewport with a 15px scrollbar).

Verified:

- Desktop hero balance, stack geometry, dotted grid, proof strip, open product
  composition, process rail, technology diagram, replay terminal, restart
  timeline, audience panels, ribbon, challenge story, CTA, and footer.
- 1024px layout preserves the split hero. 390px layout uses a stacked hero,
  vertical process rail, vertical architecture, readable event rows and stacked
  audience panels. Key text/layout elements fit at 320, 390, 768, 1024, 1440 and
  1920px; page scroll width does not exceed available width after fixes.
- All anchor destinations exist. Header/menu/footer/hero links navigate to the
  actual sections. One H1, ten sections, no duplicate IDs.
- Selecting a flow node updates its pressed state and the boundary explanation.
  Hover/focus highlights node and rail segment. Signals move rightward on desktop
  and downward on mobile using transforms.
- Primary and secondary keyboard-focus fills were visually checked, including
  dark text over the filled light surface and the visible orange outline.
  The secondary text uses difference blending to preserve contrast during the wipe.
- Mobile menu opens/closes, Escape returns focus to its trigger, and Tab after
  opening reaches Product first. Selecting an anchor closes the disclosure.
- Replay starts at event 1, reveals subsequent lines, pauses, resumes, finishes
  at event 6 and can restart. Replay row space is reserved throughout playback.
- Global motion pause reports all seven ambient animations paused; resume restores
  playback. Ribbon hover pauses the track. Two equal groups implement the loop;
  each group is at least the viewport width, including 1920px. Duplicate content
  is hidden from assistive technology; edge masks remain in normal motion mode.
- Every section reveal completes after scrolling the page; no hidden sections
  remain. Final browser logs contain no errors or warnings, including hydration.

Visual fixes made during QA: button fill peeking into the resting state, small
mobile stack annotations, menu keyboard order, narrow-screen heading fit, 320px
overflow, wide-screen ribbon coverage, and a low-contrast decorative index.

## JavaScript failure and reduced motion

Two temporary local HTML fixtures were generated inside ignored `dist`, inspected
in the browser, and removed by a clean production rebuild. They are not published
or committed:

1. **Absent JavaScript bundle:** the rendered HTML had zero scripts. All ten
   sections, the H1, and all six replay events remained visible, with no reveal
   classes hiding content. This tests a failed bundle independently of `<noscript>`.
2. **Reduced preference:** an isolated fixture forced the reduced-motion CSS
   media branch and supplied a matching preference before React hydration. All
   seven ambient animations reported `none`, scrolling was `auto`, the duplicate
   ribbon group was `display: none`, and the single wordmark list was static.
   Replay displayed Next event, remained at event 2 between checks, and advanced
   only on explicit input. Completing event 6 moved focus to Replay workflow.

The preference test used a page-local fixture because this browser tool does not
expose native media emulation. It did not change the user's operating-system
settings. This is functional/visual QA in Chromium, not a claimed cross-browser
certification or exhaustive accessibility audit.

## Product and repository review

The public claims map to `docs/ROUNDWATCH_SPIKE.md` and the inspected deterministic
activation/store/poller/Indexer code. TestNet/prototype qualifiers are visible.
The demo explicitly says WORKFLOW REPLAY and explains that it is illustrative.
No invented transaction IDs, balances, runtime Astra events, fake live labels,
public GitHub links, forms, or dead signup destinations were added.

The full page is statically rendered by a small Vite/React build script, then
hydrated by React. The initial render matches the static HTML; reduced-motion
CSS applies before hydration. No production rendering server is required.

Existing client/server code and the approved reference image remain unchanged.
No `.env`, credentials, runtime data, `dist`, `node_modules`, npm lockfile or yarn
lockfile is included. Both bundled fonts' OFL licenses are copied into the public
artifact. The repository remains private; no push, merge, deployment, domain,
or DNS operation was performed.

## Review and deployment

Run `corepack pnpm run dev:landing`, or build and preview using the commands above.
Check the page with keyboard navigation and the OS reduced-motion preference on
the reviewer's target browser/device as part of the independent polish pass.

Netlify: keep build base at the repository root; use
`corepack pnpm run build:landing`; publish **`apps/landing/dist`**. `netlify.toml`
sets Node 24 and pnpm 12.3.4. No application environment variables are required.
Deployment is intentionally deferred until review.

There are no known blocking landing issues. Existing backend production risks
(especially settlement/persistence crash reconciliation) remain documented in
the spike and the landing specification; this static website does not solve them.
