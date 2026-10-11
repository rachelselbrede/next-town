# Deploying Next Town

The app is one Cloudflare Worker that serves the static site from `public/` and the API from `src/`. The free Workers plan is enough for judging.

## One-time setup (about 10 minutes)

1. **Cloudflare account.** Sign up at https://dash.cloudflare.com/sign-up (free, no card).
2. **Anthropic API key.** Create one at https://console.anthropic.com/settings/keys and add a few dollars of credit. Live mode costs roughly $0.05-0.15 per tour plan and a few cents per city playbook with `claude-opus-5-5`. The recorded sample scenario costs nothing.
3. **Qloo API key.** Arrives by email after the hackathon form (https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide#getting-your-api-key). Until then the app runs in recorded/demo mode automatically.

## Deploy

```bash
cd ~/Desktop/next-town
npx wrangler login            # opens the browser once
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put QLOO_API_KEY     # skip until the key arrives
npx wrangler deploy
```

Wrangler prints the URL, like `https://next-town.<your-subdomain>.workers.dev`. That is the link for the Devpost "Try it out" field.

Redeploy after any change with `npx wrangler deploy`. Secrets stay set.

## When the Qloo key arrives

```bash
export QLOO_API_KEY=...        # in your shell, for the scripts
npm run verify                 # checks every query shape against the real API and fixes data/tags.json
npm run record                 # re-records the Hollow Pines sample with real Qloo responses
npm test
npx wrangler secret put QLOO_API_KEY
npx wrangler deploy
```

After `record`, the header pill changes from "Recorded demo (pre-key placeholder)" to "Recorded demo (captured <date>)" and the fixtures carry real Qloo data.

## Local development

```bash
npm run dev                    # Node server on http://localhost:8787, uses ANTHROPIC_API_KEY or your `ant auth login` profile
npm run dev:worker             # the same app under wrangler (needs .dev.vars, see .dev.vars.example)
npm test
npm run typecheck
```

## Deploying from GitHub Actions instead (optional)

If you would rather not run wrangler locally, create a Cloudflare API token (Workers Scripts: Edit) and add it as the `CLOUDFLARE_API_TOKEN` repository secret along with `CLOUDFLARE_ACCOUNT_ID`; then a workflow that runs `npx wrangler deploy` on push to `main` will publish. Set the two app secrets once with `wrangler secret put` as above (secrets are not in the repo).
