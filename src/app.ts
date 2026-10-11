// Turns a validated PlanRequest into everything runAgent needs: the system prompt, the opening
// user message, the three tools, and the turn/effort budget. Kept separate from index.ts so the
// same app can be driven by the Worker, the Node dev server, and scripts/record.mjs.

import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef } from "./agent.ts";
import type { QlooClient } from "./qloo.ts";
import type { PlanRequest } from "./types.ts";
import { makeTools, type ToolsState } from "./tools.ts";
import { planSystemPrompt, planUserMessage } from "./copy.ts";

export const LIMITS = { comps: [1, 3], days: [3, 21], driveHoursCap: [2, 10], textLength: 80 } as const;

// The request body /api/plan accepts: a PlanRequest plus the optional replay flag.
export type RunRequest = PlanRequest & { recorded?: boolean };

export type ParseResult = { ok: true; value: RunRequest } | { ok: false; error: string };

export function parseRunRequest(body: unknown): ParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Body must be a JSON object" };
  const b = body as Record<string, unknown>;

  const rawComps = Array.isArray(b.comps) ? b.comps : typeof b.comps === "string" ? [b.comps] : [];
  const comps = rawComps.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean);
  if (comps.length !== rawComps.length) return { ok: false, error: "Every comp must be a non-empty name" };
  if (comps.length < LIMITS.comps[0] || comps.length > LIMITS.comps[1]) return { ok: false, error: "Give 1 to 3 comparable acts" };
  if (comps.some((c) => c.length > LIMITS.textLength)) return { ok: false, error: `Each comp name must be ${LIMITS.textLength} characters or fewer` };

  const home = typeof b.home === "string" ? b.home.trim() : "";
  if (!home) return { ok: false, error: "home is required, e.g. \"Richmond, VA\"" };
  if (home.length > LIMITS.textLength) return { ok: false, error: `home must be ${LIMITS.textLength} characters or fewer` };

  const days = Number(b.days);
  if (!Number.isInteger(days) || days < LIMITS.days[0] || days > LIMITS.days[1]) return { ok: false, error: "days must be a whole number from 3 to 21" };

  const driveHoursCap = Number(b.driveHoursCap);
  if (!Number.isFinite(driveHoursCap) || driveHoursCap < LIMITS.driveHoursCap[0] || driveHoursCap > LIMITS.driveHoursCap[1]) {
    return { ok: false, error: "driveHoursCap must be between 2 and 10 hours" };
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
