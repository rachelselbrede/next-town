// The demo must never miss: every request the Hollow Pines scenario can make has a bundled fixture.
// This re-derives the exact query list the same way scripts/scaffold-fixtures.mjs does (same scenario
// file, same tag groups, same query builders), so if a builder or the scenario changes without
// re-running `npm run prepare:data`, this test is what fails. A fixture whose response is still an
// empty skeleton counts as a hit: the body is defined and in the documented envelope.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as Q from "../src/queries.ts";
import { canonicalUrl, idList, slug } from "../src/canonical.ts";
import { entitiesOf } from "../src/qloo.ts";
import { demoResolver, describeFixtures, fixtureMeta, FIXTURE_NOTE, PLACEHOLDER_NOTE } from "../src/demo/resolver.ts";
import { fixtures, fixtureCount, generatedAt, privateCount, provenance } from "../src/demo/fixtures.generated.ts";

const readJson = (rel: string) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const scenario = readJson("../data/scenarios/hollow-pines.json");
const tagGroups: Record<string, string[]> = readJson("../data/tags.json").groups;

const compIds: string[] = scenario.comps.map((c: { id: string }) => c.id);
const format: "music" | "comedy" = scenario.request.format;
const venueTags = (format === "comedy" ? Q.COMEDY_TAG_GROUPS : Q.VENUE_TAG_GROUPS).flatMap((g) => tagGroups[g] ?? []);

// Every city the scenario builds a playbook for, de-duplicated by slug, home last (as the scaffold does).
function scenarioCities(): string[] {
  const cities: string[] = [];
  for (const city of [...scenario.playbookCities, scenario.request.home]) {
    if (!cities.some((c) => slug(c) === slug(city))) cities.push(city);
  }
  return cities;
}

// Mirrors the `plan` array in scripts/scaffold-fixtures.mjs, file names included.
function scenarioQueries(): Array<{ label: string; file: string; query: Q.Query }> {
  const out: Array<{ label: string; file: string; query: Q.Query }> = [];
  for (const name of scenario.request.comps) out.push({ label: `search ${name}`, file: `search-${slug(name)}.json`, query: Q.searchAct(name, format) });
  out.push({ label: "rank_markets", file: `markets-${scenario.id}.json`, query: Q.rankMarkets(compIds, venueTags) });
  out.push({ label: "who_shows_up (comps overall)", file: "demographics-overall.json", query: Q.whoShowsUp(compIds) });
  for (const city of scenarioCities()) {
    const s = slug(city);
    out.push({ label: `rooms ${city}`, file: `rooms-${s}.json`, query: Q.findRooms(compIds, city, venueTags) });
    for (const group of Q.PROMO_TAG_GROUPS) {
      out.push({ label: `promo ${group} ${city}`, file: `promo-${group.replace(/_/g, "-")}-${s}.json`, query: Q.findPromoGroup(compIds, city, tagGroups[group] ?? []) });
    }
    out.push({ label: `brands ${city}`, file: `brands-${s}.json`, query: Q.localColor(compIds, city, "brand") });
    out.push({ label: `tv_shows ${city}`, file: `tvshows-${s}.json`, query: Q.localColor(compIds, city, "tv_show") });
  }
  return out;
}

const queries = scenarioQueries();
const NEW_CITIES = ["Lancaster, PA", "Washington, DC", "Cincinnati, OH", "Brooklyn, NY", "Ithaca, NY", "Northampton, MA"];

test("the scenario produces the expected number of queries", () => {
  // 3 searches + 1 markets + 1 demographics + 8 per city (rooms, 5 promo groups, brands, tv shows)
  // for every playbook city and the home city.
  const cities = scenarioCities().length;
  assert.equal(cities, scenario.playbookCities.length + 1);
  assert.equal(queries.length, 3 + 1 + 1 + 8 * cities);
});

test("the scenario covers the six single-drop cities", () => {
  for (const city of NEW_CITIES) assert.ok(scenario.playbookCities.includes(city), `${city} is a playbook city`);
});

test("every scaffolded query hits a bundled fixture", () => {
  const misses = queries.filter(({ query }) => demoResolver(query.path, query.params) === undefined).map((q) => q.label);
  assert.deepEqual(misses, [], `no fixture for: ${misses.join(", ")}`);
});

test("hits return a response body the server can read", () => {
  // Shapes differ by endpoint (/search returns `results: [...]`, /v2/insights returns
  // `results: { entities }` or `results: { demographics }`), so check through the same accessor
  // the app uses rather than guessing an envelope. Empty skeletons pass; a missing body does not.
  for (const { label, query } of queries) {
    const body = demoResolver(query.path, query.params) as any;
    assert.ok(body && typeof body === "object", `${label}: body is an object`);
    if (query.path === "/search") {
      assert.ok(Array.isArray(body.results), `${label}: results is an array`);
    } else if (query.params["filter.type"] === "urn:demographics") {
      assert.ok(Array.isArray(body.results?.demographics), `${label}: results.demographics is an array`);
    } else {
      assert.ok(Array.isArray(entitiesOf(body)), `${label}: entitiesOf(body) is an array`);
    }
  }
});

test("each scaffolded query is answered by the file the scaffold names, keyed by its own canonical URL", () => {
  for (const { label, file, query } of queries) {
    const key = canonicalUrl(query.path, query.params);
    const p = provenance[key];
    assert.ok(p, `${label}: provenance for ${key}`);
    assert.equal(p.file, file, `${label}: served by ${file}`);
    assert.equal(fixtures[key].canonical, key, `${label}: ${file} declares its own key`);
    assert.equal(canonicalUrl(fixtures[key].query.path, fixtures[key].query.params), key, `${label}: ${file} re-canonicalizes to its key`);
    assert.equal(fixtures[key].tool, query.tool, `${label}: ${file} names the tool that sends it`);
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
  const forward = Q.rankMarkets(compIds, venueTags);
  const reversed = Q.rankMarkets([...compIds].reverse(), [...venueTags].reverse());
  assert.equal(canonicalUrl(forward.path, forward.params), canonicalUrl(reversed.path, reversed.params));
  assert.ok(demoResolver(reversed.path, reversed.params) !== undefined);
  assert.equal(reversed.params["signal.interests.entities"], idList(compIds));
});

test("user-typed city casing still hits (query builders normalize the city)", () => {
  const typed = Q.findRooms(compIds, "asheville, nc", venueTags);
  const canonical = Q.findRooms(compIds, "Asheville, NC", venueTags);
  assert.deepEqual(typed.params, canonical.params);
  assert.ok(demoResolver(typed.path, typed.params) !== undefined);
  const promoTyped = Q.findPromoGroup(compIds, "ITHACA, ny", tagGroups.record_store);
  assert.ok(demoResolver(promoTyped.path, promoTyped.params) !== undefined);
});

test("demographics is one shared read, not per city", () => {
  const q = Q.whoShowsUp(compIds);
  assert.equal(q.params["signal.location.query"], undefined);
  assert.equal(q.params["signal.location.radius"], undefined);
  assert.equal(provenance[canonicalUrl(q.path, q.params)]?.file, "demographics-overall.json");
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
    assert.equal(FIXTURE_NOTE, "Recorded demo · placeholder Qloo data");
    assert.equal(FIXTURE_NOTE, PLACEHOLDER_NOTE);
    assert.match(FIXTURE_NOTE, /placeholder/); // the frontend keys its disclosure on this word
  } else {
    assert.match(FIXTURE_NOTE, /^Recorded demo · Qloo data captured \d{4}-\d{2}-\d{2}$/);
  }
  // The rule itself, independent of what is bundled right now.
  assert.equal(describeFixtures([]), PLACEHOLDER_NOTE);
  assert.equal(describeFixtures([{ _handAuthored: true, _captured: null }, { _handAuthored: false, _captured: "2026-10-20T10:00:00Z" }]), PLACEHOLDER_NOTE);
  assert.equal(describeFixtures([{ _handAuthored: false, _captured: "2026-10-20T10:00:00Z" }, { _handAuthored: false, _captured: "2026-10-22T10:00:00Z" }]), "Recorded demo · Qloo data captured 2026-10-22");
});

test("the bundle is keyed by canonical URL and carries every public fixture from fixtures/qloo/index.json", () => {
  const index: Record<string, string> = readJson("../fixtures/qloo/index.json");
  assert.equal(fixtureCount, Object.keys(fixtures).length);
  assert.equal(Object.keys(provenance).length, fixtureCount);
  // Every public key is bundled. With a private/qloo overlay (live captures, gitignored) the bundle may
  // hold extra keys (live comp ids); without one it is exactly the public index.
  for (const key of Object.keys(index)) assert.ok(fixtures[key], `public fixture ${index[key]} is bundled`);
  if (privateCount === 0) {
    assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(index).sort());
    for (const p of Object.values(provenance)) assert.equal(p.source, "public");
  }
  for (const [key, p] of Object.entries(provenance)) {
    assert.equal(p.handAuthored, fixtures[key]._handAuthored, `${p.file}: provenance flag matches the file`);
    assert.equal(p.captured, fixtures[key]._captured, `${p.file}: capture date matches the file`);
  }
  assert.ok(!Number.isNaN(Date.parse(generatedAt)), "generatedAt is a parseable timestamp");
});

test("public fixtures are placeholders only (data rule): no live capture is ever committed", () => {
  // fixtures/qloo is the committed, public set. A captured response there would violate Qloo's
  // "do not store response data in a public repository"; captures belong in private/qloo.
  // Read from disk, not from the bundle, so a local private overlay cannot mask a public file.
  const index: Record<string, string> = readJson("../fixtures/qloo/index.json");
  for (const file of new Set(Object.values(index))) {
    const f = readJson(`../fixtures/qloo/${file}`);
    assert.equal(f._handAuthored, true, `fixtures/qloo/${file} must be hand-authored`);
    assert.equal(f._captured, null, `fixtures/qloo/${file} must not carry a capture date`);
  }
});
