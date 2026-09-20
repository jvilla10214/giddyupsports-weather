// Tests whether blending the shipped prior-year-final SP+ signal (see
// backtest-ncaaf-sp-plus-signal.js, r=0.175/0.183) with a genuine IN-SEASON, point-in-time signal
// beats prior-year SP+ alone. Motivation: prior-year SP+ can't see a coaching change, major roster
// turnover, or an early-season surprise -- real in-season results, even a crude version, might catch
// what a season-old rating misses.
//
// In-season signal uses the SAME formula/methodology as NFL's own already-shipped teamScoringDelta
// (point-in-time cumulative combined scored+allowed per game, minus league average, strictly prior
// weeks only, gated at a minimum games-played threshold) -- not a new invention, just NFL's proven
// approach applied to CFBD's real game-by-game NCAAF scores. Tests it standalone AND blended with
// the SP+ signal at several weights, same train(2020-23)/test(2024-25) discipline as everything else.
//
// Usage: node scripts/backtest-ncaaf-blend-signal.js [CFBD_API_KEY] [minSeason] [splitSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const MIN_GAMES_FOR_TENDENCY = 3; // same gate as NFL's MIN_TEAM_GAMES_FOR_TENDENCY

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
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
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

async function main() {
  const apiKey = process.argv[2] || process.env.CFBD_API_KEY;
  if (!apiKey) throw new Error("Pass the CFBD API key as argv[2] or set CFBD_API_KEY env var.");
  const minSeason = Number(process.argv[3]) || 2020;
  const splitSeason = Number(process.argv[4]) || 2024;
  const maxSeason = Number(process.argv[5]) || 2025;

  // SP+ ratings from minSeason-1 through maxSeason-1 (same as backtest-ncaaf-sp-plus-signal.js).
  const ratingsBySeason = {};
  for (let s = minSeason - 1; s <= maxSeason - 1; s++) {
    const data = await fetchJsonCached(`https://api.collegefootballdata.com/ratings/sp?year=${s}`, path.join(CACHE_DIR, `cfbd-sp-${s}.json`), apiKey);
    const byTeam = {};
    for (const t of data) if (t.offense?.rating != null && t.defense?.rating != null) byTeam[t.team] = { off: t.offense.rating, def: t.defense.rating };
    const leagueAvgOff = mean(Object.values(byTeam).map((t) => t.off));
    const leagueAvgDef = mean(Object.values(byTeam).map((t) => t.def));
    ratingsBySeason[s] = { byTeam, leagueAvgOff, leagueAvgDef };
  }

  // Real games for minSeason-maxSeason, FBS-v-FBS only, sorted for point-in-time processing.
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
  console.log(`Loaded ${allGames.length} completed FBS-v-FBS games, ${minSeason}-${maxSeason}.`);

  // Point-in-time in-season combined scoring tendency, same shape as NFL's teamScoringDelta:
  // cumulative (scored+allowed)/games through strictly prior weeks of THIS season, minus this
  // season's real league-average total (computed once, all real completed games).
  const leagueTotalsBySeason = {};
  for (const g of allGames) {
    const total = g.homePoints + g.awayPoints;
    leagueTotalsBySeason[g.season] = leagueTotalsBySeason[g.season] || { sum: 0, games: 0 };
    leagueTotalsBySeason[g.season].sum += total;
    leagueTotalsBySeason[g.season].games += 1;
  }
  const cumulative = {}; // `${season}:${team}` -> { scoredSum, allowedSum, games }
  const samples = [];
  for (const g of allGames) {
    const season = g.season;
    const homeKey = `${season}:${g.homeTeam}`;
    const awayKey = `${season}:${g.awayTeam}`;
    const leagueAvgTotal = leagueTotalsBySeason[season].sum / leagueTotalsBySeason[season].games;
    const homeCum = cumulative[homeKey];
    const awayCum = cumulative[awayKey];
    let inSeasonTendency = null;
    if (homeCum && awayCum && homeCum.games >= MIN_GAMES_FOR_TENDENCY && awayCum.games >= MIN_GAMES_FOR_TENDENCY) {
      const homeInvolvement = (homeCum.scoredSum + homeCum.allowedSum) / homeCum.games;
      const awayInvolvement = (awayCum.scoredSum + awayCum.allowedSum) / awayCum.games;
      inSeasonTendency = (homeInvolvement + awayInvolvement) / 2 - leagueAvgTotal;
    }

    const prior = ratingsBySeason[season - 1];
    const home = prior?.byTeam[g.homeTeam];
    const away = prior?.byTeam[g.awayTeam];
    let spPlusTendency = null;
    if (home && away) {
      spPlusTendency = home.off - prior.leagueAvgOff + (away.off - prior.leagueAvgOff) + (home.def - prior.leagueAvgDef) + (away.def - prior.leagueAvgDef);
    }

    samples.push({ season, week: g.week, actualTotal: g.homePoints + g.awayPoints, inSeasonTendency, spPlusTendency });

    cumulative[homeKey] = cumulative[homeKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    cumulative[homeKey].scoredSum += g.homePoints;
    cumulative[homeKey].allowedSum += g.awayPoints;
    cumulative[homeKey].games += 1;
    cumulative[awayKey] = cumulative[awayKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    cumulative[awayKey].scoredSum += g.awayPoints;
    cumulative[awayKey].allowedSum += g.homePoints;
    cumulative[awayKey].games += 1;
  }

  const both = samples.filter((s) => s.inSeasonTendency != null && s.spPlusTendency != null);
  console.log(`${both.length} games with BOTH signals available (in-season needs ${MIN_GAMES_FOR_TENDENCY}+ prior games this season).\n`);

  console.log("--- Standalone correlations vs actual total points ---");
  console.log(`  spPlusTendency (all ${samples.filter((s) => s.spPlusTendency != null).length} games): r=${pearson(samples.map((s) => s.spPlusTendency), samples.map((s) => s.actualTotal)).r?.toFixed(4)}`);
  console.log(`  inSeasonTendency (all ${samples.filter((s) => s.inSeasonTendency != null).length} games): r=${pearson(samples.map((s) => s.inSeasonTendency), samples.map((s) => s.actualTotal)).r?.toFixed(4)}`);
  console.log(`  Both signals present (${both.length} games) -- spPlusTendency alone: r=${pearson(both.map((s) => s.spPlusTendency), both.map((s) => s.actualTotal)).r?.toFixed(4)}`);
  console.log(`  Both signals present (${both.length} games) -- inSeasonTendency alone: r=${pearson(both.map((s) => s.inSeasonTendency), both.map((s) => s.actualTotal)).r?.toFixed(4)}`);

  // Normalize each by its own real p75-of-|value| (same methodology as every other scale in this
  // repo), THEN blend at several weights -- so "50/50" means equal weight after normalization, not
  // equal weight on two differently-scaled raw numbers.
  const absP75 = (vals) => percentile(vals.map(Math.abs).sort((a, b) => a - b), 0.75);
  const spScale = absP75(both.map((s) => s.spPlusTendency));
  const inSeasonScale = absP75(both.map((s) => s.inSeasonTendency));
  console.log(`\nNormalization scales: spPlusTendency p75=${spScale.toFixed(2)}, inSeasonTendency p75=${inSeasonScale.toFixed(2)}`);

  const train = both.filter((s) => s.season < splitSeason);
  const test = both.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);

  console.log("\n--- Blend weight sweep (weight = share on spPlusTendency; rest on inSeasonTendency) ---");
  console.log("weight  train_r   test_r");
  for (const w of [1.0, 0.9, 0.75, 0.5, 0.25, 0.1, 0.0]) {
    const blended = (s) => w * (s.spPlusTendency / spScale) + (1 - w) * (s.inSeasonTendency / inSeasonScale);
    const trainR = pearson(train.map(blended), train.map((s) => s.actualTotal)).r;
    const testR = pearson(test.map(blended), test.map((s) => s.actualTotal)).r;
    console.log(`  ${w.toFixed(2)}   ${trainR?.toFixed(4)}   ${testR?.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
