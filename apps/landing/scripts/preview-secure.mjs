import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  validateHeaderName,
  validateHeaderValue,
} from "node:http";
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(scriptDirectory, "../../..");
const root = await realpath(resolve(scriptDirectory, "../dist"));
const configuration = await readFile(
  resolve(repository, "netlify.toml"),
  "utf8",
);

// Deliberately parse only this repository's one wildcard header rule and its
// single-line quoted values. Fail closed if that format changes; a general TOML
// dependency is unnecessary for this local-only production-build preview.
const rules = configuration.split(/^\s*\[\[headers\]\]\s*$/m).slice(1);
if (rules.length !== 1)
  throw new Error("Expected one Netlify wildcard header rule.");
const headers = {};
let wildcard = false;
let values = false;
for (const line of rules[0].split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  if (!values && trimmed === 'for = "/*"') {
    wildcard = true;
    continue;
  }
  if (wildcard && !values && trimmed === "[headers.values]") {
    values = true;
    continue;
  }
  const match =
    values &&
    trimmed.match(/^([A-Za-z][A-Za-z0-9-]*)\s*=\s*("(?:[^"\\]|\\.)*")$/);
  if (!match) throw new Error("Unsupported Netlify header configuration.");
  const [, name, quotedValue] = match;
  const value = JSON.parse(quotedValue);
  validateHeaderName(name);
  validateHeaderValue(name, value);
  if (Object.hasOwn(headers, name))
    throw new Error(`Duplicate header: ${name}`);
  headers[name] = value;
}
if (!headers["Content-Security-Policy"]?.trim()) {
  throw new Error(
    "Missing Netlify Content-Security-Policy; refusing an unprotected preview.",
  );
}
await stat(resolve(root, "index.html"));

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function insideRoot(path) {
  const remainder = relative(root, path);
  return (
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

const server = createServer(async (request, response) => {
  for (const [name, value] of Object.entries(headers))
    response.setHeader(name, value);
  response.setHeader("Cache-Control", "no-store");

  function reject(status, message) {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(request.method === "HEAD" ? undefined : message);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    reject(405, "Method not allowed");
    return;
  }

  let pathname;
  try {
    if (!request.url?.startsWith("/") || request.url.startsWith("//"))
      throw new Error();
    pathname = decodeURIComponent(
      new URL(request.url, "http://127.0.0.1:4173").pathname,
    );
    if (
      /[\\:\0]/.test(pathname) ||
      pathname.split("/").some((part) => part.startsWith("."))
    ) {
      throw new Error();
    }
  } catch {
    reject(400, "Invalid path");
    return;
  }

  try {
    const requested = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!insideRoot(requested)) {
      reject(403, "Forbidden");
      return;
    }
    // Check real paths as well so a symlink cannot expose files outside dist.
    const path = await realpath(requested);
    if (!insideRoot(path) || !(await stat(path)).isFile()) {
      reject(404, "Not found");
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type":
        types[extname(path).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    reject(
      error.code === "ENOENT" || error.code === "ENOTDIR" ? 404 : 500,
      "File unavailable",
    );
  }
});

server.on("error", (error) => {
  console.error(`Secure preview failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close());
}
server.listen(4173, "127.0.0.1", () => {
  console.log(
    "RoundWatch production preview: http://localhost:4173 (Netlify headers applied)",
  );
});
