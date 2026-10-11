// The city playbook: pure helpers fed small synthetic Qloo bodies, and buildPlaybook driven by a
// stub resolver in demo mode. Bodies follow Qloo's documented shapes: entities are type
// "urn:entity" with a subtype, tags are { id, name, type }, and per-result explainability is
// { "signal.interests.entities": [{ entity_id, score }] }.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rec } from "../src/qloo.ts";
import { QlooClient } from "../src/qloo.ts";
import { buildPlaybook, cardPayload, groupPromo, summarizeDemographics, localColorDeltas, fallbackCopy, ageBandLabel, CARD_SCHEMA, OVER_INDEX_MEANS } from "../src/city.ts";
import type { Playbook } from "../src/types.ts";
import { idList } from "../src/canonical.ts";

const rec = (id: string, name: string, extra: Partial<Rec> = {}): Rec => ({ id, name, type: "urn:entity", subtype: "urn:entity:place", tags: [], tagIds: [], why: [], ...extra });

// ---- groupPromo: one call per kind, labeled by the call ----

test("groupPromo labels each group by the call that returned it, sorts by affinity, keeps two", () => {
  const groups = groupPromo([
    { group: "record_store", places: [rec("1", "Plan 9", { affinity: 0.7 }), rec("2", "Harvest", { affinity: 0.9 }), rec("9", "Third Record Shop", { affinity: 0.95 })] },
    { group: "coffee_shop", places: [rec("3", "Lamplighter", { affinity: 0.8 })] },
    { group: "bookstore", places: [rec("4", "Chop Suey Books", { affinity: 0.6 })] },
    { group: "dive_bar", places: [rec("5", "Bamboo Cafe", { affinity: 0.5 })] },
    { group: "vintage", places: [rec("6", "Rumors", { affinity: 0.4 })] },
  ]);
  assert.deepEqual(groups.map((g) => g.kind), ["record store", "coffee shop", "bookstore", "dive bar", "vintage shop"]);
  assert.deepEqual(groups[0].places.map((p) => p.name), ["Third Record Shop", "Harvest"], "sorted by affinity and capped at two");
  assert.equal(groups[1].places[0].name, "Lamplighter");
  assert.equal(groups[3].places[0].name, "Bamboo Cafe");
});

test("groupPromo keeps a place in the first group that returned it and drops empty groups", () => {
  const bar = rec("7", "The Bar That Sells Records", { affinity: 0.9 });
  const groups = groupPromo([
    { group: "record_store", places: [bar, rec("1", "Plan 9", { affinity: 0.7 })] },
    { group: "coffee_shop", places: [] },
    { group: "dive_bar", places: [rec("5", "Bamboo", { affinity: 0.8 }), { ...bar }] },
    { group: "vintage", places: [] },
  ]);
  assert.deepEqual(groups.map((g) => g.kind), ["record store", "dive bar"]);
  assert.deepEqual(groups[0].places.map((p) => p.name), ["The Bar That Sells Records", "Plan 9"]);
  assert.deepEqual(groups[1].places.map((p) => p.name), ["Bamboo"], "the duplicate is not listed twice");
  assert.deepEqual(groupPromo([]), []);
});

// ---- demographics: one read for fans of the comps overall ----

const demoBody = {
  results: {
    demographics: [
      { entity_id: "A", query: { age: { "24_and_younger": 0.2, "25_to_29": 0.5, "30_to_34": 0.6, "55_and_older": -0.3 }, gender: { female: 0.3, male: -0.1 } } },
      { entity_id: "B", query: { age: { "24_and_younger": 0.1, "25_to_29": 0.4, "30_to_34": 0.5, "55_and_older": -0.2 }, gender: { female: 0.2, male: -0.1 } } },
    ],
  },
};

test("summarizeDemographics averages across comps, names the strongest band, and is scoped to the comps overall", () => {
  const d = summarizeDemographics(demoBody);
  assert.ok(d);
  assert.equal(d.scope, "comps-overall");
  assert.equal(d.age["30_to_34"], 0.55);
  assert.equal(d.age["25_to_29"], 0.45);
  assert.equal(d.age["24_and_younger"], 0.15);
  assert.equal(d.gender.female, 0.25);
  assert.equal(d.strongestAge, "30_to_34");
  assert.ok(d.suggestions.length >= 1 && d.suggestions.length <= 3);
  // Suggestions are phrased as suggestions, never as facts about people, and never about "here".
  for (const s of d.suggestions) {
    assert.match(s, /consider/i);
    assert.doesNotMatch(s, /\bhere\b/);
  }
  assert.match(d.suggestions[0], /overall index highest at 30 to 34/);
  assert.ok(d.suggestions.some((s) => /all-ages/.test(s)));
});

test("summarizeDemographics returns null for empty or malformed bodies", () => {
  assert.equal(summarizeDemographics(null), null);
  assert.equal(summarizeDemographics({ results: { demographics: [] } }), null);
  assert.equal(summarizeDemographics({ results: { entities: [] } }), null);
  assert.equal(summarizeDemographics({ results: { demographics: [{ entity_id: "A", query: {} }] } }), null);
});

test("ageBandLabel reads naturally", () => {
  assert.equal(ageBandLabel("24_and_younger"), "under 25");
  assert.equal(ageBandLabel("55_and_older"), "55 and older");
  assert.equal(ageBandLabel("some_other_band"), "some other band");
});

// ---- local color ----

const entity = (id: string, name: string, affinity: number) => ({ entity_id: id, name, type: "urn:entity", subtype: "urn:entity:brand", query: { affinity } });

test("localColorDeltas sorts by delta desc with unknown-at-home items after, keeps five", () => {
  const city = { results: { entities: [entity("a", "Patagonia", 0.9), entity("b", "Subaru", 0.8), entity("c", "Fender", 0.95), entity("d", "REI", 0.7), entity("e", "Allbirds", 0.6), entity("f", "Levi's", 0.5), entity("g", "Trek", 0.4)] } };
  const home = { results: { entities: [entity("a", "Patagonia", 0.85), entity("b", "Subaru", 0.4), entity("d", "REI", 0.75)] } };
  const deltas = localColorDeltas(city, home);
  assert.equal(deltas.length, 5);
  assert.deepEqual(deltas.map((d) => d.name), ["Subaru", "Patagonia", "REI", "Fender", "Allbirds"]);
  assert.equal(deltas[0].delta, 0.4);
  assert.equal(deltas[0].homeAffinity, 0.4);
  assert.equal(deltas[2].delta, -0.05);
  assert.equal(deltas[3].homeAffinity, null);
  assert.equal(deltas[3].delta, null);
});

test("localColorDeltas copes with an empty, missing or failed home list and an empty city list", () => {
  const city = { results: { entities: [entity("a", "Patagonia", 0.9)] } };
  const only = localColorDeltas(city, { results: { entities: [] } });
  assert.equal(only.length, 1);
  assert.equal(only[0].delta, null);
  const unavailable = localColorDeltas(city, null);
  assert.equal(unavailable[0].homeAffinity, null);
  assert.equal(unavailable[0].delta, null);
  assert.deepEqual(localColorDeltas({ results: { entities: [] } }, city), []);
  assert.deepEqual(localColorDeltas(null, null), []);
});

// ---- fallback copy ----

const partial: Omit<Playbook, "card" | "receipts"> = {
  city: "Asheville, NC",
  home: "Richmond, VA",
  comps: [
    { id: "1", name: "Big Thief", type: "urn:entity:artist" },
    { id: "2", name: "Waxahatchee", type: "urn:entity:artist" },
  ],
  rooms: [rec("r1", "The Grey Eagle", { affinity: 0.91, why: ["Big Thief (78%)"] })],
  promo: [{ kind: "record store", places: [rec("p1", "Harvest Records", { affinity: 0.92 })] }],
  who: summarizeDemographics(demoBody),
  localColor: {
    brands: [{ id: "b", name: "Patagonia", cityAffinity: 0.9, homeAffinity: 0.7, delta: 0.2 }],
    shows: [{ id: "s", name: "Fleabag", cityAffinity: 0.9, homeAffinity: null, delta: null }],
    homeAvailable: true,
  },
  locality: { id: "L", name: "Asheville", state: "NC", label: "Asheville, NC", rank: 1, affinity: 0.934, population: 94589, overIndex: true, why: ["Big Thief (72%)"], topRoom: { id: "r1", name: "The Grey Eagle", affinity: 0.934, why: ["Big Thief (72%)"] } },
};

test("fallbackCopy fills every field from the data and makes no forbidden claims", () => {
  const card = fallbackCopy(partial);
  for (const k of ["summary", "rooms_note", "promo_note", "who_note", "local_color_note", "caution"] as const) {
    assert.ok(card[k].trim().length > 20, `${k} is written`);
  }
  assert.equal(card.promo_copy.length, 2);
  assert.match(card.summary, /ranks #1 nationally/);
  assert.match(card.summary, /The Grey Eagle/);
  assert.match(card.summary, /93%/);
  assert.match(card.summary, /over-index town: under 250,000 people with a national rank of 20 or better/);
  assert.doesNotMatch(card.summary, /on the route because fans of .* rank it #/, "the rank belongs to the room, not a locality query");
  assert.match(card.rooms_note, /The Grey Eagle/);
  assert.match(card.rooms_note, /Big Thief \(78%\)/);
  assert.match(card.promo_note, /Harvest Records/);
  assert.match(card.who_note, /overall/);
  assert.match(card.who_note, /30 to 34/);
  assert.doesNotMatch(card.who_note, /\bhere\b/);
  assert.match(card.local_color_note, /Patagonia \(\+20 points vs\. Richmond, VA\)/);
  assert.doesNotMatch(card.local_color_note, /Fleabag/, "a show with no home affinity is not described as a lift over home");
  assert.match(card.caution, /aggregate/i);
  const all = Object.values(card).flat().join(" ");
  assert.doesNotMatch(all, /people in Asheville/i);
  assert.doesNotMatch(all, /capacity of|sold out|tickets sold|shows? up|\battend(s|ed|ing|ees)?\b|\bdraws?\b|\bdrew\b/i);
  assert.doesNotMatch(all, /compared with home|than home/i, "over-index is never framed as a home comparison");
});

test("fallbackCopy never claims a lift over home when the home list is empty", () => {
  const card = fallbackCopy({ ...partial, localColor: { brands: [{ id: "b", name: "Patagonia", cityAffinity: 0.9, homeAffinity: null, delta: null }], shows: [], homeAvailable: true } });
  assert.doesNotMatch(card.local_color_note, /over-index|points vs/);
  assert.match(card.local_color_note, /Patagonia \(90%\)/);
  assert.match(card.local_color_note, /does not .* Richmond, VA top list/);
});

test("fallbackCopy says the home comparison is unavailable when the home calls failed", () => {
  const card = fallbackCopy({
    ...partial,
    localColor: {
      brands: [{ id: "b", name: "Patagonia", cityAffinity: 0.9, homeAffinity: null, delta: null }],
      shows: [{ id: "s", name: "Fleabag", cityAffinity: 0.8, homeAffinity: null, delta: null }],
      homeAvailable: false,
    },
  });
  assert.match(card.local_color_note, /home comparison is unavailable for this run/);
  assert.match(card.local_color_note, /Patagonia \(90%\) and Fleabag \(80%\)/);
  assert.doesNotMatch(card.local_color_note, /top list|points vs/);
  const empty = fallbackCopy({ ...partial, localColor: { brands: [], shows: [], homeAvailable: false } });
  assert.match(empty.local_color_note, /home comparison is unavailable/);
});

test("fallbackCopy degrades gracefully when Qloo returned nothing", () => {
  const card = fallbackCopy({ ...partial, rooms: [], promo: [], who: null, localColor: { brands: [], shows: [], homeAvailable: true }, locality: undefined });
  assert.match(card.rooms_note, /no rooms/i);
  assert.match(card.promo_note, /No promo partners/);
  assert.match(card.who_note, /no demographic read/i);
  assert.match(card.local_color_note, /No brand or TV-show lift/);
  assert.equal(card.promo_copy.length, 2);
});

test("CARD_SCHEMA is strict and covers every CardCopy field", () => {
  const keys = Object.keys(CARD_SCHEMA.properties).sort();
  assert.deepEqual(keys, ["caution", "local_color_note", "promo_copy", "promo_note", "rooms_note", "summary", "who_note"]);
  assert.deepEqual([...CARD_SCHEMA.required].sort(), keys);
  assert.equal(CARD_SCHEMA.additionalProperties, false);
});

// ---- what Claude is shown ----

test("cardPayload labels every number by what it means", () => {
  const payload = cardPayload(partial) as any;
  assert.equal(payload.locality.nationalAffinityRank, 1);
  assert.equal("rank" in payload.locality, false);
  assert.equal(payload.locality.overIndexMeans, OVER_INDEX_MEANS);
  assert.match(OVER_INDEX_MEANS, /not a comparison with home/);
  assert.equal(payload.locality.topRoom, "The Grey Eagle");
  assert.equal(payload.promo[0].places[0].kind, "record store", "kind comes from the promo group, not a subtype");
  assert.equal(payload.rooms[0].kind, undefined);
  assert.match(payload.who.scope, /fans of the comps overall, not this city/);
  assert.equal(payload.who.strongestAgeLabel, "30 to 34");
  assert.equal(payload.localColor.homeAvailable, true);
  assert.equal(payload.localColor.note, undefined);
  assert.deepEqual(payload.localColor.brands[0], { name: "Patagonia", cityAffinity: 0.9, homeAffinity: 0.7, deltaVsHome: 0.2 });

  const unavailable = cardPayload({ ...partial, localColor: { ...partial.localColor, homeAvailable: false } }) as any;
  assert.equal(unavailable.localColor.homeAvailable, false);
  assert.match(unavailable.localColor.note, /home comparison is unavailable/);
  assert.doesNotMatch(unavailable.localColor.note, /not in the home top list/);
});

// ---- buildPlaybook with a stub resolver (demo mode) ----

const COMPS = [
  { id: "A1", name: "Comp One", type: "urn:entity:artist" },
  { id: "B1", name: "Comp Two", type: "urn:entity:artist" },
];
const IDS = idList(COMPS.map((c) => c.id));

const place = (id: string, name: string, subtype: string, tagId: string, affinity: number) => ({
  entity_id: id,
  name,
  type: "urn:entity",
  subtype,
  properties: { address: `1 Main St`, geocode: { name: "Asheville", city: "Asheville", admin1_region: "NC", country_code: "US" } },
  tags: [{ id: tagId, name: tagId.split(":").at(-1), type: "urn:tag:genre:place" }],
  query: { affinity, explainability: { "signal.interests.entities": [{ entity_id: "A1", score: 0.7 }, { entity_id: "B1", score: 0.5 }] } },
});
const brand = (id: string, name: string, affinity: number) => ({ entity_id: id, name, type: "urn:entity", subtype: "urn:entity:brand", query: { affinity } });
const insights = (entities: any[]) => ({ success: true, query: { locality: { signal: { name: "Asheville", disambiguation: "North Carolina, United States" } } }, results: { entities } });

// The city's own answers, keyed by the kind of request. Home calls answer only when `homeOk`.
function cityResolver(homeOk = true) {
  return (path: string, params: Record<string, unknown>) => {
    if (path !== "/v2/insights") return undefined;
    const type = params["filter.type"];
    if (type === "urn:demographics") {
      assert.equal(params["signal.location.query"], undefined, "demographics must not carry a location");
      assert.equal(params["signal.interests.entities"], IDS);
      return demoBody;
    }
    const loc = String(params["filter.location.query"] ?? params["signal.location.query"] ?? "");
    const tags = String(params["filter.tags"] ?? "");
    if (type === "urn:entity:place" && loc === "Asheville, NC") {
      if (tags.includes("music_venue")) return insights([place("R1", "The Grey Eagle", "urn:entity:place", "urn:tag:genre:place:music_venue", 0.93), place("R2", "The Orange Peel", "urn:entity:place", "urn:tag:genre:place:music_venue", 0.88)]);
      if (tags.includes("record_store")) return insights([place("P1", "Harvest Records", "urn:entity:place", "urn:tag:genre:place:record_store", 0.92), place("P9", "Static Age", "urn:entity:place", "urn:tag:genre:place:record_store", 0.8)]);
      if (tags.includes("coffee")) return insights([place("P2", "Trade and Lore", "urn:entity:place", "urn:tag:genre:place:coffee_shop", 0.85)]);
      if (tags.includes("bookstore")) return insights([place("P3", "Malaprop's", "urn:entity:place", "urn:tag:genre:place:bookstore", 0.84)]);
      if (tags.includes("dive_bar")) return insights([place("P9", "Static Age", "urn:entity:place", "urn:tag:genre:place:dive_bar", 0.83), place("P4", "The Odditorium", "urn:entity:place", "urn:tag:genre:place:dive_bar", 0.8)]);
      if (tags.includes("vintage")) return insights([]);
      return undefined;
    }
    if (type === "urn:entity:brand" && loc === "Asheville, NC") return insights([brand("K1", "Patagonia", 0.9), brand("K2", "Subaru", 0.8)]);
    if (type === "urn:entity:tv_show" && loc === "Asheville, NC") return insights([brand("S1", "Fleabag", 0.9)]);
    if (loc === "Richmond, VA" && homeOk) {
      if (type === "urn:entity:brand") return insights([brand("K1", "Patagonia", 0.7)]);
      if (type === "urn:entity:tv_show") return insights([brand("S1", "Fleabag", 0.95)]);
    }
    return undefined;
  };
}

async function build(homeOk = true, extra: Record<string, unknown> = {}) {
  const qloo = new QlooClient({}, cityResolver(homeOk));
  const events: any[] = [];
  const pb = await buildPlaybook({ qloo, client: null, model: "m", city: "Asheville, NC", home: "Richmond, VA", comps: COMPS, emit: (e) => events.push(e), ...extra });
  return { qloo, events, pb };
}

test("buildPlaybook makes one rooms call, five promo calls (one per kind), one shared demographics call and four local-color calls", async () => {
  const { qloo, events, pb } = await build();
  assert.equal(qloo.calls.length, 11);
  const promoCalls = qloo.calls.filter((c) => c.params["filter.type"] === "urn:entity:place" && c.params.take === 2);
  assert.equal(promoCalls.length, 5);
  assert.equal(qloo.calls.filter((c) => c.params["filter.type"] === "urn:demographics").length, 1);
  assert.equal(pb.receipts.length, 11);
  assert.equal(events.filter((e) => e.type === "receipt").length, 11);
  assert.equal(events.filter((e) => e.type === "playbook").length, 1);
  assert.ok(events.some((e) => e.type === "status" && /one call per kind/.test(e.message)));
  assert.ok(events.some((e) => e.type === "status" && /comps overall/.test(e.message)));

  // Promo groups are labeled by the call and a place seen twice stays in its first group.
  assert.deepEqual(pb.promo.map((g) => g.kind), ["record store", "coffee shop", "bookstore", "dive bar"]);
  assert.deepEqual(pb.promo[0].places.map((p) => p.name), ["Harvest Records", "Static Age"]);
  assert.deepEqual(pb.promo[3].places.map((p) => p.name), ["The Odditorium"]);

  // Explainability chips show comp names, not ids.
  assert.deepEqual(pb.rooms[0].why, ["Comp One (70%)", "Comp Two (50%)"]);
  assert.deepEqual(pb.promo[0].places[0].why, ["Comp One (70%)", "Comp Two (50%)"]);

  assert.equal(pb.who?.scope, "comps-overall");
  assert.equal(pb.localColor.homeAvailable, true);
  assert.equal(pb.localColor.brands[0].name, "Patagonia");
  assert.equal(pb.localColor.brands[0].delta, 0.2);
  assert.equal(pb.localColor.brands[1].homeAffinity, null, "Subaru is not in the home top list");
  assert.equal(pb.localColor.shows[0].delta, -0.05);
  assert.ok(pb.receipts.every((r) => r.resolved === "Asheville, North Carolina, United States" || r.resolved === undefined));
  assert.equal(pb.receipts.find((r) => r.tool === "find_rooms")?.resolved, "Asheville, North Carolina, United States");
  assert.notEqual(pb.noDemoData, true);
  assert.match(pb.card.local_color_note, /Patagonia \(\+20 points vs\. Richmond, VA\)/);
});

test("buildPlaybook marks the home comparison unavailable when a home call fails", async () => {
  const { pb } = await build(false);
  assert.equal(pb.localColor.homeAvailable, false);
  assert.ok(pb.localColor.brands.length >= 1 && pb.localColor.shows.length >= 1, "city items still show");
  assert.ok([...pb.localColor.brands, ...pb.localColor.shows].every((d) => d.homeAffinity === null && d.delta === null));
  assert.match(pb.card.local_color_note, /home comparison is unavailable for this run/);
  assert.doesNotMatch(pb.card.local_color_note, /top list/);
  assert.equal(pb.receipts.filter((r) => r.status === 404).length, 2, "the two home misses leave receipts");
  assert.notEqual(pb.noDemoData, true, "the city's own data is present");
});

test("buildPlaybook passes the abort signal to every Qloo call", async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const resolver = cityResolver();
  const qloo = { mode: "demo", calls: [], get: async (path: string, params: Record<string, unknown>, signal?: AbortSignal) => {
    seen.push(signal);
    const body = resolver(path, params);
    return { ok: body !== undefined, status: body ? 200 : 404, mode: "demo", path, params, url: "u", ms: 0, body: body ?? { error: "none" } };
  } } as unknown as QlooClient;
  const ac = new AbortController();
  await buildPlaybook({ qloo, client: null, model: "m", city: "Asheville, NC", home: "Richmond, VA", comps: COMPS, emit: () => {}, signal: ac.signal });
  assert.equal(seen.length, 11);
  assert.ok(seen.every((s) => s === ac.signal));
});

test("buildPlaybook reports a friendly line (not the raw error) when Claude copy fails", async () => {
  const client = { messages: { parse: async () => { throw new Error("401 invalid x-api-key sk-ant-secret"); } } } as any;
  const qloo = new QlooClient({}, cityResolver());
  const events: any[] = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    const pb = await buildPlaybook({ qloo, client, model: "m", city: "Asheville, NC", home: "Richmond, VA", comps: COMPS, emit: (e) => events.push(e) });
    const status = events.filter((e) => e.type === "status").map((e) => e.message).join("\n");
    assert.match(status, /Claude copy unavailable right now; using templated copy\./);
    assert.doesNotMatch(status, /sk-ant|401|x-api-key/);
    assert.match(pb.card.summary, /Asheville, NC is on the route/);
  } finally {
    console.error = quiet;
  }
});
