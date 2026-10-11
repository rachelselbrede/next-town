import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineMiles, planRoute, compareObvious, AVG_MPH } from "../src/routing.ts";
import * as browser from "../public/js/routing.js";
import type { Locality, Route } from "../src/types.ts";

// ---- helpers ----

// Synthetic geography on the equator: one degree of latitude or longitude is about 69.1 miles,
// which is 1.3 hours at 55 mph, so a 6-hour cap is roughly 4.8 degrees.
const HOME = { label: "Home, XX", lat: 0, lon: 0 };

function loc(label: string, lat: number, lon: number, rank: number, extra: Partial<Locality> = {}): Locality {
  const [name, state] = label.split(", ");
  const population = extra.population ?? 50_000;
  return { id: `id-${label}`, name, state, label, rank, affinity: 1 - rank / 100, population, lat, lon, overIndex: population < 250_000 && rank <= 20, why: [], ...extra };
}

const near = () => [loc("Alpha, XX", 0.5, 0, 1), loc("Bravo, XX", 1.0, 0, 2), loc("Charlie, XX", 1.5, 0, 3)];
// Far is 7 degrees north of home: 484 miles, 8.8 hours, a drive day from anywhere else in the set.
const far = () => loc("Far, XX", 0, 7, 4);

const hoursFor = (miles: number) => Math.round((miles / AVG_MPH) * 10) / 10;
const labels = (r: Route) => r.stops.map((s) => s.label);
const returnMiles = (r: Route) => (r.stops.length ? Math.round(haversineMiles(r.stops[r.stops.length - 1], r.home)) : 0);

// Structural invariants every route must satisfy, whatever the input.
function checkInvariants(r: Route, input: { days: number; driveHoursCap: number }) {
  assert.deepEqual(labels(r), [...new Set(labels(r))], "no stop appears twice");
  let prevDay = 0;
  for (const s of r.stops) {
    assert.ok(s.day > prevDay, "days strictly increase");
    assert.equal(s.driveDay, s.legHours > input.driveHoursCap, `${s.label}: driveDay matches the cap`);
    assert.equal(s.legHours, hoursFor(s.legMiles), `${s.label}: hours follow miles at ${AVG_MPH} mph`);
    prevDay = s.day;
  }
  const legSum = r.stops.reduce((sum, s) => sum + s.legMiles, 0) + returnMiles(r);
  assert.equal(r.totalMiles, legSum, "totalMiles = every leg plus the drive home");
  assert.equal(r.days, Math.max(input.days, r.stops.length + r.driveDays), "days covers the plan");
  assert.ok(r.stops.length + r.driveDays <= r.days, "show days plus drive days fit the plan");
}

// ---- haversine ----

test("haversineMiles: Richmond to Charlottesville is about 66 miles", () => {
  const d = haversineMiles({ lat: 37.5407, lon: -77.436 }, { lat: 38.0293, lon: -78.4767 });
  assert.ok(Math.abs(d - 66) < 3, String(d));
  assert.equal(haversineMiles(HOME, HOME), 0);
  assert.equal(haversineMiles({ lat: 10, lon: 20 }, { lat: -5, lon: 40 }), haversineMiles({ lat: -5, lon: 40 }, { lat: 10, lon: 20 }));
  assert.ok(Math.abs(haversineMiles({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 69.1) < 0.2);
});

// ---- planRoute ----

test("loop returns home, days count up, and the totals add up", () => {
  const input = { home: HOME, localities: [...near(), loc("Delta, XX", 0, 1, 4)], days: 6, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 4);
  assert.deepEqual(r.stops.map((s) => s.day), [1, 2, 3, 4]);
  assert.equal(r.driveDays, 0);
  assert.equal(r.stops[0].legMiles, Math.round(haversineMiles(HOME, r.stops[0])), "first leg is measured from home");
  const hourSum = r.stops.reduce((sum, s) => sum + s.legHours, 0) + hoursFor(returnMiles(r));
  assert.ok(Math.abs(r.totalHours - hourSum) < 0.11);
  assert.ok(r.notes.some((n) => n.startsWith("Home stretch:")));
  assert.ok(r.notes.some((n) => n === "Days 5-6 are open: rest days, or pin more markets."), r.notes.join("\n"));
  assert.deepEqual(r.home, HOME);
});

test("over-index towns are chosen before a bigger market that is nearer", () => {
  const big = loc("Metro, XX", 0.2, 0, 1, { population: 1_200_000 });
  const input = { home: HOME, localities: [big, ...near()], days: 3, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.deepEqual(labels(r).sort(), ["Alpha, XX", "Bravo, XX", "Charlie, XX"]);
  assert.ok(r.stops.every((s) => s.overIndex));
});

test("a leg over the cap is skipped when the drive day does not fit", () => {
  const input = { home: HOME, localities: [...near(), far()], days: 4, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.deepEqual(labels(r).sort(), ["Alpha, XX", "Bravo, XX", "Charlie, XX"]);
  assert.equal(r.driveDays, 0);
  assert.ok(r.notes.some((n) => /^Skipped Far, XX: 8\.8 hours from .* would cost a drive day\.$/.test(n)), r.notes.join("\n"));
  assert.ok(r.notes.includes("Day 4 is open: a rest day, or pin another market."));
});

test("a leg over the cap becomes a drive day when the budget allows it", () => {
  // Far is 8.8 hours both ways, so it costs a drive day going out and another coming home.
  const input = { home: HOME, localities: [...near(), far()], days: 6, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 4);
  assert.equal(r.driveDays, 2);
  const farStop = r.stops.find((s) => s.label === "Far, XX")!;
  assert.equal(farStop.driveDay, true);
  assert.equal(farStop.legHours > 6, true);
  assert.equal(r.stops.length + r.driveDays, 6);
  assert.ok(r.notes.some((n) => /^Day \d is a drive day: .* to Far, XX is (8\.\d|9) hours, over your 6-hour cap\.$/.test(n)), r.notes.join("\n"));
  assert.ok(r.notes.some((n) => n.startsWith("Home stretch: Far, XX to Home, XX is 8.8 hours, over your 6-hour cap, so the last day is a drive day")));
  assert.ok(!r.notes.some((n) => n.startsWith("Skipped")));
});

test("stops never drop below three even when the days say fewer", () => {
  const input = { home: HOME, localities: [...near(), far()], days: 2, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 3);
  assert.equal(r.days, 3);
  assert.ok(r.notes.includes("This plan runs 3 days against the 2 you have to reach the 3-stop minimum; drop a stop or raise the cap to pull it back."), r.notes.join("\n"));
});

test("mustInclude forces a city in, even one that costs drive days, and matches loosely", () => {
  const input = { home: HOME, localities: [...near(), far()], days: 3, driveHoursCap: 6, mustInclude: ["  far "] };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.ok(labels(r).includes("Far, XX"));
  assert.equal(r.stops.length, 4);
  assert.equal(r.driveDays, 2);
  assert.equal(r.days, 6);
  assert.ok(r.notes.includes("Pinned Far, XX: it stays in the loop whatever the distance."));
  assert.ok(r.notes.includes("This plan runs 6 days against the 3 you have because of the pinned stops; drop a stop or raise the cap to pull it back."), r.notes.join("\n"));
});

test("exclude removes a city; unknown labels and pinned cities are reported", () => {
  const input = { home: HOME, localities: [...near(), far()], days: 4, driveHoursCap: 6, mustInclude: ["Bravo, XX"], exclude: ["alpha, xx", "Nowhere, ZZ", "Bravo, XX"] };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.ok(!labels(r).includes("Alpha, XX"));
  assert.ok(labels(r).includes("Bravo, XX"));
  assert.ok(r.notes.includes("Dropped Alpha, XX at your request."));
  assert.ok(r.notes.includes("Couldn't drop Nowhere, ZZ: it isn't in the routable markets."));
  assert.ok(r.notes.includes("Kept Bravo, XX: it's pinned, so the drop was ignored."));
});

test("localities without coordinates and the home city itself are left out with a note", () => {
  const blank = loc("Blank, XX", 0, 0, 1);
  delete (blank as any).lat;
  delete (blank as any).lon;
  const homeAgain = loc("home, xx", 0, 0, 5);
  const input = { home: HOME, localities: [blank, ...near(), homeAgain], days: 5, driveHoursCap: 6, mustInclude: ["Blank, XX"] };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.deepEqual(labels(r).sort(), ["Alpha, XX", "Bravo, XX", "Charlie, XX"]);
  assert.ok(r.notes.includes("No coordinates on file for Blank, XX, so it can't be routed."));
  assert.ok(r.notes.includes("Couldn't pin Blank, XX: no coordinates on file."));
  assert.ok(r.notes.includes("Left out home, xx: that's home, so it bookends the loop instead of taking a day."));
});

test("every over-index town that did not make the route gets a 'Skipped' note", () => {
  const many = Array.from({ length: 10 }, (_, i) => loc(`Town${i}, XX`, 0.4 * (i + 1), 0.3 * (i % 3), i + 1));
  const input = { home: HOME, localities: many, days: 5, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 5);
  const skipped = many.filter((l) => !labels(r).includes(l.label));
  assert.equal(skipped.length, 5);
  for (const l of skipped) assert.ok(r.notes.some((n) => n.startsWith(`Skipped ${l.label}: `)), `note for ${l.label}`);
});

test("2-opt untangles a crossing the greedy pass leaves behind", () => {
  // Three over-index towns on a square plus a big market just off home. Greedy visits the three
  // first and then doubles back for Metro; the reorder slots Metro next to home instead.
  const square = [loc("A, XX", 1, 0, 1), loc("B, XX", 1, 1, 2), loc("C, XX", 0, 1, 3), loc("Metro, XX", 0.5, 0.1, 4, { population: 900_000 })];
  const input = { home: HOME, localities: square, days: 4, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 4);
  assert.ok(r.totalMiles <= 280, `loop is ${r.totalMiles} miles; the greedy loop is about 314`);
  const metroIndex = labels(r).indexOf("Metro, XX");
  assert.ok(metroIndex === 0 || metroIndex === 3, "Metro sits next to home");
  assert.ok(r.notes.some((n) => /^Reordered the loop to save \d+ miles of driving\.$/.test(n)), r.notes.join("\n"));
});

test("an empty candidate list yields an empty loop, not a crash", () => {
  const r = planRoute({ home: HOME, localities: [], days: 5, driveHoursCap: 6 });
  assert.deepEqual(r.stops, []);
  assert.equal(r.totalMiles, 0);
  assert.equal(r.days, 5);
  assert.ok(r.notes.includes("No routable markets, so the loop is empty."));
  assert.equal(compareObvious(r, ["Nashville, TN"]).summary, "No stops yet to compare with the usual suspects.");
});

// ---- a realistic shape: the Hollow Pines top 20 with approximate coordinates (test data only) ----

const hollowPinesTop20: Array<[string, number, number, number]> = [
  ["Asheville, NC", 35.5951, -82.5515, 94589],
  ["Carrboro, NC", 35.9101, -79.0753, 21295],
  ["Athens, GA", 33.9519, -83.3576, 127315],
  ["Bloomington, IN", 39.1653, -86.5264, 79168],
  ["Charlottesville, VA", 38.0293, -78.4767, 46553],
  ["Burlington, VT", 44.4759, -73.2121, 44743],
  ["Northampton, MA", 42.3251, -72.6412, 29571],
  ["Philadelphia, PA", 39.9526, -75.1652, 1603797],
  ["Durham, NC", 35.994, -78.8986, 283506],
  ["Pittsburgh, PA", 40.4406, -79.9959, 302971],
  ["Athens, OH", 39.3292, -82.1013, 24486],
  ["Louisville, KY", 38.2527, -85.7585, 633045],
  ["Knoxville, TN", 35.9606, -83.9207, 190740],
  ["Harrisonburg, VA", 38.4496, -78.8689, 51814],
  ["Ithaca, NY", 42.444, -76.5019, 32108],
  ["Columbus, OH", 39.9612, -82.9988, 905748],
  ["Nashville, TN", 36.1627, -86.7816, 689447],
  ["Portland, ME", 43.6591, -70.2568, 68408],
  ["Lexington, KY", 38.0406, -84.5037, 322570],
  ["Wilmington, NC", 34.2257, -77.9447, 115451],
];
const richmond = { label: "Richmond, VA", lat: 37.5407, lon: -77.436 };
const hollowPinesLocalities = () => hollowPinesTop20.map(([label, lat, lon, population], i) => loc(label, lat, lon, i + 1, { population }));

test("Hollow Pines: 12 days at a 6-hour cap fills every day with mostly over-index towns", () => {
  const input = { home: richmond, localities: hollowPinesLocalities(), days: 12, driveHoursCap: 6 };
  const r = planRoute(input);
  checkInvariants(r, input);
  assert.equal(r.stops.length, 12);
  assert.equal(r.driveDays, 0);
  assert.ok(r.stops.every((s) => s.legHours <= 6));
  assert.ok(r.stops.filter((s) => s.overIndex).length >= 8, labels(r).join(" > "));
  // The New England towns never fit a 6-hour loop out of Richmond; Portland is over the cap from
  // anywhere on the loop, so its note names the drive day.
  for (const label of ["Burlington, VT", "Northampton, MA", "Ithaca, NY", "Portland, ME"]) assert.ok(r.notes.some((n) => n.startsWith(`Skipped ${label}: `)), r.notes.join("\n"));
  assert.ok(r.notes.some((n) => n.startsWith("Skipped Portland, ME: ") && n.endsWith("would cost a drive day.")), r.notes.join("\n"));
  const obvious = compareObvious(r, ["Nashville, TN", "Philadelphia, PA", "Chicago, IL"]);
  assert.equal(obvious.overlap.length, labels(r).filter((l) => l === "Nashville, TN" || l === "Philadelphia, PA").length);
  assert.equal(obvious.smallTowns, r.stops.filter((s) => s.overIndex).length);
});

// ---- compareObvious ----

test("compareObvious counts overlap and small towns and writes the summary", () => {
  const route: Route = {
    home: richmond,
    stops: [
      { localityId: "1", label: "Asheville, NC", lat: 0, lon: 0, day: 1, legMiles: 0, legHours: 0, driveDay: false, overIndex: true },
      { localityId: "2", label: "nashville, tn", lat: 0, lon: 0, day: 2, legMiles: 0, legHours: 0, driveDay: false, overIndex: false },
      { localityId: "3", label: "Boone, NC", lat: 0, lon: 0, day: 3, legMiles: 0, legHours: 0, driveDay: false, rank: 29, population: 19000 },
    ],
    totalMiles: 0,
    totalHours: 0,
    driveDays: 0,
    days: 3,
    notes: [],
  };
  const o = compareObvious(route, ["Nashville, TN", "Chicago, IL"]);
  assert.deepEqual(o.cities, ["Nashville, TN", "Chicago, IL"]);
  assert.deepEqual(o.overlap, ["nashville, tn"]);
  assert.equal(o.smallTowns, 1);
  assert.equal(o.summary, "Overlap with the usual suspects: 1 of 3 stops. 1 of your stops is a town under 250k where your affinity rank is top 20.");
});

// ---- the browser copy must behave exactly like the TypeScript module ----

// Small deterministic generator so the comparison covers shapes nobody hand-wrote.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function randomInput(seed: number) {
  const rnd = lcg(seed);
  const n = 3 + Math.floor(rnd() * 12);
  const localities = Array.from({ length: n }, (_, i) => {
    const l = loc(`Town${i}, R${seed % 7}`, 38 + rnd() * 6 - 3, -80 + rnd() * 8 - 4, i + 1, { population: rnd() < 0.3 ? 400_000 : 40_000 });
    if (rnd() < 0.08) delete (l as any).lat;
    return l;
  });
  const pick = () => localities[Math.floor(rnd() * n)].label;
  return {
    home: { label: "Richmond, VA", lat: 37.54, lon: -77.44 },
    localities,
    days: 3 + Math.floor(rnd() * 8),
    driveHoursCap: 3 + Math.floor(rnd() * 5),
    mustInclude: rnd() < 0.4 ? [pick()] : undefined,
    exclude: rnd() < 0.4 ? [pick()] : undefined,
  };
}

test("public/js/routing.js produces identical routes and comparisons to src/routing.ts", () => {
  const obvious = ["Nashville, TN", "Philadelphia, PA", "Town1, R0"];
  const inputs = [
    { home: HOME, localities: [...near(), far()], days: 6, driveHoursCap: 6 },
    { home: HOME, localities: [...near(), far()], days: 3, driveHoursCap: 6, mustInclude: ["Far, XX"], exclude: ["Alpha, XX"] },
    { home: richmond, localities: hollowPinesLocalities(), days: 12, driveHoursCap: 6 },
    { home: richmond, localities: hollowPinesLocalities(), days: 8, driveHoursCap: 4, mustInclude: ["Burlington, VT"], exclude: ["Durham, NC"] },
    ...Array.from({ length: 40 }, (_, i) => randomInput(i + 1)),
  ];
  for (const input of inputs) {
    const ts = planRoute(input);
    const js = browser.planRoute(input);
    checkInvariants(ts, input);
    assert.deepEqual(js, ts, `routes differ for days=${input.days} cap=${input.driveHoursCap} n=${input.localities.length}`);
    assert.deepEqual(browser.compareObvious(js, obvious), compareObvious(ts, obvious));
  }
  assert.equal(browser.haversineMiles(richmond, HOME), haversineMiles(richmond, HOME));
});
