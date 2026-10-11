// Demo-mode answers for the Qloo client. When QLOO_API_KEY is absent, QlooClient hands every request
// to `demoResolver`, which looks the request up in the bundled fixtures by its canonical URL. The same
// inputs always produce the same canonical URL (see src/canonical.ts), so the demo is deterministic:
// comp ids are sorted, param keys are lower-cased, and the API key is never part of the key.
//
// The fixtures themselves live in fixtures/qloo/*.json and are bundled into ./fixtures.generated.ts
// by scripts/bundle-fixtures.mjs (`npm run fixtures`). Edit the JSON, re-run the bundler.

import type { DemoResolver, Params } from "../qloo.ts";
import { canonicalUrl } from "../canonical.ts";
import { fixtures } from "./fixtures.generated.ts";

// Shape of one fixtures/qloo/*.json file. `_handAuthored` fixtures were written by hand before the
// Qloo key arrived; `_captured` is the ISO timestamp of a live recording (scripts/record.mjs), or null.
export interface FixtureFile {
  _handAuthored: boolean;
  _captured: string | null;
  tool: string; // the agent tool that issues this request, e.g. "find_rooms"
  canonical: string; // canonical URL, same as the key in index.json
  query: { path: string; params: Params };
  response: unknown; // the raw Qloo response body, served as-is
}

function lookup(path: string, params: Params): FixtureFile | undefined {
  return fixtures[canonicalUrl(path, params)];
}

// Returns the recorded response body for this request, or undefined when nothing was recorded
// (QlooClient then reports a 404 so the trace shows exactly which request has no fixture).
// The body is returned as-is, not copied, so callers must treat it as read-only.
export const demoResolver: DemoResolver = (path, params) => lookup(path, params)?.response;

// Provenance of the fixture that would answer this request: hand-authored placeholder or live capture.
export function fixtureMeta(path: string, params: Params): { handAuthored: boolean; captured: string | null } | undefined {
  const f = lookup(path, params);
  return f ? { handAuthored: f._handAuthored, captured: f._captured } : undefined;
}

// One line for the mode pill in the UI, summarizing the newest state of the whole fixture set.
// As long as any fixture is still hand-authored the demo is a placeholder; once scripts/record.mjs
// has captured everything live, the note carries the date of the newest capture.
export const FIXTURE_NOTE: string = describeFixtures(Object.values(fixtures));

function describeFixtures(all: FixtureFile[]): string {
  const anyHandAuthored = all.length === 0 || all.some((f) => f._handAuthored);
  const captures = all.map((f) => f._captured).filter((d): d is string => typeof d === "string" && d.length > 0);
  // ISO 8601 timestamps sort lexicographically, so the last one is the newest.
  const newest = captures.sort().at(-1);
  if (anyHandAuthored || !newest) return "Recorded demo (pre-key placeholder)";
  return `Recorded demo (captured ${newest.slice(0, 10)})`;
}
