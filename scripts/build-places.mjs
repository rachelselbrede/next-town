// Builds data/us-places.json: every US incorporated place and Census-designated place (CDP) with a
// 2020 population of 5,000 or more, as { label: "Asheville, NC", name, state, population, lat, lon }.
// The app joins Qloo's locality names to this table for population (over-index towns) and map pins.
//
//   node scripts/build-places.mjs
//
// Everything comes from the US Census Bureau and is downloaded with curl while the script runs; nothing
// is cached on disk. The exact URLs and the day the committed file was built are in data/README.md.
//   1. 2020 Gazetteer place file ........ GEOID, name, state and internal-point lat/lon for every place
//   2. sub-est2023.csv ................... ESTIMATESBASE2020 (the 2020 Census count) for incorporated
//                                          places (SUMLEV 162) and for counties (SUMLEV 050, used for
//                                          the five New York City boroughs)
//   3. TIGERweb Census2020 CDP layer ..... POP100 (the 2020 Census count) for CDPs, which the estimates
//                                          file does not cover and the data API now needs a key for
//   4. 2020 Gazetteer county file ........ lat/lon for the boroughs, which are counties, not places

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = path.join(ROOT, "data", "us-places.json");
const MIN_POPULATION = 5000;
const MAX_FILE_BYTES = 1024 * 1024; // the Worker bundles this file, so keep it small

const GAZETTEER_PLACES = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_place_national.zip";
const GAZETTEER_COUNTIES = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_counties_national.zip";
const SUB_EST = "https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv";
const TIGERWEB_CDP =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/28/query?" +
  new URLSearchParams({ where: `POP100>=${MIN_POPULATION}`, outFields: "GEOID,POP100", returnGeometry: "false", f: "json" });

// ---- Name cleaning -------------------------------------------------------------------------------

// The Gazetteer appends a legal/statistical area description to every name ("Asheville city",
// "Carrboro town", "Arlington CDP") and says which one in its LSAD column. Strip exactly that.
const LSAD_SUFFIX = {
  25: "city",
  43: "town",
  47: "village",
  21: "borough",
  57: "CDP",
  55: "comunidad", // Puerto Rico
  62: "zona urbana", // Puerto Rico
  37: "municipality",
  53: "city and borough", // Alaska
  35: "metro township", // Utah
  UG: "unified government",
  UC: "urban county",
  MG: "metropolitan government",
  CN: "corporation",
  CG: "consolidated government",
  // "00" means no description; those names are either plain ("Carson City") or consolidated
  // city-counties handled by NAME_OVERRIDES below.
};

// Places whose official Census name is not what anyone types, keyed by GEOID. The comment is the
// Gazetteer name. Most are consolidated city-county governments.
const NAME_OVERRIDES = {
  "0622300": "Paso Robles", // El Paso de Robles (Paso Robles) city, CA
  "0665042": "Ventura", // San Buenaventura (Ventura) city, CA
  "0947515": "Milford", // Milford city (balance), CT
  "1234132": "Islamorada", // Islamorada, Village of Islands village, FL
  "1303440": "Athens", // Athens-Clarke County unified government (balance), GA
  "1304204": "Augusta", // Augusta-Richmond County consolidated government (balance), GA
  "1321017": "Cusseta", // Cusseta-Chattahoochee County unified government, GA
  "1349008": "Macon", // Macon-Bibb County, GA
  "1571550": "Honolulu", // Urban Honolulu CDP, HI
  "1608830": "Boise", // Boise City city, ID
  "1836003": "Indianapolis", // Indianapolis city (balance), IN
  "2146027": "Lexington", // Lexington-Fayette urban county, KY
  "2148006": "Louisville", // Louisville/Jefferson County metro government (balance), KY
  "3001675": "Anaconda", // Anaconda-Deer Lodge County, MT
  "3011397": "Butte", // Butte-Silver Bow (balance), MT
  "4732742": "Hartsville", // Hartsville/Trousdale County, TN
  "4744382": "Lynchburg", // Lynchburg, Moore County metropolitan government, TN
  "4752006": "Nashville", // Nashville-Davidson metropolitan government (balance), TN
};

function cleanName(geoid, rawName, lsad, state) {
  if (NAME_OVERRIDES[geoid]) return NAME_OVERRIDES[geoid];
  let name = rawName;
  const suffix = LSAD_SUFFIX[lsad];
  if (suffix && name.endsWith(" " + suffix)) name = name.slice(0, -suffix.length - 1);
  // Massachusetts towns with a city form of government are listed as "Amherst Town city".
  if (state === "MA" && name.endsWith(" Town")) name = name.slice(0, -5);
  // "Fredonia (Biscoe)" -> "Fredonia". The two California places whose common name is the one in
  // parentheses (Ventura, Paso Robles) are in NAME_OVERRIDES.
  name = name.replace(/\s*\([^)]*\)$/, "");
  return name.trim();
}

// ---- New York City boroughs ----------------------------------------------------------------------

// Qloo and people say "Brooklyn, NY"; the Census has one place, "New York city", and five counties.
// Each borough row takes its population and coordinates from the county with that GEOID.
const BOROUGHS = {
  36005: "Bronx",
  36047: "Brooklyn", // Kings County
  36061: "Manhattan", // New York County
  36081: "Queens",
  36085: "Staten Island", // Richmond County
};

// ---- Download and parse helpers ------------------------------------------------------------------

function download(url) {
  console.log(`  GET ${url}`);
  return execFileSync("curl", ["--silent", "--show-error", "--fail", "--location", "--retry", "3", "--max-time", "300", url], {
    maxBuffer: 256 * 1024 * 1024,
  });
}

// Node has no zip module. Each Gazetteer zip holds one text file, so this reads the central directory
// (the index at the end of every zip), finds that entry, and inflates it.
function unzipSingleFile(zip) {
  let eocd = -1; // end-of-central-directory record, signature 0x06054b50, within the last 64 KB
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");
  const entry = zip.readUInt32LE(eocd + 16); // offset of the first central directory header (0x02014b50)
  if (zip.readUInt32LE(entry) !== 0x02014b50) throw new Error("zip central directory not found");
  const method = zip.readUInt16LE(entry + 10);
  const compressedSize = zip.readUInt32LE(entry + 20);
  const localHeader = zip.readUInt32LE(entry + 42);
  // The local header (0x04034b50) repeats the name and extra fields; the data follows them.
  const dataStart = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
  const data = zip.subarray(dataStart, dataStart + compressedSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${method}`);
}

// Gazetteer files are tab-separated with a header row (the last header has trailing spaces).
function parseGazetteer(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Gazetteer column ${name} missing; header was ${header.join(",")}`);
    return i;
  };
  const [iUsps, iGeoid, iName, iLat, iLon] = ["USPS", "GEOID", "NAME", "INTPTLAT", "INTPTLONG"].map(col);
  const iLsad = header.indexOf("LSAD"); // the county file has no LSAD column
  const rows = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    rows.set(c[iGeoid], {
      state: c[iUsps],
      name: c[iName].trim(),
      lsad: iLsad >= 0 ? c[iLsad].trim() : "",
      lat: Number(c[iLat]),
      lon: Number(c[iLon]),
    });
  }
  return rows;
}

// Only the NAME column of sub-est2023.csv is ever quoted ("Islamorada, Village of Islands village").
function parseCsvLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (fields.push(field), (field = ""));
    else field += ch;
  }
  fields.push(field);
  return fields;
}

// Returns { places: Map<7-digit GEOID, population>, counties: Map<5-digit GEOID, population> }.
function parseSubEst(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = parseCsvLine(lines[0]);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`sub-est column ${name} missing; header was ${header.join(",")}`);
    return i;
  };
  const [iSumlev, iState, iCounty, iPlace, iPop] = ["SUMLEV", "STATE", "COUNTY", "PLACE", "ESTIMATESBASE2020"].map(col);
  const places = new Map();
  const counties = new Map();
  for (const line of lines.slice(1)) {
    const c = parseCsvLine(line);
    if (c[iSumlev] === "162") places.set(c[iState] + c[iPlace], Number(c[iPop]));
    else if (c[iSumlev] === "050") counties.set(c[iState] + c[iCounty], Number(c[iPop]));
  }
  return { places, counties };
}

function parseTigerwebCdps(json) {
  const body = JSON.parse(json);
  if (body.error) throw new Error(`TIGERweb error: ${JSON.stringify(body.error)}`);
  if (body.exceededTransferLimit) throw new Error("TIGERweb truncated the CDP list; add paging");
  return new Map(body.features.map((f) => [f.attributes.GEOID, f.attributes.POP100]));
}

const round4 = (n) => Number(n.toFixed(4));

// ---- Build ---------------------------------------------------------------------------------------

console.log("Downloading Census sources...");
const gazPlaces = parseGazetteer(unzipSingleFile(download(GAZETTEER_PLACES)).toString("utf8"));
const gazCounties = parseGazetteer(unzipSingleFile(download(GAZETTEER_COUNTIES)).toString("utf8"));
const subEst = parseSubEst(download(SUB_EST).toString("latin1")); // the estimates file is ISO-8859-1
const cdpPop = parseTigerwebCdps(download(TIGERWEB_CDP).toString("utf8"));

const counts = { incorporated: 0, cdp: 0, borough: 0, duplicates: 0 };
const byLabel = new Map();
function add(row, kind) {
  const prev = byLabel.get(row.label);
  if (prev) {
    // Same cleaned name twice in one state (rare). Keep the larger place and say so.
    counts.duplicates++;
    console.log(`  duplicate label ${row.label}: kept ${Math.max(prev.population, row.population)}, dropped ${Math.min(prev.population, row.population)}`);
    if (row.population <= prev.population) return;
  } else {
    counts[kind]++;
  }
  byLabel.set(row.label, row);
}

for (const [geoid, g] of gazPlaces) {
  // The estimates file wins for incorporated places; CDPs come from TIGERweb.
  const fromEstimates = subEst.places.get(geoid);
  const population = fromEstimates ?? cdpPop.get(geoid);
  if (population === undefined || population < MIN_POPULATION) continue;
  const name = cleanName(geoid, g.name, g.lsad, g.state);
  add({ label: `${name}, ${g.state}`, name, state: g.state, population, lat: round4(g.lat), lon: round4(g.lon) }, fromEstimates !== undefined ? "incorporated" : "cdp");
}

for (const [geoid, name] of Object.entries(BOROUGHS)) {
  const county = gazCounties.get(geoid);
  const population = subEst.counties.get(geoid);
  if (!county || population === undefined) throw new Error(`borough ${name}: county ${geoid} missing from a source`);
  add({ label: `${name}, NY`, name, state: "NY", population, lat: round4(county.lat), lon: round4(county.lon) }, "borough");
}

// Sort by state then name so the file reads like an atlas index and diffs stay small.
const rows = [...byLabel.values()].sort((a, b) => (a.state < b.state ? -1 : a.state > b.state ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const text = "[\n" + rows.map((r) => JSON.stringify(r)).join(",\n") + "\n]\n";
if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`data/us-places.json would be ${Buffer.byteLength(text)} bytes; the limit is ${MAX_FILE_BYTES}`);
fs.writeFileSync(OUT, text);
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${rows.length} rows (${counts.incorporated} incorporated places, ${counts.cdp} CDPs, ${counts.borough} NYC boroughs; ${counts.duplicates} duplicate labels merged), ${Math.round(Buffer.byteLength(text) / 1024)} KB`);

// ---- Self-check: everything the sample scenario and the obvious-route list name must resolve -----
// Imported after the file is written (the module loads the JSON statically) so this also exercises
// the real lookup code, including the "Saint Louis" / "St. Louis" tolerance.
const { findPlace } = await import("../src/places.ts");
const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, "data/scenarios/hollow-pines.json"), "utf8"));
const obvious = JSON.parse(fs.readFileSync(path.join(ROOT, "data/obvious-route.json"), "utf8"));
const mustResolve = [
  "Washington, DC", "Brooklyn, NY", "Carrboro, NC", "Athens, OH", "Northampton, MA", "Hudson, NY", "Saint Louis, MO", "St. Louis, MO",
  scenario.request.home,
  ...scenario.localities.map((l) => l.label),
  ...obvious.cities,
];
const unresolved = mustResolve.filter((label) => !findPlace(label));
if (unresolved.length) throw new Error(`these labels do not resolve: ${unresolved.join("; ")}`);
console.log(`Self-check passed: ${mustResolve.length} required labels resolve.`);
