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
    title: "RoundWatch — Verifiable settlement for autonomous agents",
    canonical: "https://roundwatch.observer/",
  },
  {
    path: "/impressum",
    output: "dist/impressum/index.html",
    title: "Impressum — RoundWatch",
    canonical: "https://roundwatch.observer/impressum",
  },
  {
    path: "/privacy",
    output: "dist/privacy/index.html",
    title: "Datenschutz — RoundWatch",
    canonical: "https://roundwatch.observer/privacy",
  },
];

function withMetadata(document, route) {
  return document
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${route.title}</title>`)
    .replace(
      /<link rel="canonical" href="[^"]*"\s*\/?>/,
      `<link rel="canonical" href="${route.canonical}" />`,
    )
    .replace(
      /<meta property="og:url" content="[^"]*"\s*\/?>/,
      `<meta property="og:url" content="${route.canonical}" />`,
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
