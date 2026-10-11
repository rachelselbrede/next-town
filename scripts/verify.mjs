// Checks every Qloo query shape Next Town uses against the real hackathon API, then freezes the real
// place-tag ids into data/tags.json. Run it once the QLOO_API_KEY arrives, before `npm run record`.
//
//   QLOO_API_KEY=... node scripts/verify.mjs      (or: npm run verify)
//   node scripts/verify.mjs                       no key: prints what it would do and exits 0
//
// Options:
//   --city "Durham, NC"   run the city-scoped checks against another city (default: Asheville, NC)
//   --no-write            report only; leave data/tags.json alone
//   --urls                print the exact request URL under every check
//
// What it does, in order:
//   1. /search for the three Hollow Pines comps; picks the best candidate per comp (exact name, then popularity).
//   2. /v2/tags for every group term in data/tags.json (music venue, record store, ...) and matches the
//      returned tags to the groups by name, so filter.tags carries ids Qloo actually knows.
//   3. /v2/insights for each shape the app sends, with the live comp ids and the live tag ids:
//      rank_markets (urn:entity:locality), rooms and promo partners (urn:entity:place), who_shows_up
//      (urn:demographics), local color (urn:entity:brand, urn:entity:tv_show), openers (urn:entity:artist).
//   4. One compact report line per check, a summary of what worked, then data/tags.json is rewritten
//      from step 2 (groups kept, _handAuthored set to false).
//
// Every request goes through QlooClient and the builders in src/queries.ts, exactly like the server,
// so what passes here is what the app will send. Nothing else is written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QlooClient, entitiesOf } from "../src/qloo.ts";
import { QLOO_BASE } from "../src/canonical.ts";
import * as Q from "../src/queries.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TAGS_PATH = path.join(ROOT, "data", "tags.json");
const SCENARIO_PATH = path.join(ROOT, "data", "scenarios", "hollow-pines.json");

const DEFAULT_CITY = "Asheville, NC";
const PAUSE_MS = 150; // breather between live calls; the hackathon tier is rate-limited
const MAX_TAGS_PER_GROUP = 3;
const MIN_TAG_SCORE = 40;

// Search terms and name keywords per tag group in data/tags.json. `terms` are each sent to
// GET /v2/tags; `keywords` decide which returned tags belong to the group (exact name beats a
// prefix beats a substring). A group missing here falls back to its own name ("dive_bar" -> "dive bar").
export const TAG_TERMS = {
  music_venue: { terms: ["music venue", "live music venue"], keywords: ["music venue", "live music venue", "live music"] },
  concert_hall: { terms: ["concert hall"], keywords: ["concert hall", "concert venue", "performing arts"] },
  live_music_bar: { terms: ["live music bar", "music bar"], keywords: ["live music bar", "music bar", "live music"] },
  comedy_club: { terms: ["comedy club"], keywords: ["comedy club", "comedy"] },
  record_store: { terms: ["record store", "record shop"], keywords: ["record store", "record shop", "vinyl", "music store"] },
  coffee_shop: { terms: ["coffee shop", "cafe"], keywords: ["coffee shop", "coffee", "coffeehouse", "cafe", "café"] },
  bookstore: { terms: ["bookstore", "book store"], keywords: ["bookstore", "book store", "book shop", "books"] },
  dive_bar: { terms: ["dive bar"], keywords: ["dive bar", "dive"] },
  vintage: { terms: ["vintage store", "thrift store"], keywords: ["vintage", "thrift", "secondhand", "second hand", "consignment"] },
};

const USAGE = `Usage: QLOO_API_KEY=... node scripts/verify.mjs [--city "City, ST"] [--no-write] [--urls]`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const humanize = (group) => group.replace(/_/g, " ");
const pct = (x) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "n/a");

function parseArgs(argv) {
  const opts = { city: DEFAULT_CITY, write: true, urls: false, help: false, error: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-write") opts.write = false;
    else if (a === "--urls") opts.urls = true;
    else if (a === "--city") opts.city = argv[++i] ?? opts.city;
    else if (a.startsWith("--city=")) opts.city = a.slice("--city=".length);
    else if (a === "--help" || a === "-h") opts.help = true;
    else opts.error = `Unknown option ${a}`;
  }
  return opts;
}

// /v2/tags answers with results.tags; the fallbacks cover a flatter envelope just in case.
export function tagsOf(body) {
  const r = body?.results;
  if (Array.isArray(r?.tags)) return r.tags;
  if (Array.isArray(r)) return r;
  if (Array.isArray(body?.tags)) return body.tags;
  return [];
}
const tagIdOf = (tag) => String(tag?.id ?? tag?.tag_id ?? "");

const countEntities = (body) => entitiesOf(body).length;
const firstEntity = (body) => entitiesOf(body)[0];
const demographicRows = (body) => (Array.isArray(body?.results?.demographics) ? body.results.demographics : []);

function errorText(body) {
  const text = body?.error ?? body?.message ?? body?.raw ?? (body ? JSON.stringify(body) : "no body");
  return String(text).replace(/\s+/g, " ").slice(0, 160);
}

// One line of field names for the first result: nested objects show their keys, arrays their length.
//   entity_id name type subtype popularity properties{address,geocode,business_rating} tags[3] query{affinity,explainability}
export function shapeOf(value) {
  if (!value || typeof value !== "object") return typeof value;
  return Object.entries(value)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}[${v.length}]`;
      if (v && typeof v === "object") return `${k}{${Object.keys(v).join(",")}}`;
      return k;
    })
    .join(" ");
}

// How feature.explainability came back, e.g. "by_entity[3] -> {name,score}" or "none".
export function explainabilityShape(entity) {
  const ex = entity?.query?.explainability;
  if (ex === undefined) return "none";
  if (!ex || typeof ex !== "object") return typeof ex;
  const parts = Object.entries(ex).map(([k, v]) => {
    if (v && typeof v === "object") {
      const inner = Object.values(v)[0];
      const innerShape = inner && typeof inner === "object" ? `{${Object.keys(inner).join(",")}}` : typeof inner;
      return `${k}[${Object.keys(v).length}] -> ${innerShape}`;
    }
    return `${k}: ${typeof v}`;
  });
  return parts.join("; ") || "empty object";
}

// A query on one line without the long id lists, for the no-key plan and the summary.
export function describeQuery(q) {
  const params = Object.entries(q.params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const s = String(v);
      if (k.endsWith(".entities") || k === "filter.tags") {
        const n = s.split(",").filter(Boolean).length;
        return `${k}=<${n} id${n === 1 ? "" : "s"}>`;
      }
      return `${k}=${s}`;
    });
  return `GET ${q.path}  ${params.join("  ")}`;
}

// Top results in one line, with state for localities and subtype for places: "The Grey Eagle [music_venue] 87%; ..."
function topLine(body, n = 4) {
  return entitiesOf(body)
    .slice(0, n)
    .map((e) => {
      const state = e.type === "urn:entity:locality" ? e.properties?.geocode?.admin1_region : undefined;
      const sub = e.subtype && e.type !== "urn:entity:locality" ? ` [${e.subtype.split(":").at(-1)}]` : "";
      const aff = typeof e.query?.affinity === "number" ? ` ${pct(e.query.affinity)}` : "";
      return `${e.name}${state ? `, ${state}` : ""}${sub}${aff}`;
    })
    .join("; ");
}

// Same rule as src/tools.ts bestCandidate: exact (case-insensitive) name match first, then popularity.
function bestCandidate(name, entities, wantedType) {
  const wanted = name.trim().toLowerCase();
  const typed = entities.filter((e) => !wantedType || e.type === wantedType || (Array.isArray(e.types) && e.types.includes(wantedType)));
  const exact = typed.find((e) => String(e.name ?? "").trim().toLowerCase() === wanted);
  return exact ?? [...typed].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

// How well a tag from /v2/tags fits a group. Place tags are what filter.tags on urn:entity:place
// accepts, so a non-place tag needs an exact name match to survive the threshold.
export function scoreTag(tag, keywords) {
  const name = String(tag?.name ?? "").trim().toLowerCase();
  const id = tagIdOf(tag).toLowerCase();
  if (!name || !id) return 0;
  let best = 0;
  for (const kw of keywords) {
    if (name === kw) best = Math.max(best, 100);
    else if (name.startsWith(kw) || name.endsWith(kw)) best = Math.max(best, 70);
    else if (name.includes(kw)) best = Math.max(best, 50);
    else if (id.includes(kw.replace(/\s+/g, "_"))) best = Math.max(best, 40);
  }
  if (!best) return 0;
  const isPlaceTag = id.includes(":place") || String(tag?.type ?? "").includes("place");
  return isPlaceTag ? best + 20 : best - 30;
}

// ---------------------------------------------------------------------------
// Report lines
// ---------------------------------------------------------------------------

const LABEL_WIDTH = 40;
const STATUS_TAG = { ok: " ok ", WARN: "WARN", FAIL: "FAIL", plan: " -- " };

function line(status, label, detail) {
  console.log(`${STATUS_TAG[status] ?? status} ${label.padEnd(LABEL_WIDTH)} ${detail}`);
}
function heading(text) {
  console.log(`\n${text}`);
}
function warn(text) {
  console.log(`WARN ${text}`);
}

// Runs one query through QlooClient and prints its report line(s). `count` and `first` are swapped for
// endpoints that do not answer with results.entities (tags, demographics).
function makeChecker(client, checks, opts) {
  return async function check(label, query, { count = countEntities, first = firstEntity, shape = true } = {}) {
    const r = await client.get(query.path, query.params);
    await sleep(PAUSE_MS);
    const n = r.ok ? count(r.body) : 0;
    const status = !r.ok ? "FAIL" : n === 0 ? "WARN" : "ok";
    const detail = r.ok
      ? `HTTP ${r.status}  ${String(n).padStart(3)} results  ${String(r.ms).padStart(5)} ms${n === 0 ? "   <- empty" : ""}`
      : `HTTP ${r.status || "---"}  ${errorText(r.body)}`;
    line(status, label, detail);
    if (opts.urls || !r.ok) console.log(`      ${r.url}`);
    const sample = r.ok && n > 0 ? first(r.body) : undefined;
    if (sample && shape) {
      console.log(`      first: ${shapeOf(sample)}`);
      console.log(`      explainability: ${explainabilityShape(sample)}`);
    }
    checks.push({ label, status, n, httpStatus: r.status });
    return { r, n, status, sample };
  };
}

// ---------------------------------------------------------------------------
// No key: show the plan
// ---------------------------------------------------------------------------

function printPlan(scenario, groups, city) {
  const format = scenario.request.format;
  const compIds = scenario.comps.map((c) => c.id);
  const venueTags = Q.VENUE_TAG_GROUPS.flatMap((g) => groups[g] ?? []);
  const promoTags = Q.PROMO_TAG_GROUPS.flatMap((g) => groups[g] ?? []);

  console.log("QLOO_API_KEY is not set, so nothing was called. With a key, scripts/verify.mjs runs these checks in order:");
  heading("1. Resolve the comps");
  for (const name of scenario.request.comps) line("plan", `search "${name}"`, describeQuery(Q.searchAct(name, format)));
  heading("2. Place tags, one search per group term");
  for (const group of Object.keys(groups)) {
    for (const term of TAG_TERMS[group]?.terms ?? [humanize(group)]) line("plan", `tags "${term}" -> ${group}`, describeQuery(Q.findTags(term)));
  }
  heading(`3. Insights for ${city}, with the resolved comp ids and the live tag ids`);
  line("plan", "rank_markets (urn:entity:locality)", describeQuery(Q.rankMarkets(compIds)));
  line("plan", "find_rooms (urn:entity:place)", describeQuery(Q.findRooms(compIds, city, venueTags)));
  line("plan", "find_promo_partners (place, diversify)", describeQuery(Q.findPromoPartners(compIds, city, promoTags)));
  line("plan", "who_shows_up (urn:demographics)", describeQuery(Q.whoShowsUp(compIds, city)));
  line("plan", "local_color (urn:entity:brand)", describeQuery(Q.localColor(compIds, city, "brand")));
  line("plan", "local_color (urn:entity:tv_show)", describeQuery(Q.localColor(compIds, city, "tv_show")));
  line("plan", "openers_to_ask (urn:entity:artist)", describeQuery(Q.openersToAsk(compIds, city)));
  heading("4. Then");
  console.log(`  - print status, result count, first entity's field names and explainability shape per check,`);
  console.log(`    and whether urn:entity:locality and urn:demographics worked`);
  console.log(`  - rewrite data/tags.json groups (${Object.keys(groups).join(", ")}) from the live tag results, _handAuthored: false`);
  console.log(`\nThe comp ids shown are the scenario's placeholders from data/scenarios/hollow-pines.json; the live run uses whatever /search returns.`);
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.error) {
    console.log(opts.error ? `${opts.error}\n${USAGE}` : USAGE);
    return opts.error ? 2 : 0;
  }
  const scenario = readJson(SCENARIO_PATH);
  const tagsFile = readJson(TAGS_PATH);
  const groups = tagsFile.groups ?? {};
  const city = opts.city;
  const format = scenario.request.format;
  const key = process.env.QLOO_API_KEY?.trim();

  if (!key) {
    printPlan(scenario, groups, city);
    return 0;
  }

  const client = new QlooClient({ QLOO_API_KEY: key, QLOO_MODE: "live", QLOO_BASE_URL: process.env.QLOO_BASE_URL });
  const checks = [];
  const check = makeChecker(client, checks, opts);
  console.log(`Verifying Next Town's Qloo query shapes against ${process.env.QLOO_BASE_URL || QLOO_BASE} (city: ${city})`);

  // 1. Comps. The live ids replace the scenario placeholders for every later check.
  heading("1. Resolve the comps (/search)");
  const comps = [];
  for (const name of scenario.request.comps) {
    const query = Q.searchAct(name, format);
    const { r } = await check(`search "${name}"`, query);
    const pick = r.ok ? bestCandidate(name, entitiesOf(r.body), String(query.params.types)) : undefined;
    const placeholder = scenario.comps.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (pick) {
      comps.push({ id: pick.entity_id, name: pick.name, popularity: pick.popularity });
      console.log(`      picked: ${pick.name}  ${pick.entity_id}${typeof pick.popularity === "number" ? `  popularity ${pick.popularity}` : ""}`);
    } else if (placeholder) {
      warn(`no live candidate for "${name}"; the next checks use the scenario placeholder id ${placeholder.id}`);
      comps.push({ id: placeholder.id, name: placeholder.name });
    }
  }
  const compIds = comps.map((c) => c.id);
  const changedComps = comps.filter((c) => {
    const s = scenario.comps.find((x) => x.name.toLowerCase() === c.name.toLowerCase());
    return s && s.id !== c.id;
  });

  // 2. Tags. Each group collects candidates from all of its terms, then keeps the best few ids.
  heading("2. Place tags (/v2/tags)");
  const liveGroups = {};
  const stillHandAuthored = [];
  let shownTagShape = false;
  for (const [group, oldIds] of Object.entries(groups)) {
    const spec = TAG_TERMS[group] ?? { terms: [humanize(group)], keywords: [humanize(group)] };
    const candidates = new Map(); // tag id -> { tag, score }
    for (const term of spec.terms) {
      const { r } = await check(`tags "${term}" -> ${group}`, Q.findTags(term), { count: (b) => tagsOf(b).length, first: (b) => tagsOf(b)[0], shape: !shownTagShape });
      shownTagShape = true;
      if (!r.ok) continue;
      for (const tag of tagsOf(r.body)) {
        const score = scoreTag(tag, spec.keywords);
        if (score < MIN_TAG_SCORE) continue;
        const id = tagIdOf(tag);
        if (!candidates.has(id) || candidates.get(id).score < score) candidates.set(id, { tag, score });
      }
    }
    const picked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, MAX_TAGS_PER_GROUP);
    if (picked.length) {
      liveGroups[group] = picked.map((p) => tagIdOf(p.tag));
      console.log(`      ${group}: ${picked.map((p) => `${tagIdOf(p.tag)} "${p.tag.name}"`).join(", ")}`);
    } else {
      liveGroups[group] = oldIds;
      stillHandAuthored.push(group);
      warn(`${group}: no returned tag matched ${spec.keywords.map((k) => `"${k}"`).join("/")}; keeping the hand-authored ids`);
    }
  }
  const venueTags = (format === "comedy" ? Q.COMEDY_TAG_GROUPS : Q.VENUE_TAG_GROUPS).flatMap((g) => liveGroups[g] ?? []);
  const promoTags = Q.PROMO_TAG_GROUPS.flatMap((g) => liveGroups[g] ?? []);

  // 3. Insights, one call per shape the app sends.
  heading(`3. Insights for ${city} (/v2/insights)`);
  const markets = await check("rank_markets (urn:entity:locality)", Q.rankMarkets(compIds));
  if (markets.n) console.log(`      top: ${topLine(markets.r.body, 5)}`);
  const localityEntities = markets.n ? entitiesOf(markets.r.body) : [];
  const localityWorked = localityEntities.length > 0;
  const localityHasCoords = localityEntities.some((e) => typeof e.location?.lat === "number" && typeof e.location?.lon === "number");
  const localityHasState = localityEntities.some((e) => typeof e.properties?.geocode?.admin1_region === "string");

  const rooms = await check("find_rooms (urn:entity:place)", Q.findRooms(compIds, city, venueTags));
  if (rooms.n) console.log(`      top: ${topLine(rooms.r.body)}`);
  const promo = await check("find_promo_partners (place, diversify)", Q.findPromoPartners(compIds, city, promoTags));
  if (promo.n) console.log(`      top: ${topLine(promo.r.body)}`);

  const who = await check("who_shows_up (urn:demographics)", Q.whoShowsUp(compIds, city), { count: (b) => demographicRows(b).length, first: (b) => demographicRows(b)[0] });
  const demographicsWorked = who.n > 0;
  if (demographicsWorked) {
    const ages = who.sample?.query?.age ?? who.sample?.age;
    if (ages && typeof ages === "object") console.log(`      age bands: ${Object.keys(ages).join(", ")}`);
  }

  const brands = await check("local_color (urn:entity:brand)", Q.localColor(compIds, city, "brand"));
  if (brands.n) console.log(`      top: ${topLine(brands.r.body)}`);
  const shows = await check("local_color (urn:entity:tv_show)", Q.localColor(compIds, city, "tv_show"));
  if (shows.n) console.log(`      top: ${topLine(shows.r.body)}`);
  const openers = await check("openers_to_ask (urn:entity:artist)", Q.openersToAsk(compIds, city));
  if (openers.n) console.log(`      top: ${topLine(openers.r.body)}`);

  // 4. Summary.
  heading("Summary");
  const failed = checks.filter((c) => c.status === "FAIL");
  const empty = checks.filter((c) => c.status === "WARN");
  console.log(`${checks.length} checks: ${checks.length - failed.length - empty.length} ok, ${empty.length} empty, ${failed.length} failed`);
  console.log(
    `urn:entity:locality: ${localityWorked ? `worked (${localityEntities.length} localities; location.lat/lon ${localityHasCoords ? "present" : "MISSING, the Census join will supply coordinates"}; geocode.admin1_region ${localityHasState ? "present" : "MISSING, labels will lack a state"})` : "did NOT work"}`,
  );
  console.log(`urn:demographics: ${demographicsWorked ? `worked (${who.n} rows in results.demographics)` : "did NOT work"}`);
  if (failed.length) console.log(`failed: ${failed.map((c) => `${c.label} (HTTP ${c.httpStatus})`).join("; ")}`);
  if (empty.length) console.log(`empty: ${empty.map((c) => c.label).join("; ")}`);
  if (changedComps.length) {
    console.log(`\nLive comp ids differ from data/scenarios/hollow-pines.json. Update scenario "comps" to these, then run \`npm run fixtures\` and \`npm run record\`:`);
    console.log(JSON.stringify(comps.map((c) => ({ id: c.id, name: c.name, type: format === "comedy" ? "urn:entity:person" : "urn:entity:artist", ...(typeof c.popularity === "number" ? { popularity: c.popularity } : {}) })), null, 2));
  }

  // data/tags.json: groups kept, ids replaced by what /v2/tags returned.
  heading("data/tags.json");
  const matchedGroups = Object.keys(groups).length - stillHandAuthored.length;
  if (!opts.write) {
    console.log("--no-write: left alone.");
  } else if (matchedGroups === 0) {
    warn("no live tag matched any group, so the file was left alone.");
  } else {
    for (const group of Object.keys(groups)) {
      const before = (groups[group] ?? []).join(", ");
      const after = liveGroups[group].join(", ");
      console.log(`  ${group}: ${before === after ? `${after} (unchanged)` : `${before}  ->  ${after}`}`);
    }
    writeTags(tagsFile, liveGroups, stillHandAuthored);
    console.log(`wrote ${path.relative(process.cwd(), TAGS_PATH)} (${matchedGroups}/${Object.keys(groups).length} groups from live tags${stillHandAuthored.length ? `; still hand-authored: ${stillHandAuthored.join(", ")}` : ""})`);
    console.log("Next: npm run fixtures && npm run record   (re-keys the fixture index for the new tag ids and re-records the sample)");
  }
  return failed.length ? 1 : 0;
}

function writeTags(previous, liveGroups, stillHandAuthored) {
  const now = new Date().toISOString();
  const out = {
    _handAuthored: false,
    _note: `Place tag ids per group, rewritten by scripts/verify.mjs from GET /v2/tags results on ${now.slice(0, 10)}. Each group may hold several tag ids; queries pass them with operator.filter.tags=union. Re-run \`npm run verify\` to refresh, then \`npm run fixtures\` and \`npm run record\`.`,
    _verified: now,
    ...(stillHandAuthored.length ? { _stillHandAuthored: stillHandAuthored } : {}),
    groups: Object.fromEntries(Object.keys(previous.groups ?? {}).map((g) => [g, liveGroups[g]])),
  };
  fs.writeFileSync(TAGS_PATH, JSON.stringify(out, null, 2) + "\n");
}

// Only run when executed directly (`node scripts/verify.mjs`), never on import.
const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
