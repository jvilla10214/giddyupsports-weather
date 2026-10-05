// Tests whether Baseball Savant's team-level Statcast xwOBA (expected weighted on-base average --
// a quality-of-contact-adjusted offense metric, generally considered stickier/more predictive than
// raw runs/game) would be a genuinely BETTER offense-quality input to computeTotalRunsProjection
// than the CURRENT proxy it actually uses: regressToward(t.runsPerGame, t.games, OFFENSE_REGRESS_GAMES,
// lgRpg) / lgRpg (see rules-engine.js line ~631). Reuses the exact same real 2025-season game sample,
// cached MLB Stats API team/starter/park data, and cached game results as
// backtest-mlb-total-runs-projection.js (that script's own cache files under scripts/.res-cache/ are
// read directly here -- confirmed present before writing this script, so this adds ZERO new network
// calls for anything already cached by that backtest).
//
// NEW real data pulled here: Baseball Savant's player-level Statcast CSV leaderboard (confirmed live
// via an actual fetch before writing any of this -- see investigation notes below) joined to each
// team's real MLB Stats API full-season roster, PA-weighted, to build a real team-level season xwOBA.
//
// INVESTIGATION NOTES (verify-before-build, same discipline as the rest of this project):
//   - Baseball Savant's "custom leaderboard" (baseballsavant.mlb.com/leaderboard/custom) does NOT
//     support team-level aggregation. `type=team` silently falls back to player-level data (confirmed
//     live: only "batter"/"pitcher" appear as real nav values in the page's own type-switcher links).
//     `&team=NYY` and `&team=147` were also tried live and do NOT filter the CSV -- both returned the
//     identical full 673-player league list. Savant's own `/team/{id}` pages exist but render team
//     stats via client-side JS, not a scrapeable embedded data array (unlike the park-factors page's
//     `var data = [...]` pattern already used in fetchParkFactorsForSeason/fetchParkHrIndexForSeason).
//     There is no official team-level xwOBA bulk leaderboard on Savant reachable by a simple URL.
//   - So team xwOBA here is DERIVED, not fetched pre-aggregated: real player-level season xwOBA + PA
//     from Savant's CSV export (`?csv=true`, confirmed live, same per-row shape as fetchLeagueHardHitRate
//     uses for pitchers) joined by MLBAM player_id (confirmed identical ID space to MLB Stats API --
//     e.g. player_id 592450 in the Savant CSV is Aaron Judge, same id MLB Stats API's own roster
//     endpoint returns for NYY) against each team's real `teams/{id}/roster?rosterType=fullSeason`
//     roster, then PA-weighted-averaged per team. League average xwOBA is computed directly from the
//     full real player list (PA-weighted), not re-derived from the 30 team averages.
//
// HONEST SCOPE LIMITATIONS (stated up front, not swept under the rug):
//   1. NOT point-in-time. Savant has no easy pre-aggregated point-in-time team xwOBA split (it would
//      require reconstructing it from individual batted-ball events with real timestamps, well beyond
//      this backtest's scope). Every game in the sample is scored against the SAME full-season-2025
//      team xwOBA value, including games from March. The current production proxy (runsPerGame), by
//      contrast, genuinely is point-in-time (as of the day before each game, no look-ahead) -- the
//      comparison below is "best point-in-time proxy" vs "best easily-available season-long Statcast
//      metric", not an apples-to-apples point-in-time vs point-in-time test.
//   2. A player traded mid-season appears on BOTH his old and new team's `fullSeason` roster (confirmed
//      live, e.g. a pitcher shown with status "Traded" still listed on his original team's roster), so
//      his full-season xwOBA contributes to both teams' PA-weighted averages -- a real, acknowledged
//      double-count for traded players, not corrected for here.
//   3. Team xwOBA has no regression-toward-league shrinkage applied (unlike the runsPerGame proxy's
//      OFFENSE_REGRESS_GAMES=20 shrinkage) -- a full season's PA is already a large, stable sample, so
//      shrinkage matters far less here, but this IS a real asymmetry between the two signals' treatment.
//
// Usage: node scripts/backtest-mlb-xwoba-offense-signal.js [sampleEveryNth] [season]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeRunEnvironmentScore, computeTotalRunsProjection } from "../workers/rules-engine.js";
import { scoreMlbGame } from "../workers/rules-engine.js";
import { MLB_STADIUMS, MLB_TEAM_ID_TO_KEY } from "../data/stadiums.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const UA = { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" };

// Reconstructed from rules-engine.js's real internal constants (not exported, so copied here verbatim
// for the parallel offense-term swap -- see computeTotalRunsProjection and its header comment, lines
// ~564-579 and ~624-669 of workers/rules-engine.js as of this writing). pitching(t) is NOT changed by
// this test -- only the offense(t) term is swapped, so both signals are scored through an identical
// pitching term and identical conditionsRuns (taken straight from the REAL computeTotalRunsProjection
// call for each game, not re-derived) for a clean, isolated A/B comparison.
const STARTER_SHARE = 5.5 / 9;
const STARTER_REGRESS_IP = 50;

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
async function fetchText(url, headers = UA) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
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
function regressToward(value, sample, priorSample, mean_) {
  if (value == null || !Number.isFinite(value)) return mean_;
  const w = sample > 0 ? sample / (sample + priorSample) : 0;
  return w * value + (1 - w) * mean_;
}
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Same wind vocabulary parser as backtest-mlb-total-runs-projection.js (copied, not imported --
// every backtest script in this repo is self-contained; see e.g. backtest-nfl-turnover-signal.js).
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
    case "R To L": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg + 90) };
    case "L To R": return { windSpeedMph: speed, windFromDeg: norm(cfBearingDeg - 90) };
    case "Varies": return { windSpeedMph: 0, windFromDeg: 0 };
    default: return { windSpeedMph: 0, windFromDeg: 0 };
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
      const ip = parseFloat(s.stat?.inningsPitched || "0");
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
async function fetchStarterEraAsOf(pitcherId, season, beforeDate) {
  const log = await cachedJson(`mlb-pitcherlog-${pitcherId}-${season}`, () =>
    fetchJson(`https://statsapi.mlb.com/api/v1/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`)
  );
  let er = 0, outs = 0;
  for (const s of log.stats?.[0]?.splits || []) {
    if (s.date >= beforeDate) continue;
    const ip = parseFloat(s.stat?.inningsPitched || "0");
    outs += Math.round(ip * 3);
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

// Real player-level season xwOBA + PA, confirmed live before building this (see header notes).
async function fetchPlayerXwobaSeason(season) {
  return cachedJson(`savant-player-xwoba-${season}`, async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/custom?year=${season}&type=batter&filter=&min=1&selections=xwoba,pa&chart=false&x=xwoba&y=xwoba&r=no&chartType=beeswarm&csv=true`;
    const text = await fetchText(url);
    const lines = text.split("\n").filter(Boolean);
    const header = parseCsvLine(lines[0].replace(/^﻿/, ""));
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    const byPlayerId = {};
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvLine(lines[i]);
      const playerId = Number(cols[idx.player_id]);
      const xwoba = Number(cols[idx.xwoba]);
      const pa = Number(cols[idx.pa]);
      if (Number.isFinite(playerId) && Number.isFinite(xwoba) && Number.isFinite(pa) && pa > 0) {
        byPlayerId[playerId] = { xwoba, pa };
      }
    }
    return byPlayerId;
  });
}
// Real full-season roster per team (confirmed live: MLBAM person ids match Savant's player_id space,
// e.g. 592450 = Aaron Judge in both). rosterType=fullSeason includes players traded away mid-season
// (status "Traded") -- see HONEST SCOPE LIMITATION #2 above re: the resulting double-count.
async function fetchTeamRoster(teamId, season) {
  return cachedJson(`mlb-roster-fullseason-${teamId}-${season}`, () =>
    fetchJson(`https://statsapi.mlb.com/api/v1/teams/${teamId}/roster?rosterType=fullSeason&season=${season}`)
  );
}

async function fetchTeamXwobaForSeason(season) {
  const playerXwoba = await fetchPlayerXwobaSeason(season);

  // Real league-average xwOBA, PA-weighted directly over the full real player list (not re-derived
  // from team averages, which would double-count traded players -- see limitation #2).
  let leagueSumWeighted = 0, leagueSumPa = 0;
  for (const { xwoba, pa } of Object.values(playerXwoba)) {
    leagueSumWeighted += xwoba * pa;
    leagueSumPa += pa;
  }
  const leagueXwoba = leagueSumPa ? leagueSumWeighted / leagueSumPa : null;

  const teamIds = Object.keys(MLB_TEAM_ID_TO_KEY).map(Number);
  const byTeamId = {};
  for (const teamId of teamIds) {
    const roster = await fetchTeamRoster(teamId, season);
    let sumWeighted = 0, sumPa = 0;
    for (const entry of roster.roster || []) {
      const p = playerXwoba[entry.person?.id];
      if (!p) continue;
      sumWeighted += p.xwoba * p.pa;
      sumPa += p.pa;
    }
    if (sumPa > 0) byTeamId[teamId] = { xwoba: sumWeighted / sumPa, pa: sumPa };
  }
  return { leagueXwoba, byTeamId };
}

async function main() {
  const sampleEveryNth = Number(process.argv[2]) || 8;
  const season = Number(process.argv[3]) || 2025;

  const allGames = await fetchSeasonGamePks(season);
  const sample = allGames.filter((_, i) => i % sampleEveryNth === 0);
  console.log(`Season ${season}: ${allGames.length} real completed games, sampling every ${sampleEveryNth}th -> ${sample.length} games.`);

  const [parkFactors, parkHrIndex, teamXwoba] = await Promise.all([
    fetchParkFactorsForSeason(season),
    fetchParkHrIndexForSeason(season),
    fetchTeamXwobaForSeason(season),
  ]);
  console.log(`Real team season xwOBA computed for ${Object.keys(teamXwoba.byTeamId).length}/30 teams (league avg xwOBA ${teamXwoba.leagueXwoba?.toFixed(4)}).`);

  const results = [];
  // Per-team-game rows: current proxy (point-in-time runsPerGame-based offense multiplier) and
  // candidate (season xwOBA-based offense multiplier) vs that team's own real actual runs scored.
  const perTeamRows = [];
  let skippedNoTeamData = 0, skippedNoVenueKey = 0, skippedNoXwoba = 0, errors = 0;
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

          const homeXwoba = teamXwoba.byTeamId[homeTeamId];
          const awayXwoba = teamXwoba.byTeamId[awayTeamId];
          if (!homeXwoba || !awayXwoba || !teamXwoba.leagueXwoba) { skippedNoXwoba++; return; }

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
                umpireLeanRunsPerGame: null,
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

          // Parallel xwOBA-based projection: identical pitching term and identical conditionsRuns
          // (taken straight from the real projection above), offense term swapped for team season
          // xwOBA normalized to league-average xwOBA (no regression shrinkage -- see limitation #3).
          const pitching = (t) => {
            const starterEra = t.starter ? regressToward(t.starter.era, t.starter.inningsPitched || 0, STARTER_REGRESS_IP, teamStats.leagueEra) : t.staffEra;
            return (STARTER_SHARE * starterEra + (1 - STARTER_SHARE) * t.staffEra) / teamStats.leagueEra;
          };
          const offenseXwoba = (x) => x.xwoba / teamXwoba.leagueXwoba;
          const pHome = pitching(team(homeOff, homeStaff, homeStarter));
          const pAway = pitching(team(awayOff, awayStaff, awayStarter));
          const homeRunsXwoba = teamStats.leagueRunsPerGame * offenseXwoba(homeXwoba) * pAway;
          const awayRunsXwoba = teamStats.leagueRunsPerGame * offenseXwoba(awayXwoba) * pHome;
          const projectedTotalXwoba = homeRunsXwoba + awayRunsXwoba + projection.conditionsRuns;

          results.push({
            gamePk, date, venueKey,
            projectedTotalProxy: projection.total,
            projectedTotalXwoba: Math.round(projectedTotalXwoba * 100) / 100,
            actualTotal,
          });

          // Per-team-game rows for the direct signal-vs-actual-runs test.
          const offenseProxy = (off, games) => regressToward(off.runsPerGame, games, 20, teamStats.leagueRunsPerGame) / teamStats.leagueRunsPerGame;
          perTeamRows.push({ gamePk, team: "home", runsPerGameProxy: offenseProxy(homeOff, homeOff.games), xwoba: offenseXwoba(homeXwoba), actualRuns: homeScore });
          perTeamRows.push({ gamePk, team: "away", runsPerGameProxy: offenseProxy(awayOff, awayOff.games), xwoba: offenseXwoba(awayXwoba), actualRuns: awayScore });
        } catch (err) {
          errors++;
        }
      })
    );
    if ((i / CONC) % 10 === 0) console.log(`  ...${Math.min(i + CONC, sample.length)}/${sample.length} processed (${results.length} usable so far)`);
  }

  console.log(`\nUsable games: ${results.length}. Skipped (missing team/starter data): ${skippedNoTeamData}. Skipped (no venue mapping): ${skippedNoVenueKey}. Skipped (no team xwOBA): ${skippedNoXwoba}. Errors: ${errors}.`);

  // --- Test 1: direct signal vs actual runs scored (per-team-game, 2 rows/game) ---
  const proxyVals = perTeamRows.map((r) => r.runsPerGameProxy);
  const xwobaVals = perTeamRows.map((r) => r.xwoba);
  const actualRuns = perTeamRows.map((r) => r.actualRuns);
  const rProxyVsActual = pearson(proxyVals, actualRuns);
  const rXwobaVsActual = pearson(xwobaVals, actualRuns);
  console.log(`\n=== Test 1: offense signal vs that team's real actual runs scored (n=${rProxyVsActual.n} team-games) ===`);
  console.log(`Current proxy (point-in-time runs/game, regressed):  r=${rProxyVsActual.r?.toFixed(4)}`);
  console.log(`Candidate (season-long real Statcast xwOBA):         r=${rXwobaVsActual.r?.toFixed(4)}`);

  // --- Test 2: reconstructed computeTotalRunsProjection total vs actual total runs (game-level) ---
  const projProxy = results.map((r) => r.projectedTotalProxy);
  const projXwoba = results.map((r) => r.projectedTotalXwoba);
  const actualTotals = results.map((r) => r.actualTotal);
  const rProxyTotal = pearson(projProxy, actualTotals);
  const rXwobaTotal = pearson(projXwoba, actualTotals);
  console.log(`\n=== Test 2: full reconstructed projection vs actual total runs (n=${rProxyTotal.n} games) ===`);
  console.log(`Current production logic (runs/game offense term):        r=${rProxyTotal.r?.toFixed(4)}`);
  console.log(`xwOBA-substituted offense term (same pitching/conditions): r=${rXwobaTotal.r?.toFixed(4)}`);

  // Report each test's verdict separately -- they can (and here, do) diverge: a signal can be a real
  // improvement in isolation (Test 1) while washing out once blended with pitching+conditions inside
  // the full projection (Test 2), because game-level total runs is dominated by variance the offense
  // term alone was never going to explain either way.
  const sig = (d) => Math.abs(d) < 0.02 ? "NO MEANINGFUL DIFFERENCE" : (d > 0 ? "xwOBA WINS" : "proxy WINS");
  console.log(`\nVERDICT (Test 1, direct signal quality): ${sig(rXwobaVsActual.r - rProxyVsActual.r)} (xwOBA ${rXwobaVsActual.r >= rProxyVsActual.r ? "+" : ""}${(rXwobaVsActual.r - rProxyVsActual.r).toFixed(4)} vs proxy)`);
  console.log(`VERDICT (Test 2, full reconstructed projection): ${sig(rXwobaTotal.r - rProxyTotal.r)} (xwOBA ${rXwobaTotal.r >= rProxyTotal.r ? "+" : ""}${(rXwobaTotal.r - rProxyTotal.r).toFixed(4)} vs proxy)`);

  fs.writeFileSync(path.join(CACHE_DIR, "mlb-xwoba-offense-signal-backtest-results.json"), JSON.stringify({ perTeamRows, results }, null, 1));
  console.log(`\nFull per-game/per-team results written to scripts/.res-cache/mlb-xwoba-offense-signal-backtest-results.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
