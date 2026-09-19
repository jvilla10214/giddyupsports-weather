// Expanded-signal exploration for the NFL Game Environment Score / Total Points Call, following up
// on scripts/backtest-nfl-environment-score.js's "no exploitable edge" finding (wind/temp/team
// scoring tendency only: Likely Over hit rate 46-47%, Likely Under ~49-51%, both at/under the
// ~52.4% breakeven needed against standard vig -- see that script's real output).
//
// This asks: does nflverse's games.csv (github.com/nflverse/nfldata) already contain OTHER real,
// free, already-available fields that correlate with actual total points better than the existing
// three signals did? Specifically: rest days (away_rest/home_rest -- short week suppresses offense),
// divisional familiarity (div_game -- rivalry games historically score lower), referee tendency
// (referee -- real, measurable penalty-rate variance by crew), and a same-team QB change (a cheap
// proxy for "not their normal starter", via home_qb_name/away_qb_name -- QB injuries are the single
// largest point-swing in the sport per the factor list this was built from). A fifth candidate, away
// team travel distance, is computed from this app's own NFL_STADIUMS lat/lon (haversine to the home
// team's stadium) -- only valid for true home/away games, so it's null for any `location !== "Home"`
// (neutral-site/international) game rather than silently computing a wrong number.
//
// Usage: node scripts/backtest-nfl-expanded-signals.js [minSeason] [maxSeason] (defaults 2020-2025)
//
// Deliberately does NOT touch rules-engine.js or weather-worker.js -- this is exploration only. If a
// candidate here shows real signal, the next step is folding it into the actual composite (with an
// honest out-of-sample check), not shipping straight from this file's numbers.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_TEAM_GAMES_FOR_TENDENCY } from "../workers/rules-engine.js";
import { NFL_STADIUMS } from "../data/stadiums.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const CACHE_FILE = path.join(CACHE_DIR, "nfl-games.csv");
const GAMES_CSV_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

// nflverse used "LA" for the Rams across this window; every other code already matches this app's
// own NFL_STADIUMS keys (confirmed live against the full 2020-2025 team-code set).
const TEAM_ALIAS = { LA: "LAR" };
function stadiumFor(teamCode) {
  return NFL_STADIUMS[TEAM_ALIAS[teamCode] || teamCode] || null;
}

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
  return { r: sxy / Math.sqrt(sxx * syy), n };
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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
  console.log(`Loaded ${games.length} completed REG games in ${minSeason}-${maxSeason}.\n`);

  const gamesSorted = games.slice().sort((a, b) => Number(a.season) - Number(b.season) || Number(a.week) - Number(b.week));

  // Point-in-time referee tendency (mirrors the existing team-scoring-tendency methodology in
  // backtest-nfl-environment-score.js): cumulative average total for that referee's PRIOR games
  // only, across the whole window (refs don't reset per-season the way team form does), gated at
  // the same MIN_TEAM_GAMES_FOR_TENDENCY threshold used for team scoring tendency.
  const refCumulative = {}; // referee name -> { sum, games }
  const refTendencyByGameId = {};
  // Point-in-time "not their usual starter" QB flag: tracks each team's most-common QB name seen so
  // far this season; a game where the listed starter differs from that count-leader (once enough
  // starts exist to have a leader) is flagged as a starter change for that side.
  const qbCounts = {}; // `${season}:${team}` -> { [qbName]: count }
  const qbChangeByGameId = {};

  for (const g of gamesSorted) {
    const season = g.season;
    const ref = g.referee;
    if (ref) {
      const cum = refCumulative[ref];
      refTendencyByGameId[g.game_id] = cum && cum.games >= MIN_TEAM_GAMES_FOR_TENDENCY ? cum.sum / cum.games : null;
    }
    const homeKey = `${season}:${g.home_team}`;
    const awayKey = `${season}:${g.away_team}`;
    const homeCounts = qbCounts[homeKey];
    const awayCounts = qbCounts[awayKey];
    function isChange(counts, qbName) {
      if (!counts || !qbName) return null;
      const entries = Object.entries(counts);
      const totalStarts = entries.reduce((a, [, c]) => a + c, 0);
      if (totalStarts < 3) return null; // not enough starts yet to know who's "usual"
      const [leaderName] = entries.sort((a, b) => b[1] - a[1])[0];
      return leaderName !== qbName;
    }
    const homeQbChange = isChange(homeCounts, g.home_qb_name);
    const awayQbChange = isChange(awayCounts, g.away_qb_name);
    qbChangeByGameId[g.game_id] = homeQbChange == null && awayQbChange == null ? null : homeQbChange || awayQbChange;

    // Update cumulative state AFTER computing this game's point-in-time values.
    const total = Number(g.home_score) + Number(g.away_score);
    if (ref) {
      refCumulative[ref] = refCumulative[ref] || { sum: 0, games: 0 };
      refCumulative[ref].sum += total;
      refCumulative[ref].games += 1;
    }
    if (g.home_qb_name) {
      qbCounts[homeKey] = qbCounts[homeKey] || {};
      qbCounts[homeKey][g.home_qb_name] = (qbCounts[homeKey][g.home_qb_name] || 0) + 1;
    }
    if (g.away_qb_name) {
      qbCounts[awayKey] = qbCounts[awayKey] || {};
      qbCounts[awayKey][g.away_qb_name] = (qbCounts[awayKey][g.away_qb_name] || 0) + 1;
    }
  }

  const samples = games.map((g) => {
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const awayRest = g.away_rest !== "" ? Number(g.away_rest) : null;
    const homeRest = g.home_rest !== "" ? Number(g.home_rest) : null;
    const homeStadium = stadiumFor(g.home_team);
    const awayStadium = stadiumFor(g.away_team);
    const travelMiles =
      g.location === "Home" && homeStadium && awayStadium ? haversineMiles(homeStadium.lat, homeStadium.lon, awayStadium.lat, awayStadium.lon) : null;
    return {
      gameId: g.game_id,
      season: g.season,
      actualTotal,
      totalLine: g.total_line !== "" ? Number(g.total_line) : null,
      awayRest,
      homeRest,
      restDelta: awayRest != null && homeRest != null ? homeRest - awayRest : null,
      shortWeek: awayRest != null && homeRest != null ? (awayRest <= 6 ? 1 : 0) + (homeRest <= 6 ? 1 : 0) : null,
      divGame: g.div_game === "1" ? 1 : g.div_game === "0" ? 0 : null,
      refTendency: refTendencyByGameId[g.game_id] ?? null,
      qbChange: qbChangeByGameId[g.game_id] === null ? null : qbChangeByGameId[g.game_id] ? 1 : 0,
      travelMiles,
    };
  });

  console.log("--- New candidate signals vs actual total points (n = usable pairs) ---");
  const rows2 = [
    ["restDelta (home rest - away rest)", samples.map((s) => s.restDelta)],
    ["shortWeek (# teams on <=6 days rest)", samples.map((s) => s.shortWeek)],
    ["divGame (1=divisional)", samples.map((s) => s.divGame)],
    ["refTendency (point-in-time)", samples.map((s) => s.refTendency)],
    ["qbChange (1=either side not usual starter)", samples.map((s) => s.qbChange)],
    ["travelMiles (away team, home games only)", samples.map((s) => s.travelMiles)],
  ];
  for (const [label, values] of rows2) {
    const { r, n } = pearson(values, samples.map((s) => s.actualTotal)) || { r: null, n: 0 };
    console.log(`  ${label.padEnd(42)} r=${r != null ? r.toFixed(4) : "n/a"}  n=${n}`);
  }

  console.log("\n--- Reference: original three signals' real r from backtest-nfl-environment-score.js ---");
  console.log("  windMph (outdoor only):  r = -0.0885");
  console.log("  tempF (outdoor only):    r =  0.0818");
  console.log("  teamScoringDelta:        r =  0.1449");

  // Group means for the two categorical/near-categorical ones, since a single correlation number
  // can understate a real but non-linear effect (e.g. divisional games might shift the mean without
  // a clean linear relationship across the whole range).
  console.log("\n--- Group means (sanity check beyond linear correlation) ---");
  const divMean = mean(samples.filter((s) => s.divGame === 1).map((s) => s.actualTotal));
  const nonDivMean = mean(samples.filter((s) => s.divGame === 0).map((s) => s.actualTotal));
  console.log(`  divGame=1 mean actualTotal: ${divMean?.toFixed(2)}  vs  divGame=0: ${nonDivMean?.toFixed(2)}`);
  const qbChangeMean = mean(samples.filter((s) => s.qbChange === 1).map((s) => s.actualTotal));
  const qbNoChangeMean = mean(samples.filter((s) => s.qbChange === 0).map((s) => s.actualTotal));
  console.log(`  qbChange=1 mean actualTotal: ${qbChangeMean?.toFixed(2)}  vs  qbChange=0: ${qbNoChangeMean?.toFixed(2)}`);
  for (const sw of [0, 1, 2]) {
    const m = mean(samples.filter((s) => s.shortWeek === sw).map((s) => s.actualTotal));
    console.log(`  shortWeek=${sw} mean actualTotal: ${m?.toFixed(2)} (n=${samples.filter((s) => s.shortWeek === sw).length})`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
