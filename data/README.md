# Data files

| File | What it is | Who writes it |
| --- | --- | --- |
| `us-places.json` | US places with population >= 5,000: `{ label, name, state, population, lat, lon }` | `scripts/build-places.mjs` (this page) |
| `scenarios/hollow-pines.json` | The one-click sample: a fictional band, real comps, the markets and cities the demo covers | hand-maintained |
| `obvious-route.json` | The usual-suspects streaming markets for the "obvious route" comparison | hand-maintained |
| `tags.json` | Qloo place-tag ids per promo/venue group | `scripts/verify.mjs` rewrites it from the real API |

## us-places.json

Why it exists: Qloo ranks localities by taste affinity but says nothing about how big they are or where
they sit on a map. The app joins Qloo's "City, ST" locality names to this table to flag over-index towns
(high affinity, population under 250,000) and to draw the route. `src/places.ts` imports it statically so
the Cloudflare Worker bundles it; `findPlace("Saint Louis, MO")` is the lookup.

**Built on 2026-10-10** with `node scripts/build-places.mjs` (about 3 seconds; downloads with curl, caches
nothing). Result: 6,750 rows, 710 KB. Every number in the file comes from the US Census Bureau:

| Source | Exact URL | Used for |
| --- | --- | --- |
| 2020 Gazetteer, places | https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_place_national.zip | GEOID, name, state (`USPS`), LSAD, internal-point `INTPTLAT`/`INTPTLONG` for all 31,909 places |
| Population estimates, cities and towns (vintage 2023) | https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv | `ESTIMATESBASE2020` (the 2020 Census count on current boundaries) for incorporated places, `SUMLEV=162`, joined on `STATE+PLACE` = GEOID; `SUMLEV=050` county rows for the NYC boroughs |
| TIGERweb, 2020 Census "Census Designated Places" layer | https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/28/query?where=POP100%3E%3D5000&outFields=GEOID%2CPOP100&returnGeometry=false&f=json | `POP100` (the 2020 Census count) for CDPs, which the estimates file does not cover |
| 2020 Gazetteer, counties | https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_counties_national.zip | Coordinates for the five NYC boroughs (they are counties, not places) |

Rules applied:

- Keep places with population >= 5,000. Round `lat`/`lon` to 4 decimals (about 11 m). No other fields.
- `label` is `"<name>, <ST>"`. `name` is the Gazetteer name with its legal/statistical description removed
  according to the Gazetteer's own `LSAD` column (`Asheville city` -> `Asheville`, `Carrboro town` ->
  `Carrboro`, `Arlington CDP` -> `Arlington`). Massachusetts towns listed as `Amherst Town city` become
  `Amherst`; a trailing parenthetical is dropped (`Fredonia (Biscoe)` -> `Fredonia`).
- 18 consolidated or oddly named places are renamed by GEOID in `NAME_OVERRIDES` in the script, so people
  can type what they say: `Louisville/Jefferson County metro government (balance)` -> `Louisville, KY`,
  `Nashville-Davidson metropolitan government (balance)` -> `Nashville, TN`, `Athens-Clarke County unified
  government (balance)` -> `Athens, GA`, `Lexington-Fayette urban county` -> `Lexington, KY`,
  `Urban Honolulu CDP` -> `Honolulu, HI`, `Boise City city` -> `Boise, ID`, `Indianapolis city (balance)`
  -> `Indianapolis, IN`, `San Buenaventura (Ventura) city` -> `Ventura, CA`, and so on.
- Census spellings are kept otherwise: `St. Louis, MO`, `St. Paul, MN`, `Fort Collins, CO`,
  `Mount Pleasant, MI`, `Cañon City, CO`. `findPlace()` accepts `Saint Louis`, `Ft. Collins`, `Mt.`,
  accent-free and case-insensitive input, full state names, and no state at all (then the most populous
  match wins, so `Portland` is Oregon and `Washington` is DC).
- 12 labels occurred twice within a state after cleaning (two different CDPs called `Kailua, HI`, for
  example). The larger place is kept; the script prints each one.
- `Washington, DC` comes straight from the sources (GEOID 1150000, `Washington city`, 689,548).
- Manual rows: the five New York City boroughs, which Qloo and people name as places but the Census does
  not. `Brooklyn, NY`, `Manhattan, NY`, `Queens, NY`, `Bronx, NY` and `Staten Island, NY` take their
  population from the `sub-est2023.csv` county rows (Kings, New York, Queens, Bronx and Richmond
  County) and their coordinates from the county Gazetteer. No number in the file is typed by hand.

Checked at build time and again in `tests/places.test.ts`: every locality in
`scenarios/hollow-pines.json`, its home city, every `obvious-route.json` city, and the aliases judges
are likely to type (`Washington, DC`, `Brooklyn, NY`, `Carrboro, NC`, `Athens, OH`, `Northampton, MA`,
`Hudson, NY`, `Saint Louis, MO` / `St. Louis, MO`) resolve through `findPlace()`.

Known limits: Puerto Rico appears only through its CDPs (its municipios are not places). Places that
incorporated after the 2020 Census (six of them, like Cahokia Heights, IL) have no Gazetteer row and are
left out. The Census data API (`api.census.gov/data/2020/dec/pl`) would be the one-call way to get every
place's 2020 count, but as of 2026-10-10 it refuses requests without an API key, so the script uses the
two key-free files above instead; both report the same 2020 Census count.
