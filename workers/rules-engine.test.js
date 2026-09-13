// Quick sanity checks for rules-engine.js against known real-world cases.
// Run with: node workers/rules-engine.test.js
import { scoreMlbGame, scoreNflGame, computeRunEnvironmentScore, computeTotalRunsCall, computeConditionsAdjustedEra, computeGameEnvironmentScore } from "./rules-engine.js";
import { MLB_STADIUMS, NFL_STADIUMS } from "../data/stadiums.js";

function assert(cond, msg) {
  if (!cond) throw new Error("FAILED: " + msg);
  console.log("ok - " + msg);
}

// Coors Field, hot day, wind blowing out to center -> should be strongly hitter-friendly.
const coors = scoreMlbGame(
  { tempF: 90, humidityPct: 20, windSpeedMph: 12, windFromDeg: (MLB_STADIUMS.COL.cfBearingDeg + 180) % 360, precipProbPct: 0 },
  MLB_STADIUMS.COL
);
console.log("Coors (hot, wind out to CF):", coors);
assert(coors.scoringLean === "hitter-friendly", "Coors Field on a hot day with wind blowing out should score hitter-friendly");
assert(coors.carryFt > 30, "Coors Field altitude bonus alone should push carryFt well above baseline");

// Cold, calm day at a sea-level open park -> should not be hitter-friendly.
const cold = scoreMlbGame(
  { tempF: 45, humidityPct: 50, windSpeedMph: 2, windFromDeg: 0, precipProbPct: 0 },
  MLB_STADIUMS.NYY
);
console.log("Cold calm Yankee Stadium:", cold);
assert(cold.scoringLean !== "hitter-friendly", "A cold, calm sea-level day should not read as hitter-friendly");

// Dome NFL venue with high wind in the forecast -> wind effects should be zeroed out.
const domeWindy = scoreNflGame(
  { tempF: 40, humidityPct: 60, windSpeedMph: 30, windFromDeg: 200, precipProbPct: 80 },
  NFL_STADIUMS.MIN
);
console.log("US Bank Stadium (dome) w/ 30mph forecast wind:", domeWindy);
assert(domeWindy.roofClosed === true, "A dome venue must report roofClosed=true");
assert(domeWindy.passingImpact === "none", "Wind should have zero passing impact inside a dome");
assert(domeWindy.roofStatusConfirmed === true, "A fixed dome has no real ambiguity -- always confirmed-closed");

// Retractable-roof NFL venue -> roofClosed is still the default assumption (no live NFL roof-status
// source exists, unlike MLB), but roofStatusConfirmed must be false since real data shows these
// venues actually play open 6-22% of the time depending on the team -- this is a real unconfirmed
// assumption, not a fact, and must be labeled as such.
const retractableNfl = scoreNflGame({ tempF: 70, humidityPct: 40, windSpeedMph: 5, windFromDeg: 90, precipProbPct: 0 }, NFL_STADIUMS.ARI);
console.log("State Farm Stadium (retractable):", retractableNfl);
assert(retractableNfl.roofClosed === true, "A retractable-roof venue must still default to assumed-closed");
assert(retractableNfl.roofStatusConfirmed === false, "A retractable roof's closed status must be flagged as unconfirmed, not stated as fact");

// Open-air NFL venue, severe wind -> should flag severe passing/kicking impact.
const openWindy = scoreNflGame(
  { tempF: 35, humidityPct: 70, windSpeedMph: 25, windFromDeg: 270, precipProbPct: 30 },
  NFL_STADIUMS.CHI
);
console.log("Soldier Field, 25mph wind:", openWindy);
assert(openWindy.windTier === "severe", "25mph wind at an open venue should be classified severe");

// Per-field carry breakdown: wind blowing toward right field (45deg off Yankee Stadium's CF
// bearing) should carry right field the most, left field the least. Wind direction is derived
// from the venue's own cfBearingDeg (not hardcoded) so this doesn't silently go stale if that
// bearing is ever corrected -- exactly what happened here once before, when NYY's bearing was
// recalibrated from a generic default and this test's hardcoded windFromDeg no longer pointed at
// RF under the corrected value, breaking silently until the suite was actually run.
const nyyRfBearing = (MLB_STADIUMS.NYY.cfBearingDeg + 45) % 360;
const rfWind = scoreMlbGame(
  { tempF: 75, humidityPct: 50, windSpeedMph: 15, windFromDeg: (nyyRfBearing + 180) % 360, precipProbPct: 0 },
  MLB_STADIUMS.NYY
);
console.log("Yankee Stadium, wind blowing toward RF:", rfWind.fieldCarry);
assert(rfWind.fieldCarry.right > rfWind.fieldCarry.center, "Wind toward RF should carry right field more than center");
assert(rfWind.fieldCarry.center > rfWind.fieldCarry.left, "Wind toward RF should carry center more than left field (pure crosswind there)");
assert(rfWind.carryFt === rfWind.fieldCarry.center, "The headline carryFt should equal the center-field figure");
assert(rfWind.handedness.favors === "left", "Wind carrying RF more than LF should favor left-handed pull hitters");

// Symmetric case (wind straight out to CF, Coors Field) -> no handedness edge either way.
assert(coors.handedness.favors === "neutral", "Wind blowing straight out to center should not favor either handedness");

// Closed-roof MLB venue on a scorching outdoor day -> outdoor temp/humidity must NOT leak into
// carryFt, since the interior is climate-controlled. Real bug found live: Globe Life Field (TEX,
// retractable, assumed closed) showed +10.5ft of "carry" driven by a 97F outdoor reading, directly
// contradicting the narration text right next to it saying temperature has no bearing indoors.
// Compare two wildly different outdoor readings at the same closed-roof venue -- carryFt should be
// identical (driven only by the venue's fixed altitude), proving temp/humidity have zero effect,
// without hardcoding the exact altitude-bonus math here.
const closedRoofHot = scoreMlbGame(
  { tempF: 97, humidityPct: 15, windSpeedMph: 12, windFromDeg: 90, precipProbPct: 0 },
  MLB_STADIUMS.TEX
);
const closedRoofCold = scoreMlbGame(
  { tempF: 40, humidityPct: 90, windSpeedMph: 12, windFromDeg: 90, precipProbPct: 0 },
  MLB_STADIUMS.TEX
);
console.log("Globe Life Field (closed roof), 97F vs 40F outside:", closedRoofHot.carryFt, closedRoofCold.carryFt);
assert(closedRoofHot.roofClosed === true, "Globe Life Field's retractable roof must be assumed closed");
assert(closedRoofHot.carryFt === closedRoofCold.carryFt, "Outdoor temp/humidity must not affect carry behind a closed roof");
assert(closedRoofHot.roofStatusConfirmed === false, "Without a roofStatus argument, the roof reading must be the assumed default, not a confirmed one");

// Real-time roof status (fetchGameRoofStatus in weather-worker.js, MLB's live game feed): once MLB
// confirms a retractable-roof venue's roof is actually OPEN for a specific game, outdoor weather
// should apply exactly like it does at an always-open venue -- this is the whole point of adding the
// override, so it needs its own explicit test, not just an absence-of-regression check. Wind is kept
// below the 3mph directional threshold here specifically so this test isolates temp/humidity leaking
// through (what it's meant to check) without wind direction -- which depends on the venue's real
// corrected bearing, not something to reason about by eye when picking a throwaway test angle --
// swinging the result either way for reasons unrelated to what's being tested.
const confirmedOpenHot = scoreMlbGame(
  { tempF: 97, humidityPct: 15, windSpeedMph: 2, windFromDeg: 90, precipProbPct: 0 },
  MLB_STADIUMS.TEX,
  { known: true, roofOpen: true }
);
assert(confirmedOpenHot.roofClosed === false, "A confirmed-open retractable roof must not be treated as closed");
assert(confirmedOpenHot.roofStatusConfirmed === true, "A confirmed roof reading must be flagged as confirmed, not assumed");
assert(confirmedOpenHot.carryFt > closedRoofHot.carryFt, "Confirmed-open should let real outdoor heat add carry that the closed-roof assumption blocks");

// Confirmed CLOSED should behave identically to the default assumption (same outcome, different
// provenance) -- roofStatusConfirmed is the only thing that should differ.
const confirmedClosedHot = scoreMlbGame(
  { tempF: 97, humidityPct: 15, windSpeedMph: 12, windFromDeg: 90, precipProbPct: 0 },
  MLB_STADIUMS.TEX,
  { known: true, roofOpen: false }
);
assert(confirmedClosedHot.roofClosed === true, "A confirmed-closed retractable roof must be treated as closed");
assert(confirmedClosedHot.carryFt === closedRoofHot.carryFt, "Confirmed-closed and assumed-closed must produce the same carryFt for the same weather");

// A fixed dome has no open state to confirm -- a roofStatus override must never un-close one, even
// if it were somehow passed (defensive: fetchGameRoofStatus in weather-worker.js is only ever
// called for roofType "retractable" venues, but the rules engine itself should not rely on that).
const domeIgnoresOverride = scoreMlbGame(
  { tempF: 97, humidityPct: 15, windSpeedMph: 12, windFromDeg: 90, precipProbPct: 0 },
  MLB_STADIUMS.TB,
  { known: true, roofOpen: true }
);
assert(domeIgnoresOverride.roofClosed === true, "A fixed dome must stay closed even if a roofStatus override incorrectly claims it's open");

// ---- Run Environment Score ----
//
// Test input magnitudes below are grounded in the real 450-game 2025 backtest distribution
// (scripts/backtest-run-environment-score.js, see rules-engine.js's RES_SCALE comment for the
// real p75-of-|value| each constant is based on) rather than round guessed numbers -- e.g.
// teamHrRateDelta's real observed max across the whole sample was only 0.013, so a test value
// like the old 0.015 would exceed anything the live system could ever actually produce.

// All seven signals near their real p90 magnitude, all pointing hitter-friendly -> a genuinely
// extreme real game (like Coors Field) should actually reach the top tier now, not narrowly miss
// it the way the pre-recalibration thresholds did.
const allHitterFriendly = computeRunEnvironmentScore({
  carryFt: 35, // real p90 was 35.4
  parkFactorPct: 7, // real p90 was 7.2
  umpireLeanRunsPerGame: 0.09, // real p90 was 0.093
  pitcherHr9Delta: 0.48, // real p90 was 0.48
  teamHrRateDelta: 0.005, // real p90 was 0.005
  hardHitDelta: 0.06, // real p90 was 0.062
  parkHrIndexDelta: 20, // real p90 was 20.2
});
console.log("All-hitter-friendly composite:", allHitterFriendly);
assert(allHitterFriendly.score > 0.58, "Real p90-magnitude signals, all hitter-friendly, should clear the Strong tier");
assert(allHitterFriendly.tier === "Strong Hitter Environment", "Should land in the Strong Hitter tier");
assert(allHitterFriendly.inputsUsed.length === 7, "All seven inputs should be counted when all seven are provided");

// Mirror-image pitcher-friendly case, same real-magnitude reasoning.
const allPitcherFriendly = computeRunEnvironmentScore({
  carryFt: -35,
  parkFactorPct: -7,
  umpireLeanRunsPerGame: -0.4, // within the real observed min of -0.584
  pitcherHr9Delta: -0.48,
  teamHrRateDelta: -0.005,
  hardHitDelta: -0.06,
  parkHrIndexDelta: -20,
});
console.log("All-pitcher-friendly composite:", allPitcherFriendly);
assert(allPitcherFriendly.score < -0.49, "Real p90-magnitude signals, all pitcher-friendly, should clear the Strong tier");
assert(allPitcherFriendly.tier === "Strong Pitcher Environment", "Should land in the Strong Pitcher tier");

// Missing signals (umpire not yet assigned, pitcher/team fetch failed) must not shrink the score
// toward 0 just because fewer inputs contributed -- a weighted AVERAGE over only the inputs
// present, not a weighted sum, so a game with only carryFt+parkFactor known reads on the same
// scale as one with all seven.
const partialInputs = computeRunEnvironmentScore({ carryFt: 35, parkFactorPct: 7, umpireLeanRunsPerGame: null, pitcherHr9Delta: null, teamHrRateDelta: null, hardHitDelta: null, parkHrIndexDelta: null });
console.log("Partial-inputs composite (carry + park factor only):", partialInputs);
assert(partialInputs.inputsUsed.length === 2, "Only the two provided inputs should be counted");
assert(partialInputs.score > 0.58, "Two strongly hitter-friendly inputs alone should still score high, not diluted toward 0 by the five missing ones");

// Every input missing -> nothing to score, not a fabricated 0/neutral.
assert(computeRunEnvironmentScore({ carryFt: null, parkFactorPct: null, umpireLeanRunsPerGame: null, pitcherHr9Delta: null, teamHrRateDelta: null, hardHitDelta: null, parkHrIndexDelta: null }) === null, "All inputs missing should return null, not a fake neutral score");

// Genuinely mixed signals, each at a real p75-ish magnitude but pointing in different directions,
// should land in the Neutral band, not get pulled hard either direction.
const mixed = computeRunEnvironmentScore({ carryFt: 19, parkFactorPct: -6, umpireLeanRunsPerGame: 0, pitcherHr9Delta: -0.35, teamHrRateDelta: 0.003, hardHitDelta: 0.02, parkHrIndexDelta: -8 });
console.log("Mixed-signal composite:", mixed);
assert(mixed.tier === "Neutral", "Realistic, genuinely offsetting signals should land in the Neutral tier");

// hardHitDelta specifically: a real, separate signal from pitcherHr9Delta -- pointing them in
// OPPOSITE directions should partially offset, not double-count as if they were the same thing.
const hr9VsHardHitOffset = computeRunEnvironmentScore({ carryFt: null, parkFactorPct: null, umpireLeanRunsPerGame: null, pitcherHr9Delta: 0.35, teamHrRateDelta: null, hardHitDelta: -0.043, parkHrIndexDelta: null });
console.log("pitcherHr9Delta and hardHitDelta pointing opposite ways:", hr9VsHardHitOffset);
assert(Math.abs(hr9VsHardHitOffset.score) < 0.05, "Equal-magnitude, opposite-signed HR9/hardHit signals should roughly cancel, not reinforce");
assert(hr9VsHardHitOffset.inputsUsed.length === 2, "Both pitcherHr9 and hardHit should be counted as separate signals");

// parkHrIndexDelta specifically: a real, separate signal from parkFactorPct (r=-0.02 between them
// in the real backtest -- see RES_WEIGHTS comment) -- pointing them in OPPOSITE directions should
// partially offset, not double-count as if they measured the same "park effect."
const parkFactorVsParkHrOffset = computeRunEnvironmentScore({ carryFt: null, parkFactorPct: 6, umpireLeanRunsPerGame: null, pitcherHr9Delta: null, teamHrRateDelta: null, hardHitDelta: null, parkHrIndexDelta: -15 });
console.log("parkFactorPct and parkHrIndexDelta pointing opposite ways:", parkFactorVsParkHrOffset);
assert(Math.abs(parkFactorVsParkHrOffset.score) < 0.05, "Equal-magnitude, opposite-signed park-factor/park-HR signals should roughly cancel, not reinforce");
assert(parkFactorVsParkHrOffset.inputsUsed.length === 2, "Both parkFactor and parkHr should be counted as separate signals");

// ---- Total Runs Call ----

// A Neutral-ish score (near the regression's own mean) against a very low market line -> our
// implied total should sit well above it -> Likely Over.
const overCall = computeTotalRunsCall(0, 6.5);
console.log("Total call vs a low market line:", overCall);
assert(overCall.call === "Likely Over", "A market line well below our implied total should call Likely Over");
assert(overCall.impliedTotal > 8, "Score 0 should imply a total near the regression's intercept (~8.84)");

// Same score against a very high market line -> Likely Under.
const underCall = computeTotalRunsCall(0, 11);
console.log("Total call vs a high market line:", underCall);
assert(underCall.call === "Likely Under", "A market line well above our implied total should call Likely Under");

// Market line very close to our implied total -> Toss-up, not a false-confidence lean either way.
// This is the common case given the regression's real residual std dev (4.52 runs) -- most real
// market lines should land inside the margin, not outside it.
const tossUp = computeTotalRunsCall(0, 8.5);
console.log("Total call vs a close market line:", tossUp);
assert(tossUp.call === "Toss-up", "A market line within TOTAL_CALL_MARGIN of our implied total should be a Toss-up, not a confident lean");

// delta should be signed correctly: impliedTotal - marketLine, positive means we lean Over.
assert(overCall.delta > 0, "A Likely Over call should have a positive delta (implied above market)");
assert(underCall.delta < 0, "A Likely Under call should have a negative delta (implied below market)");

// ---- Conditions-Adjusted ERA ----

// A neutral (resScore=0) day should leave the pitcher's real ERA unchanged -- no scaling at all.
assert(computeConditionsAdjustedEra(4.0, 0) === 4.0, "resScore=0 (a neutral day) should not adjust ERA at all");

// A real hitter-friendly score (e.g. Strong Hitter Environment territory) should scale ERA UP --
// more scoring expected today means a higher expected ERA, not lower.
const hitterFriendlyAdjustedEra = computeConditionsAdjustedEra(4.0, 0.6);
console.log("Adjusted ERA in a hitter-friendly environment (base 4.00, resScore 0.6):", hitterFriendlyAdjustedEra);
assert(hitterFriendlyAdjustedEra > 4.0, "A hitter-friendly resScore should scale ERA up, not down");

// Mirror-image pitcher-friendly case should scale ERA DOWN.
const pitcherFriendlyAdjustedEra = computeConditionsAdjustedEra(4.0, -0.6);
console.log("Adjusted ERA in a pitcher-friendly environment (base 4.00, resScore -0.6):", pitcherFriendlyAdjustedEra);
assert(pitcherFriendlyAdjustedEra < 4.0, "A pitcher-friendly resScore should scale ERA down, not up");

// Missing inputs -> null, not a fabricated number.
assert(computeConditionsAdjustedEra(null, 0.5) === null, "A missing ERA should return null, not a fake adjustment");
assert(computeConditionsAdjustedEra(4.0, null) === null, "A missing resScore should return null, not a fake adjustment");

// ---- Game Environment Score (NFL) ----
// Test magnitudes grounded in the real 2020-2025 nflverse backtest (scripts/backtest-nfl-environment-score.js):
// windMph real p90 ~15mph, tempF real p10/p90 ~35/80F, teamScoringDelta (point-in-time corrected
// 2026-09-12, see NFL_GES_SCALE comment) real p90 ~6.2.

// Calm + warm + high-scoring teams, all pointing the same way -> should clear the Strong High tier.
const highScoringNfl = computeGameEnvironmentScore({ windMph: 0, tempF: 85, roofClosed: false, teamScoringDelta: 6.2 });
console.log("High-scoring NFL environment:", highScoringNfl);
assert(highScoringNfl.score >= 0.62, "Calm + warm + high-scoring teams should clear the Strong High-Scoring threshold");
assert(highScoringNfl.tier === "Strong High-Scoring Environment", "Should land in the Strong High-Scoring tier");
assert(highScoringNfl.inputsUsed.length === 3, "All three inputs should be counted when all three are provided");

// High wind + freezing + low-scoring teams -> should clear the Strong Low tier.
const lowScoringNfl = computeGameEnvironmentScore({ windMph: 20, tempF: 15, roofClosed: false, teamScoringDelta: -6.2 });
console.log("Low-scoring NFL environment:", lowScoringNfl);
assert(lowScoringNfl.score <= -0.92, "High wind + freezing + low-scoring teams should clear the Strong Low-Scoring threshold");
assert(lowScoringNfl.tier === "Strong Low-Scoring Environment", "Should land in the Strong Low-Scoring tier");

// A closed roof must gate wind/temp out entirely, same as scoreNflGame's own roofClosed handling --
// only teamScoringDelta should contribute regardless of how extreme the (irrelevant) weather is.
const domeGame = computeGameEnvironmentScore({ windMph: 30, tempF: 5, roofClosed: true, teamScoringDelta: 2 });
console.log("Dome game (extreme outdoor weather must be ignored):", domeGame);
assert(domeGame.inputsUsed.length === 1 && domeGame.inputsUsed[0] === "team", "A closed roof must gate out both wind and temp, leaving only team scoring tendency");

// Missing team data (early season, under MIN_TEAM_GAMES_FOR_TENDENCY) must not shrink the score --
// weather-only should still read clearly on its own scale.
const weatherOnly = computeGameEnvironmentScore({ windMph: 3, tempF: 70, roofClosed: false, teamScoringDelta: null });
console.log("Weather-only NFL environment (no team data yet):", weatherOnly);
assert(weatherOnly.inputsUsed.length === 2, "Only wind and temp should be counted when team data is unavailable");

// Every input missing -> null, not a fabricated neutral score.
assert(computeGameEnvironmentScore({ windMph: null, tempF: null, roofClosed: false, teamScoringDelta: null }) === null, "All inputs missing should return null, not a fake neutral score");

console.log("\nAll rules-engine sanity checks passed.");
