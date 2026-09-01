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

function degToCompass16(deg) {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
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

  // Air density / carry index, in estimated feet of extra fly-ball distance vs. a 70F/50%RH/sea-level baseline.
  let carryFt = 0;
  const tempDelta = weather.tempF - 75;
  if (tempDelta > 0) carryFt += (tempDelta / 10) * 3;
  else carryFt += (tempDelta / 10) * 3; // colder air also costs distance symmetrically
  carryFt += (weather.humidityPct - 50) / 50 * 2; // small humidity nudge, +2ft at 100% RH vs 50%
  const altitudeBonusFt = (venue.altitudeFt / 5280) * 40; // ~40ft (~10% of a 400ft flyball) at Coors-level altitude
  carryFt += altitudeBonusFt;
  if (altitudeBonusFt > 15) notes.push(`Elevation (${venue.altitudeFt}ft) adds an estimated +${altitudeBonusFt.toFixed(0)}ft of carry.`);

  // Wind component relative to park orientation. windFromDeg is where wind comes FROM; the vector
  // it blows TOWARD is windFromDeg + 180. Compare that to the park's home-plate->CF bearing.
  let windZone = "calm";
  let windCarryFt = 0;
  if (!roofClosed && weather.windSpeedMph >= 3) {
    const blowsToward = (weather.windFromDeg + 180) % 360;
    const diff = angleDiff(blowsToward, venue.cfBearingDeg); // 0 = straight out to CF
    windCarryFt = Math.cos((diff * Math.PI) / 180) * weather.windSpeedMph * 3.5;
    carryFt += windCarryFt;
    if (Math.abs(diff) <= 30) windZone = windCarryFt > 0 ? "blowing out to center" : "blowing in from center";
    else if (diff > 30 && diff <= 100) windZone = windCarryFt > 0 ? "blowing out toward right field" : "blowing in from right field";
    else if (diff < -30 && diff >= -100) windZone = windCarryFt > 0 ? "blowing out toward left field" : "blowing in from left field";
    else windZone = "mostly crosswind";
  } else if (venue.roofType === "dome") {
    notes.push(`${venue.venue} is a fixed dome — always closed, so wind has no effect here.`);
  } else if (roofClosed) {
    notes.push(`${venue.venue}'s retractable roof status isn't known in advance for free — if closed, wind has no effect. Verify before relying on this.`);
  }

  const scoringLean = carryFt > 12 ? "hitter-friendly" : carryFt < -12 ? "pitcher-friendly" : "neutral";

  return {
    sport: "MLB",
    roofClosed,
    carryFt: Math.round(carryFt * 10) / 10,
    windZone,
    windCarryFt: Math.round(windCarryFt * 10) / 10,
    windCompass: degToCompass16(weather.windFromDeg),
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
    windCompass: degToCompass16(weather.windFromDeg),
    passingImpact,
    fgRangeImpact,
    notes,
  };
}

export { scoreMlbGame, scoreNflGame, degToCompass16, angleDiff };
