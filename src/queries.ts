// Every Qloo request Next Town makes, built from a small set of inputs with fixed constants.
// Claude decides WHICH query to run and for WHICH city; the parameters are composed here so the
// canonical URL (and therefore the fixture key and cache key) is deterministic.
//
// Parameter names follow the Qloo Insights API reference (docs.qloo.com/reference). scripts/verify.ts
// checks each shape against the real hackathon tier the day the key arrives.

import type { Params } from "./qloo.ts";
import { idList, normalizeCity } from "./canonical.ts";

export const C = {
  TAKE_SEARCH: 5,
  TAKE_MARKETS: 50,
  TAKE_ROOMS: 8,
  TAKE_PROMO: 12,
  TAKE_COLOR: 20,
  TAKE_OPENERS: 10,
  RADIUS_PLACE: 15000, // meters: filter.location.radius for rooms and promo partners
  RADIUS_SIGNAL: 25000, // meters: signal.location.radius for demographics and local color
  OVER_INDEX_POP: 250_000,
  OVER_INDEX_RANK: 20,
} as const;

export interface Query {
  tool: string;
  path: string;
  params: Params;
}

export const searchAct = (name: string, format: "music" | "comedy"): Query => ({
  tool: "resolve_act",
  path: "/search",
  params: { query: name.trim(), types: format === "comedy" ? "urn:entity:person" : "urn:entity:artist", take: C.TAKE_SEARCH },
});

export const findTags = (term: string): Query => ({
  tool: "find_tags",
  path: "/v2/tags",
  params: { "filter.query": term.trim(), take: 10 },
});

export const rankMarkets = (compIds: string[]): Query => ({
  tool: "rank_markets",
  path: "/v2/insights",
  params: {
    "filter.type": "urn:entity:locality",
    "signal.interests.entities": idList(compIds),
    "filter.geocode.country_code": "US",
    take: C.TAKE_MARKETS,
    "feature.explainability": "true",
  },
});

export const findRooms = (compIds: string[], city: string, tagIds: string[]): Query => ({
  tool: "find_rooms",
  path: "/v2/insights",
  params: {
    "filter.type": "urn:entity:place",
    "filter.location.query": normalizeCity(city),
    "filter.location.radius": C.RADIUS_PLACE,
    "filter.tags": idList(tagIds),
    "operator.filter.tags": "union",
    "signal.interests.entities": idList(compIds),
    sort_by: "affinity",
    take: C.TAKE_ROOMS,
    "feature.explainability": "true",
  },
});

export const findPromoPartners = (compIds: string[], city: string, tagIds: string[]): Query => ({
  tool: "find_promo_partners",
  path: "/v2/insights",
  params: {
    "filter.type": "urn:entity:place",
    "filter.location.query": normalizeCity(city),
    "filter.location.radius": C.RADIUS_PLACE,
    "filter.tags": idList(tagIds),
    "operator.filter.tags": "union",
    "signal.interests.entities": idList(compIds),
    "diversify.by": "properties.subtype",
    "diversify.take": 2,
    sort_by: "affinity",
    take: C.TAKE_PROMO,
    "feature.explainability": "true",
  },
});

export const whoShowsUp = (compIds: string[], city: string): Query => ({
  tool: "who_shows_up",
  path: "/v2/insights",
  params: {
    "filter.type": "urn:demographics",
    "signal.interests.entities": idList(compIds),
    "signal.location.query": normalizeCity(city),
    "signal.location.radius": C.RADIUS_SIGNAL,
  },
});

export const localColor = (compIds: string[], city: string, type: "brand" | "tv_show"): Query => ({
  tool: "local_color",
  path: "/v2/insights",
  params: {
    "filter.type": `urn:entity:${type}`,
    "signal.interests.entities": idList(compIds),
    "signal.location.query": normalizeCity(city),
    "signal.location.radius": C.RADIUS_SIGNAL,
    take: C.TAKE_COLOR,
  },
});

export const openersToAsk = (compIds: string[], city: string): Query => ({
  tool: "openers_to_ask",
  path: "/v2/insights",
  params: {
    "filter.type": "urn:entity:artist",
    "signal.interests.entities": idList(compIds),
    "signal.location.query": normalizeCity(city),
    "signal.location.radius": C.RADIUS_SIGNAL,
    "filter.popularity.max": 0.6,
    "filter.exclude.entities": idList(compIds),
    "bias.trends": "medium",
    take: C.TAKE_OPENERS,
    "feature.explainability": "true",
  },
});

// The place-tag groups a playbook needs. Real tag ids live in data/tags.json (frozen by verify.ts).
export const VENUE_TAG_GROUPS = ["music_venue", "concert_hall", "live_music_bar"] as const;
export const COMEDY_TAG_GROUPS = ["comedy_club"] as const;
export const PROMO_TAG_GROUPS = ["record_store", "coffee_shop", "bookstore", "dive_bar", "vintage"] as const;
export const PROMO_KIND_LABEL: Record<string, string> = {
  record_store: "record store",
  coffee_shop: "coffee shop",
  bookstore: "bookstore",
  dive_bar: "dive bar",
  vintage: "vintage shop",
};
