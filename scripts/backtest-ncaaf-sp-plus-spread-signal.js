// First real ATS (against-the-spread) test for NCAAF -- the genuinely open question flagged
// alongside the NFL spread work (NFL's own spread signals, raw scoring-margin and real EPA/play,
// both came back essentially null, r=0.018 and r=0.010 -- see backtest-nfl-epa-spread-signal.js).
// SP+'s combinedScoringTendency was only ever tested against NCAAF TOTALS, and even that was tested
// against actual outcomes directly (backtest-ncaaf-sp-plus-signal.js: r=0.175/0.183), the same
// "trivial vs real" trap this project already learned to avoid once (see the NCAAF signal
// correction note in memory) -- that number was never actually validated against the real market
// residual. Nobody has built or tested a margin-shaped (spread) version of SP+ before, against
// either outcomes or the real line. This does both honestly.
//
// Signal: netSp(team) = offense.rating - defense.rating, using SP+'s own real convention
// (offense.rating: higher = more points scored, good; defense.rating: LOWER = fewer points
// allowed, good -- so subtracting correctly rewards both a good offense and a good defense in one
// number, same points-per-game-equivalent scale per Bill Connelly's published methodology).
//   marginDiff = home's netSp - away's netSp
// Same prior-season-final-rating methodology as the totals test (CFBD's own /ratings/sp has no
// true point-in-time weekly snapshot -- confirmed live, a `week` param returns identical data for a
// past season -- so season S-1's final rating predicts season S's games, a conservative,
// look-ahead-free stand-in for what a live continuously-updating current-season rating would do).
//
// REAL market line: CFBD's own /lines endpoint (already used for the totals work), which exposes a
// per-provider real spread. Sign convention VERIFIED directly against real data before use (not
// assumed): Pittsburgh (home) vs California, spread -3.5 ("Pittsburgh -3.5"), actual scores 17-15
// (home won by only 2, i.e. did NOT cover a -3.5 line) -- confirms CFBD's spread is negative when
// home is favored, the OPPOSITE convention from nflverse's own NFL data (whose spread_line is
// positive when home is favored, hence NFL's own backtest script uses residual = margin -
// spreadLine directly). For CFBD: residual = margin + spread (verified against the example above:
// margin=+2, spread=-3.5, residual=-1.5, correctly signaling home underperformed what the market
// expected). Getting this backwards would silently invert every single finding below, so this was
// checked against real data, not copied from the NFL script.
//
// Same honest train(2020-23)/test(2024-25) split as every other backtest in this project.
//
// Usage: node scripts/backtest-ncaaf-sp-plus-spread-signal.js [CFBD_API_KEY] [minSeason] [splitSeason] [maxSeason]

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

async function main() {
  const apiKey = process.argv[2] || process.env.CFBD_API_KEY;
  if (!apiKey) throw new Error("Pass the CFBD API key as argv[2] or set CFBD_API_KEY env var.");
  const minSeason = Number(process.argv[3]) || 2020;
  const splitSeason = Number(process.argv[4]) || 2024;
  const maxSeason = Number(process.argv[5]) || 2025;

  const ratingsBySeason = {};
  for (let s = minSeason - 1; s <= maxSeason - 1; s++) {
    const data = await fetchJsonCached(`https://api.collegefootballdata.com/ratings/sp?year=${s}`, path.join(CACHE_DIR, `cfbd-sp-${s}.json`), apiKey);
    const byTeam = {};
    for (const t of data) if (t.offense?.rating != null && t.defense?.rating != null) byTeam[t.team] = { net: t.offense.rating - t.defense.rating };
    ratingsBySeason[s] = byTeam;
    console.log(`SP+ ${s}: ${Object.keys(byTeam).length} teams with both ratings.`);
  }

  const samples = [];
  for (let s = minSeason; s <= maxSeason; s++) {
    const [games, lines] = await Promise.all([
      fetchJsonCached(`https://api.collegefootballdata.com/games?year=${s}&seasonType=regular`, path.join(CACHE_DIR, `cfbd-games-${s}.json`), apiKey),
      fetchJsonCached(`https://api.collegefootballdata.com/lines?year=${s}&seasonType=regular`, path.join(CACHE_DIR, `cfbd-lines-${s}.json`), apiKey),
    ]);
    const linesById = {};
    for (const l of lines) linesById[l.id] = bestSpread(l.lines);
    const prior = ratingsBySeason[s - 1];
    for (const g of games) {
      if (!g.completed || g.homeClassification !== "fbs" || g.awayClassification !== "fbs") continue;
      if (g.homePoints == null || g.awayPoints == null) continue;
      const spread = linesById[g.id];
      if (spread == null) continue;
      const home = prior[g.homeTeam];
      const away = prior[g.awayTeam];
      const marginDiff = home && away ? home.net - away.net : null;
      const margin = g.homePoints - g.awayPoints;
      samples.push({ season: s, margin, spread, residual: margin + spread, marginDiff });
    }
  }
  console.log(`\nLoaded ${samples.length} completed FBS-v-FBS games with a real spread line, ${samples.filter((s) => s.marginDiff != null).length} with both teams' prior-year SP+.`);

  console.log("\n=== marginDiff (home netSp - away netSp) vs REAL ATS residual (margin + spread) ===");
  const vsResidual = pearson(samples.map((s) => s.marginDiff), samples.map((s) => s.residual));
  console.log(`  All seasons: r=${vsResidual.r?.toFixed(4)}  n=${vsResidual.n}`);
  const vsMargin = pearson(samples.map((s) => s.marginDiff), samples.map((s) => s.margin));
  console.log(`  (for reference, marginDiff vs raw margin directly: r=${vsMargin.r?.toFixed(4)}, n=${vsMargin.n} -- expected to be inflated vs the real residual test above)`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);
  const fit = olsFit(train.map((s) => s.marginDiff), train.map((s) => s.residual));
  console.log(`Fit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * marginDiff  (n=${fit.n})`);

  const preds = test.map((s) => (s.marginDiff != null ? fit.intercept + fit.slope * s.marginDiff : null));
  const heldOut = pearson(preds, test.map((s) => s.residual));
  console.log(`Held-out TEST correlation: r=${heldOut.r?.toFixed(4)}  n=${heldOut.n}`);

  console.log("\n--- Real ATS hit rate on HELD-OUT test seasons ---");
  for (const m of [1, 2, 3, 4]) {
    let homeCalls = 0, homeHits = 0, awayCalls = 0, awayHits = 0, noCall = 0, pushes = 0;
    for (const s of test) {
      if (s.marginDiff == null) continue;
      const pred = fit.intercept + fit.slope * s.marginDiff;
      // actualCover: did home beat the spread? home covers if margin + spread > 0.
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
