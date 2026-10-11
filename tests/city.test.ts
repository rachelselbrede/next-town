// Pure helpers behind the city playbook, fed small synthetic Qloo bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rec } from "../src/qloo.ts";
import { groupPromo, summarizeDemographics, localColorDeltas, fallbackCopy, ageBandLabel, CARD_SCHEMA } from "../src/city.ts";
import type { Playbook } from "../src/types.ts";

const rec = (id: string, name: string, extra: Partial<Rec> = {}): Rec => ({ id, name, type: "urn:entity:place", tags: [], why: [], ...extra });

test("groupPromo assigns by subtype, then by tag names, and sorts each group by affinity", () => {
  const groups = groupPromo([
    rec("1", "Plan 9", { subtype: "urn:entity:place:record_store", affinity: 0.7 }),
    rec("2", "Harvest", { subtype: "urn:entity:place:record_store", affinity: 0.9 }),
    rec("3", "Lamplighter", { subtype: "urn:entity:place:restaurant", tags: ["Coffee Shop"], affinity: 0.8 }),
    rec("4", "Chop Suey Books", { subtype: "urn:entity:place:bookstore", affinity: 0.6 }),
    rec("5", "Bamboo Cafe", { subtype: "urn:entity:place:bar", tags: ["Dive Bar"], affinity: 0.5 }),
    rec("6", "Rumors", { subtype: "urn:entity:place:vintage_store", affinity: 0.4 }),
  ]);
  const kinds = groups.map((g) => g.kind);
  assert.deepEqual(kinds, ["record store", "coffee shop", "bookstore", "dive bar", "vintage shop"]);
  assert.deepEqual(groups[0].places.map((p) => p.name), ["Harvest", "Plan 9"]);
  assert.equal(groups[1].places[0].name, "Lamplighter");
  assert.equal(groups[3].places[0].name, "Bamboo Cafe");
});

test("groupPromo deals unmatched places round-robin, two per group at most, and drops empty groups", () => {
  const places = Array.from({ length: 12 }, (_, i) => rec(String(i), `Mystery ${i}`, { subtype: "urn:entity:place:unknown", affinity: 1 - i / 100 }));
  const groups = groupPromo(places);
  assert.equal(groups.length, 5);
  for (const g of groups) assert.equal(g.places.length, 2, `${g.kind} should hold two`);
  // 12 places, 10 slots: the last two have nowhere to go.
  assert.equal(groups.reduce((n, g) => n + g.places.length, 0), 10);
  assert.deepEqual(groupPromo([]), []);
});

const demoBody = {
  results: {
    demographics: [
      { entity_id: "A", query: { age: { "24_and_younger": 0.2, "25_to_29": 0.5, "30_to_34": 0.6, "55_and_older": -0.3 }, gender: { female: 0.3, male: -0.1 } } },
      { entity_id: "B", query: { age: { "24_and_younger": 0.1, "25_to_29": 0.4, "30_to_34": 0.5, "55_and_older": -0.2 }, gender: { female: 0.2, male: -0.1 } } },
    ],
  },
};

test("summarizeDemographics averages across comps and names the strongest positive band", () => {
  const d = summarizeDemographics(demoBody);
  assert.ok(d);
  assert.equal(d.age["30_to_34"], 0.55);
  assert.equal(d.age["25_to_29"], 0.45);
  assert.equal(d.age["24_and_younger"], 0.15);
  assert.equal(d.gender.female, 0.25);
  assert.equal(d.strongestAge, "30_to_34");
  assert.ok(d.suggestions.length >= 1 && d.suggestions.length <= 3);
  // Suggestions are phrased as suggestions, never as facts about people.
  for (const s of d.suggestions) assert.match(s, /consider/i);
  assert.match(d.suggestions[0], /30 to 34/);
  // The under-25 band is positive enough to earn the all-ages suggestion.
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

const entity = (id: string, name: string, affinity: number) => ({ entity_id: id, name, type: "urn:entity:brand", query: { affinity } });

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

test("localColorDeltas copes with an empty home list and an empty city list", () => {
  const city = { results: { entities: [entity("a", "Patagonia", 0.9)] } };
  const only = localColorDeltas(city, { results: { entities: [] } });
  assert.equal(only.length, 1);
  assert.equal(only[0].delta, null);
  assert.deepEqual(localColorDeltas({ results: { entities: [] } }, city), []);
  assert.deepEqual(localColorDeltas(null, null), []);
});

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
  },
  locality: { id: "L", name: "Asheville", state: "NC", label: "Asheville, NC", rank: 1, affinity: 0.934, population: 94589, overIndex: true, why: ["Big Thief (72%)"] },
};

test("fallbackCopy fills every field from the data and makes no forbidden claims", () => {
  const card = fallbackCopy(partial);
  for (const k of ["summary", "rooms_note", "promo_note", "who_note", "local_color_note", "caution"] as const) {
    assert.ok(card[k].trim().length > 20, `${k} is written`);
  }
  assert.equal(card.promo_copy.length, 2);
  assert.match(card.summary, /#1/);
  assert.match(card.summary, /93%/);
  assert.match(card.summary, /over-index/);
  assert.match(card.rooms_note, /The Grey Eagle/);
  assert.match(card.rooms_note, /Big Thief \(78%\)/);
  assert.match(card.promo_note, /Harvest Records/);
  assert.match(card.who_note, /30 to 34/);
  assert.match(card.local_color_note, /Patagonia \(\+20 points vs\. Richmond, VA\)/);
  assert.doesNotMatch(card.local_color_note, /Fleabag/, "a show with no home affinity is not described as a lift over home");
  assert.match(card.caution, /aggregate/i);
  const all = Object.values(card).flat().join(" ");
  assert.doesNotMatch(all, /people in Asheville/i);
  assert.doesNotMatch(all, /capacity of|sold out|tickets sold/i);
});

test("fallbackCopy never claims a lift over home when the home list is empty", () => {
  const card = fallbackCopy({ ...partial, localColor: { brands: [{ id: "b", name: "Patagonia", cityAffinity: 0.9, homeAffinity: null, delta: null }], shows: [] } });
  assert.doesNotMatch(card.local_color_note, /over-index|points vs/);
  assert.match(card.local_color_note, /Patagonia \(90%\)/);
  assert.match(card.local_color_note, /does not .* Richmond, VA top list/);
});

test("fallbackCopy degrades gracefully when Qloo returned nothing", () => {
  const card = fallbackCopy({ ...partial, rooms: [], promo: [], who: null, localColor: { brands: [], shows: [] }, locality: undefined });
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
