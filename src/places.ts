// US place lookup: turns a label like "Asheville, NC" into population and coordinates.
//
// data/us-places.json is built by scripts/build-places.mjs from Census 2020 files (see data/README.md).
// It is imported statically so the Worker bundles it; nothing is read from disk at request time.
//
// findPlace() is deliberately forgiving because labels arrive from two unreliable sources: a person
// typing a home city ("washington dc", "St. Louis, MO", "Portland, Maine") and Qloo locality names
// ("Saint Louis, MO"). The table itself keeps Census spellings ("St. Louis"), and both sides of a
// lookup are normalized the same way so either spelling finds the row.

import places from "../data/us-places.json" with { type: "json" };

export interface PlaceRow {
  label: string; // "Asheville, NC"
  name: string; // "Asheville"
  state: string; // "NC"
  population: number; // 2020 Census count
  lat: number; // internal point, 4 decimals
  lon: number;
}

const ROWS: PlaceRow[] = places as PlaceRow[];

// Full state names (lower-case) to USPS codes, so "Portland, Maine" works like "Portland, ME".
const STATE_CODES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
  maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};
const STATE_SET = new Set(Object.values(STATE_CODES));
// Longest names first so "charleston west virginia" is not split at " virginia".
const STATE_NAMES_BY_LENGTH = Object.keys(STATE_CODES).sort((a, b) => b.length - a.length);

// Abbreviations people and the Census use interchangeably. Both sides of a lookup are expanded.
const WORD_EXPANSIONS: Record<string, string> = { st: "saint", ste: "sainte", mt: "mount", ft: "fort" };

// A few names that are neither the Census spelling nor an abbreviation of it.
const CITY_ALIASES: Record<string, string> = { "new york city": "new york", nyc: "new york" };

/** Normalizes a city name for matching: "St. Louis", "Saint Louis" and "ST LOUIS" all become "saint louis". */
export function cityKey(name: string): string {
  const key = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // drop accents: "Cañon City" matches "Canon City"
    .toLowerCase()
    .replace(/[.']/g, "") // "St." -> "St", "D.C." -> "DC", "Coeur d'Alene" -> "Coeur dAlene"
    .replace(/[^a-z0-9]+/g, " ") // hyphens, slashes and stray punctuation become single spaces
    .trim()
    .split(" ")
    .map((word) => WORD_EXPANSIONS[word] ?? word)
    .join(" ");
  return CITY_ALIASES[key] ?? key;
}

function toStateCode(text: string): string | undefined {
  const t = text.toLowerCase().replace(/\./g, "").trim();
  if (!t) return undefined;
  if (t.length === 2 && STATE_SET.has(t.toUpperCase())) return t.toUpperCase();
  return STATE_CODES[t];
}

// Indexes built once at module load. byLabel: "asheville|NC" -> row. byCity: "asheville" -> the most
// populous row with that name, used when no state is given ("Portland" -> Portland, OR).
const byLabel = new Map<string, PlaceRow>();
const byCity = new Map<string, PlaceRow>();
for (const row of ROWS) {
  const key = cityKey(row.name);
  const labelKey = `${key}|${row.state}`;
  const seen = byLabel.get(labelKey);
  if (!seen || row.population > seen.population) byLabel.set(labelKey, row);
  const seenCity = byCity.get(key);
  if (!seenCity || row.population > seenCity.population) byCity.set(key, row);
}

/**
 * Finds a place by label. Case-insensitive; tolerant of "Saint"/"St.", "Mount"/"Mt.", "Fort"/"Ft.",
 * accents, periods, full state names ("Portland, Maine"), a missing comma ("Washington DC") and a
 * missing state ("Asheville" -> the most populous Asheville). A state that is given but does not
 * match returns undefined rather than guessing another state: "Portland, ME" never returns Oregon.
 */
export function findPlace(label: string): PlaceRow | undefined {
  const parts = label
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const city = cityKey(parts[0]);
  if (!city) return undefined;

  // "Asheville, NC" / "Asheville, North Carolina" / "Asheville, NC 28801" (first token wins).
  if (parts.length > 1) {
    const state = toStateCode(parts[1]) ?? toStateCode(parts[1].split(/\s+/)[0]);
    if (state) return byLabel.get(`${city}|${state}`);
    return byCity.get(city); // unrecognized second part ("USA"): fall back to the city alone
  }

  // No comma: "washington dc" or "portland oregon" may still end in a state.
  for (const name of STATE_NAMES_BY_LENGTH) {
    if (city.endsWith(" " + name)) {
      const hit = byLabel.get(`${city.slice(0, -name.length - 1)}|${STATE_CODES[name]}`);
      if (hit) return hit;
    }
  }
  const lastWord = city.slice(city.lastIndexOf(" ") + 1);
  if (lastWord.length === 2 && city.length > 3 && STATE_SET.has(lastWord.toUpperCase())) {
    const hit = byLabel.get(`${city.slice(0, -3)}|${lastWord.toUpperCase()}`);
    if (hit) return hit;
  }
  return byCity.get(city);
}

/** Every row in the table (a copy, so callers can sort or filter freely). */
export function allPlaces(): PlaceRow[] {
  return [...ROWS];
}
