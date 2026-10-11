// Generates PUBLIC fixture skeletons for a scenario so every file's canonical URL matches exactly what
// the server will request. Fill the "response" of each file by hand (placeholders in Qloo's documented
// shape). Live Qloo captures never go here: scripts/record.mjs writes those to private/qloo (gitignored).
//
//   node scripts/scaffold-fixtures.mjs hollow-pines           create missing skeletons, refresh index.json
//   node scripts/scaffold-fixtures.mjs hollow-pines --prune   also delete files and index entries this
//                                                            scenario no longer produces (prints the list)
//
// Idempotent: a file that already exists keeps its response and provenance flags, always. When a
// builder or data/tags.json changes so an existing file's canonical URL moves (same file name, new
// key), only the wrapper fields (canonical, query, tool) are re-keyed; the response is left alone.
// One file per query:
//   search-<comp>.json                     /search per comp
//   markets-<scenario>.json                rankMarkets(compIds, venue tags): nationwide places, one per city
//   demographics-overall.json              whoShowsUp(compIds): one read for fans of the comps overall
//   per city (playbookCities + home):
//     rooms-<slug>.json                    findRooms
//     promo-<group>-<slug>.json            findPromoGroup, one per PROMO_TAG_GROUPS entry (record-store, ...)
//     brands-<slug>.json, tvshows-<slug>.json   localColor

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalUrl, slug } from "../src/canonical.ts";
import * as Q from "../src/queries.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const prune = args.includes("--prune");
const scenarioId = args.find((a) => !a.startsWith("--")) || "hollow-pines";

const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "scenarios", `${scenarioId}.json`), "utf8"));
const tags = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "tags.json"), "utf8")).groups;
const dir = path.join(ROOT, "fixtures", "qloo");
fs.mkdirSync(dir, { recursive: true });
const indexPath = path.join(dir, "index.json");
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

// The exact query list the scenario can make, in a stable order. tests/resolver.test.ts mirrors this.
function scenarioPlan(scenario, tagGroups) {
  const compIds = scenario.comps.map((c) => c.id);
  const format = scenario.request.format;
  const venueGroups = format === "comedy" ? Q.COMEDY_TAG_GROUPS : Q.VENUE_TAG_GROUPS;
  const venueTags = venueGroups.flatMap((g) => tagGroups[g] ?? []);
  const plan = [];
  for (const c of scenario.request.comps) plan.push({ file: `search-${slug(c)}.json`, query: Q.searchAct(c, format) });
  plan.push({ file: `markets-${scenario.id}.json`, query: Q.rankMarkets(compIds, venueTags) });
  plan.push({ file: `demographics-overall.json`, query: Q.whoShowsUp(compIds) });
  const cities = [];
  for (const city of [...scenario.playbookCities, scenario.request.home]) {
    if (!cities.some((c) => slug(c) === slug(city))) cities.push(city);
  }
  for (const city of cities) {
    const s = slug(city);
    plan.push({ file: `rooms-${s}.json`, query: Q.findRooms(compIds, city, venueTags) });
    for (const group of Q.PROMO_TAG_GROUPS) {
      plan.push({ file: `promo-${group.replace(/_/g, "-")}-${s}.json`, query: Q.findPromoGroup(compIds, city, tagGroups[group] ?? []) });
    }
    plan.push({ file: `brands-${s}.json`, query: Q.localColor(compIds, city, "brand") });
    plan.push({ file: `tvshows-${s}.json`, query: Q.localColor(compIds, city, "tv_show") });
  }
  return plan;
}

// Empty response in the documented envelope for this query, so the resolver always has a body.
function emptyResponse(query) {
  if (query.path === "/search") return { results: [] };
  if (query.params["filter.type"] === "urn:demographics") return { success: true, results: { demographics: [] } };
  return { success: true, results: { entities: [] } };
}

const plan = scenarioPlan(scenario, tags);
const wanted = new Map(plan.map(({ file, query }) => [file, canonicalUrl(query.path, query.params)]));

let created = 0;
let rekeyed = 0;
for (const { file, query } of plan) {
  const canonical = wanted.get(file);
  index[canonical] = file;
  const fp = path.join(dir, file);
  if (!fs.existsSync(fp)) {
    writeJson(fp, { _handAuthored: true, _captured: null, tool: query.tool, canonical, query: { path: query.path, params: query.params }, response: emptyResponse(query) });
    created++;
    continue;
  }
  // Existing file: never touch the response or the provenance flags. Re-key the wrapper if the
  // canonical URL moved (tag ids or builder params changed) so the file still describes its key.
  const existing = readJson(fp);
  if (existing.canonical !== canonical) {
    writeJson(fp, { ...existing, tool: query.tool, canonical, query: { path: query.path, params: query.params } });
    rekeyed++;
  }
}

// Anything in the index or on disk that this scenario no longer produces.
const staleEntries = Object.entries(index).filter(([key, file]) => !wanted.has(file) || wanted.get(file) !== key);
const staleFiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "index.json" && !wanted.has(f))
  .sort();

if (prune) {
  for (const [key] of staleEntries) delete index[key];
  for (const f of staleFiles) fs.unlinkSync(path.join(dir, f));
}
writeJson(indexPath, index);

console.log(`${plan.length} fixtures indexed, ${created} skeletons created, ${rekeyed} re-keyed in ${path.relative(process.cwd(), dir) || "."}`);
if (staleEntries.length || staleFiles.length) {
  if (prune) {
    console.log(`--prune: removed ${staleEntries.length} stale index entries and ${staleFiles.length} files:`);
  } else {
    console.log(`${staleEntries.length} stale index entries and ${staleFiles.length} files are not produced by this scenario any more (re-run with --prune to delete them):`);
  }
  const short = (key) => (key.length > 110 ? key.slice(0, 110) + "..." : key);
  for (const [key, file] of staleEntries) console.log(`  key  -> ${file}  ${short(key)}`);
  for (const f of staleFiles) console.log(`  file ${f}`);
}
