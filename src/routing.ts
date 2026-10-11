// Tour routing for Next Town. Pure functions, no I/O and no Qloo: the input is the ranked list of
// localities (already joined with Census coordinates and population by rank_markets) and the output
// is a drivable loop from home plus a plain-words note for every judgment call the planner made.
//
// public/js/routing.js is a line-for-line plain-JS copy of this file so the browser can re-route
// instantly when the user pins or drops a city. Keep the two in step: tests/routing.test.ts feeds
// both the same inputs and asserts they return identical routes.
//
// The model, in plain words:
//   - Distances are straight-line (haversine) miles times ROAD_FACTOR (1.25) as an estimate of road
//     miles; a leg takes miles / 55 hours. Nothing here is a routed drive time: every mile and hour
//     figure is an estimate, and the notes say "about" and "est." wherever they state one.
//   - A show day is a leg of at most `driveHoursCap` hours followed by a show that night.
//   - A longer leg costs drive days first: ceil(hours / cap) - 1 full days of driving, no show.
//   - Stops = days - driveDays, but never fewer than 3 (then the plan runs long and says so).
//   - Build: greedy nearest-neighbour from home, preferring over-index towns (small markets where
//     the comps' audience ranks top 20), then everyone else; a 2-opt pass (a few sweeps) to untangle
//     crossings; any pinned town the loop missed is slotted in where it adds the fewest miles
//     (bumping the weakest unpinned stop when the days run out); fill any day left open; return
//     home. A pin never reorders the loop: pinning a stop already on it returns the same route.

import type { Locality, ObviousRoute, Route, RouteStop } from "./types.ts";

export const AVG_MPH = 55;
// Road miles are estimated as straight-line miles times this factor, since roads wander. Keep it
// in step with the fine print in the UI ("x1.25 road factor at 55 mph").
export const ROAD_FACTOR = 1.25;
const EARTH_RADIUS_MILES = 3958.8;
const MIN_STOPS = 3;
const MAX_SWEEPS = 6;
// Same thresholds as C.OVER_INDEX_POP / C.OVER_INDEX_RANK in queries.ts, kept local so routing.js
// (which cannot import TypeScript) stays an exact copy.
const OVER_INDEX_POP = 250_000;
const OVER_INDEX_RANK = 20;

export interface PlanRouteInput {
  home: { label: string; lat: number; lon: number };
  localities: Locality[]; // ranked; entries without lat/lon are skipped
  days: number;
  driveHoursCap: number;
  mustInclude?: string[]; // locality labels
  exclude?: string[]; // locality labels
}

interface Point {
  label: string;
  lat: number;
  lon: number;
}

// A locality the planner can route to: it has coordinates and is not the home city.
interface Candidate extends Point {
  loc: Locality;
  overIndex: boolean;
  forced: boolean; // pinned via mustInclude
}

interface Leg {
  from: Point;
  to: Point;
  miles: number; // estimated road miles
  hours: number; // rounded to a tenth; every cap comparison uses this rounded figure
}

// ---- geometry and formatting ----

// Straight-line (great-circle) miles. Only used directly for the road estimate below.
export function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

// Estimated road miles: straight-line times ROAD_FACTOR. Every leg, total and hour figure the
// planner reports is derived from this estimate, never from a routed drive.
export function roadMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  return haversineMiles(a, b) * ROAD_FACTOR;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
// Hours are derived from whole miles so the miles and hours shown for a leg always agree.
const hoursFor = (miles: number): number => round1(Math.round(miles) / AVG_MPH);
const hoursBetween = (a: Point, b: Point): number => hoursFor(roadMiles(a, b));

// Full driving days (no show) a leg needs before the show day. A leg within the cap needs none;
// anything longer is split into cap-sized days, the last of which is the show day.
const driveDaysFor = (hours: number, cap: number): number => Math.max(0, Math.ceil(hours / cap - 1e-9) - 1);

// Hours and miles in notes are estimates (straight-line times the road factor), so say so.
function fmtHours(h: number): string {
  const r = round1(h);
  return `about ${r} hour${r === 1 ? "" : "s"} (est.)`;
}

function fmtMiles(miles: number): string {
  const r = Math.round(miles);
  return `about ${r} mile${r === 1 ? "" : "s"}`;
}

function listOf(names: string[], max = 4): string {
  if (names.length <= max) return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

// Case- and whitespace-insensitive key for a "City, ST" label.
export function labelKey(s: string): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

// "Asheville, NC" matches its label; a bare "Asheville" matches on the city name alone.
function sameCity(loc: { label: string; name?: string }, wanted: string): boolean {
  const k = labelKey(wanted);
  if (!k) return false;
  return k === labelKey(loc.label) || (!k.includes(",") && !!loc.name && k === labelKey(loc.name));
}

function isOverIndex(loc: Locality): boolean {
  if (typeof loc.overIndex === "boolean") return loc.overIndex;
  return typeof loc.population === "number" && typeof loc.rank === "number" && loc.population < OVER_INDEX_POP && loc.rank <= OVER_INDEX_RANK;
}

function byRank(a: Locality, b: Locality): number {
  const ra = typeof a.rank === "number" ? a.rank : Infinity;
  const rb = typeof b.rank === "number" ? b.rank : Infinity;
  if (ra !== rb) return ra - rb;
  const fa = a.affinity ?? 0;
  const fb = b.affinity ?? 0;
  if (fa !== fb) return fb - fa;
  return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
}

// ---- loop arithmetic: legs, days and miles for a given stop order ----

// Legs of the loop home -> stops... -> home. Empty when there are no stops.
function loopLegs(home: Point, order: Point[]): Leg[] {
  if (order.length === 0) return [];
  const pts = [home, ...order, home];
  const legs: Leg[] = [];
  for (let i = 1; i < pts.length; i++) {
    const miles = roadMiles(pts[i - 1], pts[i]);
    legs.push({ from: pts[i - 1], to: pts[i], miles, hours: hoursFor(miles) });
  }
  return legs;
}

const loopMiles = (home: Point, order: Point[]): number => loopLegs(home, order).reduce((sum, l) => sum + l.miles, 0);

// Calendar days the loop takes: one show day per stop plus every drive day, including any the
// final leg home needs.
function loopDays(home: Point, order: Point[], cap: number): number {
  return order.length + loopLegs(home, order).reduce((sum, l) => sum + driveDaysFor(l.hours, cap), 0);
}

// Next stop from `at`, nearest first within each preference tier. Over-index towns come first,
// then everyone else; markets reachable within the cap are always tried before any that would
// cost a drive day. `fits` is the day-budget check. Pins play no part here: a pinned town the
// greedy pass misses is slotted in afterwards, so a pin can never reshuffle the loop.
//
// Over-index candidates are scored by the hours to reach them. A bigger market is scored by those
// hours plus the hop from it to the nearest over-index town still unvisited, so a big-city stop is
// chosen as a bridge back toward the small towns rather than a detour away.
function chooseNext(at: Point, remaining: Candidate[], cap: number, fits: (c: Candidate) => boolean): Candidate | undefined {
  const smallLeft = remaining.filter((c) => c.overIndex);
  const lookahead = (c: Candidate) => (smallLeft.length ? Math.min(...smallLeft.map((o) => hoursBetween(c, o))) : 0);
  const scored = remaining.map((c) => {
    const hours = hoursBetween(at, c);
    return { c, hours, score: c.overIndex ? hours : hours + lookahead(c) };
  });
  const tiers: Array<(s: { c: Candidate; hours: number }) => boolean> = [
    (s) => s.hours <= cap && s.c.overIndex,
    (s) => s.hours <= cap,
    (s) => s.c.overIndex,
    () => true,
  ];
  for (const inTier of tiers) {
    // Stable sort: equal scores keep rank order.
    const options = scored.filter(inTier).sort((p, q) => p.score - q.score);
    for (const o of options) if (fits(o.c)) return o.c;
  }
  return undefined;
}

// 2-opt improvement over the loop (home fixed at both ends): reversing the stretch between two
// stops swaps two legs for two others. A reversal is kept when it removes a drive day, or keeps
// drive days equal and shortens the loop. One sweep tries every pair once, first improvement
// applied in place; a sweep that changed something is followed by another, up to MAX_SWEEPS, since
// a single sweep routinely leaves a fixable over-cap leg behind.
function twoOpt(home: Point, order: Candidate[], cap: number): Candidate[] {
  const pts: Point[] = [home, ...order, home];
  const n = order.length;
  const cost = (a: Point, b: Point) => {
    const miles = roadMiles(a, b);
    return { miles, dd: driveDaysFor(hoursFor(miles), cap) };
  };
  for (let sweep = 0, improved = true; improved && sweep < MAX_SWEEPS; sweep++) {
    improved = false;
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j <= n; j++) {
        const a = pts[i - 1];
        const b = pts[i];
        const c = pts[j];
        const d = pts[j + 1];
        const ab = cost(a, b);
        const cd = cost(c, d);
        const ac = cost(a, c);
        const bd = cost(b, d);
        const ddDelta = ac.dd + bd.dd - ab.dd - cd.dd;
        const milesDelta = ac.miles + bd.miles - ab.miles - cd.miles;
        if (ddDelta < 0 || (ddDelta === 0 && milesDelta < -0.5)) {
          const reversed = pts.slice(i, j + 1).reverse();
          pts.splice(i, j - i + 1, ...reversed);
          improved = true;
        }
      }
    }
  }
  return pts.slice(1, -1) as Candidate[];
}

interface Slot {
  index: number; // position in the stop order
  prev: Point;
  next: Point;
  added: number; // detour miles the insertion adds to the loop
}

// Cheapest place to slot `c` into the loop (least added miles) that still passes `ok`.
function cheapestSlot(home: Point, order: Candidate[], c: Candidate, ok: (seq: Candidate[]) => boolean): Slot | undefined {
  let best: Slot | undefined;
  for (let i = 0; i <= order.length; i++) {
    const prev = i === 0 ? home : order[i - 1];
    const next = i === order.length ? home : order[i];
    const added = roadMiles(prev, c) + roadMiles(c, next) - roadMiles(prev, next);
    if (best && added >= best.added) continue;
    if (!ok([...order.slice(0, i), c, ...order.slice(i)])) continue;
    best = { index: i, prev, next, added };
  }
  return best;
}

// The stop a pin may bump when the days run out: a bigger market before an over-index town, and
// among equals the worst-ranked. Pinned stops are never bumped.
function weakestStop(order: Candidate[]): Candidate | undefined {
  let weakest: Candidate | undefined;
  for (const c of order) {
    if (c.forced) continue;
    if (!weakest || (weakest.overIndex && !c.overIndex) || (weakest.overIndex === c.overIndex && byRank(c.loc, weakest.loc) > 0)) weakest = c;
  }
  return weakest;
}

// ---- the planner ----

export function planRoute(input: PlanRouteInput): Route {
  const home: Point = { label: input.home.label, lat: input.home.lat, lon: input.home.lon };
  const days = Math.max(1, Math.floor(input.days));
  const cap = Math.max(0.5, input.driveHoursCap);
  const notes: string[] = [];

  // 1. Candidates: ranked localities with coordinates. Home bookends the loop, so it is not a stop.
  const ranked = [...input.localities].sort(byRank);
  const candidates: Candidate[] = [];
  const noCoords: string[] = [];
  for (const loc of ranked) {
    if (typeof loc.lat !== "number" || typeof loc.lon !== "number" || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
      noCoords.push(loc.label);
      continue;
    }
    if (labelKey(loc.label) === labelKey(home.label)) {
      notes.push(`Left out ${loc.label}: that's home, so it bookends the loop instead of taking a day.`);
      continue;
    }
    candidates.push({ label: loc.label, lat: loc.lat, lon: loc.lon, loc, overIndex: isOverIndex(loc), forced: false });
  }
  if (noCoords.length) notes.push(`No coordinates on file for ${listOf(noCoords)}, so ${noCoords.length === 1 ? "it" : "they"} can't be routed.`);

  // 2. Pins and drops. A pin wins if the same city is in both lists. The pin's own note comes in
  //    step 5, once the planner knows whether the loop reached it on its own.
  for (const label of input.mustInclude ?? []) {
    const hit = candidates.find((c) => sameCity(c.loc, label));
    if (hit) hit.forced = true;
    else if (ranked.some((l) => sameCity(l, label))) notes.push(`Couldn't pin ${label}: no coordinates on file.`);
    else notes.push(`Couldn't pin ${label}: it isn't in the ranked markets.`);
  }
  const dropped = new Set<Candidate>();
  for (const label of input.exclude ?? []) {
    const hit = candidates.find((c) => sameCity(c.loc, label));
    if (!hit) notes.push(`Couldn't drop ${label}: it isn't in the routable markets.`);
    else if (hit.forced) notes.push(`Kept ${hit.label}: it's pinned, so the drop was ignored.`);
    else if (!dropped.has(hit)) {
      dropped.add(hit);
      notes.push(`Dropped ${hit.label} at your request.`);
    }
  }
  const pool = candidates.filter((c) => !dropped.has(c));
  const pinned = pool.filter((c) => c.forced);

  // 3. Greedy loop from home, pins ignored. Each stop costs a show day plus any drive days its leg
  //    (and the new leg home) needs; a stop only goes in while it fits the day budget, except the
  //    first three stops, which go in regardless.
  const fitsBudget = (seq: Candidate[]) => loopDays(home, seq, cap) <= days;
  let order: Candidate[] = [];
  const remaining = [...pool];
  let at: Point = home;
  while (remaining.length) {
    const next = chooseNext(at, remaining, cap, (c) => order.length < MIN_STOPS || fitsBudget([...order, c]));
    if (!next) break;
    remaining.splice(remaining.indexOf(next), 1);
    order.push(next);
    at = next;
  }

  // 4. 2-opt to untangle the loop.
  const greedyMiles = loopMiles(home, order);
  order = twoOpt(home, order, cap);
  const saved = greedyMiles - loopMiles(home, order);
  if (saved >= 1) notes.push(`Reordered the loop to save ${fmtMiles(saved)} of driving.`);

  // 5. Pins the loop missed go in where they add the fewest miles, leaving the stops already placed
  //    in their order, so pinning a stop that is already on the loop changes nothing. When the day
  //    budget has no room, the weakest unpinned stops are bumped one at a time (never below the
  //    3-stop minimum) and the bumps are kept only if the pin then fits; otherwise the pin goes in
  //    anyway and the plan runs long.
  const bumped = new Set<Candidate>();
  let pinsOverBudget = false;
  for (const pin of pinned) {
    if (order.includes(pin)) {
      notes.push(`Pinned ${pin.label}: it's already on the loop, so nothing moved.`);
      continue;
    }
    const idx = remaining.indexOf(pin);
    if (idx >= 0) remaining.splice(idx, 1);
    let slot = cheapestSlot(home, order, pin, fitsBudget);
    let fits = true;
    if (!slot) {
      const trial = [...order];
      const bumps: Candidate[] = [];
      while (!slot && trial.length >= MIN_STOPS) {
        const weak = weakestStop(trial);
        if (!weak) break;
        trial.splice(trial.indexOf(weak), 1);
        bumps.push(weak);
        slot = cheapestSlot(home, trial, pin, fitsBudget);
      }
      if (slot) {
        order = trial;
        for (const weak of bumps) {
          bumped.add(weak);
          notes.push(`Dropped ${weak.label} to make room for pinned ${pin.label}.`);
        }
      } else {
        slot = cheapestSlot(home, order, pin, () => true)!;
        fits = false;
        pinsOverBudget = true;
      }
    }
    order.splice(slot.index, 0, pin);
    notes.push(`Pinned ${pin.label}: added between ${slot.prev.label} and ${slot.next.label}${fits ? "" : ", even though it doesn't fit the days"}.`);
  }

  // 6. Fill days the reorder (or a greedy dead end) left open: slot a remaining market into the
  //    gap where it adds the fewest miles, as long as it fits the budget and the detour is under a
  //    day's drive. An over-index town wins whenever one qualifies; otherwise the smallest detour.
  const byPreference = [...remaining].sort((a, b) => Number(b.overIndex) - Number(a.overIndex));
  while (byPreference.length && loopDays(home, order, cap) < days) {
    let best: { c: Candidate; slot: Slot } | undefined;
    for (const c of byPreference) {
      if (best && best.c.overIndex && !c.overIndex) break; // over-index towns come first in the list
      const slot = cheapestSlot(home, order, c, fitsBudget);
      if (!slot || hoursFor(slot.added) > cap) continue;
      if (!best || slot.added < best.slot.added) best = { c, slot };
    }
    if (!best) break;
    order.splice(best.slot.index, 0, best.c);
    byPreference.splice(byPreference.indexOf(best.c), 1);
    notes.push(`Added ${best.c.label} between ${best.slot.prev.label} and ${best.slot.next.label} to use an open day.`);
  }

  // 7. Lay the loop out by day. The first stop's leg is measured from home; the leg back home is
  //    folded into the totals and the home-stretch note.
  const stops: RouteStop[] = [];
  let day = 0;
  let driveDays = 0;
  let totalMiles = 0;
  let totalHours = 0;
  let prev: Point = home;
  for (const c of order) {
    const miles = roadMiles(prev, c);
    const hours = hoursFor(miles);
    const dd = driveDaysFor(hours, cap);
    if (dd > 0) {
      const which = dd === 1 ? `Day ${day + 1} is a drive day` : `Days ${day + 1}-${day + dd} are drive days`;
      notes.push(`${which}: ${prev.label} to ${c.label} is ${fmtHours(hours)}, over your ${cap}-hour cap.`);
    }
    day += dd + 1;
    driveDays += dd;
    totalMiles += Math.round(miles);
    totalHours += hours;
    stops.push({
      localityId: c.loc.id,
      label: c.loc.label,
      lat: c.lat,
      lon: c.lon,
      day,
      legMiles: Math.round(miles),
      legHours: hours,
      driveDay: dd > 0,
      rank: c.loc.rank,
      affinity: c.loc.affinity,
      overIndex: c.overIndex,
      population: c.loc.population,
    });
    prev = c;
  }
  if (order.length) {
    const miles = roadMiles(prev, home);
    const hours = hoursFor(miles);
    const dd = driveDaysFor(hours, cap);
    driveDays += dd;
    totalMiles += Math.round(miles);
    totalHours += hours;
    const tail = dd === 0 ? "" : `, over your ${cap}-hour cap, so ${dd === 1 ? "the last day is a drive day" : `the last ${dd} days are drive days`}`;
    notes.push(`Home stretch: ${prev.label} to ${home.label} is ${fmtHours(hours)}${tail}.`);
  } else {
    notes.push("No routable markets, so the loop is empty.");
  }

  // 8. Every over-index town that did not make it gets a reason (a stop bumped for a pin already
  //    has one).
  const placed = new Set<Candidate>(order);
  const loopPts: Point[] = [home, ...order];
  for (const c of pool) {
    if (placed.has(c) || bumped.has(c) || !c.overIndex) continue;
    let near = loopPts[0];
    let nearHours = Infinity;
    for (const p of loopPts) {
      const h = hoursBetween(p, c);
      if (h < nearHours) {
        nearHours = h;
        near = p;
      }
    }
    notes.push(
      nearHours > cap
        ? `Skipped ${c.label}: ${fmtHours(nearHours)} from ${near.label} would cost a drive day.`
        : `Skipped ${c.label}: ${fmtHours(nearHours)} from ${near.label}, but it didn't fit in the ${days} days.`,
    );
  }

  // 9. Day budget: say so when the plan runs long or leaves days open.
  const used = stops.length + driveDays;
  if (used > days) {
    const why = pinsOverBudget ? " because of the pinned stops" : stops.length <= MIN_STOPS ? " to reach the 3-stop minimum" : "";
    notes.push(`This plan runs ${used} days against the ${days} you have${why}; drop a stop or raise the cap to pull it back.`);
  } else if (used < days && stops.length) {
    const open = days - used;
    notes.push(open === 1 ? `Day ${days} is open: a rest day, or pin another market.` : `Days ${used + 1}-${days} are open: rest days, or pin more markets.`);
  }

  return {
    home,
    stops,
    totalMiles,
    totalHours: round1(totalHours),
    driveDays,
    days: Math.max(days, used),
    notes,
  };
}

// ---- the obvious-route comparison ----

function stopIsOverIndex(s: RouteStop): boolean {
  if (typeof s.overIndex === "boolean") return s.overIndex;
  return typeof s.population === "number" && typeof s.rank === "number" && s.population < OVER_INDEX_POP && s.rank <= OVER_INDEX_RANK;
}

export function compareObvious(route: Route, obviousCities: string[]): ObviousRoute {
  const usual = new Set(obviousCities.map(labelKey));
  const overlap = route.stops.filter((s) => usual.has(labelKey(s.label))).map((s) => s.label);
  const smallTowns = route.stops.filter(stopIsOverIndex).length;
  const n = route.stops.length;
  const summary =
    n === 0
      ? "No stops yet to compare with the usual suspects."
      : `Overlap with the usual suspects: ${overlap.length} of ${n} stop${n === 1 ? "" : "s"}. ` +
        `${smallTowns} of your stops ${smallTowns === 1 ? "is a town" : "are towns"} under ${OVER_INDEX_POP / 1000}k where your affinity rank is top ${OVER_INDEX_RANK}.`;
  return { cities: [...obviousCities], overlap, smallTowns, summary };
}
