// Request validation and the three agent tools, driven by a stub Qloo client (demo mode with an
// inline resolver) and a stub Census lookup. Synthetic bodies follow Qloo's documented shapes:
// insights entities are type "urn:entity" with a subtype, tags are { id, name, type }, /search
// results carry `types: [...]`, and explainability is `{ "signal.interests.entities": [{ entity_id, score }] }`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { QlooClient, type QlooResult } from "../src/qloo.ts";
import type { AgentEvent, ToolContext } from "../src/agent.ts";
import { makeTools, toReceipt, resolvedLocality, topLevelExplainSentence, venueToLocality, tagsFor } from "../src/tools.ts";
import { parseRunRequest, buildApp } from "../src/app.ts";
import { demoResolver } from "../src/demo/resolver.ts";
import { findPlace as realFindPlace, type PlaceRow } from "../src/places.ts";
import * as Q from "../src/queries.ts";

// ---- parseRunRequest ----

const good = { comps: ["Big Thief", "Waxahatchee"], home: "Richmond, VA", days: 12, driveHoursCap: 6, format: "music" };

test("parseRunRequest accepts a valid body and trims names", () => {
  const r = parseRunRequest({ ...good, comps: [" Big Thief ", "Waxahatchee"], scenarioId: "hollow-pines", recorded: true });
  assert.ok(r.ok);
  assert.deepEqual(r.value, { comps: ["Big Thief", "Waxahatchee"], home: "Richmond, VA", days: 12, driveHoursCap: 6, format: "music", scenarioId: "hollow-pines", recorded: true });
});

test("parseRunRequest defaults format to music and leaves optional fields out", () => {
  const r = parseRunRequest({ ...good, format: undefined });
  assert.ok(r.ok);
  assert.equal(r.value.format, "music");
  assert.ok(!("scenarioId" in r.value) && !("recorded" in r.value));
});

test("parseRunRequest rejects bad bodies with a specific message", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    ["x", /JSON object/],
    [{ ...good, comps: [] }, /1 to 3/],
    [{ ...good, comps: ["a", "b", "c", "d"] }, /1 to 3/],
    [{ ...good, comps: ["a", ""] }, /non-empty/],
    [{ ...good, comps: ["x".repeat(81)] }, /80 characters/],
    [{ ...good, home: "" }, /home is required/],
    [{ ...good, days: 2 }, /3 to 21/],
    [{ ...good, days: 22 }, /3 to 21/],
    [{ ...good, days: 7.5 }, /3 to 21/],
    [{ ...good, driveHoursCap: 1 }, /2 and 10/],
    [{ ...good, driveHoursCap: "lots" }, /2 and 10/],
    [{ ...good, format: "opera" }, /music.*comedy/],
    [{ ...good, scenarioId: 7 }, /scenarioId/],
    [{ ...good, recorded: "yes" }, /recorded/],
  ];
  for (const [body, re] of cases) {
    const r = parseRunRequest(body);
    assert.equal(r.ok, false, JSON.stringify(body));
    if (!r.ok) assert.match(r.error, re);
  }
});

// ---- stub Qloo + stub Census ----

// /search results: `types` is an array and there is no `type` field.
const ARTIST = (id: string, name: string, popularity: number) => ({ entity_id: id, name, types: ["urn:entity:artist"], popularity, properties: {}, tags: [] });

// An insights place entity: a live-music room standing for its town.
const VENUE = (id: string, name: string, city: string, state: string, affinity: number, lat: number, lon: number, scores: Array<[string, number]> = [["A1", 0.7]]) => ({
  entity_id: id,
  name,
  type: "urn:entity",
  subtype: "urn:entity:place",
  popularity: 0.5,
  location: { lat, lon },
  properties: { address: `1 Main St, ${city}, ${state}`, geocode: { name: city, city, admin1_region: state, country_code: "US" } },
  tags: [{ id: "urn:tag:genre:place:music_venue", name: "Music Venue", type: "urn:tag:genre:place" }],
  query: { affinity, explainability: { "signal.interests.entities": scores.map(([entity_id, score]) => ({ entity_id, score })) } },
});

const MARKETS_BODY = {
  success: true,
  query: { explainability: { "signal.interests.entities": [{ entity_id: "A1", score: { top_10: 0.72, all: 0.66 } }] } },
  results: {
    entities: [
      VENUE("V1", "The Barn", "Smallville", "VA", 0.95, 37.51, -78.51),
      VENUE("V2", "Big Hall", "Bigcity", "VA", 0.9, 38.01, -77.01),
      VENUE("V3", "The Basement", "Nashville", "TN", 0.85, 36.17, -86.79),
      VENUE("V4", "Nowhere Tavern", "Nowhere", "ZZ", 0.8, 36.5, -79.0), // not in the Census stub
      VENUE("V5", "Second Barn", "Smallville", "VA", 0.78, 37.52, -78.52), // same town again: must collapse
      VENUE("V6", "Hill Hall", "Hilltown", "VA", 0.75, 37.01, -80.01),
    ],
  },
};

const stubResolver = (path: string, params: Record<string, unknown>) => {
  if (path === "/search") {
    const q = String(params.query);
    if (q === "Comp One") return { results: [ARTIST("A1", "Comp One", 0.9), ARTIST("A2", "Comp One Tribute", 0.3), { entity_id: "P1", name: "Comp One", types: ["urn:entity:person"] }, ARTIST("A3", "Comp Oneder", 0.5), ARTIST("A4", "Compote", 0.1)] };
    if (q === "Comp Two") return { results: [{ entity_id: "B1", name: "Comp Two", type: "urn:entity:artist", popularity: 0.6 }] }; // older shape with `type`
    if (q === "Nobody") return { results: [] };
    return undefined;
  }
  if (path === "/v2/insights" && params["filter.type"] === "urn:entity:place" && params["diversify.by"] === "properties.geocode.city" && params["signal.interests.entities"] === "A1") {
    return MARKETS_BODY;
  }
  return undefined;
};

const census: Record<string, PlaceRow> = {
  "richmond, va": { label: "Richmond, VA", name: "Richmond", state: "VA", population: 226610, lat: 37.5295, lon: -77.4756 },
  "smallville, va": { label: "Smallville, VA", name: "Smallville", state: "VA", population: 40000, lat: 37.5, lon: -78.5 },
  "bigcity, va": { label: "Bigcity, VA", name: "Bigcity", state: "VA", population: 900000, lat: 38.0, lon: -77.0 },
  "nashville, tn": { label: "Nashville, TN", name: "Nashville", state: "TN", population: 689447, lat: 36.16, lon: -86.78 },
  "hilltown, va": { label: "Hilltown, VA", name: "Hilltown", state: "VA", population: 12000, lat: 37.0, lon: -80.0 },
};
const stubFindPlace = (label: string) => census[label.trim().toLowerCase()];

function harness(findPlace = stubFindPlace, resolver = stubResolver, qlooOverride?: QlooClient) {
  const qloo = qlooOverride ?? new QlooClient({}, resolver as any);
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { emit: (e) => events.push(e) };
  const { tools, state } = makeTools({ qloo, format: "music", home: "Richmond, VA", days: 7, driveHoursCap: 5, findPlace });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { qloo, events, ctx, tools, state, byName };
}

// A QlooClient stand-in whose every call returns one fixed result (for live-failure paths).
function fixedClient(result: Partial<QlooResult>): QlooClient {
  const base: QlooResult = { ok: true, status: 200, mode: "live", path: "/x", params: {}, url: "https://hackathon.api.qloo.com/x", ms: 1, body: {} };
  return { mode: result.mode ?? "live", calls: [], get: async () => ({ ...base, ...result }) } as unknown as QlooClient;
}

test("tool schemas are strict-compatible: additionalProperties false and every property required", () => {
  const { tools } = harness();
  assert.deepEqual(tools.map((t) => t.name), ["resolve_act", "rank_markets", "plan_route"]);
  for (const t of tools) {
    const s = t.input_schema as any;
    assert.equal(s.type, "object");
    assert.equal(s.additionalProperties, false, t.name);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), `${t.name} requires every property`);
  }
});

// ---- resolve_act ----

test("resolve_act reads the type from `types` (array) or `type`, keeps the wanted type, caps at 3, emits comps + receipt", async () => {
  const h = harness();
  const out: any = await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  assert.deepEqual(out.candidates.map((c: any) => c.name), ["Comp One", "Comp One Tribute", "Comp Oneder"]);
  assert.ok(out.candidates.every((c: any) => c.type === "urn:entity:artist"));
  assert.equal(out.qloo.tool, "resolve_act");
  assert.equal(out.qloo.mode, "demo");
  assert.equal(out.qloo.status, 200);
  assert.equal(out.qloo.resultCount, 5);
  assert.match(out.qloo.url, /\/search\?/);
  assert.match(out.summary, /3 candidates/);
  assert.deepEqual(h.events.map((e) => e.type), ["receipt", "comps"]);
  assert.equal((h.events[1] as any).comps[0].id, "A1", "running list holds the exact-name, most popular match");
  assert.equal(h.state.receipts.length, 1);

  const two: any = await h.byName.resolve_act.run({ name: "Comp Two" }, h.ctx);
  assert.deepEqual(two.candidates, [{ id: "B1", name: "Comp Two", type: "urn:entity:artist", popularity: 0.6 }]);
});

test("resolve_act with an empty recorded answer never claims Qloo does not know the act", async () => {
  const h = harness();
  const out: any = await h.byName.resolve_act.run({ name: "Nobody" }, h.ctx);
  assert.deepEqual(out.candidates, []);
  assert.match(out.summary, /recorded demo answer for "Nobody"/);
  assert.doesNotMatch(out.summary, /found no|not found|does not know/i);
});

test("resolve_act in demo mode with no fixture throws an honest error (Qloo was not called)", async () => {
  const h = harness();
  await assert.rejects(h.byName.resolve_act.run({ name: "Unknown Act" }, h.ctx), /No recorded demo answer for "Unknown Act" \(Qloo was not called; the live key is not set\)/);
  assert.equal(h.state.receipts.length, 1, "the miss still leaves a receipt");
  assert.equal(h.state.receipts[0].status, 404);
});

test("resolve_act reports a live failure by status and an empty live 200 as Qloo's answer", async () => {
  const failed = harness(stubFindPlace, stubResolver, fixedClient({ ok: false, status: 502, body: { error: "bad gateway" } }));
  await assert.rejects(failed.byName.resolve_act.run({ name: "Big Thief" }, failed.ctx), /Qloo search failed \(HTTP 502\)/);
  const empty = harness(stubFindPlace, stubResolver, fixedClient({ ok: true, status: 200, body: { results: [] } }));
  const out: any = await empty.byName.resolve_act.run({ name: "Big Thief" }, empty.ctx);
  assert.match(out.summary, /Qloo found no artist named "Big Thief"/);
});

test("tools pass the request's abort signal to every Qloo call", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const client = {
    mode: "demo",
    calls: [],
    get: async (path: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      seen.push(signal);
      const body = stubResolver(path, params);
      return { ok: body !== undefined, status: body ? 200 : 404, mode: "demo", path, params, url: "u", ms: 0, body: body ?? { error: "no demo fixture for this request" } };
    },
  } as unknown as QlooClient;
  const h = harness(stubFindPlace, stubResolver, client);
  const ac = new AbortController();
  const ctx: ToolContext = { emit: () => {}, signal: ac.signal };
  await h.byName.resolve_act.run({ name: "Comp One" }, ctx);
  await h.byName.rank_markets.run({ compIds: ["A1"] }, ctx);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s === ac.signal));
});

// ---- rank_markets ----

test("rank_markets turns venue results into towns: Census join, topRoom, explainability names, de-duplicated labels", async () => {
  const h = harness();
  await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  h.events.length = 0;
  const out: any = await h.byName.rank_markets.run({ compIds: ["A1"] }, h.ctx);
  assert.equal(out.qloo.tool, "rank_markets");
  assert.match(out.qloo.url, /filter\.type=urn%3Aentity%3Aplace/);
  assert.match(out.qloo.url, /diversify\.by=properties\.geocode\.city/);
  assert.ok(out.qloo.url.includes(encodeURIComponent(tagsFor(Q.VENUE_TAG_GROUPS)[0])), "venue tag ids from data/tags.json");

  assert.equal(out.localities.length, 5, "six venues, one duplicate town");
  const [l1, l2, l3, l4, l5] = out.localities;
  assert.equal(l1.label, "Smallville, VA");
  assert.equal(l1.rank, 1);
  assert.equal(l1.id, "V1", "the venue's entity id stands for the town");
  assert.equal(l1.population, 40000);
  assert.equal(l1.lat, 37.5, "Census coordinates win when the town is known");
  assert.equal(l1.overIndex, true);
  assert.equal(l1.affinity, 0.95);
  assert.deepEqual(l1.why, ["Comp One (70%)"], "chips carry the resolved comp's name, not its id");
  assert.deepEqual(l1.topRoom, { id: "V1", name: "The Barn", affinity: 0.95, why: ["Comp One (70%)"] });
  assert.equal(l2.overIndex, false, "900k people is not a small town");
  assert.equal(l3.label, "Nashville, TN");
  assert.equal(l4.label, "Nowhere, ZZ");
  assert.equal(l4.population, undefined, "unknown place keeps the venue's coordinates but no population");
  assert.equal(l4.lat, 36.5);
  assert.equal(l4.overIndex, false);
  assert.equal(l5.label, "Hilltown, VA");
  assert.equal(l5.rank, 5, "ranks stay contiguous after the duplicate is dropped");
  assert.ok(!out.localities.some((l: any) => l.topRoom?.name === "Second Barn"));

  assert.match(out.summary, /5 towns ranked/);
  assert.match(out.summary, /best-matching room ranks highest/);
  assert.match(out.summary, /Comp One drives most of the top markets\./, "one sentence from the top-level explainability");
  assert.match(out.summary, /Smallville, VA #1 \(95%, The Barn\)/);
  assert.match(out.summary, /Usual suspects: Nashville, TN #3/);
  assert.deepEqual(h.events.map((e) => e.type), ["comps", "receipt", "markets"]);
  assert.deepEqual(h.state.comps, [{ id: "A1", name: "Comp One", type: "urn:entity:artist", popularity: 0.9 }]);
  assert.equal(h.state.localities.length, 5);
});

test("rank_markets skips the explainability sentence when the top level is a warning", async () => {
  const resolver = (path: string, params: Record<string, unknown>) => {
    const body = stubResolver(path, params);
    if (body === MARKETS_BODY) return { ...MARKETS_BODY, query: { explainability: { warning: "Explainability is unavailable for this query." } } };
    return body;
  };
  const h = harness(stubFindPlace, resolver);
  await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  const out: any = await h.byName.rank_markets.run({ compIds: ["A1"] }, h.ctx);
  assert.doesNotMatch(out.summary, /drives most/);
  assert.equal(out.localities.length, 5);
});

test("venueToLocality accepts full state names through the real Census lookup", () => {
  const loc = venueToLocality(VENUE("V9", "Boone Saloon", "Boone", "North Carolina", 0.8, 36.21, -81.67) as any, 3, realFindPlace, { A1: "Comp One" });
  assert.equal(loc.label, "Boone, NC");
  assert.equal(loc.state, "NC");
  assert.equal(typeof loc.population, "number");
  assert.equal(loc.overIndex, true);
  const stl = venueToLocality(VENUE("V10", "Off Broadway", "Saint Louis", "MO", 0.8, 38.6, -90.2) as any, 1, realFindPlace);
  assert.equal(stl.label, "St. Louis, MO", "Census spelling becomes the canonical label");
  assert.equal(stl.overIndex, false, "St. Louis is over 250k");
  assert.deepEqual(stl.why, ["entity A1 (70%)"], "without a names map the chip falls back to the id");
});

test("topLevelExplainSentence names the leading comp, or both when they tie", () => {
  const names = { A1: "Comp One", B1: "Comp Two" };
  const list = (a: number, b: number) => ({ query: { explainability: { "signal.interests.entities": [{ entity_id: "A1", score: a }, { entity_id: "B1", score: b }] } } });
  assert.equal(topLevelExplainSentence(list(0.7, 0.4), names), "Comp One drives most of the top markets.");
  assert.equal(topLevelExplainSentence(list(0.4, 0.7), names), "Comp Two drives most of the top markets.");
  assert.equal(topLevelExplainSentence(list(0.5, 0.49), names), "Comp One and Comp Two drive the top markets about equally.");
  assert.equal(topLevelExplainSentence({ query: {} }, names), undefined);
  // The map form ({ "<id>": { top_10, all } }) and a warning.
  assert.equal(topLevelExplainSentence({ query: { explainability: { "signal.interests.entities": { A1: { top_10: 0.3, all: 0.2 }, B1: { top_10: 0.8, all: 0.7 } } } } }, names), "Comp Two drives most of the top markets.");
  assert.equal(topLevelExplainSentence({ query: { explainability: { warning: "n/a" } } }, names), undefined);
  assert.equal(topLevelExplainSentence(list(0.7, 0.4), {}), undefined, "no sentence without a name to put in it");
});

test("rank_markets validates its input and surfaces a Qloo miss as an error", async () => {
  const h = harness();
  await assert.rejects(h.byName.rank_markets.run({ compIds: [] }, h.ctx), /1 to 3/);
  await assert.rejects(h.byName.rank_markets.run({ compIds: ["Z9"] }, h.ctx), /HTTP 404/);
  // The failed call still left a receipt so the trace shows what was asked.
  assert.equal(h.state.receipts.length, 1);
  assert.equal(h.state.receipts[0].status, 404);
});

// ---- plan_route ----

test("plan_route needs rank_markets first and a known home city", async () => {
  const h = harness();
  await assert.rejects(h.byName.plan_route.run({ days: 7, driveHoursCap: 5, mustInclude: [], exclude: [] }, h.ctx), /rank_markets/);
  const noHome = harness(() => undefined);
  await noHome.byName.resolve_act.run({ name: "Comp One" }, noHome.ctx);
  await noHome.byName.rank_markets.run({ compIds: ["A1"] }, noHome.ctx);
  await assert.rejects(noHome.byName.plan_route.run({ days: 7, driveHoursCap: 5, mustInclude: [], exclude: [] }, noHome.ctx), /Home city/);
});

test("plan_route builds a loop from home, compares with the obvious route, and emits route", async () => {
  const h = harness();
  await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  await h.byName.rank_markets.run({ compIds: ["A1"] }, h.ctx);
  h.events.length = 0;
  const out: any = await h.byName.plan_route.run({ days: 7, driveHoursCap: 5, mustInclude: [], exclude: ["Hilltown, VA"] }, h.ctx);
  assert.equal(out.route.home.label, "Richmond, VA");
  assert.ok(out.route.stops.length >= 3, "at least three stops");
  assert.ok(!out.route.stops.some((s: any) => s.label === "Hilltown, VA"), "excluded town stays off");
  assert.ok(out.route.stops.every((s: any) => typeof s.lat === "number" && typeof s.lon === "number"));
  assert.equal(out.route.days, 7);
  assert.ok(Array.isArray(out.obvious.cities) && out.obvious.cities.includes("Nashville, TN"));
  assert.ok(typeof out.obvious.summary === "string" && out.obvious.summary.length > 0);
  assert.match(out.summary, /stops over 7 days, about \d+ miles \(est\.\)/);
  assert.equal(out.qloo, undefined, "no Qloo call for routing");
  assert.deepEqual(h.events.map((e) => e.type), ["route"]);
  assert.equal(h.state.route, out.route);
  assert.equal(h.state.obvious, out.obvious);
});

test("plan_route falls back to the request's days and cap when the agent passes nonsense", async () => {
  const h = harness();
  await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  await h.byName.rank_markets.run({ compIds: ["A1"] }, h.ctx);
  const out: any = await h.byName.plan_route.run({ days: 99, driveHoursCap: 0, mustInclude: [], exclude: [] }, h.ctx);
  assert.equal(out.route.days, 7);
});

// ---- receipts ----

const baseResult: QlooResult = { ok: true, status: 200, mode: "demo", path: "/v2/insights", params: {}, url: "https://x/y", ms: 3, body: {} };

test("toReceipt counts demographics rows and lists the top three with affinities", () => {
  const demo = toReceipt("who_shows_up", { ...baseResult, body: { results: { demographics: [{ entity_id: "A" }, { entity_id: "B" }] } } });
  assert.equal(demo.resultCount, 2);
  assert.deepEqual(demo.top, []);
  const ents = toReceipt("find_rooms", { ...baseResult, body: { results: { entities: [{ entity_id: "1", name: "a", query: { affinity: 0.9 } }, { entity_id: "2", name: "b" }, { entity_id: "3", name: "c", query: { affinity: 0.5 } }, { entity_id: "4", name: "d" }] } } });
  assert.equal(ents.resultCount, 4);
  assert.deepEqual(ents.top, [{ name: "a", affinity: 0.9 }, { name: "b" }, { name: "c", affinity: 0.5 }]);
  assert.equal(ents.method, "GET");
  assert.equal(ents.note, undefined);
  assert.equal(ents.cached, undefined);
  assert.equal(ents.resolved, undefined);
  const miss = toReceipt("x", { ...baseResult, ok: false, status: 404, body: { error: "no demo fixture for this request" } });
  assert.equal(miss.note, "no demo fixture for this request");
  const bare = toReceipt("x", { ...baseResult, ok: false, status: 500, body: { raw: "<html>" } });
  assert.equal(bare.note, "HTTP 500");
});

test("toReceipt carries the client's note and cached flag, and the locality Qloo resolved", () => {
  const fallback = toReceipt("find_rooms", { ...baseResult, mode: "demo", note: "Live Qloo call failed (HTTP 503); served the recorded fixture instead.", body: { results: { entities: [] } } });
  assert.equal(fallback.note, "Live Qloo call failed (HTTP 503); served the recorded fixture instead.");
  const cached = toReceipt("find_rooms", { ...baseResult, mode: "live", cached: true, body: { results: { entities: [] } } });
  assert.equal(cached.cached, true);
  const resolvedObj = toReceipt("find_rooms", { ...baseResult, body: { query: { locality: { signal: { name: "Asheville", disambiguation: "North Carolina, United States" } } }, results: { entities: [] } } });
  assert.equal(resolvedObj.resolved, "Asheville, North Carolina, United States");
  const resolvedStr = toReceipt("find_rooms", { ...baseResult, body: { query: { locality: { signal: "Asheville, NC" } }, results: { entities: [] } } });
  assert.equal(resolvedStr.resolved, "Asheville, NC");
  assert.equal(resolvedLocality({ query: { locality: { signal: { name: "  " } } } }), undefined);
  assert.equal(resolvedLocality({ query: { locality: { signal: { name: "Boone", disambiguation: "Boone" } } } }), "Boone", "no duplicate text");
  assert.equal(resolvedLocality(null), undefined);
});

// ---- buildApp ----

test("buildApp wires the prompt, opening message, tools, and budget", () => {
  const qloo = new QlooClient({}, stubResolver as any);
  const app = buildApp(qloo, { ...good, format: "music" });
  assert.equal(app.maxTurns, 8);
  assert.equal(app.effort, "medium");
  assert.equal(app.tools.length, 3);
  assert.equal(app.messages.length, 1);
  assert.match(String(app.messages[0].content), /Big Thief; Waxahatchee/);
  assert.match(app.system, /resolve_act once for each comp/);
  assert.match(app.system, /Never claim venue capacity, age policy, ticket sales/);
  assert.match(app.system, /best-matching live-music room ranks highest/);
  assert.match(app.system, /straight-line estimates/);
  assert.match(app.system, /ranks #3 nationally/);
  assert.match(app.system, /only state a rank threshold/);
  assert.match(app.system, /days=12 and driveHoursCap=6/);
  assert.deepEqual(app.state, { comps: [], localities: [], receipts: [] });
});

// ---- the bundled Hollow Pines fixtures, end to end through the tools ----
// The fixture files are owned by another workflow step and may still be empty skeletons; this
// test only runs once the new rank_markets fixture (venue-based) answers through demoResolver.

const scenario = JSON.parse(fs.readFileSync(new URL("../data/scenarios/hollow-pines.json", import.meta.url), "utf8"));
const scenarioIds: string[] = scenario.comps.map((c: any) => c.id);
const marketsFixture = demoResolver(Q.rankMarkets(scenarioIds, tagsFor(Q.VENUE_TAG_GROUPS)).path, Q.rankMarkets(scenarioIds, tagsFor(Q.VENUE_TAG_GROUPS)).params) as any;
const marketsReady = Array.isArray(marketsFixture?.results?.entities) && marketsFixture.results.entities.length >= 10;
const searchesReady = scenario.request.comps.every((name: string) => demoResolver("/search", Q.searchAct(name, "music").params) !== undefined);

test("Hollow Pines runs through all three tools on bundled fixtures and the Census file", { skip: !(marketsReady && searchesReady) && "venue-based markets fixture not filled yet" }, async () => {
  const qloo = new QlooClient({}, demoResolver);
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { emit: (e) => events.push(e) };
  const { tools, state } = makeTools({ qloo, format: "music", home: scenario.request.home, days: scenario.request.days, driveHoursCap: scenario.request.driveHoursCap });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const chosen: string[] = [];
  for (const name of scenario.request.comps) {
    const out: any = await byName.resolve_act.run({ name }, ctx);
    assert.ok(out.candidates.length >= 1, `candidates for ${name}`);
    chosen.push(out.candidates[0].id);
  }
  assert.deepEqual(chosen.sort(), [...scenarioIds].sort());

  const ranked: any = await byName.rank_markets.run({ compIds: chosen }, ctx);
  assert.ok(ranked.localities.length >= 10);
  assert.ok(ranked.localities.every((l: any) => typeof l.lat === "number" && typeof l.lon === "number"), "every town has coordinates");
  assert.ok(ranked.localities.every((l: any) => l.topRoom?.name), "every town carries its top room");
  assert.ok(ranked.localities.filter((l: any) => l.overIndex).length >= 1);
  assert.equal(state.comps.map((c) => c.name).sort().join(","), [...scenario.request.comps].sort().join(","));

  const routed: any = await byName.plan_route.run({ days: 12, driveHoursCap: 6, mustInclude: [], exclude: [] }, ctx);
  assert.ok(routed.route.stops.length >= 3);
  assert.ok(routed.route.stops.every((s: any) => s.legHours <= 6 || s.driveDay), "legs over the cap become drive days");

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "receipt").length, 4, "three searches plus one rank_markets");
  assert.ok(types.includes("comps") && types.includes("markets") && types.includes("route"));
  assert.equal(types.at(-1), "route");
});
