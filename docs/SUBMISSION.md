# Devpost submission: Next Town

Paste these into the Qloo Agentic Hackathon submission form. Fill the two placeholders after the Cloudflare deploy.

**Project name:** Next Town

**Tagline:** Find the towns that already love you.

**Try it out (demo link):** `<WORKER_URL>` (live agent on Cloudflare Workers). Backup that needs no keys: https://rachelselbrede.github.io/next-town/

**Repository:** https://github.com/rachelselbrede/next-town (MIT license, visible in the About section)

**Built with:** Qloo Insights API, Claude (claude-opus-5-5, Anthropic SDK, tool use with strict schemas), Cloudflare Workers, TypeScript, vanilla JavaScript, Leaflet, US Census Bureau 2020 data

---

## Inspiration

Independent acts route tours by gut and by streaming listener counts, which always point at the same saturated cities. The towns where a specific act's taste-audience over-indexes, the Ashevilles and Bloomingtons, are invisible to them. And once a city is picked, nothing tells you which room fits, where to hang posters, or what that crowd loves. Qloo's taste graph can answer exactly those questions, across music, places, brands and TV, so we built the agent that asks them.

## What it does

You tell Next Town who you sound like (one to three comparable artists), where you live, how many days you have, and how far you will drive in a day. The agent resolves your comps in Qloo, asks for the venues nationwide that fans of those comps rank highest (one per city), joins them to Census population, and flags over-index towns: places under 250,000 people with a top-20 national rank. It plans a drive-capped loop, shows the "obvious route" of big streaming markets beside it with an overlap count, and lets you pin, drop, or add towns with instant re-routing.

Click any stop and it builds a playbook from Qloo: rooms your fans like, where to hang posters (record store, coffee shop, bookstore, dive bar, vintage shop), who your comps draw (age and gender bands), and local color (brands and shows this market's fans love more than your home market's). Every item carries "because Big Thief 72%" chips from Qloo's explainability, every card has "Show the query", and a Receipts drawer lists every Qloo call with its exact URL and "Copy as curl". "Build my tour" produces a booking-agent pitch, an itinerary, and one printable advance sheet per stop.

The one-click sample is a fictional Richmond, VA band, Hollow Pines (real comps, fictional band, labeled as such). Its recorded run routes 12 shows in 12 days: nine of the twelve stops are over-index towns, and only one (Nashville) is on the usual big-city list.

## How we built it

A Cloudflare Worker serves a vanilla HTML/CSS/JS site and runs the agent. The agent is a small streaming tool-use loop on the Claude Messages API with three tools: `resolve_act` (Qloo `/search`), `rank_markets` (a nationwide `/v2/insights` place query with venue tags, `filter.geocode.country_code=US`, `diversify.by=properties.geocode.city`, `take=50`, explainability on), and `plan_route` (pure routing, no Qloo). Claude decides which tool to call; the code composes every Qloo parameter from fixed constants, so each request has one canonical URL that doubles as the cache key and the receipt judges see.

City playbooks run eleven Qloo calls in parallel: rooms (`filter.location.query` plus venue tags), one call per promo kind, one demographics read (`filter.type=urn:demographics` with the comp ids), and brand and TV-show affinities with `signal.location` for both the stop and home, so local color is a delta against your own market. Explainability is parsed in Qloo's documented shape and mapped to comp names. Card copy and the pitch come from short Claude calls that may only cite values in the data, with templated fallbacks.

Routing is a greedy loop that prefers over-index towns, a 2-opt pass, and drive-day handling, duplicated line for line in the browser so edits re-route instantly. Population and coordinates come from the Census 2020 Gazetteer and estimates files. Everything has tests (about 150) on Node's built-in runner.

## Challenges we ran into

- **The obvious query is not supported.** We first ranked localities directly (`urn:entity:locality` with artist signals). Qloo's docs say that type only accepts locality signals, so we rebuilt the hero query around venues diversified by city, which answers the same question honestly: the towns where fans of your comps most love a room.
- **The data rule.** The hackathon FAQ says not to store Qloo response data in a public repository. We split the project into public hand-written placeholders (in Qloo's documented shape, clearly labeled) and a gitignored `private/` folder for live captures, with the generated data modules treated as build artifacts. The public mirror can only ever carry placeholders.
- **Keeping the demo unbreakable.** The sample replays a real recorded run, so it never stalls in front of a judge, while live runs are rate-limited per visitor, capped in size, and fall back to recorded answers if a Qloo call fails.
- **Honesty under pressure.** Drive times are straight-line estimates and are labeled so; the demographics read is for fans of the comps overall, and the card says so; nothing claims capacity, age policy, or ticket sales.

## Accomplishments that we're proud of

Every number on the screen is traceable: a receipt with the exact URL, an explainability chip, or a Census row. The route screen shows the delta the product creates in one glance, your towns next to the obvious ones. And the whole thing is a complete product: route, edit, playbook, print, not a chat box.

## What we learned

Reading the API reference beats guessing: three of our first queries used parameters that would have been silently ignored or rejected. Deterministic query composition made the fixture, cache, and receipt layers trivial. And a recorded replay is the kindest thing you can give a judge with five minutes.

## What's next for Next Town

Live Qloo data the day our key arrives (`npm run verify` and `npm run record` are ready), comedians through `urn:entity:person`, openers to approach from artist affinities around each stop, and a shareable advance-sheet link a band can send to a booker.

## What makes it Qloo-powered

Remove Qloo and the product collapses to a list of famous music cities plus a Yelp dump. The routing itself is a Qloo query: where fans of your comps most love a venue, across the whole country, with the small towns surfaced by joining affinity rank to population. Every playbook card is a distinct cross-domain Qloo query (places by taste, demographics, brands and TV shows shaped by location), and the explainability output is what lets the app say why each pick is there. An LLM alone cannot rank Asheville above Nashville for a given act, and it cannot show its work.

## 60-second judge walkthrough

1. Open the demo and click **Try it with Hollow Pines**, then **Skip ahead**.
2. On the route screen, read the agent's closing on the left, hover a stop on the map, and flip **Obvious route vs. your route**.
3. Click **Drop** on Boone, NC and watch the loop re-plan, then **Restore** it.
4. Click **Open playbook** on Asheville, NC: rooms, poster spots, who your comps draw, local color against Richmond, and the "because" chips. Click **Show the query**.
5. Open **Receipts** in the header to see every Qloo request with its URL.
6. Back on the route, click **Build my tour** for the itinerary, pitch, and printable sheets.

## Submission checklist

- [ ] Live hosted demo link (Cloudflare Worker URL; the GitHub Pages mirror as backup)
- [x] Public repository with an open-source license visible in About
- [x] Text description (above) that says what makes it Qloo-powered
- [x] No Qloo response data in the public repository (placeholders only, labeled)
