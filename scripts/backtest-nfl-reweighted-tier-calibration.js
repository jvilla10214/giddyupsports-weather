// Recalibrates NFL's tier thresholds against the REAL updated formula (regression-derived weights +
// the new turf input, see NFL_GES_WEIGHTS's comment in rules-engine.js) -- the old
// -0.92/-0.60/+0.13/+0.62 thresholds were calibrated against the OLD ad-hoc-weighted composite and
// no longer describe this one's real distribution. Also re-checks the actual Likely Over/Under call
// hit rate against real historical odds (same methodology as the original
// backtest-nfl-environment-score.js) to confirm the validated correlation gain actually shows up as
// better real calls, not just a better abstract r.
//
// Usage: node scripts/backtest-nfl-reweighted-tier-calibration.js [minSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeGameEnvironmentScore } from "../workers/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
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

function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const maxSeason = Number(process.argv[3]) || 2025;

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "nfl-environment-score-samples.json"), "utf8"));
  const gamesCsv = parseCsv(fs.readFileSync(path.join(__dirname, ".res-cache", "nfl-games.csv"), "utf8"));
  const surfaceByGameId = {};
  for (const g of gamesCsv) surfaceByGameId[g.game_id] = g.surface;

  const samples = raw.samples
    .filter((s) => Number(s.season) >= minSeason && Number(s.season) <= maxSeason)
    .map((s) => {
      const surf = surfaceByGameId[s.gameId];
      const isTurf = surf ? (surf.trim() === "grass" ? false : true) : null;
      const result = computeGameEnvironmentScore({ windMph: s.windMph, tempF: s.tempF, roofClosed: s.roofClosed, teamScoringDelta: s.teamScoringDelta, isTurf });
      return { ...s, gameEnvScore: result?.score ?? null };
    });
  console.log(`Loaded ${samples.length} real games (${minSeason}-${maxSeason}).`);

  const scoreSorted = samples.map((s) => s.gameEnvScore).filter((v) => v != null).sort((a, b) => a - b);
  console.log(`\n--- New composite score percentiles (reweighted + turf, ${scoreSorted.length} scored games) ---`);
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) console.log(`  p${p * 100}: ${percentile(scoreSorted, p).toFixed(3)}`);

  const fit = olsFit(samples.map((s) => s.gameEnvScore), samples.map((s) => s.actualTotal));
  console.log(`\nOLS fit vs actual total points: r=${fit.r.toFixed(4)}  r2=${fit.r2 ?? (fit.r * fit.r).toFixed(4)}  n=${fit.n}`);

  console.log("\n--- Real Likely Over/Under call hit rate vs actual historical odds (NEW formula) ---");
  for (const margin of [1, 2, 3, 4]) {
    let overCalls = 0, overHits = 0, underCalls = 0, underHits = 0, pushes = 0, tossUps = 0;
    for (const s of samples) {
      if (s.gameEnvScore == null || s.totalLine == null) continue;
      const impliedTotal = fit.intercept + fit.slope * s.gameEnvScore;
      const delta = impliedTotal - s.totalLine;
      const actualResult = s.actualTotal > s.totalLine ? "over" : s.actualTotal < s.totalLine ? "under" : "push";
      if (actualResult === "push") pushes++;
      if (delta >= margin) {
        overCalls++;
        if (actualResult === "over") overHits++;
      } else if (delta <= -margin) {
        underCalls++;
        if (actualResult === "under") underHits++;
      } else {
        tossUps++;
      }
    }
    const overRate = overCalls ? ((overHits / overCalls) * 100).toFixed(1) : "n/a";
    const underRate = underCalls ? ((underHits / underCalls) * 100).toFixed(1) : "n/a";
    console.log(`  margin=${margin}: Likely Over ${overCalls} calls, ${overRate}% hit | Likely Under ${underCalls} calls, ${underRate}% hit | Toss-up ${tossUps} | pushes ${pushes}`);
  }
}

main();
