// Real turnover differential test for NFL -- a genuinely distinct, well-regarded real
// football-analytics predictor (unlike EPA/power-margin, a different signal family entirely) never
// tried in this project. Real per-team-game turnover data from nflverse's stats_team_week (same
// free/keyless source already used for EPA, see backtest-nfl-epa-spread-signal.js):
//   giveaways = passing_interceptions + fumbles_lost_total   (this team's own offense losing the ball)
//   takeaways = def_interceptions + fumble_recovery_opp      (this team's defense taking it away)
//   turnoverMargin = takeaways - giveaways
//
// Two honest tests, same point-in-time no-look-ahead discipline (MIN_TEAM_GAMES_FOR_TENDENCY gate,
// strictly prior weeks only) and train(2020-23)/test(2024-25) split as every other signal here:
//   1. SPREAD: marginDiff = home's own turnover margin - away's own turnover margin. The standard
//      handicapping application -- a team that wins the turnover battle should outperform a market
//      that doesn't fully price it in.
//   2. TOTALS: combinedGiveawayRate = home's own giveaways/game + away's own giveaways/game. A
//      "sloppiness" proxy -- untested empirically whether high-turnover games predict more total
//      points (short fields, cheap scores) or fewer (drives ending before they reach scoring range).
//
// Usage: node scripts/backtest-nfl-turnover-signal.js [minSeason] [splitSeason] [maxSeason]

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

async function loadTurnoversByGameTeam(minSeason, maxSeason) {
  const byKey = {};
  for (let season = minSeason; season <= maxSeason; season++) {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week_${season}.csv`;
    const cacheFile = path.join(CACHE_DIR, `stats_team_week_${season}.csv`);
    const text = await loadCached(url, cacheFile);
    for (const r of parseCsv(text)) {
      if (r.season_type !== "REG") continue;
      const giveaways = Number(r.passing_interceptions || 0) + Number(r.fumbles_lost_total || 0);
      const takeaways = Number(r.def_interceptions || 0) + Number(r.fumble_recovery_opp || 0);
      if (!Number.isFinite(giveaways) || !Number.isFinite(takeaways)) continue;
      byKey[`${r.game_id}:${r.team}`] = { season: Number(r.season), week: Number(r.week), giveaways, takeaways };
    }
  }
  return byKey;
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const [gamesText, toByKey] = await Promise.all([loadCached(GAMES_URL, GAMES_CACHE), loadTurnoversByGameTeam(minSeason, maxSeason)]);
  const gameRows = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.spread_line !== "" && r.total_line !== "";
  });
  console.log(`Loaded ${gameRows.length} completed REG games with spread+total lines in ${minSeason}-${maxSeason}.`);
  console.log(`Loaded turnover rows for ${Object.keys(toByKey).length} team-games.`);

  const gamesSorted = gameRows.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const cumulative = {}; // `${season}:${team}` -> { giveawaySum, takeawaySum, games }
  const pointInTimeByGameId = {};

  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`, awayKey = `${season}:${g.away_team}`;
    const homeCum = cumulative[homeKey], awayCum = cumulative[awayKey];
    const enough = (c) => c && c.games >= MIN_TEAM_GAMES_FOR_TENDENCY;
    pointInTimeByGameId[g.game_id] = {
      homeMargin: enough(homeCum) ? (homeCum.takeawaySum - homeCum.giveawaySum) / homeCum.games : null,
      awayMargin: enough(awayCum) ? (awayCum.takeawaySum - awayCum.giveawaySum) / awayCum.games : null,
      homeGiveawayRate: enough(homeCum) ? homeCum.giveawaySum / homeCum.games : null,
      awayGiveawayRate: enough(awayCum) ? awayCum.giveawaySum / awayCum.games : null,
    };
    const homeRow = toByKey[`${g.game_id}:${g.home_team}`];
    const awayRow = toByKey[`${g.game_id}:${g.away_team}`];
    if (homeRow) { cumulative[homeKey] = cumulative[homeKey] || { giveawaySum: 0, takeawaySum: 0, games: 0 }; cumulative[homeKey].giveawaySum += homeRow.giveaways; cumulative[homeKey].takeawaySum += homeRow.takeaways; cumulative[homeKey].games += 1; }
    if (awayRow) { cumulative[awayKey] = cumulative[awayKey] || { giveawaySum: 0, takeawaySum: 0, games: 0 }; cumulative[awayKey].giveawaySum += awayRow.giveaways; cumulative[awayKey].takeawaySum += awayRow.takeaways; cumulative[awayKey].games += 1; }
  }

  const samples = gameRows.map((g) => {
    const margin = Number(g.home_score) - Number(g.away_score);
    const spreadLine = Number(g.spread_line);
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const totalLine = Number(g.total_line);
    const p = pointInTimeByGameId[g.game_id] || {};
    const marginDiff = p.homeMargin != null && p.awayMargin != null ? p.homeMargin - p.awayMargin : null;
    const combinedGiveawayRate = p.homeGiveawayRate != null && p.awayGiveawayRate != null ? p.homeGiveawayRate + p.awayGiveawayRate : null;
    return { season: Number(g.season), spreadResidual: margin - spreadLine, totalResidual: actualTotal - totalLine, marginDiff, combinedGiveawayRate };
  });

  console.log("\n=== SPREAD: turnover marginDiff (home margin - away margin) vs the real ATS residual ===");
  const spreadAll = pearson(samples.map((s) => s.marginDiff), samples.map((s) => s.spreadResidual));
  console.log(`  All seasons: r=${spreadAll.r?.toFixed(4)}  n=${spreadAll.n}`);
  const trainS = samples.filter((s) => s.season < splitSeason);
  const testS = samples.filter((s) => s.season >= splitSeason);
  const fitS = olsFit(trainS.map((s) => s.marginDiff), trainS.map((s) => s.spreadResidual));
  console.log(`  Train fit: predictedResidual = ${fitS.intercept.toFixed(3)} + ${fitS.slope.toFixed(4)} * marginDiff  (n=${fitS.n})`);
  const predsS = testS.map((s) => (s.marginDiff != null ? fitS.intercept + fitS.slope * s.marginDiff : null));
  const heldOutS = pearson(predsS, testS.map((s) => s.spreadResidual));
  console.log(`  Held-out TEST: r=${heldOutS.r?.toFixed(4)}  n=${heldOutS.n}`);

  console.log("\n=== TOTALS: combinedGiveawayRate (home + away giveaways/game) vs the real total residual ===");
  const totalAll = pearson(samples.map((s) => s.combinedGiveawayRate), samples.map((s) => s.totalResidual));
  console.log(`  All seasons: r=${totalAll.r?.toFixed(4)}  n=${totalAll.n}`);
  const trainT = samples.filter((s) => s.season < splitSeason);
  const testT = samples.filter((s) => s.season >= splitSeason);
  const fitT = olsFit(trainT.map((s) => s.combinedGiveawayRate), trainT.map((s) => s.totalResidual));
  console.log(`  Train fit: predictedResidual = ${fitT.intercept.toFixed(3)} + ${fitT.slope.toFixed(4)} * combinedGiveawayRate  (n=${fitT.n})`);
  const predsT = testT.map((s) => (s.combinedGiveawayRate != null ? fitT.intercept + fitT.slope * s.combinedGiveawayRate : null));
  const heldOutT = pearson(predsT, testT.map((s) => s.totalResidual));
  console.log(`  Held-out TEST: r=${heldOutT.r?.toFixed(4)}  n=${heldOutT.n}`);

  console.log("\n=== Real ATS hit rate using turnover marginDiff, HELD-OUT test seasons ===");
  for (const m of [1, 2, 3]) {
    let homeCalls = 0, homeHits = 0, awayCalls = 0, awayHits = 0, noCall = 0;
    for (const s of testS) {
      if (s.marginDiff == null) continue;
      const pred = fitS.intercept + fitS.slope * s.marginDiff;
      const actualCover = s.spreadResidual > 0 ? "home" : s.spreadResidual < 0 ? "away" : "push";
      if (pred >= m) { homeCalls++; if (actualCover === "home") homeHits++; }
      else if (pred <= -m) { awayCalls++; if (actualCover === "away") awayHits++; }
      else noCall++;
    }
    console.log(`  margin=${m}: Home calls ${homeCalls}, ${homeCalls ? ((homeHits/homeCalls)*100).toFixed(1) : "n/a"}% hit | Away calls ${awayCalls}, ${awayCalls ? ((awayHits/awayCalls)*100).toFixed(1) : "n/a"}% hit | No call ${noCall}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
