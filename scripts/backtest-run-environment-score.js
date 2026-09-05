// Backtests the Run Environment Score (computeRunEnvironmentScore in rules-engine.js) against a
// real sample of the 2025 MLB regular season -- same spirit and methodology as
// scripts/backtest-carry-model.js (which recalibrated CARRY_LEAN_THRESHOLD_FT) and the umpire
// hitter/pitcher-lean threshold derivation in weather-worker.js (see DECISIONS.md for both). This
// script is the equivalent check for RES_WEIGHTS/RES_SCALE/the tier boundaries, none of which have
// ever been checked against real outcomes -- they were "a documented starting point, NOT a
// backtested constant yet" per the comment above RES_WEIGHTS in rules-engine.js.
//
// Usage: node scripts/backtest-run-environment-score.js [season] [gamesPerTeam]
//   season       defaults to 2025
//   gamesPerTeam how many home games to sample per team, spread evenly across the season
//                (defaults to 15 -- see DECISIONS.md-style reasoning in the header below)
//
// Every external fetch is cached to disk under scripts/.res-cache/ (gitignored-worthy, not
// committed) so an interrupted run loses no work and a re-run with the same args costs nothing.
// The final assembled sample set is written to scripts/data/run-environment-score-samples.json.
//
// ---- Scope and known limitations (documented up front, not discovered after the fact) ----
//
// 1. Look-ahead bias on pitcher/team rates: this script uses each pitcher's FULL 2025 season
//    homeRunsPer9 and each team's FULL 2025 season hitting-vs-hand split, not a rolling "stats as of
//    that game date" snapshot. For a game in April, that rate already includes September games that
//    hadn't happened yet. MLB Stats API's `stats=byDateRange` could fix this per-game, but at one
//    extra fetch per starter per game across hundreds of games it wasn't worth the time budget for a
//    first calibration pass -- documented here explicitly, same as the task asked, rather than
//    silently accepted. Directionally this likely makes early-season pitcherHr9Delta/teamHrRateDelta
//    slightly less accurate (reflecting a full-season rate that a pitcher hadn't "earned" yet) but
//    doesn't bias the SIGN of the signal, since a pitcher who allows more/fewer homers all year
//    tends to do so consistently across the season, not in one concentrated stretch.
// 2. Daily-vs-hourly weather granularity: same limitation the historical almanac feature already
//    accepts (see fetchHistoricalWeatherWindow in weather-worker.js) -- Open-Meteo's archive API only
//    gives a day's mean temp / max wind speed / dominant wind direction, not a reading at actual
//    first-pitch time. A night game's real conditions can differ meaningfully from the day's mean
//    (cooler, calmer), so carryFt here is a real but coarser estimate than what the live product
//    computes from an hourly forecast.
// 3. Umpire lean uses full 2015-present career history (matching fetchUmpireCareerLean's own
//    definition in weather-worker.js) rather than career-as-of-game-date -- same category of
//    look-ahead as #1, accepted for the same reason (a career rate moves slowly; a few years either
//    side of a 2025 game barely shifts it), and it's the same number the live product already shows.
// 4. Sample size: full 2025 season is ~2,430 games. This script samples a fixed, evenly-spaced
//    number of home games per team (see gamesPerTeam) rather than the full season, to keep the
//    per-game fanout (boxscore + starter HR/9 + umpire lookups) practical. Spread evenly across each
//    team's home schedule (every Nth home date) rather than e.g. the first N games of the season, so
//    the sample isn't concentrated in one part of the season/weather cycle.
// 5. Missing signals: not every sampled game will have all 5 inputs (an unassigned/unrecognized
//    umpire, a starter under MIN_PITCHER_IP, a fetch that 404s). computeRunEnvironmentScore already
//    handles partial input sets via its weighted-average design -- this script reports how often
//    each signal was actually available, since a signal missing on 80% of games is a different kind
//    of problem than one that's just slightly noisy.

import { scoreMlbGame, computeRunEnvironmentScore, MIN_PITCHER_IP } from "../workers/rules-engine.js";
import { MLB_STADIUMS, MLB_TEAM_ID_TO_KEY, MLB_KEY_TO_TEAM_ID } from "../data/stadiums.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, ".res-cache");
const DATA_DIR = path.join(__dirname, "data");
const HEADERS = { "User-Agent": "GiddyUpSports-Weather-Backtest/1.0 (contact: jvilla10214@gmail.com)" };

const SEASON = process.argv[2] ? Number(process.argv[2]) : 2025;
const GAMES_PER_TEAM = process.argv[3] ? Number(process.argv[3]) : 15;

// ---- tiny disk cache (JSON file per key, no expiry -- a finished season's stats don't change) ----
async function cached(key, fetcher) {
  const file = path.join(CACHE_DIR, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
  try {
    const hit = await fs.readFile(file, "utf8");
    return JSON.parse(hit);
  } catch {
    // fall through to fetch
  }
  const fresh = await fetcher();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(fresh));
  return fresh;
}

async function fetchJson(url, headers = HEADERS) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---- league-wide baselines (fetched once) ----

function parseInningsPitched(ip) {
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.trunc(n);
  const remainder = Math.round((n - whole) * 10); // thirds, not tenths
  return whole + remainder / 3;
}

async function fetchLeagueHrRate(season) {
  return cached(`league-hr-rate-${season}`, async () => {
    const [pitching, vsLeft, vsRight] = await Promise.all([
      fetchJson(`https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${season}&sportIds=1`),
      fetchJson(`https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&group=hitting&season=${season}&sportIds=1&sitCodes=vl`),
      fetchJson(`https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&group=hitting&season=${season}&sportIds=1&sitCodes=vr`),
    ]);
    let leagueHr = 0;
    let leagueIp = 0;
    for (const s of pitching.stats?.[0]?.splits || []) {
      leagueHr += s.stat?.homeRuns || 0;
      leagueIp += parseInningsPitched(s.stat?.inningsPitched);
    }
    const pitcherHr9League = leagueIp ? (leagueHr / leagueIp) * 9 : null;

    function splitsByTeam(splitData) {
      const byTeamId = {};
      let hrSum = 0;
      let paSum = 0;
      for (const s of splitData.stats?.[0]?.splits || []) {
        const teamId = s.team?.id;
        const hr = s.stat?.homeRuns || 0;
        const pa = s.stat?.plateAppearances || 0;
        if (teamId) byTeamId[teamId] = { hr, pa, hrRate: pa ? hr / pa : null };
        hrSum += hr;
        paSum += pa;
      }
      return { byTeamId, leagueHrRate: paSum ? hrSum / paSum : null };
    }
    const vl = splitsByTeam(vsLeft);
    const vr = splitsByTeam(vsRight);
    return {
      pitcherHr9League,
      hittingLeagueByHand: { L: vl.leagueHrRate, R: vr.leagueHrRate },
      hittingByTeamId: { L: vl.byTeamId, R: vr.byTeamId },
    };
  });
}

async function fetchParkFactors(season) {
  return cached(`park-factors-${season}`, async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=distance&year=${season}&batSide=&stat=index_wOBA&condition=All&rolling=`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`Baseball Savant park factors ${res.status}`);
    const html = await res.text();
    const match = html.match(/var data = (\[.*?\]);/s);
    if (!match) throw new Error("Baseball Savant park factors: expected data array not found");
    const rows = JSON.parse(match[1]);
    const byVenueKey = {};
    for (const r of rows) {
      const venueKey = MLB_TEAM_ID_TO_KEY[Number(r.main_team_id)];
      if (!venueKey) continue;
      byVenueKey[venueKey] = Number(r.extra_distance);
    }
    return byVenueKey;
  });
}

async function fetchPitcherHr9(pitcherId, season) {
  return cached(`pitcher-hr9-${pitcherId}-${season}`, async () => {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}?hydrate=stats(group=[pitching],type=[season],season=${season})`;
    const data = await fetchJson(url);
    const person = data.people?.[0];
    const stat = person?.stats?.find((s) => s.group?.displayName === "pitching" && s.type?.displayName === "season")?.splits?.[0]?.stat;
    const ip = parseInningsPitched(stat?.inningsPitched);
    return {
      throwsHand: person?.pitchHand?.code || null,
      hr9: stat?.homeRunsPer9 != null ? Number(stat.homeRunsPer9) : null,
      inningsPitched: ip,
      qualifies: ip >= MIN_PITCHER_IP,
    };
  });
}

const LEAN_MIN_CAREER_GAMES = 20; // same gate as fetchUmpireCareerLean in weather-worker.js
async function fetchUmpireLean(umpireName) {
  return cached(`umpire-lean-${umpireName}`, async () => {
    const url = `https://umpscorecards.com/api/single-umpire?umpire=${encodeURIComponent(umpireName)}&startDate=2015-01-01&endDate=2026-12-31`;
    const data = await fetchJson(url);
    const rows = data.rows || [];
    const games = rows.length;
    let totalBatterImpact = 0;
    for (const r of rows) totalBatterImpact += (r.home_batter_impact || 0) + (r.away_batter_impact || 0);
    const perGame = games ? totalBatterImpact / games : null;
    return { games, perGameBatterImpact: games >= LEAN_MIN_CAREER_GAMES ? perGame : null };
  });
}

async function fetchTeamSeasonSchedule(teamId, season) {
  return cached(`schedule-${teamId}-${season}`, async () => {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${season}-01-01&endDate=${season}-12-31&hydrate=venue,officials,linescore`;
    const data = await fetchJson(url);
    const games = [];
    for (const d of data.dates || []) {
      for (const g of d.games || []) {
        if (g.gameType !== "R") continue;
        if (g.teams?.home?.team?.id !== teamId) continue;
        if (g.status?.abstractGameState !== "Final") continue;
        const awayScore = g.teams.away?.score;
        const homeScore = g.teams.home?.score;
        if (awayScore == null || homeScore == null) continue;
        const hpUmpire = (g.officials || []).find((o) => o.officialType === "Home Plate")?.official?.fullName || null;
        games.push({
          gamePk: g.gamePk,
          date: d.date,
          awayTeamId: g.teams.away.team.id,
          homeTeamId: g.teams.home.team.id,
          awayScore,
          homeScore,
          hpUmpire,
        });
      }
    }
    return games;
  });
}

async function fetchSeasonWeather(lat, lon, season) {
  return cached(`weather-${lat}-${lon}-${season}`, async () => {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${season}-01-01&end_date=${season}-12-31` +
      `&daily=temperature_2m_mean,relative_humidity_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const data = await fetchJson(url, undefined);
    return data.daily;
  });
}

async function fetchBoxscoreStartersAndHr(gamePk) {
  return cached(`boxscore-${gamePk}`, async () => {
    const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
    const data = await fetchJson(url);
    const away = data.teams?.away;
    const home = data.teams?.home;
    return {
      awayStarterId: away?.pitchers?.[0] ?? null,
      homeStarterId: home?.pitchers?.[0] ?? null,
      awayHomeRuns: away?.teamStats?.batting?.homeRuns ?? null,
      homeHomeRuns: home?.teamStats?.batting?.homeRuns ?? null,
    };
  });
}

// ---- tiny concurrency limiter so we don't fire hundreds of requests at once ----
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function pickEvenlySpaced(arr, n) {
  if (arr.length <= n) return arr;
  const step = arr.length / n;
  const picked = [];
  for (let i = 0; i < n; i++) picked.push(arr[Math.floor(i * step)]);
  return picked;
}

async function main() {
  console.error(`Run Environment Score backtest -- season ${SEASON}, ~${GAMES_PER_TEAM} home games/team\n`);

  const [leagueRates, parkFactors] = await Promise.all([fetchLeagueHrRate(SEASON), fetchParkFactors(SEASON)]);
  console.error(`League pitcherHr9: ${leagueRates.pitcherHr9League?.toFixed(3)}, hitting HR-rate vs L/R: ${leagueRates.hittingLeagueByHand.L?.toFixed(4)}/${leagueRates.hittingLeagueByHand.R?.toFixed(4)}`);

  const samples = [];
  const missing = { carryFt: 0, parkFactorPct: 0, umpireLean: 0, pitcherHr9: 0, teamHrRate: 0 };
  const teamKeys = Object.keys(MLB_STADIUMS);

  for (const key of teamKeys) {
    const venue = MLB_STADIUMS[key];
    const teamId = MLB_KEY_TO_TEAM_ID[key];
    let games, weather;
    try {
      [games, weather] = await Promise.all([fetchTeamSeasonSchedule(teamId, SEASON), fetchSeasonWeather(venue.lat, venue.lon, SEASON)]);
    } catch (err) {
      console.error(`  ${key} schedule/weather FAILED: ${err.message}`);
      continue;
    }
    const sampled = pickEvenlySpaced(games, GAMES_PER_TEAM);
    const { time, temperature_2m_mean, relative_humidity_2m_mean, wind_speed_10m_max, wind_direction_10m_dominant } = weather;
    const weatherByDate = new Map();
    for (let i = 0; i < time.length; i++) {
      weatherByDate.set(time[i], {
        tempF: temperature_2m_mean[i],
        humidityPct: relative_humidity_2m_mean[i],
        windSpeedMph: wind_speed_10m_max[i],
        windFromDeg: wind_direction_10m_dominant[i],
        precipProbPct: 0,
      });
    }

    let teamMatched = 0;
    await mapLimit(sampled, 6, async (g) => {
      const w = weatherByDate.get(g.date);
      if (!w || w.tempF == null || w.windSpeedMph == null || w.windFromDeg == null) return;

      let box;
      try {
        box = await fetchBoxscoreStartersAndHr(g.gamePk);
      } catch {
        return;
      }

      const score = scoreMlbGame(w, venue);
      const carryFt = score.carryFt;

      const parkFactorPct = parkFactors[key] ?? null;

      let umpireLeanRunsPerGame = null;
      if (g.hpUmpire) {
        try {
          const lean = await fetchUmpireLean(g.hpUmpire);
          umpireLeanRunsPerGame = lean.perGameBatterImpact;
        } catch {
          // leave null
        }
      }

      let awayPitcher = null;
      let homePitcher = null;
      try {
        [awayPitcher, homePitcher] = await Promise.all([
          box.awayStarterId ? fetchPitcherHr9(box.awayStarterId, SEASON) : null,
          box.homeStarterId ? fetchPitcherHr9(box.homeStarterId, SEASON) : null,
        ]);
      } catch {
        // leave null
      }
      const hr9s = [awayPitcher, homePitcher].filter((p) => p?.qualifies && p.hr9 != null).map((p) => p.hr9);
      const pitcherHr9Delta = hr9s.length && leagueRates.pitcherHr9League != null ? hr9s.reduce((a, b) => a + b, 0) / hr9s.length - leagueRates.pitcherHr9League : null;

      // Team HR-rate-vs-opposing-starter's-hand: home lineup vs away starter's hand, away lineup vs
      // home starter's hand -- each compared to the league average for that same hand split.
      const deltas = [];
      if (homePitcher?.throwsHand && leagueRates.hittingByTeamId[homePitcher.throwsHand]) {
        const awayTeamSplit = leagueRates.hittingByTeamId[homePitcher.throwsHand][g.awayTeamId];
        const leagueAvg = leagueRates.hittingLeagueByHand[homePitcher.throwsHand];
        if (awayTeamSplit?.hrRate != null && leagueAvg != null) deltas.push(awayTeamSplit.hrRate - leagueAvg);
      }
      if (awayPitcher?.throwsHand && leagueRates.hittingByTeamId[awayPitcher.throwsHand]) {
        const homeTeamSplit = leagueRates.hittingByTeamId[awayPitcher.throwsHand][g.homeTeamId];
        const leagueAvg = leagueRates.hittingLeagueByHand[awayPitcher.throwsHand];
        if (homeTeamSplit?.hrRate != null && leagueAvg != null) deltas.push(homeTeamSplit.hrRate - leagueAvg);
      }
      const teamHrRateDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;

      const actualCombinedRuns = g.awayScore + g.homeScore;
      const actualCombinedHomeRuns = box.awayHomeRuns != null && box.homeHomeRuns != null ? box.awayHomeRuns + box.homeHomeRuns : null;

      const inputs = { carryFt, parkFactorPct, umpireLeanRunsPerGame, pitcherHr9Delta, teamHrRateDelta };
      const res = computeRunEnvironmentScore(inputs);

      if (carryFt == null) missing.carryFt++;
      if (parkFactorPct == null) missing.parkFactorPct++;
      if (umpireLeanRunsPerGame == null) missing.umpireLean++;
      if (pitcherHr9Delta == null) missing.pitcherHr9++;
      if (teamHrRateDelta == null) missing.teamHrRate++;

      samples.push({
        venue: key,
        date: g.date,
        gamePk: g.gamePk,
        ...inputs,
        actualCombinedRuns,
        actualCombinedHomeRuns,
        resScore: res?.score ?? null,
        resTier: res?.tier ?? null,
        inputsUsed: res?.inputsUsed ?? [],
      });
      teamMatched++;
    });
    console.error(`  ${key.padEnd(4)} ${venue.venue.padEnd(28)} ${games.length} home games, sampled ${sampled.length}, matched ${teamMatched}`);
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const outFile = path.join(DATA_DIR, "run-environment-score-samples.json");
  await fs.writeFile(outFile, JSON.stringify({ season: SEASON, gamesPerTeam: GAMES_PER_TEAM, generatedAt: new Date().toISOString(), samples }, null, 1));
  console.error(`\nWrote ${samples.length} samples to ${outFile}\n`);

  analyze(samples, missing);
}

// ---- analysis ----

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}
function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  return num / Math.sqrt(dx2 * dy2);
}

function distLine(label, arr) {
  const clean = arr.filter((v) => v != null && Number.isFinite(v));
  if (!clean.length) {
    console.log(`  ${label.padEnd(24)} n=0`);
    return;
  }
  console.log(
    `  ${label.padEnd(24)} n=${String(clean.length).padEnd(6)} min=${percentile(clean, 0).toFixed(3).padEnd(8)} p25=${percentile(clean, 25).toFixed(3).padEnd(8)} median=${percentile(clean, 50).toFixed(3).padEnd(8)} p75=${percentile(clean, 75).toFixed(3).padEnd(8)} p90=${percentile(clean, 90).toFixed(3).padEnd(8)} max=${percentile(clean, 100).toFixed(3)}`
  );
}

function analyze(samples, missing) {
  const n = samples.length;
  console.log(`\n=== Run Environment Score backtest: ${n} sampled games, season ${SEASON} ===\n`);

  console.log("--- Missing-signal rate (out of all sampled games) ---");
  for (const [k, v] of Object.entries(missing)) console.log(`  ${k.padEnd(20)} missing on ${v}/${n} (${((v / n) * 100).toFixed(1)}%)`);

  console.log("\n--- Raw signal distributions ---");
  distLine("carryFt", samples.map((s) => s.carryFt));
  distLine("parkFactorPct", samples.map((s) => s.parkFactorPct));
  distLine("umpireLeanRunsPerGame", samples.map((s) => s.umpireLeanRunsPerGame));
  distLine("pitcherHr9Delta", samples.map((s) => s.pitcherHr9Delta));
  distLine("teamHrRateDelta", samples.map((s) => s.teamHrRateDelta));

  console.log("\n--- Current composite RES score distribution (existing RES_WEIGHTS/RES_SCALE) ---");
  distLine("resScore", samples.map((s) => s.resScore));
  const tierCounts = {};
  for (const s of samples) tierCounts[s.resTier] = (tierCounts[s.resTier] || 0) + 1;
  for (const [tier, count] of Object.entries(tierCounts)) console.log(`  ${tier.padEnd(28)} n=${count} (${((count / n) * 100).toFixed(1)}%)`);

  console.log("\n--- Does the current score correlate with actual outcomes? ---");
  const scored = samples.filter((s) => s.resScore != null);
  const rRuns = pearson(scored.map((s) => s.resScore), scored.map((s) => s.actualCombinedRuns));
  console.log(`  Pearson r (resScore vs actualCombinedRuns): ${rRuns.toFixed(4)} (n=${scored.length})`);
  const hrScored = scored.filter((s) => s.actualCombinedHomeRuns != null);
  const rHr = pearson(hrScored.map((s) => s.resScore), hrScored.map((s) => s.actualCombinedHomeRuns));
  console.log(`  Pearson r (resScore vs actualCombinedHomeRuns): ${rHr.toFixed(4)} (n=${hrScored.length})`);

  console.log("\n  By tier:");
  for (const tier of ["Strong Hitter Environment", "Hitter Leaning", "Neutral", "Pitcher Leaning", "Strong Pitcher Environment"]) {
    const bucket = samples.filter((s) => s.resTier === tier);
    if (!bucket.length) {
      console.log(`    ${tier.padEnd(28)} n=0`);
      continue;
    }
    const runs = bucket.map((s) => s.actualCombinedRuns);
    const hrs = bucket.filter((s) => s.actualCombinedHomeRuns != null).map((s) => s.actualCombinedHomeRuns);
    console.log(`    ${tier.padEnd(28)} n=${String(bucket.length).padEnd(5)} mean runs=${mean(runs).toFixed(2).padEnd(7)} mean HR=${mean(hrs).toFixed(2)}`);
  }

  console.log("\n  Low vs. high score bucket comparison (bottom 25% vs top 25% of resScore):");
  const sortedByScore = scored.slice().sort((a, b) => a.resScore - b.resScore);
  const q = Math.floor(sortedByScore.length / 4);
  const low = sortedByScore.slice(0, q);
  const high = sortedByScore.slice(-q);
  console.log(`    Low  quartile (n=${low.length}): mean resScore=${mean(low.map((s) => s.resScore)).toFixed(2)}, mean runs=${mean(low.map((s) => s.actualCombinedRuns)).toFixed(2)}, mean HR=${mean(low.filter((s) => s.actualCombinedHomeRuns != null).map((s) => s.actualCombinedHomeRuns)).toFixed(2)}`);
  console.log(`    High quartile (n=${high.length}): mean resScore=${mean(high.map((s) => s.resScore)).toFixed(2)}, mean runs=${mean(high.map((s) => s.actualCombinedRuns)).toFixed(2)}, mean HR=${mean(high.filter((s) => s.actualCombinedHomeRuns != null).map((s) => s.actualCombinedHomeRuns)).toFixed(2)}`);

  console.log("\n--- Per-signal correlation with actual outcomes (raw, unweighted) ---");
  function corrLine(label, key) {
    const clean = samples.filter((s) => s[key] != null && Number.isFinite(s[key]));
    if (clean.length < 10) {
      console.log(`  ${label.padEnd(24)} n=${clean.length} (too few to correlate)`);
      return;
    }
    const rr = pearson(clean.map((s) => s[key]), clean.map((s) => s.actualCombinedRuns));
    const rh = pearson(
      clean.filter((s) => s.actualCombinedHomeRuns != null).map((s) => s[key]),
      clean.filter((s) => s.actualCombinedHomeRuns != null).map((s) => s.actualCombinedHomeRuns)
    );
    console.log(`  ${label.padEnd(24)} n=${String(clean.length).padEnd(6)} r(runs)=${rr.toFixed(4).padEnd(9)} r(HR)=${rh.toFixed(4)}`);
  }
  corrLine("carryFt", "carryFt");
  corrLine("parkFactorPct", "parkFactorPct");
  corrLine("umpireLeanRunsPerGame", "umpireLeanRunsPerGame");
  corrLine("pitcherHr9Delta", "pitcherHr9Delta");
  corrLine("teamHrRateDelta", "teamHrRateDelta");

  console.log("\nDone. Full sample data: scripts/data/run-environment-score-samples.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
