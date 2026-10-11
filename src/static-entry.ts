// Browser build of the server for the static GitHub Pages mirror (scripts/build-static.mjs).
//
// The mirror runs the exact Worker handler from ./index.ts inside the page, with no Anthropic key and
// Qloo in demo mode. That is the same configuration as a Worker deployed without secrets: the
// Hollow Pines sample replays its recording, playbooks for recorded stops replay, other fixture-backed
// cities build from the Qloo fixtures with templated copy, and custom runs get the "needs a key" 503.

import worker, { type Env } from "./index.ts";

const env: Env = {
  ASSETS: { fetch: async () => new Response("not found", { status: 404 }) },
  QLOO_MODE: "demo",
};

export function handle(request: Request): Promise<Response> {
  return worker.fetch(request, env);
}
