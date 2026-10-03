// Real per-play-EPA totals test for NFL -- the gap this project's prior work left open. EPA was
// tested for SPREAD only (backtest-nfl-epa-spread-signal.js: r=0.0182 vs the ATS residual, no real
// edge). NFL totals have only ever been tested with the simpler "combined scoring involvement"
// proxy already shipped (teamScoringDelta in rules-engine.js -- average of scoredSum+allowedSum per
// game, not real per-play efficiency). This fills that gap: does nflverse's real EPA/play predict
// what the closing TOTAL line got wrong, the same honest way the spread version was tested.
//
// Candidate signal, built from the SAME four point-in-time per-team components the spread version
// already computes (offensive EPA/game, defensive EPA/game allowed) but combined differently: a
// spread signal wants the DIFFERENCE between two teams' net efficiency (who's relatively better);
// a totals signal wants the SUM of everything that drives combined scoring -- both offenses' real
// quality AND both defenses' real weakness (high EPA allowed), all four pushing the same direction.
//   totalEpaSignal = homeOff + awayOff + homeDefAllowed + awayDefAllowed
// (all four per-game, point-in-time, no-look-ahead -- same MIN_TEAM_GAMES_FOR_TENDENCY gate as
// every other signal here). A good offense raises expected combined points; a leaky defense
// (high EPA allowed) does too, regardless of which side of the matchup it's on.
//
// Same honest train(2020-23)/test(2024-25) discipline as every other backtest in this repo.
//
// Usage: node scripts/backtest-nfl-epa-totals-signal.js [minSeason] [splitSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_TEAM_GAMES_FOR_TENDENCY } from "../workers/rules-engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const GAMES_CACHE = path.join(CACHE_DIR, "nfl-games.csv");
const GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

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
    let cur = "", inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; continue; }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }
}
async function loadCached(url, cacheFile) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 24 * 60 * 60 * 1000) {
    return fs.readFileSync(cacheFile, "utf8");
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(cacheFile, text);
  return text;
}
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 2) return { r: null, n };
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { const dx = x - mx, dy = y - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { r: sxy / Math.sqrt(sxx * syy), n };
}
function olsFit(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  return { n, slope, intercept };
}

async function loadEpaByGameTeam(minSeason, maxSeason) {
  const byKey = {};
  for (let season = minSeason; season <= maxSeason; season++) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
    const cacheFile = path.join(CACHE_DIR, `stats_team_week_${season}.csv`);
    const text = await loadCached(url, cacheFile);
    const rows = parseCsv(text);
    for (const r of rows) {
      if (r.season_type !== "REG") continue;
      const off = Number(r.passing_epa) + Number(r.rushing_epa);
      if (!Number.isFinite(off)) continue;
      byKey[`${r.game_id}:${r.team}`] = { season: Number(r.season), week: Number(r.week), team: r.team, opponent: r.opponent_team, off };
    }
  }
  return byKey;
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const [gamesText, epaByKey] = await Promise.all([loadCached(GAMES_URL, GAMES_CACHE), loadEpaByGameTeam(minSeason, maxSeason)]);
  const gameRows = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.total_line !== "";
  });
  console.log(`Loaded ${gameRows.length} completed REG games with a total line in ${minSeason}-${maxSeason}.`);
  console.log(`Loaded EPA rows for ${Object.keys(epaByKey).length} team-games.`);

  const gamesSorted = gameRows.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const cumulative = {}; // `${season}:${team}` -> { offSum, defAllowedSum, games }
  const pointInTimeByGameId = {}; // gameId -> { homeOff, awayOff, homeDefAllowed, awayDefAllowed } or nulls

  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`;
    const awayKey = `${season}:${g.away_team}`;
    const homeCum = cumulative[homeKey];
    const awayCum = cumulative[awayKey];
    const enough = (c) => c && c.games >= MIN_TEAM_GAMES_FOR_TENDENCY;
    pointInTimeByGameId[g.game_id] = {
      homeOff: enough(homeCum) ? homeCum.offSum / homeCum.games : null,
      awayOff: enough(awayCum) ? awayCum.offSum / awayCum.games : null,
      homeDefAllowed: enough(homeCum) ? homeCum.defAllowedSum / homeCum.games : null,
      awayDefAllowed: enough(awayCum) ? awayCum.defAllowedSum / awayCum.games : null,
    };

    const homeRow = epaByKey[`${g.game_id}:${g.home_team}`];
    const awayRow = epaByKey[`${g.game_id}:${g.away_team}`];
    if (homeRow && awayRow) {
      cumulative[homeKey] = cumulative[homeKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[homeKey].offSum += homeRow.off;
      cumulative[homeKey].defAllowedSum += awayRow.off;
      cumulative[homeKey].games += 1;
      cumulative[awayKey] = cumulative[awayKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[awayKey].offSum += awayRow.off;
      cumulative[awayKey].defAllowedSum += homeRow.off;
      cumulative[awayKey].games += 1;
    }
  }

  const samples = gameRows.map((g) => {
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const totalLine = Number(g.total_line);
    const p = pointInTimeByGameId[g.game_id] || {};
    const allFour = [p.homeOff, p.awayOff, p.homeDefAllowed, p.awayDefAllowed];
    const totalEpaSignal = allFour.every((x) => x != null) ? allFour.reduce((a, b) => a + b, 0) : null;
    return { season: Number(g.season), actualTotal, totalLine, residual: actualTotal - totalLine, totalEpaSignal };
  });

  console.log("\n--- totalEpaSignal (homeOff + awayOff + homeDefAllowed + awayDefAllowed) vs the RESIDUAL (actualTotal - totalLine) ---");
  console.log("The real test: does real per-play efficiency predict what the closing total line got wrong.");
  const vsResidual = pearson(samples.map((s) => s.totalEpaSignal), samples.map((s) => s.residual));
  console.log(`  r=${vsResidual.r != null ? vsResidual.r.toFixed(4) : "n/a"}  n=${vsResidual.n}`);
  const vsActual = pearson(samples.map((s) => s.totalEpaSignal), samples.map((s) => s.actualTotal));
  console.log(`  (for reference, totalEpaSignal vs actual total directly: r=${vsActual.r?.toFixed(4)}, n=${vsActual.n})`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);

  const fit = olsFit(train.map((s) => s.totalEpaSignal), train.map((s) => s.residual));
  console.log(`\nFit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * totalEpaSignal  (n=${fit.n})`);

  const testPreds = test.map((s) => (s.totalEpaSignal != null ? fit.intercept + fit.slope * s.totalEpaSignal : null));
  const heldOutR = pearson(testPreds, test.map((s) => s.residual));
  console.log(`\nHeld-out TEST correlation (predicted residual vs real residual): r=${heldOutR.r?.toFixed(4)}  n=${heldOutR.n}`);

  console.log("\n--- Real Over/Under hit rate on HELD-OUT test seasons ---");
  for (const margin of [1, 2, 3, 4]) {
    let overCalls = 0, overHits = 0, underCalls = 0, underHits = 0, pushes = 0, noCall = 0;
    for (const s of test) {
      if (s.totalEpaSignal == null) continue;
      const predictedResidual = fit.intercept + fit.slope * s.totalEpaSignal;
      const actualResult = s.actualTotal > s.totalLine ? "over" : s.actualTotal < s.totalLine ? "under" : "push";
      if (actualResult === "push") pushes++;
      if (predictedResidual >= margin) {
        overCalls++;
        if (actualResult === "over") overHits++;
      } else if (predictedResidual <= -margin) {
        underCalls++;
        if (actualResult === "under") underHits++;
      } else {
        noCall++;
      }
    }
    const overRate = overCalls ? ((overHits / overCalls) * 100).toFixed(1) : "n/a";
    const underRate = underCalls ? ((underHits / underCalls) * 100).toFixed(1) : "n/a";
    console.log(`  margin=${margin}: Over calls ${overCalls}, ${overRate}% hit | Under calls ${underCalls}, ${underRate}% hit | No call ${noCall} | pushes ${pushes}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ---- Follow-up: multi-variable regression instead of a naive equal-weighted sum ----
// The single pre-summed signal above forces homeOff/awayOff/homeDefAllowed/awayDefAllowed to equal
// weight, which is an assumption, not a finding -- the MLB Total Runs rebuild's real improvement
// specifically came from regressing offense and pitching as SEPARATE weighted terms rather than one
// composite. Re-tests the same real data with each of the 4 components as its own regression
// variable (real 4-variable OLS via the normal equation), to check whether unequal weighting finds
// something the naive sum missed, before concluding this is a dead end the way the sum alone is.
function multiOls(rows, yKey) {
  // rows: [{homeOff, awayOff, homeDefAllowed, awayDefAllowed, y}], solves y = b0 + b1*x1 + ... + b4*x4
  const X = [], y = [];
  for (const r of rows) {
    if ([r.homeOff, r.awayOff, r.homeDefAllowed, r.awayDefAllowed, r[yKey]].some((v) => v == null || !Number.isFinite(v))) continue;
    X.push([1, r.homeOff, r.awayOff, r.homeDefAllowed, r.awayDefAllowed]);
    y.push(r[yKey]);
  }
  const n = X.length, p = X[0].length;
  // Normal equations: (X'X) beta = X'y
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < p; a++) {
      Xty[a] += X[i][a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gaussian elimination solve
  const A = XtX.map((row, i) => [...row, Xty[i]]);
  for (let i = 0; i < p; i++) {
    let maxRow = i;
    for (let k = i + 1; k < p; k++) if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
    [A[i], A[maxRow]] = [A[maxRow], A[i]];
    for (let k = i + 1; k < p; k++) {
      const f = A[k][i] / A[i][i];
      for (let j = i; j <= p; j++) A[k][j] -= f * A[i][j];
    }
  }
  const beta = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = A[i][p];
    for (let j = i + 1; j < p; j++) s -= A[i][j] * beta[j];
    beta[i] = s / A[i][i];
  }
  return { beta, n };
}

async function followUp() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;
  const [gamesText, epaByKey] = await Promise.all([loadCached(GAMES_URL, GAMES_CACHE), loadEpaByGameTeam(minSeason, maxSeason)]);
  const gameRows = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.total_line !== "";
  });
  const gamesSorted = gameRows.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const cumulative = {};
  const pointInTimeByGameId = {};
  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`, awayKey = `${season}:${g.away_team}`;
    const homeCum = cumulative[homeKey], awayCum = cumulative[awayKey];
    const enough = (c) => c && c.games >= MIN_TEAM_GAMES_FOR_TENDENCY;
    pointInTimeByGameId[g.game_id] = {
      homeOff: enough(homeCum) ? homeCum.offSum / homeCum.games : null,
      awayOff: enough(awayCum) ? awayCum.offSum / awayCum.games : null,
      homeDefAllowed: enough(homeCum) ? homeCum.defAllowedSum / homeCum.games : null,
      awayDefAllowed: enough(awayCum) ? awayCum.defAllowedSum / awayCum.games : null,
    };
    const homeRow = epaByKey[`${g.game_id}:${g.home_team}`];
    const awayRow = epaByKey[`${g.game_id}:${g.away_team}`];
    if (homeRow && awayRow) {
      cumulative[homeKey] = cumulative[homeKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[homeKey].offSum += homeRow.off; cumulative[homeKey].defAllowedSum += awayRow.off; cumulative[homeKey].games += 1;
      cumulative[awayKey] = cumulative[awayKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[awayKey].offSum += awayRow.off; cumulative[awayKey].defAllowedSum += homeRow.off; cumulative[awayKey].games += 1;
    }
  }
  const samples = gameRows.map((g) => {
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const totalLine = Number(g.total_line);
    const p = pointInTimeByGameId[g.game_id] || {};
    return { season: Number(g.season), ...p, residual: actualTotal - totalLine };
  });
  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);

  const { beta, n } = multiOls(train, "residual");
  console.log(`\n--- Multi-variable OLS (separately weighted, train n=${n}) ---`);
  console.log(`  predictedResidual = ${beta[0].toFixed(3)} + ${beta[1].toFixed(4)}*homeOff + ${beta[2].toFixed(4)}*awayOff + ${beta[3].toFixed(4)}*homeDefAllowed + ${beta[4].toFixed(4)}*awayDefAllowed`);

  const testRows = test.filter((r) => [r.homeOff, r.awayOff, r.homeDefAllowed, r.awayDefAllowed].every((v) => v != null));
  const preds = testRows.map((r) => beta[0] + beta[1] * r.homeOff + beta[2] * r.awayOff + beta[3] * r.homeDefAllowed + beta[4] * r.awayDefAllowed);
  const heldOut = pearson(preds, testRows.map((r) => r.residual));
  console.log(`  Held-out TEST correlation (separately-weighted): r=${heldOut.r?.toFixed(4)}  n=${heldOut.n}`);
}
followUp().catch((err) => { console.error(err); process.exit(1); });
