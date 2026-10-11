// data/us-places.json is the join table behind over-index towns and map pins. These tests pin down
// the two things the app relies on: the sample scenario's cities all resolve with coordinates, and
// findPlace() tolerates the spellings people and Qloo actually use.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { findPlace, allPlaces, cityKey, type PlaceRow } from "../src/places.ts";

const read = (rel: string) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const scenario = read("../data/scenarios/hollow-pines.json");
const obvious = read("../data/obvious-route.json");

function assertResolves(label: string): PlaceRow {
  const row = findPlace(label);
  assert.ok(row, `${label} should resolve`);
  assert.ok(row.population >= 5000, `${label}: population ${row.population}`);
  assert.ok(row.lat > 17 && row.lat < 72, `${label}: lat ${row.lat}`); // Puerto Rico to Alaska
  assert.ok(row.lon > -180 && row.lon < -64, `${label}: lon ${row.lon}`);
  return row;
}

test("the table is small enough to bundle and every row has the contract shape", () => {
  const bytes = fs.statSync(new URL("../data/us-places.json", import.meta.url)).size;
  assert.ok(bytes < 1024 * 1024, `data/us-places.json is ${bytes} bytes; must stay under 1 MB`);

  const rows = allPlaces();
  assert.ok(rows.length > 6000, `expected thousands of rows, got ${rows.length}`);
  const labels = new Set<string>();
  for (const r of rows) {
    assert.equal(r.label, `${r.name}, ${r.state}`);
    assert.match(r.state, /^[A-Z]{2}$/);
    assert.ok(Number.isInteger(r.population) && r.population >= 5000, `${r.label}: population ${r.population}`);
    assert.equal(r.lat, Number(r.lat.toFixed(4)), `${r.label}: lat not rounded to 4 decimals`);
    assert.equal(r.lon, Number(r.lon.toFixed(4)), `${r.label}: lon not rounded to 4 decimals`);
    assert.ok(!labels.has(r.label), `duplicate label ${r.label}`);
    labels.add(r.label);
  }
});

test("allPlaces returns a copy, so callers cannot corrupt the index", () => {
  const a = allPlaces();
  a.length = 0;
  assert.ok(allPlaces().length > 6000);
});

test("every Hollow Pines locality and the home city resolve with coordinates", () => {
  const labels: string[] = [scenario.request.home, ...scenario.localities.map((l: { label: string }) => l.label)];
  for (const label of labels) {
    const row = assertResolves(label);
    // The label in the scenario and the row it resolves to must agree on the state.
    assert.equal(row.state, label.slice(-2), `${label} resolved to ${row.label}`);
  }
});

test("every usual-suspect city in the obvious route resolves", () => {
  for (const label of obvious.cities) assertResolves(label);
});

test("populations support the over-index rule (towns under 250k vs big markets)", () => {
  assert.ok(assertResolves("Asheville, NC").population < 250_000);
  assert.ok(assertResolves("Carrboro, NC").population < 250_000);
  assert.ok(assertResolves("Philadelphia, PA").population > 1_000_000);
  assert.ok(assertResolves("Brooklyn, NY").population > 2_000_000);
  assert.ok(assertResolves("Washington, DC").population > 600_000);
});

test("Saint/St., case and punctuation all find the same row", () => {
  const canonical = assertResolves("Saint Louis, MO");
  assert.equal(canonical.label, "St. Louis, MO"); // the table keeps the Census spelling
  for (const variant of ["St. Louis, MO", "st louis, mo", "ST. LOUIS, MO", "Saint Louis, Missouri", "St Louis MO"]) {
    assert.equal(findPlace(variant)?.label, canonical.label, variant);
  }
  assert.equal(findPlace("St. Paul, MN")?.label, "St. Paul, MN");
  assert.equal(findPlace("Saint Paul, MN")?.label, "St. Paul, MN");
  assert.equal(findPlace("Ft. Collins, CO")?.label, "Fort Collins, CO");
  assert.equal(findPlace("Mt. Pleasant, MI")?.label, "Mount Pleasant, MI");
  assert.equal(findPlace("Canon City, CO")?.label, "Cañon City, CO"); // accents are optional
  assert.equal(findPlace("winston salem, nc")?.label, "Winston-Salem, NC"); // so are hyphens
});

test("Washington, DC resolves however it is written", () => {
  for (const variant of ["Washington, DC", "washington dc", "Washington, D.C.", "Washington D.C.", "Washington, District of Columbia"]) {
    assert.equal(findPlace(variant)?.label, "Washington, DC", variant);
  }
  // No state at all: the most populous Washington is the capital, not Washington, PA or IL.
  assert.equal(findPlace("Washington")?.label, "Washington, DC");
});

test("places the Census names differently are reachable by their common names", () => {
  const expected: Record<string, string> = {
    "Brooklyn, NY": "Brooklyn, NY",
    "Manhattan, NY": "Manhattan, NY",
    "Queens, NY": "Queens, NY",
    "New York City, NY": "New York, NY",
    "NYC": "New York, NY",
    "Nashville, TN": "Nashville, TN", // Nashville-Davidson metropolitan government (balance)
    "Louisville, KY": "Louisville, KY", // Louisville/Jefferson County metro government (balance)
    "Lexington, KY": "Lexington, KY", // Lexington-Fayette urban county
    "Athens, GA": "Athens, GA", // Athens-Clarke County unified government (balance)
    "Indianapolis, IN": "Indianapolis, IN", // Indianapolis city (balance)
    "Honolulu, HI": "Honolulu, HI", // Urban Honolulu CDP
    "Boise, ID": "Boise, ID", // Boise City city
    "Ventura, CA": "Ventura, CA", // San Buenaventura (Ventura) city
    "Amherst, MA": "Amherst, MA", // Amherst Town city
    "Arlington, VA": "Arlington, VA", // a CDP, absent from the city estimates file
    "Carson City, NV": "Carson City, NV", // no LSAD suffix; "City" is part of the name
    "Kansas City, MO": "Kansas City, MO",
    "Old Town, ME": "Old Town, ME", // "Town" is part of the name outside Massachusetts
  };
  for (const [input, label] of Object.entries(expected)) assert.equal(findPlace(input)?.label, label, input);
});

test("a missing state picks the most populous match; a wrong state never guesses", () => {
  assert.equal(findPlace("Portland")?.label, "Portland, OR");
  assert.equal(findPlace("Portland, ME")?.label, "Portland, ME");
  assert.equal(findPlace("Portland, Maine")?.label, "Portland, ME");
  assert.equal(findPlace("portland oregon")?.label, "Portland, OR");
  assert.equal(findPlace("Athens")?.label, "Athens, GA");
  assert.equal(findPlace("Athens, OH")?.label, "Athens, OH");
  assert.equal(findPlace("Asheville")?.label, "Asheville, NC");
  assert.equal(findPlace("Asheville, NC 28801")?.label, "Asheville, NC");
  assert.equal(findPlace("Asheville, USA")?.label, "Asheville, NC"); // unrecognized state is ignored
  assert.equal(findPlace("Asheville, TX"), undefined); // recognized but wrong state: no guess
  assert.equal(findPlace("Charleston West Virginia")?.label, "Charleston, WV");
  assert.equal(findPlace("Charleston, SC")?.label, "Charleston, SC");
  assert.equal(findPlace("Nowhere, ZZ"), undefined);
  assert.equal(findPlace("Atlantis"), undefined);
  assert.equal(findPlace(""), undefined);
  assert.equal(findPlace(" , "), undefined);
});

test("cityKey is the shared normalizer", () => {
  assert.equal(cityKey("St. Louis"), "saint louis");
  assert.equal(cityKey("Saint Louis"), "saint louis");
  assert.equal(cityKey("  Ft. Wayne "), "fort wayne");
  assert.equal(cityKey("Coeur d'Alene"), "coeur dalene");
  assert.equal(cityKey("Cañon City"), "canon city");
});
