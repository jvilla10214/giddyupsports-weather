// Follow-up to backtest-nfl-expanded-signals.js: of six new candidates tested there (rest, short
// week, divisional game, referee tendency, QB change, travel distance), only qbChange showed a real
// effect (r=-0.1239, n=1327, group means 43.64 vs 47.16 actual total points) -- comparable to or
// larger than the existing wind/temp signals, and the only one worth folding into a composite.
//
// This script builds that composite (wind + temp + teamScoringDelta + qbChange, same normalize-by-
// real-p75 methodology as backtest-nfl-environment-score.js) and, critically, evaluates it with an
// honest TRAIN/TEST split rather than fitting and hit-rate-testing on the same games -- searching
// across six candidate signals and keeping the one that correlated is exactly the multiple-
// comparisons trap that makes in-sample-only validation unsafe here. Composite weights and the OLS
// fit are learned ONLY on minSeason..splitSeason-1; the real Likely Over/Under hit-rate check runs
// ONLY on splitSeason..maxSeason, seasons the fit never saw.
//
// Usage: node scripts/backtest-nfl-qbchange-composite.js [minSeason] [splitSeason] [maxSeason]
//   defaults: train 2020-2023, test 2024-2025.

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
function absP75(values) {
  const abs = values.filter((v) => v != null && Number.isFinite(v)).map((v) => Math.abs(v)).sort((a, b) => a - b);
  return percentile(abs, 0.75);
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
    intercept = my - slope * mx,
    r = sxy / Math.sqrt(sxx * syy);
  return { n, slope, intercept, r, r2: r * r };
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const csvText = fs.readFileSync(CACHE_FILE, "utf8"); // reuse the cache the other two scripts already populated
  const rows = parseCsv(csvText);
  const games = rows.filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.away_score !== "";
  });
  const gamesSorted = games.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));

  const leagueTotalsBySeason = {};
  for (const g of games) {
    const total = Number(g.home_score) + Number(g.away_score);
    leagueTotalsBySeason[g.season] = leagueTotalsBySeason[g.season] || { sum: 0, games: 0 };
    leagueTotalsBySeason[g.season].sum += total;
    leagueTotalsBySeason[g.season].games += 1;
  }

  const teamCumulative = {};
  const teamScoringDeltaByGameId = {};
  const qbCounts = {};
  const qbChangeByGameId = {};
  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`,
      awayKey = `${season}:${g.away_team}`;
    const leagueAvgTotal = leagueTotalsBySeason[season].sum / leagueTotalsBySeason[season].games;
    const homeCum = teamCumulative[homeKey],
      awayCum = teamCumulative[awayKey];
    let teamScoringDelta = null;
    if (homeCum && awayCum && homeCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY && awayCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) {
      teamScoringDelta = ((homeCum.scoredSum + homeCum.allowedSum) / homeCum.games + (awayCum.scoredSum + awayCum.allowedSum) / awayCum.games) / 2 - leagueAvgTotal;
    }
    teamScoringDeltaByGameId[g.game_id] = teamScoringDelta;

    const homeCounts = qbCounts[homeKey],
      awayCounts = qbCounts[awayKey];
    function isChange(counts, qbName) {
      if (!counts || !qbName) return null;
      const entries = Object.entries(counts);
      const totalStarts = entries.reduce((a, [, c]) => a + c, 0);
      if (totalStarts < 3) return null;
      const [leaderName] = entries.sort((a, b) => b[1] - a[1])[0];
      return leaderName !== qbName;
    }
    const homeQbChange = isChange(homeCounts, g.home_qb_name);
    const awayQbChange = isChange(awayCounts, g.away_qb_name);
    qbChangeByGameId[g.game_id] = homeQbChange == null && awayQbChange == null ? null : homeQbChange || awayQbChange ? 1 : 0;

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
    if (g.home_qb_name) {
      qbCounts[homeKey] = qbCounts[homeKey] || {};
      qbCounts[homeKey][g.home_qb_name] = (qbCounts[homeKey][g.home_qb_name] || 0) + 1;
    }
    if (g.away_qb_name) {
      qbCounts[awayKey] = qbCounts[awayKey] || {};
      qbCounts[awayKey][g.away_qb_name] = (qbCounts[awayKey][g.away_qb_name] || 0) + 1;
    }
  }

  const samples = games.map((g) => {
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const roofClosed = g.roof === "closed" || g.roof === "dome";
    return {
      gameId: g.game_id,
      season: Number(g.season),
      roofClosed,
      windMph: g.wind !== "" ? Number(g.wind) : roofClosed ? 0 : null,
      tempF: g.temp !== "" ? Number(g.temp) : null,
      teamScoringDelta: teamScoringDeltaByGameId[g.game_id] ?? null,
      qbChange: qbChangeByGameId[g.game_id] ?? null,
      actualTotal,
      totalLine: g.total_line !== "" ? Number(g.total_line) : null,
    };
  });

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`Train: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})\n`);

  // Scales and weights learned ONLY on train.
  const trainOutdoor = train.filter((s) => !s.roofClosed);
  const windScale = absP75(trainOutdoor.map((s) => s.windMph));
  const tempScale = absP75(trainOutdoor.map((s) => s.tempF - 60));
  const teamScale = absP75(train.map((s) => s.teamScoringDelta));
  // qbChange is already 0/1 -- no scale needed, just a signed contribution.
  const WEIGHTS = { wind: 1.0, temp: 0.6, team: 1.0, qbChange: 1.0 };

  function composite(s) {
    const contributions = [];
    if (!s.roofClosed && s.windMph != null) contributions.push({ w: WEIGHTS.wind, v: -s.windMph / windScale });
    if (!s.roofClosed && s.tempF != null) contributions.push({ w: WEIGHTS.temp, v: (s.tempF - 60) / tempScale });
    if (s.teamScoringDelta != null) contributions.push({ w: WEIGHTS.team, v: s.teamScoringDelta / teamScale });
    if (s.qbChange != null) contributions.push({ w: WEIGHTS.qbChange, v: s.qbChange === 1 ? -1 : 0 });
    if (!contributions.length) return null;
    const wSum = contributions.reduce((a, c) => a + c.w, 0);
    return contributions.reduce((a, c) => a + c.w * c.v, 0) / wSum;
  }

  const trainScored = train.map((s) => ({ ...s, gameEnvScore: composite(s) }));
  const fit = olsFit(trainScored.map((s) => s.gameEnvScore), trainScored.map((s) => s.actualTotal));
  console.log("--- Fit on TRAIN only ---");
  console.log(`  impliedTotal = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(3)} * gameEnvScore`);
  console.log(`  n=${fit.n}  r=${fit.r.toFixed(4)}  r2=${fit.r2.toFixed(4)}`);

  // For comparison, the same fit WITHOUT qbChange (i.e. the original three-signal composite),
  // learned on the identical train split, so the delta below isolates qbChange's real contribution.
  function compositeNoQb(s) {
    const contributions = [];
    if (!s.roofClosed && s.windMph != null) contributions.push({ w: WEIGHTS.wind, v: -s.windMph / windScale });
    if (!s.roofClosed && s.tempF != null) contributions.push({ w: WEIGHTS.temp, v: (s.tempF - 60) / tempScale });
    if (s.teamScoringDelta != null) contributions.push({ w: WEIGHTS.team, v: s.teamScoringDelta / teamScale });
    if (!contributions.length) return null;
    const wSum = contributions.reduce((a, c) => a + c.w, 0);
    return contributions.reduce((a, c) => a + c.w * c.v, 0) / wSum;
  }
  const trainScoredNoQb = train.map((s) => ({ ...s, gameEnvScore: compositeNoQb(s) }));
  const fitNoQb = olsFit(trainScoredNoQb.map((s) => s.gameEnvScore), trainScoredNoQb.map((s) => s.actualTotal));
  console.log(`  (baseline, no qbChange: r=${fitNoQb.r.toFixed(4)}  r2=${fitNoQb.r2.toFixed(4)})`);

  function hitRateReport(label, scoredFn, fitToUse) {
    const testScored = test.map((s) => ({ ...s, gameEnvScore: scoredFn(s) }));
    console.log(`\n--- ${label}: real Likely Over/Under hit rate on HELD-OUT test seasons (${splitSeason}-${maxSeason}) ---`);
    for (const margin of [1, 2, 3, 4]) {
      let overCalls = 0,
        overHits = 0,
        underCalls = 0,
        underHits = 0,
        tossUps = 0,
        pushes = 0;
      for (const s of testScored) {
        if (s.gameEnvScore == null || s.totalLine == null) continue;
        const impliedTotal = fitToUse.intercept + fitToUse.slope * s.gameEnvScore;
        const delta = impliedTotal - s.totalLine;
        const actualResult = s.actualTotal > s.totalLine ? "over" : s.actualTotal < s.totalLine ? "under" : "push";
        if (actualResult === "push") pushes++;
        if (delta >= margin) {
          overCalls++;
          if (actualResult === "over") overHits++;
        } else if (delta <= -margin) {
          underCalls++;
          if (actualResult === "under") underHits++;
        } else tossUps++;
      }
      const overRate = overCalls ? ((overHits / overCalls) * 100).toFixed(1) : "n/a";
      const underRate = underCalls ? ((underHits / underCalls) * 100).toFixed(1) : "n/a";
      console.log(`  margin=${margin}: Likely Over ${overCalls} calls, ${overRate}% hit | Likely Under ${underCalls} calls, ${underRate}% hit | Toss-up ${tossUps} | pushes ${pushes}`);
    }
  }

  hitRateReport("WITH qbChange", composite, fit);
  hitRateReport("WITHOUT qbChange (baseline)", compositeNoQb, fitNoQb);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
