// Deterministic weather-impact scoring for MLB and NFL games. No network calls, no API keys —
// pure functions over { weather, venue } so they're unit-testable in isolation (see rules-engine.test.js)
// and cheap to run inside the Worker before the AI narration step.
//
// Physics basis (see project research notes):
// - MLB carry: +3ft per +10F above 75F; higher humidity -> marginally *lower* air density -> marginally
//   more carry (water vapor is lighter than N2/O2); ~3-4ft of fly-ball distance per mph of wind blowing
//   out; Coors Field-style altitude bonus (~10% extra distance at 5280ft, scaled linearly by altitude).
// - NFL: passing/kicking accuracy holds up under ~10mph (NFL average), degrades noticeably 10-15mph,
//   significantly 15-20mph, severely past 20mph. Field goal % drops from ~83.8% (<10mph) to ~76.9%
//   (>20mph gusts). Indoor/closed-roof venues zero out all wind/precip effects.

// carryFt threshold for the hitter-/pitcher-friendly scoringLean label. Originally a round,
// hand-picked physics estimate (12ft); backtested against a full real season (2025, 1,786 games,
// scripts/backtest-carry-model.js) and recalibrated. Real finding: most MLB parks are oriented
// ~0-67.5deg (facing away from the setting sun, per MLB Rule 1.04 -- see data/stadiums.js), and
// real prevailing summer wind commonly blows FROM the SW toward that same range -- a genuine,
// physically real tendency for wind to blow out toward center field on a typical day, not a bug in
// the angle math (median real wind blew FROM ~202deg, i.e. TOWARD ~22deg, squarely inside that
// cluster). Net effect: the OLD 12ft cutoff sat below the real median carryFt (+14.4ft) --
// "hitter-friendly" was firing on 78% of real games, the opposite of a selective, notable label.
// 20ft sits between the real median and 75th percentile (median +14.4ft, p75 +28.6ft) and nearly
// doubles the real hitter-vs-pitcher-friendly scoring gap in backtesting (0.92 -> 1.37 runs) while
// keeping both flagged buckets a healthy size (750/308 out of 1,786) rather than over-thinning them.
const CARRY_LEAN_THRESHOLD_FT = 20;

// Feet of fly-ball carry added per mph of pure tailwind (a park's own windSensitivity, see
// data/stadiums.js, scales this further per venue). Originally an inline "3-4ft per mph" estimate
// (see the physics-basis comment above); cross-checked against a real external figure -- MLB
// Statcast physicist Dr. Alan Nathan's public estimate that 5mph of wind adds ~19ft, i.e. 3.8ft/mph
// -- which fell inside that same range without requiring a change. See DECISIONS.md for the
// 2026-09-04 backtest sweep that re-confirmed this value directly against real season outcomes
// (not just the physicist estimate) after windSensitivity was introduced.
const WIND_CARRY_FT_PER_MPH = 3.5;

function degToCompass16(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

// Below ~3mph, wind direction has no dominant driving force and is effectively noise -- caught
// live when an uncached query showed the reading swing ~180deg in under half an hour at Nationals
// Park. Showing a specific compass letter ("ENE") at that speed reads as more precise/confident
// than the data actually is, regardless of how fresh the fetch was. Same threshold already used
// to zero out direction-based carry/passing effects in scoreMlbGame/scoreNflGame below.
//
// weather.windFromDeg is the meteorological convention: the direction wind is blowing FROM. This
// function reports the opposite -- the direction it's blowing TOWARD, i.e. which way it's actually
// pushing a fly ball or a pass -- since that's what every carry/passing effect in this app is
// described in terms of ("blowing out toward right field") and what a general audience reads
// intuitively, without needing to mentally flip a "from" compass letter by 180deg. The carry/
// passing math (windCarryAt below, and the frontend's wind-flow arrows) already computes this
// TOWARD vector internally; this is just the one place a human-readable label gets built from it.
function windCompassOrVariable(weather) {
  if (weather.windSpeedMph < 3) return "variable";
  const towardDeg = (weather.windFromDeg + 180) % 360;
  return degToCompass16(towardDeg);
}

// Angle between two bearings, normalized to [-180, 180].
function angleDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * @param {object} weather - { tempF, humidityPct, windSpeedMph, windFromDeg, precipProbPct }
 *   windFromDeg is the meteorological convention: the direction the wind is blowing FROM.
 * @param {object} venue - MLB_STADIUMS[x] entry: { roofType, altitudeFt, cfBearingDeg }
 * @param {object} [roofStatus] - optional, from fetchGameRoofStatus in weather-worker.js:
 *   { known: boolean, roofOpen?: boolean }. Only ever overrides the default for a `retractable`
 *   venue -- a `dome` has no open state to confirm, and `open` venues don't need confirming. When
 *   omitted, or `known` is false (MLB hasn't published it yet for this game -- see
 *   fetchGameRoofStatus for why that's routine, not an error), falls back to the same conservative
 *   "assume closed" default this function always used before this parameter existed.
 */
function scoreMlbGame(weather, venue, roofStatus) {
  const roofStatusConfirmed = venue.roofType === "retractable" && roofStatus?.known === true;
  const roofClosed = roofStatusConfirmed ? !roofStatus.roofOpen : venue.roofType !== "open";
  const notes = [];

  // Air density / carry index, in estimated feet of extra fly-ball distance vs. a 70F/50%RH/sea-level
  // baseline. This part is direction-independent -- it applies the same to a ball hit anywhere in the park.
  //
  // Temperature/humidity are outdoor readings -- real, and physically what drives carry, but only
  // when there's outdoor air to feel them. When the roof is closed the interior is climate-
  // controlled, so those two stop applying entirely (a real bug found live: a 97F day outside a
  // closed-roof Globe Life Field was still adding +10.5ft of "carry" driven by that outdoor heat,
  // directly contradicting this same function's own roofClosed framing everywhere else, and the
  // AI narration's "temperature has no bearing" text right next to that very number). Altitude is
  // different -- it's the venue's fixed elevation/air pressure, not outdoor weather, so it still
  // applies indoors (moot for every current MLB dome, none of which sit at real altitude, but
  // correct in principle and free to keep).
  let baseCarryFt = 0;
  if (!roofClosed) {
    const tempDelta = weather.tempF - 75;
    baseCarryFt += (tempDelta / 10) * 3; // colder air costs distance symmetrically to how hot air adds it
    baseCarryFt += (weather.humidityPct - 50) / 50 * 2; // small humidity nudge, +2ft at 100% RH vs 50%
  }
  const altitudeBonusFt = (venue.altitudeFt / 5280) * 40; // ~40ft (~10% of a 400ft flyball) at Coors-level altitude
  baseCarryFt += altitudeBonusFt;
  if (altitudeBonusFt > 15) notes.push(`Elevation (${venue.altitudeFt}ft) adds an estimated +${altitudeBonusFt.toFixed(0)}ft of carry.`);

  // Wind component, evaluated separately at three bearings approximating the pull direction to each
  // field -- foul lines run roughly +/-45deg off the park's home-plate->CF bearing, so that's used as
  // a stand-in for "toward left field" / "toward right field". windFromDeg is where wind comes FROM;
  // the vector it blows TOWARD is windFromDeg + 180.
  //
  // venue.windSensitivity (added 2026-09-04, see data/stadiums.js) scales this per park -- real MLB
  // parks vary a lot in how much wind actually reaches the field beyond what geometry alone predicts
  // (PNC Park's enclosed bowl is famously wind-sheltered; Coors and Oracle Park are famously not),
  // and this term had no way to represent that before. Falls back to 1.0 (league-average, i.e. no
  // change from before this field existed) if a venue somehow lacks it.
  function windCarryAt(targetBearingDeg) {
    if (roofClosed || weather.windSpeedMph < 3) return 0;
    const blowsToward = (weather.windFromDeg + 180) % 360;
    const diff = angleDiff(blowsToward, targetBearingDeg); // 0 = blowing straight out toward that bearing
    const sensitivity = venue.windSensitivity ?? 1.0;
    return Math.cos((diff * Math.PI) / 180) * weather.windSpeedMph * WIND_CARRY_FT_PER_MPH * sensitivity;
  }

  // Facing center field from home plate, right field is to the right (+45deg), left field to the left.
  const rfBearing = (venue.cfBearingDeg + 45) % 360;
  const lfBearing = (venue.cfBearingDeg - 45 + 360) % 360;
  const cfWindCarryFt = windCarryAt(venue.cfBearingDeg);
  const rfWindCarryFt = windCarryAt(rfBearing);
  const lfWindCarryFt = windCarryAt(lfBearing);

  const fieldCarry = {
    left: Math.round((baseCarryFt + lfWindCarryFt) * 10) / 10,
    center: Math.round((baseCarryFt + cfWindCarryFt) * 10) / 10,
    right: Math.round((baseCarryFt + rfWindCarryFt) * 10) / 10,
  };
  const carryFt = fieldCarry.center; // kept as the headline number, same value as before this split

  // Pull hitters skew the platoon advantage: right-handed batters predominantly pull fly balls
  // toward left field, left-handed batters toward right field. So extra carry toward LF favors
  // RHB power, extra carry toward RF favors LHB power. Small deltas aren't meaningful -- require
  // a real gap (8ft, roughly the same order as the wind-out-to-CF carry threshold below) before
  // calling it either way.
  const handedDeltaFt = Math.round((fieldCarry.right - fieldCarry.left) * 10) / 10;
  const handedness =
    roofClosed || Math.abs(handedDeltaFt) < 8
      ? { favors: "neutral", deltaFt: handedDeltaFt }
      : handedDeltaFt > 0
        ? { favors: "left", deltaFt: handedDeltaFt } // RF carries more -> favors left-handed pull power
        : { favors: "right", deltaFt: handedDeltaFt }; // LF carries more -> favors right-handed pull power

  // Classify by whichever of the three fields the wind is actually affecting most, rather than
  // hand-tuned angle buckets on the CF bearing alone -- the previous version only recognized wind
  // blowing OUT toward center (diff near 0) as a "center" case, so wind blowing almost directly IN
  // from center (diff near +/-180, the opposite extreme) fell through every bucket and was
  // mislabeled "mostly crosswind" even though cfWindCarryFt was the largest, most negative number
  // of the three. Picking by magnitude handles every angle correctly by construction.
  let windZone = "calm";
  if (!roofClosed && weather.windSpeedMph >= 3) {
    const candidates = [
      { name: "center", ft: cfWindCarryFt },
      { name: "right field", ft: rfWindCarryFt },
      { name: "left field", ft: lfWindCarryFt },
    ];
    const strongest = candidates.reduce((a, b) => (Math.abs(b.ft) > Math.abs(a.ft) ? b : a));
    windZone =
      Math.abs(strongest.ft) < 1
        ? "calm"
        : `blowing ${strongest.ft > 0 ? "out toward" : "in from"} ${strongest.name}`;
  } else if (venue.roofType === "dome") {
    notes.push(`${venue.venue} is a fixed dome — always closed, so wind has no effect here.`);
  } else if (roofClosed && roofStatusConfirmed) {
    notes.push(`${venue.venue}'s roof is confirmed closed for this game — wind has no effect.`);
  } else if (roofClosed) {
    notes.push(`${venue.venue}'s retractable roof status isn't known yet — MLB usually doesn't publish it until close to game time (see DECISIONS.md). Assuming closed until confirmed; verify before relying on this.`);
  }

  const scoringLean =
    carryFt > CARRY_LEAN_THRESHOLD_FT ? "hitter-friendly" : carryFt < -CARRY_LEAN_THRESHOLD_FT ? "pitcher-friendly" : "neutral";

  return {
    sport: "MLB",
    roofClosed,
    roofStatusConfirmed, // true only when a retractable venue's status came from fetchGameRoofStatus, not the default assumption
    carryFt: Math.round(carryFt * 10) / 10,
    fieldCarry,
    handedness,
    windZone,
    windCarryFt: Math.round(cfWindCarryFt * 10) / 10,
    windCompass: windCompassOrVariable(weather),
    scoringLean,
    notes,
  };
}

// Wind/passing and wind/FG-range claims below were AUDITED 2026-09-06 against real 2020-2025 data
// (nflverse's games.csv + stats_team_week, joined by game_id -- see scripts/nfl-accuracy-audit
// findings recorded in project memory). Two very different outcomes:
//
// PASSING: real, confirmed, monotonic. Using CPOE (completion % over expected -- isolates real
// accuracy from play-calling changes, unlike raw completion% which can be inflated by teams
// shifting to safer short throws in wind) across the SAME <10/10-15/15-20/20+ mph tiers already
// used here: light +1.87, moderate +0.40, strong +0.13, severe -2.57. A real step-change sits right
// around 20mph, validating the "severe" cutoff specifically.
//
// FIELD GOALS: the OLD "~77% FG% in severe wind" claim had NO real support and has been removed.
// Checked three ways against real data: raw FG% by wind tier (no decline -- if anything a slight
// increase at higher wind, likely because kickers/coaches favor shorter/safer attempts in tough
// wind); average attempted distance by wind tier (barely changes, 39.0yd calm vs 36.3yd severe --
// not a large shift); and, most tellingly, 40+-yard attempts ONLY (like-for-like distance, isolates
// wind's real effect): 74.6% made at 0-10mph vs 81.3% at 20+mph -- no decline even distance-adjusted.
// Caveat: this only measures wind SPEED, not direction relative to the kick (a kick WITH the wind
// vs INTO it isn't distinguishable in this box-score-level data), which could be masking a real
// directional effect this analysis can't see -- and the 20+mph sample is small (n=93 team-weeks,
// 32 individual 40+yd kicks). Genuinely inconclusive, not "proven no effect" -- so the language
// below says exactly that, rather than either the old fabricated number or an overcorrected claim.
/**
 * @param {object} weather - { tempF, humidityPct, windSpeedMph, windFromDeg, precipProbPct }
 * @param {object} venue - NFL_STADIUMS[x] entry: { roofType }
 */
function scoreNflGame(weather, venue) {
  const roofClosed = venue.roofType !== "open";
  const notes = [];

  if (roofClosed) {
    // A dome has no real ambiguity -- always closed, always confirmed. A retractable roof does:
    // real 2020-2025 data shows these 5 venues actually play with the roof OPEN somewhere between
    // 6% (DAL, HOU) and 22% (ATL) of games (ARI 16%, IND 16%) -- this app has no live per-game
    // roof-status source for NFL (unlike MLB's fetchGameRoofStatus, which uses MLB's own live game
    // feed), so "closed" here is a real, unconfirmed ASSUMPTION, not a fact. roofStatusConfirmed
    // mirrors the same field/meaning MLB's roof-status feature already uses, so this can get the
    // same honest "assumed, not confirmed" UI treatment rather than being stated as certain.
    const isRetractable = venue.roofType === "retractable";
    return {
      sport: "NFL",
      roofClosed: true,
      roofStatusConfirmed: !isRetractable,
      windTier: "none (closed roof)",
      passingImpact: "none",
      fgRangeImpact: "none",
      notes: isRetractable
        ? [
            `${venue.venue}'s retractable roof status isn't confirmed for this game — assumed closed. Real data shows these venues actually play open somewhere between 6-22% of the time depending on the team, so today's wind/precip readings could be wrong if the roof is actually open.`,
          ]
        : [`${venue.venue} is a fixed dome — always closed, so wind/precip effects don't apply.`],
    };
  }

  const w = weather.windSpeedMph;
  let windTier, passingImpact, fgRangeImpact;
  if (w < 10) {
    windTier = "light";
    passingImpact = "negligible — real data shows passers at or above expected accuracy in this range";
    fgRangeImpact = "full range — no real accuracy penalty at this wind speed";
  } else if (w < 15) {
    windTier = "moderate";
    passingImpact = "a modest real dip in accuracy vs. expected begins here";
    fgRangeImpact = "full range — real data shows no clear FG accuracy drop at this wind speed, even for long attempts";
  } else if (w < 20) {
    windTier = "strong";
    passingImpact = "a clearer real accuracy drop, expect a more run-leaning game plan";
    fgRangeImpact = "full range — real data still shows no clear FG accuracy drop here, though kickers may favor shorter attempts when they have the choice";
  } else {
    windTier = "severe";
    passingImpact = "the clearest real accuracy drop of any tier — deep passing least reliable";
    fgRangeImpact = "inconclusive at this wind speed — real data shows no consistent FG accuracy drop, but the sample of real 20mph+ games is small; treat either way with caution";
  }

  if (weather.precipProbPct >= 50) notes.push("High precipitation chance — expect more ball-security caution and a run-heavier script.");
  if (weather.tempF <= 32) notes.push("Freezing temps historically correlate with lower scoring and a run-leaning game plan.");

  return {
    sport: "NFL",
    roofClosed: false,
    roofStatusConfirmed: true, // no roof at all in play -- an open-air "open" venue has nothing to confirm
    windTier,
    windCompass: windCompassOrVariable(weather),
    passingImpact,
    fgRangeImpact,
    notes,
  };
}

// ---- Run Environment Score (composite "unique algorithm") ----
//
// Combines today's weather-driven carry, this park's season-long Statcast park factor, the
// home-plate umpire's career hitter/pitcher lean, and both starters'/lineups' HR tendencies into
// one composite rating -- this product's version of the racing app's Weather Bias Predictor
// Score, requested 2026-09-03 and scoped out 2026-09-04 (see DECISIONS.md). Each raw input is
// normalized onto a comparable scale before being weighted, rather than combined in mismatched
// raw units (feet vs. percent vs. runs/game vs. HR/9) which would let whichever signal happens to
// have the biggest raw numbers dominate by accident.
//
// Weighted AVERAGE, not weighted sum: dividing by the total weight of only the inputs actually
// present means a game missing a signal (umpire not yet assigned, a pitcher/team fetch failing)
// doesn't quietly read as less extreme just because fewer inputs contributed -- the score stays
// on the same scale regardless of how many of the 5 signals are available that day.
//
// Weights and normalization scales below were BACKTESTED 2026-09-05 against 450 real 2025 games
// (15 home games/team, all 30 parks -- scripts/backtest-run-environment-score.js, cached dataset
// at scripts/data/run-environment-score-samples.json), the same process already used for
// CARRY_LEAN_THRESHOLD_FT/WIND_CARRY_FT_PER_MPH above. Each RES_SCALE value is that signal's real
// p75-of-|value| across the sample -- so a "typical extreme" real game normalizes to roughly 1.0,
// not a round guessed number. Correlations overall are real but weak in absolute terms -- this
// recalibration makes the tier labels honestly match what the score actually produces, not a claim
// of strong predictive power.
//
// pitcherHr9's weight was corrected 2026-09-06, after auditing the football side surfaced the same
// class of look-ahead bug here: the ORIGINAL backtest evaluated pitcherHr9Delta using each starter's
// FULL completed 2025 season HR/9, including starts that hadn't happened yet at the time of an
// earlier-season game being backtested -- inflating its apparent strength (originally the 2nd-
// strongest signal, r=0.13/0.19 vs runs/HR). Rebuilt with REAL point-in-time data (MLB Stats API's
// gameLog endpoint, 367 unique starters, cumulative HR/9 through strictly-prior starts only): real
// correlation collapses to r=0.04/0.02 -- now one of the WEAKEST signals, roughly on par with
// umpireLean, not teamHrRate/parkFactor. Weight lowered from 0.8 to 0.4 to match. IMPORTANT: this
// bug was only in the BACKTEST's methodology, not live production -- fetchPitcherHrTendency in
// weather-worker.js queries "this season so far" at request time, which is already correctly
// point-in-time for a real game happening today (nothing to fix there). teamHrRateDelta almost
// certainly has the same category of bias (it's also built from full-season stats) but couldn't be
// corrected or even verified -- MLB Stats API's team-splits endpoint doesn't support date-range
// filtering (confirmed: identical output with/without startDate/endDate), so its own r=0.09/0.19
// may also be somewhat inflated in ways this app can't currently measure or fix.
const RES_WEIGHTS = {
  carry: 1.0,
  parkFactor: 0.8,
  umpireLean: 0.4,
  pitcherHr9: 0.4, // lowered from 0.8 -- see comment above
  teamHrRate: 0.8,
};

const RES_SCALE = {
  carryFt: 25, // real p75-of-|value| was 25.5ft across the 450-game sample
  parkFactorPct: 6, // real p75 was 5.9%
  umpireLeanRunsPerGame: 0.2, // real p75 was 0.207 -- old value of 0.1 over-amplified this signal
  pitcherHr9Delta: 0.35, // real p75 was 0.36
  teamHrRateDelta: 0.0045, // real p75 was 0.0044 -- old value of 0.015 was ~3x too generous, see above
};

// Gates a starter's HR/9 out of the score entirely below this many innings pitched this season --
// same small-sample reasoning as MIN_CAREER_GAMES for umpires above; a rookie's first start or two
// isn't a real rate yet.
const MIN_PITCHER_IP = 10;

// Thresholds recalibrated 2026-09-05 from the real p10/p25/p75/p90 of the RECALIBRATED score
// across the same 450-game backtest (median 0.02, p25 -0.27, p75 0.34, p10 -0.49, p90 0.61) -- same
// top/bottom-quartile logic already used for LEAN_HITTER_THRESHOLD/LEAN_PITCHER_THRESHOLD above,
// extended with a p10/p90 pair for "Strong". Old ±0.5/±1.5 thresholds sat far out in the tail of
// what the score ever actually produced -- "Strong Pitcher Environment" fired on 1 of 450 real
// games under the old thresholds; the recalibrated ±0.3/±0.6 gives a real, checkable ~16% of games
// in a "Strong" tier and a roughly halved Neutral share (73% -> 49%), with a clean, monotonic-in-
// real-runs gradient across all 5 tiers.
//
// Re-checked 2026-09-06 against the corrected point-in-time pitcherHr9Delta + lowered weight (see
// RES_WEIGHTS comment above): real p10/p25/p75/p90 of the corrected composite across the full
// 2,430-game backtest are -0.53/-0.30/+0.31/+0.63 -- essentially unchanged from the thresholds
// below (within 0.03), so left as-is rather than introduce false precision over a shift this small.
function runEnvironmentTier(score) {
  if (score >= 0.6) return "Strong Hitter Environment";
  if (score >= 0.3) return "Hitter Leaning";
  if (score > -0.3) return "Neutral";
  if (score > -0.6) return "Pitcher Leaning";
  return "Strong Pitcher Environment";
}

/**
 * @param {object} inputs
 *   carryFt: number - today's weather-driven carry estimate (scoreMlbGame's carryFt; already 0
 *     when the roof is closed, so a dome game naturally drops this contribution's magnitude)
 *   parkFactorPct: number|null - season Statcast park factor (extra_distance %)
 *   umpireLeanRunsPerGame: number|null - career hitter/pitcher lean (perGameBatterImpact)
 *   pitcherHr9Delta: number|null - avg of both starters' HR/9 minus league-average HR/9
 *   teamHrRateDelta: number|null - avg of both lineups' HR-rate-vs-opposing-starter's-hand minus
 *     league average for that same split
 * @returns {{score: number, tier: string, inputsUsed: string[]}|null} null only if every input is
 *   missing (nothing to score)
 */
function computeRunEnvironmentScore(inputs) {
  const contributions = [];
  const add = (key, raw, scaleKey) => {
    if (raw == null || !Number.isFinite(raw)) return;
    contributions.push({ key, weight: RES_WEIGHTS[key], normalized: raw / RES_SCALE[scaleKey] });
  };
  add("carry", inputs.carryFt, "carryFt");
  add("parkFactor", inputs.parkFactorPct, "parkFactorPct");
  add("umpireLean", inputs.umpireLeanRunsPerGame, "umpireLeanRunsPerGame");
  add("pitcherHr9", inputs.pitcherHr9Delta, "pitcherHr9Delta");
  add("teamHrRate", inputs.teamHrRateDelta, "teamHrRateDelta");

  if (!contributions.length) return null;

  const weightedSum = contributions.reduce((sum, c) => sum + c.weight * c.normalized, 0);
  const weightTotal = contributions.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((weightedSum / weightTotal) * 100) / 100;

  return { score, tier: runEnvironmentTier(score), inputsUsed: contributions.map((c) => c.key) };
}

// ---- Total Runs Call (Run Environment Score vs. the real market O/U line) ----
//
// User requested 2026-09-05: pull a real Vegas O/U line (RotoGrinders) per game and have something
// call "Likely Over"/"Likely Under". Deliberately NOT delegated to the AI model -- this file has
// nine documented cases of that model mishandling numbers it's handed (flipped signs, scrambled
// values, fabricated claims), so the call itself is a plain deterministic comparison in code, same
// as every other signal in this app; the model's only job, if used at all, is narrating an
// already-resolved fact.
//
// TOTAL_RUNS_REGRESSION fits real actualCombinedRuns to resScore via ordinary least squares across
// the full 2,430-game 2025 backtest (scripts/backtest-run-environment-score.js, dataset at
// scripts/data/run-environment-score-samples.json): impliedTotal = INTERCEPT + SLOPE * resScore.
//
// HONEST CAVEAT, worth reading before changing anything below: R-squared for this fit is only
// 0.032 -- resScore explains roughly 3% of game-to-game variance in actual total runs -- and the
// residual standard deviation is 4.52 runs, which DWARFS the ~5-run swing the score produces across
// its entire range (Strong Pitcher's implied ~6.2 to Strong Hitter's implied ~11.4). This is a real,
// modest, correctly-signed signal (same conclusion as the Run Environment Score's own backtest
// writeup), not a strong predictor of any single game. TOTAL_CALL_MARGIN below is deliberately
// wide (not tuned against real historical odds, which this project doesn't have -- RotoGrinders only
// exposes today's live line, not a historical archive) specifically so the call only fires "Likely
// Over/Under" on a genuinely large gap between our implied total and the market line, and reads
// "Toss-up" otherwise -- consistent with the honest, unconfident framing that residual std dev
// demands. Revisit both the regression and the margin once real historical market-line outcomes can
// be collected to actually backtest this call's hit rate, the same way every other constant in this
// file has been.
const TOTAL_RUNS_REGRESSION = { intercept: 8.765, slope: 1.729 };
const TOTAL_CALL_MARGIN = 1.0; // runs of gap between implied total and market line before calling a lean at all

/**
 * @param {number} resScore - Run Environment Score's `score` (not the tier label)
 * @param {number} marketLine - the real O/U line for this game (e.g. from RotoGrinders)
 * @returns {{impliedTotal: number, marketLine: number, delta: number, call: string}}
 */
function computeTotalRunsCall(resScore, marketLine) {
  const impliedTotal = Math.round((TOTAL_RUNS_REGRESSION.intercept + TOTAL_RUNS_REGRESSION.slope * resScore) * 100) / 100;
  const delta = Math.round((impliedTotal - marketLine) * 100) / 100;
  const call = delta >= TOTAL_CALL_MARGIN ? "Likely Over" : delta <= -TOTAL_CALL_MARGIN ? "Likely Under" : "Toss-up";
  return { impliedTotal, marketLine, delta, call };
}

// ---- Game Environment Score (NFL) ----
//
// DESCRIPTIVE ONLY -- deliberately NOT a betting call, unlike MLB's Run Environment Score/Total
// Runs Call. A rigorous backtest (scripts/backtest-nfl-environment-score.js, 1,615 real games
// 2020-2025, joined against real historical Vegas total lines from nflverse) found NO real edge
// against the market from free public signals: neither simple points-per-game nor real EPA/play +
// pace (the actual metric professional analysts use, computed strictly from each team's PRIOR
// weeks only -- true point-in-time, zero data leakage) beat a coin flip once look-ahead bias was
// properly removed. Best composite achieved r2=0.042 against actual totals; the market's own
// total_line alone correlates with actual outcomes at r=0.32 -- far stronger than anything built
// here. NFL totals are a famously efficiently-priced market (concentrated weekly volume on one
// number per game, books using proprietary info like injury/practice reports this app has no
// access to), genuinely different from MLB where a real, if weak, signal existed. So this score
// combines weather + team scoring tendency into one at-a-glance rating shown ALONGSIDE the real
// market line as context -- never "our model says Over/Under", which would be an unsupported claim.
//
// Weights/scales below are the real ones backtested (not placeholders needing a later revisit,
// unlike MLB's initial pass) -- each scale is that signal's real p75-of-|value| across the sample.
const NFL_GES_WEIGHTS = { wind: 1.0, temp: 0.6, team: 1.0 };
const NFL_GES_SCALE = {
  windMph: 11, // real p75 across 2020-2025 outdoor/open-roof games
  tempFDeltaFrom60: 25, // real p75 of |tempF - 60|, outdoor/open-roof games only
  teamScoringDelta: 3.29, // real p75 of |value|, leave-one-out corrected (excludes each game's own score from that team's season average)
};

// Gates team scoring tendency out entirely below this many games of season-to-date data -- same
// small-sample reasoning as MIN_PITCHER_IP above; early in a season a team's average is mostly noise.
const MIN_TEAM_GAMES_FOR_TENDENCY = 3;

// Tier boundaries are the real p10/p25/p75/p90 of this composite score across the 1,615-game
// backtest (median -0.25, not 0 -- the wind term can only ever subtract, never add, since wind
// speed can't be negative, so the whole distribution skews low). Percentile-based, same
// methodology as MLB's LEAN_HITTER_THRESHOLD/CARRY_LEAN_THRESHOLD_FT, not a symmetric guess.
function nflGameEnvironmentTier(score) {
  if (score >= 0.72) return "Strong High-Scoring Environment";
  if (score >= 0.19) return "High-Scoring Leaning";
  if (score > -0.6) return "Neutral";
  if (score > -0.91) return "Low-Scoring Leaning";
  return "Strong Low-Scoring Environment";
}

/**
 * @param {object} inputs
 *   windMph: number|null - ignored when roofClosed (matches scoreNflGame's own wind/precip gate)
 *   tempF: number|null - ignored when roofClosed
 *   roofClosed: boolean
 *   teamScoringDelta: number|null - combined home+away scoring "involvement" (own points scored +
 *     allowed, averaged) minus league average, from real season-to-date data (see
 *     fetchNflTeamScoringTendency in weather-worker.js), null if either team has fewer than
 *     MIN_TEAM_GAMES_FOR_TENDENCY games played yet this season
 * @returns {{score: number, tier: string, inputsUsed: string[]}|null} null only if every input is missing
 */
function computeGameEnvironmentScore(inputs) {
  const contributions = [];
  const add = (key, raw, scaleKey) => {
    if (raw == null || !Number.isFinite(raw)) return;
    contributions.push({ key, weight: NFL_GES_WEIGHTS[key], normalized: raw / NFL_GES_SCALE[scaleKey] });
  };
  add("wind", inputs.roofClosed ? null : inputs.windMph != null ? -inputs.windMph : null, "windMph");
  add("temp", inputs.roofClosed || inputs.tempF == null ? null : inputs.tempF - 60, "tempFDeltaFrom60");
  add("team", inputs.teamScoringDelta, "teamScoringDelta");

  if (!contributions.length) return null;

  const weightedSum = contributions.reduce((sum, c) => sum + c.weight * c.normalized, 0);
  const weightTotal = contributions.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((weightedSum / weightTotal) * 100) / 100;

  return { score, tier: nflGameEnvironmentTier(score), inputsUsed: contributions.map((c) => c.key) };
}

export {
  scoreMlbGame,
  scoreNflGame,
  degToCompass16,
  angleDiff,
  windCompassOrVariable,
  computeRunEnvironmentScore,
  MIN_PITCHER_IP,
  computeTotalRunsCall,
  computeGameEnvironmentScore,
  MIN_TEAM_GAMES_FOR_TENDENCY,
};
