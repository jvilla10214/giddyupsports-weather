# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. Same format/spirit as the
racing command center's `DECISIONS.md`.

---

## Wind-direction audit: fixed a real FROM/TOWARD bug in the human-readable label, and a 5th AI phrasing failure
**Date:** 2026-09-02
**Decision:** Systematically grepped every use of `windFromDeg`/`windCompass`/`blowsToward` end to
end (carry math, wind-arrow animation, compass label, both AI prompts, cache key) in response to
"make sure the AI calls are synced up with wind direction (the direction the wind is blowing, NOT
where it is coming from)." Found and fixed two real bugs:
1. `windCompassOrVariable()` — the function producing the human-readable compass letter shown in
   stat chips, grid previews, the almanac card, and fed into both AI prompts — was computing
   `degToCompass16(weather.windFromDeg)`, i.e. the direction wind is blowing FROM, while every other
   part of the app (carry math, wind-flow arrows) had always correctly used the TOWARD vector. Fixed
   by converting FROM->TOWARD before computing the letter, matching `windCarryAt`'s existing
   `(windFromDeg + 180) % 360` conversion.
2. The AI insight cache key (`insight:{sport}:{venue}:{date}:{speed}:{temp}`) never included
   direction, only rounded speed/temp. Since direction can flip (e.g. onshore to offshore) without
   speed or temp moving enough to change the rounded key — exactly the kind of swing already proven
   to happen within 30 minutes at Nationals Park — a stale, direction-wrong insight could be served
   for up to its full 6hr cache TTL. Fixed by appending `score.windCompass` (falls back to
   `windTier` for NFL, which doesn't compute a compass letter) to the key.
**Fifth AI narration failure found live during verification:** even after fix #1, and even with an
explicit "blowing TOWARD the SSW... not where it's coming from" clause in the prompt, the model's
own generated sentence for Nationals Park said "...from the southwest" — backwards (SSW was where
the wind was headed; it was blowing FROM the north). Explaining the FROM/TOWARD distinction and
trusting the model to preserve it while composing a fresh sentence didn't hold, the same class of
failure as the four earlier field/handedness-scrambling incidents documented below. Fixed the same
way those were fixed: stopped giving the model the raw compass letter to rephrase at all. `windZone`
(e.g. "blowing in from left field") already states direction unambiguously in plain English with
the correct preposition baked in by deterministic code, so the prompt now says "use the exact phrase
[windZone] verbatim... do NOT invent your own compass direction, cardinal letters, or a 'from the
[direction]' phrasing." The NFL prompt no longer receives a compass letter either (NFL doesn't have
a per-field breakdown to hang direction off of, so it added risk with no informational value) — it
was told explicitly not to state a compass direction and to describe speed/tier effects only. The
raw compass letter is still shown in the UI directly from `score.windCompass`, deterministic and
correct — it's just never passed through the AI's own wording anymore.
**Verified live** post-deploy across three real games with real wind (Fenway 12.7mph blowing in from
RF, Nationals Park 6.7mph blowing in from LF, Coors Field 8.1mph blowing in from RF/adding carry):
all three insights correctly framed reduction vs. increase, matched `windZone`, and contained zero
invented compass letters or "from the [direction]" phrasing.
**Broader audit, no other issues found:** re-checked cache TTLs (weather 10min, schedule 15min,
insight 6hr, historical/NWS-station-lookup 60-90 days, almanac 24hr) — all still reasonable for
their data's actual volatility, no changes needed. Re-checked schedule freshness and roof-status
handling — unchanged from prior audits, still correct.

## Wind source: real NWS station observations preferred over Open-Meteo's nowcast
**Date:** 2026-09-02
**Decision:** `fetchWeather` now tries a real NWS observation station (nearest to the venue, found
via `api.weather.gov/points` and cached ~90 days since that mapping never changes) first for wind
speed/direction/gusts, falling back to Open-Meteo whenever NWS is unavailable, errored, returns
null fields, or the venue is outside the US (Rogers Centre, Toronto — the only non-US venue in
either sport). Temperature/humidity/precipitation still come from Open-Meteo either way.
**Why:** Investigating the Nationals Park report below turned up a real, demonstrated accuracy gap
during fast-moving weather: at the same moment Open-Meteo's "current" endpoint reported 0.7mph and
"mainly clear," the real METAR for the nearest airport (KDCA) had just issued a SPECI (a report
triggered specifically by sudden significant weather) showing an active thunderstorm — real wind
at 12kt/13.8mph with lightning. Open-Meteo's current data is a high-resolution model nowcast, not
a live instrument reading; it's good in steady conditions but can meaningfully lag sudden
convective events. NWS station data is real ground truth when available.
**Known limitation, found while validating this fix:** NWS's own structured JSON observation
endpoint returned null wind fields (quality-control code "Z" = missing) for KDCA during the very
storm this fix was meant to catch — even though the raw METAR text for the same report clearly had
valid wind data. Rather than add a raw-METAR-text parser to work around NWS's own pipeline gap,
`fetchNwsWind` just treats null fields as "unavailable" and falls back to Open-Meteo — tested live
across several venues (NYY, CHC, CHI succeeded via NWS; SF and WSH fell back cleanly, no errors).
This means the one specific storm-driven case that motivated the fix can still occasionally fall
through to the same imperfect Open-Meteo nowcast on both ends of the fallback chain — an inherent
limit of free data sources during genuinely fast-moving weather, not a bug in the fallback logic.
**Also added:** `windGustMph`, surfaced in the UI wind chip ("· gusts 12") whenever gust exceeds
sustained speed by 5mph+, since a single averaged sustained-speed number can undersell how gusty/
variable conditions actually are — directly addresses "wind blowing in occasionally" reports where
the *average* reads calm but individual gusts don't. Deliberately kept out of the AI prompt (see
the AI narration decision below for why adding another number for the model to juggle is risky).

## Weather cache: 30min -> 10min, and hide wind direction below 3mph
**Date:** 2026-09-02
**Decision:** `fetchWeather`'s KV cache TTL dropped from 30 minutes to 10. Separately,
`windCompass` now returns the literal string `"variable"` instead of a specific compass letter
whenever `windSpeedMph < 3` (same threshold already used to zero out direction-based carry/passing
effects) — added as `windCompassOrVariable()` in rules-engine.js, used everywhere a compass
direction is shown (both sports' live game endpoint and the historical almanac).
**Why:** User reported Nationals Park showing positive field-carry numbers and a hitter-friendly
writeup while wind was "clearly blowing in" in real life. Investigation: an uncached direct
Open-Meteo query showed wind direction had swung from 66deg to 252deg — nearly a full reversal —
in under 30 minutes, because wind that light (0.7-2.7mph observed) has no dominant driving force
and is inherently erratic. The 30min cache meant the site could serve a snapshot already stale
and reversed by the time someone looked at it. Shortening the cache reduces how large that window
can get, but doesn't eliminate it (light wind can still flip within 10 minutes) — so the second
half of the fix is showing "variable" instead of a specific direction at low speed, which is
honest about the real uncertainty regardless of cache freshness. The underlying math was never
wrong here (2.7mph is genuinely below the "meaningful enough to model" bar), the problem was
presentation implying more precision/confidence than the data supports.
**Alternatives considered:** Dropping the cache entirely (rejected — defeats the purpose of
caching, and freshness beyond ~10min doesn't meaningfully change the "is this a real, sustained
wind or just noise" question anyway); a much shorter TTL like 2-3 minutes (rejected — diminishing
returns once "variable" is shown below 3mph regardless, and it would meaningfully increase
Open-Meteo traffic for no real accuracy gain at that point).

## AI narration: stopped asking the model to restate per-field numbers or handedness
**Date:** 2026-09-02
**Decision:** The MLB insight prompt no longer asks the model to (a) state which batter
handedness benefits, or (b) restate the individual left/center/right field carry numbers. Both
are computed correctly and shown directly in the UI (the field-carry chips and the handedness
badge are pure rules-engine output, never AI-generated) — the model's job is now limited to
describing the single `windZone` phrase and the overall carry/lean in plain language.
**Why:** Four distinct factual errors were caught live by the user, in order: (1) called wind
favoring left-handed hitters while describing it pushing toward left field — backwards, since
lefties pull to right field; (2) called a still-negative field carry (-10.4ft, below a neutral
day) an absolute "boost," when it was only a relative edge over an even-worse-suppressed opposite
field; (3) after fixing #1, named the correct benefiting field but attributed it to the wrong
handedness anyway; (4) after removing handedness from its job entirely, it separately scrambled
which of the three field-carry numbers belonged to which field, and misnamed the windZone
direction in its own prose (said "left field" when the data said right field). Each fix closed
the specific failure caught, but the model kept finding new ways to mishandle the same underlying
task: reliably pairing 3+ related values in freeform text. Rather than keep prompt-engineering
around a small (3B) free-tier model's demonstrated limit, the fix was architectural — narrow what
it's asked to generate down to what it's actually reliable at (a short natural-language summary
given one clear directional fact), and let deterministic code own everything that requires
correctly tracking multiple paired values.
**Also fixed in the same pass:** a real (non-AI) bug in `windZone` classification — wind blowing
almost directly in from center field (angle near 180° from the "blowing out" reference) fell
through every angle bucket and was mislabeled `"mostly crosswind"`. Replaced hand-tuned angle
buckets with picking whichever of the three fields' computed wind-carry values has the largest
magnitude, which handles every angle correctly by construction (this was the Fenway case the user
caught, not the Nationals one).
**How to apply:** If more AI-narrated multi-value facts get added later (e.g. a future NFL
handedness-equivalent), assume this model needs the same treatment — either give it exactly one
value to talk about, or compute the sentence deterministically and skip generation for that part
entirely. Don't assume more/better prompt instructions will fix a pattern like this; test with a
real example immediately, and if it recurs after one fix, narrow scope instead of patching further.

## Historical almanac: schedule-first search, not weather-first
**Date:** 2026-09-02
**Decision:** `/api/almanac` finds the closest-matching historical weather day at a venue by
first pulling each of the last 15 years' home-game schedule in a +/-5 day window around today's
month/day (via MLB Stats API, `hydrate=linescore`), and only comparing weather among those
confirmed game dates — not by finding the single closest weather day in history and hoping a game
happened to be played then.
**Why:** The point of this feature is "here's what happened last time it felt like this," which
requires an actual game to report on. Weather-first search would frequently land on a date with no
game (off day, road trip) and produce a dead end after users already read a date. Schedule-first
guarantees every match has a final score and HR count to show, at the cost of a slightly less
perfect weather match (constrained to ~11 candidate days/year instead of all 365).
**Known limitation:** team IDs are stable across relocations, but venues aren't — for the
Athletics (moved from Oakland Coliseum to Sutter Health Park in 2025), a match can return a
historical game played at their *old* venue while comparing against the *new* venue's weather.
Confirmed live: querying for Sutter Health Park returned a 2014 game at Oakland Coliseum. Affects
one team; not worth the complexity of tracking historical venue-per-game before more of the
schedule accumulates at the new park.
**Alternatives considered:** NFL support (rejected — no free historical box-score API exists for
NFL, confirmed when scoping this feature; MLB Stats API's boxscore endpoint has no equivalent);
searching all 365 days of history instead of a +/-5 day window (rejected — a "closest match" from
January weather when today is September isn't a meaningful comparison regardless of how close the
numbers happen to land).

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
