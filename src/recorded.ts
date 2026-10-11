// Recorded-scenario replay. Judges click the sample and get the exact stream a real run produced,
// at a human reading pace, with no Anthropic key involved. The public recording (made against the
// placeholder fixtures) lives in fixtures/scenarios/hollow-pines/; a recording made against live
// Qloo lives in private/scenarios/hollow-pines/ and is never committed. scripts/record.mjs bundles
// whichever exists (private first) into ./recorded.generated.ts, a gitignored build artifact.

import { slug } from "./canonical.ts";
import type { Pitch, Playbook } from "./types.ts";
import { planEvents, playbooks, pitch } from "./recorded.generated.ts";

export const RECORDED_AVAILABLE: boolean = planEvents.length > 0;

// Cadence of the replay. Streamed text arrives as many small deltas, so those get a short pause
// (the words still appear one phrase at a time); every other event gets the 250-600 ms beat.
const EVENT_DELAY_MS: [number, number] = [250, 600];
const TEXT_DELTA_DELAY_MS = 60;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function delayFor(event: any): number {
  if (event?.type === "text" || event?.type === "thinking") return TEXT_DELTA_DELAY_MS;
  const [lo, hi] = EVENT_DELAY_MS;
  return lo + Math.random() * (hi - lo);
}

// Yields the recorded events in order. `fast` (from ?fast=1, the "skip ahead" button) drops the delays.
export async function* replayPlan(fast: boolean): AsyncGenerator<any> {
  for (const event of planEvents) {
    if (!fast) await sleep(delayFor(event));
    yield event;
  }
}

export function recordedPlaybook(city: string): Playbook | undefined {
  const key = slug(city);
  if (playbooks[key]) return playbooks[key] as Playbook;
  // Tolerate a label that slugs differently from the recorded one (e.g. "Asheville NC" vs "Asheville, NC").
  const wanted = city.trim().toLowerCase();
  return Object.values(playbooks).find((p) => typeof p?.city === "string" && p.city.trim().toLowerCase() === wanted) as Playbook | undefined;
}

// Labels of every city with a recorded playbook (e.g. "Asheville, NC"), in recording order, for
// /api/health so the client knows which towns can replay without a key.
export function recordedCityLabels(): string[] {
  const labels: string[] = [];
  for (const p of Object.values(playbooks)) {
    if (typeof p?.city === "string" && p.city.trim() && !labels.includes(p.city)) labels.push(p.city);
  }
  return labels;
}

export function recordedPitch(): Pitch | undefined {
  return pitch && typeof pitch.text === "string" ? (pitch as Pitch) : undefined;
}
