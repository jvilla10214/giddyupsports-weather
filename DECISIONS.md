# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. Same format/spirit as the
racing command center's `DECISIONS.md`.

---

## NFL schedule: fetched client-side, not through the Worker
**Date:** 2026-09-01
**Decision:** `index.html` calls ESPN's scoreboard API (`site.api.espn.com`) directly from the
browser for NFL schedule data. The Worker no longer attempts this — `/api/schedule?sport=nfl`
returns a 400 pointing here instead.
**Why:** Verified live, not theoretical: identical requests (same URL, same browser User-Agent,
Referer, Origin headers) return 200 from a plain machine and 403 from the deployed Worker, every
time, regardless of header tweaking. ESPN's edge is blocking Cloudflare Workers' IP ranges
specifically, not detecting a missing header. Checking ESPN's own response headers confirmed
`Access-Control-Allow-Origin: *` — they explicitly permit any browser to call this cross-origin —
so the fix is to stop pretending to be a server and just be the browser the API already welcomes.
MLB's official Stats API has no such block and stays server-side through the Worker as originally
designed.
**Alternatives considered:** A CORS/IP proxy in front of the Worker's request (rejected — adds a
third-party dependency and another point of failure for no real benefit over just calling from the
browser, which already works); TheSportsDB as a schedule source (rejected — checked live, its free
tier's `search_all_leagues` doesn't include the NFL at all, only smaller leagues like the CFL and
European American-football leagues).

## AI narration model: llama-3.2-3b-instruct via env.AI, called through the REST endpoint contract
**Date:** 2026-09-01
**Decision:** Settled on `@cf/meta/llama-3.2-3b-instruct` after the originally planned
`@cf/meta/llama-3.1-8b-instruct` turned out to be deprecated (May 2026). Also upgraded the project's
Wrangler dependency from 4.86.0 to the current 4.128.0 (which needed a Node 22 runtime bump too) —
the old Wrangler version's `env.AI` binding was resolving valid, non-deprecated model IDs through a
stale internal route and failing with a deprecation error for a model we never requested, while the
exact same model+request called via Cloudflare's plain REST API (same account) worked immediately.
Upgrading Wrangler fixed the binding without changing anything else.
**Why:** This was diagnosed live, not guessed — direct REST calls to `/ai/run/@cf/meta/llama-3.2-3b-instruct`
succeeded consistently before the Wrangler upgrade, proving the model and account were fine and the
bug was specifically in the old binding's local routing table.
**Known rough edge:** the free small model's phrasing is occasionally awkward (e.g. describing
"negligible passing impact" in a way that reads ambiguous rather than clearly reassuring). Not
worth fighting further given the free-tier model size — a tighter prompt or a slightly larger model
is the fix if this becomes noticeable in real use.

## Wrangler + ES modules for the Worker, instead of manual dashboard paste-editing
**Date:** 2026-08-31
**Decision:** Unlike the racing repo's `stable-tour-feed.js` (a single monolithic file pasted
directly into the Cloudflare dashboard's editor), this project's Worker is split across
`workers/weather-worker.js`, `workers/rules-engine.js`, and `data/stadiums.js` using standard ES
`import`/`export`, and deployed with Wrangler (`npm run deploy`) rather than copy-paste.
**Why:** The Cloudflare Workers runtime has no `require()` — it's not Node/CommonJS — so a
multi-file design needs either a bundler or single-file inlining. Given this product is meant to
be sold eventually, and the rules engine specifically needed to be unit-testable in isolation
(`npm test` runs real assertions against known cases like Coors Field), the maintainability win of
Wrangler's automatic bundling + real local dev (`wrangler dev` + curl) outweighed matching the old
repo's zero-tooling deploy process exactly. The frontend (`index.html`) still has zero build step,
matching the racing app's approach — only the backend gained tooling, and only because it needed
real testability the old copy-paste process never had to support.
**Alternatives considered:** A concatenation script producing one paste-ready file (rejected — adds
a manual build step without giving any of Wrangler's actual benefits, like local dev or automatic
KV/AI binding management).

## Aerial imagery: Esri World Imagery tiles via Leaflet, not Google/Mapbox
**Date:** 2026-08-31
**Decision:** Stadium aerial views use Leaflet.js with the Esri World Imagery tile service
(`server.arcgisonline.com/.../World_Imagery`), centered on each venue's lat/lon from
`data/stadiums.js`.
**Why:** User explicitly asked to build this "as free as possible." Esri's World Imagery tiles are
free for standard use with no API key, no signup, and no billing account required — unlike Google
Maps Static API (requires a billing account even within its free credit) or Mapbox (requires an
account + token). This matches the project's existing keyless-API philosophy (Open-Meteo, NWS,
MLB Stats API).
**Alternatives considered:** Mapbox Static Images API (rejected — needs an account/token even on
the free tier); Google Maps Static API (rejected — needs billing on file); a literal weather-radar
embed like the racing app's Windy.com iframe (rejected outright per user correction — they want an
aerial/overhead stadium view, not radar).

## AI narration: Cloudflare Workers AI free tier, not a paid LLM API
**Date:** 2026-08-31
**Decision:** Game insights are generated by a deterministic rules engine (`rules-engine.js`) and
then phrased into readable text by Cloudflare Workers AI (`@cf/meta/llama-3.1-8b-instruct`), not a
paid API like Claude or OpenAI.
**Why:** User directly asked whether an LLM API is free and said to build this as free as possible.
No major hosted LLM API is free at the account level, but Workers AI gives 10,000 free "neurons"/day
and this project already runs on Cloudflare — so it's a genuinely $0 option for the expected volume
(~15 MLB games/day + a handful of NFL games/week), with no separate API key or billing account to
manage. The actual physics judgment (carry distance, wind zone, scoring lean) comes from the rules
engine, not the LLM — the model's only job is turning structured output into a sentence or two, which
keeps the numbers auditable and the AI failure mode limited to "worse prose," never "wrong facts."
**Alternatives considered:** A fully free-tier hosted API like Google Gemini's free tier (rejected —
adds a second vendor/account to manage for no real benefit over a same-platform option); rules-engine
output with template-generated text and no LLM at all (a valid fallback if Workers AI's free tier
ever proves insufficient, kept in mind as a cheap downgrade path, not built now).

## Stadium reference data: hand-compiled, not a live API
**Date:** 2026-08-31
**Decision:** `data/stadiums.js` is a manually written table of MLB/NFL venue coordinates, roof
types, and (for MLB) approximate home-plate-to-center-field bearings, rather than a live lookup.
**Why:** No free API reliably provides park orientation bearing or roof type in a structured,
queryable way — this is the same category of decision the racing app already made for track
geometry (rail coordinates, stretch bearing), which started as "eyeballed once from satellite
imagery" rather than a live feed. MLB team-ID-to-venue mapping uses MLB's own stable numeric team
IDs (returned by the schedule API) rather than parsing team display names, which is fragile (e.g.
"Boston Red Sox".split(" ").pop() would wrongly yield "Sox", not matching a "Red Sox" key).
**Known limitation:** `cfBearingDeg` values are not survey-grade for every park — most default to
67.5° (ENE), the orientation MLB's Rule 1.04 recommends and most parks roughly follow, with only a
few well-established exceptions adjusted by hand. Refine against real aerial imagery before
treating any single park's number as precise. Also: MLB roof-open/closed status for the seven
retractable-roof parks isn't known ahead of time from any free source, so wind-based MLB insights
for those venues are labeled "verify roof status" rather than presented as certain.

## Unofficial ESPN scoreboard API for NFL schedule — acceptable for now, flagged for later
**Date:** 2026-08-31
**Decision:** NFL schedule/venue data comes from ESPN's undocumented
`site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard` endpoint, cached in KV rather than
called per page view.
**Why:** No free, keyless, officially-documented NFL schedule API exists comparable to MLB's
official Stats API. ESPN's hidden endpoint is free, requires no key, and is widely used by hobby
projects, but it's explicitly unofficial — fine for an MVP/personal-use tool, but a real risk if
this becomes a paid product resold to other users.
**Alternatives considered:** A licensed provider like SportsData.io (rejected for now — costs
money, and the user wants to validate the product free-first before taking on that expense). If
this ships commercially, swapping the NFL schedule fetch for a licensed provider is the intended
upgrade path — nothing else in the architecture depends on ESPN's endpoint specifically, so the
swap is localized to `fetchNflSchedule()` in `workers/weather-worker.js`.
