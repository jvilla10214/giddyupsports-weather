// Tests team PACE (total offensive plays per game: pass attempts + rush carries) as its own signal,
// distinct from the EPA/efficiency signals already tested (backtest-nfl-epa-spread-signal.js). A
// team can be efficient per play but slow (ball-control) or fast but inefficient -- pace itself
// changes how many scoring opportunities exist in a game regardless of how good either offense is
// per play. Derived from nflverse's stats_team_week (attempts + carries), same free/keyless source
// already cached for the EPA work -- no new data collection needed.
//
// Point-in-time cumulative average plays/game per team (strictly prior weeks only, same
// no-look-ahead discipline as every other signal here). Tested against both totals (combined pace)
// and the spread residual (pace differential), same honest train/test methodology throughout.
//
// Usage: node scripts/backtest-nfl-pace-signal.js [minSeason] [splitSeason] [maxSeason]

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

async function loadPlaysByGameTeam(minSeason, maxSeason) {
  const byKey = {}; // `${game_id}:${team}` -> plays
  for (let season = minSeason; season <= maxSeason; season++) {
    const cacheFile = path.join(CACHE_DIR, `stats_team_week_${season}.csv`);
    const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
    const text = await loadCached(url, cacheFile);
    for (const r of parseCsv(text)) {
      if (r.season_type !== "REG") continue;
      const plays = Number(r.attempts) + Number(r.carries);
      if (!Number.isFinite(plays)) continue;
      byKey[`${r.game_id}:${r.team}`] = { season: Number(r.season), week: Number(r.week), plays };
    }
  }
  return byKey;
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const [gamesText, playsByKey] = await Promise.all([loadCached(GAMES_URL, GAMES_CACHE), loadPlaysByGameTeam(minSeason, maxSeason)]);
  const gameRows = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.spread_line !== "";
  });
  console.log(`Loaded ${gameRows.length} completed REG games with a spread line in ${minSeason}-${maxSeason}.`);

  const gamesSorted = gameRows.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const cumulative = {}; // `${season}:${team}` -> { playsSum, games }
  const paceByGameId = {};
  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`, awayKey = `${season}:${g.away_team}`;
    const homeCum = cumulative[homeKey], awayCum = cumulative[awayKey];
    let homePace = null, awayPace = null;
    if (homeCum && homeCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) homePace = homeCum.playsSum / homeCum.games;
    if (awayCum && awayCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) awayPace = awayCum.playsSum / awayCum.games;
    paceByGameId[g.game_id] = { homePace, awayPace };

    const homeRow = playsByKey[`${g.game_id}:${g.home_team}`];
    const awayRow = playsByKey[`${g.game_id}:${g.away_team}`];
    if (homeRow) { cumulative[homeKey] = cumulative[homeKey] || { playsSum: 0, games: 0 }; cumulative[homeKey].playsSum += homeRow.plays; cumulative[homeKey].games += 1; }
    if (awayRow) { cumulative[awayKey] = cumulative[awayKey] || { playsSum: 0, games: 0 }; cumulative[awayKey].playsSum += awayRow.plays; cumulative[awayKey].games += 1; }
  }

  const samples = gameRows.map((g) => {
    const pace = paceByGameId[g.game_id] || {};
    const combinedPace = pace.homePace != null && pace.awayPace != null ? pace.homePace + pace.awayPace : null;
    const paceDiff = pace.homePace != null && pace.awayPace != null ? pace.homePace - pace.awayPace : null;
    const margin = Number(g.home_score) - Number(g.away_score);
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const spreadLine = Number(g.spread_line);
    const totalLine = g.total_line !== "" ? Number(g.total_line) : null;
    return { season: Number(g.season), combinedPace, paceDiff, actualTotal, totalLine, margin, spreadLine, residual: margin - spreadLine, totalResidual: totalLine != null ? actualTotal - totalLine : null };
  });

  console.log("\n--- TOTALS: combined pace vs actual total points (and vs. the real total-line residual) ---");
  const totalsSamples = samples.filter((s) => s.combinedPace != null);
  console.log(`  n=${totalsSamples.length}`);
  console.log(`  combinedPace vs actualTotal: r=${pearson(totalsSamples.map((s) => s.combinedPace), totalsSamples.map((s) => s.actualTotal)).r?.toFixed(4)}`);
  const withLine = totalsSamples.filter((s) => s.totalResidual != null);
  console.log(`  combinedPace vs REAL total-line residual (n=${withLine.length}): r=${pearson(withLine.map((s) => s.combinedPace), withLine.map((s) => s.totalResidual)).r?.toFixed(4)}`);

  console.log("\n--- SPREAD: pace differential vs actual margin (and vs. the real spread residual) ---");
  const spreadSamples = samples.filter((s) => s.paceDiff != null);
  console.log(`  n=${spreadSamples.length}`);
  console.log(`  paceDiff vs margin: r=${pearson(spreadSamples.map((s) => s.paceDiff), spreadSamples.map((s) => s.margin)).r?.toFixed(4)}`);
  console.log(`  paceDiff vs REAL spread residual: r=${pearson(spreadSamples.map((s) => s.paceDiff), spreadSamples.map((s) => s.residual)).r?.toFixed(4)}`);

  // Honest train/test check for the totals angle specifically (the more plausible of the two).
  const train = withLine.filter((s) => s.season < splitSeason);
  const test = withLine.filter((s) => s.season >= splitSeason);
  const fit = olsFit(train.map((s) => s.combinedPace), train.map((s) => s.totalResidual));
  const testPred = test.map((s) => fit.intercept + fit.slope * s.combinedPace);
  console.log(`\nTrain (${train.length} games) fit: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * combinedPace`);
  console.log(`Held-out TEST (${test.length} games) correlation with real total-line residual: r=${pearson(testPred, test.map((s) => s.totalResidual)).r?.toFixed(4)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
