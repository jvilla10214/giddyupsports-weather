// Validates computeTotalRunsProjection (the 2026-09-25 MLB Total Runs rebuild) against REAL actual
// combined runs for a real sample of the 2025 season -- NOT a market-line backtest (see CLAUDE.md's
// "Where we left off": no free historical MLB closing-line archive exists; confirmed live 2026-09-29
// against sportsbookreviewsonline.com, now dead, and cross-checked against an independent public
// project's own documented investigation reaching the same conclusion). This instead checks the one
// thing that's answerable for free: does the projection track real final scores at all?
//
// Every input is real and POINT-IN-TIME (no look-ahead): team offense/staff ERA and league
// averages come from MLB Stats API's byDateRange stats with endDate set to the day BEFORE each
// game; starter ERA comes from that pitcher's own real game log, summed over starts strictly
// before this one; weather is MLB's own real recorded per-game reading (condition/temp/wind), not
// simulated; park factors are Baseball Savant's real 2025-season leaderboards (not today's).
//
// HONEST SCOPE LIMITATION: computeRunEnvironmentScore is fed only carry/parkFactor/parkHr here
// (umpireLean has no free historical per-game archive; pitcherHr9Delta/teamHrRateDelta/hardHitDelta
// are excluded from computeTotalRunsProjection's conditions sum BY DESIGN already, so omitting them
// doesn't change conditionsRuns' numerator -- but it does shrink weightTotal's denominator vs a live
// game where those 3 signals are also present, which very slightly amplifies conditionsRuns here
// relative to production for the same raw carry/parkFactor/parkHr values). Conditions are a small
// modifier next to offense+pitching in this model, so the effect on projectedTotal is minor, but
// it's a real, stated difference from live behavior, not swept under the rug.
//
// Usage: node scripts/backtest-mlb-total-runs-projection.js [sampleEveryNth] [season]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRunEnvironmentScore, computeTotalRunsProjection } from "../workers/rules-engine.js";
import { scoreMlbGame } from "../workers/rules-engine.js";
import { MLB_STADIUMS, MLB_TEAM_ID_TO_KEY } from "../data/stadiums.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const UA = { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" };

function cachePath(key) {
  return path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".json");
}
async function cachedJson(key, fetcher) {
  const p = cachePath(key);
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  const data = await fetcher();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data));
  return data;
}
async function fetchJson(url, headers = UA) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}
function dayBefore(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
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
function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}

// MLB's own real per-game wind text vocabulary, catalogued live from a 206-game sample across the
// full 2025 season (not guessed): "Calm"/"None", "In From {CF,LF,RF}", "Out To {CF,LF,RF}",
// "L To R", "R To L", "Varies". Converts to { windSpeedMph, windFromDeg } for scoreMlbGame, which
// wants windFromDeg in meteorological convention (the direction wind blows FROM).
function parseWind(windStr, cfBearingDeg) {
  const m = windStr.match(/^(\d+)\s*mph,?\s*(.*)$/i);
  const speed = m ? Number(m[1]) : 0;
  const dir = (m ? m[2] : windStr).trim();
  const rf = (cfBearingDeg + 45) % 360;
  const lf = (cfBearingDeg - 45 + 360) % 360;
  const norm = (d) => ((d % 360) + 360) % 360;
  switch (dir) {
    case "Out To CF": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg + 180) };
    case "In From CF": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg) };
    case "Out To LF": return { windSpeedMph: speed, windFromDeg: norm(lf + 180) };
    case "In From LF": return { windSpeedMph: speed, windFromDeg: norm(lf) };
    case "Out To RF": return { windSpeedMph: speed, windFromDeg: norm(rf + 180) };
    case "In From RF": return { windSpeedMph: speed, windFromDeg: norm(rf) };
    // Crosswind: blowing from the batter's right (cf+90) toward the left, or vice versa. Derived
    // (not guessed) from scoreMlbGame's own rfBearing=cf+45/lfBearing=cf-45 convention -- see this
    // script's own commit message / DECISIONS.md entry for the full derivation and a sanity check
    // against the carry formula's sign.
    case "R To L": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg + 90) };
    case "L To R": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg - 90) };
    // "Varies": MLB itself is reporting no stable direction -- honest choice is no directional
    // carry effect at all, not a guessed bearing. windCarryAt already zeroes out below 3mph.
    case "Varies": return { windSpeedMph: 0, windFromDeg: 0 };
    default: return { windSpeedMph: 0, windFromDeg: 0 }; // "Calm"/"None"/unrecognized
  }
}

async function fetchSeasonGamePks(season) {
  return cachedJson(`mlb-${season}-gamepks-v2`, async () => {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R&startDate=${season}-01-01&endDate=${season}-12-31`;
    const d = await fetchJson(url);
    const games = [];
    for (const day of d.dates || []) {
      for (const g of day.games || []) {
        if (g.status?.abstractGameState === "Final") games.push({ gamePk: g.gamePk, date: day.date });
      }
    }
    return games;
  });
}

async function fetchGameLiveFeed(gamePk) {
  return cachedJson(`mlb-livefeed-${gamePk}`, () => fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`));
}

// Real point-in-time team hitting+pitching stats, one call per (season, endDate) pair -- cached so
// every game sampled on the same date reuses it instead of refetching per-game.
async function fetchTeamStatsAsOf(season, endDate) {
  return cachedJson(`mlb-teamstats-${season}-${endDate}`, async () => {
    const startDate = `${season}-01-01`;
    const [hitting, pitching] = await Promise.all([
      fetchJson(`https://statsapi.mlb.com/api/v1/teams/stats?stats=byDateRange&group=hitting&season=${season}&sportIds=1&startDate=${startDate}&endDate=${endDate}`),
      fetchJson(`https://statsapi.mlb.com/api/v1/teams/stats?stats=byDateRange&group=pitching&season=${season}&sportIds=1&startDate=${startDate}&endDate=${endDate}`),
    ]);
    const offenseByTeamId = {};
    let leagueRuns = 0, leagueGames = 0;
    for (const s of hitting.stats?.[0]?.splits || []) {
      const runs = s.stat?.runs || 0, games = s.stat?.gamesPlayed || 0;
      if (s.team?.id && games) offenseByTeamId[s.team.id] = { runsPerGame: runs / games, games };
      leagueRuns += runs; leagueGames += games;
    }
    const staffByTeamId = {};
    let leagueEr = 0, leagueIp = 0;
    for (const s of pitching.stats?.[0]?.splits || []) {
      const ip = parseFloat(s.stat?.inningsPitched || "0"); // approx (ignores .1/.2 thirds) -- fine for a season-scale league aggregate
      const er = s.stat?.earnedRuns || 0;
      if (s.team?.id && ip) staffByTeamId[s.team.id] = { staffEra: (er / ip) * 9 };
      leagueEr += er; leagueIp += ip;
    }
    return {
      leagueRunsPerGame: leagueGames ? leagueRuns / leagueGames : null,
      leagueEra: leagueIp ? (leagueEr / leagueIp) * 9 : null,
      offenseByTeamId,
      staffByTeamId,
    };
  });
}

// Real point-in-time starter ERA: sum this pitcher's own real game log strictly before `beforeDate`.
async function fetchStarterEraAsOf(pitcherId, season, beforeDate) {
  const log = await cachedJson(`mlb-pitcherlog-${pitcherId}-${season}`, () =>
    fetchJson(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`)
  );
  let er = 0, outs = 0;
  for (const s of log.stats?.[0]?.splits || []) {
    if (s.date >= beforeDate) continue; // strictly before -- no look-ahead
    const ip = parseFloat(s.stat?.inningsPitched || "0");
    outs += Math.round(ip * 3); // approx thirds from decimal IP; fine for a per-pitcher cumulative sum
    er += s.stat?.earnedRuns || 0;
  }
  if (outs === 0) return null;
  const ip = outs / 3;
  return { era: (er / ip) * 9, inningsPitched: ip };
}

async function fetchParkFactorsForSeason(season) {
  return cachedJson(`mlb-parkfactors-${season}`, async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=distance&year=${season}&batSide=&stat=index_wOBA&condition=All&rolling=`;
    const res = await fetch(url, { headers: UA });
    const html = await res.text();
    const match = html.match(/var data = (\[.*?\]);/s);
    const rows = match ? JSON.parse(match[1]) : [];
    const byVenueKey = {};
    for (const r of rows) {
      const key = MLB_TEAM_ID_TO_KEY[Number(r.main_team_id)];
      if (key) byVenueKey[key] = Number(r.extra_distance);
    }
    return byVenueKey;
  });
}
async function fetchParkHrIndexForSeason(season) {
  return cachedJson(`mlb-parkhrindex-${season}`, async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=year&year=${season}&batSide=&stat=index_wOBA&condition=All&rolling=`;
    const res = await fetch(url, { headers: UA });
    const html = await res.text();
    const match = html.match(/var data = (\[.*?\]);/s);
    const rows = match ? JSON.parse(match[1]) : [];
    const byVenueKey = {};
    for (const r of rows) {
      const key = MLB_TEAM_ID_TO_KEY[Number(r.main_team_id)];
      if (key) byVenueKey[key] = Number(r.index_hr) - 100;
    }
    return byVenueKey;
  });
}

async function main() {
  const sampleEveryNth = Number(process.argv[2]) || 8;
  const season = Number(process.argv[3]) || 2025;

  const allGames = await fetchSeasonGamePks(season);
  const sample = allGames.filter((_, i) => i % sampleEveryNth === 0);
  console.log(`Season ${season}: ${allGames.length} real completed games, sampling every ${sampleEveryNth}th -> ${sample.length} games.`);

  const [parkFactors, parkHrIndex] = await Promise.all([fetchParkFactorsForSeason(season), fetchParkHrIndexForSeason(season)]);

  const results = [];
  let skippedNoTeamData = 0, skippedNoVenueKey = 0, errors = 0;
  const CONC = 6;
  for (let i = 0; i < sample.length; i += CONC) {
    const batch = sample.slice(i, i + CONC);
    await Promise.all(
      batch.map(async ({ gamePk, date }) => {
        try {
          const feed = await fetchGameLiveFeed(gamePk);
          const gd = feed.gameData;
          const box = feed.liveData?.boxscore;
          const homeTeamId = gd?.teams?.home?.id;
          const awayTeamId = gd?.teams?.away?.id;
          const venueKey = MLB_TEAM_ID_TO_KEY[homeTeamId];
          if (!venueKey || !MLB_STADIUMS[venueKey]) { skippedNoVenueKey++; return; }
          const venue = MLB_STADIUMS[venueKey];

          const homeScore = feed.liveData?.linescore?.teams?.home?.runs;
          const awayScore = feed.liveData?.linescore?.teams?.away?.runs;
          if (homeScore == null || awayScore == null) return;
          const actualTotal = homeScore + awayScore;

          const weather = gd?.weather;
          const condition = weather?.condition || "";
          const roofClosed = condition === "Roof Closed" || condition === "Dome";
          const tempF = weather?.temp ? Number(weather.temp) : null;
          const wind = weather?.wind ? parseWind(weather.wind, venue.cfBearingDeg) : { windSpeedMph: 0, windFromDeg: 0 };
          const score = tempF != null
            ? scoreMlbGame({ tempF, humidityPct: 50, windSpeedMph: wind.windSpeedMph, windFromDeg: wind.windFromDeg, precipProbPct: 0 }, venue, { known: true, roofOpen: !roofClosed })
            : null;

          const cutoff = dayBefore(date);
          const teamStats = await fetchTeamStatsAsOf(season, cutoff);
          const homeOff = teamStats.offenseByTeamId[homeTeamId];
          const awayOff = teamStats.offenseByTeamId[awayTeamId];
          const homeStaff = teamStats.staffByTeamId[homeTeamId];
          const awayStaff = teamStats.staffByTeamId[awayTeamId];
          if (!homeOff || !awayOff || !homeStaff || !awayStaff || !teamStats.leagueRunsPerGame || !teamStats.leagueEra) {
            skippedNoTeamData++;
            return;
          }

          const homeStarterId = box?.teams?.home?.pitchers?.[0];
          const awayStarterId = box?.teams?.away?.pitchers?.[0];
          const [homeStarter, awayStarter] = await Promise.all([
            homeStarterId ? fetchStarterEraAsOf(homeStarterId, season, date) : null,
            awayStarterId ? fetchStarterEraAsOf(awayStarterId, season, date) : null,
          ]);

          const runEnvironmentScore = score
            ? computeRunEnvironmentScore({
                carryFt: score.carryFt,
                parkFactorPct: parkFactors[venueKey] ?? null,
                parkHrIndexDelta: parkHrIndex[venueKey] ?? null,
                umpireLeanRunsPerGame: null, // no free historical per-game source -- see script header
              })
            : null;

          const team = (off, staff, starter) => ({ runsPerGame: off.runsPerGame, games: off.games, staffEra: staff.staffEra, starter });
          const projection = computeTotalRunsProjection({
            leagueRunsPerGame: teamStats.leagueRunsPerGame,
            leagueEra: teamStats.leagueEra,
            home: team(homeOff, homeStaff, homeStarter),
            away: team(awayOff, awayStaff, awayStarter),
            runEnvironmentScore,
          });
          if (!projection) { skippedNoTeamData++; return; }

          results.push({ gamePk, date, venueKey, projectedTotal: projection.total, actualTotal, residual: actualTotal - projection.total });
        } catch (err) {
          errors++;
        }
      })
    );
    if ((i / CONC) % 10 === 0) console.log(`  ...${Math.min(i + CONC, sample.length)}/${sample.length} processed (${results.length} usable so far)`);
  }

  console.log(`\nUsable games: ${results.length}. Skipped (missing team/starter data, mostly early-season): ${skippedNoTeamData}. Skipped (no venue mapping): ${skippedNoVenueKey}. Errors: ${errors}.`);

  const proj = results.map((r) => r.projectedTotal);
  const act = results.map((r) => r.actualTotal);
  const res = results.map((r) => r.residual);
  console.log(`\nProjected total: mean ${mean(proj).toFixed(2)}, stddev ${stddev(proj).toFixed(2)}`);
  console.log(`Actual total:    mean ${mean(act).toFixed(2)}, stddev ${stddev(act).toFixed(2)}`);
  console.log(`Residual (actual - projected): mean ${mean(res).toFixed(2)} (bias), stddev ${stddev(res).toFixed(2)}`);
  const { r, n } = pearson(proj, act);
  console.log(`\nCorrelation (projected vs actual total runs): r=${r?.toFixed(4)} (n=${n})`);
  console.log(`For reference, this project's own real historical resScore-only regression (see TOTAL_RUNS_REGRESSION in rules-engine.js) had R2~0.027 (r~0.16) against actual runs across a full 2,430-game season.`);

  fs.writeFileSync(path.join(CACHE_DIR, "mlb-total-runs-projection-backtest-results.json"), JSON.stringify(results, null, 1));
  console.log(`\nFull per-game results written to scripts/.res-cache/mlb-total-runs-projection-backtest-results.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
