// Quick sanity checks for rules-engine.js against known real-world cases.
// Run with: node workers/rules-engine.test.js
import { scoreMlbGame, scoreNflGame } from "./rules-engine.js";
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

// Open-air NFL venue, severe wind -> should flag severe passing/kicking impact.
const openWindy = scoreNflGame(
  { tempF: 35, humidityPct: 70, windSpeedMph: 25, windFromDeg: 270, precipProbPct: 30 },
  NFL_STADIUMS.CHI
);
console.log("Soldier Field, 25mph wind:", openWindy);
assert(openWindy.windTier === "severe", "25mph wind at an open venue should be classified severe");

// Per-field carry breakdown: wind blowing toward right field (45deg off Yankee Stadium's CF
// bearing of 0) should carry right field the most, left field the least.
const rfWind = scoreMlbGame(
  { tempF: 75, humidityPct: 50, windSpeedMph: 15, windFromDeg: 225, precipProbPct: 0 },
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

console.log("\nAll rules-engine sanity checks passed.");
