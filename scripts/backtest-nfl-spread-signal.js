// First real ATS (against-the-spread) test for NFL, using nflverse's `spread_line` column (never
// used before -- every prior NFL backtest in this repo only tested totals). Candidate signal: a
// point-in-time "power differential" -- home team's season-to-date net scoring margin
// ((scoredSum-allowedSum)/games) minus away team's, same point-in-time-only methodology (no
// look-ahead) as teamScoringDelta in backtest-nfl-environment-score.js, just computed as a
// difference instead of an average (average is right for predicting TOTAL points; difference is
// the natural analog for predicting MARGIN/spread).
//
// IMPORTANT: raw correlation between spread_line and actual margin is high (r=0.43, confirmed) --
// but that's trivial and expected, since the closing spread's whole purpose is predicting margin.
// It says nothing about whether OUR signal adds anything the market doesn't already have. The real
// test is whether powerDiff predicts the RESIDUAL: does actual margin deviate from the closing
// spread in the direction powerDiff points, more often than chance? That's what the hit-rate section
// below actually checks, with an honest train/2020-23-test/2024-25 split.
//
// Usage: node scripts/backtest-nfl-spread-signal.js [minSeason] [splitSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_TEAM_GAMES_FOR_TENDENCY } from "../workers/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, ".res-cache", "nfl-games.csv");

function parseCsv(text) {
  const lines = text.split("\n").filter(Boolean);
  const header = parseLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const row = {};
    for (const h of header) row[h] = cols[idx[h]];
    rows.push(row);
  }
  return rows;
  function parseLine(line) {
    const out = [];
    let cur = "",
      inQ = false;
    for (const c of line) {
      if (c === '"') {
        inQ = !inQ;
        continue;
      }
      if (c === "," && !inQ) {
        out.push(cur);
        cur = "";
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  }
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx),
    hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
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
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const csvText = fs.readFileSync(CACHE_FILE, "utf8");
  const rows = parseCsv(csvText);
  const games = rows.filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.spread_line !== "";
  });
  const gamesSorted = games.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  console.log(`Loaded ${games.length} completed REG games with a spread line in ${minSeason}-${maxSeason}.\n`);

  // Point-in-time NET scoring margin per team (not the average used for totals -- a difference is
  // the right analog for predicting margin/spread).
  const teamCumulative = {};
  const powerDiffByGameId = {};
  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`,
      awayKey = `${season}:${g.away_team}`;
    const homeCum = teamCumulative[homeKey],
      awayCum = teamCumulative[awayKey];
    let powerDiff = null;
    if (homeCum && awayCum && homeCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY && awayCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) {
      const homeNetMargin = (homeCum.scoredSum - homeCum.allowedSum) / homeCum.games;
      const awayNetMargin = (awayCum.scoredSum - awayCum.allowedSum) / awayCum.games;
      powerDiff = homeNetMargin - awayNetMargin;
    }
    powerDiffByGameId[g.game_id] = powerDiff;

    const homeScore = Number(g.home_score),
      awayScore = Number(g.away_score);
    teamCumulative[homeKey] = teamCumulative[homeKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamCumulative[homeKey].scoredSum += homeScore;
    teamCumulative[homeKey].allowedSum += awayScore;
    teamCumulative[homeKey].games += 1;
    teamCumulative[awayKey] = teamCumulative[awayKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamCumulative[awayKey].scoredSum += awayScore;
    teamCumulative[awayKey].allowedSum += homeScore;
    teamCumulative[awayKey].games += 1;
  }

  const samples = games.map((g) => {
    const margin = Number(g.home_score) - Number(g.away_score);
    const spreadLine = Number(g.spread_line);
    return {
      season: Number(g.season),
      margin,
      spreadLine,
      residual: margin - spreadLine, // how much the actual result beat/missed the closing line, home perspective
      powerDiff: powerDiffByGameId[g.game_id] ?? null,
    };
  });

  console.log("--- powerDiff (home net margin minus away net margin) vs the RESIDUAL (margin - spreadLine) ---");
  console.log("This is the real test: does our signal predict what the closing line got wrong, not just predict margin itself.");
  const { r, n } = pearson(samples.map((s) => s.powerDiff), samples.map((s) => s.residual));
  console.log(`  r=${r != null ? r.toFixed(4) : "n/a"}  n=${n}`);
  const { r: rMargin } = pearson(samples.map((s) => s.powerDiff), samples.map((s) => s.margin));
  console.log(`  (for reference, powerDiff vs raw margin directly: r=${rMargin?.toFixed(4)} -- expected to be much higher, since margin includes what the market already predicted)`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);

  // Fit residual = a + b*powerDiff on TRAIN only, then check real ATS hit rate on the held-out TEST
  // seasons -- same discipline as the qbChange composite.
  function olsFit(xs, ys) {
    const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
    const nn = pairs.length;
    const mx = mean(pairs.map((p) => p[0])),
      my = mean(pairs.map((p) => p[1]));
    let sxy = 0,
      sxx = 0;
    for (const [x, y] of pairs) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    }
    const slope = sxy / sxx,
      intercept = my - slope * mx;
    return { n: nn, slope, intercept };
  }
  const fit = olsFit(train.map((s) => s.powerDiff), train.map((s) => s.residual));
  console.log(`\nFit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * powerDiff  (n=${fit.n})`);

  console.log("\n--- Real ATS hit rate on HELD-OUT test seasons ---");
  for (const margin of [1, 2, 3, 4]) {
    let homeCoverCalls = 0,
      homeCoverHits = 0,
      awayCoverCalls = 0,
      awayCoverHits = 0,
      pushes = 0,
      noCall = 0;
    for (const s of test) {
      if (s.powerDiff == null) continue;
      const predictedResidual = fit.intercept + fit.slope * s.powerDiff;
      const actualCover = s.margin > s.spreadLine ? "home" : s.margin < s.spreadLine ? "away" : "push";
      if (actualCover === "push") pushes++;
      if (predictedResidual >= margin) {
        homeCoverCalls++;
        if (actualCover === "home") homeCoverHits++;
      } else if (predictedResidual <= -margin) {
        awayCoverCalls++;
        if (actualCover === "away") awayCoverHits++;
      } else {
        noCall++;
      }
    }
    const homeRate = homeCoverCalls ? ((homeCoverHits / homeCoverCalls) * 100).toFixed(1) : "n/a";
    const awayRate = awayCoverCalls ? ((awayCoverHits / awayCoverCalls) * 100).toFixed(1) : "n/a";
    console.log(`  margin=${margin}: Home-covers calls ${homeCoverCalls}, ${homeRate}% hit | Away-covers calls ${awayCoverCalls}, ${awayRate}% hit | No call ${noCall} | pushes ${pushes}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
