// Records the Hollow Pines sample so judges get a deterministic replay with no Anthropic key involved.
//
//   node scripts/record.mjs                 (or: npm run record)
//   node scripts/record.mjs --dry-run       show what would run and where it would write; calls nothing
//   node scripts/record.mjs --no-fixtures   even with QLOO_API_KEY set, leave fixtures/qloo alone
//   node scripts/record.mjs --module-only   rebuild src/recorded.generated.ts from the files already recorded; calls nothing
//
// It drives the real Worker handler (src/index.ts) in-process under Node, the way scripts/dev-node.mjs
// does, with recorded:false so the real agent runs. No HTTP server is involved: each step is one
// worker.fetch(new Request(...)) whose SSE body is read back here.
//   1. POST /api/plan   -> <scenarios dir>/plan.jsonl   every SSE event except "open", one JSON per line
//   2. POST /api/city   -> city-<slug>.json for every route stop and every scenario playbookCity (the playbook payload)
//   3. POST /api/pitch  -> pitch.json
//   4. regenerates src/recorded.generated.ts: the plan events inlined, the city files and pitch as static JSON
//      imports (the same trick scripts/bundle-fixtures.mjs uses), so the Worker bundle carries the recording
//   5. with QLOO_API_KEY set: writes every live Qloo response this run made to private/qloo/*.json
//      (_handAuthored:false, _captured:<ISO date>) with its own index.json, then re-bundles with
//      scripts/bundle-fixtures.mjs (which overlays private/qloo on the public placeholders)
//
// DATA RULE (Qloo FAQ: "Do not store Qloo response data in a public repository"). Where things go:
//   without QLOO_API_KEY   fixtures/scenarios/hollow-pines/   the public recording, made against the
//                                                             hand-authored placeholders; committed
//   with QLOO_API_KEY      private/scenarios/hollow-pines/    the recording made against live Qloo
//                          private/qloo/                      the live responses themselves
//                          both gitignored; NEVER commit private/, never build the public mirror from it
//   always                 src/recorded.generated.ts          gitignored build artifact
//
// Claude comes from ANTHROPIC_API_KEY or an `ant auth login` profile (DEV=1 lets the SDK look for one).
// Qloo is live with QLOO_API_KEY, otherwise the agent answers from the bundled fixtures. A run spends real
// Claude tokens (one agent run, one structured-output call per city, one pitch call), so tests never run it.
// Safe to re-run: every output is overwritten, stale city files are removed, the private index is re-keyed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalUrl, idList, slug } from "../src/canonical.ts";

// The Worker handler (src/index.ts) imports the generated modules this script rebuilds, so it is
// loaded lazily in main(), only for a real run or --dry-run. --module-only must work even when
// src/recorded.generated.ts is stale or points at files that no longer exist (e.g. private/ removed).
let worker;

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_ID = "hollow-pines";
const SCENARIO_PATH = path.join(ROOT, "data", "scenarios", `${SCENARIO_ID}.json`);
const TAGS_PATH = path.join(ROOT, "data", "tags.json");
const GENERATED_PATH = path.join(ROOT, "src", "recorded.generated.ts");
const BUNDLE_SCRIPT = path.join(ROOT, "scripts", "bundle-fixtures.mjs");

// Public (committed) and private (gitignored) homes for a recording and for Qloo responses.
export const PUBLIC_OUT_DIR = path.join(ROOT, "fixtures", "scenarios", SCENARIO_ID);
export const PRIVATE_OUT_DIR = path.join(ROOT, "private", "scenarios", SCENARIO_ID);
export const PUBLIC_FIXTURE_DIR = path.join(ROOT, "fixtures", "qloo");
export const PRIVATE_FIXTURE_DIR = path.join(ROOT, "private", "qloo");
const PRIVATE_DIR = path.join(ROOT, "private");

// Place tag ids per group (data/tags.json), used to name a capture after the promo group it asked for.
const TAG_GROUPS = fs.existsSync(TAGS_PATH) ? readJsonFile(TAGS_PATH).groups ?? {} : {};

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The handler is called in-process, so the host name is only cosmetic.
const ORIGIN = "http://next-town.local";

// Params that carry comp ids. When the live ids differ from the scenario placeholders, these are
// what gets swapped to find the fixture a request corresponds to.
const ID_LIST_PARAMS = ["signal.interests.entities", "filter.exclude.entities"];

const USAGE = `Usage: node scripts/record.mjs [--dry-run] [--no-fixtures] [--module-only]`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const rel = (file) => path.relative(process.cwd(), file) || ".";
const sameCity = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const kb = (file) => `${Math.round(fs.statSync(file).size / 1024)} KB`;

function parseArgs(argv) {
  const opts = { dryRun: false, fixtures: true, moduleOnly: false, help: false, error: "" };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-fixtures") opts.fixtures = false;
    else if (a === "--module-only") opts.moduleOnly = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.error = `Unknown option ${a}`;
  }
  return opts;
}

// Same env the Node dev server builds, minus a real static-file handler (the API never touches it).
const ASSETS = {
  async fetch() {
    return new Response("record.mjs serves no static files", { status: 404 });
  },
};
const CTX = { waitUntil() {}, passThroughOnException() {} };

function makeEnv() {
  return {
    ASSETS,
    MODEL: process.env.MODEL || "claude-opus-5-5",
    QLOO_MODE: process.env.QLOO_MODE || "auto",
    QLOO_API_KEY: process.env.QLOO_API_KEY,
    QLOO_BASE_URL: process.env.QLOO_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEV: "1",
  };
}

// Every QlooClient the handler creates shares this prototype, so wrapping get() here collects the
// calls log across all requests of the run. Installed by main(), never on import. Every argument
// (path, params, abort signal) is forwarded untouched.
function captureQlooCalls(QlooClient) {
  const log = [];
  const original = QlooClient.prototype.get;
  QlooClient.prototype.get = async function loggedGet(...args) {
    const result = await original.apply(this, args);
    log.push(result);
    return result;
  };
  return log;
}

// A directory counts as holding a recording when its plan.jsonl exists.
export function hasRecording(dir) {
  return fs.existsSync(path.join(dir, "plan.jsonl"));
}

// The recording folder src/recorded.generated.ts should be built from: the private one when a live
// recording exists there, else the public placeholder recording.
export function recordingSource() {
  return hasRecording(PRIVATE_OUT_DIR) ? { dir: PRIVATE_OUT_DIR, name: "private" } : { dir: PUBLIC_OUT_DIR, name: "public" };
}

// ---------------------------------------------------------------------------
// Talking to the handler
// ---------------------------------------------------------------------------

async function post(env, pathname, body) {
  const request = new Request(ORIGIN + pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return worker.fetch(request, env, CTX);
}

// Parses a text/event-stream body into { type, data } pairs. Mirrors public/js/stream.js.
export async function* readSse(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const event = parseSseFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const last = buffer.trim() ? parseSseFrame(buffer) : null;
  if (last) yield last;
}

function parseSseFrame(frame) {
  let type = "message";
  const data = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) type = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (!data.length) return null;
  const text = data.join("\n");
  try {
    return { type, data: JSON.parse(text) };
  } catch {
    return { type, data: text };
  }
}

// Reads a whole SSE response, dropping the "open" handshake, and fails on an "error" event.
async function collectStream(response, onEvent) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const events = [];
  for await (const { type, data } of readSse(response)) {
    if (type === "open") continue;
    events.push(data);
    onEvent?.(data);
  }
  const failure = events.find((e) => e?.type === "error");
  if (failure) throw new Error(failure.message || "the stream reported an error");
  return events;
}

// Prints the agent's run as it streams: turns, tool calls, narration, the route.
function planProgress() {
  let midLine = false;
  const endLine = () => {
    if (midLine) process.stdout.write("\n");
    midLine = false;
  };
  return (e) => {
    switch (e?.type) {
      case "turn":
        endLine();
        console.log(`  turn ${e.n}`);
        break;
      case "text":
        if (!midLine) process.stdout.write("  | ");
        process.stdout.write(String(e.delta).replace(/\n+/g, " "));
        midLine = true;
        break;
      case "tool_call":
        endLine();
        console.log(`  -> ${e.name} ${JSON.stringify(e.input)}`);
        break;
      case "tool_result":
        endLine();
        console.log(`  <- ${e.name}: ${e.summary} (${e.ms} ms)`);
        break;
      case "receipt":
        endLine();
        console.log(`     qloo ${e.receipt.mode} HTTP ${e.receipt.status} ${e.receipt.tool}: ${e.receipt.resultCount} results`);
        break;
      case "route":
        endLine();
        console.log(`  route: ${e.route.stops.map((s) => s.label).join(" -> ")} (${e.route.driveDays} drive days, ${Math.round(e.route.totalMiles)} miles)`);
        break;
      case "done":
        endLine();
        console.log(`  done after ${e.turns} turns (${e.usage?.input ?? "?"} in / ${e.usage?.output ?? "?"} out tokens)`);
        break;
      case "error":
        endLine();
        console.log(`  error: ${e.message}`);
        break;
      default:
        break; // meta, thinking, comps, markets, status
    }
  };
}

// ---------------------------------------------------------------------------
// src/recorded.generated.ts
// ---------------------------------------------------------------------------

// Import specifier from src/ to a recording folder (a module path, so always forward slashes).
const importPrefixFor = (dir) => "../" + path.relative(ROOT, dir).split(path.sep).join("/") + "/";

// Everything the renderer needs, read from the recording folder: the plan events, the city slugs
// (from the city-<slug>.json file names, sorted) and whether a pitch exists. Empty when nothing is recorded.
export function readRecording(dir = recordingSource().dir) {
  const planPath = path.join(dir, "plan.jsonl");
  const planEvents = fs.existsSync(planPath)
    ? fs
        .readFileSync(planPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];
  const citySlugs = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .map((f) => /^city-(.+)\.json$/.exec(f)?.[1])
        .filter(Boolean)
        .sort()
    : [];
  const hasPitch = fs.existsSync(path.join(dir, "pitch.json"));
  const recordedAt = fs.existsSync(planPath) ? fs.statSync(planPath).mtime.toISOString() : null;
  return { planEvents, citySlugs, hasPitch, recordedAt, dir };
}

// Renders src/recorded.generated.ts. The plan events are inlined one per line (JSON Lines cannot be
// imported); each city file and the pitch become a static JSON import, so the module stays small and
// the JSON files remain the source of truth. With nothing recorded it renders the empty placeholder.
export function renderRecordedModule({ planEvents = [], citySlugs = [], hasPitch = false, recordedAt = null, dir = PUBLIC_OUT_DIR } = {}) {
  const head = "// GENERATED FILE. Do not edit by hand; run `npm run prepare:data` (or `npm run record`) instead. Gitignored build artifact.\n//";
  const IMPORT_PREFIX = importPrefixFor(dir);
  if (planEvents.length === 0) {
    return `${head}
// scripts/record.mjs runs the Hollow Pines scenario through the real handler and writes
// fixtures/scenarios/${SCENARIO_ID}/plan.jsonl, city-<slug>.json, and pitch.json (private/scenarios/
// when Qloo is live), then regenerates this module so the Worker bundle carries the recording with
// it. Until it has run, everything here is empty and src/recorded.ts reports RECORDED_AVAILABLE = false.

// Every event /api/plan streamed on the recorded run, in order (one per line of plan.jsonl).
export const planEvents: any[] = [];

// Full \`playbook\` event payloads keyed by city slug (e.g. "asheville-nc"), from city-<slug>.json.
export const playbooks: Record<string, any> = {};

// The Pitch from pitch.json, or null until recorded.
export const pitch: any = null;
`;
  }
  const slugs = [...citySlugs].sort();
  const identifier = (s) => `city_${s.replace(/[^A-Za-z0-9]+/g, "_")}`;
  const imports = slugs.map((s) => `import ${identifier(s)} from ${JSON.stringify(`${IMPORT_PREFIX}city-${s}.json`)} with { type: "json" };`);
  if (hasPitch) imports.push(`import pitchJson from ${JSON.stringify(`${IMPORT_PREFIX}pitch.json`)} with { type: "json" };`);
  return `${head}
// Recorded ${recordedAt} for the "${SCENARIO_ID}" scenario, from ${path.relative(ROOT, dir).split(path.sep).join("/")}/.
// The plan events are inlined from plan.jsonl (JSON Lines cannot be imported); the playbooks and
// pitch are static JSON imports so the Worker bundle carries the whole recording with it.

${imports.join("\n")}

// Every event /api/plan streamed on the recorded run, in order (one per line of plan.jsonl).
export const planEvents: any[] = [
${planEvents.map((e) => `  ${JSON.stringify(e)},`).join("\n")}
];

// Full \`playbook\` event payloads keyed by city slug (e.g. "asheville-nc"), from city-<slug>.json.
export const playbooks: Record<string, any> = {
${slugs.map((s) => `  ${JSON.stringify(s)}: ${identifier(s)},`).join("\n")}
};

// The Pitch from pitch.json${hasPitch ? "" : ", or null until recorded"}.
export const pitch: any = ${hasPitch ? "pitchJson" : "null"};
`;
}

// Writes the module from whatever is in the chosen recording folder right now (private first).
function writeRecordedModule(dir = recordingSource().dir) {
  const recording = readRecording(dir);
  fs.writeFileSync(GENERATED_PATH, renderRecordedModule(recording));
  console.log(`wrote ${rel(GENERATED_PATH)} from ${rel(dir)}/ (${kb(GENERATED_PATH)}: ${recording.planEvents.length} plan events, ${recording.citySlugs.length} playbook imports, pitch ${recording.hasPitch ? "imported" : "null"})`);
  return recording;
}

// ---------------------------------------------------------------------------
// private/qloo: write the live calls log as fixtures
// ---------------------------------------------------------------------------

// The promo group (record_store, coffee_shop, ...) whose tag ids a place query carries, or undefined
// for a venue-tag query (rooms, markets).
export function promoGroupFor(params, tagGroups = TAG_GROUPS) {
  const wanted = typeof params["filter.tags"] === "string" ? idList(params["filter.tags"].split(",")) : "";
  if (!wanted) return undefined;
  for (const group of Object.keys(tagGroups)) {
    const ids = tagGroups[group];
    if (Array.isArray(ids) && ids.length && idList(ids) === wanted && !["music_venue", "concert_hall", "live_music_bar", "comedy_club"].includes(group)) return group;
  }
  return undefined;
}

// Which agent tool issues a request, derived from its shape (same names as src/queries.ts).
export function toolFor(qpath, params, tagGroups = TAG_GROUPS) {
  if (qpath === "/search") return "resolve_act";
  if (qpath === "/v2/tags") return "find_tags";
  switch (params["filter.type"]) {
    case "urn:entity:place":
      if (params["diversify.by"] && !params["filter.location.query"]) return "rank_markets"; // nationwide, one venue per city
      return promoGroupFor(params, tagGroups) ? "find_promo_partners" : "find_rooms";
    case "urn:demographics":
      return "who_shows_up";
    case "urn:entity:brand":
    case "urn:entity:tv_show":
      return "local_color";
    case "urn:entity:artist":
      return "openers_to_ask";
    default:
      return "qloo";
  }
}

// The file name scripts/scaffold-fixtures.mjs would give this request, so live captures land under the
// same names the skeletons use: search-big-thief.json, markets-hollow-pines.json, demographics-overall.json,
// rooms-asheville-nc.json, promo-record-store-asheville-nc.json ...
export function fixtureFileFor(qpath, params, scenarioId = SCENARIO_ID, tagGroups = TAG_GROUPS) {
  if (qpath === "/search") return `search-${slug(String(params.query ?? "query"))}.json`;
  if (qpath === "/v2/tags") return `tags-${slug(String(params["filter.query"] ?? "query"))}.json`;
  const where = slug(String(params["filter.location.query"] ?? params["signal.location.query"] ?? ""));
  switch (params["filter.type"]) {
    case "urn:entity:place": {
      if (params["diversify.by"] && !params["filter.location.query"]) return `markets-${scenarioId}.json`;
      const group = promoGroupFor(params, tagGroups);
      return group ? `promo-${group.replace(/_/g, "-")}-${where}.json` : `rooms-${where}.json`;
    }
    case "urn:demographics":
      return where ? `demographics-${where}.json` : `demographics-overall.json`;
    case "urn:entity:brand":
      return `brands-${where}.json`;
    case "urn:entity:tv_show":
      return `tvshows-${where}.json`;
    case "urn:entity:artist":
      return `openers-${where}.json`;
    default: {
      const hash = crypto.createHash("sha1").update(canonicalUrl(qpath, params)).digest("hex").slice(0, 8);
      return `${slug(qpath) || "qloo"}-${hash}.json`;
    }
  }
}

// live comp id -> scenario placeholder id, matched by name. Empty when the ids already agree.
export function scenarioIdMap(scenarioComps, liveComps) {
  const map = new Map();
  for (const live of liveComps) {
    const match = scenarioComps.find((s) => sameCity(s.name, live.name));
    if (match && match.id !== live.id) map.set(live.id, match.id);
  }
  return map;
}

// The same params with live comp ids swapped for scenario placeholders (sorted, like idList does).
export function swapIds(params, idMap) {
  if (!idMap.size) return params;
  const out = { ...params };
  for (const key of ID_LIST_PARAMS) {
    if (typeof out[key] !== "string") continue;
    out[key] = idList(out[key].split(",").map((id) => idMap.get(id.trim()) ?? id.trim()));
  }
  return out;
}

// Finds the public placeholder file a live request corresponds to, so the private capture takes the
// same name: by its canonical URL, else by the URL it would have with the scenario's placeholder ids,
// else by the file name the scaffold would use, else a new file.
export function locateFixture(index, result, idMap, scenarioId = SCENARIO_ID, fixtureDir = PUBLIC_FIXTURE_DIR) {
  const canonical = canonicalUrl(result.path, result.params);
  if (index[canonical]) return { file: index[canonical], how: "canonical URL" };
  const swapped = canonicalUrl(result.path, swapIds(result.params, idMap));
  if (swapped !== canonical && index[swapped]) return { file: index[swapped], how: "comp-id substitution" };
  const derived = fixtureFileFor(result.path, result.params, scenarioId);
  if (Object.values(index).includes(derived) || fs.existsSync(path.join(fixtureDir, derived))) return { file: derived, how: "file name" };
  return { file: derived, how: "new file" };
}

// Writes every successful live response of the run to private/qloo (never fixtures/qloo), named after
// the public placeholder it corresponds to, with private/qloo/index.json keyed by the live canonical URLs.
function writePrivateFixtures(log, { scenario, liveComps, capturedAt }) {
  const publicIndexPath = path.join(PUBLIC_FIXTURE_DIR, "index.json");
  const publicIndex = fs.existsSync(publicIndexPath) ? readJson(publicIndexPath) : {};
  const privateIndexPath = path.join(PRIVATE_FIXTURE_DIR, "index.json");
  const index = fs.existsSync(privateIndexPath) ? readJson(privateIndexPath) : {};
  fs.mkdirSync(PRIVATE_FIXTURE_DIR, { recursive: true });
  const idMap = scenarioIdMap(scenario.comps, liveComps);
  const seen = new Set();
  const counts = {};
  let skipped = 0;

  for (const result of log) {
    if (result.mode !== "live" || result.cached) continue; // demo answers; cache hits repeat an answer already logged
    if (!result.ok || result.status !== 200) {
      skipped += 1;
      continue;
    }
    const canonical = canonicalUrl(result.path, result.params);
    if (seen.has(canonical)) continue; // the home city's local-color pair repeats for every playbook
    seen.add(canonical);

    const { file, how } = locateFixture(publicIndex, result, idMap, scenario.id);
    const target = path.join(PRIVATE_FIXTURE_DIR, file);
    const publicTwin = path.join(PUBLIC_FIXTURE_DIR, file);
    const previous = fs.existsSync(target) ? readJson(target) : fs.existsSync(publicTwin) ? readJson(publicTwin) : undefined;
    writeJson(target, {
      _handAuthored: false,
      _captured: capturedAt,
      tool: previous?.tool ?? toolFor(result.path, result.params),
      canonical,
      query: { path: result.path, params: result.params },
      response: result.body,
    });
    // One key per file: drop any stale key (old tag ids, placeholder comp ids) that pointed at it.
    for (const [key, value] of Object.entries(index)) if (value === file && key !== canonical) delete index[key];
    index[canonical] = file;
    counts[how] = (counts[how] ?? 0) + 1;
    console.log(`  ${how === "new file" ? "created" : "wrote"} private/qloo/${file}  (matched to the public placeholder by ${how})`);
  }
  writeJson(privateIndexPath, index);

  const summary = Object.entries(counts).map(([how, n]) => `${n} by ${how}`).join(", ");
  console.log(`  ${seen.size} live captures written to ${rel(PRIVATE_FIXTURE_DIR)}/ (${summary || "none"})${skipped ? `; ${skipped} failed live calls left alone` : ""}`);
  console.log(`  ${rel(PUBLIC_FIXTURE_DIR)}/ (the public placeholders) was not touched.`);
  if (idMap.size) {
    console.log(`  Live comp ids differ from data/scenarios/${scenario.id}.json; private captures are keyed by the live ids. Update the scenario "comps" to:`);
    console.log(JSON.stringify(liveComps, null, 2).replace(/^/gm, "    "));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.error) {
    console.log(opts.error ? `${opts.error}\n${USAGE}` : USAGE);
    return opts.error ? 2 : 0;
  }
  if (opts.moduleOnly) {
    const source = recordingSource();
    console.log(`--module-only: rebuilding ${rel(GENERATED_PATH)} from the ${source.name} recording in ${rel(source.dir)}/ without calling anything`);
    writeRecordedModule(source.dir);
    return 0;
  }

  const t0 = Date.now();
  const scenario = readJson(SCENARIO_PATH);
  const env = makeEnv();
  const home = scenario.request.home;

  // Load the handler now (see the note at the top): it needs the generated modules to exist.
  ({ default: worker } = await import("../src/index.ts"));
  const { QlooClient } = await import("../src/qloo.ts");

  const health = await (await worker.fetch(new Request(`${ORIGIN}/api/health`), env, CTX)).json();
  const live = health.qloo === "live";
  // Data rule: a recording made against live Qloo carries Qloo response data, so it goes to private/.
  const OUT_DIR = live ? PRIVATE_OUT_DIR : PUBLIC_OUT_DIR;
  console.log(`Recording "${scenario.act}" (${SCENARIO_ID}): model ${health.model}, Qloo ${health.qloo}, Claude via ${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "local profile"}`);
  console.log(`Output: ${rel(OUT_DIR)}/ (${live ? "PRIVATE: live Qloo data, gitignored" : "public placeholder recording, committed"}) and ${rel(GENERATED_PATH)}${live && opts.fixtures ? `, plus ${rel(PRIVATE_FIXTURE_DIR)}/*.json (PRIVATE live captures, gitignored)` : ""}`);
  if (live) console.log(`DATA RULE: nothing this run writes may be committed. private/ is gitignored; keep it that way and never build the public mirror from it.`);

  if (opts.dryRun) {
    console.log(`\n--dry-run: nothing called. The run would:`);
    console.log(`  1. POST /api/plan ${JSON.stringify({ ...scenario.request, scenarioId: SCENARIO_ID, recorded: false })}`);
    console.log(`     -> ${rel(path.join(OUT_DIR, "plan.jsonl"))}`);
    console.log(`  2. POST /api/city for every route stop plus: ${scenario.playbookCities.join(", ")}`);
    console.log(`     -> ${rel(OUT_DIR)}/city-<slug>.json`);
    console.log(`  3. POST /api/pitch -> ${rel(path.join(OUT_DIR, "pitch.json"))}`);
    console.log(`  4. regenerate ${rel(GENERATED_PATH)} from ${rel(OUT_DIR)}/ (plan events inlined, city files and pitch imported as JSON)`);
    console.log(live && opts.fixtures ? `  5. write the live responses to ${rel(PRIVATE_FIXTURE_DIR)}/*.json (+ index.json) and run scripts/bundle-fixtures.mjs` : `  5. (no Qloo fixtures written: ${live ? "--no-fixtures" : "no QLOO_API_KEY, answers come from the bundled fixtures"})`);
    return 0;
  }

  const qlooLog = captureQlooCalls(QlooClient);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. The plan: the agent resolves comps, ranks markets, routes, and narrates.
  console.log(`\n1. /api/plan`);
  const planResponse = await post(env, "/api/plan", { ...scenario.request, scenarioId: SCENARIO_ID, recorded: false });
  const planEvents = await collectStream(planResponse, planProgress());

  const comps = planEvents.filter((e) => e.type === "comps").at(-1)?.comps ?? [];
  const localities = planEvents.find((e) => e.type === "markets")?.localities ?? [];
  const routeEvent = planEvents.find((e) => e.type === "route");
  const done = planEvents.find((e) => e.type === "done");
  if (!routeEvent || !done) throw new Error("the plan stream ended without a route and a done event; nothing was written");
  if (!comps.length) throw new Error("the plan stream never emitted comps; nothing was written");
  const { route, obvious } = routeEvent;

  const planPath = path.join(OUT_DIR, "plan.jsonl");
  fs.writeFileSync(planPath, planEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const recordedAt = fs.statSync(planPath).mtime.toISOString(); // the module header and fixture _captured dates use this
  console.log(`  wrote ${rel(planPath)} (${planEvents.length} events, ${kb(planPath)})`);

  // 2. One playbook per route stop, plus the scenario's listed cities, so clicking any of them replays.
  const cities = [];
  for (const label of [...route.stops.map((s) => s.label), ...scenario.playbookCities]) {
    if (!cities.some((c) => sameCity(c, label))) cities.push(label);
  }
  console.log(`\n2. /api/city for ${cities.length} cities`);
  const playbooks = {};
  const written = new Set(); // city files from this run; any other city-*.json is a leftover from an older route
  for (const city of cities) {
    console.log(`  ${city}`);
    const locality = localities.find((l) => sameCity(l.label, city));
    const response = await post(env, "/api/city", { city, home, comps, ...(locality ? { locality } : {}), scenarioId: SCENARIO_ID, recorded: false });
    const events = await collectStream(response, (e) => {
      if (e.type === "status") console.log(`     ${e.message}`);
    });
    const playbook = events.find((e) => e.type === "playbook")?.playbook;
    if (!playbook) throw new Error(`no playbook event came back for ${city}`);
    const file = `city-${slug(city)}.json`;
    writeJson(path.join(OUT_DIR, file), playbook);
    written.add(file);
    playbooks[slug(city)] = playbook;
    const promoCount = playbook.promo.reduce((n, g) => n + g.places.length, 0);
    console.log(`     wrote ${file}: ${playbook.rooms.length} rooms, ${promoCount} promo partners, demographics ${playbook.who ? "yes" : "no"}, ${playbook.receipts.length} receipts`);
  }
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (!written.has(file) && /^city-.*\.json$/.test(file)) {
      fs.unlinkSync(path.join(OUT_DIR, file));
      console.log(`  removed stale ${file}`);
    }
  }

  // 3. The pitch, from the route and the playbooks in stop order (what the tour screen sends).
  console.log(`\n3. /api/pitch`);
  const pitchResponse = await post(env, "/api/pitch", {
    route,
    // Same slimming as public/js/app.js fetchPitch: headlines only, well under the 64 KB body cap.
    playbooks: route.stops
      .map((s) => playbooks[slug(s.label)])
      .filter(Boolean)
      .map((p) => ({
        city: p.city,
        rooms: (p.rooms || []).slice(0, 2).map((r) => ({ name: r.name })),
        promo: (p.promo || []).map((g) => ({ kind: g.kind, places: (g.places || []).slice(0, 1).map((x) => ({ name: x.name })) })),
        who: p.who ? { strongestAge: p.who.strongestAge } : null,
      })),
    comps,
    home,
    obvious,
    scenarioId: SCENARIO_ID,
    recorded: false,
  });
  if (!pitchResponse.ok) throw new Error(`/api/pitch failed: HTTP ${pitchResponse.status} ${(await pitchResponse.text()).slice(0, 300)}`);
  const pitch = await pitchResponse.json();
  const pitchPath = path.join(OUT_DIR, "pitch.json");
  writeJson(pitchPath, pitch);
  console.log(`  wrote ${rel(pitchPath)} (${pitch.text.split(/\s+/).length} words, ${pitch.itinerary.length} itinerary rows)`);

  // 4. The module the Worker bundles, built from the files just written. A live recording in private/
  //    takes precedence over the public one; a public (placeholder) recording is only used when no
  //    private one exists, so say which.
  console.log(`\n4. src/recorded.generated.ts`);
  const source = recordingSource();
  if (source.dir !== OUT_DIR) console.log(`  NOTE: a ${source.name} recording exists in ${rel(source.dir)}/ and takes precedence; the module is built from it, not from this run's ${rel(OUT_DIR)}/.`);
  writeRecordedModule(source.dir);

  // 5. Qloo responses: live ones are captured privately; in demo mode, report any fixture gaps instead.
  console.log(`\n5. Qloo responses`);
  const liveCalls = qlooLog.filter((r) => r.mode === "live");
  const misses = qlooLog.filter((r) => r.mode === "demo" && !r.ok);
  if (liveCalls.length && opts.fixtures) {
    writePrivateFixtures(qlooLog, { scenario, liveComps: comps, capturedAt: recordedAt });
    console.log(`  bundling with ${rel(BUNDLE_SCRIPT)} (public placeholders with the private captures overlaid)`);
    execFileSync(process.execPath, [BUNDLE_SCRIPT], { cwd: ROOT, stdio: "inherit" });
  } else if (liveCalls.length) {
    console.log(`  --no-fixtures: ${liveCalls.length} live Qloo responses not saved`);
  } else {
    console.log(`  demo mode: ${qlooLog.length} Qloo requests answered from fixtures, ${misses.length} with no fixture; ${rel(PUBLIC_FIXTURE_DIR)}/ untouched`);
    if (misses.length) {
      console.log(`  WARN these requests had no fixture and were served empty; add their cities to playbookCities in ${rel(SCENARIO_PATH)} and run \`npm run prepare:data\`:`);
      for (const url of new Set(misses.map((r) => r.url))) console.log(`    ${url}`);
    }
  }

  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s: ${planEvents.length} plan events, ${cities.length} playbooks, pitch. The agent closed with:`);
  console.log(`  ${String(done.text).trim().replace(/\s+/g, " ")}`);
  console.log(`\nWhere things went:`);
  console.log(`  recording      ${rel(OUT_DIR)}/  (${live ? "PRIVATE, gitignored" : "public, commit it"})`);
  if (liveCalls.length && opts.fixtures) console.log(`  Qloo captures  ${rel(PRIVATE_FIXTURE_DIR)}/  (PRIVATE, gitignored)`);
  console.log(`  modules        ${rel(GENERATED_PATH)}, src/demo/fixtures.generated.ts  (build artifacts, gitignored; \`npm run prepare:data\` rebuilds them)`);
  if (live) {
    console.log(`\nDATA RULE: Qloo asks that response data never be stored in a public repository. Everything this run wrote is under ${rel(PRIVATE_DIR)}/, which is gitignored. Do not commit it, do not add it to the public mirror, do not share the folder.`);
    console.log(`Next: npm test && npm run typecheck; deploy with npm run deploy (the Worker bundle carries the private data, which is fine for a private server).`);
  } else {
    console.log(`\nNext: npm test && npm run typecheck, then commit ${rel(OUT_DIR)}/ (placeholder data only; the generated modules are not committed).`);
  }
  return 0;
}

// Only run when executed directly (`node scripts/record.mjs`), never on import.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`\nrecord.mjs failed: ${err instanceof Error ? err.message : err}`);
      if (!process.env.ANTHROPIC_API_KEY) console.error("Claude is needed for a recording: set ANTHROPIC_API_KEY or sign in with `ant auth login`.");
      process.exitCode = 1;
    },
  );
}
