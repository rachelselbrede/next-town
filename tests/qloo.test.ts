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
  assert.deepEqual(rec.why, ["Willie Nelson (62%)", "entity A2 (30%)"]);
  assert.deepEqual(rec.tagIds, ["urn:tag:genre:restaurant:bbq", "Casual"]);
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

// ---- Real explainability shape and the live-call policy ----
import { explainEntries, explainChips, resetQlooCache } from "../src/qloo.ts";

test("explainability: the documented array shape maps ids to comp names, strongest first", () => {
  const ex = { "signal.interests.entities": [{ entity_id: "B", score: 0.32 }, { entity_id: "A", score: 0.51 }] };
  assert.deepEqual(explainChips(ex, { A: "Big Thief", B: "Waxahatchee" }), ["Big Thief (51%)", "Waxahatchee (32%)"]);
  assert.deepEqual(explainChips(ex), ["entity A (51%)", "entity B (32%)"]);
  assert.deepEqual(explainEntries(null), []);
});

test("explainability: top-level subset averages use the 'all' subset", () => {
  const ex = { "signal.interests.entities": [{ entity_id: "A", top_3: 0.9, all: 0.6 }, { entity_id: "B", subsets: { all: 0.7 } }] };
  assert.deepEqual(explainEntries(ex, { A: "a", B: "b" }).map((i) => [i.name, i.score]), [["b", 0.7], ["a", 0.6]]);
});

test("normalize reads coordinates from location", () => {
  const rec = normalize({ entity_id: "1", name: "x", location: { lat: 35.6, lon: -82.5 }, properties: { geocode: { city: "Asheville", admin1_region: "NC" } } });
  assert.equal(rec.lat, 35.6);
  assert.equal(rec.lon, -82.5);
  assert.equal(rec.region, "NC");
});

async function withFetch(impl: (url: string, init: any) => Promise<Response>, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = impl as any;
  resetQlooCache();
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
    resetQlooCache();
  }
}

test("live: retries a 429, then caches the answer privately", async () => {
  let calls = 0;
  await withFetch(
    async () => (++calls === 1 ? new Response("slow down", { status: 429 }) : new Response(JSON.stringify({ results: { entities: [{ entity_id: "1", name: "Room" }] } }), { status: 200 })),
    async () => {
      const c = new QlooClient({ QLOO_API_KEY: "k" });
      const a = await c.get("/v2/insights", { "filter.type": "urn:entity:place", take: 1 });
      assert.equal(a.ok, true);
      assert.equal(calls, 2);
      const b = await c.get("/v2/insights", { take: 1, "filter.type": "urn:entity:place" }); // same request, other param order
      assert.equal(b.cached, true);
      assert.equal(calls, 2);
    },
  );
});

test("live: a failing call falls back to the recorded fixture and says so", async () => {
  await withFetch(
    async () => new Response("boom", { status: 503 }),
    async () => {
      const c = new QlooClient({ QLOO_API_KEY: "k" }, () => ({ results: { entities: [{ entity_id: "f", name: "Fixture" }] } }));
      const r = await c.get("/v2/insights", { "filter.type": "urn:entity:place" });
      assert.equal(r.ok, true);
      assert.equal(r.mode, "demo");
      assert.match(r.note ?? "", /HTTP 503.*recorded fixture/);
    },
  );
});

test("live: a 4xx is not retried and has no fallback when no fixture exists", async () => {
  let calls = 0;
  await withFetch(
    async () => (calls++, new Response(JSON.stringify({ error: "bad" }), { status: 400 })),
    async () => {
      const c = new QlooClient({ QLOO_API_KEY: "k" });
      const r = await c.get("/v2/insights", { "filter.type": "urn:entity:place" });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.equal(calls, 1);
    },
  );
});

test("live: the caller's abort stops the request without a fallback", async () => {
  await withFetch(
    (_url, init) =>
      new Promise((_, reject) => {
        if (init.signal.aborted) return reject(init.signal.reason);
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
    async () => {
      const c = new QlooClient({ QLOO_API_KEY: "k" }, () => ({ results: [] }));
      const ac = new AbortController();
      const p = c.get("/search", { query: "x" }, ac.signal);
      ac.abort();
      await assert.rejects(p);
    },
  );
});
