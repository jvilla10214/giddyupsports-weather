# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. Same format/spirit as the
racing command center's `DECISIONS.md`.

---

## Recalibrated the hitter-/pitcher-friendly threshold using the backtest data
**Date:** 2026-09-02
**Decision:** `CARRY_LEAN_THRESHOLD_FT` (the `|carryFt|` cutoff for the `scoringLean` label) moved
from a hand-picked 12ft to a backtested 20ft.
**Why:** Checked where 12ft actually fell in the real 2025-season distribution
(`scripts/backtest-carry-model.js`) before assuming it needed changing. It was badly miscalibrated:
median real carryFt was **+14.4ft** — already above the "hitter-friendly" cutoff — so 78% of real
games were being classified hitter- or pitcher-friendly, the opposite of a selective, notable
label. Investigated why the distribution skewed positive at all (first suspected the 75F temp
baseline, since real games actually averaged a *cooler* 67.5F — which would push carryFt down, not
up, ruling that out). The real cause: isolating just the wind-driven component showed a +10.7ft
median on its own, and most MLB parks cluster at a `cfBearingDeg` of 0-67.5deg (facing away from
the setting sun per MLB Rule 1.04), while the median real wind across the whole sample blew FROM
~202deg -- i.e. TOWARD ~22deg, squarely inside that same cluster. That's a genuine, physically real
tendency for wind to blow out toward center field at most parks on a typical day, not a bug in the
angle math -- confirmed by checking the raw numbers rather than assuming either explanation.
**Recalibration:** swept threshold values from 4ft to 32ft against real combined-runs outcomes.
20ft sits between the real median (+14.4ft) and 75th percentile (+28.6ft), and nearly doubles the
real hitter-vs-pitcher-friendly scoring gap found in the original backtest (0.92 -> 1.37 runs)
while keeping both flagged buckets a healthy size (750 hitter-friendly / 308 pitcher-friendly /
728 neutral, out of 1,786) rather than over-thinning them at a more extreme cutoff.
**A concrete effect of this change, verified live:** Coors Field's ~40ft altitude bonus alone
always cleared the old 12ft bar, so it was unconditionally "hitter-friendly" regardless of the
day's actual wind. At 20ft, a day where wind is blowing in enough to meaningfully offset that
altitude bonus can now correctly land as neutral instead -- the label reflects the day's total
predicted effect again, not just which park it's in.
**Not touched:** the underlying carryFt computation itself (temp/humidity/altitude math, wind angle
math) -- both were confirmed correct and physically grounded during this investigation, not the
source of the miscalibration. Also not touched: the separate 8ft handedness-advantage threshold,
which wasn't covered by this backtest (would need real platoon-split outcome data, not just
combined runs, to calibrate the same way) -- a natural next backtest if this gets revisited.
## Backtest: does the carry model's predicted lean actually correlate with real scoring?
**Date:** 2026-09-02
**What:** `scripts/backtest-carry-model.js` — a standalone Node script (no Cloudflare bindings,
run locally) that pulls a full season's real home-game results (MLB Stats API) and matching daily
weather (Open-Meteo archive) for every open-air MLB venue, runs each day through the actual
`scoreMlbGame` from `rules-engine.js`, and checks whether the model's predicted `carryFt`/
`scoringLean` correlates with real combined runs. Same spirit as the racing app's standalone
Weather Bias Predictor Score tuning script. Run with `node scripts/backtest-carry-model.js
[season]` (defaults to last full year).
**2025 season results** (22 open-air venues, 1,786 games):
- Pearson correlation, predicted carryFt vs. actual combined runs: **r = 0.117**
- By predicted lean: hitter-friendly n=933 mean 9.43 runs · neutral n=389 mean 8.60 · pitcher-
  friendly n=464 mean 8.51 — correctly ordered (hitter-friendly > neutral > pitcher-friendly).
- With Coors Field excluded (its ~40ft altitude bonus alone clears the hitter-friendly threshold
  regardless of wind, so it's worth checking the effect isn't just one famous outlier park): still
  r = 0.095, same correct ordering — the signal generalizes beyond Coors, just gets a bit weaker.
- Isolating only the wind-driven component (excluding the fixed temp/altitude baseline every park
  carries regardless of the day's wind) against real runs, all parks pooled: r = 0.084 — wind
  timing itself, the thing this product actually claims to read game-by-game, has a real but modest
  independent relationship to scoring.
**Read on this:** the model has genuine, non-spurious, correctly-signed predictive validity — it is
not noise, and it is not just repackaging a well-known park factor. But r≈0.08-0.12 means it
explains roughly 1-1.5% of the variance in game scoring, which is honestly weak on its own — MLB
scoring is dominated by starting pitching quality, lineup strength, and other factors miles bigger
than same-day wind. This is the expected order of magnitude for a single weather signal against a
noisy outcome, not a red flag, but it's real information for how much confidence a user should put
in "hitter-friendly" as a standalone signal: real tilt, not a strong prediction.
**Not changed as a result of this pass:** the ±12ft hitter/pitcher-friendly threshold in
`scoreMlbGame` is still the original hand-derived physics estimate, not fit to this data. Real
outcome data now exists to inform whether that threshold is well-placed (e.g. checking what
percentile of the real carryFt distribution 12ft actually represents) — a natural next step, but a
big enough decision (changes what "hitter-friendly" means site-wide) that it wasn't done
unilaterally here.

## Fixed: outdoor temp/humidity leaking into carryFt behind a closed roof
**Date:** 2026-09-02
**Decision:** `scoreMlbGame`'s `baseCarryFt` now only adds the temperature/humidity component when
`!roofClosed`; the altitude component still always applies (a fixed property of the venue's
location, not outdoor weather).
**Why:** found while starting the carry-model backtest below — needed to decide whether to exclude
dome venues from the historical sample, and checking one live turned up a real bug: Globe Life
Field (TEX, retractable roof, assumed closed) was showing +10.5ft of "carry" on a 97F day, entirely
driven by outdoor heat that has no way to reach a climate-controlled interior. That number sat
directly next to this same function's `roofClosed: true` flag and the AI narration's own text
("Conditions are climate-controlled, so wind, temperature, and precipitation have no bearing") --
directly self-contradicting. No existing test covered a closed-roof MLB venue's `carryFt` at all,
which is how this got past every previous audit. Added a regression test comparing the same
closed-roof venue at 97F vs. 40F outside -- `carryFt` must come out identical.

## Wind/weather: point-forecast at scheduled game time, not always "right now"
**Date:** 2026-09-02
**Decision:** `fetchWeather(env, lat, lon, targetTimeIso)` now takes the game's scheduled start
time (the schedule's own `startTimeUtc`, passed through from the frontend on every `/api/game` and
`/api/almanac` call). When the target is more than ~90 minutes out, it fetches Open-Meteo's hourly
forecast (`forecast_days=16`, cached per venue per hour so every game at a venue shares one fetch)
and picks the hour bucket closest to the scheduled start. Within ~90 minutes of start (or for a
game already underway/past), it falls back to the existing current-conditions path (NWS live
station reading preferred, Open-Meteo nowcast as fallback) unchanged.
**Why:** requested directly, from a self-audit ("more accurate AI weather predictions"). Previously
every request — whether checked at 2pm for a 7:40pm game or checked at 7:35pm right before first
pitch — got the exact same "right now" reading. Checking a night game hours ahead of time wasn't
predicting anything; it was describing an afternoon that has nothing to do with game conditions.
**Guardrails:** if the picked forecast hour is still more than 3hrs from the actual target (only
possible if a game is scheduled further out than the 16-day forecast window, or the target time is
otherwise unparseable), the forecast is treated as unavailable and it falls back to current
conditions — better than confidently mislabeling a different day's weather as game time.
**AI narration:** the model was telling users these were "current conditions" even when they were a
forecast for hours later — accurate numbers, misleading framing. Fixed by explicitly telling it
whether to describe the numbers as "current conditions" or "the forecast for game time"
(`conditionsLabel` in `narrate()`) rather than leaving that framing to guesswork. Insight cache key
also now includes the forecast/current flag, since rounded speed/temp/direction could coincidentally
match across that transition without busting the key on their own.
**Known limitation:** forecasts beyond ~7-10 days are meteorologically low-skill (closer to
climatology than prediction) — Open-Meteo will still return a number for a game 12 days out, and
the UI shows it as a forecast, but no confidence/uncertainty framing is surfaced yet. Not solved
here; a future pass could scale the "forecast" language by lead time, or add a real Open-Meteo
uncertainty/ensemble read for far-out games.
**Not done here:** the current-conditions path prefers a real NWS station observation over
Open-Meteo's nowcast (see the NWS decision below); the forecast path uses Open-Meteo only. NWS also
publishes gridpoint hourly forecasts, which would be a natural next upgrade in the same spirit, but
that's a meaningfully larger addition (different response shape, a new gridpoint lookup) — scoped
out of this pass to keep it contained.

## Hero picture: smaller on-screen, zoomed in tight — via fitBounds, not a fixed zoom level
**Date:** 2026-09-02
**Decision:** `.hero` height reduced from `clamp(340px, 42vw, 540px)` to `clamp(220px, 28vw,
360px)`. The aerial map's framing changed from a fixed Leaflet zoom level to `map.fitBounds()`
against a real-world box built from a per-sport half-extent in meters (`STADIUM_HALF_EXTENT_M =
{ mlb: 95, nfl: 190 }`, see `metersToLatLngBox`/`ensureMap` in `index.html`) centered on the venue.
**Why:** Requested directly, in two rounds. First round: the picture was taking up too much screen
space and the stadium read as a small part of a wider aerial view. A fixed zoom (first landed on
18.4, checked live against Great American Ball Park/Fenway/Coors Field) fixed that on desktop. But
checking NFL stadiums at that same zoom (per the follow-up request "check other stadiums in NFL
too... crop it so the entire stadium is visible") showed SoFi Stadium's roof cropped down to
unrecognizable texture — NFL stadiums, especially large domes, are real-world bigger than MLB parks
on average, so one shared zoom couldn't fit both sports. Dropping to a looser NFL-only zoom (17.0)
fixed that, but checking mobile (per the same request) then showed MLB cropping too: the hero
container is both narrower AND shorter in absolute pixels on a phone than on desktop, so the same
zoom level shows meaningfully less real-world area there, cropping stadiums that fit fine on
desktop — a fixed zoom level only ever frames correctly at the one container size it was tuned
against.
**Fix:** replaced fixed zoom with `fitBounds` against a fixed real-world box (in meters, not
pixels/zoom) around each venue. This guarantees the same physical area is always fully visible
regardless of container size or aspect ratio — mobile just zooms out further automatically to fit
the same box, rather than cropping it. Box sizes were measured live off the largest venue in each
sport (Coors Field for MLB, SoFi Stadium for NFL) so every smaller venue also fits with margin.
**Verified live:** desktop and mobile (375×812), MLB (Great American Ball Park, Fenway, Coors) and
NFL (Lumen Field, SoFi, Soldier Field, Ford Field, AT&T Stadium, Allegiant Stadium, Bank of America
Stadium) — no cropping on any of them, including known-oddly-shaped Soldier Field. `lat`/`lon` in
`data/stadiums.js` are still venue centroids, not survey-grade, so a specific park could still be
off-center within its box; revisit with real per-venue footprint data if one looks wrong.

## Almanac: aggregate across all similar-weather games, not just the single closest match
**Date:** 2026-09-02
**Decision:** `findAlmanacMatch` (single closest day) replaced with `findAlmanacAggregate`. It still
pulls every home game in a +/-5 day window across the last 15 years and scores each by
`weatherDistance` against today, but instead of keeping only the #1 closest day, it now keeps every
day within a similarity cap (`ALMANAC_DIST_CAP = 9`, roughly within ~7F/~4mph of today) up to 20
games, and averages their real combined runs/HRs. If fewer than 6 games qualify under the cap (a
real possibility for uncommon weather at a given park), the cap is relaxed to take the 6 closest
regardless, flagged as `looseMatch: true` so the UI can say the sample isn't as tightly matched
rather than silently presenting it as equally reliable.
**Why:** A single closest-match day can be a statistical outlier (a 15-run blowout on a day whose
weather happened to line up closest) and reads as "here's what this weather does" when it's really
one data point. Averaging across every genuinely similar day answers "what does this weather
usually produce" instead.
**API/cache change:** `/api/almanac` response field renamed `match` -> `aggregate` (now `{
sampleSize, looseMatch, avgWeather, avgCombinedRuns, avgCombinedHomeRuns, games[] }`). Cache key
prefix changed `almanac:` -> `almanac-agg:` specifically so the new code never deserializes an old
single-match-shaped cached entry left over from before this change. Frontend now shows the two
averages up top, a one-line similarity note (sample size + avg conditions), and a compact list of
the individual comparable games (capped display of 6, "+N more" for the rest) underneath for
transparency/drill-down.

## Detail view: game strip for jumping between games without returning to the grid
**Date:** 2026-09-02
**Decision:** Added a horizontal strip of condensed game pills (`#gameStrip`) at the top of the
game-detail view, populated from the same `currentGames` list backing the front-page grid, with the
currently-viewed game highlighted. Clicking a pill calls `showDetail` directly — it does not
navigate back through the grid. The "All games" back button is unchanged and still returns to the
grid view.
**Why:** Requested directly — comparing conditions across several games in a slate previously
required going back to the grid and re-clicking each time.

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
