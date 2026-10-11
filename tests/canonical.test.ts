import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalUrl, normalizeCity, slug, idList, QLOO_BASE } from "../src/canonical.ts";
import * as Q from "../src/queries.ts";

// The canonical URL is the fixture key and the cache key, so it has to be the same string no
// matter how the params were assembled.

test("canonicalUrl sorts keys, lowercases them, trims values and encodes", () => {
  const u = canonicalUrl("/v2/insights", { "Filter.Type": "urn:entity:place", take: 5, "filter.location.query": " Austin, TX " });
  assert.equal(u, `${QLOO_BASE}/v2/insights?filter.location.query=Austin%2C%20TX&filter.type=urn%3Aentity%3Aplace&take=5`);
});

test("canonicalUrl omits empty, null and undefined params", () => {
  const u = canonicalUrl("/search", { query: "Big Thief", types: "", take: undefined, nil: null });
  assert.equal(u, `${QLOO_BASE}/search?query=Big%20Thief`);
  assert.equal(canonicalUrl("/v2/tags", {}), `${QLOO_BASE}/v2/tags`);
});

test("canonicalUrl is independent of param order", () => {
  const a = canonicalUrl("/v2/insights", { take: 8, "filter.type": "urn:entity:place", sort_by: "affinity" });
  const b = canonicalUrl("/v2/insights", { sort_by: "affinity", "filter.type": "urn:entity:place", take: 8 });
  assert.equal(a, b);
});

test("canonicalUrl adds the leading slash and accepts a custom base", () => {
  assert.equal(canonicalUrl("search", { q: "x" }), `${QLOO_BASE}/search?q=x`);
  assert.equal(canonicalUrl("/search", { q: "x" }, "https://example.test/"), "https://example.test/search?q=x");
});

test("canonicalUrl stringifies numbers and booleans the same way every time", () => {
  assert.equal(canonicalUrl("/x", { take: 50 }), canonicalUrl("/x", { take: "50" }));
  assert.equal(canonicalUrl("/x", { on: true }), `${QLOO_BASE}/x?on=true`);
});

test("normalizeCity title-cases the city and upper-cases the state", () => {
  assert.equal(normalizeCity("asheville, nc"), "Asheville, NC");
  assert.equal(normalizeCity("  new   york ,  ny "), "New York, NY");
  assert.equal(normalizeCity("ATHENS, oh"), "Athens, OH");
  assert.equal(normalizeCity("Austin"), "Austin");
  assert.equal(normalizeCity(""), "");
  assert.equal(normalizeCity(" , "), "");
});

test("slug lowercases, strips accents and collapses punctuation", () => {
  assert.equal(slug("Athens, OH"), "athens-oh");
  assert.equal(slug("  Big Thief "), "big-thief");
  assert.equal(slug("Saint-Étienne"), "saint-etienne");
  assert.equal(slug("Washington, DC"), "washington-dc");
  assert.equal(slug("hollow-pines"), "hollow-pines");
});

test("idList sorts, trims and de-duplicates so comp order never changes a key", () => {
  assert.equal(idList(["b", " a ", "c", "a"]), "a,b,c");
  assert.equal(idList(["c", "b", "a"]), idList(["a", "b", "c"]));
  assert.equal(idList([" ", ""]), "");
  assert.equal(idList([]), "");
});

// Every query builder must yield one stable canonical URL regardless of comp (or tag) order.
const comps = ["4F3A0B2C-0C2E-4E0C-9F1A-1B2C3D4E5F60", "7A9C1D3E-5F7B-4A9C-8D1E-2F3A4B5C6D71", "9B1D3F5A-7C9E-4B1D-AF3A-4B5C6D7E8F92"];
const tagsA = ["urn:tag:genre:place:music_venue", "urn:tag:category:place:live_music_venue", "urn:tag:genre:place:concert_hall"];
const shuffled = <T>(xs: T[]) => [xs[2], xs[0], xs[1]];
const key = (q: Q.Query) => canonicalUrl(q.path, q.params);

const builders: Array<[string, (ids: string[], tags: string[]) => Q.Query]> = [
  ["searchAct", () => Q.searchAct("Big Thief", "music")],
  ["findTags", () => Q.findTags("music venue")],
  ["rankMarkets", (ids) => Q.rankMarkets(ids)],
  ["findRooms", (ids, tags) => Q.findRooms(ids, "asheville, nc", tags)],
  ["findPromoPartners", (ids, tags) => Q.findPromoPartners(ids, "asheville, nc", tags)],
  ["whoShowsUp", (ids) => Q.whoShowsUp(ids, "asheville, nc")],
  ["localColor(brand)", (ids) => Q.localColor(ids, "asheville, nc", "brand")],
  ["localColor(tv_show)", (ids) => Q.localColor(ids, "asheville, nc", "tv_show")],
  ["openersToAsk", (ids) => Q.openersToAsk(ids, "asheville, nc")],
];

for (const [name, build] of builders) {
  test(`${name} yields a stable canonical URL regardless of comp order`, () => {
    const first = key(build(comps, tagsA));
    assert.equal(key(build(shuffled(comps), shuffled(tagsA))), first);
    assert.equal(key(build([...comps].reverse(), [...tagsA].reverse())), first);
    assert.ok(first.startsWith(QLOO_BASE + "/"), first);
    assert.ok(!/[A-Z]=/.test(first.split("?")[1] ?? ""), "param names are lowercase");
  });
}

test("city normalization feeds the key, so casing and spacing of the city do not change it", () => {
  const a = key(Q.findRooms(comps, "Asheville, NC", tagsA));
  const b = key(Q.findRooms(comps, "  asheville ,  nc", tagsA));
  assert.equal(a, b);
  assert.ok(a.includes("filter.location.query=Asheville%2C%20NC"));
});

test("rankMarkets reproduces the canonical recorded in the scaffolded fixture", () => {
  const fixture = JSON.parse(fs.readFileSync(new URL("../fixtures/qloo/markets-hollow-pines.json", import.meta.url), "utf8"));
  const q = Q.rankMarkets(shuffled(comps));
  assert.equal(key(q), fixture.canonical);
  assert.equal(canonicalUrl(fixture.query.path, fixture.query.params), fixture.canonical);
});
