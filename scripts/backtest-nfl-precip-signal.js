// Tests real historical precipitation as its own signal -- distinct from wind/temp (already
// shipped) and never tested before, since nflverse's games.csv carries no precip field at all. Real
// hourly precipitation pulled from Open-Meteo's free historical archive API (same source this
// product already uses live), one call per NFL stadium covering the full 2020-2026 range (Open-Meteo
// allows a multi-year range in a single request, confirmed live -- 32 calls total, not one per game).
//
// Outdoor/open-roof games only (same gate as wind/temp -- precip is irrelevant under a closed roof).
// gametime in nflverse's games.csv is US Eastern local time regardless of the actual stadium's own
// timezone (confirmed against a real Thursday Night game: "20:20" for an 8:20pm ET kickoff) --
// converted to UTC here accounting for EDT/EST (DST ends first Sunday of November, the one cutover
// that actually falls inside an NFL season).
//
// Usage: node scripts/backtest-nfl-precip-signal.js [minSeason] [splitSeason] [maxSeason]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NFL_STADIUMS } from "../data/stadiums.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const GAMES_CACHE = path.join(CACHE_DIR, "nfl-games.csv");
const GAMES_URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

// nflverse team codes that differ from this app's own NFL_STADIUMS keys.
const NFLVERSE_TO_STADIUM_KEY = { LA: "LAR", WAS: "WSH" };

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
async function loadCachedText(url, cacheFile) {
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
async function loadCachedJson(url, cacheFile) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${url}: ${res.status}`);
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

// DST in the US ends the first Sunday of November at 2am local -- the one cutover that falls inside
// an NFL regular season (starts EDT in September, ends EST in January). Everything from opening
// week through that date is UTC-4; everything after is UTC-5.
function easternOffsetHours(dateObj) {
  const year = dateObj.getUTCFullYear();
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSundayNov = 1 + ((7 - nov1.getUTCDay()) % 7);
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNov, 6)); // 2am ET = 6/7am UTC depending on EDT/EST, close enough for a same-day cutover
  return dateObj < dstEnd ? -4 : -5;
}
function gameKickoffUtcHour(gameday, gametime) {
  const [y, m, d] = gameday.split("-").map(Number);
  const [hh] = gametime.split(":").map(Number);
  const roughUtc = new Date(Date.UTC(y, m - 1, d, hh));
  const offset = easternOffsetHours(roughUtc);
  const realUtc = new Date(Date.UTC(y, m - 1, d, hh - offset));
  return realUtc.toISOString().slice(0, 13) + ":00"; // matches Open-Meteo's "YYYY-MM-DDTHH:00" hourly time format
}

async function loadPrecipByStadium(minSeason, maxSeason) {
  const byTeam = {};
  const teams = Object.keys(NFL_STADIUMS);
  for (const team of teams) {
    const venue = NFL_STADIUMS[team];
    const cacheFile = path.join(CACHE_DIR, `precip-${team}.json`);
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${venue.lat}&longitude=${venue.lon}&start_date=${minSeason}-08-01&end_date=${maxSeason + 1}-02-28&hourly=precipitation&timezone=UTC`;
    const data = await loadCachedJson(url, cacheFile);
    const byHour = {};
    data.hourly.time.forEach((t, i) => { byHour[t] = data.hourly.precipitation[i]; });
    byTeam[team] = byHour;
  }
  return byTeam;
}

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const splitSeason = Number(process.argv[3]) || 2024;
  const maxSeason = Number(process.argv[4]) || 2025;

  const [gamesText, precipByStadium] = await Promise.all([
    loadCachedText(GAMES_URL, GAMES_CACHE),
    loadPrecipByStadium(minSeason, maxSeason),
  ]);
  const games = parseCsv(gamesText).filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.total_line !== "" && (r.roof === "outdoors" || r.roof === "open");
  });
  console.log(`Loaded ${games.length} completed outdoor REG games with a total line in ${minSeason}-${maxSeason}.`);

  let matched = 0, missing = 0;
  const samples = games.map((g) => {
    const stadiumKey = NFLVERSE_TO_STADIUM_KEY[g.home_team] || g.home_team;
    const byHour = precipByStadium[stadiumKey];
    let precipMm = null;
    if (byHour && g.gameday && g.gametime) {
      const hourKey = gameKickoffUtcHour(g.gameday, g.gametime);
      precipMm = byHour[hourKey] ?? null;
      if (precipMm != null) matched++; else missing++;
    } else {
      missing++;
    }
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const totalLine = Number(g.total_line);
    return { season: Number(g.season), precipMm, hasPrecip: precipMm != null ? (precipMm > 0.1 ? 1 : 0) : null, actualTotal, totalLine, residual: actualTotal - totalLine };
  });
  console.log(`Matched real hourly precip for ${matched} games, missing for ${missing} (stadium/time lookup gaps).`);

  const valid = samples.filter((s) => s.precipMm != null);
  console.log("\n--- Real precipitation distribution ---");
  const wetGames = valid.filter((s) => s.hasPrecip === 1);
  console.log(`  Games with measurable precip (>0.1mm at kickoff hour): ${wetGames.length} / ${valid.length}`);

  console.log("\n--- TOTALS: precip (continuous mm) vs actual total points and vs REAL total-line residual ---");
  console.log(`  precipMm vs actualTotal: r=${pearson(valid.map((s) => s.precipMm), valid.map((s) => s.actualTotal)).r?.toFixed(4)}`);
  console.log(`  precipMm vs REAL residual: r=${pearson(valid.map((s) => s.precipMm), valid.map((s) => s.residual)).r?.toFixed(4)}`);

  console.log("\n--- TOTALS: hasPrecip (binary) group means ---");
  const dryMean = mean(valid.filter((s) => s.hasPrecip === 0).map((s) => s.actualTotal));
  const wetMean = mean(valid.filter((s) => s.hasPrecip === 1).map((s) => s.actualTotal));
  console.log(`  Dry games mean actualTotal: ${dryMean?.toFixed(2)}  (n=${valid.filter((s) => s.hasPrecip === 0).length})`);
  console.log(`  Wet games mean actualTotal: ${wetMean?.toFixed(2)}  (n=${wetGames.length})`);
  console.log(`  hasPrecip vs REAL residual: r=${pearson(valid.map((s) => s.hasPrecip), valid.map((s) => s.residual)).r?.toFixed(4)}`);

  const train = valid.filter((s) => s.season < splitSeason);
  const test = valid.filter((s) => s.season >= splitSeason);
  const fit = olsFit(train.map((s) => s.precipMm), train.map((s) => s.residual));
  const testPred = test.map((s) => fit.intercept + fit.slope * s.precipMm);
  console.log(`\nTrain (${train.length}) fit: predictedResidual = ${fit.intercept.toFixed(3)} + ${fit.slope.toFixed(4)} * precipMm`);
  console.log(`Held-out TEST (${test.length}) correlation with real residual: r=${pearson(testPred, test.map((s) => s.residual)).r?.toFixed(4)}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
