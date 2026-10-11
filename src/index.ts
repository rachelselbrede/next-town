// Cloudflare Worker entry. Also run under Node by scripts/dev-node.mjs (same handler).
//   GET  /api/health  -> { ok, qloo: "live"|"demo", model, claude, recorded }
//   POST /api/plan    -> text/event-stream: meta, agent events, comps/markets/route/receipt, done
//   POST /api/city    -> text/event-stream: meta, status..., receipt..., playbook, done
//   POST /api/pitch   -> JSON Pitch
//   *                 -> static assets from ./public
//
// Modes: Qloo is "live" with QLOO_API_KEY, else "demo" (fixtures). Claude is available with
// ANTHROPIC_API_KEY, or under the Node dev server (DEV=1) where the SDK can use an `ant auth login`
// profile. Without Claude, the sample scenario replays its recording and custom runs get a 503.

import Anthropic from "@anthropic-ai/sdk";
import { runAgent } from "./agent.ts";
import { QlooClient } from "./qloo.ts";
import { sseResponse, json, type SseEvent } from "./sse.ts";
import { buildApp, parseRunRequest } from "./app.ts";
import { buildPlaybook } from "./city.ts";
import { buildPitch } from "./pitch.ts";
import { RECORDED_AVAILABLE, recordedPitch, recordedPlaybook, replayPlan } from "./recorded.ts";
import { demoResolver, FIXTURE_NOTE } from "./demo/resolver.ts";
import type { Comp, Locality, ObviousRoute, Playbook, Route } from "./types.ts";

export interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  MODEL?: string;
  QLOO_MODE?: string;
  QLOO_API_KEY?: string;
  QLOO_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  DEV?: string;
}

const DEFAULT_MODEL = "claude-opus-5-5";
const SAMPLE_SCENARIO = "hollow-pines";

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

function metaEvent(qloo: QlooClient, env: Env, recorded: boolean): SseEvent {
  return { type: "meta", qlooMode: qloo.mode, model: modelOf(env), recorded, ...(qloo.mode === "demo" ? { fixtureNote: FIXTURE_NOTE } : {}) };
}

async function readJson(request: Request): Promise<{ ok: true; body: any } | { ok: false; response: Response }> {
  if (request.method !== "POST") return { ok: false, response: json({ error: "POST only" }, 405, SECURITY_HEADERS) };
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false, response: json({ error: "Body must be JSON" }, 400, SECURITY_HEADERS) };
  }
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
      return json({ ok: true, qloo: qloo.mode, model: modelOf(env), claude: claudeAvailable(env), recorded: RECORDED_AVAILABLE }, 200, SECURITY_HEADERS);
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

      if (!live) return json({ error: "Live mode needs an Anthropic key; try the sample." }, 503, SECURITY_HEADERS);

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
      const b = read.body ?? {};
      const city = typeof b.city === "string" ? b.city.trim() : "";
      const home = typeof b.home === "string" ? b.home.trim() : "";
      const comps: Comp[] = Array.isArray(b.comps) ? b.comps.filter((c: any) => c && typeof c.id === "string" && typeof c.name === "string") : [];
      if (!city || !home) return json({ error: "city and home are required" }, 400, SECURITY_HEADERS);
      if (comps.length < 1 || comps.length > 3) return json({ error: "comps must hold 1 to 3 resolved acts" }, 400, SECURITY_HEADERS);
      const locality: Locality | undefined = b.locality && typeof b.locality === "object" ? (b.locality as Locality) : undefined;
      const qloo = new QlooClient(env, demoResolver);
      const live = claudeAvailable(env);

      if (b.scenarioId === SAMPLE_SCENARIO && (b.recorded === true || !live)) {
        const recorded = recordedPlaybook(city);
        if (recorded) {
          async function* replay() {
            yield metaEvent(qloo, env, true);
            yield { type: "status", message: `Opening the recorded playbook for ${recorded!.city}...` };
            for (const receipt of recorded!.receipts) yield { type: "receipt", receipt };
            yield { type: "playbook", playbook: recorded };
            yield { type: "done", text: recorded!.card.summary, turns: 0, usage: { input: 0, output: 0 } };
          }
          return sseResponse(replay(), SECURITY_HEADERS);
        }
      }

      const channel = eventChannel<SseEvent>();
      channel.push(metaEvent(qloo, env, false));
      buildPlaybook({ qloo, client: makeClaude(env), model: modelOf(env), city, home, comps, locality, emit: (e) => channel.push(e as SseEvent) })
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
      const b = read.body ?? {};
      const route = b.route as Route | undefined;
      if (!route || !Array.isArray(route.stops) || typeof route.totalMiles !== "number") return json({ error: "route with stops is required" }, 400, SECURITY_HEADERS);
      const playbooks: Playbook[] = Array.isArray(b.playbooks) ? b.playbooks.filter((p: any) => p && typeof p.city === "string") : [];
      const comps: Comp[] = Array.isArray(b.comps) ? b.comps.filter((c: any) => c && typeof c.name === "string") : [];
      const home = typeof b.home === "string" ? b.home.trim() : route.home?.label ?? "";
      const obvious: ObviousRoute = b.obvious && typeof b.obvious === "object" ? b.obvious : { cities: [], overlap: [], smallTowns: 0, summary: "" };
      const live = claudeAvailable(env);

      // The recorded pitch describes the recorded loop, so it is only used when the client says the
      // loop is untouched. An edited loop gets a fresh pitch (Claude, or the template without a key).
      if (b.scenarioId === SAMPLE_SCENARIO && b.recorded === true) {
        const recorded = recordedPitch();
        if (recorded) return json(recorded, 200, SECURITY_HEADERS);
      }
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
