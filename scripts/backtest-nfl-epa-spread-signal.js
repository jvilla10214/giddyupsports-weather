// Second real ATS (against-the-spread) test for NFL, following up on backtest-nfl-spread-signal.js
// (powerDiff, run 2026-09-20: r=0.0182 vs the market's residual, essentially no real calls on the
// held-out test seasons). That signal used a crude proxy for team strength -- raw season net
// scoring margin. This one uses a real per-play efficiency metric instead: nflverse's own EPA/play
// (passing_epa + rushing_epa per team per game, from stats_team_week -- see
// github.com/nflverse/nflverse-data, free/keyless, no auth), which is what real handicapping models
// (nfelo, DVOA, FPI) actually use for margin prediction, not raw scoring margin.
//
// Candidate signal: netEpaDiff = (home net EPA/game) - (away net EPA/game), where a team's own net
// EPA/game = its own point-in-time cumulative offensive EPA/game minus the offensive EPA/game it
// has allowed opponents (its own defensive EPA allowed), both computed the same point-in-time,
// no-look-ahead way as every other signal in this repo (MIN_TEAM_GAMES_FOR_TENDENCY gate, strictly
// prior weeks only).
//
// Same honest test as backtest-nfl-spread-signal.js: raw correlation vs actual margin is expected to
// be inflated (margin includes what the market already priced in) -- the real test is correlation
// vs the RESIDUAL (margin - spreadLine), with a train(2020-23)/test(2024-25) split.
//
// Usage: node scripts/backtest-nfl-epa-spread-signal.js [minSeason] [splitSeason] [maxSeason]

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

async function loadEpaByGameTeam(minSeason, maxSeason) {
  // team-week EPA rows, keyed by `${game_id}:${team}` -> { off, opponent }
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
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.spread_line !== "";
  });
  console.log(`Loaded ${gameRows.length} completed REG games with a spread line in ${minSeason}-${maxSeason}.`);
  console.log(`Loaded EPA rows for ${Object.keys(epaByKey).length} team-games.`);

  // Point-in-time cumulative net EPA/game per team, same no-look-ahead discipline as every other
  // signal here -- built incrementally in season/week order, gated at MIN_TEAM_GAMES_FOR_TENDENCY.
  const gamesSorted = gameRows.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const cumulative = {}; // `${season}:${team}` -> { offSum, defAllowedSum, games }
  const netEpaByGameId = {}; // gameId -> { home, away } point-in-time net EPA/game, or null

  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`;
    const awayKey = `${season}:${g.away_team}`;
    const homeCum = cumulative[homeKey];
    const awayCum = cumulative[awayKey];
    let homeNet = null,
      awayNet = null;
    if (homeCum && homeCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) homeNet = homeCum.offSum / homeCum.games - homeCum.defAllowedSum / homeCum.games;
    if (awayCum && awayCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) awayNet = awayCum.offSum / awayCum.games - awayCum.defAllowedSum / awayCum.games;
    netEpaByGameId[g.game_id] = { homeNet, awayNet };

    // Update cumulative AFTER recording this game's point-in-time value.
    const homeRow = epaByKey[`${g.game_id}:${g.home_team}`];
    const awayRow = epaByKey[`${g.game_id}:${g.away_team}`];
    if (homeRow && awayRow) {
      cumulative[homeKey] = cumulative[homeKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[homeKey].offSum += homeRow.off;
      cumulative[homeKey].defAllowedSum += awayRow.off; // what the home defense allowed = away offense's EPA this game
      cumulative[homeKey].games += 1;
      cumulative[awayKey] = cumulative[awayKey] || { offSum: 0, defAllowedSum: 0, games: 0 };
      cumulative[awayKey].offSum += awayRow.off;
      cumulative[awayKey].defAllowedSum += homeRow.off;
      cumulative[awayKey].games += 1;
    }
  }

  const samples = gameRows.map((g) => {
    const margin = Number(g.home_score) - Number(g.away_score);
    const spreadLine = Number(g.spread_line);
    const net = netEpaByGameId[g.game_id] || {};
    const netEpaDiff = net.homeNet != null && net.awayNet != null ? net.homeNet - net.awayNet : null;
    return { season: Number(g.season), margin, spreadLine, residual: margin - spreadLine, netEpaDiff };
  });

  console.log("\n--- netEpaDiff (home net EPA/game minus away net EPA/game) vs the RESIDUAL (margin - spreadLine) ---");
  console.log("The real test: does real per-play efficiency predict what the closing line got wrong.");
  const vsResidual = pearson(samples.map((s) => s.netEpaDiff), samples.map((s) => s.residual));
  console.log(`  r=${vsResidual.r != null ? vsResidual.r.toFixed(4) : "n/a"}  n=${vsResidual.n}`);
  const vsMargin = pearson(samples.map((s) => s.netEpaDiff), samples.map((s) => s.margin));
  console.log(`  (for reference, netEpaDiff vs raw margin directly: r=${vsMargin.r?.toFixed(4)}, n=${vsMargin.n})`);

  const train = samples.filter((s) => s.season < splitSeason);
  const test = samples.filter((s) => s.season >= splitSeason);
  console.log(`\nTrain: ${train.length} games (${minSeason}-${splitSeason - 1})  |  Test: ${test.length} games (${splitSeason}-${maxSeason})`);

  const fit = olsFit(train.map((s) => s.netEpaDiff), train.map((s) => s.residual));
  console.log(`\nFit on TRAIN: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * netEpaDiff  (n=${fit.n})`);

  console.log("\n--- Real ATS hit rate on HELD-OUT test seasons ---");
  for (const margin of [1, 2, 3, 4]) {
    let homeCoverCalls = 0,
      homeCoverHits = 0,
      awayCoverCalls = 0,
      awayCoverHits = 0,
      pushes = 0,
      noCall = 0;
    for (const s of test) {
      if (s.netEpaDiff == null) continue;
      const predictedResidual = fit.intercept + fit.slope * s.netEpaDiff;
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
