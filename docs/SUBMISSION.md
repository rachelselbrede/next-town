# Devpost submission: Next Town

Paste from here into the Devpost form for the Qloo Agentic Hackathon. Each claim points at a file in this repo so a reviewer can check it. Fill in the URLs after deploy (see [DEPLOY.md](DEPLOY.md)).

## Project name

Next Town

## Elevator pitch

Find the towns that already love you.

Longer version, if the field wants one (under 200 characters): A tour-routing agent for independent acts. Qloo finds where fans of the artists you sound like rank highest; Next Town routes a drivable loop through those towns.

## Try it out (links)

- Live app: `<LIVE_URL>` (the `workers.dev` URL that `npm run deploy` prints)
- Code: `<REPO_URL>`
- Static mirror, sample only (optional): `<PAGES_URL>`

There's no video. Judges open the live app and click **Try it with Hollow Pines**.

---

## About the project

### Inspiration

A lot of independent bands plan a tour from their streaming dashboard: sort the cities by listeners and book from the top. That list leans toward the biggest markets, where a new act is up against every other tour for the same nights. A small band ends up as one more name on a weeknight bill. Next Town shows one line beside its route comparison to make the money plain: "$600 guarantee against a $1,400 van, gas and hotel night: one empty Tuesday erases three good nights." (`public/js/route.js`)

Qloo can answer a different question. Not where the most listeners are, but where fans of the artists you sound like rank highest compared with everywhere else. Put that rank next to a Census population, and the small towns where your kind of audience already gathers stand out. Next Town is an agent that asks that question, routes the answer, and writes the advance sheets.

### What it does

You name one to three artists you sound like, a home city, the days you have (3 to 21), and a daily drive cap (2 to 10 hours). The agent:

1. Resolves each comp to a Qloo entity (`resolve_act`).
2. Asks Qloo for the 50 US localities where fans of those comps rank highest, with a per-comp explanation for each (`rank_markets`). It joins each town to its Census population and coordinates, and flags over-index towns: under 250,000 people with an affinity rank of 20 or better.
3. Plans a loop from home through those towns that respects the drive cap (`plan_route`). Its prompt asks for two or three specific observations along the way, and a short closing paragraph a booking agent could read aloud.

Next to your route sits the "obvious route": fifteen big markets most acts default to. A switch puts them on the map and counts the overlap. Pin, drop or add a town and the loop re-plans in the browser at once, with a plain-words note for every judgment call.

Click any stop for a one-page playbook: four cards, built from seven Qloo calls.

- **Rooms your fans like**: places tagged as music venues, concert halls or live-music bars, sorted by the comps' affinity.
- **Where to hang posters**: record stores, coffee shops, bookstores, dive bars and vintage shops, up to two of each, with a suggested ask.
- **Who shows up here**: age and gender affinity bars for fans of the comps nearby, with suggestions labeled as suggestions.
- **Local color**: brands and TV shows this market's fans like more than your home market's fans do.

Every room and shop carries "because Big Thief 78% / Waxahatchee 66% / Adrianne Lenker 61%" chips from Qloo's explainability output. Every card has **Show the query**. A Receipts drawer lists every Qloo call with its parameters, status, timing, top results, exact URL, and **Copy as curl**.

**Build my tour** builds every playbook, writes a short pitch for a booking agent, and produces an itinerary table and one printable advance sheet per stop.

The one-click sample is Hollow Pines, a fictional indie-folk trio from Richmond, VA. The comps are real, the band is not, and the app labels it "fictional band". It replays a recorded run of the real agent, so it needs no key and plays the same for every judge. One honest note: the Qloo key hadn't arrived when this was built, so the sample's Qloo answers are hand-authored placeholders in the documented response shape. The header pill says "Recorded demo (pre-key placeholder)" until they're replaced with live responses.

### How we built it

**Qloo.** Every request goes to `https://hackathon.api.qloo.com` with the `X-Api-Key` header, through one client (`src/qloo.ts`). The query builders live in `src/queries.ts`:

- `GET /search` with `query`, `types=urn:entity:artist` (`urn:entity:person` for comedy), `take=5`, to resolve comps.
- `GET /v2/insights` with `filter.type=urn:entity:locality`, `signal.interests.entities=<comp ids>`, `filter.geocode.country_code=US`, `take=50`, `feature.explainability=true`, to rank markets.
- `GET /v2/insights` with `filter.type=urn:entity:place`, `filter.location.query=<City, ST>`, `filter.location.radius=15000`, `filter.tags=<venue tag ids>`, `operator.filter.tags=union`, `signal.interests.entities`, `sort_by=affinity`, `take=8`, `feature.explainability=true`, for rooms. The same with the promo tag ids plus `diversify.by=properties.subtype`, `diversify.take=2`, `take=12`, for promo partners.
- `GET /v2/insights` with `filter.type=urn:demographics`, `signal.interests.entities`, `signal.location.query`, `signal.location.radius=25000`, for who shows up.
- `GET /v2/insights` with `filter.type=urn:entity:brand` or `urn:entity:tv_show`, the same location signal, and `take=20`, run for the stop and for home, for local color (stop affinity minus home affinity).
- `GET /v2/tags` with `filter.query`, in `scripts/verify.mjs`, to swap the guessed tag ids in `data/tags.json` for real ones.

Planning the sample is four Qloo calls. A playbook is seven, run in parallel. Planning plus all twelve playbooks is 88, and the Receipts drawer shows each one.

**Claude tool use.** `src/agent.ts` is a small streaming tool loop on the Messages API (`@anthropic-ai/sdk`), with no agent framework. Claude gets three tools with strict JSON schemas (`resolve_act`, `rank_markets`, `plan_route`), adaptive thinking with summarized display, effort "medium", and at most 8 turns. Tool calls from one turn run in parallel. Claude never writes a URL: the tools take small inputs, `src/queries.ts` composes the parameters, and `idList()` and `canonicalUrl()` in `src/canonical.ts` sort the entity ids and parameter keys, so the same inputs always make the same request. `plan_route` can only route through towns `rank_markets` returned. Card copy is one structured-output call per playbook (`client.messages.parse` with a JSON schema). It sees only the fields it may cite, under a prompt that forbids anything not in them. The pitch is one short call. Both have templated fallbacks built from the same data, so nothing is ever blank. The default model is `claude-opus-5-5`, set by `MODEL`.

**Cloudflare Workers.** One Worker (`src/index.ts`, `wrangler.jsonc`) serves `public/` as static assets and four routes: `GET /api/health`, `POST /api/plan` (Server-Sent Events), `POST /api/city` (Server-Sent Events), and `POST /api/pitch` (JSON). The secrets are `ANTHROPIC_API_KEY` and `QLOO_API_KEY`. The same handler runs under Node for local development (`scripts/dev-node.mjs`) and for recording (`scripts/record.mjs`), and in the browser for a static GitHub Pages mirror (`src/static-entry.ts`, `scripts/build-static.mjs`).

**Vanilla JS.** `public/js/` is plain ES modules, with no bundler and no framework. There's a state machine for the four screens (`app.js`), a Leaflet 1.9.4 map (`map.js`), the route rail (`route.js`), the four cards (`playbook.js`), the tour sheet (`tour.js`), the Receipts drawer (`receipts.js`), and the agent log (`trace.js`). `routing.js` is a plain-JS copy of the router, so pin and drop re-plan without a server round trip. State is saved to `localStorage`, so a reload can resume. Print CSS gives one advance sheet per page.

**Data.** `data/us-places.json` holds 6,750 US places with 5,000 or more people, built by `scripts/build-places.mjs` from Census 2020 files (sources and rules in `data/README.md`). Qloo says how strongly a town's fans rank; the Census says how big the town is. The over-index badge needs both.

**Determinism and replay.** `fixtures/qloo/` holds one response per canonical URL. `scripts/record.mjs` runs the real handler end to end and saves every event to `fixtures/scenarios/hollow-pines/`. The Worker replays it at reading pace, and **Skip ahead** replays it instantly. `scripts/verify.mjs` checks every query shape against the live API the day the key arrives.

### Challenges we ran into

- **Building before the Qloo key arrived.** The key hadn't come by the time the app was done. So every query is composed by code, every request has a canonical URL, and `fixtures/qloo/` holds a placeholder response for each one, in the shape the Qloo reference documents. The app runs end to end in demo mode, the header pill says so, and two commands (`npm run verify`, then `npm run record`) swap the placeholders for live responses.
- **Keeping an agent demo deterministic.** A judge should see the same route every time. Claude decides which tool to call; the tool decides the parameters. Entity ids are sorted, parameter keys are lower-cased and sorted, and city names are normalized before anything becomes a key, so comp order and typing never change what Qloo is asked.
- **Keeping Claude to the data.** The planner only routes through towns Qloo ranked. The copywriter only sees the fields it may cite. Every prompt forbids claims about capacity, age policy or ticket sales. A missing fixture shows up as a 404 receipt, not invented data, and a city with no recorded answers gets a page that says so instead of four empty cards.
- **A Worker has no filesystem.** The fixtures and the recording are bundled into generated TypeScript modules as static JSON imports (`scripts/bundle-fixtures.mjs`, `scripts/record.mjs`).
- **Two copies of the router.** The browser needs the routing algorithm for instant pin and drop, and the server needs it for the agent. `public/js/routing.js` is a copy of `src/routing.ts`, and a test feeds both the same inputs and asserts identical routes.
- **Census data without a key.** The Census data API refuses keyless requests now, so the places table is built from key-free files that report the same 2020 counts (`data/README.md`).
- **Map tiles.** The keyless CARTO basemap started serving an "API KEY REQUIRED" watermark, so the map uses Esri's Light Gray Canvas with its attribution.

### Accomplishments that we're proud of

- The Receipts drawer. Every Qloo call, in order, with its exact URL, parameters, mode, status, timing, top results and **Copy as curl**. Nothing is hidden.
- The honesty rules live in three places: the prompts, the templated fallback copy, and a caution on every playbook and advance sheet. The app says "fans of your comps around Asheville", never "people in Asheville".
- Over 90 tests on Node's built-in test runner with no test dependencies, and a clean `tsc --noEmit`. They cover the query keys, the Census lookup, the router and its browser copy, promo grouping, demographic averaging, local-color deltas, the fallback copy, the fixture resolver, the three tools running the whole sample, and what a judge sees in the hosted demo without keys.
- A planner that explains itself. On the sample's placeholder ranking it plans twelve stops, 1,936 miles and no drive days, with nine stops in over-index towns and none on the usual-suspects list. It says why it skipped Burlington, VT, Northampton, MA, Ithaca, NY and Portland, ME.
- A Census table with no hand-typed number in it.
- A static mirror that runs the real Worker handler inside the page, so the sample works even with no server.

### What we learned

- Let the model choose the step and let code choose the parameters. That one split made the demo reproducible, made fixtures possible, and made the receipts exact.
- One canonical key can do two jobs: fixture lookup and in-request cache.
- Hand the copywriter only what it may cite. The templated fallback proves the data alone can fill the page.
- Taste affinity and population are different axes. The interesting towns are high on one and low on the other, and you need a second data source to see that.

### What's next for Next Town

- Run `npm run verify` and `npm run record` the day the Qloo key arrives, then redeploy. The pill flips to "Recorded demo (captured <date>)" on its own.
- With live Qloo, every town the planner adds gets a real playbook. Today only the sample's 14 cities have fixtures.
- An "openers to ask" card: local artists below a popularity ceiling, excluding the comps, with `bias.trends`. The query is already built in `src/queries.ts` and checked by `scripts/verify.mjs`.
- A comedy sample. The code already searches people instead of artists and switches to comedy-club tags when the format is comedy.
- Real road routing instead of straight-line miles.

---

## What makes it Qloo-powered

The brief's own test is that if a submission would work the same without Qloo, it's the wrong thing to build. Take Qloo out of Next Town and there's nothing to route. The whole product rests on a question only Qloo answers: among every US locality, where do fans of these specific artists rank highest, and which of those artists drives each one? That ranking (`/v2/insights` with `filter.type=urn:entity:locality`, `signal.interests.entities` and `feature.explainability`) is the only candidate list the planner may draw from (`src/tools.ts`). It's the source of every over-index badge and every "because" chip. Each playbook card comes from its own Qloo calls: places filtered by tag and location and sorted by the comps' affinity, the demographic read for that audience near that city, and brand and TV-show affinities compared between the stop and home. The card copy and the pitch are written only from those results. Claude on its own could list college towns from memory, but it couldn't rank fifty markets for these three artists, say which artist drives each one, or show the request behind every claim. The dependence is easy to see in demo mode too: open a town the demo has no Qloo answers for, and the receipts say 404 and the page says nothing on it comes from Qloo. Judges can count the calls themselves in the Receipts drawer: four to plan, seven per stop.

---

## 60-second judge walkthrough

1. Open `<LIVE_URL>`. Note the "fictional band" tag on the sample card. Click **Try it with Hollow Pines**. The header pill switches to "Recorded demo (pre-key placeholder)".
2. The agent log streams on the left: turns, thinking, three `resolve_act` calls, `rank_markets`, `plan_route`. Expand a tool call to see its input and result, plus the exact Qloo request for the Qloo-backed ones. Click **Skip ahead** to jump to the finished route.
3. The map shows dots sized by affinity, gold rings on over-index towns, and the loop from home. Hover a dot for its rank, population and "because" line. "The agent's read" under the map is the closing paragraph. The right rail says 12 stops, 1,936 miles, 0 drive days.
4. Flip **Obvious route vs. your route**. Grey dots mark fifteen usual-suspect cities, and the summary reads "Overlap with the usual suspects: 0 of 12 stops." Open **Judgment calls the planner made** to see why Burlington, VT was skipped.
5. Click **Drop** on a stop. The loop re-plans at once. Click **Restore** under "Dropped" to put it back. (Until the key arrives, the town that fills the gap has no recorded Qloo answers, and its playbook says so. Restore before building the tour to keep the sample whole.)
6. Click **Asheville, NC** in the right rail. You get four cards with "because" chips on every room and shop, age bars, and brand and TV-show differences against Richmond. Click **Show the query** on any card; the Receipts drawer opens at that call. Use **Next stop** to page through.
7. Click **Receipts** in the header to see every call so far, then **Copy as curl** on one.
8. Go **Back to route** and click **Build my tour**. A progress chip fills for each stop and for the pitch. The tour screen shows the itinerary, the booking-agent pitch, and one advance sheet per stop. Click **Print advance sheets**. The Receipts count is now 88.

---

## Built with

- Qloo Insights API (hackathon): `GET /search`, `GET /v2/insights` (localities, places, demographics, brands, TV shows), `GET /v2/tags`
- Claude (Anthropic) through `@anthropic-ai/sdk` 0.133: streaming tool use, adaptive thinking, structured outputs; default model `claude-opus-5-5`
- Cloudflare Workers with static assets (wrangler 4)
- TypeScript: Node 26 runs it directly for local dev and tests, wrangler bundles it for the Worker, `tsc` type-checks it; Node's built-in test runner
- Vanilla JavaScript ES modules, HTML and CSS, with a print stylesheet
- Leaflet 1.9.4 with Esri Light Gray Canvas tiles
- US Census Bureau: 2020 Gazetteer, Vintage 2023 population estimates, TIGERweb
- Google Fonts: Fredoka and Nunito
- esbuild, GitHub Actions and GitHub Pages for the static mirror

Tags: `qloo`, `claude`, `anthropic`, `cloudflare-workers`, `typescript`, `javascript`, `node.js`, `leaflet`, `census`, `esbuild`, `github-actions`

---

## Submission checklist

- [ ] **Functional demo link:** `<LIVE_URL>`, hosted on Cloudflare Workers. The sample works end to end with no sign-in.
- [ ] **Public repository:** `<REPO_URL>`, with all source, data, fixtures and the instructions in `README.md`.
- [ ] **Text description:** the sections above, including "What makes it Qloo-powered".
- [ ] **Hosted externally:** the Worker (and optionally the GitHub Pages mirror), not localhost.
- [ ] **Open-source license:** `LICENSE` (MIT) at the repo root, so GitHub shows it in the About sidebar.

## Team

Rachel Selbrede.
