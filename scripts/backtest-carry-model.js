// Backtests the MLB carry model in rules-engine.js against real historical (weather, result) pairs
// -- checks whether scoreMlbGame's predicted carryFt/scoringLean actually correlates with real
// combined runs, the same kind of calibration check the racing app's Weather Bias Predictor Score
// got. Standalone script (plain fetch, no Cloudflare bindings) so it can run locally against a full
// season without touching the Worker's KV cache or quota.
//
// Usage: node scripts/backtest-carry-model.js [season]   (defaults to last full season)
//
// Scope: open-air MLB venues only. Closed-roof venues (see the "outdoor temp/humidity leaking into
// carryFt" fix in DECISIONS.md) now correctly hold carryFt near-constant regardless of outdoor
// weather -- there's no variation to test a correlation against, so including them would just
// dilute the sample with points that are trivially "flat" by construction.

import { scoreMlbGame } from "../workers/rules-engine.js";
import { MLB_STADIUMS, MLB_TEAM_ID_TO_KEY } from "../data/stadiums.js";

const SEASON = process.argv[2] ? Number(process.argv[2]) : new Date().getUTCFullYear() - 1;
const HEADERS = { "User-Agent": "GiddyUpSports-Weather-Backtest/1.0 (contact: jvilla10214@gmail.com)" };
const MLB_KEY_TO_TEAM_ID = Object.fromEntries(Object.entries(MLB_TEAM_ID_TO_KEY).map(([id, key]) => [key, Number(id)]));

async function fetchSeasonHomeGames(teamId, season) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${season}-01-01&endDate=${season}-12-31&hydrate=linescore`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`MLB schedule ${res.status} for team ${teamId}`);
  const data = await res.json();
  const games = [];
  for (const d of data.dates || []) {
    for (const g of d.games || []) {
      if (g.gameType !== "R") continue; // regular season only -- skip spring training/postseason
      if (g.teams?.home?.team?.id !== teamId) continue;
      if (g.status?.abstractGameState !== "Final") continue;
      const awayScore = g.teams.away?.score;
      const homeScore = g.teams.home?.score;
      if (awayScore == null || homeScore == null) continue;
      games.push({ date: d.date, awayScore, homeScore });
    }
  }
  return games;
}

async function fetchSeasonWeather(lat, lon, season) {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${season}-01-01&end_date=${season}-12-31` +
    `&daily=temperature_2m_mean,relative_humidity_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo archive ${res.status}`);
  const data = await res.json();
  const { time, temperature_2m_mean, relative_humidity_2m_mean, wind_speed_10m_max, wind_direction_10m_dominant } = data.daily;
  const byDate = new Map();
  for (let i = 0; i < time.length; i++) {
    byDate.set(time[i], {
      tempF: temperature_2m_mean[i],
      humidityPct: relative_humidity_2m_mean[i],
      windSpeedMph: wind_speed_10m_max[i],
      windFromDeg: wind_direction_10m_dominant[i],
      precipProbPct: 0,
    });
  }
  return byDate;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}
function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

async function main() {
  const teamKeys = Object.entries(MLB_STADIUMS)
    .filter(([, v]) => v.roofType === "open")
    .map(([k]) => k);

  console.error(`Backtesting ${SEASON} season across ${teamKeys.length} open-air venues...\n`);

  const samples = [];
  for (const key of teamKeys) {
    const venue = MLB_STADIUMS[key];
    const teamId = MLB_KEY_TO_TEAM_ID[key];
    try {
      const [games, weatherByDate] = await Promise.all([
        fetchSeasonHomeGames(teamId, SEASON),
        fetchSeasonWeather(venue.lat, venue.lon, SEASON),
      ]);
      let matched = 0;
      for (const g of games) {
        const w = weatherByDate.get(g.date);
        if (!w || w.tempF == null || w.windSpeedMph == null || w.windFromDeg == null) continue;
        const score = scoreMlbGame(w, venue);
        samples.push({
          venue: key,
          date: g.date,
          carryFt: score.carryFt,
          windCarryFt: score.windCarryFt,
          scoringLean: score.scoringLean,
          combinedRuns: g.awayScore + g.homeScore,
        });
        matched++;
      }
      console.error(`  ${key.padEnd(4)} ${venue.venue.padEnd(28)} ${games.length} games, ${matched} matched to weather`);
    } catch (err) {
      console.error(`  ${key} FAILED: ${err.message}`);
    }
  }

  console.log(`\n=== Results: ${SEASON} season, ${samples.length} total game samples ===\n`);

  const carryFts = samples.map((s) => s.carryFt);
  const runs = samples.map((s) => s.combinedRuns);
  const r = pearson(carryFts, runs);
  console.log(`Pearson correlation (predicted carryFt vs. actual combined runs): ${r.toFixed(4)}`);
  console.log(`(0 = no relationship, +1 = perfect positive, typically weak-to-moderate for a single`);
  console.log(` weather factor against a noisy outcome like runs -- context follows.)\n`);

  console.log("By predicted scoring lean:");
  for (const lean of ["hitter-friendly", "neutral", "pitcher-friendly"]) {
    const bucket = samples.filter((s) => s.scoringLean === lean).map((s) => s.combinedRuns);
    if (!bucket.length) {
      console.log(`  ${lean.padEnd(17)} n=0`);
      continue;
    }
    console.log(`  ${lean.padEnd(17)} n=${String(bucket.length).padEnd(5)} mean runs=${mean(bucket).toFixed(2).padEnd(6)} stdev=${stdev(bucket).toFixed(2)}`);
  }

  console.log(`\nOverall mean combined runs (all samples): ${mean(runs).toFixed(2)}`);

  // Coors Field's altitude bonus alone (~40ft) clears the hitter-friendly threshold (12ft)
  // regardless of wind, and Coors is a well-documented scoring outlier for reasons unrelated to
  // wind timing -- checking with it excluded separates "does the wind-timing signal generalize"
  // from "did one extreme, already-famous park's real effect dominate the average."
  const noColorado = samples.filter((s) => s.venue !== "COL");
  const rNoCol = pearson(noColorado.map((s) => s.carryFt), noColorado.map((s) => s.combinedRuns));
  console.log(`\n=== Same analysis excluding Coors Field (n=${noColorado.length}) ===`);
  console.log(`Pearson correlation (carryFt vs. runs), Coors excluded: ${rNoCol.toFixed(4)}`);
  for (const lean of ["hitter-friendly", "neutral", "pitcher-friendly"]) {
    const bucket = noColorado.filter((s) => s.scoringLean === lean).map((s) => s.combinedRuns);
    if (!bucket.length) continue;
    console.log(`  ${lean.padEnd(17)} n=${String(bucket.length).padEnd(5)} mean runs=${mean(bucket).toFixed(2).padEnd(6)} stdev=${stdev(bucket).toFixed(2)}`);
  }

  // Isolating just the wind-driven component (windCarryFt, which excludes the fixed altitude/temp
  // baseline every park carries regardless of the day's wind) checks whether wind TIMING itself --
  // the thing this product actually claims to read game-by-game -- has a real relationship to
  // scoring, independent of which park a game happens to be in.
  const rWindOnly = pearson(samples.map((s) => s.windCarryFt), samples.map((s) => s.combinedRuns));
  console.log(`\nPearson correlation (wind-only component vs. runs, all parks pooled): ${rWindOnly.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
