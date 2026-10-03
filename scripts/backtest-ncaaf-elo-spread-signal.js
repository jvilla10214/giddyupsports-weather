// Tests CFBD's own real, continuously-updating Elo rating (homePregameElo/awayPregameElo,
// already present in the cached /games response -- no new API call needed) against the real
// NCAAF spread residual. Genuinely different signal shape from SP+ (backtest-ncaaf-sp-plus-
// spread-signal.js, closed null): SP+ is a frozen prior-season-final snapshot, Elo updates after
// every single game within the current season, so it can see a hot start, a bad loss, a coaching
// change's early results -- things prior-year SP+ structurally cannot. Point-in-time by
// construction (pregameElo is CFBD's own value as of right before this exact game).
//
// Same sign convention and residual math as backtest-ncaaf-sp-plus-spread-signal.js (verified
// there against a real game: CFBD spread is negative when home is favored, so
// residual = margin + spread). Same train(2020-23)/test(2024-25) split.
//
// Usage: node scripts/backtest-ncaaf-elo-spread-signal.js [minSeason] [splitSeason] [maxSeason]
// Reads only from the existing scripts/.res-cache/ -- no API key needed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");

function readCached(file) {
  const p = path.join(CACHE_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`Missing cache file ${p} -- run the SP+ spread backtest first to populate it.`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
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

function bestSpread(lines) {
  if (!lines?.length) return null;
  const dk = lines.find((l) => l.provider === "DraftKings" && l.spread != null);
  if (dk) return dk.spread;
  const any = lines.find((l) => l.spread != null);
  return any ? any.spread : null;
}

function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const samples = [];
  for (let s = minSeason; s <= maxSeason; s++) {
    const games = readCached(`cfbd-games-${s}.json`);
    const lines = readCached(`cfbd-lines-${s}.json`);
    const linesById = {};
    for (const l of lines) linesById[l.id] = bestSpread(l.lines);
    for (const g of games) {
      if (!g.completed || g.homeClassification !== "fbs" || g.awayClassification !== "fbs") continue;
      if (g.homePoints == null || g.awayPoints == null) continue;
      const spread = linesById[g.id];
      if (spread == null) continue;
      const eloDiff = g.homePregameElo != null && g.awayPregameElo != null ? g.homePregameElo - g.awayPregameElo : null;
      const margin = g.homePoints - g.awayPoints;
      samples.push({ season: s, margin, spread, residual: margin + spread, eloDiff });
    }
  }
  console.log(`Loaded ${samples.length} completed FBS-v-FBS games with a real spread line, ${samples.filter((s) => s.eloDiff != null).length} with both teams' pregame Elo.`);

  console.log("\n=== eloDiff (home pregameElo - away pregameElo) vs REAL ATS residual (margin + spread) ===");
  const vsResidual = pearson(samples.map((s) => s.eloDiff), samples.map((s) => s.residual));
  console.log(`  All seasons: r=${vsResidual.r?.toFixed(4)}  n=${vsResidual.n}`);
  const vsMargin = pearson(samples.map((s) => s.eloDiff), samples.map((s) => s.margin));
  console.log(`  (reference: eloDiff vs raw margin directly: r=${vsMargin.r?.toFixed(4)}, n=${vsMargin.n})`);
  const vsSpread = pearson(samples.map((s) => s.eloDiff), samples.map((s) => s.spread));
  console.log(`  (reference: eloDiff vs the market's OWN spread: r=${vsSpread.r?.toFixed(4)}, n=${vsSpread.n} -- how much Elo just tracks what the market already knows)`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);
  const fit = olsFit(train.map((s) => s.eloDiff), train.map((s) => s.residual));
  console.log(`Fit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(5)} * eloDiff  (n=${fit.n})`);

  const preds = test.map((s) => (s.eloDiff != null ? fit.intercept + fit.slope * s.eloDiff : null));
  const heldOut = pearson(preds, test.map((s) => s.residual));
  console.log(`Held-out TEST correlation: r=${heldOut.r?.toFixed(4)}  n=${heldOut.n}`);

  console.log("\n--- Real ATS hit rate on HELD-OUT test seasons ---");
  for (const m of [1, 2, 3, 4]) {
    let homeCalls = 0, homeHits = 0, awayCalls = 0, awayHits = 0, noCall = 0, pushes = 0;
    for (const s of test) {
      if (s.eloDiff == null) continue;
      const pred = fit.intercept + fit.slope * s.eloDiff;
      const actualCover = s.residual > 0 ? "home" : s.residual < 0 ? "away" : "push";
      if (actualCover === "push") pushes++;
      if (pred >= m) { homeCalls++; if (actualCover === "home") homeHits++; }
      else if (pred <= -m) { awayCalls++; if (actualCover === "away") awayHits++; }
      else noCall++;
    }
    const homeRate = homeCalls ? ((homeHits / homeCalls) * 100).toFixed(1) : "n/a";
    const awayRate = awayCalls ? ((awayHits / awayCalls) * 100).toFixed(1) : "n/a";
    console.log(`  margin=${m}: Home-covers calls ${homeCalls}, ${homeRate}% hit | Away-covers calls ${awayCalls}, ${awayRate}% hit | No call ${noCall} | pushes ${pushes}`);
  }
}

main();
