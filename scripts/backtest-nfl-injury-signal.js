// First real test of an injury-severity signal for NFL, beyond QB Watch's descriptive-only starter
// check. Uses nflverse's official injury reports (github.com/nflverse/nflverse-data, free/keyless,
// back to 2009) -- real Out/Doubtful/Questionable statuses from actual team injury reports, not a
// depth-chart guess. Tests the simplest possible version first (raw "Out" count, no position
// weighting) against BOTH targets this product cares about: totals (does more missing players mean
// fewer combined points) and spread residual (does one team missing more players than the other
// predict what the closing line got wrong) -- deliberately not over-engineering a position-weighted
// scheme before checking whether the raw signal shows anything at all worth refining.
//
// No look-ahead risk here unlike team-scoring-tendency signals: an injury report is inherently
// scoped to its own week (this week's report describes this week's game), so no point-in-time
// cumulative-average machinery is needed -- just a direct per-team-per-week join.
//
// Usage: node scripts/backtest-nfl-injury-signal.js [minSeason] [splitSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    sxx = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  const slope = sxy / sxx,
    intercept = my - slope * mx;
  return { n, slope, intercept };
}

async function loadInjuryCounts(minSeason, maxSeason) {
  // `${season}:${week}:${team}` -> { out, outOrDoubtful }
  const byKey = {};
  for (let season = minSeason; season <= maxSeason; season++) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/injuries/injuries_${season}.csv`;
    const cacheFile = path.join(CACHE_DIR, `nfl-injuries-${season}.csv`);
    const text = await loadCached(url, cacheFile);
    const rows = parseCsv(text);
    for (const r of rows) {
      if (r.game_type !== "REG") continue;
      const key = `${r.season}:${r.week}:${r.team}`;
      byKey[key] = byKey[key] || { out: 0, outOrDoubtful: 0 };
      if (r.report_status === "Out") {
        byKey[key].out += 1;
        byKey[key].outOrDoubtful += 1;
      } else if (r.report_status === "Doubtful") {
        byKey[key].outOrDoubtful += 1;
      }
    }
  }
  return byKey;
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const [gamesText, injuryByKey] = await Promise.all([loadCached(GAMES_URL, GAMES_CACHE), loadInjuryCounts(minSeason, maxSeason)]);
  const games = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.spread_line !== "";
  });
  console.log(`Loaded ${games.length} completed REG games with a spread line in ${minSeason}-${maxSeason}.`);
  console.log(`Loaded injury-count rows for ${Object.keys(injuryByKey).length} team-weeks.`);

  const samples = games.map((g) => {
    const homeInj = injuryByKey[`${g.season}:${g.week}:${g.home_team}`];
    const awayInj = injuryByKey[`${g.season}:${g.week}:${g.away_team}`];
    const margin = Number(g.home_score) - Number(g.away_score);
    const spreadLine = Number(g.spread_line);
    return {
      season: Number(g.season),
      actualTotal: Number(g.home_score) + Number(g.away_score),
      margin,
      spreadLine,
      residual: margin - spreadLine,
      combinedOut: homeInj && awayInj ? homeInj.out + awayInj.out : null,
      combinedOutOrDoubtful: homeInj && awayInj ? homeInj.outOrDoubtful + awayInj.outOrDoubtful : null,
      outDiff: homeInj && awayInj ? awayInj.out - homeInj.out : null, // positive = away missing more players than home -> should favor home
      outOrDoubtfulDiff: homeInj && awayInj ? awayInj.outOrDoubtful - homeInj.outOrDoubtful : null,
    };
  }).filter((s) => s.combinedOut != null);
  console.log(`${samples.length} games with injury data for both teams.\n`);

  console.log("--- Raw signal distributions ---");
  for (const key of ["combinedOut", "combinedOutOrDoubtful", "outDiff", "outOrDoubtfulDiff"]) {
    const vals = samples.map((s) => s[key]).filter((v) => v != null);
    console.log(`  ${key}: mean=${mean(vals).toFixed(2)} min=${Math.min(...vals)} max=${Math.max(...vals)}`);
  }

  console.log("\n--- TOTALS: combined injury count vs actual total points ---");
  for (const key of ["combinedOut", "combinedOutOrDoubtful"]) {
    const { r, n } = pearson(samples.map((s) => s[key]), samples.map((s) => s.actualTotal));
    console.log(`  ${key}: r=${r?.toFixed(4)}  n=${n}`);
  }

  console.log("\n--- SPREAD: injury count differential vs the RESIDUAL (margin - spreadLine) ---");
  for (const key of ["outDiff", "outOrDoubtfulDiff"]) {
    const { r, n } = pearson(samples.map((s) => s[key]), samples.map((s) => s.residual));
    console.log(`  ${key}: r=${r?.toFixed(4)}  n=${n}`);
  }

  // Honest held-out test for the best-looking of the two spread variants (chosen by TRAIN r only).
  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  const trainR_out = pearson(train.map((s) => s.outDiff), train.map((s) => s.residual)).r || 0;
  const trainR_outDoubt = pearson(train.map((s) => s.outOrDoubtfulDiff), train.map((s) => s.residual)).r || 0;
  const bestKey = Math.abs(trainR_out) >= Math.abs(trainR_outDoubt) ? "outDiff" : "outOrDoubtfulDiff";
  console.log(`\nBest spread variant on TRAIN: ${bestKey} (r=${bestKey === "outDiff" ? trainR_out.toFixed(4) : trainR_outDoubt.toFixed(4)})`);
  const fit = olsFit(train.map((s) => s[bestKey]), train.map((s) => s.residual));
  console.log(`Fit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * ${bestKey}  (n=${fit.n})`);
  const testR = pearson(test.map((s) => s[bestKey]), test.map((s) => s.residual));
  console.log(`Held-out TEST correlation: r=${testR.r?.toFixed(4)}  n=${testR.n}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
