// Cloudflare Worker entry. Also run under Node by scripts/dev-node.mjs (same handler).
//   GET  /api/health  -> { ok, qloo: "live"|"demo", model, claude, recorded, fixtureNote, recordedCities }
//   POST /api/plan    -> text/event-stream: meta, agent events, comps/markets/route/receipt, done
//   POST /api/city    -> text/event-stream: meta, status..., receipt..., playbook, done
//   POST /api/pitch   -> JSON Pitch
//   *                 -> static assets from ./public
//
// Modes: Qloo is "live" with QLOO_API_KEY, else "demo" (fixtures). Claude is available with
// ANTHROPIC_API_KEY, or under the Node dev server (DEV=1) where the SDK can use an `ant auth login`
// profile. Without Claude, the sample scenario replays its recording and custom runs get a 503.
// Without the Qloo key, only the sample scenario can run at all (its fixtures are the only Qloo
// answers the server has), so a custom act gets a 503 before any Claude spend.
//
// Spend guard: the three branches that can spend Claude tokens (a live /api/plan run, /api/city when
// it builds a playbook with Claude, /api/pitch when it calls Claude) are rate limited per client IP,
// through the Workers Rate Limiting binding LIVE_LIMITER when it is bound (wrangler.jsonc), else an
// in-memory window per isolate. Recorded replays are never limited.

import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.ts";
import { QlooClient } from "./qloo.ts";
import { sseResponse, json, type SseEvent } from "./sse.ts";
import { buildApp, parseRunRequest, LIMITS } from "./app.ts";
import { buildPlaybook, type BuildPlaybookOptions } from "./city.ts";
import { buildPitch } from "./pitch.ts";
import * as recorded from "./recorded.ts";
import { playbooks as recordedPlaybooks } from "./recorded.generated.ts";
import { demoResolver, FIXTURE_NOTE } from "./demo/resolver.ts";
import type { Comp, Locality, ObviousRoute, Playbook, Route, RouteStop } from "./types.ts";

const { RECORDED_AVAILABLE, recordedPitch, recordedPlaybook, replayPlan } = recorded;

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MODEL?: string;
  QLOO_MODE?: string;
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  DEV?: string;
  // Workers Rate Limiting binding (wrangler.jsonc "ratelimits"). Optional: absent under Node and in
  // tests, where the in-memory window below takes over.
  LIVE_LIMITER?: RateLimit;
}

const DEFAULT_MODEL = "claude-opus-5-5";
const SAMPLE_SCENARIO = "hollow-pines";
const MAX_BODY_BYTES = 64 * 1024;

export const MESSAGES = {
  demoOnly: "Routing your own act needs the live Qloo key, which isn't set on this server yet. The Hollow Pines sample shows the full flow.",
  noClaude: "Live mode needs an Anthropic key; try the sample.",
  busy: "Live mode is busy right now; the Hollow Pines sample still works.",
  tooLarge: "Body too large (64 KB max)",
} as const;

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const modelOf = (env: Env) => env.MODEL || DEFAULT_MODEL;
const claudeAvailable = (env: Env) => Boolean(env.ANTHROPIC_API_KEY?.trim()) || env.DEV === "1";

// In the Worker the key comes from a secret; under Node the SDK also accepts an `ant auth login` profile.
function makeClaude(env: Env): Anthropic | null {
  if (env.ANTHROPIC_API_KEY?.trim()) return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY.trim() });
  return env.DEV === "1" ? new Anthropic() : null;
}

// Labels of the cities with a recorded playbook, so the UI can keep its "Add a town" picker honest in
// demo mode. src/recorded.ts exports recordedCityLabels() once the data-rule work lands; until then
// the labels are read straight off the generated module.
export function recordedCities(): string[] {
  const helper = (recorded as { recordedCityLabels?: () => string[] }).recordedCityLabels;
  if (typeof helper === "function") return helper();
  return Object.values(recordedPlaybooks)
    .map((p: any) => p?.city)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

// The fixture note travels with every stream that is not live Qloo: recorded replays (always
// fixture-backed) and any run in demo mode.
function metaEvent(qloo: QlooClient, env: Env, isReplay: boolean): SseEvent {
  const fixtureBacked = isReplay || qloo.mode === "demo";
  return { type: "meta", qlooMode: qloo.mode, model: modelOf(env), recorded: isReplay, ...(fixtureBacked ? { fixtureNote: FIXTURE_NOTE } : {}) };
}

// ---- Spend guard ----
// Without the LIVE_LIMITER binding: a sliding window of LIVE_WINDOW.limit requests per
// LIVE_WINDOW.periodMs per client IP, held in this isolate's memory (so it resets on redeploy and is
// per isolate, which is fine for a guard against one browser hammering the live endpoints).
// Under the Node dev server (DEV=1, also scripts/record.mjs, which makes ~20 Claude calls in a row
// from one "IP") the in-memory window is skipped; a real binding is always honored.
export const LIVE_WINDOW = { limit: 6, periodMs: 60_000 } as const;
const MAX_TRACKED_IPS = 5000;
const liveWindow = new Map<string, number[]>();

export function resetLiveLimiter(): void {
  liveWindow.clear();
}

export async function allowLiveCall(env: Env, request: Request, now = Date.now()): Promise<boolean> {
  const key = request.headers.get("cf-connecting-ip") ?? "anon";
  if (env.LIVE_LIMITER) {
    const outcome = await env.LIVE_LIMITER.limit({ key });
    return outcome.success;
  }
  if (env.DEV === "1") return true;
  const recent = (liveWindow.get(key) ?? []).filter((t) => now - t < LIVE_WINDOW.periodMs);
  if (recent.length >= LIVE_WINDOW.limit) {
    liveWindow.set(key, recent);
    return false;
  }
  recent.push(now);
  if (!liveWindow.has(key) && liveWindow.size >= MAX_TRACKED_IPS) {
    // Drop the stalest entries rather than grow without bound under a flood of addresses.
    for (const [k, stamps] of liveWindow) {
      if (!stamps.some((t) => now - t < LIVE_WINDOW.periodMs)) liveWindow.delete(k);
      if (liveWindow.size < MAX_TRACKED_IPS) break;
    }
    if (liveWindow.size >= MAX_TRACKED_IPS) liveWindow.delete(liveWindow.keys().next().value!);
  }
  liveWindow.set(key, recent);
  return true;
}

const busy = () => json({ error: MESSAGES.busy }, 429, { ...SECURITY_HEADERS, "retry-after": "60" });

// ---- Body parsing and caps ----

async function readJson(request: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  if (request.method !== "POST") return { ok: false, response: json({ error: "POST only" }, 405, SECURITY_HEADERS) };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { ok: false, response: json({ error: MESSAGES.tooLarge }, 413, SECURITY_HEADERS) };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: "Body could not be read" }, 400, SECURITY_HEADERS) };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, response: json({ error: MESSAGES.tooLarge }, 413, SECURITY_HEADERS) };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: json({ error: "Body must be JSON" }, 400, SECURITY_HEADERS) };
  }
}

const TEXT_MAX: number = LIMITS.textLength; // 80
const str = (v: unknown, max = TEXT_MAX): string | undefined => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const strList = (v: unknown, count: number, max = TEXT_MAX): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, count).map((s) => s.slice(0, max)) : [];
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// Comps the client sends back after resolve_act: ids and names only, both strings, capped.
function parseComps(v: unknown, requireId: boolean): Comp[] | undefined {
  if (!Array.isArray(v) || v.length < 1 || v.length > LIMITS.comps[1]) return undefined;
  const out: Comp[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") return undefined;
    const name = str((c as any).name);
    const id = str((c as any).id, 120);
    if (!name || (requireId && !id) || (typeof (c as any).name === "string" && (c as any).name.length > TEXT_MAX)) return undefined;
    out.push(defined({ id: id ?? "", name, type: str((c as any).type, 40) ?? "urn:entity:artist", popularity: num((c as any).popularity), image: str((c as any).image, 500) }));
  }
  return out;
}

// A Locality rebuilt from known fields only: the browser cannot smuggle big or odd payloads into
// the playbook (which is echoed back to it and handed to Claude).
function parseLocality(v: unknown): Locality | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 120);
  const name = str(o.name);
  const label = str(o.label);
  const rank = num(o.rank);
  const affinity = num(o.affinity);
  if (!id || !name || !label || rank === undefined || affinity === undefined) return undefined;
  const topRoomRaw = o.topRoom && typeof o.topRoom === "object" ? (o.topRoom as Record<string, unknown>) : undefined;
  const topRoom = topRoomRaw && str(topRoomRaw.name) ? defined({ id: str(topRoomRaw.id, 120) ?? "", name: str(topRoomRaw.name)!, affinity: num(topRoomRaw.affinity), why: strList(topRoomRaw.why, 6) }) : undefined;
  const locality = defined({
    id,
    name,
    label,
    rank,
    affinity,
    state: str(o.state, 20),
    population: num(o.population),
    lat: num(o.lat),
    lon: num(o.lon),
    overIndex: bool(o.overIndex) ?? false,
    why: strList(o.why, 6),
    topRoom,
  });
  return locality as unknown as Locality;
}

function parseStop(v: unknown): RouteStop | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const label = str(o.label);
  const lat = num(o.lat);
  const lon = num(o.lon);
  const day = num(o.day);
  if (!label || lat === undefined || lon === undefined || day === undefined) return undefined;
  return defined({
    localityId: str(o.localityId, 120) ?? "",
    label,
    lat,
    lon,
    day,
    legMiles: num(o.legMiles) ?? 0,
    legHours: num(o.legHours) ?? 0,
    driveDay: bool(o.driveDay) ?? false,
    rank: num(o.rank),
    affinity: num(o.affinity),
    overIndex: bool(o.overIndex),
    population: num(o.population),
  });
}

const PITCH_CAPS = { stops: 21, notes: 6, noteChars: 200, obviousCities: 15, summaryChars: 300, playbooks: 21 } as const;

function parseRoute(v: unknown): Route | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.stops) || typeof o.totalMiles !== "number" || !Number.isFinite(o.totalMiles)) return undefined;
  const stops = o.stops.slice(0, PITCH_CAPS.stops).map(parseStop).filter((s): s is RouteStop => !!s);
  const homeRaw = o.home && typeof o.home === "object" ? (o.home as Record<string, unknown>) : {};
  const first = stops[0];
  return {
    home: { label: str(homeRaw.label) ?? "", lat: num(homeRaw.lat) ?? first?.lat ?? 0, lon: num(homeRaw.lon) ?? first?.lon ?? 0 },
    stops,
    totalMiles: o.totalMiles,
    totalHours: num(o.totalHours) ?? 0,
    driveDays: num(o.driveDays) ?? 0,
    days: num(o.days) ?? stops.at(-1)?.day ?? stops.length,
    notes: strList(o.notes, PITCH_CAPS.notes, PITCH_CAPS.noteChars),
  };
}

function parseObvious(v: unknown): ObviousRoute {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  return {
    cities: strList(o.cities, PITCH_CAPS.obviousCities),
    overlap: strList(o.overlap, PITCH_CAPS.obviousCities),
    smallTowns: num(o.smallTowns) ?? 0,
    summary: str(o.summary, PITCH_CAPS.summaryChars) ?? "",
  };
}

// Only what pitchItinerary reads: the city, the top two room names, the first place of each promo
// group, and the strongest age band. Nothing else from the client's copy of a playbook is kept.
function parsePitchPlaybook(v: unknown): Playbook | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const city = str(o.city);
  if (!city) return undefined;
  const rooms = Array.isArray(o.rooms)
    ? o.rooms
        .slice(0, 2)
        .map((r: any) => str(r?.name))
        .filter((n): n is string => !!n)
        .map((name) => ({ id: "", name, type: "urn:entity:place", affinity: 0, why: [] }))
    : [];
  const promo = Array.isArray(o.promo)
    ? o.promo.slice(0, 5).map((g: any) => {
        const first = Array.isArray(g?.places) ? str(g.places[0]?.name) : undefined;
        return { kind: str(g?.kind, 40) ?? "", places: first ? [{ id: "", name: first, type: "urn:entity:place", affinity: 0, why: [] }] : [] };
      })
    : [];
  const strongestAge = o.who && typeof o.who === "object" ? str((o.who as any).strongestAge, 40) : undefined;
  const who = strongestAge ? { age: {}, gender: {}, strongestAge, suggestions: [] } : null;
  return { city, home: "", comps: [], rooms, promo, who, localColor: { brands: [], shows: [] }, card: {} as Playbook["card"], receipts: [] } as unknown as Playbook;
}

// A tiny push-to-pull bridge: buildPlaybook emits events through a callback while the SSE helper
// wants an async iterable. Events are queued and handed over as the stream asks for them.
function eventChannel<T>() {
  const queue: T[] = [];
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(e: T) {
      queue.push(e);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    fail(err: unknown) {
      failure = err;
      closed = true;
      notify();
    },
    async *events(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      const qloo = new QlooClient(env, demoResolver);
      return json(
        {
          ok: true,
          qloo: qloo.mode,
          model: modelOf(env),
          claude: claudeAvailable(env),
          recorded: RECORDED_AVAILABLE,
          fixtureNote: FIXTURE_NOTE,
          recordedCities: recordedCities(),
        },
        200,
        SECURITY_HEADERS,
      );
    }

    // /api/run is the pre-contract name; kept as an alias so an older public/js/stream.js still works.
    if (url.pathname === "/api/plan" || url.pathname === "/api/run") {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const parsed = parseRunRequest(read.body);
      if (!parsed.ok) return json({ error: parsed.error }, 400, SECURITY_HEADERS);
      const req = parsed.value;
      const qloo = new QlooClient(env, demoResolver);
      const live = claudeAvailable(env);

      // The sample replays its recording whenever the client asks for it or Claude is unavailable.
      if (req.scenarioId === SAMPLE_SCENARIO && (req.recorded === true || !live) && RECORDED_AVAILABLE) {
        const fast = url.searchParams.get("fast") === "1";
        async function* replay() {
          yield metaEvent(qloo, env, true);
          for await (const e of replayPlan(fast)) if (e?.type !== "meta") yield e;
        }
        return sseResponse(replay(), SECURITY_HEADERS);
      }

      // Without the Qloo key the fixtures only answer the sample's queries, so a custom act would
      // burn Claude tokens on a run that cannot find anything. Checked before anything Claude-related.
      if (qloo.mode === "demo" && req.scenarioId !== SAMPLE_SCENARIO) return json({ error: MESSAGES.demoOnly }, 503, SECURITY_HEADERS);
      if (!live) return json({ error: MESSAGES.noClaude }, 503, SECURITY_HEADERS);
      if (!(await allowLiveCall(env, request))) return busy();

      const client = makeClaude(env)!;
      const app = buildApp(qloo, req);
      const events = runAgent({
        client,
        model: modelOf(env),
        system: app.system,
        messages: app.messages,
        tools: app.tools,
        maxTurns: app.maxTurns,
        effort: app.effort,
        signal: request.signal,
      });

      // Tools emit app events (comps, markets, route, receipt) through ctx.emit; runAgent flushes
      // them between turns, so one stream carries both the agent's narration and the app state.
      async function* withMeta() {
        yield metaEvent(qloo, env, false);
        for await (const e of events) yield e as SseEvent;
      }
      return sseResponse(withMeta(), SECURITY_HEADERS);
    }

    if (url.pathname === "/api/city") {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const b = read.body && typeof read.body === "object" ? read.body : {};
      const city = typeof b.city === "string" ? b.city.trim() : "";
      const home = typeof b.home === "string" ? b.home.trim() : "";
      if (!city || !home) return json({ error: "city and home are required" }, 400, SECURITY_HEADERS);
      if (city.length > TEXT_MAX || home.length > TEXT_MAX) return json({ error: `city and home must be ${TEXT_MAX} characters or fewer` }, 400, SECURITY_HEADERS);
      const comps = parseComps(b.comps, true);
      if (!comps) return json({ error: `comps must hold 1 to 3 resolved acts, each with an id and a name of ${TEXT_MAX} characters or fewer` }, 400, SECURITY_HEADERS);
      const locality = parseLocality(b.locality);
      const qloo = new QlooClient(env, demoResolver);
      const live = claudeAvailable(env);

      if (b.scenarioId === SAMPLE_SCENARIO && (b.recorded === true || !live)) {
        const playbook = recordedPlaybook(city);
        if (playbook) {
          async function* replay() {
            yield metaEvent(qloo, env, true);
            yield { type: "status", message: `Opening the recorded playbook for ${playbook!.city}...` };
            for (const receipt of playbook!.receipts) yield { type: "receipt", receipt };
            yield { type: "playbook", playbook };
            yield { type: "done", text: playbook!.card.summary, turns: 0, usage: { input: 0, output: 0 } };
          }
          return sseResponse(replay(), SECURITY_HEADERS);
        }
      }

      // From here the playbook is built, and with Claude available that is a paid call.
      if (live && !(await allowLiveCall(env, request))) return busy();

      const channel = eventChannel<SseEvent>();
      channel.push(metaEvent(qloo, env, false));
      // `signal` lets a closed tab cancel the Qloo calls; assigned here (not inline) so the build
      // still type-checks until BuildPlaybookOptions declares it.
      const options: BuildPlaybookOptions & { signal?: AbortSignal } = {
        qloo,
        client: makeClaude(env),
        model: modelOf(env),
        city,
        home,
        comps,
        locality,
        emit: (e) => channel.push(e as SseEvent),
        signal: request.signal,
      };
      buildPlaybook(options)
        .then((playbook: Playbook) => {
          channel.push({ type: "done", text: playbook.card.summary, turns: 0, usage: { input: 0, output: 0 } });
          channel.close();
        })
        .catch((err) => channel.fail(err));
      return sseResponse(channel.events(), SECURITY_HEADERS);
    }

    if (url.pathname === "/api/pitch") {
      const read = await readJson(request);
      if (!read.ok) return read.response;
      const b = read.body && typeof read.body === "object" ? read.body : {};
      const route = parseRoute(b.route);
      if (!route || route.stops.length === 0) return json({ error: "route with stops is required" }, 400, SECURITY_HEADERS);
      const playbooks = Array.isArray(b.playbooks)
        ? b.playbooks
            .slice(0, PITCH_CAPS.playbooks)
            .map(parsePitchPlaybook)
            .filter((p: Playbook | undefined): p is Playbook => !!p)
        : [];
      const comps = parseComps(b.comps, false) ?? [];
      const home = str(b.home) || route.home.label;
      const obvious = parseObvious(b.obvious);
      const live = claudeAvailable(env);

      // The recorded pitch describes the recorded loop, so it is only used when the client says the
      // loop is untouched. An edited loop gets a fresh pitch (Claude, or the template without a key).
      if (b.scenarioId === SAMPLE_SCENARIO && b.recorded === true) {
        const pitch = recordedPitch();
        if (pitch) return json(pitch, 200, SECURITY_HEADERS);
      }
      if (live && !(await allowLiveCall(env, request))) return busy();
      const pitch = await buildPitch({ client: makeClaude(env), model: modelOf(env), route, playbooks, comps, home, obvious });
      return json(pitch, 200, SECURITY_HEADERS);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404, SECURITY_HEADERS);

    const res = await env.ASSETS.fetch(request);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  },
};
