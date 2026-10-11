import { test } from "node:test";
import assert from "node:assert/strict";
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
  ["rankMarkets", (ids, tags) => Q.rankMarkets(ids, tags)],
  ["findRooms", (ids, tags) => Q.findRooms(ids, "asheville, nc", tags)],
  ["findPromoGroup", (ids, tags) => Q.findPromoGroup(ids, "asheville, nc", tags)],
  ["whoShowsUp", (ids) => Q.whoShowsUp(ids)],
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

// ---- The shared interface: exact parameters per docs.qloo.com (checked by the other modules' owners) ----

test("rankMarkets is a nationwide place query grouped by city, not a locality query", () => {
  const q = Q.rankMarkets(shuffled(comps), shuffled(tagsA));
  assert.equal(q.tool, "rank_markets");
  assert.equal(q.path, "/v2/insights");
  assert.deepEqual(q.params, {
    "filter.type": "urn:entity:place",
    "filter.tags": idList(tagsA),
    "operator.filter.tags": "union",
    "filter.geocode.country_code": "US",
    "signal.interests.entities": idList(comps),
    "diversify.by": "properties.geocode.city",
    "diversify.take": 1,
    take: 50,
    "feature.explainability": "true",
  });
  assert.ok(!("filter.location.query" in q.params), "no location: the whole country is in scope");
});

test("findPromoGroup asks for two places of one kind near the city, with explainability", () => {
  const tags = ["urn:tag:genre:place:record_store"];
  const q = Q.findPromoGroup(comps, "asheville, nc", tags);
  assert.equal(q.tool, "find_promo_partners");
  assert.deepEqual(q.params, {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Asheville, NC",
    "filter.location.radius": 15000,
    "filter.tags": "urn:tag:genre:place:record_store",
    "operator.filter.tags": "union",
    "signal.interests.entities": idList(comps),
    sort_by: "affinity",
    take: 2,
    "feature.explainability": "true",
  });
  assert.ok(!("diversify.by" in q.params), "properties.subtype is not a valid diversify.by value");
  // Different kinds are different requests, so each has its own fixture and receipt.
  assert.notEqual(key(q), key(Q.findPromoGroup(comps, "asheville, nc", ["urn:tag:genre:place:bookstore"])));
});

test("whoShowsUp takes only the interest signals: location is not a documented demographics input", () => {
  const q = Q.whoShowsUp(shuffled(comps));
  assert.equal(q.tool, "who_shows_up");
  assert.deepEqual(q.params, { "filter.type": "urn:demographics", "signal.interests.entities": idList(comps) });
  assert.equal(key(q), `${QLOO_BASE}/v2/insights?filter.type=urn%3Ademographics&signal.interests.entities=${encodeURIComponent(idList(comps))}`);
});

test("the old per-city promo and locality builders are gone", () => {
  assert.equal((Q as Record<string, unknown>).findPromoPartners, undefined);
  assert.ok(!JSON.stringify(Q.rankMarkets(comps, tagsA).params).includes("urn:entity:locality"));
});

test("findRooms, localColor, searchAct, findTags and openersToAsk are unchanged", () => {
  assert.deepEqual(Q.findRooms(comps, "Boone, NC", tagsA).params, {
    "filter.type": "urn:entity:place",
    "filter.location.query": "Boone, NC",
    "filter.location.radius": 15000,
    "filter.tags": idList(tagsA),
    "operator.filter.tags": "union",
    "signal.interests.entities": idList(comps),
    sort_by: "affinity",
    take: 8,
    "feature.explainability": "true",
  });
  assert.deepEqual(Q.localColor(comps, "Boone, NC", "tv_show").params, {
    "filter.type": "urn:entity:tv_show",
    "signal.interests.entities": idList(comps),
    "signal.location.query": "Boone, NC",
    "signal.location.radius": 25000,
    take: 20,
  });
  assert.deepEqual(Q.searchAct(" Big Thief ", "comedy").params, { query: "Big Thief", types: "urn:entity:person", take: 5 });
  assert.deepEqual(Q.findTags(" dive bar ").params, { "filter.query": "dive bar", take: 10 });
  assert.equal(Q.openersToAsk(comps, "Boone, NC").params["filter.popularity.max"], 0.6);
  assert.deepEqual([...Q.PROMO_TAG_GROUPS], ["record_store", "coffee_shop", "bookstore", "dive_bar", "vintage"]);
  assert.deepEqual(Object.keys(Q.PROMO_KIND_LABEL), ["record_store", "coffee_shop", "bookstore", "dive_bar", "vintage"]);
});
