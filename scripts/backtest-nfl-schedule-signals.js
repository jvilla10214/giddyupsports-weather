// Second round of NFL signal-hunting, continuing from backtest-nfl-expanded-signals.js (which
// screened rest/short-week/divisional/referee/QB-change/travel -- only QB change showed real
// in-sample signal, and it didn't survive an honest out-of-sample test either, see
// backtest-nfl-qbchange-composite.js).
//
// This round tests two schedule-spot effects from nflverse's games.csv `weekday`/`gametime` fields
// (not used anywhere else in this app yet), both real, well-known handicapping folklore worth
// actually checking rather than assuming:
//   primetime      -- Thursday/Monday night games, or a Sunday game kicking at/after 20:00 local.
//   earlyWestCoast -- a West Coast team (SEA/SF/LAC/LA/LV, Pacific timezone) on the road at a
//                     non-West-Coast stadium for an early (<=13:xx local) kickoff -- the "10am
//                     body clock" effect, distinct from plain short rest (already tested and found
//                     to be noise) since this is about circadian mistiming, not recovery time.
//
// Usage: node scripts/backtest-nfl-schedule-signals.js [minSeason] [maxSeason] (default 2020-2025)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, ".res-cache", "nfl-games.csv");
const WEST_COAST_TEAMS = new Set(["SEA", "SF", "LAC", "LA", "LAR", "LV"]);

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

async function main() {
  const minSeason = Number(process.argv[2]) || 2020;
  const maxSeason = Number(process.argv[3]) || 2025;
  const csvText = fs.readFileSync(CACHE_FILE, "utf8");
  const rows = parseCsv(csvText);
  const games = rows.filter((r) => {
    const season = Number(r.season);
    return r.game_type === "REG" && season >= minSeason && season <= maxSeason && r.home_score !== "" && r.away_score !== "" && r.gametime !== "";
  });
  console.log(`Loaded ${games.length} completed REG games with a known kickoff time in ${minSeason}-${maxSeason}.\n`);

  const samples = games.map((g) => {
    const actualTotal = Number(g.home_score) + Number(g.away_score);
    const hour = Number(g.gametime.split(":")[0]);
    const primetime = g.weekday === "Thursday" || g.weekday === "Monday" || (g.weekday === "Sunday" && hour >= 20) ? 1 : 0;
    const awayWestCoast = WEST_COAST_TEAMS.has(g.away_team);
    const homeWestCoast = WEST_COAST_TEAMS.has(g.home_team);
    const earlyWestCoast = g.weekday === "Sunday" && awayWestCoast && !homeWestCoast && hour <= 13 ? 1 : 0;
    return { gameId: g.game_id, actualTotal, totalLine: g.total_line !== "" ? Number(g.total_line) : null, primetime, earlyWestCoast, hour, weekday: g.weekday };
  });

  console.log("--- Schedule-spot signals vs actual total points ---");
  for (const [label, key] of [["primetime (Thu/Mon/late Sun)", "primetime"], ["earlyWestCoast (10am body clock)", "earlyWestCoast"]]) {
    const { r, n } = pearson(samples.map((s) => s[key]), samples.map((s) => s.actualTotal));
    console.log(`  ${label.padEnd(36)} r=${r != null ? r.toFixed(4) : "n/a"}  n=${n}`);
  }

  console.log("\n--- Group means ---");
  for (const key of ["primetime", "earlyWestCoast"]) {
    const yes = mean(samples.filter((s) => s[key] === 1).map((s) => s.actualTotal));
    const no = mean(samples.filter((s) => s[key] === 0).map((s) => s.actualTotal));
    const nYes = samples.filter((s) => s[key] === 1).length;
    console.log(`  ${key}=1 mean actualTotal: ${yes?.toFixed(2)} (n=${nYes})  vs  ${key}=0: ${no?.toFixed(2)}`);
  }

  // Also check the market's own total_line by primetime/earlyWestCoast -- if oddsmakers already
  // set the total lower for these spots, that's direct evidence the effect (if any) is priced in
  // already, same conclusion QB-change reached.
  console.log("\n--- Market's own total_line by spot (checks whether this is already priced in) ---");
  for (const key of ["primetime", "earlyWestCoast"]) {
    const yes = mean(samples.filter((s) => s[key] === 1).map((s) => s.totalLine));
    const no = mean(samples.filter((s) => s[key] === 0).map((s) => s.totalLine));
    console.log(`  ${key}=1 mean totalLine: ${yes?.toFixed(2)}  vs  ${key}=0: ${no?.toFixed(2)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
