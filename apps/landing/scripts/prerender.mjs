import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
  appType: "custom",
});

const routes = [
  {
    path: "/",
    output: "dist/index.html",
    title: "RoundWatch — Algorand x402 Payment Monitoring API",
    description:
      "Monitor one exact future Algorand USDC payment with a durable x402 API. RoundWatch persists the watch and returns verified on-chain transaction evidence.",
    canonical: "https://roundwatch.observer/",
  },
  {
    path: "/start",
    output: "dist/start/index.html",
    title: "RoundWatch Quickstart — Algorand x402 Payment Monitoring API",
    description:
      "Integrate RoundWatch on Algorand MainNet: create a durable watch for one exact future USDC payment, settle the x402 fee, and retrieve verified evidence.",
    canonical: "https://roundwatch.observer/start",
  },
  {
    path: "/impressum",
    output: "dist/impressum/index.html",
    title: "Impressum — RoundWatch",
    description: "Legal notice for RoundWatch.",
    canonical: "https://roundwatch.observer/impressum",
  },
  {
    path: "/privacy",
    output: "dist/privacy/index.html",
    title: "Datenschutz — RoundWatch",
    description: "Privacy information for RoundWatch.",
    canonical: "https://roundwatch.observer/privacy",
  },
];

function withMetadata(document, route) {
  return document
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${route.title}</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
      `<meta name="description" content="${route.description}" />`,
    )
    .replace(
      /<link rel="canonical" href="[^"]*"\s*\/?>/,
      `<link rel="canonical" href="${route.canonical}" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*"\s*\/?>/,
      `<meta property="og:url" content="${route.canonical}" />`,
    )
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:title" content="${route.title}" />`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/?>/,
      `<meta property="og:description" content="${route.description}" />`,
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/?>/,
      `<meta name="twitter:title" content="${route.title}" />`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/?>/,
      `<meta name="twitter:description" content="${route.description}" />`,
    );
}

try {
  const { default: RootApp } = await vite.ssrLoadModule("/src/RootApp.tsx");
  const template = await readFile("dist/index.html", "utf8");
  const outlet = '<div id="root"></div>';
  if (!template.includes(outlet)) throw new Error("Missing static HTML outlet");

  for (const route of routes) {
    const html = renderToString(createElement(RootApp, { path: route.path }));
    const document = withMetadata(
      template.replace(outlet, () => `<div id="root">${html}</div>`),
      route,
    );
    await mkdir(dirname(route.output), { recursive: true });
    await writeFile(route.output, document);
    console.log(
      `Prerendered ${route.path}: ${Buffer.byteLength(html)} bytes of public HTML.`,
    );
  }
} finally {
  await vite.close();
}
