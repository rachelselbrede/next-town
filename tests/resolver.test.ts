// The demo must never miss: every request the Hollow Pines scenario can make has a recorded fixture.
// This re-derives the exact query list the same way scripts/scaffold-fixtures.mjs does (same scenario
// file, same tag groups, same query builders), so if a builder or the scenario changes without
// re-running `npm run fixtures`, this test is what fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as Q from "../src/queries.ts";
import { canonicalUrl, idList } from "../src/canonical.ts";
import { entitiesOf } from "../src/qloo.ts";
import { demoResolver, fixtureMeta, FIXTURE_NOTE } from "../src/demo/resolver.ts";
import { fixtures, fixtureCount, generatedAt } from "../src/demo/fixtures.generated.ts";

const readJson = (rel: string) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const scenario = readJson("../data/scenarios/hollow-pines.json");
const tagGroups: Record<string, string[]> = readJson("../data/tags.json").groups;

const compIds: string[] = scenario.comps.map((c: { id: string }) => c.id);
const venueTags = Q.VENUE_TAG_GROUPS.flatMap((g) => tagGroups[g] ?? []);
const promoTags = Q.PROMO_TAG_GROUPS.flatMap((g) => tagGroups[g] ?? []);

// Mirrors the `plan` array in scripts/scaffold-fixtures.mjs.
function scenarioQueries(): Array<{ label: string; query: Q.Query }> {
  const out: Array<{ label: string; query: Q.Query }> = [];
  for (const name of scenario.request.comps) out.push({ label: `search ${name}`, query: Q.searchAct(name, scenario.request.format) });
  out.push({ label: "rank_markets", query: Q.rankMarkets(compIds) });
  for (const city of [...scenario.playbookCities, scenario.request.home]) {
    out.push({ label: `rooms ${city}`, query: Q.findRooms(compIds, city, venueTags) });
    out.push({ label: `promo ${city}`, query: Q.findPromoPartners(compIds, city, promoTags) });
    out.push({ label: `demographics ${city}`, query: Q.whoShowsUp(compIds, city) });
    out.push({ label: `brands ${city}`, query: Q.localColor(compIds, city, "brand") });
    out.push({ label: `tv_shows ${city}`, query: Q.localColor(compIds, city, "tv_show") });
  }
  return out;
}

const queries = scenarioQueries();

test("the scenario produces the expected number of queries", () => {
  // 3 searches + 1 markets + 5 per city for 9 playbook cities and the home city.
  assert.equal(queries.length, 3 + 1 + 5 * (scenario.playbookCities.length + 1));
});

test("every scaffolded query hits a bundled fixture", () => {
  const misses = queries.filter(({ query }) => demoResolver(query.path, query.params) === undefined).map((q) => q.label);
  assert.deepEqual(misses, [], `no fixture for: ${misses.join(", ")}`);
});

test("hits return a response body the server can read", () => {
  // Shapes differ by endpoint (/search returns `results: [...]`, /v2/insights returns
  // `results: { entities }` or `results: { demographics }`), so check through the same accessor
  // the app uses rather than guessing an envelope.
  for (const { label, query } of queries) {
    const body = demoResolver(query.path, query.params) as any;
    assert.ok(body && typeof body === "object", `${label}: body is an object`);
    if (query.params["filter.type"] === "urn:demographics") {
      assert.ok(Array.isArray(body.results?.demographics), `${label}: results.demographics is an array`);
    } else {
      assert.ok(Array.isArray(entitiesOf(body)), `${label}: entitiesOf(body) is an array`);
    }
  }
});

test("a slightly different param misses", () => {
  for (const { label, query } of queries) {
    assert.equal(demoResolver(query.path, { ...query.params, take: 9 }), undefined, `${label} with take=9 should miss`);
  }
});

test("an unrelated request misses", () => {
  assert.equal(demoResolver("/v2/insights", { "filter.type": "urn:entity:movie" }), undefined);
  assert.equal(demoResolver("/search", { query: "Radiohead", types: "urn:entity:artist", take: 5 }), undefined);
});

test("comp order does not change the key", () => {
  const forward = Q.rankMarkets(compIds);
  const reversed = Q.rankMarkets([...compIds].reverse());
  assert.equal(canonicalUrl(forward.path, forward.params), canonicalUrl(reversed.path, reversed.params));
  assert.ok(demoResolver(reversed.path, reversed.params) !== undefined);
  assert.equal(reversed.params["signal.interests.entities"], idList(compIds));
});

test("user-typed city casing still hits (query builders normalize the city)", () => {
  const typed = Q.whoShowsUp(compIds, "asheville, nc");
  const canonical = Q.whoShowsUp(compIds, "Asheville, NC");
  assert.deepEqual(typed.params, canonical.params);
  assert.ok(demoResolver(typed.path, typed.params) !== undefined);
});

test("fixtureMeta reports provenance for hits and undefined for misses", () => {
  const q = Q.findRooms(compIds, "Asheville, NC", venueTags);
  const meta = fixtureMeta(q.path, q.params);
  assert.ok(meta, "meta for a hit");
  assert.equal(typeof meta.handAuthored, "boolean");
  assert.ok(meta.captured === null || typeof meta.captured === "string");
  assert.equal(fixtureMeta(q.path, { ...q.params, take: 9 }), undefined);
});

test("FIXTURE_NOTE summarizes the fixture set in one of the two documented forms", () => {
  const all = Object.values(fixtures);
  const anyHandAuthored = all.some((f) => f._handAuthored);
  if (anyHandAuthored) {
    assert.equal(FIXTURE_NOTE, "Recorded demo (pre-key placeholder)");
  } else {
    assert.match(FIXTURE_NOTE, /^Recorded demo \(captured \d{4}-\d{2}-\d{2}\)$/);
  }
});

test("the bundle is keyed by canonical URL and matches fixtures/qloo/index.json", () => {
  const index: Record<string, string> = readJson("../fixtures/qloo/index.json");
  assert.equal(fixtureCount, Object.keys(index).length);
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(index).sort());
  for (const [key, f] of Object.entries(fixtures)) {
    assert.equal(f.canonical, key, `fixture ${index[key]}: its canonical field should equal its index key`);
    assert.equal(canonicalUrl(f.query.path, f.query.params), key, `fixture ${index[key]}: query re-canonicalizes to its key`);
  }
  assert.ok(!Number.isNaN(Date.parse(generatedAt)), "generatedAt is a parseable timestamp");
});
