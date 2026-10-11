// Generates fixture skeletons for a scenario so every file's canonical URL matches exactly what
// the server will request. Fill the "response" of each file (by hand before the key arrives, or
// by scripts/record.ts after). Existing files are never overwritten.
//
//   node scripts/scaffold-fixtures.mjs hollow-pines

import fs from "node:fs";
import path from "node:path";
import { canonicalUrl, slug } from "../src/canonical.ts";
import * as Q from "../src/queries.ts";

const scenarioId = process.argv[2] || "hollow-pines";
const scenario = JSON.parse(fs.readFileSync(`data/scenarios/${scenarioId}.json`, "utf8"));
const tags = JSON.parse(fs.readFileSync("data/tags.json", "utf8")).groups;
const dir = "fixtures/qloo";
fs.mkdirSync(dir, { recursive: true });
const indexPath = path.join(dir, "index.json");
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, "utf8")) : {};

const compIds = scenario.comps.map((c) => c.id);
const venueTags = Q.VENUE_TAG_GROUPS.flatMap((g) => tags[g] ?? []);
const promoTags = Q.PROMO_TAG_GROUPS.flatMap((g) => tags[g] ?? []);

const plan = [];
for (const c of scenario.request.comps) plan.push({ file: `search-${slug(c)}.json`, query: Q.searchAct(c, scenario.request.format) });
plan.push({ file: `markets-${scenarioId}.json`, query: Q.rankMarkets(compIds) });
const cities = [...scenario.playbookCities, scenario.request.home];
for (const city of cities) {
  const s = slug(city);
  plan.push({ file: `rooms-${s}.json`, query: Q.findRooms(compIds, city, venueTags) });
  plan.push({ file: `promo-${s}.json`, query: Q.findPromoPartners(compIds, city, promoTags) });
  plan.push({ file: `demographics-${s}.json`, query: Q.whoShowsUp(compIds, city) });
  plan.push({ file: `brands-${s}.json`, query: Q.localColor(compIds, city, "brand") });
  plan.push({ file: `tvshows-${s}.json`, query: Q.localColor(compIds, city, "tv_show") });
}

let created = 0;
for (const { file, query } of plan) {
  const canonical = canonicalUrl(query.path, query.params);
  index[canonical] = file;
  const fp = path.join(dir, file);
  if (fs.existsSync(fp)) continue;
  const empty = query.params["filter.type"] === "urn:demographics" ? { success: true, results: { demographics: [] } } : { success: true, results: { entities: [] } };
  fs.writeFileSync(fp, JSON.stringify({ _handAuthored: true, _captured: null, tool: query.tool, canonical, query: { path: query.path, params: query.params }, response: empty }, null, 2) + "\n");
  created++;
}
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n");
console.log(`${plan.length} fixtures indexed, ${created} skeletons created in ${dir}`);
