// Turns a validated PlanRequest into everything runAgent needs: the system prompt, the opening
// user message, the three tools, and the turn/effort budget. Kept separate from index.ts so the
// same app can be driven by the Worker, the Node dev server, and scripts/record.mjs.

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./agent.ts";
import type { QlooClient } from "./qloo.ts";
import type { PlanRequest } from "./types.ts";
import { makeTools, type ToolsState } from "./tools.ts";
import { planSystemPrompt, planUserMessage } from "./copy.ts";
import { findPlace } from "./places.ts";

export const LIMITS = { comps: [1, 3], days: [3, 21], driveHoursCap: [2, 10], textLength: 80 } as const;

// The request body /api/plan accepts: a PlanRequest plus the optional replay flag.
export type RunRequest = PlanRequest & { recorded?: boolean };

export type ParseResult = { ok: true; value: RunRequest } | { ok: false; error: string };

export const HOME_NOT_FOUND = (home: string) => `We couldn't place "${home}" on the map. Try the nearest town of 5,000+ people as "City, ST".`;

// Strict on purpose: this body comes straight from the browser (or anyone with curl), so every
// field is checked by type and length before it reaches Qloo or Claude. The home city is resolved
// against the Census table up front and normalized to its canonical label ("richmond va" -> "Richmond, VA").
export function parseRunRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.comps)) return { ok: false, error: "comps must be a list of 1 to 3 comparable acts" };
  if (b.comps.length < LIMITS.comps[0] || b.comps.length > LIMITS.comps[1]) return { ok: false, error: "Give 1 to 3 comparable acts" };
  if (b.comps.some((c) => typeof c !== "string" || !c.trim())) return { ok: false, error: "Every comp must be a non-empty name" };
  const comps = (b.comps as string[]).map((c) => c.trim());
  if (comps.some((c) => c.length > LIMITS.textLength)) return { ok: false, error: `Each comp name must be ${LIMITS.textLength} characters or fewer` };

  const rawHome = typeof b.home === "string" ? b.home.trim() : "";
  if (!rawHome) return { ok: false, error: "home is required, e.g. \"Richmond, VA\"" };
  if (rawHome.length > LIMITS.textLength) return { ok: false, error: `home must be ${LIMITS.textLength} characters or fewer` };
  const place = findPlace(rawHome);
  if (!place) return { ok: false, error: HOME_NOT_FOUND(rawHome) };
  const home = place.label;

  const days = b.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < LIMITS.days[0] || days > LIMITS.days[1]) {
    return { ok: false, error: "days must be a whole number from 3 to 21" };
  }

  const driveHoursCap = b.driveHoursCap;
  if (typeof driveHoursCap !== "number" || !Number.isFinite(driveHoursCap) || driveHoursCap < LIMITS.driveHoursCap[0] || driveHoursCap > LIMITS.driveHoursCap[1]) {
    return { ok: false, error: "driveHoursCap must be a number between 2 and 10 hours" };
  }

  const format = b.format === undefined ? "music" : b.format;
  if (format !== "music" && format !== "comedy") return { ok: false, error: "format must be \"music\" or \"comedy\"" };

  if (b.scenarioId !== undefined && typeof b.scenarioId !== "string") return { ok: false, error: "scenarioId must be a string" };
  if (b.recorded !== undefined && typeof b.recorded !== "boolean") return { ok: false, error: "recorded must be true or false" };

  return {
    ok: true,
    value: {
      comps,
      home,
      days,
      driveHoursCap,
      format,
      ...(typeof b.scenarioId === "string" && b.scenarioId ? { scenarioId: b.scenarioId } : {}),
      ...(typeof b.recorded === "boolean" ? { recorded: b.recorded } : {}),
    },
  };
}

export interface BuiltApp {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: ToolDef[];
  maxTurns: number;
  effort: "low" | "medium" | "high";
  state: ToolsState;
}

export function buildApp(qloo: QlooClient, req: PlanRequest): BuiltApp {
  const { tools, state } = makeTools({ qloo, format: req.format, home: req.home, days: req.days, driveHoursCap: req.driveHoursCap });
  return {
    system: planSystemPrompt(req),
    messages: [{ role: "user", content: planUserMessage(req) }],
    tools,
    // 3 resolve calls (often one turn), rank, route, closing = 4-6 turns in practice; 8 leaves room for a retry.
    maxTurns: 8,
    effort: "medium",
    state,
  };
}
