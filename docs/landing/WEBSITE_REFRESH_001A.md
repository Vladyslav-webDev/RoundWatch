# Website Refresh 001A review handoff

The prepared worktree at `C:\Dev\x402-audit-website-001` was clean on `feat/roundwatch-website-refresh-001` at `b78cffa3ec3c15bf1d5ff5a65bd495561e06f0fb`. Both the local tracking refs and `git ls-remote` matched the requested landing baseline and production `main` at `8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5`.

## Changed files

| File | Change |
| --- | --- |
| `apps/landing/src/App.tsx` | Updated flow, operating contract, release evidence and CTAs. Made Quickstart the primary hero and closing action. |
| `apps/landing/src/Quickstart.tsx` | Updated canonical offer, caller-owned watch inputs, signed admission, settlement, free recovery and result retrieval. |
| `apps/landing/src/AlgorandPaymentMonitoring.tsx` | Corrected discovery and matching guidance, the sample body, recovery and CTA copy. |
| `apps/landing/src/VideoShowcase.tsx` | Labeled the existing recording as a legacy MainNet demonstration in visible and accessible copy. |
| `apps/landing/src/WorkflowReplay.tsx` | Retained the six-event replay and relabeled it as an illustration of the canonical TestNet flow. |
| `apps/landing/src/Resilience.tsx` | Identified the redeploy evidence as historical MainNet proof. |
| `docs/landing/DEMO_002_STORYBOARD.md` | Added the recorded TestNet evidence sequence and required recording assets. |
| `docs/landing/WEBSITE_REFRESH_001A.md` | Recorded sources, validation, and the independent review checklist. |

## Contract and evidence review

- The offer uses x402 v2 with official SDK `2.29.0`, `exact`, `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k`, Circle USDC ASA `31566704`, and `100000` atomic units (`0.10 USDC`). The service payer signs the fee to `payTo`. The watched transfer has its own sender, receiver and amount. [Network IDs](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/algorand-networks.ts) · [Production SDK dependencies](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/package.json#L25-L30) · [MainNet client safety constants](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/client/mainnet-safety.ts) · [Circle USDC assets](https://developers.circle.com/stablecoins/usdc-contract-addresses)
- An unsigned `402` advertises the offer and Bazaar inputs before semantic validation or paid readiness. Check the resource, terms and body before local signing. The signed path checks readiness and validates the body, verifies the payment, rechecks readiness and prepares durable state before settling. Confirmation supplies the activation round. Save the ID for free status lookup. [Signed admission](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/app.ts#L849-L1056) · [Preparation before settlement](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/app.ts#L1205-L1357)
- Generate a key per watch and keep it with the exact specification for the same service payer. The production handler rejects the literal discovery key and note placeholders on new paid requests. If a response is lost, use free recovery with the same specification and public `servicePayer`. Eligibility starts at durable preparation. A match must confirm after the activation round with a block timestamp before the 30-minute deadline. The work budget is 500 units. [Caller inputs and eligibility](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/roundwatch-contract.ts) · [Policy constants](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/app.ts#L84-L88) · [Recovery and status](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/apps/server/app.ts#L1360-L1440)
- The September MainNet canary paid for a watch and matched a distinct transfer on an earlier build. The supplied November release evidence records a canonical paid TestNet watch and match, plus MainNet health, readiness and unsigned canonical `402` smoke checks. The pinned API implementation verifies the contract. The production README and deployment guide describe the earlier qualification state. [September paid canary](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/docs/POST_REPRICE_CANARY_2026-09-29.md) · [Pre-run qualification note](https://github.com/Vladyslav-webDev/RoundWatch/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/README.md#L223)

## Local validation

- `pnpm install --frozen-lockfile`, `pnpm run typecheck:landing`, `pnpm run build:landing` and `git diff --check` passed with Node `24.14.0` and pnpm `12.3.4`. All five routes prerendered.
- Inspected `/`, `/start` and `/algorand-payment-monitoring-api` in Chromium at 1440 × 1000 and 390 × 900. Each rendered one H1 with the route title, canonical URL, and Open Graph URL. Both sizes had zero document-level horizontal overflow. Long mobile code samples scroll within their own blocks. The three routes had no console warnings or errors in the route-aware preview.
- Verified the hero Quickstart link, guide anchor, keyboard Flow selection, mobile Menu → Product tab order, and Escape focus return. In the browser’s reduced-motion mode the page had no pending reveals and the replay exposed all six events. The video loaded its 78-second duration and displayed the existing poster and controls under the legacy label.
- The default Vite preview returned the home document for clean subroutes, causing hydration warnings there. For the final browser pass, the loopback preview mapped the exact subroutes to their prerendered `index.html` and applied the headers from `netlify.toml`. This was local Chromium QA. Live Netlify behavior and normal-motion playback timing were outside that browser pass.

## Independent review

1. Inspect the diff against the landing baseline, including both new documents. Recheck that the two demo binaries have their baseline Git blob hashes. Confirm the hero and closing CTA lead with Quickstart and the legacy video remains reachable.
2. Compare the three public pages with the pinned source above. Pay particular attention to offer versus paid admission, service payer and recipient versus the watched parties, and durable preparation before settlement. Read the examples without sending payment requests.
3. Rebuild and serve `apps/landing/dist` with clean URLs resolving to their route `index.html`. Check the H1, metadata and static body on each route. Repeat keyboard, mobile navigation, media and reduced-motion checks. Compare the evidence labels with the [Demo 002 storyboard](DEMO_002_STORYBOARD.md).

## Remaining evidence

The release brief reports the November TestNet and MainNet smoke results. The raw TestNet captures and MainNet smoke logs are absent from the pinned source, and the TestNet Indexer lookup was unavailable during this pass. Attach the redacted originals and confirm the two public transaction records before recording Demo 002. A paid MainNet end-to-end run on this release has yet to be performed. There is no confirmed independent paying customer.
