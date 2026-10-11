// Request validation and the three agent tools, driven by a stub Qloo client (demo mode with an
// inline resolver) and a stub Census lookup, plus one pass over the real Hollow Pines fixtures.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { QlooClient } from "../src/qloo.ts";
import type { AgentEvent, ToolContext } from "../src/agent.ts";
import { makeTools, toReceipt } from "../src/tools.ts";
import { parseRunRequest, buildApp } from "../src/app.ts";
import { demoResolver } from "../src/demo/resolver.ts";
import type { PlaceRow } from "../src/places.ts";

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

const ARTIST = (id: string, name: string, popularity: number) => ({ entity_id: id, name, type: "urn:entity:artist", popularity });
const LOCALITY = (id: string, name: string, state: string, affinity: number, lat: number, lon: number, who = "A1") => ({
  entity_id: id,
  name,
  type: "urn:entity:locality",
  properties: { geocode: { name, admin1_region: state, country_code: "US" } },
  location: { lat, lon },
  query: { affinity, explainability: { by_entity: { [who]: { name: "Comp One", score: 0.7 } } } },
});

const stubResolver = (path: string, params: Record<string, unknown>) => {
  if (path === "/search") {
    const q = String(params.query);
    if (q === "Comp One") return { results: [ARTIST("A1", "Comp One", 0.9), ARTIST("A2", "Comp One Tribute", 0.3), { entity_id: "P1", name: "Comp One", type: "urn:entity:person" }, ARTIST("A3", "Comp Oneder", 0.5), ARTIST("A4", "Compote", 0.1)] };
    if (q === "Nobody") return { results: [] };
    return undefined;
  }
  if (path === "/v2/insights" && params["filter.type"] === "urn:entity:locality" && params["signal.interests.entities"] === "A1") {
    return {
      results: {
        entities: [
          LOCALITY("L1", "Smallville", "VA", 0.95, 37.5, -78.5),
          LOCALITY("L2", "Bigcity", "VA", 0.9, 38.0, -77.0),
          LOCALITY("L3", "Nashville", "TN", 0.85, 36.16, -86.78),
          LOCALITY("L4", "Nowhere", "ZZ", 0.8, 36.5, -79.0), // not in the Census stub
          LOCALITY("L5", "Hilltown", "VA", 0.75, 37.0, -80.0),
        ],
      },
    };
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

function harness(findPlace = stubFindPlace, resolver = stubResolver) {
  const qloo = new QlooClient({}, resolver as any);
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { emit: (e) => events.push(e) };
  const { tools, state } = makeTools({ qloo, format: "music", home: "Richmond, VA", days: 7, driveHoursCap: 5, findPlace });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { qloo, events, ctx, tools, state, byName };
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

test("resolve_act keeps only the requested entity type, caps at 3, and emits comps + receipt", async () => {
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
  const types = h.events.map((e) => e.type);
  assert.deepEqual(types, ["receipt", "comps"]);
  const comps = (h.events[1] as any).comps;
  assert.equal(comps[0].id, "A1", "running list holds the exact-name, most popular match");
  assert.equal(h.state.receipts.length, 1);
});

test("resolve_act with no results reports it plainly instead of throwing", async () => {
  const h = harness();
  const out: any = await h.byName.resolve_act.run({ name: "Nobody" }, h.ctx);
  assert.deepEqual(out.candidates, []);
  assert.match(out.summary, /No artist named "Nobody"/);
});

test("rank_markets joins the Census stub, computes overIndex, and emits markets", async () => {
  const h = harness();
  await h.byName.resolve_act.run({ name: "Comp One" }, h.ctx);
  h.events.length = 0;
  const out: any = await h.byName.rank_markets.run({ compIds: ["A1"] }, h.ctx);
  assert.equal(out.localities.length, 5);
  const [l1, l2, l3, l4] = out.localities;
  assert.equal(l1.label, "Smallville, VA");
  assert.equal(l1.rank, 1);
  assert.equal(l1.population, 40000);
  assert.equal(l1.overIndex, true);
  assert.deepEqual(l1.why, ["Comp One (70%)"]);
  assert.equal(l2.overIndex, false, "900k people is not a small town");
  assert.equal(l3.label, "Nashville, TN");
  assert.equal(l4.population, undefined, "unknown place keeps Qloo coordinates but no population");
  assert.equal(l4.lat, 36.5);
  assert.equal(l4.overIndex, false);
  assert.match(out.summary, /Smallville, VA #1 \(95%\)/);
  assert.match(out.summary, /Usual suspects: Nashville, TN #3/);
  assert.deepEqual(h.events.map((e) => e.type), ["comps", "receipt", "markets"]);
  assert.deepEqual(h.state.comps, [{ id: "A1", name: "Comp One", type: "urn:entity:artist", popularity: 0.9 }]);
  assert.equal(h.state.localities.length, 5);
});

test("rank_markets validates its input and surfaces a Qloo miss as an error", async () => {
  const h = harness();
  await assert.rejects(h.byName.rank_markets.run({ compIds: [] }, h.ctx), /1 to 3/);
  await assert.rejects(h.byName.rank_markets.run({ compIds: ["Z9"] }, h.ctx), /HTTP 404/);
  // The failed call still left a receipt so the trace shows what was asked.
  assert.equal(h.state.receipts.length, 1);
  assert.equal(h.state.receipts[0].status, 404);
});

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
  assert.match(out.summary, /stops over 7 days/);
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

test("toReceipt counts demographics rows and lists the top three with affinities", () => {
  const base = { ok: true, status: 200, mode: "demo" as const, path: "/v2/insights", params: {}, url: "https://x/y", ms: 3 };
  const demo = toReceipt("who_shows_up", { ...base, body: { results: { demographics: [{ entity_id: "A" }, { entity_id: "B" }] } } });
  assert.equal(demo.resultCount, 2);
  assert.deepEqual(demo.top, []);
  const ents = toReceipt("find_rooms", { ...base, body: { results: { entities: [{ entity_id: "1", name: "a", query: { affinity: 0.9 } }, { entity_id: "2", name: "b" }, { entity_id: "3", name: "c", query: { affinity: 0.5 } }, { entity_id: "4", name: "d" }] } } });
  assert.equal(ents.resultCount, 4);
  assert.deepEqual(ents.top, [{ name: "a", affinity: 0.9 }, { name: "b" }, { name: "c", affinity: 0.5 }]);
  assert.equal(ents.method, "GET");
  assert.equal(ents.note, undefined);
  const miss = toReceipt("x", { ...base, ok: false, status: 404, body: { error: "no demo fixture for this request" } });
  assert.equal(miss.note, "no demo fixture for this request");
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
  assert.match(app.system, /over-index town/);
  assert.match(app.system, /days=12 and driveHoursCap=6/);
  assert.deepEqual(app.state, { comps: [], localities: [], receipts: [] });
});

// ---- the real Hollow Pines fixtures, end to end through the tools ----

const scenario = JSON.parse(fs.readFileSync(new URL("../data/scenarios/hollow-pines.json", import.meta.url), "utf8"));

test("Hollow Pines runs through all three tools on recorded fixtures and the Census file", async () => {
  const qloo = new QlooClient({}, demoResolver);
  const events: AgentEvent[] = [];
  const ctx: ToolContext = { emit: (e) => events.push(e) };
  const { tools, state } = makeTools({ qloo, format: "music", home: scenario.request.home, days: scenario.request.days, driveHoursCap: scenario.request.driveHoursCap });
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const chosen: string[] = [];
  for (const name of scenario.request.comps) {
    const out: any = await byName.resolve_act.run({ name }, ctx);
    assert.ok(out.candidates.length >= 1, `candidates for ${name}`);
    assert.equal(out.candidates[0].name, name, "the exact match comes first in the fixture");
    chosen.push(out.candidates[0].id);
  }
  assert.deepEqual(chosen.sort(), scenario.comps.map((c: any) => c.id).sort());

  const ranked: any = await byName.rank_markets.run({ compIds: chosen }, ctx);
  assert.equal(ranked.localities.length, 50);
  assert.equal(ranked.localities[0].label, "Asheville, NC");
  assert.equal(ranked.localities[0].overIndex, true, "Asheville is under 250k and ranked #1");
  const nashville = ranked.localities.find((l: any) => l.label === "Nashville, TN");
  assert.ok(nashville && nashville.overIndex === false, "Nashville is a usual suspect, not an over-index town");
  assert.ok(ranked.localities.filter((l: any) => l.overIndex).length >= 5);
  assert.ok(ranked.localities.every((l: any) => typeof l.lat === "number" && typeof l.lon === "number"), "every locality has coordinates");
  assert.equal(state.comps.map((c) => c.name).sort().join(","), [...scenario.request.comps].sort().join(","));

  const routed: any = await byName.plan_route.run({ days: 12, driveHoursCap: 6, mustInclude: [], exclude: [] }, ctx);
  assert.ok(routed.route.stops.length >= 3);
  assert.ok(routed.route.stops.every((s: any) => s.legHours <= 6 || s.driveDay), "legs over the cap become drive days");
  assert.ok(routed.obvious.smallTowns >= 1);

  const types = events.map((e) => e.type);
  assert.equal(types.filter((t) => t === "receipt").length, 4, "three searches plus one rank_markets");
  assert.ok(types.includes("comps") && types.includes("markets") && types.includes("route"));
  assert.equal(types.at(-1), "route");
});
