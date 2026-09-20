// Re-derives NCAAF's tier thresholds for the new blended team signal (25% prior-year SP+ / 75%
// real in-season point-in-time scoring tendency, see backtest-ncaaf-blend-signal.js -- r=0.27
// held-out, replacing the pure-SP+ signal's r=0.183). Same bootstrap methodology as
// backtest-ncaaf-tier-calibration.js (no free source joins real historical weather to NCAAF's real
// historical scores, so real team-signal values are paired with randomly-resampled real NFL outdoor
// wind/temp pairs under an independence assumption) -- just with the new, stronger team signal.
//
// Usage: node scripts/backtest-ncaaf-blend-tier-calibration.js [CFBD_API_KEY] [minSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeGameEnvironmentScore } from "../workers/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const MIN_GAMES_FOR_TENDENCY = 3;
const BLEND_WEIGHT_SP = 0.25;

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
function shuffledCopy(arr, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(Math.random() * arr.length)]);
  return out;
}
function loadNflWeatherSamples() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "nfl-environment-score-samples.json"), "utf8"));
  return raw.samples.filter((s) => !s.roofClosed && s.windMph != null && s.tempF != null).map((s) => ({ windMph: s.windMph, tempF: s.tempF }));
}

async function main() {
  const apiKey = process.argv[2] || process.env.CFBD_API_KEY;
  if (!apiKey) throw new Error("Pass the CFBD API key as argv[2] or set CFBD_API_KEY env var.");
  const minSeason = Number(process.argv[3]) || 2020;
  const maxSeason = Number(process.argv[4]) || 2025;

  const ratingsBySeason = {};
  for (let s = minSeason - 1; s <= maxSeason - 1; s++) {
    const data = await fetchJsonCached(`https://api.collegefootballdata.com/ratings/sp?year=${s}`, path.join(CACHE_DIR, `cfbd-sp-${s}.json`), apiKey);
    const byTeam = {};
    for (const t of data) if (t.offense?.rating != null && t.defense?.rating != null) byTeam[t.team] = { off: t.offense.rating, def: t.defense.rating };
    ratingsBySeason[s] = { byTeam, leagueAvgOff: mean(Object.values(byTeam).map((t) => t.off)), leagueAvgDef: mean(Object.values(byTeam).map((t) => t.def)) };
  }
  const allGames = [];
  for (let s = minSeason; s <= maxSeason; s++) {
    const games = await fetchJsonCached(`https://api.collegefootballdata.com/games?year=${s}&seasonType=regular`, path.join(CACHE_DIR, `cfbd-games-${s}.json`), apiKey);
    for (const g of games) {
      if (!g.completed || g.homeClassification !== "fbs" || g.awayClassification !== "fbs") continue;
      if (g.homePoints == null || g.awayPoints == null) continue;
      allGames.push(g);
    }
  }
  allGames.sort((a, b) => a.season - b.season || a.week - b.week);

  const leagueTotalsBySeason = {};
  for (const g of allGames) {
    const total = g.homePoints + g.awayPoints;
    leagueTotalsBySeason[g.season] = leagueTotalsBySeason[g.season] || { sum: 0, games: 0 };
    leagueTotalsBySeason[g.season].sum += total;
    leagueTotalsBySeason[g.season].games += 1;
  }
  const cumulative = {};
  const spVals = [],
    inSeasonVals = [],
    blendedPairs = [];
  for (const g of allGames) {
    const season = g.season;
    const homeKey = `${season}:${g.homeTeam}`,
      awayKey = `${season}:${g.awayTeam}`;
    const leagueAvgTotal = leagueTotalsBySeason[season].sum / leagueTotalsBySeason[season].games;
    const homeCum = cumulative[homeKey],
      awayCum = cumulative[awayKey];
    let inSeasonTendency = null;
    if (homeCum && awayCum && homeCum.games >= MIN_GAMES_FOR_TENDENCY && awayCum.games >= MIN_GAMES_FOR_TENDENCY) {
      const hi = (homeCum.scoredSum + homeCum.allowedSum) / homeCum.games,
        ai = (awayCum.scoredSum + awayCum.allowedSum) / awayCum.games;
      inSeasonTendency = (hi + ai) / 2 - leagueAvgTotal;
    }
    const prior = ratingsBySeason[season - 1];
    const home = prior?.byTeam[g.homeTeam],
      away = prior?.byTeam[g.awayTeam];
    let spPlusTendency = null;
    if (home && away) spPlusTendency = home.off - prior.leagueAvgOff + (away.off - prior.leagueAvgOff) + (home.def - prior.leagueAvgDef) + (away.def - prior.leagueAvgDef);
    if (spPlusTendency != null) spVals.push(spPlusTendency);
    if (inSeasonTendency != null) inSeasonVals.push(inSeasonTendency);
    if (spPlusTendency != null && inSeasonTendency != null) blendedPairs.push({ sp: spPlusTendency, inS: inSeasonTendency });

    cumulative[homeKey] = cumulative[homeKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    cumulative[homeKey].scoredSum += g.homePoints;
    cumulative[homeKey].allowedSum += g.awayPoints;
    cumulative[homeKey].games += 1;
    cumulative[awayKey] = cumulative[awayKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    cumulative[awayKey].scoredSum += g.awayPoints;
    cumulative[awayKey].allowedSum += g.homePoints;
    cumulative[awayKey].games += 1;
  }

  const absP75 = (vals) => percentile(vals.map(Math.abs).sort((a, b) => a - b), 0.75);
  const spScale = absP75(spVals);
  const inSeasonScale = absP75(inSeasonVals);
  const blendedRaw = blendedPairs.map((v) => BLEND_WEIGHT_SP * (v.sp / spScale) + (1 - BLEND_WEIGHT_SP) * (v.inS / inSeasonScale));
  const blendScale = absP75(blendedRaw);
  console.log(`spScale=${spScale.toFixed(3)}  inSeasonScale=${inSeasonScale.toFixed(3)}  blendScale (final NCAAF_TEAM_SCALE)=${blendScale.toFixed(4)}`);

  // Bootstrap: pair every real blended team value with a randomly-drawn real NFL outdoor wind/temp
  // pair, run through the ACTUAL production formula (computeGameEnvironmentScore with
  // teamScale=blendScale) so the derived percentiles exactly match what production will compute.
  const weatherPool = loadNflWeatherSamples();
  const N = blendedRaw.length * 5;
  const teamDraws = shuffledCopy(blendedRaw, N);
  const weatherDraws = shuffledCopy(weatherPool, N);
  const composites = [];
  for (let i = 0; i < N; i++) {
    const result = computeGameEnvironmentScore({ windMph: weatherDraws[i].windMph, tempF: weatherDraws[i].tempF, roofClosed: false, teamScoringDelta: teamDraws[i] }, blendScale);
    if (result) composites.push(result.score);
  }
  composites.sort((a, b) => a - b);
  console.log(`\nSynthetic composite sample size: ${composites.length}`);
  console.log("--- NCAAF blended-signal composite score percentiles ---");
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) console.log(`  p${p * 100}: ${percentile(composites, p).toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
