// Recalibrates NCAAF's Game Environment Score tier thresholds against NCAAF's OWN real
// distribution, instead of reusing NFL's (nflGameEnvironmentTier's 0.62/0.13/-0.6/-0.92, calibrated
// from NFL's 1,615-game backtest -- see rules-engine.js). NCAAF shares NFL's wind/temp scales (real
// physics, no reason outdoor football weather effects differ by division), but its team signal
// (SP+-based combinedScoringTendency, real r=0.175-0.183, see backtest-ncaaf-sp-plus-signal.js) has
// a genuinely different real-world distribution than NFL's teamScoringDelta.
//
// HONEST METHODOLOGY NOTE: no free source has real historical per-game weather joined to NCAAF's
// real historical scores/lines at the scale NFL's nflverse games.csv provides (that's exactly the
// gap documented in DECISIONS.md for NFL's own historical-almanac feature, worse here since NCAAF
// has 130+ teams across many more venues). Building that from scratch would mean geocoding and
// backfilling weather for thousands of individual games -- a much bigger, separate effort. Instead:
// bootstrap the composite by pairing REAL NCAAF team-signal values (from CFBD, 4,174 real games)
// with REAL NFL wind/temp values (from nfl-environment-score-samples.json, outdoor games only,
// resampled with replacement) under an independence assumption -- wind/temp and team strength are
// not meaningfully correlated with each other in either sport, so this produces a genuinely
// data-grounded composite distribution, not a fabricated one, while being transparent that the
// wind+temp and team components come from two different real sources rather than the same games.
//
// Usage: node scripts/backtest-ncaaf-tier-calibration.js [CFBD_API_KEY] [minSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeGameEnvironmentScore, NCAAF_TEAM_SCALE } from "../workers/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

async function fetchJsonCached(url, cacheFile, apiKey) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`CFBD fetch failed for ${url}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

async function loadNcaafTeamSignals(apiKey, minSeason, maxSeason) {
  const ratingsBySeason = {};
  for (let s = minSeason - 1; s <= maxSeason - 1; s++) {
    const data = await fetchJsonCached(`https://api.collegefootballdata.com/ratings/sp?year=${s}`, path.join(CACHE_DIR, `cfbd-sp-${s}.json`), apiKey);
    const byTeam = {};
    for (const t of data) if (t.offense?.rating != null && t.defense?.rating != null) byTeam[t.team] = { off: t.offense.rating, def: t.defense.rating };
    const leagueAvgOff = mean(Object.values(byTeam).map((t) => t.off));
    const leagueAvgDef = mean(Object.values(byTeam).map((t) => t.def));
    ratingsBySeason[s] = { byTeam, leagueAvgOff, leagueAvgDef };
  }
  const values = [];
  for (let s = minSeason; s <= maxSeason; s++) {
    const games = await fetchJsonCached(`https://api.collegefootballdata.com/games?year=${s}&seasonType=regular`, path.join(CACHE_DIR, `cfbd-games-${s}.json`), apiKey);
    const prior = ratingsBySeason[s - 1];
    for (const g of games) {
      if (!g.completed || g.homeClassification !== "fbs" || g.awayClassification !== "fbs") continue;
      const home = prior.byTeam[g.homeTeam],
        away = prior.byTeam[g.awayTeam];
      if (!home || !away) continue;
      values.push(home.off - prior.leagueAvgOff + (away.off - prior.leagueAvgOff) + (home.def - prior.leagueAvgDef) + (away.def - prior.leagueAvgDef));
    }
  }
  return values;
}

function loadNflWeatherSamples() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "nfl-environment-score-samples.json"), "utf8"));
  return raw.samples.filter((s) => !s.roofClosed && s.windMph != null && s.tempF != null).map((s) => ({ windMph: s.windMph, tempF: s.tempF }));
}

function shuffledCopy(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(Math.random() * arr.length)]);
  return out;
}

async function main() {
  const apiKey = process.argv[2] || process.env.CFBD_API_KEY;
  if (!apiKey) throw new Error("Pass the CFBD API key as argv[2] or set CFBD_API_KEY env var.");
  const minSeason = Number(process.argv[3]) || 2020;
  const maxSeason = Number(process.argv[4]) || 2025;

  const teamValues = await loadNcaafTeamSignals(apiKey, minSeason, maxSeason);
  const weatherPool = loadNflWeatherSamples();
  console.log(`Real NCAAF team-signal values: ${teamValues.length}`);
  console.log(`Real NFL outdoor wind/temp pairs available to resample: ${weatherPool.length}`);

  // Bootstrap: pair every real NCAAF team value with a randomly-drawn real NFL wind/temp pair
  // (with replacement), 5x oversampled for a smoother percentile estimate.
  const N = teamValues.length * 5;
  const teamDraws = shuffledCopy(teamValues, N);
  const weatherDraws = shuffledCopy(weatherPool, N);

  const composites = [];
  for (let i = 0; i < N; i++) {
    const result = computeGameEnvironmentScore(
      { windMph: weatherDraws[i].windMph, tempF: weatherDraws[i].tempF, roofClosed: false, teamScoringDelta: teamDraws[i] },
      NCAAF_TEAM_SCALE
    );
    if (result) composites.push(result.score);
  }
  composites.sort((a, b) => a - b);
  console.log(`\nSynthetic composite sample size: ${composites.length}`);
  console.log("\n--- NCAAF composite score percentiles (bootstrap, real data both sides) ---");
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) console.log(`  p${p * 100}: ${percentile(composites, p).toFixed(3)}`);

  console.log("\n--- For comparison, NFL's own real (non-bootstrapped) tier thresholds ---");
  console.log("  p10: -0.92  p25: -0.6  p75: 0.13  p90: 0.62");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
