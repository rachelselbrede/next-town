// Runs the same fetch handler as the Cloudflare Worker, but under Node, so local development can
// use your Anthropic credentials from the environment or an `ant auth login` profile.
// Static files are served from ./public the way the Worker's ASSETS binding would.
//
//   npm run dev            -> http://localhost:8787
//   PORT=9000 npm run dev

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = Number(portArg ? portArg.slice(7) : process.env.PORT || 8787);
const PUBLIC = path.resolve(HERE, "../public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC)) return new Response("forbidden", { status: 403 });
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      // Single-page fallback.
      const index = path.join(PUBLIC, "index.html");
      if (!fs.existsSync(index)) return new Response("not found", { status: 404 });
      file = index;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    return new Response(fs.readFileSync(file), { headers: { "content-type": type, "cache-control": "no-cache" } });
  },
};

const env = {
  ASSETS,
  MODEL: process.env.MODEL || "claude-opus-5-5",
  QLOO_MODE: process.env.QLOO_MODE || "auto",
  QLOO_API_KEY: process.env.QLOO_API_KEY,
  QLOO_BASE_URL: process.env.QLOO_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  DEV: "1",
};

const worker = (await import("../src/index.ts")).default;

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://localhost:${PORT}${req.url}`;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : Readable.toWeb(req);
    const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: "half" });
    const response = await worker.fetch(request, env, { waitUntil() {}, passThroughOnException() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) return res.end();
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}  (model ${env.MODEL}, qloo ${env.QLOO_API_KEY ? "live" : "demo"})`);
});
