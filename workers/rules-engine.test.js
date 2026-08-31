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

console.log("\nAll rules-engine sanity checks passed.");
