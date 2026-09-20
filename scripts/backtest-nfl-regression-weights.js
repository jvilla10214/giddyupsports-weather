// Checks whether the Game Environment Score's weights ({wind:1.0, temp:0.6, team:1.0}) actually
// reflect each signal's real predictive strength, or were just hand-picked. Real correlations
// (already documented in rules-engine.js): wind r=-0.089, temp r=0.082, team r=0.145 -- team is
// nearly TWICE as strong as either weather term alone, yet the current weights give it barely more
// influence than wind and MORE than temp only by a 1.0-vs-0.6 margin, not proportional to how much
// more it actually explains. Runs a real multiple OLS regression (3 predictors: normalized wind,
// normalized temp, normalized team, same normalization already used in production) against actual
// total points, to find the weights that best fit the real data, and compares that composite's r/r2
// against the current ad-hoc-weighted composite's.
//
// Usage: node scripts/backtest-nfl-regression-weights.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Solves a 4x4 linear system (3 predictors + intercept) via Gaussian elimination with partial
// pivoting -- small enough to hand-roll rather than pull in a stats library.
function solveLinearSystem(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let k = col; k <= n; k++) M[row][k] -= factor * M[col][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let col = row + 1; col < n; col++) sum -= M[row][col] * x[col];
    x[row] = sum / M[row][row];
  }
  return x;
}

// Multiple OLS: y = b0 + b1*x1 + b2*x2 + b3*x3, via normal equations (X'X)b = X'y.
function multipleOls(predictors, y) {
  const pairs = predictors[0].map((_, i) => i).filter((i) => y[i] != null && Number.isFinite(y[i]) && predictors.every((p) => p[i] != null && Number.isFinite(p[i])));
  const n = pairs.length;
  const k = predictors.length + 1; // + intercept
  const X = pairs.map((i) => [1, ...predictors.map((p) => p[i])]);
  const Y = pairs.map((i) => y[i]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const XtY = new Array(k).fill(0);
  for (let row = 0; row < n; row++) {
    for (let a = 0; a < k; a++) {
      XtY[a] += X[row][a] * Y[row];
      for (let bIdx = 0; bIdx < k; bIdx++) XtX[a][bIdx] += X[row][a] * X[row][bIdx];
    }
  }
  const coeffs = solveLinearSystem(XtX, XtY);
  const predicted = pairs.map((i, idx) => coeffs[0] + predictors.reduce((sum, p, pIdx) => sum + coeffs[pIdx + 1] * p[i], 0));
  const { r } = pearson(predicted, Y);
  return { n, coeffs, r, r2: r * r };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "nfl-environment-score-samples.json"), "utf8"));
  const samples = raw.samples;
  console.log(`Loaded ${samples.length} real NFL games (${raw.minSeason}-${raw.maxSeason}).`);

  // Same real normalization already used in production (rules-engine.js NFL_GES_SCALE).
  const WIND_SCALE = 11,
    TEMP_SCALE = 25,
    TEAM_SCALE = 4.3;
  const normWind = samples.map((s) => (s.roofClosed || s.windMph == null ? null : -s.windMph / WIND_SCALE));
  const normTemp = samples.map((s) => (s.roofClosed || s.tempF == null ? null : (s.tempF - 60) / TEMP_SCALE));
  const normTeam = samples.map((s) => (s.teamScoringDelta != null ? s.teamScoringDelta / TEAM_SCALE : null));
  const actualTotal = samples.map((s) => s.actualTotal);

  console.log("\n--- Current production weights: {wind: 1.0, temp: 0.6, team: 1.0} ---");
  const CURRENT_WEIGHTS = { wind: 1.0, temp: 0.6, team: 1.0 };
  const currentComposite = samples.map((s, i) => {
    const contributions = [];
    if (normWind[i] != null) contributions.push({ w: CURRENT_WEIGHTS.wind, v: normWind[i] });
    if (normTemp[i] != null) contributions.push({ w: CURRENT_WEIGHTS.temp, v: normTemp[i] });
    if (normTeam[i] != null) contributions.push({ w: CURRENT_WEIGHTS.team, v: normTeam[i] });
    if (!contributions.length) return null;
    const wSum = contributions.reduce((a, c) => a + c.w, 0);
    return contributions.reduce((a, c) => a + c.w * c.v, 0) / wSum;
  });
  const currentFit = pearson(currentComposite, actualTotal);
  console.log(`  Current ad-hoc composite: r=${currentFit.r.toFixed(4)}  r2=${(currentFit.r * currentFit.r).toFixed(4)}  n=${currentFit.n}`);

  console.log("\n--- Real multiple OLS regression (only games with ALL THREE signals present) ---");
  const reg = multipleOls([normWind, normTemp, normTeam], actualTotal);
  console.log(`  n=${reg.n}`);
  console.log(`  intercept=${reg.coeffs[0].toFixed(3)}  wind_coeff=${reg.coeffs[1].toFixed(3)}  temp_coeff=${reg.coeffs[2].toFixed(3)}  team_coeff=${reg.coeffs[3].toFixed(3)}`);
  console.log(`  Regression composite: r=${reg.r.toFixed(4)}  r2=${reg.r2.toFixed(4)}`);
  console.log(`\n  For comparison, implied WEIGHT RATIO if we normalize wind's coefficient to 1.0:`);
  console.log(`    wind: 1.00   temp: ${(reg.coeffs[2] / reg.coeffs[1]).toFixed(2)}   team: ${(reg.coeffs[3] / reg.coeffs[1]).toFixed(2)}`);
  console.log(`  (current production ratio is wind:1.00  temp:0.60  team:1.00 for comparison)`);
}

main();
