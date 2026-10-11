// Captures the README / Devpost gallery screenshots by driving headless Chrome over the DevTools
// protocol (no extra dependencies: Node's built-in WebSocket and fetch).
//
//   node scripts/screenshots.mjs [url]        default: https://rachelselbrede.github.io/next-town/
//   CHROME=/path/to/chrome node scripts/screenshots.mjs
//
// Writes docs/screenshots/*.png.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const URL_ = process.argv[2] || "https://rachelselbrede.github.io/next-town/";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "nt-shots-"));
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });

async function cdpTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await cdpTarget());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.value;

async function viewport(width, height, mobile = false) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile });
}

async function shot(name, { fullHeight } = {}) {
  const params = { format: "png", captureBeyondViewport: Boolean(fullHeight) };
  if (fullHeight) {
    const width = await evaluate("document.documentElement.clientWidth");
    params.clip = { x: 0, y: 0, width, height: fullHeight, scale: 1 };
  }
  const { data } = await send("Page.captureScreenshot", params);
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log("saved", name);
}

const click = (pattern, scope = "document") =>
  evaluate(`(() => { const b = [...${scope}.querySelectorAll('button, a')].find((x) => ${pattern}.test(x.textContent)); if (b) b.click(); return Boolean(b); })()`);

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });

// 1. Landing
await viewport(1440, 900);
await send("Page.navigate", { url: URL_ });
await sleep(3000);
await evaluate("localStorage.clear()");
await send("Page.navigate", { url: URL_ });
await sleep(3000);
await shot("1-landing");

// 2. Route, after skipping the replay to the finished loop
await click("/try it with hollow pines/i");
await sleep(2500);
await click("/skip ahead/i");
await sleep(5000);
await evaluate("window.scrollTo(0, 0)");
await sleep(2500);
await shot("2-route");

// 3. Obvious route vs. your route
await evaluate(`(() => { const t = document.getElementById('obvious-switch'); if (t) t.click(); return Boolean(t); })()`);
await sleep(2500);
await shot("3-obvious-route");
await evaluate(`(() => { const t = document.getElementById('obvious-switch'); if (t) t.click(); return Boolean(t); })()`);

// 4. A playbook (Asheville, the #1 market)
await evaluate(`(() => { const s = [...document.querySelectorAll('.stop')].find((x) => /Asheville/.test(x.textContent)); const b = s && [...s.querySelectorAll('button')].find((x) => /open playbook/i.test(x.textContent)); if (b) b.click(); return Boolean(b); })()`);
await sleep(3000);
await evaluate("window.scrollTo(0, 0)");
await sleep(800);
await shot("4-playbook", { fullHeight: 2000 });

// 5. Receipts drawer
await click("/^\\s*Receipts/");
await sleep(1500);
await shot("5-receipts");
await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /close receipts/i.test(x.getAttribute('aria-label') || x.textContent)); if (b) b.click(); })()`);
await sleep(800);

// 6. Tour sheet
await click("/back to route/i");
await sleep(1500);
await click("/build my tour/i");
await sleep(9000);
await evaluate("window.scrollTo(0, 0)");
await sleep(800);
await shot("6-tour", { fullHeight: 1500 });

// 7. Phone
await viewport(390, 844, true);
await click("/back to route/i");
await sleep(2500);
await evaluate("document.querySelector('#map')?.scrollIntoView({ block: 'center' })");
await sleep(2500);
await shot("7-phone-route");

ws.close();
chrome.kill();
await new Promise((r) => chrome.once("exit", r));
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  /* Chrome can still be flushing its profile; the OS temp dir will clean it up. */
}
