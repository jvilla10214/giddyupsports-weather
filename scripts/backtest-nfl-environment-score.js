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
// FIXED 2026-09-12: this previously used each team's FULL SEASON scored/allowed average (only
// leave-one-out, excluding the game being predicted itself) -- the same class of look-ahead bias
// already found in MLB's pitcherHr9Delta, just not yet corrected here. Now computes a real
// point-in-time cumulative average (through STRICTLY PRIOR WEEKS of that season only, gated at
// MIN_TEAM_GAMES_FOR_TENDENCY). Real effect: standalone correlation drops from r=0.181 to r=0.145,
// full composite r2 vs actual total points from 0.0420 to 0.0305 -- real but more modest than
// pitcherHr9Delta's near-total collapse. IMPORTANT: production (fetchNflTeamScoringTendency in
// weather-worker.js) was ALREADY correct -- it only sums games with a non-blank score, and
// nflverse's games.csv only populates a score after a game is actually played, so a live request
// today naturally already sees only real season-to-date results (an NFL team plays at most one game
// per week, so "games played so far" and "weeks strictly prior" are the same thing from that team's
// own perspective). This was purely a backtest-methodology bug, same distinction already made for
// MLB's fix. See NFL_GES_SCALE/nflGameEnvironmentTier comments in rules-engine.js for the updated
// constants this produced.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_TEAM_GAMES_FOR_TENDENCY } from "../workers/rules-engine.js";

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

  // League-average total per season -- a centering constant, not itself a per-game predictive
  // signal, so it's fine to use the season's full real total here (same reasoning as the hard-hit
  // league baseline in the MLB backtest script).
  const leagueTotalsBySeason = {}; // season -> { sum, games }
  for (const g of games) {
    const total = Number(g.home_score) + Number(g.away_score);
    leagueTotalsBySeason[g.season] = leagueTotalsBySeason[g.season] || { sum: 0, games: 0 };
    leagueTotalsBySeason[g.season].sum += total;
    leagueTotalsBySeason[g.season].games += 1;
  }

  // Team scoring tendency: TRUE point-in-time, cumulative through STRICTLY PRIOR WEEKS of that
  // season only -- built incrementally in season/week order below so "prior" is real, not a
  // future-informed lookup. FIXED 2026-09-12 (see header comment): the old leave-one-out-but-
  // full-season version still let a week-3 game's tendency reflect weeks 4-18, which hadn't been
  // played yet at the time that game would actually be predicted.
  const gamesSorted = games.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));
  const teamCumulative = {}; // `${season}:${team}` -> { scoredSum, allowedSum, games } as of games processed so far
  const teamScoringDeltaByGameId = {};
  for (const g of gamesSorted) {
    const season = g.season;
    const homeKey = `${season}:${g.home_team}`;
    const awayKey = `${season}:${g.away_team}`;
    const leagueAvgTotal = leagueTotalsBySeason[season].sum / leagueTotalsBySeason[season].games;

    const homeCum = teamCumulative[homeKey];
    const awayCum = teamCumulative[awayKey];
    let teamScoringDelta = null;
    if (homeCum && awayCum && homeCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY && awayCum.games >= MIN_TEAM_GAMES_FOR_TENDENCY) {
      const homeInvolvement = (homeCum.scoredSum + homeCum.allowedSum) / homeCum.games;
      const awayInvolvement = (awayCum.scoredSum + awayCum.allowedSum) / awayCum.games;
      teamScoringDelta = (homeInvolvement + awayInvolvement) / 2 - leagueAvgTotal;
    }
    teamScoringDeltaByGameId[g.game_id] = teamScoringDelta;

    // Update cumulative AFTER computing this game's point-in-time value, so this game itself never
    // contributes to its own (or an earlier game's) "prior" figure.
    const homeScore = Number(g.home_score);
    const awayScore = Number(g.away_score);
    teamCumulative[homeKey] = teamCumulative[homeKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamCumulative[homeKey].scoredSum += homeScore;
    teamCumulative[homeKey].allowedSum += awayScore;
    teamCumulative[homeKey].games += 1;
    teamCumulative[awayKey] = teamCumulative[awayKey] || { scoredSum: 0, allowedSum: 0, games: 0 };
    teamCumulative[awayKey].scoredSum += awayScore;
    teamCumulative[awayKey].allowedSum += homeScore;
    teamCumulative[awayKey].games += 1;
  }

  const samples = [];
  for (const g of games) {
    const homeScore = Number(g.home_score);
    const awayScore = Number(g.away_score);
    const actualTotal = homeScore + awayScore;
    const totalLine = g.total_line !== "" ? Number(g.total_line) : null;
    const roofClosed = g.roof === "closed" || g.roof === "dome";
    const windMph = g.wind !== "" ? Number(g.wind) : roofClosed ? 0 : null;
    const tempF = g.temp !== "" ? Number(g.temp) : null; // null (not 0) when missing -- a dome's "no temp effect" is handled by roofClosed gating windMph/temp contributions entirely, not by faking a temp value.
    const teamScoringDelta = teamScoringDeltaByGameId[g.game_id] ?? null;

    samples.push({
      gameId: g.game_id,
      season: g.season,
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

  // Tier-threshold percentiles -- reproduces the real numbers nflGameEnvironmentTier's thresholds
  // in rules-engine.js are calibrated against, so a future re-run can check them the same way.
  const scoreSorted = scored.map((s) => s.gameEnvScore).filter((v) => v != null).sort((a, b) => a - b);
  console.log("\n--- Composite score percentiles (nflGameEnvironmentTier's real calibration source) ---");
  for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) console.log(`  p${p * 100}: ${percentile(scoreSorted, p).toFixed(3)}`);
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
