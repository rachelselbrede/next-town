import { test } from "node:test";
import assert from "node:assert/strict";
import { QlooClient, normalize, normalizeAll, entitiesOf, asEntityType } from "../src/qloo.ts";

test("mode: auto picks live only when a key is present", () => {
  assert.equal(new QlooClient({}).mode, "demo");
  assert.equal(new QlooClient({ QLOO_API_KEY: "k" }).mode, "live");
  assert.equal(new QlooClient({ QLOO_API_KEY: "k", QLOO_MODE: "demo" }).mode, "demo");
  assert.equal(new QlooClient({ QLOO_MODE: "live" }).mode, "live");
});

test("url builder encodes params and drops empties", () => {
  const c = new QlooClient({});
  const u = c.url("/v2/insights", { "filter.type": "urn:entity:place", "filter.location.query": "Austin, TX", take: 5, empty: "", nil: null, undef: undefined });
  assert.ok(u.startsWith("https://hackathon.api.qloo.com/v2/insights?"));
  assert.ok(u.includes("filter.type=urn%3Aentity%3Aplace"));
  assert.ok(u.includes("filter.location.query=Austin%2C+TX") || u.includes("filter.location.query=Austin%2C%20TX"));
  assert.ok(u.includes("take=5"));
  assert.ok(!u.includes("empty=") && !u.includes("nil=") && !u.includes("undef="));
});

test("demo mode serves fixtures and records the call", async () => {
  const c = new QlooClient({}, (path, params) => (path === "/search" ? { results: [{ entity_id: "x", name: String(params.query) }] } : undefined));
  const r = await c.search("Radiohead");
  assert.equal(r.ok, true);
  assert.equal(r.mode, "demo");
  assert.equal(r.body.results[0].name, "Radiohead");
  const miss = await c.get("/v2/nothing", {});
  assert.equal(miss.ok, false);
  assert.equal(c.calls.length, 2);
});

test("entitiesOf handles the documented response shapes", () => {
  assert.deepEqual(entitiesOf({ results: { entities: [{ entity_id: "1", name: "a" }] } }).map((e) => e.name), ["a"]);
  assert.deepEqual(entitiesOf({ results: [{ entity_id: "1", name: "b" }] }).map((e) => e.name), ["b"]);
  assert.deepEqual(entitiesOf(null), []);
});

test("normalize flattens properties, tags and explainability", () => {
  const rec = normalize({
    entity_id: "E1",
    name: "Franklin Barbecue",
    type: "urn:entity:place",
    subtype: "urn:entity:place:restaurant",
    popularity: 0.97,
    properties: { address: "900 E 11th St", geocode: { city: "Austin" }, business_rating: 4.7, price_level: 2, description: "Legendary brisket line.", image: { url: "https://img/x.jpg" } },
    tags: [{ name: "Barbecue", id: "urn:tag:genre:restaurant:bbq" }, "Casual"],
    query: { affinity: 0.91, explainability: { by_entity: { A1: { name: "Willie Nelson", score: 0.62 }, A2: 0.3 } } },
  });
  assert.equal(rec.id, "E1");
  assert.equal(rec.city, "Austin");
  assert.equal(rec.rating, 4.7);
  assert.equal(rec.price_level, 2);
  assert.equal(rec.image, "https://img/x.jpg");
  assert.deepEqual(rec.tags, ["Barbecue", "Casual"]);
  assert.equal(rec.affinity, 0.91);
  assert.deepEqual(rec.why, ["Willie Nelson (62%)", "A2 (30%)"]);
  assert.equal(rec.raw, undefined);
});

test("normalizeAll caps results", () => {
  const body = { results: { entities: Array.from({ length: 30 }, (_, i) => ({ entity_id: String(i), name: "n" + i })) } };
  assert.equal(normalizeAll(body, 7).length, 7);
});

test("asEntityType accepts bare and urn forms", () => {
  assert.equal(asEntityType("place"), "urn:entity:place");
  assert.equal(asEntityType("urn:entity:book"), "urn:entity:book");
  assert.equal(asEntityType("unicorn"), undefined);
});
