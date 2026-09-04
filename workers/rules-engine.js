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
 */
function scoreMlbGame(weather, venue) {
  const roofClosed = venue.roofType !== "open"; // retractable/dome: assume closed unless told otherwise
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
  } else if (roofClosed) {
    notes.push(`${venue.venue}'s retractable roof status isn't known in advance for free — if closed, wind has no effect. Verify before relying on this.`);
  }

  const scoringLean =
    carryFt > CARRY_LEAN_THRESHOLD_FT ? "hitter-friendly" : carryFt < -CARRY_LEAN_THRESHOLD_FT ? "pitcher-friendly" : "neutral";

  return {
    sport: "MLB",
    roofClosed,
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

/**
 * @param {object} weather - { tempF, humidityPct, windSpeedMph, windFromDeg, precipProbPct }
 * @param {object} venue - NFL_STADIUMS[x] entry: { roofType }
 */
function scoreNflGame(weather, venue) {
  const roofClosed = venue.roofType !== "open";
  const notes = [];

  if (roofClosed) {
    return {
      sport: "NFL",
      roofClosed: true,
      windTier: "none (closed roof)",
      passingImpact: "none",
      fgRangeImpact: "none",
      notes: [`${venue.venue} is a ${venue.roofType} venue — wind/precip effects don't apply indoors.`],
    };
  }

  const w = weather.windSpeedMph;
  let windTier, passingImpact, fgRangeImpact;
  if (w < 10) {
    windTier = "light";
    passingImpact = "negligible";
    fgRangeImpact = "full range";
  } else if (w < 15) {
    windTier = "moderate";
    passingImpact = "noticeable dip in deep-ball accuracy";
    fgRangeImpact = "full range, slight lean toward shorter tries in that wind direction";
  } else if (w < 20) {
    windTier = "strong";
    passingImpact = "significant accuracy drop, expect a run-leaning game plan";
    fgRangeImpact = "effective range shortened, ~3% FG success drop";
  } else {
    windTier = "severe";
    passingImpact = "severe — deep passing and long field goals both unreliable";
    fgRangeImpact = "effective range shortened well inside normal attempts, FG% drops toward ~77%";
  }

  if (weather.precipProbPct >= 50) notes.push("High precipitation chance — expect more ball-security caution and a run-heavier script.");
  if (weather.tempF <= 32) notes.push("Freezing temps historically correlate with lower scoring and a run-leaning game plan.");

  return {
    sport: "NFL",
    roofClosed: false,
    windTier,
    windCompass: windCompassOrVariable(weather),
    passingImpact,
    fgRangeImpact,
    notes,
  };
}

export { scoreMlbGame, scoreNflGame, degToCompass16, angleDiff, windCompassOrVariable };
