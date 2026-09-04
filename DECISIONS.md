# Decisions Log

A running record of why key architectural and data-source choices were made in this project, so
future work doesn't re-litigate settled questions. Newest at the top. Same format/spirit as the
racing command center's `DECISIONS.md`.

---

## Per-park wind sensitivity multiplier, and a wind-coefficient re-check
**Date:** 2026-09-04
**What shipped:** a real, per-park `windSensitivity` multiplier (`data/stadiums.js`) applied to the
wind-carry term in `windCarryAt` (`rules-engine.js`) — 1.0 = league-average, ranges 0.5-1.8 across
real MLB parks. Before this, every park's wind effect scaled off the same generic coefficient
regardless of the park's own physical wind exposure, even though this project already knew (from the
user-shared Statcast wind-effect charts and the WAM/CFD article, see the umpire/park-factor entries
above) that real parks vary a lot here — PNC Park is one of the least wind-affected parks in MLB
despite being open-air, Wrigley and Coors are among the most.

**Source and derivation**: Baseball Savant's own park-factors leaderboard (already scraped for the
`parkFactor` feature) breaks each park's seasonal distance factor into temperature/elevation/roof/
environment sub-factors — `environment_extra_distance` is the residual after those three are removed
(humidity, wind, everything else), so using it doesn't double-count the separately-modeled altitude
bonus. Fetched this for 5 real seasons (2021-2025) per park, took the average of |environment_extra_
distance| across those years (a season's signed value can partially hide true day-to-day volatility
if wind blows both directions roughly equally over a season — noted as a real caveat, not swept under
the rug), then scaled every park relative to the league mean and clamped to [0.5, 1.8] so one noisy
season can't produce an extreme multiplier.

**Two real data-contamination bugs caught and fixed during derivation**, both from the same root
cause: Baseball Savant's `main_team_id` is stable across a franchise relocating home parks within the
window, so a naive multi-year fetch silently blends two different, unrelated stadiums under one key.
- Athletics: played 2021-2024 at the since-demolished Oakland Coliseum before moving to Sutter Health
  Park in 2025 (the park this file actually models them at). Only the 2025 datapoint is real for the
  park in question, and one season is too small a sample to trust — defaulted `ATH` to a neutral 1.0
  rather than build a multiplier off a single data point (also consistent with `cfBearingDeg`, which
  already treats ATH as unsourced for the same reason — no historical MLB tenancy to draw on).
- Rays: Tropicana Field (the dome `TB` is coded as) was hurricane-damaged and the team played their
  entire 2025 season at the outdoor George M. Steinbrenner Field instead — a real park, just not the
  one this file models TB as. Excluded 2025 from TB's average, used the remaining 4 real Tropicana
  Field seasons. (Moot in practice either way, since `windCarryAt` already zeroes wind entirely for
  any closed-roof venue — but the multiplier is stored correctly regardless, ready for the roof-
  status work below.)

**Re-ran the real 2025-season backtest after applying this** (`scripts/backtest-carry-model.js`):
the gap-maximizing threshold got noisier/flatter (peaks bouncing between T=18 and T=32, gaps 1.05-
1.30, vs. a cleaner single peak near T=20 before) but `CARRY_LEAN_THRESHOLD_FT` (20) still sits in a
reasonable position with healthy bucket sizes (n=608/242) — kept as-is rather than chase a noisier
peak with thinner buckets.

**Also added a coefficient sweep to the same backtest script**, at the user's request to "tighten"
`WIND_CARRY_FT_PER_MPH` (3.5): swept 2.5-4.5 ft/mph, each candidate re-optimizing its own best
threshold (a fair comparison, since a bigger coefficient should pair with a bigger cutoff) rather than
just re-scoring the existing 20ft cutoff. Real finding: **the achievable gap barely moves across that
whole range (1.29-1.36)** — correlation itself can't distinguish coefficients at all (it's scale-
invariant, a rescaled predictor has identical correlation), and the threshold-based gap metric that
CAN distinguish them shows no meaningfully-better value than what's already there. 3.5 also still sits
inside the range independently implied by Dr. Alan Nathan's public Statcast-based estimate (~3.8ft at
5mph, i.e. 3.8ft/mph) shared by the user earlier. Concluded: **no change** — a legitimate outcome of
tightening a parameter, not a failure to find one. Left `WIND_CARRY_FT_PER_MPH` at 3.5, documented as
a named constant (previously an inline number) for future re-checks.

---

## Real career hitter/pitcher umpire lean, derived from full history (2015-present)
**Date:** 2026-09-04
**What shipped:** the entry below this one shipped umpire tendencies without a hitter/pitcher-lean
claim, because UmpScorecards' season leaderboard has no such metric. The user asked to use the
site's full historical data (back to 2015) to derive one properly instead of leaving the gap.

**Found a real signal**: UmpScorecards' per-umpire page hits a different, undocumented endpoint --
`umpscorecards.com/api/single-umpire?umpire=NAME&startDate=...&endDate=...` -- returning one row per
game with `home_batter_impact`/`away_batter_impact`/`home_pitcher_impact`/`away_pitcher_impact` (run-
value impact split by which side of the pitch benefited, not by home/away team). Checked across a
97-game sample: `(home_batter_impact + away_batter_impact)` exactly equals
`-(home_pitcher_impact + away_pitcher_impact)` in every single row, zero mismatches -- a genuine
zero-sum split between batters and pitchers. Summed across an umpire's full career, that's a real,
derivable "did this umpire's misses net help batters or pitchers" number, distinct from
UmpScorecards' own team-based "favor" metric already shown as `avgFavorRuns`.

**Calibrated the threshold from real data, not a guess**: fetched full 2015-present career history
for all 91 currently-active umpires, computed each one's career-average batter-impact-per-game. Real
distribution: min -0.58, p25 -0.198, median -0.094 (skews slightly pitcher-ward league-wide), p75
+0.023, max +0.41 runs/game. `LEAN_HITTER_THRESHOLD` (0.02) / `LEAN_PITCHER_THRESHOLD` (-0.2) in
`weather-worker.js` are that snapshot's real p75/p25 -- top quartile of active umpires = "hitter"
lean, bottom quartile = "pitcher" lean, middle 50% = "neutral". `MIN_CAREER_GAMES` (20) gates small-
sample noise -- 5 of the 91 active umpires had under 20 career games in that snapshot, one of them a
9-game sample sitting at an extreme -0.43 that's clearly noise, not signal, this early.

**A third and fourth AI-narration failure on this exact feature, in the same session** (see the
entry below for the first two): even a real, correctly-derived number wasn't safe from this model.
Told to state a pre-written career-lean sentence "with nothing added before or after it within the
same sentence," it obeyed literally -- inserted the sentence intact, then appended an entirely new
sentence with a fabricated zone-size claim ("batters are likely to see more balls and fewer
strikes") anyway. Nine documented failures of the same shape, across every different wording tried
this session, was enough: stopped trying to phrase around it. **The umpire is no longer described to
the model at all** -- neither season accuracy/consistency nor career lean appears in the prompt sent
to Workers AI. Both are built as a plain string in code and appended directly to the model's response
after the AI call returns, in `narrate()`. There is nothing left to embellish because the model never
sees the umpire data in the first place -- same end state this file already reached for the LF/CF/RF
field-carry numbers (shown correctly in the UI, no longer described by the model at all).

**UI**: the "Hitter Lean"/"Pitcher Lean"/"Neutral Lean" tag next to the umpire badge reuses the exact
`good`/`info`/`neutral` color convention already used for the MLB scoring-lean pill, so it reads at a
glance without introducing a new visual language.

---

## Statcast park factors and umpire tendencies, MLB detail view
**Date:** 2026-09-04
**What shipped:** two new real, free data sources joined into `/api/game` (MLB only) and shown in
the UI and AI insight, alongside the existing weather/carry model — not replacing it.

- **Park factor**: Baseball Savant's Statcast park-factors leaderboard
  (baseballsavant.mlb.com/leaderboard/statcast-park-factors) embeds its full current-season dataset
  as a plain `var data = [...]` JS array in server-rendered HTML — no auth, no JS execution, no CSV
  endpoint needed (checked; `&csv=true` just re-serves the same page). `fetchParkFactors` regex-
  extracts and parses it, joins on `main_team_id` via the existing `MLB_TEAM_ID_TO_KEY` map, caches
  24h (season-aggregate, changes slowly). Shown as its own "Park Factor" stat-pair (a season-long,
  weather-independent %) rather than folded into "Est. Carry," so it's never mistaken for part of
  today's forecast.
- **Umpire tendencies**: today's home-plate umpire comes from the MLB Stats API schedule endpoint's
  `hydrate=officials` (added to the existing `fetchMlbSchedule` call, one extra hydrate, no new
  request), matched by name against UmpScorecards' public API
  (umpscorecards.com/api/umpires?startDate=...&endDate=...&seasonType=R), cached 24h. MLB doesn't
  publish crew assignments until a few hours before first pitch — confirmed live, every game showed
  an empty `officials` array most of the day, one game got its assignment ~2 games before first
  pitch — so this silently goes from "no umpire shown" to populated as the day progresses; no code
  path depends on it being available early.
- **Deliberately NOT labeled "hitter-friendly/pitcher-friendly"**: UmpScorecards' own site describes
  its mission as measuring "accuracy, consistency, and favor" — "favor" is which TEAM an umpire's
  incorrect calls tended to benefit (run-impact terms), not a strike-zone-size rating. There is no
  published zone-size metric to hang a hitter/pitcher framing on, so the UI and prompt show accuracy/
  consistency honestly instead of forcing a framing the data doesn't support.

**Two real AI-narration bugs found in this feature's own testing** (same model, same documented
history of mishandling anything beyond "restate this one pre-resolved fact" — six prior failures on
the wind narration alone, see the entry below):
1. Handed a signed park-factor percentage (e.g. -3.5), the model dropped the minus sign and said
   "3.5% extra... natural fly-ball advantage" — backwards. Fixed by resolving hitter-friendly/
   pitcher-friendly in code and handing the model a pre-labeled phrase, never a raw signed number to
   interpret (same fix shape as the windIsOut fix below).
2. Even with an explicit "do not claim favors hitters/pitchers or zone size" ban, the model dodged
   those exact phrases and invented "hitters can expect... a relatively high chance of being called
   out on strikes" — an unsupported strikeout-rate claim, live-caught against a real assigned umpire
   (Tom Hanahan, Progressive Field). Banning specific phrases didn't work; fixed by shrinking the
   umpire's role to "state these two numbers, once, as a brief aside" with an explicit ban on
   connecting them to any in-game outcome (strikeouts, walks, pace, scoring) at all, not just the
   original banned phrases.

Both the insight cache key (already includes `windZone`, see below) now also includes `umpire.name`
— required, not optional: without it, every game at the same venue/day/weather would share one
cached insight regardless of which umpire is actually working it.

**Verification gap, noted honestly**: the park-factor fix was verified against a real live AI call.
The umpire fix's SECOND guard (banning outcome-prediction, not just banned phrases) was also verified
against a real live AI call once a real umpire assignment appeared mid-session — both fixes are
confirmed working against the actual deployed model, not just reasoned about.

---

## Real per-park wind orientation data (Clem's Baseball), and a wrong-field AI-narration bug
**Date:** 2026-09-03
**AI narration bug (found first, real root cause of a live user report):** the user flagged that
wind blowing IN at PNC Park was still being narrated as favoring home runs there. The rules-engine
output (`fieldCarry`, `windZone`) was already correct -- the bug was in `weather-worker.js`'s prompt
builder, which decided whether to tell the model "this is an INCREASE" or "a REDUCTION" in carry by
checking `score.carryFt`, which is **always the center-field number**, regardless of which field
`windZone` actually names. When wind hit left or right field hardest while center happened to read
the opposite sign, the model was handed backwards framing and (correctly, given what it was told)
wrote text that contradicted the real per-field numbers. Fixed by deriving the framing from
`windZone`'s own "out toward"/"in from" wording instead, which always matches whichever field it
names. Also added `score.windZone` into the AI-insight cache key (it was keyed on `windCompass`
before, a proxy for the prompt's actual input, not the input itself) so a future fix like this one
invalidates stale cached insight text immediately instead of leaving it served for up to 6 more
hours.

**Full per-park orientation audit, requested after the above fix (a *different*, deeper problem):**
investigating the PNC Park report also surfaced that `cfBearingDeg` itself was wrong for PIT (315,
should be ~112.5) -- and the file's own comment admitted why: most parks had never been individually
measured, just defaulted to a generic 67.5 (ENE, "what MLB Rule 1.04 recommends") "as a first pass."
Tried to fix this by eyeballing real aerial photos (Esri World Imagery via a static-export endpoint)
for all 30 parks, first by hand, then with a Python/PIL/scipy connected-component script to find each
field's grass blob and its major axis programmatically. **Both approaches turned out to be too
imprecise to trust**: a sanity check against Fenway Park (whose real orientation, ~45 NE, is about as
well-documented as any fact in the sport) showed the two visual methods disagreeing with each other
by ~80 degrees, and the programmatic version clustered ~15 different real stadiums suspiciously close
to due north -- a strong sign of a systematic bias in the pixel-reading itself, not a real pattern.
Abandoned pixel-measurement entirely in favor of a real source: **Clem's Baseball**
(andrewclem.com/Baseball/Stadium_statistics.html), a long-established stadium-history reference
citing Lowry's "Green Cathedrals," Ritter, and the ESPN Sports Almanac, with a specific "CF
Orientation" column for every park plus a load-bearing validating rule -- "no MLB stadium is oriented
toward any direction between 150 and 315 degrees" -- that this session's own earlier PIT guess (180,
picked from the eyeballed photo) and SF guess (22.5) both violated. Recalibrated all 29 real MLB
parks' `cfBearingDeg` against this source (only `ATH`, Sutter Health Park, has no entry -- it's a
temporary AAA facility with no MLB tenancy history -- so its old default value was left in place,
unsourced). Re-ran `scripts/backtest-carry-model.js` against the full real 2025 season under the
corrected bearings: `CARRY_LEAN_THRESHOLD_FT` (20ft) is still right around the gap-maximizing cutoff
(1.26 at T=20 vs. a maximum of 1.28 at T=28, with T=20 keeping healthier bucket sizes) and the overall
carryFt distribution barely moved (p50 14.7ft, p75 27.8ft vs. the original calibration's 14.4/28.6) --
so no threshold change was needed despite ~20 of 29 parks' bearings changing, often substantially.
Also fixed `rules-engine.test.js`'s Yankee Stadium per-field-carry test, which hardcoded a
`windFromDeg` computed from NYY's *old* bearing (0) and silently broke once NYY's bearing corrected
to 67.5 -- now derives the wind direction from the venue's own `cfBearingDeg` at test-run time, same
self-adjusting pattern the Coors Field test already used, so a future bearing correction can't break
it silently again.
**Lesson for future sessions:** don't trust a single self-derived aerial-photo reading for orientation
claims beyond the one-off, well-corroborated case (PIT's downtown-skyline fact was strong enough on
its own); a real per-park sourced dataset is worth the extra search effort before touching this file
again.

---

## Redesign follow-ups: manual theme toggle, first-load map race condition, PNC Park orientation fix, wind-arrow rework
**Date:** 2026-09-03
**Manual light/dark toggle:** the redesign only ever reacted to OS `prefers-color-scheme`, with no
way to override it. Added a half-moon button (`#themeToggle`) next to the sport switcher that sets
`document.documentElement.dataset.theme` to `"dark"`/`"light"`. Both sport theme blocks already had
a light-default + dark-media-query cascade; restructured each to add an explicit
`html[data-sport="x"][data-theme="dark"|"light"]` override block (guarded with `:not([data-theme=...])`
on the media-query blocks) so a manual pick wins over system preference in either direction. State
resolves from `dataset.theme` first, falling back to `matchMedia` only when unset — a naive boolean
flip gets stuck once an explicit value exists.

**First-load aerial map bug (found, fixed):** on a hard reload, clicking straight into the first game
sometimes rendered the Leaflet map fully zoomed out (a world tile at `z=0`) instead of the stadium.
Switching venues afterward always framed correctly. Root cause: `ensureMap()` called `.fitBounds()`
synchronously as part of map creation, with no `invalidateSize()` first — the container's layout
wasn't always settled yet on a genuinely first paint, and the existing `setTimeout(150)` safety net
didn't reliably catch it. Fixed by making map creation and re-use both fall through to one shared
path that unconditionally calls `invalidateSize()` immediately before `fitBounds()`; the delayed
re-fit stays as a second safety net.

**PNC Park orientation was wrong:** `cfBearingDeg` for PIT was coded as 315° (NW). Prompted by a
user question about wind at PNC Park seeming to help hitters despite blowing "in," re-examined the
venue with the (now-fixed) aerial photo — PNC Park's defining feature is the downtown Pittsburgh
skyline visible beyond the outfield wall, which sits across the Allegheny River roughly south of the
park, not northwest. Pixel-measured the real aerial photo's diamond orientation directly (home plate
to the deepest point of the outfield wall) and got ~187°, confirming the true bearing is close to due
south, not 315°. Corrected to `cfBearingDeg: 180`. This only affects PIT — every other venue's
bearing was left untouched since this was a single bad data entry, not a systemic issue. The
wind FROM/TOWARD math itself was independently re-verified correct before making this change.

**Wind-flow-arrows visual rework:** replaced the old 150-particle short-dart/hard-chevron trail
system with fewer (90), longer (26-point) streaklines that curl gently via a per-particle two-frequency
sine wobble instead of running dead-straight, taper in width and fade from a dim to a near-white gold
along their length, and end in a soft additive-blend glow instead of a flat triangle arrowhead. Tints
itself from the active sport's `--accent-ai` token (re-read every ~40 frames, not every frame) so it
follows both sport and theme. Same dark-outline-then-color legibility trick as before, since it still
draws over a live, brightness-varying satellite photo.

---

## Redesign shipped: "Diamond Atmospherics" (MLB) / "Gridiron Pressure" (NFL), plus a suite landing page
**Date:** 2026-09-03
**Decision:** Replaced the live "Vintage Diamond" (MLB) and "Gridiron" (NFL) themes with a new
instrument-panel visual identity, approved the prior session as a standalone concept mockup (see
the two published Artifacts referenced in memory) and pushed live here. Same `html[data-sport]`
token-swap mechanism as before, values carried over from the approved mockup: MLB gets a warm
stadium-lights-amber + storm-front-blue two-accent palette on a cool near-white/near-black ground
(Big Shoulders Display + IBM Plex Sans + IBM Plex Mono); NFL gets cold steel/frost with a
chain-gang-gold accent (Anton + Barlow Semi Condensed + Space Mono). Golf and Tennis stay exactly
as they already were — disabled "Coming soon" buttons — since neither has a real backend or data
source; no functionality was invented for them.
**Deliberately kept, not replaced:** the real Leaflet aerial satellite photo of the stadium and the
wind-flow-arrows canvas layered on it. The approved mockup used an abstract line-drawing schematic
instead, but that was specifically a workaround for the Artifact sandbox's CSP blocking external
map tiles — not a genuine preference over real imagery, which the live site has no such
restriction on and which is a real, working, valuable existing feature.
**New components, not just a reskin:**
- Circular arc gauges (temp/humidity/wind) replace the old flat stat chips.
- An analog wind-rose compass dial overlays the aerial photo, needle rotated to the TOWARD bearing
  (`(windFromDeg + 180) % 360`) — same conversion already used by `score.windCompass` and the
  wind-flow canvas, so all three now visibly agree with each other by construction.
- MLB's LF/CF/RF carry re-rendered as a center-zero bidirectional bar with the real, backtested
  `CARRY_LEAN_THRESHOLD_FT` (20ft, see the recalibration decision below) marked on it, instead of
  three flat pass/fail boxes. Found and fixed a real staleness bug in the process: the old box
  coloring used a hardcoded +-12ft cutoff left over from before that recalibration, silently out of
  sync with the actual +-20ft threshold driving `scoringLean` everywhere else.
- NFL's wind effect rendered as a single left-anchored magnitude bar off real wind speed against
  the same 10/15/20mph tiers the backend already classifies by — deliberately NOT a 3-row
  PASS/KICK/PUNT breakdown like MLB's, since the backend has no real per-play numeric output to
  drive one and inventing those numbers would mean shipping fiction, not a redesign.
- A real hourly wind-speed sparkline leading into game time, **not decorative**: the backend
  already fetches the full Open-Meteo hourly array for the point-forecast feature but only
  returned the single matched hour; `fetchWeather` now also returns `weather.windTrend` — the 7
  hours anchored straight into the matched game-time hour (chosen over anchoring to "now" so a
  game days out still gets a fixed, meaningful 8-point trend rather than an oddly long or
  subsampled one). Only populated on the forecast path (`windTrend: null` on the current-conditions
  path) — the sparkline panel hides itself when absent.
- A new suite landing page (`#landingView`), shown before any sport is picked: one tile per sport
  (Diamond Atmospherics, Gridiron Pressure, Links & Lie, Advantage Court), each carrying its own
  accent color via inline `--tile-accent`/`--tile-accent-2` custom properties rather than a full
  page theme, since Golf/Tennis don't have pages to theme yet. Reachable at any time via the
  GiddyUpSports wordmark, now a button.
**Verified live** (not just visually eyeballed) across MLB and NFL, light and dark, desktop and
mobile widths, with real data from real games — including confirming the wind-rose needle, the AI
narration's windZone text, and score.windCompass all agree on direction, and that the sparkline's
real 8-point trend renders correctly end to end from the new backend field.
**Explicitly deferred** (per the approved plan, not forgotten): Golf/Tennis running on invented
data, and per-sport front-page grid styling beyond what MLB/NFL already share — both stay on the
punch list, not built here.

## Tried and reverted: barometric pressure as a carry-model input
**Date:** 2026-09-02
**Tried:** added `pressure_msl` (mean-sea-level pressure, hPa) to `scoreMlbGame`'s `baseCarryFt` —
same air-density mechanism as the existing altitude term, but day-to-day rather than fixed per
venue. Coefficient (0.23ft per hPa below the 1013.25hPa standard) was derived for internal
consistency with the existing altitude term's own implied rate (its ~40ft bonus at Coors' 5280ft
corresponds to a ~174.75hPa drop in standard atmosphere). Applied regardless of roof status, unlike
temp/humidity, since current MLB roofs are rigid structures that don't pressurize their interior
the way an old air-supported dome design would have. Threaded through `fetchWeather` (both the
current-conditions and point-forecast paths) and the season backtest script.
**Result: reverted, not shipped.** Re-ran the same 2025-season backtest with pressure included:
r moved from 0.1172 to 0.1177 — a difference of 0.0005 against a standard error of ~0.024 at this
sample size (n=1,786), i.e. about 2% of one standard error. Indistinguishable from zero. The
hitter-vs-pitcher-friendly scoring gap at the same 20ft threshold was actually very slightly worse
with pressure included (1.30 vs. 1.37 runs) — also within noise, but certainly no improvement
either way. Concluded the coefficient's physical derivation, while internally consistent, doesn't
translate into a detectable real-world signal at the pressure swings MLB games actually see
(typically a much narrower day-to-day range than the ~175hPa spread used to derive the rate from
Coors' altitude) — reverted rather than ship complexity with no measured benefit.
**Why this is worth keeping on record:** avoids re-attempting the same idea later without knowing
it was tried and tested. If revisited, the open question is whether the coefficient itself needs
a different derivation (not assuming linear consistency with the altitude term across such
different scales of pressure change), not whether pressure matters at all in principle.
**Not affected:** this was purely an addition on top of the recalibrated 20ft threshold below —
reverting it changed nothing about that recalibration, which remains live.
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
