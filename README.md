# GiddyUpSports Weather Command Center

A weather-driven conditions dashboard for MLB and NFL games — wind, humidity, temperature, and
an aerial view of each stadium, plus an AI-narrated read on what the conditions mean for scoring
(fly-ball carry / HR-favorable field direction for MLB, passing & kicking impact for NFL).

Sister project to the GiddyUpBets racing command center, same operating philosophy (static
frontend, no build step, a Cloudflare Worker for backend data), kept in its own repo since it's a
separate product.

## Layout

- `index.html` — the entire frontend (HTML/CSS/JS, no framework, no build step). Deploys via
  GitHub Pages on push to `main`.
- `workers/weather-worker.js` — Cloudflare Worker: fetches schedules (MLB Stats API, ESPN's
  scoreboard API) and weather (Open-Meteo), runs the rules engine, calls Workers AI for narration,
  and caches everything in KV.
- `workers/rules-engine.js` — pure-function physics scoring (wind/air-density/altitude for MLB,
  wind-speed tiers for NFL). No network calls — testable on its own with `npm test`.
- `data/stadiums.js` — hand-compiled venue reference data (coordinates, roof type, MLB park
  orientation bearing, MLB team-ID lookup). See the top-of-file comment for accuracy caveats.

## Local development

```bash
npm install
npm test          # rules-engine sanity checks, no network/Cloudflare needed
npm run dev        # wrangler dev — local Worker with real KV/AI bindings (needs `wrangler login`)
```

With `wrangler dev` running (default `http://localhost:8787`), open `index.html` directly in a
browser — it auto-detects localhost and points at the local Worker.

## Deploying

1. `npx wrangler kv namespace create WEATHER_KV`, paste the returned id into `wrangler.toml`.
2. `npx wrangler login` (one-time).
3. `npm run deploy` — bundles and deploys the Worker, including the KV and Workers AI bindings
   declared in `wrangler.toml`.
4. Update the `WORKER_BASE` constant near the top of `index.html`'s `<script>` with your deployed
   Worker URL (e.g. `https://giddyupsports-weather.<your-subdomain>.workers.dev`).
5. Push to `main` — GitHub Pages serves `index.html` from the repo root (`.nojekyll` is required,
   already present).

## Data sources

All free, no paid API keys required:

| Data | Source |
|---|---|
| MLB schedule | `statsapi.mlb.com` (official, keyless) |
| NFL schedule | ESPN's undocumented scoreboard API — cache aggressively, don't over-request |
| Weather (wind/humidity/temp/precip) | Open-Meteo (keyless) |
| Stadium aerial imagery | Esri World Imagery tiles via Leaflet.js (keyless) |
| AI narration | Cloudflare Workers AI free tier (10k neurons/day) |

See `DECISIONS.md` for why each of these was chosen and known limitations.
