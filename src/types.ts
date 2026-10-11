// Shared types for Next Town. Everything the server sends to the browser is described here.
import type { Rec } from "./qloo.ts";

export type Format = "music" | "comedy";

export interface PlanRequest {
  comps: string[]; // 1-3 names, e.g. ["Big Thief", "Waxahatchee"]
  home: string; // "Richmond, VA"
  days: number; // 3..21
  driveHoursCap: number; // 2..10
  format: Format;
  scenarioId?: string; // "hollow-pines" replays the recorded scenario when not in live mode
}

export interface Comp {
  id: string;
  name: string;
  type: string; // urn:entity:artist | urn:entity:person
  popularity?: number;
  image?: string;
}

export interface Locality {
  id: string;
  name: string; // "Asheville"
  state?: string; // "NC"
  label: string; // "Asheville, NC"
  rank: number; // 1-based affinity rank from Qloo
  affinity: number; // 0..1
  population?: number; // from data/us-places.json (Census)
  lat?: number;
  lon?: number;
  overIndex: boolean; // population < 250k && rank <= 20
  why: string[]; // explainability chips, e.g. "Big Thief (71%)"
}

export interface RouteStop {
  localityId: string;
  label: string;
  lat: number;
  lon: number;
  day: number; // 1-based day the show happens
  legMiles: number; // from previous stop (0 for first)
  legHours: number;
  driveDay: boolean; // true when a rest/drive day precedes this stop
  rank?: number;
  affinity?: number;
  overIndex?: boolean;
  population?: number;
}

export interface Route {
  home: { label: string; lat: number; lon: number };
  stops: RouteStop[];
  totalMiles: number;
  totalHours: number;
  driveDays: number;
  days: number;
  notes: string[]; // the judgment calls the planner made, in plain words
}

export interface ObviousRoute {
  cities: string[]; // the usual-suspects streaming markets, labels "Nashville, TN"
  overlap: string[]; // route stops that are also usual suspects
  smallTowns: number; // route stops with population < 250k and rank <= 20
  summary: string;
}

export interface Receipt {
  id: string;
  tool: string;
  method: "GET";
  url: string; // exact URL, key never included
  mode: "live" | "demo";
  status: number;
  ms: number;
  resultCount: number;
  top: Array<{ name: string; affinity?: number }>;
  note?: string; // e.g. "served from recorded fixture after a live timeout"
}

export interface PromoGroup {
  kind: string; // "record store" | "coffee shop" | "bookstore" | "dive bar" | "vintage"
  places: Rec[];
}

export interface Demographics {
  age: Record<string, number>; // band -> affinity, e.g. "24_and_younger": 0.42
  gender: Record<string, number>;
  strongestAge: string;
  suggestions: string[];
}

export interface Delta {
  id: string;
  name: string;
  image?: string;
  cityAffinity: number;
  homeAffinity: number | null; // null = not in the home top list
  delta: number | null;
}

export interface CardCopy {
  summary: string; // 2 sentences on why this market is on the route
  rooms_note: string;
  promo_note: string;
  who_note: string;
  local_color_note: string;
  promo_copy: string[]; // 2 lines
  caution: string;
}

export interface Playbook {
  city: string; // "Asheville, NC"
  home: string;
  comps: Comp[];
  rooms: Rec[];
  promo: PromoGroup[];
  who: Demographics | null;
  localColor: { brands: Delta[]; shows: Delta[] };
  card: CardCopy;
  receipts: Receipt[];
  locality?: Locality;
  noDemoData?: boolean; // demo mode, and none of this city's Qloo queries has a recorded fixture
}

export interface Pitch {
  text: string; // ~150 words for a booking agent
  itinerary: Array<{ day: number; city: string; driveHours: number; overIndex: boolean; topRoom?: string; topPromo?: string; ageRead?: string }>;
  totalMiles: number;
}

// Server-sent event payloads (event name = `type`). The generic agent events from src/agent.ts
// (turn, thinking, text, tool_call, tool_result, status, done, error) are also forwarded as-is.
export type AppEvent =
  | { type: "meta"; qlooMode: "live" | "demo"; model: string; recorded: boolean; fixtureNote?: string }
  | { type: "comps"; comps: Comp[] }
  | { type: "markets"; localities: Locality[] }
  | { type: "route"; route: Route; obvious: ObviousRoute }
  | { type: "receipt"; receipt: Receipt }
  | { type: "playbook"; playbook: Playbook }
  | { type: "pitch"; pitch: Pitch };
