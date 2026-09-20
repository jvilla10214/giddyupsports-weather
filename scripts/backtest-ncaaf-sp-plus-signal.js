// First real team-strength backtest for NCAAF. Today's NCAAF Game Environment Score is weather-only
// -- no nflverse-equivalent free dataset exists covering all 130+ FBS teams' game-by-game results,
// so `teamScoringDelta` is hardcoded null in handleNcaafGame (weather-worker.js). CollegeFootballData.com's
// free-tier API closes that gap: SP+ (Bill Connelly's predictive power rating) gives every FBS team
// a real offense/defense efficiency rating each season.
//
// IMPORTANT METHODOLOGY NOTE: CFBD's /ratings/sp endpoint for a completed season only returns that
// season's FINAL rating -- a `week` param does not return an earlier in-season snapshot (confirmed
// live: week=5 and no-week-param return identical data for a past season). Using a season's own
// final rating to "predict" that same season's games would be look-ahead bias (the same class of
// bug already found and fixed in NFL's teamScoringDelta and MLB's pitcherHr9Delta). This backtest
// instead uses season (S-1)'s FINAL rating to predict season S's games -- a standard, genuinely
// look-ahead-free "preseason strength" methodology (real production use would fetch the CURRENT,
// continuously-updating season's rating mid-season, which is legitimately point-in-time; this
// backtest's prior-year-final approach is a conservative stand-in that avoids needing to guess at
// the live weekly-refresh cadence).
//
// Signal: combinedScoringTendency = (homeOff - leagueAvgOff) + (awayOff - leagueAvgOff)
//                                  + (homeDef - leagueAvgDef) + (awayDef - leagueAvgDef)
// SP+ offense.rating: higher = more points scored (good). SP+ defense.rating: LOWER = fewer points
// allowed (good) -- confirmed via Bill Connelly's own published methodology. Both are on the same
// points-per-game-equivalent scale (season mean ~27 for both, confirmed live), so this sums how much
// more (or less) combined scoring these two offenses+defenses should produce than a neutral matchup.
//
// Usage: node scripts/backtest-ncaaf-sp-plus-signal.js [CFBD_API_KEY] [minSeason] [splitSeason] [maxSeason]
//   Reads the key from argv[2] if given, else process.env.CFBD_API_KEY.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");

async function fetchJsonCached(url, cacheFile, apiKey) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  if (!res.ok) throw new Error(`CFBD fetch failed for ${url}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}

function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 2) return { r: null, n };
  const mx = mean(pairs.map((p) => p[0])),
    my = mean(pairs.map((p) => p[1]));
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx,
      dy = y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return { r: sxy / Math.sqrt(sxx * syy), n };
}

function olsFit(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  const mx = mean(pairs.map((p) => p[0])),
    my = mean(pairs.map((p) => p[1]));
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (const [x, y] of pairs) {
    const dx = x - mx,
      dy = y - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxy / sxx,
    intercept = my - slope * mx;
  let ssRes = 0;
  for (const [x, y] of pairs) ssRes += (y - (intercept + slope * x)) ** 2;
  return { n, slope, intercept, r: sxy / Math.sqrt(sxx * syy), residStd: Math.sqrt(ssRes / (n - 2)) };
}

async function main() {
  const apiKey = process.argv[2] || process.env.CFBD_API_KEY;
  if (!apiKey) throw new Error("Pass the CFBD API key as argv[2] or set CFBD_API_KEY env var.");
  const minSeason = Number(process.argv[3]) || 2020;
  const splitSeason = Number(process.argv[4]) || 2024;
  const maxSeason = Number(process.argv[5]) || 2025;

  // Ratings needed from minSeason-1 (to predict minSeason's games) through maxSeason-1.
  const ratingsBySeason = {};
  for (let s = minSeason - 1; s <= maxSeason - 1; s++) {
    const data = await fetchJsonCached(`https://api.collegefootballdata.com/ratings/sp?year=${s}`, path.join(CACHE_DIR, `cfbd-sp-${s}.json`), apiKey);
    const byTeam = {};
    for (const t of data) if (t.offense?.rating != null && t.defense?.rating != null) byTeam[t.team] = { off: t.offense.rating, def: t.defense.rating };
    const leagueAvgOff = mean(Object.values(byTeam).map((t) => t.off));
    const leagueAvgDef = mean(Object.values(byTeam).map((t) => t.def));
    ratingsBySeason[s] = { byTeam, leagueAvgOff, leagueAvgDef };
    console.log(`SP+ ${s}: ${Object.keys(byTeam).length} teams, leagueAvgOff=${leagueAvgOff.toFixed(2)}, leagueAvgDef=${leagueAvgDef.toFixed(2)}`);
  }

  const samples = [];
  for (let s = minSeason; s <= maxSeason; s++) {
    const games = await fetchJsonCached(`https://api.collegefootballdata.com/games?year=${s}&seasonType=regular`, path.join(CACHE_DIR, `cfbd-games-${s}.json`), apiKey);
    const prior = ratingsBySeason[s - 1];
    for (const g of games) {
      if (!g.completed || g.homeClassification !== "fbs" || g.awayClassification !== "fbs") continue;
      if (g.homePoints == null || g.awayPoints == null) continue;
      const home = prior.byTeam[g.homeTeam];
      const away = prior.byTeam[g.awayTeam];
      let combinedScoringTendency = null;
      if (home && away) {
        combinedScoringTendency =
          home.off - prior.leagueAvgOff + (away.off - prior.leagueAvgOff) + (home.def - prior.leagueAvgDef) + (away.def - prior.leagueAvgDef);
      }
      samples.push({ season: s, actualTotal: g.homePoints + g.awayPoints, combinedScoringTendency });
    }
  }
  console.log(`\nLoaded ${samples.length} completed FBS-v-FBS games, ${samples.filter((s) => s.combinedScoringTendency != null).length} with both teams' prior-year SP+.`);

  const { r, n } = pearson(samples.map((s) => s.combinedScoringTendency), samples.map((s) => s.actualTotal));
  console.log(`\ncombinedScoringTendency vs actual total points: r=${r?.toFixed(4)}  n=${n}`);
  console.log(`(for reference, NFL's own teamScoringDelta -- the closest analog already shipped -- backtested at r=0.145)`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);
  const fit = olsFit(train.map((s) => s.combinedScoringTendency), train.map((s) => s.actualTotal));
  console.log(`Fit on TRAIN: impliedTotal = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * combinedScoringTendency  (n=${fit.n}, r=${fit.r.toFixed(4)}, residStd=${fit.residStd.toFixed(2)})`);

  const testR = pearson(test.map((s) => s.combinedScoringTendency), test.map((s) => s.actualTotal));
  console.log(`Held-out TEST correlation: r=${testR.r?.toFixed(4)}  n=${testR.n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
