// "Build my tour": the booking-agent pitch. One Claude call for the ~150-word paragraph, with a
// templated fallback so the tour screen always has something to print. The itinerary rows are
// pure data (no model involved) so they are always consistent with the route.

import type Anthropic from "@anthropic-ai/sdk";
import type { Comp, ObviousRoute, Pitch, Playbook, Route } from "./types.ts";
import { ageBandLabel } from "./city.ts";
import { PITCH_SYSTEM } from "./copy.ts";

export interface BuildPitchOptions {
  client: Anthropic | null;
  model: string;
  route: Route;
  playbooks: Playbook[];
  comps: Comp[];
  home: string;
  obvious: ObviousRoute;
}

const sameCity = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// One row per stop, with the headline from that stop's playbook when the user opened it.
export function pitchItinerary(route: Route, playbooks: Playbook[]): Pitch["itinerary"] {
  const stops = Array.isArray(route?.stops) ? route.stops : [];
  const books = Array.isArray(playbooks) ? playbooks : [];
  return stops.map((s) => {
    const pb = books.find((p) => p && typeof p.city === "string" && sameCity(p.city, s.label));
    const topRoom = pb?.rooms?.[0]?.name;
    const topPromo = pb?.promo?.find?.((g) => g?.places?.length)?.places?.[0]?.name;
    const ageRead = pb?.who?.strongestAge ? ageBandLabel(pb.who.strongestAge) : undefined;
    return {
      day: s.day,
      city: s.label,
      driveHours: Math.round((Number(s.legHours) || 0) * 10) / 10,
      overIndex: Boolean(s.overIndex),
      ...(topRoom ? { topRoom } : {}),
      ...(topPromo ? { topPromo } : {}),
      ...(ageRead ? { ageRead } : {}),
    };
  });
}

// Templated paragraph from the data alone; also the shape Claude is asked to improve on.
export function fallbackPitchText(opts: Omit<BuildPitchOptions, "client" | "model">, itinerary: Pitch["itinerary"]): string {
  const { route, comps, home, obvious } = opts;
  const compNames = joinNames((comps ?? []).map((c) => c?.name).filter((n): n is string => typeof n === "string" && n.length > 0)) || "our comps";
  const routeStops = Array.isArray(route?.stops) ? route.stops : [];
  const stops = routeStops.length;
  const over = itinerary.filter((r) => r.overIndex).length;
  const rooms = itinerary.map((r) => (r.topRoom ? `${r.topRoom} in ${r.city}` : null)).filter((x): x is string => !!x).slice(0, 3);
  const first = routeStops[0]?.label;
  const last = routeStops.at(-1)?.label;
  const obviousCities = Array.isArray(obvious?.cities) ? obvious.cities : [];
  const overlap = Array.isArray(obvious?.overlap) ? obvious.overlap : [];
  const driveDays = Number(route?.driveDays) || 0;
  const sentences = [
    `We are routing a ${route.days}-day run out of ${home} built on Qloo taste data for fans of ${compNames}: ${stops} stops, about ${Math.round(route.totalMiles).toLocaleString("en-US")} miles (est.), ${driveDays} drive day${driveDays === 1 ? "" : "s"}.`,
    first && last ? `The loop opens in ${first} and closes in ${last}.` : "",
    over ? `${over} of the ${stops} stops are towns under 250k whose best-matching room ranks in the national top 20 for that audience, markets the big-city streaming numbers would have skipped.` : "",
    obviousCities.length
      ? overlap.length
        ? `${overlap.length} of the ${stops} stops are on the usual big-market list.`
        : "None of the stops are on the usual big-market list."
      : "",
    rooms.length ? `The rooms we would like to approach first, the ones fans of our comps rank highest, include ${joinNames(rooms)}.` : "",
    "Every stop comes with a one-page advance sheet: rooms, promo partners, an audience read, and the exact Qloo queries behind each pick. Happy to send the full packet.",
  ];
  return sentences.filter(Boolean).join(" ");
}

export async function buildPitch(opts: BuildPitchOptions): Promise<Pitch> {
  const itinerary = pitchItinerary(opts.route, opts.playbooks);
  const totalMiles = Math.round(opts.route.totalMiles);
  let text = fallbackPitchText(opts, itinerary);

  if (opts.client) {
    try {
      const payload = {
        home: opts.home,
        comps: opts.comps.map((c) => c.name),
        days: opts.route.days,
        totalMiles,
        driveDays: opts.route.driveDays,
        obvious: {
          cities: Array.isArray(opts.obvious?.cities) ? opts.obvious.cities : [],
          overlap: Array.isArray(opts.obvious?.overlap) ? opts.obvious.overlap : [],
          smallTowns: Number(opts.obvious?.smallTowns) || 0,
          summary: typeof opts.obvious?.summary === "string" ? opts.obvious.summary : "",
        },
        itinerary,
        notes: Array.isArray(opts.route.notes) ? opts.route.notes.slice(0, 6) : [],
      };
      // Thinking is always on for this model family and its tokens count against max_tokens, so the
      // cap is well above the ~150 words we want back and effort is low (a short paragraph, no tools).
      const message = await opts.client.messages.create({
        model: opts.model,
        max_tokens: 4000,
        output_config: { effort: "low" },
        system: PITCH_SYSTEM,
        messages: [{ role: "user", content: `Write the pitch from this data:\n${JSON.stringify(payload)}` }],
      });
      const draft = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      // A cut-off paragraph (max_tokens) reads worse than the template, so only a finished one wins.
      if (message.stop_reason === "end_turn" && draft.length > 80) text = draft;
    } catch {
      // Keep the templated text; the pitch must never be empty.
    }
  }

  return { text, itinerary, totalMiles };
}
