// Qloo API client. Live mode calls the hackathon API; demo mode serves recorded fixtures so the
// app runs end to end before the key arrives (and keeps running if the key ever fails).
//
// Docs: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
//   Base URL  https://hackathon.api.qloo.com   Header  X-Api-Key
//   GET /search?query=...                         resolve names to entity IDs
//   GET /v2/tags?filter.query=...                 find tag IDs (cuisines, genres, interests)
//   GET /v2/insights?filter.type=urn:entity:...   recommendations from signals + filters

export type QlooMode = "live" | "demo";

export interface QlooEnv {
  QLOO_API_KEY?: string;
  QLOO_MODE?: string;
  QLOO_BASE_URL?: string;
}

export type Params = Record<string, string | number | boolean | undefined | null>;

export interface QlooEntity {
  entity_id: string;
  name: string;
  type?: string;
  subtype?: string;
  popularity?: number;
  properties?: Record<string, any>;
  tags?: Array<{ id?: string; name?: string; type?: string; tag_id?: string; [k: string]: any }>;
  query?: { affinity?: number; explainability?: any; [k: string]: any };
  location?: { lat?: number; lon?: number };
  [k: string]: any;
}

export interface QlooResult {
  ok: boolean;
  status: number;
  mode: QlooMode;
  path: string;
  params: Params;
  url: string;
  ms: number;
  body: any;
}

export type DemoResolver = (path: string, params: Params) => any | undefined;

export class QlooClient {
  readonly mode: QlooMode;
  private readonly key: string | undefined;
  private readonly base: string;
  private readonly demo: DemoResolver | undefined;
  readonly calls: QlooResult[] = [];

  constructor(env: QlooEnv, demo?: DemoResolver) {
    this.key = env.QLOO_API_KEY?.trim() || undefined;
    this.base = (env.QLOO_BASE_URL || "https://hackathon.api.qloo.com").replace(/\/$/, "");
    const wanted = (env.QLOO_MODE || "auto").toLowerCase();
    this.mode = wanted === "live" ? "live" : wanted === "demo" ? "demo" : this.key ? "live" : "demo";
    this.demo = demo;
  }

  // Build the exact URL a request would use. Exposed so the UI can show judges the real calls.
  url(path: string, params: Params): string {
    const u = new URL(this.base + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async get(path: string, params: Params = {}): Promise<QlooResult> {
    const url = this.url(path, params);
    const t0 = Date.now();
    let result: QlooResult;
    if (this.mode === "demo") {
      const body = this.demo?.(path, params);
      result = { ok: body !== undefined, status: body !== undefined ? 200 : 404, mode: "demo", path, params, url, ms: Date.now() - t0, body: body ?? { error: "no demo fixture for this request" } };
    } else {
      try {
        const res = await fetch(url, { headers: { "X-Api-Key": this.key ?? "", accept: "application/json" } });
        const text = await res.text();
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 2000) };
        }
        result = { ok: res.ok, status: res.status, mode: "live", path, params, url, ms: Date.now() - t0, body };
      } catch (err) {
        result = { ok: false, status: 0, mode: "live", path, params, url, ms: Date.now() - t0, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }
    this.calls.push(result);
    return result;
  }

  // ---- Convenience wrappers around the three documented endpoints ----

  async search(query: string, types?: string, take = 5): Promise<QlooResult> {
    return this.get("/search", { query, types, take });
  }

  async tags(query: string, take = 10): Promise<QlooResult> {
    return this.get("/v2/tags", { "filter.query": query, take });
  }

  async insights(params: Params): Promise<QlooResult> {
    return this.get("/v2/insights", params);
  }
}

// ---- Normalization: turn raw Qloo entities into something the agent and UI can reason about ----

export interface Rec {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  affinity?: number; // 0..1, higher = stronger match to the signals
  popularity?: number; // 0..1 percentile
  rating?: number;
  price_level?: number;
  address?: string;
  city?: string;
  neighborhood?: string;
  description?: string;
  image?: string;
  year?: number | string;
  tags: string[];
  why: string[]; // explainability: which input signals drove this result
  raw?: QlooEntity;
}

export function entitiesOf(body: any): QlooEntity[] {
  if (!body) return [];
  if (Array.isArray(body.results?.entities)) return body.results.entities;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.entities)) return body.entities;
  return [];
}

export function normalize(e: QlooEntity, keepRaw = false): Rec {
  const p = e.properties ?? {};
  const tags = (e.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t.name || t.id || t.tag_id || ""))
    .filter(Boolean)
    .slice(0, 12);
  const why: string[] = [];
  const ex = e.query?.explainability;
  if (ex && typeof ex === "object") {
    const byEntity = ex.by_entity ?? ex["signal.interests.entities"] ?? {};
    for (const [k, v] of Object.entries(byEntity as Record<string, any>)) {
      const score = typeof v === "number" ? v : typeof v?.score === "number" ? v.score : undefined;
      const label = typeof v === "object" && v?.name ? v.name : k;
      why.push(score !== undefined ? `${label} (${Math.round(score * 100)}%)` : String(label));
    }
  }
  const image = typeof p.image === "string" ? p.image : p.image?.url;
  return {
    id: e.entity_id,
    name: e.name,
    type: e.type ?? "",
    subtype: e.subtype,
    affinity: e.query?.affinity,
    popularity: typeof e.popularity === "number" ? e.popularity : p.popularity,
    rating: p.business_rating ?? p.rating,
    price_level: p.price_level,
    address: p.address,
    city: p.geocode?.city ?? p.geocode?.name,
    neighborhood: p.neighborhood ?? p.geocode?.admin2_region,
    description: typeof p.description === "string" ? p.description.slice(0, 400) : undefined,
    image,
    year: p.release_year ?? p.publication_year ?? p.release_date,
    tags,
    why,
    raw: keepRaw ? e : undefined,
  };
}

export function normalizeAll(body: any, limit = 20): Rec[] {
  return entitiesOf(body).slice(0, limit).map((e) => normalize(e));
}

// Entity types the Insights API accepts for filter.type.
export const ENTITY_TYPES = [
  "urn:entity:artist",
  "urn:entity:book",
  "urn:entity:brand",
  "urn:entity:destination",
  "urn:entity:movie",
  "urn:entity:person",
  "urn:entity:place",
  "urn:entity:podcast",
  "urn:entity:tv_show",
  "urn:entity:video_game",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export function asEntityType(s: string): EntityType | undefined {
  const t = s.startsWith("urn:entity:") ? s : `urn:entity:${s}`;
  return (ENTITY_TYPES as readonly string[]).includes(t) ? (t as EntityType) : undefined;
}
