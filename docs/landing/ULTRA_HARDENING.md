# Ultra pass: static deployment hardening

## Scope and policy

`netlify.toml` supplies one `/*` header rule for the static landing. The CSP permits
same-origin JavaScript, stylesheets, fonts, images and connections; it blocks
inline script execution, external resources, embedded objects, framing, base-URL
overrides and form submission. No trackers, embeds, forms or browser API calls
were added. The browser Permissions Policy disables camera, microphone and
geolocation access, which this page does not use. `nosniff` protects resource MIME
types, and `strict-origin-when-cross-origin` limits cross-origin referrer detail.

Style attributes remain allowed for prerendered delay/progress values and
lightweight animation variables. `style-src-elem 'self'` restricts style blocks
and stylesheet sources in browsers supporting that directive. Same-origin
`connect-src` also accommodates Vite's module-preload fetch fallback. Script
execution has no `unsafe-inline` or `unsafe-eval` exception. No HSTS, domain,
hosting account, deployment or DNS setting was changed.

The ecosystem retains text names instead of unverified proprietary logo assets.
The OpenAI relationship is use of GPT-6 Astra in development; it is not an
endorsement or a settlement-verification runtime step. TestNet and illustrative
replay boundaries remain the product truth.

## Local production validation

From the repository root, build and launch:

```powershell
corepack pnpm run build:landing
node apps/landing/scripts/preview-secure.mjs
```

Open `http://localhost:4173`. This dependency-free Node preview serves only the
built `apps/landing/dist` directory and reads the same header values from
`netlify.toml`; no policy values are duplicated. Its narrow parser supports the
one wildcard rule with single-line quoted values and fails if that format changes
or CSP is absent. Requests are limited to GET/HEAD, filesystem paths and real
symlink targets remain inside `dist`, MIME types are explicit, and responses are
not cached. It has no application backend and binds only to loopback.

Check document and asset response headers, CSP/browser console errors, successful
font/CSS/script loading, interactions and all target viewport sizes. Inspect both
paused and reduced-motion states. A plain Vite preview does not apply Netlify's
headers. Local checks validate the production bundle and policy together; they do
not establish that a future deployed response has these headers. Actual browser
results belong in the final Ultra validation report.

Local transport checks on 2026-09-15 passed: `node --check` accepted the preview
script, and 13 HTTP cases covered the document, favicon, all four built assets,
HEAD, unsupported methods, missing files, encoded traversal, backslashes, null
bytes and dotfiles. Every response carried the exact CSP read from Netlify;
successful assets had the expected MIME types. These are server/transport checks,
not a substitute for the browser validation above.

### Local browser fixtures

After the final production build, optionally run:

```powershell
node apps/landing/scripts/qa-fixtures.mjs
```

This local-only generator reads the built HTML/CSS and writes ignored `dist`
fixtures; it is not called by build/deployment scripts. The normal build clears
these files. The secure preview serves them with the unchanged production CSP:

- `/qa-nojs.html` removes the application module and retains all prerendered
  content. It tests the no-hydration fallback, not a browser's native JS-disable
  setting.
- `/qa-reduced.html` keeps the production bundle, loads an external loopback-only
  script before hydration to report the exact reduced-motion media query as true,
  and uses CSS copies whose reduced-motion conditions match all widths. This is
  **synthetic emulation**, not a native OS/browser preference test. Other media
  queries and the original production assets remain unchanged.
- `/qa-motion.html` keeps the production bundle and adds an external read-only
  diagnostic script. It records replay/resilience data-attribute changes, global
  motion state, native animation play states/rates, orbital rate history and
  visible-frame gaps as JSON in hidden `output#qa-results`. Sampling ends after
  90 seconds or page exit; reload to start another sample. The script never
  scrolls, focuses, selects, pauses, resumes or makes network requests. Its own
  measurement overhead means the frame samples are diagnostics, not a benchmark.

Fixture titles and noindex metadata identify their QA purpose. Regenerate them
after every build being inspected; do not run the generator during deployment.

## Hosting injection check

An anonymous HTTPS read of `https://roundwatch.observer/` on 2026-09-15 contained
one script: the same-origin built module `/assets/index-BRj5U5S8.js`. No inline
script or Netlify badge injection was present in that response. No badge loader is
present in the repository build. This observation cannot rule out session-specific
hosting/UI injection.

Netlify documents its Drawer for Deploy Previews and enabled branch deploys.
It also documents that restrictive CSP can prevent the Drawer from appearing.
The proposed production policy does not allow its external frame or an injected
inline loader. If preview collaboration UI is later required, assess a scoped
preview policy with the human; do not weaken this production policy or change
hosting settings solely to accommodate a badge. No deployment changes were made.

## Remaining human information

No verified operator identity, address or contact details were supplied for legal
pages. Whether an Impressum/privacy notice is required and its correct contents
need human assessment. This pass does not invent legal details, placeholder pages
or claims about the host's own data processing.

## Primary sources checked

- [Netlify custom headers](https://docs.netlify.com/manage/routing/headers/)
- [Content Security Policy Level 3](https://www.w3.org/TR/CSP3/)
- [Permissions Policy](https://www.w3.org/TR/permissions-policy/)
- [Referrer Policy](https://www.w3.org/TR/referrer-policy/)
- [OpenAI design and trademark guidelines](https://openai.com/brand/)
- [Netlify Deploy Previews](https://docs.netlify.com/deploy/deploy-types/deploy-previews/)
- [Netlify Drawer CSP troubleshooting](https://docs.netlify.com/deploy/review-deploys/netlify-drawer-for-feedback/troubleshoot-the-netlify-drawer/)
