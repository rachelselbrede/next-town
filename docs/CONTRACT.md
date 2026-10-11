# Next Town: build contract

Read this before touching any file. It defines what every module owns, the shapes they exchange, and the rules that keep the demo deterministic. `src/types.ts`, `src/queries.ts`, `src/canonical.ts`, `src/qloo.ts`, `src/agent.ts`, `src/sse.ts` are the backbone and are already written; do not change their exported signatures. Add exports if you must, never rename or remove.

## Product in one paragraph

Next Town is a tour-routing agent for independent acts. The user says who they sound like (1-3 comparable artists), their home city, days available, and max drive hours per day. The agent resolves the comps in Qloo, asks Qloo for the US localities where that taste-audience ranks highest, flags over-index towns (high affinity, population under 250k), and plans an editable loop. Beside it sits the "obvious route" of big streaming markets so the difference is visible. Clicking a stop builds a one-page playbook from Qloo: rooms fans love, promo partners (record store, coffee, bookstore, dive bar, vintage), who shows up (age bands from Qloo demographics), and local color (brands and TV shows this market's fans love more than the home market's). Every item has "because ..." explainability chips and a Receipts drawer lists every Qloo call with its exact URL. "Build my tour" produces printable advance sheets and a booking-agent pitch. One-click sample: the fictional band Hollow Pines (Richmond, VA; comps Big Thief, Waxahatchee, Adrianne Lenker; 12 days; 6-hour cap).

Tone: warm, plain, honest. Never claim capacity, age policy, ticket sales, or anything about an individual person. Qloo results are aggregate taste affinities. Say "fans of your comps in this area" not "people in Asheville".

## Stack and runtime

- Cloudflare Worker (`src/index.ts`) with static assets in `public/`. Also runs under Node via `scripts/dev-node.mjs` (same handler), which is how we test locally with Anthropic credentials from an `ant auth login` profile. TypeScript everywhere in `src/`; plain ES modules in `public/js/` (no bundler, no framework). Node 26 runs `.ts` directly (`node --test tests/*.test.ts`, `node scripts/x.mjs` importing `.ts`).
- Claude via `@anthropic-ai/sdk` (model from `env.MODEL`, default `claude-opus-5-5`) through `runAgent()` in `src/agent.ts` (streaming tool loop). Structured outputs via `client.messages.parse` with `output_config.format` are allowed for one-shot copy generation.
- Qloo via `QlooClient` in `src/qloo.ts`. Demo mode is automatic when `QLOO_API_KEY` is absent; it answers from `fixtures/qloo/` through `src/demo/resolver.ts`.
- Leaflet 1.9.4 from `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js` and `.css`; tiles from CARTO light (`https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png`, attribution required). No other external scripts.
- Fonts: Google Fonts Fredoka (headings) and Nunito (body), like Rachel's other apps. Light and dark via `prefers-color-scheme`. Phone-width must work (one column).

## Determinism rules (the demo must never break)

1. Claude never writes a Qloo URL. Tools take small inputs (comp ids, a city label, a type) and compose params with the builders in `src/queries.ts`. `canonicalUrl()` from `src/canonical.ts` is the fixture key and the cache key.
2. `fixtures/qloo/index.json` maps canonical URL -> file. `scripts/scaffold-fixtures.mjs` already generated every skeleton the Hollow Pines scenario needs. Fixture file shape:
   ```json
   { "_handAuthored": true, "_captured": null, "tool": "find_rooms", "canonical": "<url>", "query": { "path": "/v2/insights", "params": {...} }, "response": { "success": true, "results": { "entities": [ ... ] } } }
   ```
   Demographics fixtures use `"results": { "demographics": [ { "entity_id": "<comp id>", "query": { "age": { "24_and_younger": 0.31, "25_to_29": 0.44, "30_to_34": 0.52, "35_to_44": 0.38, "45_to_54": 0.12, "55_and_older": -0.2 }, "gender": { "female": 0.22, "male": -0.1 } } } ] }` (one entry per comp id; values are affinities, may be negative).
3. Entity shape inside `results.entities` (follow the Qloo reference): `entity_id` (UUID string), `name`, `type` (`urn:entity:place` etc.), `subtype` (`urn:entity:place:music_venue`, `urn:entity:place:record_store`, `urn:entity:brand`, `urn:entity:tv_show`, `urn:entity:locality` ...), `popularity` (0..1), `properties` { `image: { url }`, `description`, `address`, `geocode: { name, city, admin1_region, country_code }`, `business_rating` (1-5), `price_level` (1-4), `phone`, `website` }, `tags: [ { "name": "Music Venue", "tag_id": "urn:tag:genre:place:music_venue", "type": "urn:tag:genre:place" } ]`, `query: { "affinity": 0.87, "explainability": { "by_entity": { "<comp id>": { "name": "Big Thief", "score": 0.71 } } } }`. Localities add `location: { lat, lon }`.
4. Recorded scenario replay: `fixtures/scenarios/hollow-pines/plan.jsonl` (one JSON event per line, exactly what `/api/plan` streamed on a live run), `city-<slug>.json` (the full `playbook` event payload per city), `pitch.json`. When the server is not in live-Claude mode (no `ANTHROPIC_API_KEY` and no local profile) or the request has `scenarioId` and `recorded=true`, `/api/plan` replays `plan.jsonl` with a 250-600 ms cadence per event (`?fast=1` disables the delay). These files are produced by `scripts/record.mjs`, which runs the real agent against fixtures (or live Qloo) and saves the stream.
5. Custom inputs (not the sample) require Claude. If Claude is unavailable, `/api/plan` returns 503 with `{ error: "Live mode needs an Anthropic key; try the sample." }`.

## HTTP API (owned by `src/index.ts`, `src/app.ts`, `src/city.ts`, `src/pitch.ts`, `src/recorded.ts`)

- `GET /api/health` -> `{ ok, qloo: "live"|"demo", model, claude: boolean, recorded: boolean }`
- `POST /api/plan` body `PlanRequest` (+ optional `recorded: boolean`) -> SSE. Event order for a successful run: `meta`, then agent events (`turn`, `thinking`, `text`, `tool_call`, `tool_result`), with `comps` after resolve_act results, `receipt` after every Qloo call, `markets` after rank_markets, `route` after plan_route, `done` at the end (`done.text` is the agent's closing narration). Errors: `error`.
- `POST /api/city` body `{ city: string, home: string, comps: Comp[], locality?: Locality, scenarioId?: string }` -> SSE: `meta`, `status` lines ("Asking Qloo which rooms fans of your comps love..."), `receipt` per Qloo call, then one `playbook` event, then `done`. Qloo calls run in parallel. Card copy comes from one Claude structured-output call (`CardCopy` schema); if Claude is unavailable, fall back to templated copy built from the data (never leave the card empty).
- `POST /api/pitch` body `{ route: Route, playbooks: Playbook[], comps: Comp[], home: string, obvious: ObviousRoute }` -> JSON `Pitch`. One Claude call; template fallback.
- Static files otherwise.

Agent events are defined in `src/agent.ts` (`AgentEvent`); app events in `src/types.ts` (`AppEvent`). `tool_result.data` for Qloo-backed tools includes `qloo: Receipt | Receipt[]` so the trace panel can show the request (see `public/js/trace.js`).

## Tools exposed to Claude in `/api/plan` (owned by `src/tools.ts`)

Each is a `ToolDef` from `src/agent.ts` with `strict`-compatible JSON schema (`additionalProperties: false`, `required` lists every property).

- `resolve_act({ name })` -> `{ candidates: Comp[], qloo: Receipt }` using `searchAct` (format from the request). Keep only matching entity types; max 3 candidates. Emits `comps` event via `ctx.emit` once the agent has resolved all comps (the tool may emit `comps` with the running list each time).
- `rank_markets({ compIds: string[] })` -> `{ localities: Locality[], qloo: Receipt, summary }` using `rankMarkets`; joins `data/us-places.json` by `label` (case-insensitive "City, ST") for population and lat/lon; computes `overIndex`; emits `markets`.
- `plan_route({ days, driveHoursCap, mustInclude?: string[], exclude?: string[] })` -> `{ route: Route, obvious: ObviousRoute, summary }` using `src/routing.ts`; emits `route`. No Qloo call. Uses the localities from the last `rank_markets` result (kept in the tool context closure) and the home city coordinates from `data/us-places.json`.
- The system prompt (in `src/app.ts`) tells Claude: resolve each comp (one call per comp, pick the best candidate by name match then popularity), then rank markets, then plan the route, narrating briefly in between with two or three specific observations (name an over-index town and where a usual-suspect city landed), and finish with one short paragraph. Max 8 turns. Effort "medium".

## City playbook (owned by `src/city.ts`)

Runs in parallel: `findRooms`, `findPromoPartners`, `whoShowsUp`, `localColor(brand)`, `localColor(tv_show)` for the city, plus the two `localColor` calls for the home city (cache by canonical URL within the request; the home pair is identical across cities). Normalize with `normalizeAll`. Promo groups: assign each place to a `PROMO_KIND_LABEL` group by its subtype or tags (fallback: round-robin so every group has up to 2). Demographics: average age/gender across comps, pick the strongest positive band, derive 1-3 suggestions phrased as suggestions. Local color: for each city item in the top 20, `homeAffinity` is the home affinity for the same `entity_id` or `null`; `delta = city - home` or `null`; sort by delta desc with nulls after, keep top 5 per type. Card copy via Claude structured output with a system prompt that forbids any claim not traceable to the returned data. Fallback copy is templated.

## Routing (owned by `src/routing.ts`, tested in `tests/routing.test.ts`)

Haversine miles; hours = miles / 55. Candidates: localities with coordinates, ranked. Build a loop from home: greedily add the next nearest candidate among the top over-index towns first (then the rest), respecting `driveHoursCap` per leg where possible; one 2-opt improvement pass; then return home. A leg over the cap becomes a drive day (no show). Stops = `days - driveDays`, minimum 3. `mustInclude` are forced in; `exclude` removed. Notes: list every judgment call ("Skipped Burlington, VT: 11 hours from Pittsburgh would cost a drive day."). `ObviousRoute` from `data/obvious-route.json`: `overlap` = stops whose label is in the list; `smallTowns` = stops with overIndex; summary like "Overlap with the usual suspects: 2 of 9 stops. 7 of your stops are towns under 250k where your affinity rank is top 20."

## Data (owned by `scripts/build-places.mjs`, output `data/us-places.json`)

Array of `{ label: "Asheville, NC", name, state, population, lat, lon }` for US incorporated places and Census-designated places with population >= 5,000 (about 7-8k rows; keep the file under 1 MB by rounding lat/lon to 4 decimals and omitting extras). Sources: Census 2020 Gazetteer place file (lat/lon, GEOID) and Census population estimates `sub-est2023.csv` (`ESTIMATESBASE2020` / `CENSUS2020POP` by `SUMLEV=162` and GEOID), or the 2020 DEC API. Record the exact source URLs and date in `data/README.md`. Include DC as "Washington, DC". Add well-known aliases where Census names differ (e.g. "Carrboro, NC" is a town, "Brooklyn, NY" is a borough: add it manually with its population and coordinates, noting the source).

## Frontend (owned by `public/`)

Files: `index.html`, `styles.css`, `print.css`, `js/app.js` (state machine and wiring), `js/stream.js` (exists), `js/trace.js` (exists; Agent log), `js/map.js` (Leaflet), `js/route.js` (route rail, obvious toggle, pin/drop), `js/playbook.js` (city cards), `js/tour.js` (itinerary, pitch, print), `js/receipts.js` (drawer). Screens are sections toggled by `data-screen`: `landing`, `route`, `playbook`, `tour`. State in a single `state` object in `app.js`: `{ request, comps, localities, route, obvious, playbooks: {}, receipts: [], pinned: [], dropped: [], meta }`, persisted to `localStorage` under `nexttown.v1`. Re-routing after pin/drop calls `POST /api/plan`? No: it is local. `public/js/routing.js` is a plain-JS copy of the routing algorithm (keep the two in sync; tests cover the TS one) so pin/drop re-routes instantly in the browser.

UX rules: one click from landing to a running route; the agent log streams on the left (desktop) or above the map (phone); "skip ahead" button in recorded mode calls `/api/plan?fast=1` and replays instantly; mode pill always visible ("Live: Qloo + Claude", "Recorded demo (pre-key placeholder)" or "Recorded demo (captured <date>)"); every card has "Show the query"; Receipts drawer slides from the right; print CSS makes one page per stop. Fictional label on the sample. Accessible: buttons are buttons, focus visible, aria-live on the log.

## Scripts (owned by `scripts/`)

- `scripts/verify.mjs`: with `QLOO_API_KEY` set, runs each query shape once (search, tags for every group term, rank_markets, rooms, promo, demographics, brand, tv_show, openers) for the Hollow Pines comps and Asheville; prints status, result count, first entity's field names, explainability shape, and whether `urn:entity:locality` and `urn:demographics` work; rewrites `data/tags.json` from real `GET /v2/tags` results (keeping the groups) and sets `_handAuthored: false`.
- `scripts/record.mjs`: runs the Hollow Pines scenario end to end through the real handler (`src/index.ts` under Node, like dev-node) and writes `fixtures/scenarios/hollow-pines/plan.jsonl`, `city-<slug>.json` for each stop in the route plus any in `playbookCities`, and `pitch.json`. With `QLOO_API_KEY` set it also overwrites `fixtures/qloo/*.json` responses with the live responses and sets `_handAuthored: false, _captured: <ISO date>`.

## Exact module signatures (so parallel work fits together)

```ts
// src/routing.ts
export function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number;
export function planRoute(input: {
  home: { label: string; lat: number; lon: number };
  localities: Locality[];          // ranked, may include entries without lat/lon (skip those)
  days: number;
  driveHoursCap: number;
  mustInclude?: string[];          // locality labels
  exclude?: string[];              // locality labels
}): Route;
export function compareObvious(route: Route, obviousCities: string[]): ObviousRoute;
// public/js/routing.js exports the same three functions in plain JS with identical behavior.

// src/places.ts  (data/us-places.json is imported statically: import places from "../data/us-places.json" with { type: "json" })
export interface PlaceRow { label: string; name: string; state: string; population: number; lat: number; lon: number }
export function findPlace(label: string): PlaceRow | undefined;   // case-insensitive, tolerant of "Saint"/"St." and missing state
export function allPlaces(): PlaceRow[];

// src/demo/resolver.ts
export const demoResolver: DemoResolver;   // (path, params) => fixture.response | undefined, keyed by canonicalUrl(path, params)
export function fixtureMeta(path: string, params: Params): { handAuthored: boolean; captured: string | null } | undefined;
export const FIXTURE_NOTE: string;         // "pre-key placeholder" or "captured <date>" summarizing the newest fixture state
// Fixtures are bundled by scripts/bundle-fixtures.mjs into src/demo/fixtures.generated.ts (static imports of every
// fixtures/qloo/*.json plus index.json, exporting `fixtures: Record<canonicalUrl, FixtureFile>`). Run it after editing fixtures.
// package.json gets a "fixtures" script that runs scaffold + bundle.

// src/tools.ts
export function makeTools(ctx: { qloo: QlooClient; format: Format; home: string; days: number; driveHoursCap: number }): { tools: ToolDef[]; state: { comps: Comp[]; localities: Locality[]; route?: Route; obvious?: ObviousRoute; receipts: Receipt[] } };
export function toReceipt(tool: string, r: QlooResult, body?: any): Receipt;   // resultCount from entitiesOf(body), top 3 names+affinities

// src/city.ts
export function buildPlaybook(opts: { qloo: QlooClient; client: Anthropic | null; model: string; city: string; home: string; comps: Comp[]; locality?: Locality; emit: (e: AppEvent | AgentEvent) => void }): Promise<Playbook>;
export function groupPromo(places: Rec[]): PromoGroup[];
export function summarizeDemographics(body: any): Demographics | null;
export function localColorDeltas(cityBody: any, homeBody: any): Delta[];
export function fallbackCopy(p: Omit<Playbook, "card" | "receipts">): CardCopy;

// src/recorded.ts
export function replayPlan(fast: boolean): AsyncGenerator<any>;             // reads fixtures/scenarios/hollow-pines/plan.jsonl (bundled as a string import or generated module)
export function recordedPlaybook(city: string): Playbook | undefined;
export function recordedPitch(): Pitch | undefined;
export const RECORDED_AVAILABLE: boolean;
```

Frontend module contracts (plain JS):

```js
// public/js/map.js
export function createMap(el) -> { setLocalities(localities), setRoute(route), setObvious(cities, on), setHome(home), focus(label), destroy() }
// public/js/route.js
export function renderRouteRail(el, { route, localities, pinned, dropped, onPin, onDrop, onAdd, onOpenCity, obvious, showObvious, onToggleObvious })
// public/js/playbook.js
export function renderPlaybook(el, playbook, { onShowQuery, onOpenReceipt, onPrev, onNext, onPrint })
// public/js/tour.js
export function renderTour(el, { route, playbooks, pitch, obvious, onOpenCity, onPrint })
// public/js/receipts.js
export class Receipts { constructor(drawerEl, countEl); add(receipt); clear(); open(); close(); toggle(); highlight(id) }
```

Sample-button behavior: the landing's primary button sends `{ ...scenario.request, scenarioId: "hollow-pines", recorded: true }` so judges always get the deterministic replay; a secondary "Run it live" link appears only when `/api/health` reports `claude: true` and sends `recorded: false`.

## Tests (`tests/`)

Node test runner, no dependencies. Existing: `qloo.test.ts`, `agent.test.ts`. Add: `canonical.test.ts`, `routing.test.ts`, `city.test.ts` (pure helpers: promo grouping, demographics averaging, local color deltas, fallback copy), `resolver.test.ts` (fixture lookup hits for every scaffolded query), `places.test.ts` (data file has the scenario cities with coordinates). `npm test` must pass and `npm run typecheck` must be clean.
