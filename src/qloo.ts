// Qloo API client. Live mode calls the hackathon API; demo mode serves recorded fixtures so the
// app runs end to end before the key arrives (and keeps running if the key ever fails).
//
// Docs: https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide
//   Base URL  https://hackathon.api.qloo.com   Header  X-Api-Key
//   GET /search?query=...                         resolve names to entity IDs
//   GET /v2/tags?filter.query=...                 find tag IDs (cuisines, genres, interests)
//   GET /v2/insights?filter.type=urn:entity:...   recommendations from signals + filters

import { canonicalUrl } from "./canonical.ts";

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
  cached?: boolean; // live answer served from this server's private in-memory cache
  note?: string; // plain-words explanation when something unusual happened (retry, fallback)
}

export type DemoResolver = (path: string, params: Params) => any | undefined;

// ---- Live-call policy ----
// The hackathon key is rate limited (about 5 requests per second), so live calls share a small
// concurrency cap, retry 429/5xx/network errors with a short backoff, and give up after 8 s.
const LIVE_TIMEOUT_MS = 8000;
const RETRY_DELAYS_MS = [400, 1200];
const MAX_CONCURRENT = 4;

// Private, per-isolate, in-memory cache of successful live responses, keyed by canonical URL.
// The hackathon FAQ allows private server-side caching; nothing here is ever written to disk or git.
const LIVE_CACHE_MAX = 400;
const liveCache = new Map<string, { status: number; body: any }>();

let active = 0;
const waiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  // The releasing call hands its slot straight to us, so `active` stays at the cap.
  await new Promise<void>((resolve) => waiters.push(resolve));
}
function releaseSlot(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

const retryable = (status: number) => status === 0 || status === 429 || status >= 500;

/** Test hook: forget cached live responses. */
export function resetQlooCache(): void {
  liveCache.clear();
}

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

  // `signal` is the caller's abort signal (the browser went away, "Skip ahead"); it cancels the
  // live request and any retry wait.
  async get(path: string, params: Params = {}, signal?: AbortSignal): Promise<QlooResult> {
    const url = this.url(path, params);
    const t0 = Date.now();
    let result: QlooResult;
    if (this.mode === "demo") {
      const body = this.demo?.(path, params);
      result = { ok: body !== undefined, status: body !== undefined ? 200 : 404, mode: "demo", path, params, url, ms: Date.now() - t0, body: body ?? { error: "no demo fixture for this request" } };
    } else {
      result = await this.live(path, params, url, t0, signal);
    }
    this.calls.push(result);
    return result;
  }

  private async live(path: string, params: Params, url: string, t0: number, signal?: AbortSignal): Promise<QlooResult> {
    const key = canonicalUrl(path, params, this.base);
    const hit = liveCache.get(key);
    if (hit) return { ok: true, status: hit.status, mode: "live", path, params, url, ms: 0, body: hit.body, cached: true };

    let status = 0;
    let body: any;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1], signal);
      signal?.throwIfAborted();
      await acquireSlot();
      try {
        const timeout = AbortSignal.timeout(LIVE_TIMEOUT_MS);
        const res = await fetch(url, {
          headers: { "X-Api-Key": this.key ?? "", accept: "application/json" },
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        status = res.status;
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 2000) };
        }
      } catch (err) {
        if (signal?.aborted) throw err; // the caller left; do not retry or fall back
        status = 0;
        const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
        body = { error: timedOut ? `no answer within ${LIVE_TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err) };
      } finally {
        releaseSlot();
      }
      if (!retryable(status)) break;
    }

    const ok = status >= 200 && status < 300;
    if (ok) {
      if (liveCache.size >= LIVE_CACHE_MAX) liveCache.delete(liveCache.keys().next().value!);
      liveCache.set(key, { status, body });
      return { ok, status, mode: "live", path, params, url, ms: Date.now() - t0, body };
    }

    // The live call failed. If a recorded fixture exists for this exact request, serve it and say so,
    // so a judge sees a working card and an honest receipt instead of an empty one.
    const fallback = this.demo?.(path, params);
    if (fallback !== undefined) {
      const why = status ? `HTTP ${status}` : String(body?.error ?? "network error");
      return { ok: true, status: 200, mode: "demo", path, params, url, ms: Date.now() - t0, body: fallback, note: `Live Qloo call failed (${why}); served the recorded fixture instead.` };
    }
    return { ok: false, status, mode: "live", path, params, url, ms: Date.now() - t0, body };
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
  tags: string[]; // tag names (or ids when a tag has no name)
  tagIds: string[]; // tag ids, for matching against data/tags.json groups
  why: string[]; // explainability chips: "Big Thief (71%)", strongest first
  lat?: number;
  lon?: number;
  region?: string; // geocode admin1_region (state), when present
  raw?: QlooEntity;
}

export interface ExplainItem {
  id: string;
  name?: string;
  score?: number;
}

// Explainability arrives in more than one shape. The documented per-result shape (and the one the
// hackathon host returns) is `{ "signal.interests.entities": [{ entity_id, score }] }`, with no names;
// older examples use a `by_entity` map. Accept both; map ids to names with `names` (the resolved comps).
// The top-level `query.explainability` carries per-entity averages over top-N subsets; for those the
// "all" subset (or the first number found) is used as the score.
export function explainEntries(ex: any, names?: Record<string, string>): ExplainItem[] {
  if (!ex || typeof ex !== "object") return [];
  const scoreOf = (v: any): number | undefined => {
    if (typeof v === "number") return v;
    if (!v || typeof v !== "object") return undefined;
    for (const k of ["score", "average", "avg", "all", "value"]) if (typeof v[k] === "number") return v[k];
    for (const k of ["subsets", "averages", "by_subset"]) if (v[k] && typeof v[k] === "object") return scoreOf(v[k]);
    const first = Object.values(v).find((x) => typeof x === "number");
    return typeof first === "number" ? first : undefined;
  };
  let items: ExplainItem[] = [];
  const list = ex["signal.interests.entities"] ?? ex.entities;
  if (Array.isArray(list)) {
    items = list
      .filter((x: any) => x && typeof x === "object")
      .map((x: any) => ({ id: String(x.entity_id ?? x.id ?? ""), name: typeof x.name === "string" ? x.name : undefined, score: scoreOf(x) }));
  } else {
    const map = ex.by_entity ?? (list && typeof list === "object" ? list : undefined);
    if (map && typeof map === "object") {
      items = Object.entries(map as Record<string, any>).map(([id, v]) => ({ id, name: typeof v?.name === "string" ? v.name : undefined, score: scoreOf(v) }));
    }
  }
  return items
    .filter((i) => i.id)
    .map((i) => ({ ...i, name: names?.[i.id] ?? i.name }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

export function explainChips(ex: any, names?: Record<string, string>): string[] {
  return explainEntries(ex, names).map((i) => {
    const label = i.name ?? `entity ${i.id.slice(0, 8)}`;
    return typeof i.score === "number" ? `${label} (${Math.round(i.score * 100)}%)` : label;
  });
}

export function entitiesOf(body: any): QlooEntity[] {
  if (!body) return [];
  if (Array.isArray(body.results?.entities)) return body.results.entities;
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.entities)) return body.entities;
  return [];
}

// `names` maps entity ids to display names (the resolved comps) for the explainability chips.
export function normalize(e: QlooEntity, keepRaw = false, names?: Record<string, string>): Rec {
  const p = e.properties ?? {};
  const rawTags = (e.tags ?? []) as Array<any>;
  const tags = rawTags
    .map((t) => (typeof t === "string" ? t : t.name || t.id || t.tag_id || ""))
    .filter(Boolean)
    .slice(0, 12);
  const tagIds = rawTags.map((t) => (typeof t === "string" ? t : t.id || t.tag_id || "")).filter(Boolean);
  const why = explainChips(e.query?.explainability, names);
  const image = typeof p.image === "string" ? p.image : p.image?.url;
  const lat = typeof e.location?.lat === "number" ? e.location.lat : typeof p.geocode?.lat === "number" ? p.geocode.lat : undefined;
  const lon = typeof e.location?.lon === "number" ? e.location.lon : typeof p.geocode?.lon === "number" ? p.geocode.lon : undefined;
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
    tagIds,
    why,
    ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
    ...(p.geocode?.admin1_region ? { region: String(p.geocode.admin1_region) } : {}),
    raw: keepRaw ? e : undefined,
  };
}

export function normalizeAll(body: any, limit = 20, names?: Record<string, string>): Rec[] {
  return entitiesOf(body)
    .slice(0, limit)
    .map((e) => normalize(e, false, names));
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
