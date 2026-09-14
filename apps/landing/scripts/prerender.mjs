import { readFile, writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createServer } from "vite";

// Render the one public page during the build. There is no deployed SSR server.
const vite = await createServer({
  server: { middlewareMode: true, hmr: false, watch: null, ws: false },
  appType: "custom",
});

try {
  const { default: App } = await vite.ssrLoadModule("/src/App.tsx");
  const template = await readFile("dist/index.html", "utf8");
  const outlet = '<div id="root"></div>';
  if (!template.includes(outlet)) throw new Error("Missing static HTML outlet");
  const html = renderToString(createElement(App));
  await writeFile("dist/index.html", template.replace(outlet, () => `<div id="root">${html}</div>`));
  console.log(`Prerendered RoundWatch: ${Buffer.byteLength(html)} bytes of public HTML.`);
} finally {
  await vite.close();
}
