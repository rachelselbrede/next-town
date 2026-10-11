# Deploying Next Town

Two deployments exist:

- **GitHub Pages mirror** (automatic). Every push to `main` runs tests and the type check, builds the static mirror, and publishes it at https://rachelselbrede.github.io/next-town/. It replays the recorded sample with no API keys and only ever carries the public placeholder fixtures. Nothing to do by hand.
- **Cloudflare Worker** (live agent). One Worker serves the same site from `public/` plus the API in `src/`. This is the link that runs custom acts live. The free Workers plan is enough for judging.

## One-time setup (about 10 minutes)

1. **Cloudflare account.** Sign up at https://dash.cloudflare.com/sign-up (free, no card).
2. **Anthropic API key.** Create one at https://console.anthropic.com/settings/keys and add a little credit. Then set a **monthly spend limit** on that workspace in the Console (Settings, Limits). The app also caps live runs per visitor, but the spend limit is the backstop. Live mode costs roughly $0.05 to $0.15 per tour plan and a few cents per city playbook with `claude-opus-5-5`. The recorded sample costs nothing.
3. **Qloo API key.** Arrives by email after the hackathon form (https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide#getting-your-api-key). Until then the Worker runs in placeholder mode: the sample works, custom acts get a polite "needs the Qloo key" message, and the header pill says so.

## Deploy

```bash
cd ~/Desktop/next-town
npm install
npx wrangler login                        # opens the browser once
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put QLOO_API_KEY      # skip until the key arrives
npm run deploy
```

`npm run deploy` first runs `prepare:data` (rebuilds the two generated data modules) and then `wrangler deploy`. Wrangler prints the URL, like `https://next-town.<your-subdomain>.workers.dev`. Put that URL in the Devpost "Try it out" field and in README.md where it says `<WORKER_URL>`.

Redeploy after any change with `npm run deploy`. Secrets stay set.

`wrangler.jsonc` declares a Workers Rate Limiting binding named `LIVE_LIMITER` (6 live runs per minute per visitor). It is created automatically on deploy; if your account cannot use that binding, remove the `ratelimits` block and the Worker falls back to an in-memory limit.

## When the Qloo key arrives

```bash
export QLOO_API_KEY=...        # in your shell, for the scripts
npm run verify                 # hits every query shape once, prints what came back, fixes data/tags.json
npm run record                 # re-records the Hollow Pines sample against live Qloo, into private/
npm test
npx wrangler secret put QLOO_API_KEY
npm run deploy
```

The Qloo FAQ says not to store Qloo response data in a public repository, so `record` and `verify` write live captures under `private/`, which is gitignored. The deploy bundles them into the Worker (that is private, server-side use). The public mirror keeps the placeholders. After this the Worker's header pill reads "Recorded demo · Qloo data captured <date>". Commit `data/tags.json` (tag ids are identifiers, not response data); never commit `private/`.

## Local development

```bash
npm run dev                    # Node server on http://localhost:8787
npm run dev:worker             # the same app under wrangler (reads .dev.vars, see .dev.vars.example)
npm test
npm run typecheck
npm run build:static           # the Pages mirror, into site/
```

`npm run dev` uses `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` from your shell, or an `ant auth login` profile in `~/.config/anthropic`. With none of those, the sample still replays and custom runs get a 503.
