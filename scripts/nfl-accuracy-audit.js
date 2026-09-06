// Audit of scoreNflGame's wind/temp/roof-derived claims (rules-engine.js) against real 2020-2025
// data (nflverse's games.csv + stats_team_week, cached in scripts/.res-cache/ by
// scripts/backtest-nfl-environment-score.js -- run that first if the cache is empty).
//
// Findings from the 2026-09-06 run are recorded directly in rules-engine.js's own comments above
// scoreNflGame, and in project memory (see the NFL Game Environment Score memory file). Re-run this
// whenever nflverse's data updates meaningfully (e.g. after a full new season) to check whether
// those findings still hold.
//
// Usage: node scripts/nfl-accuracy-audit.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, ".res-cache");

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

const games = parseCsv(fs.readFileSync(`${CACHE}/nfl-games.csv`, "utf8"));
const gamesById = Object.fromEntries(games.map((g) => [g.game_id, g]));

// Retractable-roof NFL venues, matching data/stadiums.js's NFL_STADIUMS.
const RETRACTABLE_TEAMS = ["ARI", "ATL", "DAL", "HOU", "IND"];

console.log("=== 1. Retractable-roof real open/closed rate (2020-2025 REG) ===");
for (const team of RETRACTABLE_TEAMS) {
  const homeGames = games.filter((g) => g.game_type === "REG" && g.home_team === team && Number(g.season) >= 2020 && Number(g.season) <= 2025 && g.roof !== "");
  const closed = homeGames.filter((g) => g.roof === "closed").length;
  const open = homeGames.filter((g) => g.roof === "open").length;
  console.log(`  ${team}: n=${homeGames.length}  closed=${closed} (${((closed / homeGames.length) * 100).toFixed(0)}%)  open=${open} (${((open / homeGames.length) * 100).toFixed(0)}%)`);
}

// ---- Join team-week stats to game-level wind/temp/roof ----
const teamWeekRows = [];
for (const season of [2020, 2021, 2022, 2023, 2024, 2025]) {
  const rows = parseCsv(fs.readFileSync(`${CACHE}/stats_team_week_${season}.csv`, "utf8"));
  for (const r of rows) {
    if (r.season_type !== "REG") continue;
    const g = gamesById[r.game_id];
    if (!g) continue;
    const roofClosed = g.roof === "closed" || g.roof === "dome";
    const wind = g.wind !== "" ? Number(g.wind) : roofClosed ? 0 : null;
    const temp = g.temp !== "" ? Number(g.temp) : null;
    teamWeekRows.push({
      ...r,
      roofClosed,
      wind,
      temp,
      attempts: Number(r.attempts || 0),
      completions: Number(r.completions || 0),
      cpoe: r.passing_cpoe !== "" ? Number(r.passing_cpoe) : null,
      fgMade: Number(r.fg_made || 0),
      fgAtt: Number(r.fg_att || 0),
    });
  }
}
console.log(`\nJoined ${teamWeekRows.length} team-week rows to game-level weather.`);

const outdoor = teamWeekRows.filter((r) => !r.roofClosed && r.wind != null);

function bucketStats(rows, bucketFn, label) {
  const buckets = {};
  for (const r of rows) {
    const b = bucketFn(r);
    if (b == null) continue;
    buckets[b] = buckets[b] || { attempts: 0, completions: 0, cpoeSum: 0, cpoeN: 0, fgMade: 0, fgAtt: 0, n: 0 };
    buckets[b].attempts += r.attempts;
    buckets[b].completions += r.completions;
    if (r.cpoe != null) {
      buckets[b].cpoeSum += r.cpoe;
      buckets[b].cpoeN++;
    }
    buckets[b].fgMade += r.fgMade;
    buckets[b].fgAtt += r.fgAtt;
    buckets[b].n++;
  }
  console.log(`\n--- ${label} ---`);
  for (const key of Object.keys(buckets).sort()) {
    const b = buckets[key];
    const compPct = b.attempts ? ((b.completions / b.attempts) * 100).toFixed(1) : "n/a";
    const avgCpoe = b.cpoeN ? (b.cpoeSum / b.cpoeN).toFixed(2) : "n/a";
    const fgPct = b.fgAtt ? ((b.fgMade / b.fgAtt) * 100).toFixed(1) : "n/a";
    console.log(`  ${key.padEnd(12)} n=${String(b.n).padEnd(5)} completion%=${compPct.padEnd(6)} avgCPOE=${avgCpoe.padEnd(6)} fgAtt=${b.fgAtt}  fg%=${fgPct}`);
  }
}

bucketStats(
  outdoor,
  (r) => {
    const w = r.wind;
    if (w < 10) return "0-10mph (light)";
    if (w < 15) return "10-15mph (moderate)";
    if (w < 20) return "15-20mph (strong)";
    return "20+mph (severe)";
  },
  "Passing/kicking by WIND tier (current scoreNflGame boundaries: <10/<15/<20/20+)"
);

bucketStats(
  outdoor,
  (r) => {
    const t = r.temp;
    if (t == null) return null;
    if (t <= 32) return "1-freezing (<=32F)";
    if (t <= 50) return "2-cold (33-50F)";
    if (t <= 70) return "3-mild (51-70F)";
    return "4-warm (71F+)";
  },
  "Passing/kicking by TEMPERATURE"
);

// ---- Distance-adjusted FG check: is the flat FG% just because kickers attempt shorter kicks in wind? ----
console.log("\n=== Distance-adjusted field goal check ===");
const fgKicks = []; // { distance, made, wind }
for (const r of teamWeekRows) {
  if (r.roofClosed || r.wind == null) continue;
  const made = (r.fg_made_list || "").split(";").filter(Boolean).map(Number);
  const missed = (r.fg_missed_list || "").split(";").filter(Boolean).map(Number);
  for (const d of made) fgKicks.push({ distance: d, made: true, wind: r.wind });
  for (const d of missed) fgKicks.push({ distance: d, made: false, wind: r.wind });
}
console.log(`Total individual kicks with real distance+wind: ${fgKicks.length}`);

function fgBucket(rows, bucketFn, label) {
  const buckets = {};
  for (const r of rows) {
    const b = bucketFn(r);
    if (b == null) continue;
    buckets[b] = buckets[b] || { made: 0, att: 0, distSum: 0 };
    buckets[b].att++;
    if (r.made) buckets[b].made++;
    buckets[b].distSum += r.distance;
  }
  console.log(`\n--- ${label} ---`);
  for (const key of Object.keys(buckets).sort()) {
    const b = buckets[key];
    console.log(`  ${key.padEnd(20)} att=${String(b.att).padEnd(6)} made%=${((b.made / b.att) * 100).toFixed(1).padEnd(6)} avgAttemptedDistance=${(b.distSum / b.att).toFixed(1)}`);
  }
}

fgBucket(
  fgKicks,
  (r) => {
    if (r.wind < 10) return "0-10mph";
    if (r.wind < 15) return "10-15mph";
    if (r.wind < 20) return "15-20mph";
    return "20+mph";
  },
  "All kicks: made% AND avg attempted distance by wind (checks the 'shorter kicks in wind' selection-bias theory)"
);

fgBucket(
  fgKicks.filter((r) => r.distance >= 40),
  (r) => {
    if (r.wind < 10) return "0-10mph";
    if (r.wind < 15) return "10-15mph";
    if (r.wind < 20) return "15-20mph";
    return "20+mph";
  },
  "40+ yard kicks ONLY (like-for-like distance, isolates wind's real effect)"
);
