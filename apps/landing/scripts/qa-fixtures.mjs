import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run manually after the final build. Generated fixtures stay in ignored dist;
// this script is never part of the production build or deployment command.
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const html = await readFile(resolve(dist, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)];
if (scripts.length !== 1 || !/type="module"/.test(scripts[0][0])) {
  throw new Error(
    "Expected one built module script; inspect the build before creating fixtures.",
  );
}
const moduleScript = scripts[0][0];
const stylesheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)];
if (!stylesheets.length) throw new Error("No built stylesheet found.");

function fixture(source, label) {
  return source
    .replace("<title>", `<title>[LOCAL QA: ${label}] `)
    .replace(
      "</head>",
      '<meta name="robots" content="noindex, nofollow">\n</head>',
    );
}

function reducedPreference() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    const media = original(query);
    if (query !== "(prefers-reduced-motion: reduce)") return media;
    return new Proxy(media, {
      get(target, property) {
        if (property === "matches") return true;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
}

function motionDiagnostics() {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) return;
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const output = document.getElementById("qa-results");
      const started = performance.now();
      const results = {
        fixture:
          "Local read-only diagnostics; 90-second sampling window, not a performance benchmark",
        complete: false,
        elapsedMs: 0,
        replayHistory: [],
        resilienceHistory: [],
        motionHistory: [],
        animations: [],
        orbitalHistory: [],
        recentFrameGapsMs: [],
        frameCount: 0,
        maxVisibleFrameGapMs: 0,
        gapsOver50Ms: 0,
      };
      const previous = new Map();
      const identifiers = new WeakMap();
      let nextIdentifier = 1;
      let previousFrame = 0;
      let frame = 0;
      const elapsed = () => Math.round(performance.now() - started);
      function history(key, value) {
        const serialized = JSON.stringify(value);
        if (previous.get(key) === serialized) return;
        previous.set(key, serialized);
        results[key].push({ atMs: elapsed(), ...value });
        if (results[key].length > 180) results[key].shift();
      }
      function attributes(selector, names) {
        const element = document.querySelector(selector);
        return Object.fromEntries(
          names.map((name) => [
            name,
            element?.getAttribute(`data-${name}`) ?? null,
          ]),
        );
      }
      function state() {
        history(
          "replayHistory",
          attributes("[data-replay-state]", ["replay-state", "replay-running"]),
        );
        history(
          "resilienceHistory",
          attributes("[data-story-phase]", [
            "story-phase",
            "story-started",
            "story-running",
          ]),
        );
        history("motionHistory", {
          ...attributes(".site", ["paused"]),
          visibility: document.visibilityState,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        });
        results.elapsedMs = elapsed();
        output.textContent = JSON.stringify(results);
      }
      function animations() {
        results.animations = document.getAnimations().map((animation) => {
          if (!identifiers.has(animation))
            identifiers.set(animation, nextIdentifier++);
          const target = animation.effect?.target;
          return {
            id: identifiers.get(animation),
            name: animation.animationName ?? "Web Animation",
            target:
              target?.getAttribute?.("class") ?? target?.tagName ?? "unknown",
            playState: animation.playState,
            playbackRate: Number(animation.playbackRate.toFixed(3)),
            currentTime:
              typeof animation.currentTime === "number"
                ? Math.round(animation.currentTime)
                : null,
          };
        });
        const orbitals = results.animations
          .filter((item) => item.target.includes("orbital-signal"))
          .map(({ id, playState, playbackRate }) => ({
            id,
            playState,
            playbackRate,
          }));
        history("orbitalHistory", { orbitals });
        state();
      }
      function sampleFrame(time) {
        if (!document.hidden && previousFrame) {
          const gap = Number((time - previousFrame).toFixed(2));
          results.recentFrameGapsMs.push(gap);
          if (results.recentFrameGapsMs.length > 240)
            results.recentFrameGapsMs.shift();
          results.frameCount++;
          results.maxVisibleFrameGapMs = Math.max(
            results.maxVisibleFrameGapMs,
            gap,
          );
          if (gap > 50) results.gapsOver50Ms++;
        }
        previousFrame = document.hidden ? 0 : time;
        frame = requestAnimationFrame(sampleFrame);
      }
      const observer = new MutationObserver(state);
      observer.observe(document.documentElement, {
        subtree: true,
        attributes: true,
        attributeFilter: [
          "data-replay-state",
          "data-replay-running",
          "data-story-phase",
          "data-story-started",
          "data-story-running",
          "data-paused",
        ],
      });
      const visibility = () => {
        previousFrame = 0;
        state();
      };
      document.addEventListener("visibilitychange", visibility);
      const timer = setInterval(animations, 300);
      frame = requestAnimationFrame(sampleFrame);
      function stop() {
        observer.disconnect();
        clearInterval(timer);
        clearTimeout(expiration);
        cancelAnimationFrame(frame);
        document.removeEventListener("visibilitychange", visibility);
        window.removeEventListener("pagehide", stop);
        results.complete = true;
        animations();
      }
      const expiration = setTimeout(stop, 90000);
      window.addEventListener("pagehide", stop, { once: true });
      animations();
    },
    { once: true },
  );
}

let reduced = html;
let conditions = 0;
for (const [index, [tag]] of stylesheets.entries()) {
  const asset = tag.match(/href="(\/assets\/[A-Za-z0-9_.-]+\.css)"/)?.[1];
  if (!asset) throw new Error("Unexpected built stylesheet path.");
  const css = await readFile(resolve(dist, `.${asset}`), "utf8");
  const simulated = css.replace(/\(prefers-reduced-motion:\s*reduce\)/g, () => {
    conditions++;
    return "(min-width:0px)";
  });
  const copy = `/assets/qa-reduced-${index}.css`;
  await writeFile(resolve(dist, `.${copy}`), simulated);
  reduced = reduced.replace(tag, tag.replace(asset, copy));
}
if (!conditions)
  throw new Error("No reduced-motion CSS conditions found; inspect the build.");

await writeFile(
  resolve(dist, "qa-reduced.js"),
  `(${reducedPreference.toString()})();\n`,
);
await writeFile(
  resolve(dist, "qa-motion.js"),
  `(${motionDiagnostics.toString()})();\n`,
);
await writeFile(
  resolve(dist, "qa-nojs.html"),
  fixture(html.replace(moduleScript, ""), "module removed"),
);
await writeFile(
  resolve(dist, "qa-reduced.html"),
  fixture(
    reduced.replace(
      moduleScript,
      `<script src="/qa-reduced.js"></script>\n${moduleScript}`,
    ),
    "synthetic reduced motion",
  ),
);
await writeFile(
  resolve(dist, "qa-motion.html"),
  fixture(
    html
      .replace(
        moduleScript,
        `<script src="/qa-motion.js"></script>\n${moduleScript}`,
      )
      .replace(
        "</body>",
        '<output id="qa-results" hidden aria-hidden="true"></output>\n</body>',
      ),
    "read-only motion diagnostics",
  ),
);
console.log(
  `Generated local QA fixtures in ignored dist; forced ${conditions} reduced-motion CSS conditions.`,
);
