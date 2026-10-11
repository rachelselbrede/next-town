// The city playbook: one page per stop, built from five parallel Qloo calls for the city plus two
// for the home market (so "local color" can show what this market's fans love MORE than home).
// The pure helpers (groupPromo, summarizeDemographics, localColorDeltas, fallbackCopy) are exported
// and unit-tested; buildPlaybook wires them together and emits status/receipt/playbook events.

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "./agent.ts";
import type { QlooClient, QlooResult, Rec } from "./qloo.ts";
import { entitiesOf, normalizeAll } from "./qloo.ts";
import type { AppEvent, CardCopy, Comp, Delta, Demographics, Locality, Playbook, PromoGroup, Receipt } from "./types.ts";
import * as Q from "./queries.ts";
import { canonicalUrl } from "./canonical.ts";
import { toReceipt } from "./tools.ts";
import { CARD_SYSTEM } from "./copy.ts";
import tagsFile from "../data/tags.json" with { type: "json" };

const TAG_GROUPS = tagsFile.groups as Record<string, string[]>;
const tagsFor = (groups: readonly string[]) => groups.flatMap((g) => TAG_GROUPS[g] ?? []);

// ---- Promo partners: five groups, each a kind of shop that will hang a poster ----

// Words that place a venue in a promo group, checked against its subtype and tag names.
const PROMO_KEYWORDS: Record<string, string[]> = {
  record_store: ["record"],
  coffee_shop: ["coffee", "cafe", "café", "espresso"],
  bookstore: ["book"],
  dive_bar: ["dive", "bar", "pub", "tavern"],
  vintage: ["vintage", "thrift", "consignment", "secondhand"],
};
const MAX_PER_GROUP_FALLBACK = 2;

function promoKindOf(place: Rec): string | undefined {
  const haystack = [place.subtype ?? "", ...place.tags].map((s) => s.toLowerCase().replace(/[_-]+/g, " "));
  for (const kind of Q.PROMO_TAG_GROUPS) {
    if (haystack.some((h) => PROMO_KEYWORDS[kind].some((w) => h.includes(w)))) return kind;
  }
  return undefined;
}

// Assign each place to a group by subtype or tags. Places that match nothing are dealt round-robin
// into the emptiest groups (up to 2 each) so a thin Qloo result still fills the card. Every group is
// then capped at its two strongest places: that is what the query asks Qloo for (diversify.take=2)
// and what the card has room for, even when a response (or a tag-based match) returns more.
const MAX_PER_GROUP = 2;
export function groupPromo(places: Rec[]): PromoGroup[] {
  const buckets = new Map<string, Rec[]>(Q.PROMO_TAG_GROUPS.map((k) => [k, []]));
  const leftovers: Rec[] = [];
  for (const p of places) {
    const kind = promoKindOf(p);
    if (kind) buckets.get(kind)!.push(p);
    else leftovers.push(p);
  }
  for (const p of leftovers) {
    const target = [...buckets.entries()].filter(([, v]) => v.length < MAX_PER_GROUP_FALLBACK).sort((a, b) => a[1].length - b[1].length)[0];
    if (!target) break;
    target[1].push(p);
  }
  const byAffinity = (a: Rec, b: Rec) => (b.affinity ?? 0) - (a.affinity ?? 0);
  return [...buckets.entries()]
    .filter(([, v]) => v.length > 0)
    .map(([kind, v]) => ({ kind: Q.PROMO_KIND_LABEL[kind] ?? kind, places: v.sort(byAffinity).slice(0, MAX_PER_GROUP) }));
}

// ---- Who shows up: average the age/gender affinities across comps ----

export const AGE_BAND_LABEL: Record<string, string> = {
  "24_and_younger": "under 25",
  "25_to_29": "25 to 29",
  "30_to_34": "30 to 34",
  "35_to_44": "35 to 44",
  "45_to_54": "45 to 54",
  "55_and_older": "55 and older",
};
export const ageBandLabel = (band: string) => AGE_BAND_LABEL[band] ?? band.replace(/_/g, " ");

function averageBands(rows: any[], key: "age" | "gender"): Record<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const row of rows) {
    const bands = row?.query?.[key] ?? row?.[key];
    if (!bands || typeof bands !== "object") continue;
    for (const [band, v] of Object.entries(bands as Record<string, unknown>)) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const s = sums.get(band) ?? { total: 0, n: 0 };
      s.total += v;
      s.n += 1;
      sums.set(band, s);
    }
  }
  const out: Record<string, number> = {};
  for (const [band, s] of sums) out[band] = Math.round((s.total / s.n) * 100) / 100;
  return out;
}

export function summarizeDemographics(body: any): Demographics | null {
  const rows = body?.results?.demographics;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const age = averageBands(rows, "age");
  const gender = averageBands(rows, "gender");
  const ranked = Object.entries(age).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [strongestAge, strongestValue] = ranked[0];

  // Suggestions, not findings: the data is an affinity index for fans of the comps, not a headcount.
  const suggestions: string[] = [];
  if (strongestValue > 0) {
    suggestions.push(`Fans of your comps here index highest at ${ageBandLabel(strongestAge)}; consider pitching rooms and promo partners that already draw that crowd.`);
  } else {
    suggestions.push("No age band indexes positively here; consider treating this as a build-from-scratch market and leaning on the comps' names in promo.");
  }
  const young = age["24_and_younger"];
  if (typeof young === "number" && young >= 0.15 && strongestAge !== "24_and_younger") {
    suggestions.push("The under-25 band is also positive; consider asking rooms whether an all-ages or early show is an option.");
  }
  const older = age["55_and_older"];
  if (typeof older === "number" && older <= -0.15) {
    suggestions.push("The 55-and-older band indexes low; consider a later set time if the room offers a choice.");
  }
  const f = gender.female;
  const m = gender.male;
  if (typeof f === "number" && typeof m === "number" && Math.abs(f - m) >= 0.2 && suggestions.length < 3) {
    const lean = f > m ? "women" : "men";
    suggestions.push(`Affinity leans toward ${lean} among fans of your comps here; consider that when choosing which promo partner gets the poster first.`);
  }
  return { age, gender, strongestAge, suggestions: suggestions.slice(0, 3) };
}

// ---- Local color: what this market's fans love more than the home market's ----

export function localColorDeltas(cityBody: any, homeBody: any): Delta[] {
  const homeAffinity = new Map<string, number>();
  for (const e of entitiesOf(homeBody)) {
    if (typeof e.query?.affinity === "number") homeAffinity.set(e.entity_id, e.query.affinity);
  }
  const deltas: Delta[] = entitiesOf(cityBody)
    .slice(0, Q.C.TAKE_COLOR)
    .map((e) => {
      const cityAffinity = typeof e.query?.affinity === "number" ? e.query.affinity : 0;
      const home = homeAffinity.get(e.entity_id);
      const p = e.properties ?? {};
      const image = typeof p.image === "string" ? p.image : p.image?.url;
      return {
        id: e.entity_id,
        name: e.name,
        ...(image ? { image } : {}),
        cityAffinity,
        homeAffinity: home ?? null,
        delta: home === undefined ? null : Math.round((cityAffinity - home) * 1000) / 1000,
      };
    });
  // Known deltas first (largest lift over home), then the items home never ranked, by city affinity.
  deltas.sort((a, b) => {
    if (a.delta === null && b.delta === null) return b.cityAffinity - a.cityAffinity;
    if (a.delta === null) return 1;
    if (b.delta === null) return -1;
    return b.delta - a.delta || b.cityAffinity - a.cityAffinity;
  });
  return deltas.slice(0, 5);
}

// ---- Card copy ----

type PlaybookData = Omit<Playbook, "card" | "receipts">;

const pct = (x: number | undefined) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "n/a");
const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// Templated copy built only from the data, used when Claude is unavailable or its call fails.
export function fallbackCopy(p: PlaybookData): CardCopy {
  const comps = joinNames(p.comps.map((c) => c.name)) || "your comps";
  const loc = p.locality;
  const topRoom = p.rooms[0];
  const firstPromo = p.promo.find((g) => g.places.length);
  const topBrand = p.localColor.brands[0];
  const topShow = p.localColor.shows[0];

  const whyRank = loc
    ? `fans of ${comps} rank it #${loc.rank} in the US with a ${pct(loc.affinity)} affinity${loc.overIndex ? ", and it is a town under 250k where that audience over-indexes" : ""}`
    : `fans of ${comps} rank it highly in Qloo's locality insights`;
  const summary = `${p.city} is on the route because ${whyRank}. Qloo returned ${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"} and ${p.promo.reduce((n, g) => n + g.places.length, 0)} promo partners nearby for that audience.`;

  const rooms_note = topRoom
    ? `The top room for this audience is ${topRoom.name} (${pct(topRoom.affinity)} affinity${topRoom.why[0] ? `, driven most by ${topRoom.why[0]}` : ""}).`
    : "Qloo returned no rooms for these tags nearby; try widening the search or asking a local promoter.";

  const promo_note = firstPromo
    ? `Start with the ${firstPromo.kind} group: ${firstPromo.places[0].name} ranks ${pct(firstPromo.places[0].affinity)} with fans of ${comps}.`
    : "No promo partners came back for this city; a record store or coffee shop near the room is still the usual first ask.";

  const who_note = p.who
    ? `Fans of ${comps} here index highest at ${ageBandLabel(p.who.strongestAge)}; ${p.who.suggestions[0]?.replace(/^Fans of your comps here index highest at [^;]+; /, "") ?? "consider that when picking the room."}`
    : "Qloo returned no demographic read for this market, so plan the show without assumptions about age.";

  // Only call it a lift over home when we actually have a home affinity to compare against.
  const lifted = [topBrand, topShow].filter((d): d is Delta => !!d && d.delta !== null && d.delta > 0);
  const unranked = [topBrand, topShow].filter((d): d is Delta => !!d && d.delta === null);
  let local_color_note: string;
  if (lifted.length) {
    const bits = lifted.map((d) => `${d.name} (+${Math.round((d.delta as number) * 100)} points vs. ${p.home})`);
    local_color_note = `Fans of ${comps} around ${p.city} over-index on ${joinNames(bits)} compared with ${p.home}; a nod to that on the poster or merch table will land.`;
  } else if (unranked.length) {
    const bits = unranked.map((d) => `${d.name} (${pct(d.cityAffinity)})`);
    local_color_note = `Fans of ${comps} around ${p.city} rank ${joinNames(bits)} highly; ${unranked.length === 1 ? "it does not" : "neither shows up"} in the ${p.home} top list, so lean on ${unranked.length === 1 ? "it" : "them"} here.`;
  } else {
    local_color_note = `No brand or TV-show lift over ${p.home} showed up for this market.`;
  }

  const firstComp = p.comps[0]?.name ?? "your favorite band";
  const promo_copy = [
    `If you love ${firstComp}, come hear who's next: live in ${p.city}.`,
    `Fans of ${comps} keep ${p.city} on the map. Ask us where the show is.`,
  ];

  const caution = "These are aggregate taste affinities from Qloo, not attendance or ticket predictions. Confirm capacity, age policy, and availability with each room directly.";

  return { summary, rooms_note, promo_note, who_note, local_color_note, promo_copy, caution };
}

// JSON schema for Claude's structured output (same fields as CardCopy, every one required).
export const CARD_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "Two sentences on why this market is on the route." },
    rooms_note: { type: "string" },
    promo_note: { type: "string" },
    who_note: { type: "string" },
    local_color_note: { type: "string" },
    promo_copy: { type: "array", items: { type: "string" }, description: "Exactly two short lines a shop could post." },
    caution: { type: "string" },
  },
  required: ["summary", "rooms_note", "promo_note", "who_note", "local_color_note", "promo_copy", "caution"],
  additionalProperties: false,
} as const;

function isCardCopy(x: any): x is CardCopy {
  const keys: Array<keyof CardCopy> = ["summary", "rooms_note", "promo_note", "who_note", "local_color_note", "caution"];
  return !!x && typeof x === "object" && keys.every((k) => typeof x[k] === "string" && x[k].trim()) && Array.isArray(x.promo_copy) && x.promo_copy.every((s: unknown) => typeof s === "string");
}

// What Claude sees: only the fields it is allowed to cite, trimmed so the call stays small.
function cardPayload(p: PlaybookData) {
  const place = (r: Rec) => ({ name: r.name, kind: r.subtype?.split(":").at(-1), affinity: r.affinity, why: r.why, rating: r.rating, description: r.description });
  const color = (d: Delta) => ({ name: d.name, cityAffinity: d.cityAffinity, homeAffinity: d.homeAffinity, deltaVsHome: d.delta });
  return {
    city: p.city,
    home: p.home,
    comps: p.comps.map((c) => c.name),
    locality: p.locality ? { rank: p.locality.rank, affinity: p.locality.affinity, population: p.locality.population, overIndex: p.locality.overIndex, why: p.locality.why } : null,
    rooms: p.rooms.map(place),
    promo: p.promo.map((g) => ({ kind: g.kind, places: g.places.map(place) })),
    who: p.who ? { ...p.who, strongestAgeLabel: ageBandLabel(p.who.strongestAge) } : null,
    localColor: { brands: p.localColor.brands.map(color), shows: p.localColor.shows.map(color) },
  };
}

async function writeCardCopy(client: Anthropic, model: string, p: PlaybookData): Promise<CardCopy> {
  // Thinking is always on for this model family and counts against max_tokens, so leave headroom
  // above the ~250 words of copy; effort is low because the task is short and the data is given.
  const message = await client.messages.parse({
    model,
    max_tokens: 4000,
    system: CARD_SYSTEM,
    messages: [{ role: "user", content: `Write the card copy for this playbook data:\n${JSON.stringify(cardPayload(p))}` }],
    output_config: { effort: "low", format: { type: "json_schema", schema: CARD_SCHEMA as unknown as Record<string, unknown> } },
  });
  if (message.stop_reason === "max_tokens") throw new Error("card copy was cut off (max_tokens)");
  // With a plain JSON schema the SDK leaves parsing to us; parsed_output is set when a parser is attached.
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const parsed = (message.parsed_output as unknown) ?? JSON.parse(text);
  if (!isCardCopy(parsed)) throw new Error("card copy did not match the schema");
  return { ...parsed, promo_copy: parsed.promo_copy.slice(0, 2) };
}

// ---- The playbook itself ----

export interface BuildPlaybookOptions {
  qloo: QlooClient;
  client: Anthropic | null;
  model: string;
  city: string;
  home: string;
  comps: Comp[];
  locality?: Locality;
  emit: (e: AppEvent | AgentEvent) => void;
}

export function noDemoDataCopy(city: string): CardCopy {
  return {
    summary: `${city} is on your edited route, but this demo only carries recorded Qloo answers for the sample's cities. With a Qloo key the same queries run live here.`,
    rooms_note: "",
    promo_note: "",
    who_note: "",
    local_color_note: "",
    promo_copy: [],
    caution: "No recorded data for this city in the demo; nothing on this page comes from Qloo.",
  };
}

export async function buildPlaybook(opts: BuildPlaybookOptions): Promise<Playbook> {
  const { qloo, client, model, city, home, comps, locality, emit } = opts;
  const compIds = comps.map((c) => c.id);
  const comedy = comps.some((c) => c.type === "urn:entity:person");
  const venueTags = tagsFor(comedy ? Q.COMEDY_TAG_GROUPS : Q.VENUE_TAG_GROUPS);
  const promoTags = tagsFor(Q.PROMO_TAG_GROUPS);
  const receipts: Receipt[] = [];

  // One request per canonical URL per playbook: when the city IS the home market the local-color
  // calls would otherwise run twice.
  const inflight = new Map<string, Promise<QlooResult>>();
  const ask = (q: Q.Query): Promise<QlooResult> => {
    const key = canonicalUrl(q.path, q.params);
    let p = inflight.get(key);
    if (!p) {
      p = qloo.get(q.path, q.params).then((r) => {
        const receipt = toReceipt(q.tool, r);
        receipts.push(receipt);
        emit({ type: "receipt", receipt });
        return r;
      });
      inflight.set(key, p);
    }
    return p;
  };

  const compNames = comps.map((c) => c.name).join(", ") || "your comps";
  emit({ type: "status", message: `Asking Qloo which rooms fans of ${compNames} love around ${city}...` });
  emit({ type: "status", message: `Finding record stores, coffee shops, bookstores, dive bars, and vintage shops that audience ranks highly...` });
  emit({ type: "status", message: `Reading the age and gender affinity for fans of your comps near ${city}...` });
  emit({ type: "status", message: `Comparing the brands and TV shows they love against ${home}...` });

  const [rooms, promo, who, cityBrands, cityShows, homeBrands, homeShows] = await Promise.all([
    ask(Q.findRooms(compIds, city, venueTags)),
    ask(Q.findPromoPartners(compIds, city, promoTags)),
    ask(Q.whoShowsUp(compIds, city)),
    ask(Q.localColor(compIds, city, "brand")),
    ask(Q.localColor(compIds, city, "tv_show")),
    ask(Q.localColor(compIds, home, "brand")),
    ask(Q.localColor(compIds, home, "tv_show")),
  ]);

  const data: PlaybookData = {
    city,
    home,
    comps,
    rooms: normalizeAll(rooms.body, Q.C.TAKE_ROOMS),
    promo: groupPromo(normalizeAll(promo.body, Q.C.TAKE_PROMO)),
    who: summarizeDemographics(who.body),
    localColor: { brands: localColorDeltas(cityBrands.body, homeBrands.body), shows: localColorDeltas(cityShows.body, homeShows.body) },
    ...(locality ? { locality } : {}),
  };

  // Demo mode with no recorded fixture for any of this city's queries: there is no Qloo data to
  // describe, so skip Claude and let the UI say plainly that the demo has nothing recorded here.
  const noDemoData = qloo.mode === "demo" && [rooms, promo, who, cityBrands, cityShows].every((r) => !r.ok && r.status === 404);
  if (noDemoData) {
    const playbook: Playbook = { ...data, card: noDemoDataCopy(city), receipts, noDemoData: true };
    emit({ type: "playbook", playbook });
    return playbook;
  }

  let card: CardCopy;
  if (client) {
    emit({ type: "status", message: "Writing the card with Claude..." });
    try {
      card = await writeCardCopy(client, model, data);
    } catch (err) {
      emit({ type: "status", message: `Claude copy unavailable (${err instanceof Error ? err.message : String(err)}); using templated copy.` });
      card = fallbackCopy(data);
    }
  } else {
    card = fallbackCopy(data);
  }

  const playbook: Playbook = { ...data, card, receipts };
  emit({ type: "playbook", playbook });
  return playbook;
}
