// Builds the static GitHub Pages mirror into ./site.
//
//   node scripts/build-static.mjs
//
// 1. Copies public/ to site/.
// 2. Bundles src/static-entry.ts (the real Worker handler, no Anthropic key, Qloo fixtures) for the
//    browser as site/js/server.bundle.js.
// 3. Adds site/js/static-shim.js, which answers fetch("/api/...") in the page by calling that handler,
//    and loads it before app.js. app.js itself is unchanged, so the mirror behaves exactly like a
//    Worker deployed without secrets: the recorded sample works end to end; custom runs explain that
//    live mode needs the hosted Worker.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site");

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "public"), OUT, { recursive: true });

const result = await build({
  entryPoints: [path.join(ROOT, "src/static-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "none",
  outfile: path.join(OUT, "js/server.bundle.js"),
  metafile: true,
  logLevel: "warning",
});
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0);

const SHIM = `// Static mirror only: answers the app's /api/* requests inside the page with the bundled Worker handler.
const API = /\\/api\\/(health|plan|city|pitch|run)$/;
const realFetch = window.fetch.bind(window);
let handlerPromise = null;
const handler = () => (handlerPromise ??= import("./server.bundle.js").then((m) => m.handle));

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url, location.href);
  const match = url.origin === location.origin && url.pathname.match(API);
  if (!match) return realFetch(input, init);
  if (match[1] === "health") {
    return new Response(JSON.stringify({ ok: true, qloo: "demo", model: "claude-opus-5-5", claude: false, recorded: true, static: true }), {
      headers: { "content-type": "application/json" },
    });
  }
  const signal = init?.signal;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const request = new Request(new URL("/api/" + match[1] + url.search, location.origin), init);
  const response = await (await handler())(request);
  if (response.status === 503) {
    return new Response(
      JSON.stringify({ error: "This GitHub Pages mirror replays the recorded Hollow Pines run. Routing your own act runs the live agent, which lives on the hosted Worker." }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }
  if (!signal || !response.body) return response;
  // A real network fetch stops reading when its signal aborts; an in-page Response does not, so
  // cancel the body ourselves. Otherwise "Skip ahead" would leave the slow replay running.
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      if (signal.aborted) return controller.error(new DOMException("Aborted", "AbortError"));
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  signal.addEventListener("abort", () => reader.cancel().catch(() => {}), { once: true });
  return new Response(body, { status: response.status, headers: response.headers });
};
handler(); // start loading the bundle right away
`;
fs.writeFileSync(path.join(OUT, "js/static-shim.js"), SHIM);

const indexPath = path.join(OUT, "index.html");
let html = fs.readFileSync(indexPath, "utf8");
const appTag = '<script type="module" src="js/app.js"></script>';
if (!html.includes(appTag)) throw new Error("index.html no longer loads js/app.js the expected way; update build-static.mjs");
html = html.replace(appTag, `<script type="module" src="js/static-shim.js"></script>\n  ${appTag}`);
fs.writeFileSync(indexPath, html);
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

console.log(`static mirror built in site/ (server bundle ${(bytes / 1024).toFixed(0)} KB)`);
