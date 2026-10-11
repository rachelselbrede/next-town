// The city playbook: one page per stop, built from parallel Qloo calls: rooms, five promo groups
// (one call per kind), the brands and TV shows for the city and for the home market (so "local
// color" can show what this market's fans love MORE than home), plus one demographics read for
// fans of the comps overall (urn:demographics takes no location).
// The pure helpers (groupPromo, summarizeDemographics, localColorDeltas, fallbackCopy) are exported
// and unit-tested; buildPlaybook wires them together and emits status/receipt/playbook events.

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentEvent } from "./agent.ts";
import type { QlooClient, QlooResult, Rec } from "./qloo.ts";
import { entitiesOf, normalizeAll } from "./qloo.ts";
import type { AppEvent, CardCopy, Comp, Delta, Demographics, Locality, Playbook, PromoGroup, Receipt } from "./types.ts";
import * as Q from "./queries.ts";
import { canonicalUrl } from "./canonical.ts";
import { tagsFor, toReceipt } from "./tools.ts";
import { CARD_SYSTEM } from "./copy.ts";

// ---- Promo partners: five groups, each a kind of shop that will hang a poster ----

// One Qloo call per kind returns up to two places; the kind is known from the call, not guessed
// from a subtype. A place that comes back for two kinds (a bar that is also a record store) stays
// in the first group that returned it. Each group is sorted by affinity and capped at two.
const MAX_PER_GROUP = 2;
export function groupPromo(byGroup: Array<{ group: string; places: Rec[] }>): PromoGroup[] {
  const seen = new Set<string>();
  const byAffinity = (a: Rec, b: Rec) => (b.affinity ?? 0) - (a.affinity ?? 0);
  const out: PromoGroup[] = [];
  for (const { group, places } of byGroup) {
    const fresh: Rec[] = [];
    for (const p of [...places].sort(byAffinity)) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      fresh.push(p);
      if (fresh.length === MAX_PER_GROUP) break;
    }
    if (fresh.length) out.push({ kind: Q.PROMO_KIND_LABEL[group] ?? group, places: fresh });
  }
  return out;
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

  // Suggestions, not findings: the data is an affinity index for fans of the comps overall (Qloo's
  // demographics read takes no location), not a headcount for this city.
  const suggestions: string[] = [];
  if (strongestValue > 0) {
    suggestions.push(`Fans of your comps overall index highest at ${ageBandLabel(strongestAge)}; consider leading with rooms and promo partners that program for that age range.`);
  } else {
    suggestions.push("No age band indexes positively for fans of your comps overall; consider treating this as a build-from-scratch market and leaning on the comps' names in promo.");
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
    suggestions.push(`Affinity leans toward ${lean} among fans of your comps overall; consider that when choosing which promo partner gets the poster first.`);
  }
  return { scope: "comps-overall", age, gender, strongestAge, suggestions: suggestions.slice(0, 3) };
}

// ---- Local color: what this market's fans love more than the home market's ----

// `homeBody` may be null/undefined when the home call failed: every delta is then null.
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

export const OVER_INDEX_MEANS = "population under 250,000 and a national affinity rank of 20 or better (not a comparison with home)";

// Templated copy built only from the data, used when Claude is unavailable or its call fails.
export function fallbackCopy(p: PlaybookData): CardCopy {
  const comps = joinNames(p.comps.map((c) => c.name)) || "your comps";
  const loc = p.locality;
  const topRoom = p.rooms[0];
  const firstPromo = p.promo.find((g) => g.places.length);
  const topBrand = p.localColor.brands[0];
  const topShow = p.localColor.shows[0];
  const homeAvailable = p.localColor.homeAvailable !== false;

  const whyRank = loc
    ? `its best-matching room${loc.topRoom?.name ? ` (${loc.topRoom.name})` : ""} ranks #${loc.rank} nationally for fans of ${comps} with a ${pct(loc.affinity)} affinity${loc.overIndex ? ", and it is an over-index town: under 250,000 people with a national rank of 20 or better" : ""}`
    : `fans of ${comps} rank a room there highly in Qloo's place insights`;
  const summary = `${p.city} is on the route because ${whyRank}. Qloo returned ${p.rooms.length} room${p.rooms.length === 1 ? "" : "s"} and ${p.promo.reduce((n, g) => n + g.places.length, 0)} promo partners nearby for that audience.`;

  const rooms_note = topRoom
    ? `The top room for this audience is ${topRoom.name} (${pct(topRoom.affinity)} affinity${topRoom.why[0] ? `, driven most by ${topRoom.why[0]}` : ""}).`
    : "Qloo returned no rooms for these tags nearby; try widening the search or asking a local promoter.";

  const promo_note = firstPromo
    ? `Start with the ${firstPromo.kind} group: ${firstPromo.places[0].name} ranks ${pct(firstPromo.places[0].affinity)} with fans of ${comps}.`
    : "No promo partners came back for this city; a record store or coffee shop near the room is still the usual first ask.";

  const who_note = p.who
    ? `Fans of ${comps} overall (Qloo's demographics read is not per city) index highest at ${ageBandLabel(p.who.strongestAge)}; ${p.who.suggestions[0]?.replace(/^Fans of your comps overall index highest at [^;]+; /, "") ?? "consider that when picking the room."}`
    : "Qloo returned no demographic read for fans of your comps, so plan the show without assumptions about age.";

  // Only call it a lift over home when we actually have a home affinity to compare against.
  const lifted = [topBrand, topShow].filter((d): d is Delta => !!d && d.delta !== null && d.delta > 0);
  const unranked = [topBrand, topShow].filter((d): d is Delta => !!d && d.delta === null);
  let local_color_note: string;
  if (!homeAvailable) {
    const bits = [topBrand, topShow].filter((d): d is Delta => !!d).map((d) => `${d.name} (${pct(d.cityAffinity)})`);
    local_color_note = bits.length
      ? `The home comparison is unavailable for this run (the ${p.home} calls did not return), so these are simply what fans of ${comps} around ${p.city} rank highest: ${joinNames(bits)}.`
      : `The home comparison is unavailable for this run (the ${p.home} calls did not return), and no brands or shows came back for ${p.city}.`;
  } else if (lifted.length) {
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

// What Claude sees: only the fields it is allowed to cite, trimmed so the call stays small, with
// each number labeled by what it actually means so the copy cannot drift into a bigger claim.
export function cardPayload(p: PlaybookData) {
  const place = (r: Rec, kind?: string) => ({ name: r.name, ...(kind ? { kind } : {}), affinity: r.affinity, why: r.why, rating: r.rating, description: r.description });
  const color = (d: Delta) => ({ name: d.name, cityAffinity: d.cityAffinity, homeAffinity: d.homeAffinity, deltaVsHome: d.delta });
  const homeAvailable = p.localColor.homeAvailable !== false;
  return {
    city: p.city,
    home: p.home,
    comps: p.comps.map((c) => c.name),
    locality: p.locality
      ? {
          nationalAffinityRank: p.locality.rank,
          affinity: p.locality.affinity,
          population: p.locality.population,
          overIndex: p.locality.overIndex,
          overIndexMeans: OVER_INDEX_MEANS,
          topRoom: p.locality.topRoom?.name,
          why: p.locality.why,
        }
      : null,
    rooms: p.rooms.map((r) => place(r)),
    promo: p.promo.map((g) => ({ kind: g.kind, places: g.places.map((r) => place(r, g.kind)) })),
    who: p.who
      ? { ...p.who, scope: "fans of the comps overall, not this city (Qloo's demographics read takes no location)", strongestAgeLabel: ageBandLabel(p.who.strongestAge) }
      : null,
    localColor: {
      homeAvailable,
      ...(homeAvailable ? {} : { note: `The home comparison is unavailable for this run: the ${p.home} calls failed, so homeAffinity and deltaVsHome are null for every item. Say so; do not say an item is missing from the home list.` }),
      brands: p.localColor.brands.map(color),
      shows: p.localColor.shows.map(color),
    },
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
  signal?: AbortSignal; // the request's abort signal: cancels live Qloo calls when the reader leaves
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
  const { qloo, client, model, city, home, comps, locality, emit, signal } = opts;
  const compIds = comps.map((c) => c.id);
  const names: Record<string, string> = Object.fromEntries(comps.filter((c) => c.id && c.name).map((c) => [c.id, c.name]));
  const comedy = comps.some((c) => c.type === "urn:entity:person");
  const venueTags = tagsFor(comedy ? Q.COMEDY_TAG_GROUPS : Q.VENUE_TAG_GROUPS);
  const receipts: Receipt[] = [];

  // One request per canonical URL per playbook: when the city IS the home market the local-color
  // calls would otherwise run twice.
  const inflight = new Map<string, Promise<QlooResult>>();
  const ask = (q: Q.Query): Promise<QlooResult> => {
    const key = canonicalUrl(q.path, q.params);
    let p = inflight.get(key);
    if (!p) {
      p = qloo.get(q.path, q.params, signal).then((r) => {
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
  emit({ type: "status", message: `Finding record stores, coffee shops, bookstores, dive bars, and vintage shops that audience ranks highly (one call per kind)...` });
  emit({ type: "status", message: `Reading the age and gender affinity for fans of your comps overall (Qloo's demographics read is not per city)...` });
  emit({ type: "status", message: `Comparing the brands and TV shows they love against ${home}...` });

  const promoGroups = [...Q.PROMO_TAG_GROUPS];
  const [rooms, who, cityBrands, cityShows, homeBrands, homeShows, ...promoResults] = await Promise.all([
    ask(Q.findRooms(compIds, city, venueTags)),
    ask(Q.whoShowsUp(compIds)),
    ask(Q.localColor(compIds, city, "brand")),
    ask(Q.localColor(compIds, city, "tv_show")),
    ask(Q.localColor(compIds, home, "brand")),
    ask(Q.localColor(compIds, home, "tv_show")),
    ...promoGroups.map((group) => ask(Q.findPromoGroup(compIds, city, tagsFor([group])))),
  ]);

  // The home comparison only exists when both home calls answered; otherwise every delta is null
  // and the copy says the comparison is unavailable (never "not in the home top list").
  const homeAvailable = homeBrands.ok && homeShows.ok;
  const data: PlaybookData = {
    city,
    home,
    comps,
    rooms: normalizeAll(rooms.body, Q.C.TAKE_ROOMS, names),
    promo: groupPromo(promoGroups.map((group, i) => ({ group, places: normalizeAll(promoResults[i].body, Q.C.TAKE_PROMO, names) }))),
    who: summarizeDemographics(who.body),
    localColor: {
      brands: localColorDeltas(cityBrands.body, homeAvailable ? homeBrands.body : null),
      shows: localColorDeltas(cityShows.body, homeAvailable ? homeShows.body : null),
      homeAvailable,
    },
    ...(locality ? { locality } : {}),
  };

  // Demo mode with no recorded fixture for any of this city's own queries (the demographics read is
  // shared and the home calls belong to home): there is no Qloo data to describe, so skip Claude and
  // let the UI say plainly that the demo has nothing recorded here.
  const cityCalls = [rooms, cityBrands, cityShows, ...promoResults];
  const noDemoData = qloo.mode === "demo" && cityCalls.every((r) => !r.ok && r.status === 404);
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
      console.error("card copy failed:", err);
      emit({ type: "status", message: "Claude copy unavailable right now; using templated copy." });
      card = fallbackCopy(data);
    }
  } else {
    card = fallbackCopy(data);
  }

  const playbook: Playbook = { ...data, card, receipts };
  emit({ type: "playbook", playbook });
  return playbook;
}
