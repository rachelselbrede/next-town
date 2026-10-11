// Behaviors a judge hits in the hosted demo without API keys: honest empty states, a pitch that
// matches an edited loop, and streams that stop working when the reader goes away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QlooClient } from "../src/qloo.ts";
import { buildPlaybook } from "../src/city.ts";
import { sseResponse } from "../src/sse.ts";
import worker from "../src/index.ts";
import { recordedPitch } from "../src/recorded.ts";
import { fallbackPitchText, pitchItinerary } from "../src/pitch.ts";
import type { Route } from "../src/types.ts";

const comps = [
  { id: "4F3A0B2C-0C2E-4E0C-9F1A-1B2C3D4E5F60", name: "Big Thief", type: "urn:entity:artist" },
  { id: "7A9C1D3E-5F7B-4A9C-8D1E-2F3A4B5C6D71", name: "Waxahatchee", type: "urn:entity:artist" },
];

const route: Route = {
  home: { label: "Richmond, VA", lat: 37.54, lon: -77.43 },
  stops: [
    { localityId: "a", label: "Charlottesville, VA", lat: 38.03, lon: -78.48, day: 1, legMiles: 66, legHours: 1.2, driveDay: false, overIndex: true },
    { localityId: "b", label: "Pittsburgh, PA", lat: 40.44, lon: -79.99, day: 2, legMiles: 1234.4, legHours: 4.1, driveDay: false, overIndex: false },
  ],
  totalMiles: 1534.6,
  totalHours: 9.4,
  driveDays: 0,
  days: 2,
  notes: [],
};
const obvious = { cities: ["Pittsburgh, PA", "Nashville, TN"], overlap: ["Pittsburgh, PA"], smallTowns: 1, summary: "x" };

test("a demo city with no recorded fixtures says so instead of showing empty Qloo results", async () => {
  const qloo = new QlooClient({}, () => undefined); // demo mode, every lookup misses
  const events: any[] = [];
  const pb = await buildPlaybook({ qloo, client: null, model: "m", city: "Lancaster, PA", home: "Richmond, VA", comps, emit: (e) => events.push(e) });
  assert.equal(pb.noDemoData, true);
  assert.match(pb.card.summary, /only carries recorded Qloo answers/);
  assert.equal(pb.receipts.length, 7);
  assert.ok(pb.receipts.every((r) => r.status === 404 && r.mode === "demo"));
  assert.equal(events.filter((e) => e.type === "playbook").length, 1);
});

test("a city with fixtures is not flagged", async () => {
  const qloo = new QlooClient({}, (path) => (path === "/v2/insights" ? { results: { entities: [{ entity_id: "1", name: "Room", query: { affinity: 0.9 } }] } } : undefined));
  const pb = await buildPlaybook({ qloo, client: null, model: "m", city: "Asheville, NC", home: "Richmond, VA", comps, emit: () => {} });
  assert.notEqual(pb.noDemoData, true);
});

test("the recorded pitch is served only when the client says the loop is untouched", async () => {
  const env = { ASSETS: { fetch: async () => new Response("") } };
  const call = async (recorded: boolean) => {
    const res = await worker.fetch(
      new Request("http://x/api/pitch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId: "hollow-pines", recorded, route, comps, home: "Richmond, VA", obvious, playbooks: [] }) }),
      env as any,
    );
    return res.json() as Promise<any>;
  };
  const edited = await call(false);
  assert.match(edited.text, /1,535 miles/);
  assert.equal(edited.itinerary.length, 2);
  const rec = recordedPitch();
  if (rec) assert.equal((await call(true)).text, rec.text);
});

test("template pitch formats miles and states the big-market overlap once", () => {
  const opts = { route, playbooks: [], comps: comps as any, home: "Richmond, VA", obvious };
  const text = fallbackPitchText(opts, pitchItinerary(route, []));
  assert.match(text, /about 1,535 miles/);
  assert.match(text, /1 of the 2 stops are on the usual big-market list\./);
  assert.equal(text.match(/towns under 250k/g)?.length, 1);
});

test("cancelling an SSE response stops the generator behind it", async () => {
  let produced = 0;
  let finished = false;
  async function* forever() {
    try {
      for (;;) {
        produced++;
        yield { type: "tick", n: produced };
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      finished = true;
    }
  }
  const reader = sseResponse(forever()).body!.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  await new Promise((r) => setTimeout(r, 40));
  const after = produced;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(finished, true);
  assert.equal(produced, after, "no events produced after cancel");
});
