const ROUNDWATCH_SITE_URL = 'https://roundwatch.observer';
const ROUNDWATCH_ICON_URL = `${ROUNDWATCH_SITE_URL}/favicon.svg`;
const ROUNDWATCH_OG_IMAGE_URL = `${ROUNDWATCH_SITE_URL}/roundwatch-og.jpg`;
const ROUNDWATCH_TITLE = 'RoundWatch — Algorand x402 Payment Monitoring API';
const ROUNDWATCH_DESCRIPTION =
   'Durable payment monitoring for one exact future Algorand USDC payment, with verified on-chain evidence.';

export function merchantIdentityHtml(): string {
   const structuredData = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebAPI',
      name: 'RoundWatch',
      url: `${ROUNDWATCH_SITE_URL}/`,
      description: ROUNDWATCH_DESCRIPTION,
      documentation: `${ROUNDWATCH_SITE_URL}/start`,
      provider: {
         '@type': 'Organization',
         name: 'RoundWatch',
         url: `${ROUNDWATCH_SITE_URL}/`,
      },
   });

   return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="application-name" content="RoundWatch" />
    <meta name="description" content="${ROUNDWATCH_DESCRIPTION}" />
    <link rel="canonical" href="${ROUNDWATCH_SITE_URL}/" />
    <link rel="icon" type="image/svg+xml" href="${ROUNDWATCH_ICON_URL}" />
    <link rel="alternate" type="application/json" href="/openapi.json" title="RoundWatch OpenAPI" />
    <link rel="alternate" type="text/plain" href="/llms.txt" title="RoundWatch LLM instructions" />
    <title>${ROUNDWATCH_TITLE}</title>
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="RoundWatch" />
    <meta property="og:url" content="${ROUNDWATCH_SITE_URL}/" />
    <meta property="og:title" content="${ROUNDWATCH_TITLE}" />
    <meta property="og:description" content="${ROUNDWATCH_DESCRIPTION}" />
    <meta property="og:image" content="${ROUNDWATCH_OG_IMAGE_URL}" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="RoundWatch payment monitoring API" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${ROUNDWATCH_TITLE}" />
    <meta name="twitter:description" content="${ROUNDWATCH_DESCRIPTION}" />
    <meta name="twitter:image" content="${ROUNDWATCH_OG_IMAGE_URL}" />
    <script type="application/ld+json">${structuredData}</script>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #090b0d; color: #f3f4f6; }
      main { width: min(680px, calc(100% - 40px)); padding: 40px; border: 1px solid #252a31; border-radius: 18px; background: #101318; }
      .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 28px; font-weight: 700; letter-spacing: .02em; }
      .brand img { width: 34px; height: 34px; }
      h1 { margin: 0 0 16px; font-size: clamp(2rem, 7vw, 4rem); line-height: .98; letter-spacing: -.05em; }
      p { margin: 0; max-width: 58ch; color: #b8c0ca; line-height: 1.65; }
      nav { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
      a { color: #f3f4f6; text-underline-offset: 4px; }
      .meta { margin-top: 30px; color: #7f8996; font: 12px/1.6 ui-monospace, SFMono-Regular, Consolas, monospace; }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <img src="${ROUNDWATCH_ICON_URL}" alt="" />
        <span>RoundWatch</span>
      </div>
      <h1>RoundWatch API</h1>
      <p>${ROUNDWATCH_DESCRIPTION}</p>
      <nav aria-label="RoundWatch links">
        <a href="${ROUNDWATCH_SITE_URL}/">Product</a>
        <a href="${ROUNDWATCH_SITE_URL}/start">Quickstart</a>
        <a href="${ROUNDWATCH_SITE_URL}/algorand-payment-monitoring-api">Technical guide</a>
        <a href="/openapi.json">OpenAPI</a>
        <a href="/llms.txt">LLMs</a>
      </nav>
      <div class="meta">Algorand · USDC · x402 · durable payment monitoring</div>
    </main>
  </body>
</html>`;
}
