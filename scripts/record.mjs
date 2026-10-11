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
//   1. POST /api/plan   -> fixtures/scenarios/hollow-pines/plan.jsonl   every SSE event except "open", one JSON per line
//   2. POST /api/city   -> city-<slug>.json for every route stop and every scenario playbookCity (the playbook payload)
//   3. POST /api/pitch  -> pitch.json
//   4. regenerates src/recorded.generated.ts: the plan events inlined, the city files and pitch as static JSON
//      imports (the same trick scripts/bundle-fixtures.mjs uses), so the Worker bundle carries the recording
//   5. with QLOO_API_KEY set: rewrites fixtures/qloo/*.json from the live Qloo responses this run made
//      (_handAuthored:false, _captured:<ISO date>), then re-bundles them with scripts/bundle-fixtures.mjs
//
// Claude comes from ANTHROPIC_API_KEY or an `ant auth login` profile (DEV=1 lets the SDK look for one).
// Qloo is live with QLOO_API_KEY, otherwise the agent answers from the bundled fixtures. A run spends real
// Claude tokens (one agent run, one structured-output call per city, one pitch call), so tests never run it.
// Safe to re-run: every output is overwritten, stale city files are removed, the fixture index is re-keyed.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import worker from "../src/index.ts";
import { QlooClient } from "../src/qloo.ts";
import { canonicalUrl, idList, slug } from "../src/canonical.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCENARIO_ID = "hollow-pines";
const SCENARIO_PATH = path.join(ROOT, "data", "scenarios", `${SCENARIO_ID}.json`);
const OUT_DIR = path.join(ROOT, "fixtures", "scenarios", SCENARIO_ID);
const FIXTURE_DIR = path.join(ROOT, "fixtures", "qloo");
const INDEX_PATH = path.join(FIXTURE_DIR, "index.json");
const GENERATED_PATH = path.join(ROOT, "src", "recorded.generated.ts");
const BUNDLE_SCRIPT = path.join(ROOT, "scripts", "bundle-fixtures.mjs");

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
// calls log across all requests of the run. Installed by main(), never on import.
function captureQlooCalls() {
  const log = [];
  const original = QlooClient.prototype.get;
  QlooClient.prototype.get = async function loggedGet(qpath, params) {
    const result = await original.call(this, qpath, params);
    log.push(result);
    return result;
  };
  return log;
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

// Import specifier from src/ to the recording folder (a module path, so always forward slashes).
const IMPORT_PREFIX = `../fixtures/scenarios/${SCENARIO_ID}/`;

// Everything the renderer needs, read from the recording folder: the plan events, the city slugs
// (from the city-<slug>.json file names, sorted) and whether a pitch exists. Empty when nothing is recorded.
export function readRecording(dir = OUT_DIR) {
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
  return { planEvents, citySlugs, hasPitch, recordedAt };
}

// Renders src/recorded.generated.ts. The plan events are inlined one per line (JSON Lines cannot be
// imported); each city file and the pitch become a static JSON import, so the module stays small and
// the JSON files remain the source of truth. With nothing recorded it renders the empty placeholder.
export function renderRecordedModule({ planEvents = [], citySlugs = [], hasPitch = false, recordedAt = null } = {}) {
  const head = "// GENERATED FILE. Do not edit by hand; run `npm run record` (scripts/record.mjs) instead.\n//";
  if (planEvents.length === 0) {
    return `${head}
// scripts/record.mjs runs the Hollow Pines scenario through the real handler and writes
// fixtures/scenarios/${SCENARIO_ID}/plan.jsonl, city-<slug>.json, and pitch.json, then regenerates
// this module so the Worker bundle carries the recording with it. Until it has run, everything
// here is empty and src/recorded.ts reports RECORDED_AVAILABLE = false.

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
// Recorded ${recordedAt} for the "${SCENARIO_ID}" scenario. The plan events are inlined from
// plan.jsonl (JSON Lines cannot be imported); the playbooks and pitch are static JSON imports so the
// Worker bundle carries the whole recording with it.

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

// Writes the module from whatever is in the recording folder right now.
function writeRecordedModule() {
  const recording = readRecording();
  fs.writeFileSync(GENERATED_PATH, renderRecordedModule(recording));
  console.log(`wrote ${rel(GENERATED_PATH)} (${kb(GENERATED_PATH)}: ${recording.planEvents.length} plan events, ${recording.citySlugs.length} playbook imports, pitch ${recording.hasPitch ? "imported" : "null"})`);
  return recording;
}

// ---------------------------------------------------------------------------
// fixtures/qloo: rewrite from the live calls log
// ---------------------------------------------------------------------------

// Which agent tool issues a request, derived from its shape (same names as src/queries.ts).
export function toolFor(qpath, params) {
  if (qpath === "/search") return "resolve_act";
  if (qpath === "/v2/tags") return "find_tags";
  switch (params["filter.type"]) {
    case "urn:entity:locality":
      return "rank_markets";
    case "urn:entity:place":
      return params["diversify.by"] ? "find_promo_partners" : "find_rooms";
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

// The file name scripts/scaffold-fixtures.mjs would give this request, so live captures land in the
// same files the skeletons use: search-big-thief.json, markets-hollow-pines.json, rooms-asheville-nc.json ...
export function fixtureFileFor(qpath, params, scenarioId = SCENARIO_ID) {
  if (qpath === "/search") return `search-${slug(String(params.query ?? "query"))}.json`;
  if (qpath === "/v2/tags") return `tags-${slug(String(params["filter.query"] ?? "query"))}.json`;
  const where = slug(String(params["filter.location.query"] ?? params["signal.location.query"] ?? ""));
  switch (params["filter.type"]) {
    case "urn:entity:locality":
      return `markets-${scenarioId}.json`;
    case "urn:entity:place":
      return `${params["diversify.by"] ? "promo" : "rooms"}-${where}.json`;
    case "urn:demographics":
      return `demographics-${where}.json`;
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

// Finds the fixture file a live request belongs to: by its canonical URL, else by the URL it would
// have with the scenario's placeholder ids, else by the file name the scaffold would use, else a new file.
export function locateFixture(index, result, idMap, scenarioId = SCENARIO_ID) {
  const canonical = canonicalUrl(result.path, result.params);
  if (index[canonical]) return { file: index[canonical], how: "canonical URL" };
  const swapped = canonicalUrl(result.path, swapIds(result.params, idMap));
  if (swapped !== canonical && index[swapped]) return { file: index[swapped], how: "comp-id substitution" };
  const derived = fixtureFileFor(result.path, result.params, scenarioId);
  if (Object.values(index).includes(derived) || fs.existsSync(path.join(FIXTURE_DIR, derived))) return { file: derived, how: "file name" };
  return { file: derived, how: "new file" };
}

function rewriteFixtures(log, { scenario, liveComps, capturedAt }) {
  const index = fs.existsSync(INDEX_PATH) ? readJson(INDEX_PATH) : {};
  const idMap = scenarioIdMap(scenario.comps, liveComps);
  const seen = new Set();
  const counts = {};
  let skipped = 0;

  for (const result of log) {
    if (result.mode !== "live") continue;
    if (!result.ok || result.status !== 200) {
      skipped += 1;
      continue;
    }
    const canonical = canonicalUrl(result.path, result.params);
    if (seen.has(canonical)) continue; // the home city's local-color pair repeats for every playbook
    seen.add(canonical);

    const { file, how } = locateFixture(index, result, idMap, scenario.id);
    const target = path.join(FIXTURE_DIR, file);
    const previous = fs.existsSync(target) ? readJson(target) : undefined;
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
    console.log(`  ${how === "new file" ? "created" : "rewrote"} ${file}  (matched by ${how})`);
  }
  writeJson(INDEX_PATH, index);

  const summary = Object.entries(counts).map(([how, n]) => `${n} by ${how}`).join(", ");
  console.log(`  ${seen.size} fixtures written (${summary || "none"})${skipped ? `; ${skipped} failed live calls left alone` : ""}`);
  if (idMap.size) {
    console.log(`  Live comp ids differ from data/scenarios/${scenario.id}.json; fixtures are now keyed by the live ids. Update the scenario "comps" to:`);
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
    console.log(`--module-only: rebuilding ${rel(GENERATED_PATH)} from ${rel(OUT_DIR)}/ without calling anything`);
    writeRecordedModule();
    return 0;
  }

  const t0 = Date.now();
  const scenario = readJson(SCENARIO_PATH);
  const env = makeEnv();
  const home = scenario.request.home;

  const health = await (await worker.fetch(new Request(`${ORIGIN}/api/health`), env, CTX)).json();
  console.log(`Recording "${scenario.act}" (${SCENARIO_ID}): model ${health.model}, Qloo ${health.qloo}, Claude via ${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : "local profile"}`);
  console.log(`Output: ${rel(OUT_DIR)}/ and ${rel(GENERATED_PATH)}${health.qloo === "live" && opts.fixtures ? `, plus ${rel(FIXTURE_DIR)}/*.json` : ""}`);

  if (opts.dryRun) {
    console.log(`\n--dry-run: nothing called. The run would:`);
    console.log(`  1. POST /api/plan ${JSON.stringify({ ...scenario.request, scenarioId: SCENARIO_ID, recorded: false })}`);
    console.log(`     -> ${rel(path.join(OUT_DIR, "plan.jsonl"))}`);
    console.log(`  2. POST /api/city for every route stop plus: ${scenario.playbookCities.join(", ")}`);
    console.log(`     -> ${rel(OUT_DIR)}/city-<slug>.json`);
    console.log(`  3. POST /api/pitch -> ${rel(path.join(OUT_DIR, "pitch.json"))}`);
    console.log(`  4. regenerate ${rel(GENERATED_PATH)} (plan events inlined, city files and pitch imported as JSON)`);
    console.log(health.qloo === "live" && opts.fixtures ? `  5. rewrite ${rel(FIXTURE_DIR)}/*.json from the live responses and run scripts/bundle-fixtures.mjs` : `  5. (fixtures/qloo untouched: ${health.qloo === "live" ? "--no-fixtures" : "no QLOO_API_KEY"})`);
    return 0;
  }

  const qlooLog = captureQlooCalls();
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
    playbooks: route.stops.map((s) => playbooks[slug(s.label)]).filter(Boolean),
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

  // 4. The module the Worker bundles, built from the files just written.
  console.log(`\n4. src/recorded.generated.ts`);
  writeRecordedModule();

  // 5. Fixtures: live responses replace the hand-authored ones; in demo mode, report any gaps instead.
  console.log(`\n5. fixtures/qloo`);
  const liveCalls = qlooLog.filter((r) => r.mode === "live");
  const misses = qlooLog.filter((r) => r.mode === "demo" && !r.ok);
  if (liveCalls.length && opts.fixtures) {
    rewriteFixtures(qlooLog, { scenario, liveComps: comps, capturedAt: recordedAt });
    console.log(`  bundling with ${rel(BUNDLE_SCRIPT)}`);
    execFileSync(process.execPath, [BUNDLE_SCRIPT], { cwd: ROOT, stdio: "inherit" });
  } else if (liveCalls.length) {
    console.log(`  --no-fixtures: ${liveCalls.length} live Qloo responses not saved`);
  } else {
    console.log(`  demo mode: ${qlooLog.length} Qloo requests answered from fixtures, ${misses.length} with no fixture`);
    if (misses.length) {
      console.log(`  WARN these requests had no fixture and were served empty; add their cities to playbookCities in ${rel(SCENARIO_PATH)} and run \`npm run fixtures\`:`);
      for (const url of new Set(misses.map((r) => r.url))) console.log(`    ${url}`);
    }
  }

  console.log(`\nDone in ${Math.round((Date.now() - t0) / 1000)} s: ${planEvents.length} plan events, ${cities.length} playbooks, pitch. The agent closed with:`);
  console.log(`  ${String(done.text).trim().replace(/\s+/g, " ")}`);
  console.log(`Next: npm test && npm run typecheck, then commit ${rel(OUT_DIR)}/ and ${rel(GENERATED_PATH)}${liveCalls.length && opts.fixtures ? ` (and ${rel(FIXTURE_DIR)}/, src/demo/fixtures.generated.ts)` : ""}.`);
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
