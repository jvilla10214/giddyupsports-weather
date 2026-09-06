// Backtest for the NFL "Game Environment Score" + "Total Points Call" -- same purpose and
// methodology as scripts/backtest-run-environment-score.js, but built around nflverse's `games.csv`
// (github.com/nflverse/nfldata), a free, actively-maintained public dataset -- rather than the
// per-game live-API fetching MLB's backtest needed, since this one file already joins real final
// scores, real historical Vegas total lines, and real weather/roof per game.
//
// Genuinely richer than the MLB backtest could be: MLB had no historical odds archive at all
// (RotoGrinders only exposes today's live line), so that backtest could only correlate a score
// against actual runs. This one has the REAL historical total_line too, so it can directly check
// the actual call logic's hit rate against real over/under outcomes -- not just a correlation.
//
// Usage: node scripts/backtest-nfl-environment-score.js [minSeason] [maxSeason]
//   defaults to 2020-2025 (REG season only; playoffs excluded -- small, unusual sample).
//
// KNOWN LIMITATION, same category as MLB's: team scoring tendency uses each team's FULL SEASON
// scored/allowed average, not stats-as-of-that-week -- mild look-ahead bias, documented and
// accepted the same way MLB's pitcher/team HR9 signals were.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const CACHE_FILE = path.join(CACHE_DIR, "nfl-games.csv");
const GAMES_CSV_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

async function loadGamesCsv() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (fs.existsSync(CACHE_FILE)) {
    const stat = fs.statSync(CACHE_FILE);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs < 24 * 60 * 60 * 1000) return fs.readFileSync(CACHE_FILE, "utf8");
  }
  const res = await fetch(GAMES_CSV_URL);
  if (!res.ok) throw new Error(`nflverse games.csv fetch failed: ${res.status}`);
  const text = await res.text();
  fs.writeFileSync(CACHE_FILE, text);
  return text;
}

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
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
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
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function describe(label, values) {
  const clean = values.filter((v) => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) {
    console.log(`  ${label.padEnd(24)} n=0 (no data)`);
    return;
  }
  console.log(
    `  ${label.padEnd(24)} n=${String(clean.length).padEnd(6)} min=${clean[0].toFixed(3).padEnd(9)} p25=${percentile(clean, 0.25).toFixed(3).padEnd(9)} median=${percentile(clean, 0.5).toFixed(3).padEnd(9)} p75=${percentile(clean, 0.75).toFixed(3).padEnd(9)} p90=${percentile(clean, 0.9).toFixed(3).padEnd(9)} max=${clean[clean.length - 1].toFixed(3)}`
  );
}

function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 2) return null;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
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
  return sxy / Math.sqrt(sxx * syy);
}

function olsFit(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  const mx = mean(pairs.map((p) => p[0]));
  const my = mean(pairs.map((p) => p[1]));
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
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  let ssRes = 0;
  for (const [x, y] of pairs) {
    const resid = y - (intercept + slope * x);
    ssRes += resid * resid;
  }
  const residStd = Math.sqrt(ssRes / (n - 2));
  return { n, slope, intercept, r, r2: r * r, residStd };
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const maxSeason = Number(process.argv[3]) || 2025;

  const csvText = await loadGamesCsv();
  const rows = parseCsv(csvText);

  const games = rows.filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.away_score !== "";
  });
  console.log(`Loaded ${rows.length} total nflverse rows, ${games.length} completed REG games in ${minSeason}-${maxSeason}.`);

  // Team season scoring stats (full-season aggregate, same "documented mild look-ahead" limitation
  // as the MLB backtest's pitcher/team HR9 signals) -- points scored/allowed per game.
  const teamSeasonStats = {}; // `${season}:${team}` -> { scoredSum, allowedSum, games }
  const leagueTotalsBySeason = {}; // season -> { sum, games }
  for (const g of games) {
    const season = g.season;
    const homeScore = Number(g.home_score);
    const awayScore = Number(g.away_score);
    const total = homeScore + awayScore;

    const homeKey = `${season}:${g.home_team}`;
    const awayKey = `${season}:${g.away_team}`;
    teamSeasonStats[homeKey] = teamSeasonStats[homeKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamSeasonStats[homeKey].scoredSum += homeScore;
    teamSeasonStats[homeKey].allowedSum += awayScore;
    teamSeasonStats[homeKey].games += 1;
    teamSeasonStats[awayKey] = teamSeasonStats[awayKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamSeasonStats[awayKey].scoredSum += awayScore;
    teamSeasonStats[awayKey].allowedSum += homeScore;
    teamSeasonStats[awayKey].games += 1;

    leagueTotalsBySeason[season] = leagueTotalsBySeason[season] || { sum: 0, games: 0 };
    leagueTotalsBySeason[season].sum += total;
    leagueTotalsBySeason[season].games += 1;
  }

  const samples = [];
  for (const g of games) {
    const season = g.season;
    const homeScore = Number(g.home_score);
    const awayScore = Number(g.away_score);
    const actualTotal = homeScore + awayScore;
    const totalLine = g.total_line !== "" ? Number(g.total_line) : null;
    const roofClosed = g.roof === "closed" || g.roof === "dome";
    const windMph = g.wind !== "" ? Number(g.wind) : roofClosed ? 0 : null;
    const tempF = g.temp !== "" ? Number(g.temp) : null; // null (not 0) when missing -- a dome's "no temp effect" is handled by roofClosed gating windMph/temp contributions entirely, not by faking a temp value.

    // Leave-one-out: subtract THIS game's own scored/allowed contribution before averaging, so a
    // team's computed tendency doesn't partly reflect the very outcome being predicted (a real,
    // checkable form of look-ahead bias a full-season average would otherwise have -- with ~17
    // games/season, one game is ~6% of the average, enough to matter for a correlation check).
    const homeStats = teamSeasonStats[`${season}:${g.home_team}`];
    const awayStats = teamSeasonStats[`${season}:${g.away_team}`];
    const leagueAvgTotal = leagueTotalsBySeason[season].sum / leagueTotalsBySeason[season].games;
    let teamScoringDelta = null;
    if (homeStats && awayStats && homeStats.games > 1 && awayStats.games > 1) {
      const homeInvolvement = (homeStats.scoredSum - homeScore + homeStats.allowedSum - awayScore) / (homeStats.games - 1);
      const awayInvolvement = (awayStats.scoredSum - awayScore + awayStats.allowedSum - homeScore) / (awayStats.games - 1);
      teamScoringDelta = (homeInvolvement + awayInvolvement) / 2 - leagueAvgTotal;
    }

    samples.push({
      gameId: g.game_id,
      season,
      week: g.week,
      home: g.home_team,
      away: g.away_team,
      roof: g.roof,
      roofClosed,
      windMph,
      tempF,
      teamScoringDelta,
      actualTotal,
      totalLine,
    });
  }

  fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "data", "nfl-environment-score-samples.json"), JSON.stringify({ minSeason, maxSeason, generatedAt: new Date().toISOString(), samples }, null, 0));
  console.log(`Wrote ${samples.length} samples to scripts/data/nfl-environment-score-samples.json\n`);

  // ---- Raw signal distributions ----
  console.log("--- Raw signal distributions (outdoor/open-roof games only for wind/temp) ---");
  const outdoor = samples.filter((s) => !s.roofClosed);
  describe("windMph (outdoor only)", outdoor.map((s) => s.windMph));
  describe("tempF (outdoor only)", outdoor.map((s) => s.tempF));
  describe("teamScoringDelta (all)", samples.map((s) => s.teamScoringDelta));
  describe("actualTotal (all)", samples.map((s) => s.actualTotal));
  describe("totalLine (all)", samples.map((s) => s.totalLine));
  console.log(`  roofClosed games: ${samples.filter((s) => s.roofClosed).length} / ${samples.length}`);

  // ---- Correlations with actual total points ----
  console.log("\n--- Per-signal correlation with actual total points ---");
  console.log("  windMph (outdoor only):     r =", pearson(outdoor.map((s) => s.windMph), outdoor.map((s) => s.actualTotal))?.toFixed(4));
  console.log("  tempF (outdoor only):       r =", pearson(outdoor.map((s) => s.tempF), outdoor.map((s) => s.actualTotal))?.toFixed(4));
  console.log("  teamScoringDelta (all):     r =", pearson(samples.map((s) => s.teamScoringDelta), samples.map((s) => s.actualTotal))?.toFixed(4));
  const closedMean = mean(samples.filter((s) => s.roofClosed).map((s) => s.actualTotal));
  const openMean = mean(samples.filter((s) => !s.roofClosed).map((s) => s.actualTotal));
  console.log(`  roofClosed mean actualTotal: ${closedMean?.toFixed(2)} vs open-air mean: ${openMean?.toFixed(2)}`);

  // ---- Fit a composite Game Environment Score the same way MLB's Run Environment Score was: ----
  // each raw signal normalized by its own real p75-of-|value|, weighted average.
  function absP75(values) {
    const abs = values.filter((v) => v != null && Number.isFinite(v)).map((v) => Math.abs(v)).sort((a, b) => a - b);
    return percentile(abs, 0.75);
  }
  const windScale = absP75(outdoor.map((s) => s.windMph));
  const tempScale = absP75(outdoor.map((s) => s.tempF - 60)); // centered on a neutral ~60F baseline before taking magnitude
  const teamScale = absP75(samples.map((s) => s.teamScoringDelta));
  console.log("\n--- Proposed normalization scales (real p75-of-|value|) ---");
  console.log({ windScale, tempScale: tempScale, teamScale });

  const WEIGHTS = { wind: 1.0, temp: 0.6, team: 1.0 };
  function composite(s) {
    const contributions = [];
    if (!s.roofClosed && s.windMph != null) contributions.push({ w: WEIGHTS.wind, v: -s.windMph / windScale }); // more wind -> lower scoring -> negative contribution
    if (!s.roofClosed && s.tempF != null) contributions.push({ w: WEIGHTS.temp, v: (s.tempF - 60) / tempScale }); // colder than 60F -> lower scoring
    if (s.teamScoringDelta != null) contributions.push({ w: WEIGHTS.team, v: s.teamScoringDelta / teamScale });
    if (!contributions.length) return null;
    const wSum = contributions.reduce((a, c) => a + c.w, 0);
    const wv = contributions.reduce((a, c) => a + c.w * c.v, 0);
    return wv / wSum;
  }
  const scored = samples.map((s) => ({ ...s, gameEnvScore: composite(s) }));
  const fit = olsFit(scored.map((s) => s.gameEnvScore), scored.map((s) => s.actualTotal));
  console.log("\n--- Composite Game Environment Score vs actual total points ---");
  console.log(`  OLS fit: impliedTotal = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(3)} * gameEnvScore`);
  console.log(`  n=${fit.n}  r=${fit.r.toFixed(4)}  r2=${fit.r2.toFixed(4)}  residStd=${fit.residStd.toFixed(3)}`);

  // ---- REAL backtest of the actual call logic against real historical odds outcomes ----
  // This is the thing MLB's backtest could NOT do (no historical odds archive existed there).
  console.log("\n--- Backtesting the actual Likely Over/Under call against real historical odds ---");
  for (const margin of [1, 2, 3, 4]) {
    let overCalls = 0,
      overHits = 0,
      underCalls = 0,
      underHits = 0,
      pushes = 0,
      tossUps = 0;
    for (const s of scored) {
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
    console.log(
      `  margin=${margin}: Likely Over ${overCalls} calls, ${overRate}% hit | Likely Under ${underCalls} calls, ${underRate}% hit | Toss-up ${tossUps} | pushes ${pushes}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
