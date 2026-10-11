// The three tools Claude can call while planning a tour. Each takes small inputs (names, ids,
// numbers) and composes the Qloo request through src/queries.ts, so Claude never writes a URL and
// every request has a deterministic canonical key (which is also how demo fixtures are found).
//
// Qloo-backed tools return `{ ..., qloo: Receipt }` so the trace panel can show the exact request,
// and they emit app events (comps, markets, route, receipt) through ctx.emit so the map and route
// rail update while the agent is still talking.

import type { ToolDef, ToolContext, AgentEvent } from "./agent.ts";
import type { QlooClient, QlooResult } from "./qloo.ts";
import { entitiesOf, normalize } from "./qloo.ts";
import type { AppEvent, Comp, Format, Locality, ObviousRoute, Receipt, Route } from "./types.ts";
import * as Q from "./queries.ts";
import { findPlace as findPlaceInCensus, type PlaceRow } from "./places.ts";
import { compareObvious, planRoute } from "./routing.ts";
import obviousRoute from "../data/obvious-route.json" with { type: "json" };

export interface ToolsContext {
  qloo: QlooClient;
  format: Format;
  home: string;
  days: number;
  driveHoursCap: number;
  // Census lookup for population and coordinates. Injectable so tests can run without data/us-places.json.
  findPlace?: (label: string) => PlaceRow | undefined;
}

export interface ToolsState {
  comps: Comp[];
  localities: Locality[];
  route?: Route;
  obvious?: ObviousRoute;
  receipts: Receipt[];
}

// App events share the agent's emit channel; runAgent forwards whatever it is handed.
function emitApp(ctx: ToolContext, e: AppEvent): void {
  ctx.emit(e as unknown as AgentEvent);
}

let receiptSeq = 0;

// One line per Qloo request for the Receipts drawer: exact URL (no key), mode, status, timing, and
// the top three results so a judge can eyeball the call without opening it.
export function toReceipt(tool: string, r: QlooResult, body?: any): Receipt {
  const data = body ?? r.body;
  const entities = entitiesOf(data);
  const demographics = Array.isArray(data?.results?.demographics) ? data.results.demographics : [];
  const resultCount = entities.length || demographics.length;
  const top = entities.slice(0, 3).map((e) => {
    const affinity = typeof e.query?.affinity === "number" ? e.query.affinity : undefined;
    return affinity === undefined ? { name: e.name } : { name: e.name, affinity };
  });
  receiptSeq += 1;
  return {
    id: `r${Date.now().toString(36)}-${receiptSeq}`,
    tool,
    method: "GET",
    url: r.url,
    mode: r.mode,
    status: r.status,
    ms: r.ms,
    resultCount,
    top,
    ...(r.ok ? {} : { note: typeof data?.error === "string" ? data.error : `HTTP ${r.status}` }),
  };
}

function compFromEntity(e: ReturnType<typeof entitiesOf>[number]): Comp {
  const rec = normalize(e);
  return {
    id: e.entity_id,
    name: e.name,
    type: e.type ?? (Array.isArray(e.types) ? String(e.types[0]) : ""),
    ...(typeof rec.popularity === "number" ? { popularity: rec.popularity } : {}),
    ...(rec.image ? { image: rec.image } : {}),
  };
}

// The candidate Claude is most likely to pick: an exact (case-insensitive) name match, else the most popular.
function bestCandidate(name: string, candidates: Comp[]): Comp | undefined {
  const wanted = name.trim().toLowerCase();
  return candidates.find((c) => c.name.trim().toLowerCase() === wanted) ?? [...candidates].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

function toLocality(e: ReturnType<typeof entitiesOf>[number], rank: number, findPlace: (label: string) => PlaceRow | undefined): Locality {
  const state: string | undefined = e.properties?.geocode?.admin1_region || undefined;
  const label = state ? `${e.name}, ${state}` : e.name;
  const place = findPlace(label);
  const lat = typeof e.location?.lat === "number" ? e.location.lat : place?.lat;
  const lon = typeof e.location?.lon === "number" ? e.location.lon : place?.lon;
  const population = place?.population;
  const affinity = typeof e.query?.affinity === "number" ? e.query.affinity : 0;
  return {
    id: e.entity_id,
    name: e.name,
    ...(state ? { state } : {}),
    label,
    rank,
    affinity,
    ...(population !== undefined ? { population } : {}),
    ...(lat !== undefined ? { lat } : {}),
    ...(lon !== undefined ? { lon } : {}),
    overIndex: population !== undefined && population < Q.C.OVER_INDEX_POP && rank <= Q.C.OVER_INDEX_RANK,
    why: normalize(e).why,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function makeTools(ctx: ToolsContext): { tools: ToolDef[]; state: ToolsState } {
  const { qloo, format } = ctx;
  const findPlace = ctx.findPlace ?? findPlaceInCensus;
  const state: ToolsState = { comps: [], localities: [], receipts: [] };

  // Every candidate resolve_act has returned, by id, so rank_markets can turn chosen ids back into Comps.
  const candidatesById = new Map<string, Comp>();
  // Best guess per comp name while the agent is still resolving, used for the running `comps` event.
  const guesses = new Map<string, Comp>();

  function record(tool: string, r: QlooResult, toolCtx: ToolContext): Receipt {
    const receipt = toReceipt(tool, r);
    state.receipts.push(receipt);
    emitApp(toolCtx, { type: "receipt", receipt });
    return receipt;
  }

  const resolveAct: ToolDef<{ name: string }> = {
    name: "resolve_act",
    description:
      "Look up one comparable act by name in Qloo and return up to three candidate entities (id, name, type, popularity). Call it once per comp. Pick the exact name match if there is one, otherwise the most popular candidate.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string", description: "The act's name as the user typed it, e.g. \"Big Thief\"." } },
      required: ["name"],
      additionalProperties: false,
    },
    async run(input, toolCtx) {
      const name = String(input?.name ?? "").trim();
      if (!name) throw new Error("name is required");
      const q = Q.searchAct(name, format);
      const r = await qloo.get(q.path, q.params);
      const receipt = record(q.tool, r, toolCtx);
      const wantedType = q.params.types as string;
      const candidates = entitiesOf(r.body)
        .filter((e) => e.type === wantedType || (Array.isArray(e.types) && e.types.includes(wantedType)))
        .slice(0, 3)
        .map(compFromEntity);
      for (const c of candidates) candidatesById.set(c.id, c);
      const best = bestCandidate(name, candidates);
      if (best) guesses.set(name.toLowerCase(), best);
      emitApp(toolCtx, { type: "comps", comps: [...guesses.values()] });
      const summary = candidates.length
        ? `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} for "${name}": ${candidates.map((c) => c.name).join(", ")}`
        : `No ${format === "comedy" ? "comedian" : "artist"} named "${name}" found in Qloo`;
      return { candidates, qloo: receipt, summary };
    },
  };

  const rankMarkets: ToolDef<{ compIds: string[] }> = {
    name: "rank_markets",
    description:
      "Ask Qloo which US localities rank highest for fans of the chosen comps (top 50, with explainability). Joins Census population and coordinates and flags over-index towns: population under 250k with an affinity rank in the top 20. Call it once, after every comp is resolved.",
    input_schema: {
      type: "object",
      properties: {
        compIds: { type: "array", items: { type: "string" }, description: "The chosen Qloo entity ids, one per comp (1-3)." },
      },
      required: ["compIds"],
      additionalProperties: false,
    },
    async run(input, toolCtx) {
      const compIds = Array.isArray(input?.compIds) ? input.compIds.map(String).filter(Boolean) : [];
      if (compIds.length < 1 || compIds.length > 3) throw new Error("compIds must hold 1 to 3 entity ids");

      // The chosen ids are the final comps; fall back to a bare id if Claude passed one we never saw.
      state.comps = compIds.map((id) => candidatesById.get(id) ?? { id, name: id, type: "" });
      emitApp(toolCtx, { type: "comps", comps: state.comps });

      const q = Q.rankMarkets(compIds);
      const r = await qloo.get(q.path, q.params);
      const receipt = record(q.tool, r, toolCtx);
      if (!r.ok) throw new Error(`Qloo rank_markets failed (HTTP ${r.status})`);

      const localities = entitiesOf(r.body).map((e, i) => toLocality(e, i + 1, findPlace));
      state.localities = localities;
      emitApp(toolCtx, { type: "markets", localities });

      const over = localities.filter((l) => l.overIndex);
      const usual = localities.filter((l) => obviousRoute.cities.includes(l.label)).slice(0, 3);
      const parts = [`${localities.length} localities ranked.`];
      if (over.length) parts.push(`${over.length} over-index towns (under 250k, rank <= 20): ${over.slice(0, 5).map((l) => `${l.label} #${l.rank} (${pct(l.affinity)})`).join(", ")}.`);
      if (usual.length) parts.push(`Usual suspects: ${usual.map((l) => `${l.label} #${l.rank}`).join(", ")}.`);
      return { localities, qloo: receipt, summary: parts.join(" ") };
    },
  };

  const planRouteTool: ToolDef<{ days: number; driveHoursCap: number; mustInclude: string[]; exclude: string[] }> = {
    name: "plan_route",
    description:
      "Build the driving loop from home through the ranked markets (over-index towns first), respecting the daily drive cap, and compare it with the obvious big-market route. No Qloo call. Requires rank_markets to have run. Pass empty arrays for mustInclude and exclude when the user named no towns.",
    input_schema: {
      type: "object",
      properties: {
        days: { type: "integer", description: "Days available for the tour (3-21)." },
        driveHoursCap: { type: "number", description: "Maximum drive hours per day (2-10)." },
        mustInclude: { type: "array", items: { type: "string" }, description: "Locality labels to force onto the route, e.g. [\"Asheville, NC\"]. Usually []." },
        exclude: { type: "array", items: { type: "string" }, description: "Locality labels to leave out. Usually []." },
      },
      required: ["days", "driveHoursCap", "mustInclude", "exclude"],
      additionalProperties: false,
    },
    async run(input, toolCtx) {
      if (!state.localities.length) throw new Error("Call rank_markets before plan_route");
      const homePlace = findPlace(ctx.home);
      if (!homePlace) throw new Error(`Home city "${ctx.home}" is not in the Census place list; try "City, ST"`);

      // Trust the agent's numbers only when they are in range; otherwise use what the user asked for.
      const days = Number.isInteger(input?.days) && input.days >= 3 && input.days <= 21 ? input.days : ctx.days;
      const cap = typeof input?.driveHoursCap === "number" && input.driveHoursCap >= 2 && input.driveHoursCap <= 10 ? input.driveHoursCap : ctx.driveHoursCap;
      const asLabels = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);

      const route = planRoute({
        home: { label: homePlace.label, lat: homePlace.lat, lon: homePlace.lon },
        localities: state.localities,
        days,
        driveHoursCap: cap,
        mustInclude: asLabels(input?.mustInclude),
        exclude: asLabels(input?.exclude),
      });
      const obvious = compareObvious(route, obviousRoute.cities);
      state.route = route;
      state.obvious = obvious;
      emitApp(toolCtx, { type: "route", route, obvious });

      const summary = `${route.stops.length} stops over ${route.days} days, ${Math.round(route.totalMiles)} miles, ${route.driveDays} drive day${route.driveDays === 1 ? "" : "s"}. ${obvious.summary}`;
      return { route, obvious, summary };
    },
  };

  return { tools: [resolveAct, rankMarkets, planRouteTool], state };
}
