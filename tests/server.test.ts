// The Worker's fetch handler, called directly (no network, no Claude, no Qloo): request validation,
// body caps, the demo-mode guard, the spend guard, and error sanitization on the SSE stream.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import worker, { allowLiveCall, resetLiveLimiter, LIVE_WINDOW, MESSAGES, type Env } from "../src/index.ts";
import { sseResponse, type SseEvent } from "../src/sse.ts";
import { RECORDED_AVAILABLE } from "../src/recorded.ts";
import { FIXTURE_NOTE } from "../src/demo/resolver.ts";

const ORIGIN = "http://test.local";
const ASSETS = { fetch: async () => new Response("asset", { headers: { "content-type": "text/plain" } }) };

// Demo Qloo (no key) and no Claude (no key, DEV unset): the public mirror's situation.
const demoEnv = (extra: Partial<Env> = {}): Env => ({ ASSETS, QLOO_MODE: "auto", ...extra });

function post(path: string, body: unknown, env: Env = demoEnv(), headers: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  return worker.fetch(request, env);
}

// Reads a whole SSE body and parses its events.
async function sseEvents(res: Response): Promise<SseEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data: "))
    .map((chunk) => JSON.parse(chunk.slice(chunk.indexOf("data: ") + 6)));
}

const PLAN = { comps: ["Big Thief", "Waxahatchee"], home: "Richmond, VA", days: 12, driveHoursCap: 6, format: "music" };
const COMPS = [
  { id: "A1", name: "Big Thief", type: "urn:entity:artist" },
  { id: "A2", name: "Waxahatchee", type: "urn:entity:artist" },
];
const STOP = (label: string, day: number, lat = 35.6, lon = -82.55) => ({ localityId: `L-${day}`, label, lat, lon, day, legMiles: 120, legHours: 2.7, driveDay: false, rank: day, affinity: 0.8, overIndex: true, population: 90000 });
const ROUTE = { home: { label: "Richmond, VA", lat: 37.53, lon: -77.47 }, stops: [STOP("Asheville, NC", 1), STOP("Boone, NC", 2, 36.2, -81.68)], totalMiles: 640, totalHours: 14.5, driveDays: 1, days: 5, notes: ["Kept the loop under 6 h a day."] };

// ---- /api/health ----

test("health reports mode, fixture note and the recorded cities", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), demoEnv());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.qloo, "demo");
  assert.equal(typeof h.model, "string");
  assert.equal(h.claude, false);
  assert.equal(h.recorded, RECORDED_AVAILABLE);
  assert.equal(h.fixtureNote, FIXTURE_NOTE);
  assert.ok(Array.isArray(h.recordedCities));
  assert.ok(h.recordedCities.every((c: unknown) => typeof c === "string" && c.length > 0));
  if (RECORDED_AVAILABLE) assert.ok(h.recordedCities.length > 0, "recorded playbooks should list their cities");
});

test("health says claude is available with a key or under DEV", async () => {
  const withKey = await (await worker.fetch(new Request(`${ORIGIN}/api/health`), demoEnv({ ANTHROPIC_API_KEY: "sk-test" }))).json();
  assert.equal(withKey.claude, true);
  const dev = await (await worker.fetch(new Request(`${ORIGIN}/api/health`), demoEnv({ DEV: "1" }))).json();
  assert.equal(dev.claude, true);
});

// ---- /api/plan validation ----

test("plan rejects wrong types, unknown homes and too many comps with 400", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ ...PLAN, days: "12" }, /days must be a whole number/],
    [{ ...PLAN, driveHoursCap: "6" }, /driveHoursCap must be a number/],
    [{ ...PLAN, comps: "Big Thief" }, /comps must be a list/],
    [{ ...PLAN, comps: ["a", "b", "c", "d"] }, /1 to 3/],
    [{ ...PLAN, comps: ["Big Thief", 7] }, /non-empty name/],
    [{ ...PLAN, comps: ["x".repeat(81)] }, /80 characters/],
    [{ ...PLAN, home: "Nowhere Special, ZZ" }, /We couldn't place "Nowhere Special, ZZ" on the map/],
    [{ ...PLAN, home: "" }, /home is required/],
    ["not json", /Body must be JSON/],
  ];
  for (const [body, re] of cases) {
    const res = await post("/api/plan", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const { error } = await res.json();
    assert.match(error, re);
  }
});

test("plan only accepts POST", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/plan`), demoEnv());
  assert.equal(res.status, 405);
});

test("plan for a custom act in demo mode is a 503 before any Claude client exists", async () => {
  // No key, DEV unset: Claude is unavailable too, but the Qloo-demo message must win because it is checked first.
  const res = await post("/api/plan", PLAN);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: MESSAGES.demoOnly });

  // With Claude "available" (DEV=1, no key) a run would otherwise start a stream; the 503 shows the
  // demo check fires before makeClaude / runAgent.
  const dev = await post("/api/plan", { ...PLAN, scenarioId: "my-own-act" }, demoEnv({ DEV: "1" }));
  assert.equal(dev.status, 503);
  assert.deepEqual(await dev.json(), { error: MESSAGES.demoOnly });
  assert.equal(dev.headers.get("content-type"), "application/json; charset=utf-8");
});

test("plan for the sample without Claude replays the recording with the fixture note", { skip: !RECORDED_AVAILABLE }, async () => {
  const res = await post("/api/plan?fast=1", { ...PLAN, scenarioId: "hollow-pines", recorded: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await sseEvents(res);
  assert.equal(events[0].type, "open");
  const meta = events[1];
  assert.equal(meta.type, "meta");
  assert.equal(meta.recorded, true);
  assert.equal(meta.qlooMode, "demo");
  assert.equal(meta.fixtureNote, FIXTURE_NOTE);
  assert.equal(events.filter((e) => e.type === "meta").length, 1, "the recording's own meta is dropped");
  assert.equal(events.at(-1)?.type, "done");
});

// ---- body cap ----

test("a body over 64 KB is a 413 on every POST endpoint", async () => {
  const big = JSON.stringify({ ...PLAN, padding: "x".repeat(70 * 1024) });
  for (const path of ["/api/plan", "/api/city", "/api/pitch"]) {
    const res = await post(path, big);
    assert.equal(res.status, 413, path);
    assert.deepEqual(await res.json(), { error: MESSAGES.tooLarge });
  }
  // A declared content-length above the cap is refused without reading the body.
  const declared = await post("/api/plan", PLAN, demoEnv(), { "content-length": String(100 * 1024) });
  assert.equal(declared.status, 413);
});

// ---- /api/city validation ----

test("city rejects long names, bad comps and missing fields with 400", async () => {
  const base = { city: "Asheville, NC", home: "Richmond, VA", comps: COMPS };
  const cases: Array<[unknown, RegExp]> = [
    [{ ...base, city: "" }, /city and home are required/],
    [{ ...base, city: "x".repeat(81) }, /80 characters/],
    [{ ...base, home: "y".repeat(81) }, /80 characters/],
    [{ ...base, comps: [] }, /1 to 3/],
    [{ ...base, comps: [...COMPS, ...COMPS] }, /1 to 3/],
    [{ ...base, comps: [{ id: 5, name: "Big Thief" }] }, /id and a name/],
    [{ ...base, comps: [{ id: "A1", name: "z".repeat(81) }] }, /80 characters/],
    [{ ...base, comps: [{ name: "Big Thief" }] }, /id and a name/],
  ];
  for (const [body, re] of cases) {
    const res = await post("/api/city", body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match((await res.json()).error, re);
  }
});

test("city replays a recorded playbook with the fixture note and ignores junk in locality", { skip: !RECORDED_AVAILABLE }, async () => {
  const health = await (await worker.fetch(new Request(`${ORIGIN}/api/health`), demoEnv())).json();
  const city = health.recordedCities[0];
  const locality = { id: "L1", name: city.split(",")[0], label: city, rank: 1, affinity: 0.9, why: Array(40).fill("w".repeat(500)), bogus: { deep: [1, 2, 3] } };
  const res = await post("/api/city", { city, home: "Richmond, VA", comps: COMPS, locality, scenarioId: "hollow-pines", recorded: true });
  assert.equal(res.status, 200);
  const events = await sseEvents(res);
  const meta = events.find((e) => e.type === "meta")!;
  assert.equal(meta.recorded, true);
  assert.equal(meta.fixtureNote, FIXTURE_NOTE);
  const playbook = events.find((e) => e.type === "playbook") as any;
  assert.equal(playbook.playbook.city, city);
  assert.equal(events.at(-1)?.type, "done");
});

// ---- /api/pitch caps and robustness ----

test("pitch works without obvious or playbooks and caps every list", async () => {
  const stops = Array.from({ length: 30 }, (_, i) => STOP(`Town ${i + 1}, NC`, i + 1));
  const notes = Array.from({ length: 10 }, (_, i) => `note ${i} ${"n".repeat(400)}`);
  const playbooks = Array.from({ length: 30 }, (_, i) => ({
    city: `Town ${i + 1}, NC`,
    rooms: [{ name: `Room ${i + 1}`, extra: { huge: "h".repeat(300) } }, { name: "Second" }, { name: "Third" }],
    promo: [{ kind: "record store", places: [{ name: `Shop ${i + 1}` }, { name: "Other" }] }],
    who: { strongestAge: "25_to_29" },
    receipts: Array(5).fill({ url: "x".repeat(200) }),
  }));
  const obvious = { cities: Array(40).fill("Nashville, TN"), overlap: Array(40).fill("Nashville, TN"), smallTowns: 3, summary: "s".repeat(1000), junk: [1] };
  const res = await post("/api/pitch", { route: { ...ROUTE, stops, notes }, playbooks, comps: [...COMPS, ...COMPS], home: "Richmond, VA", obvious });
  assert.equal(res.status, 200);
  const pitch = await res.json();
  assert.equal(pitch.itinerary.length, 21, "stops capped to 21");
  assert.equal(pitch.itinerary[0].topRoom, "Room 1");
  assert.equal(pitch.itinerary[0].topPromo, "Shop 1");
  assert.match(pitch.itinerary[0].ageRead, /25.*29/);
  assert.equal(pitch.totalMiles, 640);
  assert.equal(typeof pitch.text, "string");
  assert.ok(pitch.text.length > 80);

  // No obvious, no playbooks, no home, no notes: still a pitch.
  const bare = await post("/api/pitch", { route: { stops: ROUTE.stops, totalMiles: 640 } });
  assert.equal(bare.status, 200);
  const p2 = await bare.json();
  assert.equal(p2.itinerary.length, 2);
  assert.ok(p2.text.length > 80);
  assert.ok(!("topRoom" in p2.itinerary[0]));
});

test("pitch needs a route with stops", async () => {
  for (const body of [{}, { route: { stops: [], totalMiles: 10 } }, { route: { stops: [STOP("A, NC", 1)] } }, { route: "x" }]) {
    const res = await post("/api/pitch", body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

// ---- spend guard ----

test("a LIVE_LIMITER binding that says no turns a Claude-spending call into a 429", async () => {
  const seen: string[] = [];
  const LIVE_LIMITER = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: false }) };
  // DEV=1 makes Claude "available"; the limiter must answer before any client is built.
  const env = demoEnv({ DEV: "1", LIVE_LIMITER });
  const res = await post("/api/pitch", { route: ROUTE, comps: COMPS, home: "Richmond, VA" }, env, { "cf-connecting-ip": "203.0.113.9" });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: MESSAGES.busy });
  assert.deepEqual(seen, ["203.0.113.9"]);

  const city = await post("/api/city", { city: "Asheville, NC", home: "Richmond, VA", comps: COMPS }, env);
  assert.equal(city.status, 429);
  assert.deepEqual(seen, ["203.0.113.9", "anon"]);

  // Recorded replays are never limited.
  const replay = await post("/api/pitch", { route: ROUTE, scenarioId: "hollow-pines", recorded: true }, env);
  assert.notEqual(replay.status, 429);
  assert.equal(seen.length, 2);
});

test("without the binding the in-memory window allows 6 calls per minute per IP", async () => {
  resetLiveLimiter();
  const env = demoEnv();
  const req = (ip: string) => new Request(`${ORIGIN}/api/pitch`, { method: "POST", headers: { "cf-connecting-ip": ip } });
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < LIVE_WINDOW.limit; i++) assert.equal(await allowLiveCall(env, req("10.0.0.1"), t0 + i * 1000), true, `call ${i + 1}`);
  assert.equal(await allowLiveCall(env, req("10.0.0.1"), t0 + 7000), false, "7th call from the same IP");
  assert.equal(await allowLiveCall(env, req("10.0.0.2"), t0 + 7000), true, "another IP is not affected");
  assert.equal(await allowLiveCall(env, req("10.0.0.1"), t0 + LIVE_WINDOW.periodMs + 1), true, "the window slides");
  // Under the Node dev server (DEV=1) the in-memory window is off, a real binding is still honored.
  for (let i = 0; i < 10; i++) assert.equal(await allowLiveCall(demoEnv({ DEV: "1" }), req("10.0.0.3"), t0), true);
  const no = { limit: async () => ({ success: false }) };
  assert.equal(await allowLiveCall(demoEnv({ DEV: "1", LIVE_LIMITER: no }), req("10.0.0.3"), t0), false);
  resetLiveLimiter();
});

test("the in-memory window answers 429 on the pitch endpoint after 6 calls from one IP", async () => {
  resetLiveLimiter();
  // Claude "available" through a key, but every call is blocked by a binding except... no binding here:
  // the in-memory window applies. Use the pitch endpoint, which would call Claude on the 7th request,
  // and prove the guard fires first by exhausting the window directly and then posting.
  const env = demoEnv({ ANTHROPIC_API_KEY: "sk-test-not-real" });
  const ip = { "cf-connecting-ip": "198.51.100.7" };
  for (let i = 0; i < LIVE_WINDOW.limit; i++) assert.equal(await allowLiveCall(env, new Request(`${ORIGIN}/x`, { headers: ip })), true);
  const res = await post("/api/pitch", { route: ROUTE, comps: COMPS, home: "Richmond, VA" }, env, ip);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  // The same request without Claude available is not a spending branch, so it is not limited.
  const free = await post("/api/pitch", { route: ROUTE, comps: COMPS, home: "Richmond, VA" }, demoEnv(), ip);
  assert.equal(free.status, 200);
  resetLiveLimiter();
});

// ---- SSE error sanitization ----

async function streamThatThrows(err: unknown): Promise<SseEvent[]> {
  async function* gen(): AsyncGenerator<SseEvent> {
    yield { type: "status", message: "working" };
    throw err;
  }
  const quiet = console.error;
  console.error = () => {};
  try {
    return await sseEvents(sseResponse(gen()));
  } finally {
    console.error = quiet;
  }
}

test("sseResponse hides raw errors: Anthropic API errors name their status, everything else is generic", async () => {
  const api = await streamThatThrows(new Anthropic.APIError(529, { type: "overloaded_error" }, "Overloaded: req_abc123 model x", undefined));
  assert.deepEqual(api.at(-1), { type: "error", message: "Claude is unavailable right now (HTTP 529). The Hollow Pines sample still works." });

  const statusOnly = await streamThatThrows(Object.assign(new Error("401 invalid x-api-key sk-ant-secret"), { status: 401 }));
  assert.deepEqual(statusOnly.at(-1), { type: "error", message: "Claude is unavailable right now (HTTP 401). The Hollow Pines sample still works." });

  const plain = await streamThatThrows(new Error("ENOTFOUND hackathon.api.qloo.com /private/path"));
  assert.deepEqual(plain.at(-1), { type: "error", message: "Something went wrong on the server." });
  assert.equal(plain[1].type, "status", "events before the failure still arrive");

  const stringy = await streamThatThrows("raw string with secrets");
  assert.deepEqual(stringy.at(-1), { type: "error", message: "Something went wrong on the server." });
});

// ---- misc ----

test("unknown /api paths are 404 and other paths fall through to assets with security headers", async () => {
  const api = await worker.fetch(new Request(`${ORIGIN}/api/nope`), demoEnv());
  assert.equal(api.status, 404);
  const asset = await worker.fetch(new Request(`${ORIGIN}/index.html`), demoEnv());
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await asset.text(), "asset");
});
