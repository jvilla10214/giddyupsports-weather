/**
 * GiddyUpSports Weather Command Center — Cloudflare Worker
 *
 * Deploy with Wrangler (`npx wrangler deploy` — see wrangler.toml), which bundles this file plus
 * its imports into one script server-side. Unlike the racing repo's manually-pasted single-file
 * Worker, this one is split into modules for testability (`node --test` against rules-engine.js
 * and stadiums.js directly) while still deploying as a single bundled Worker. Bindings needed
 * (declared in wrangler.toml):
 *   - KV namespace bound as `WEATHER_KV`
 *   - Workers AI bound as `AI` (no API key needed — it's a native Cloudflare binding)
 *
 * Routes (all GET, all CORS-open for the GitHub Pages frontend):
 *   /api/schedule?sport=mlb                                 -> today's MLB games (includes both
 *                                                               teams' abbreviations for the
 *                                                               front-page quick-look grid)
 *   /api/game?sport=mlb&venueKey=...[&startTimeUtc=...]      -> weather + score + AI insight.
 *                                                               startTimeUtc (from the schedule's
 *                                                               own game object) gets a point-
 *                                                               forecast for that hour instead of
 *                                                               right-now conditions when the game
 *                                                               is >90min out; omitted or a near/
 *                                                               past time uses current conditions.
 *   /api/game?sport=mlb&venueKey=...&preview=1               -> same, minus the AI call (cheap,
 *                                                               used to populate every card in
 *                                                               the quick-look grid at once)
 *   /api/game?sport=nfl&venueKey=...[&preview=1]             -> same, NFL
 *   /api/almanac?sport=mlb&venueKey=...[&startTimeUtc=...]   -> aggregate across every home game
 *                                                               at this venue (last 15 years) whose
 *                                                               weather closely matched today's --
 *                                                               avg combined runs/HRs across that
 *                                                               sample, not just one game. MLB
 *                                                               only — no free historical box-score
 *                                                               API for NFL, see DECISIONS.md.
 *
 * NFL schedule is NOT fetched here — ESPN's scoreboard API blocks Cloudflare Worker IPs but
 * allows browser CORS requests, so the frontend fetches it client-side instead. See DECISIONS.md.
 *
 * Every external call is cached in KV so a burst of page loads doesn't hammer free/unofficial
 * upstream APIs (MLB Stats API, Open-Meteo, Workers AI's free tier).
 */

import { MLB_STADIUMS, NFL_STADIUMS, MLB_TEAM_ID_TO_KEY, MLB_KEY_TO_TEAM_ID } from "../data/stadiums.js";
import { scoreMlbGame, scoreNflGame, windCompassOrVariable, computeRunEnvironmentScore, MIN_PITCHER_IP } from "./rules-engine.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function cached(env, key, ttlSeconds, fetcher) {
  const hit = await env.WEATHER_KV.get(key, "json");
  if (hit) return hit;
  const fresh = await fetcher();
  await env.WEATHER_KV.put(key, JSON.stringify(fresh), { expirationTtl: ttlSeconds });
  return fresh;
}

// ---- Schedules ----

async function fetchMlbSchedule(env) {
  const date = todayIso();
  return cached(env, `schedule:mlb:${date}`, 15 * 60, async () => {
    // hydrate=officials adds each game's umpire crew -- used to pull the home-plate umpire's name
    // for the umpire-tendency feature (see fetchUmpireStats) without a second API call per game.
    // hydrate=probablePitcher adds each side's starter (id/name only -- no handedness or stats;
    // those come from a separate per-pitcher fetch, see fetchPitcherHrTendency) for the Run
    // Environment Score's pitcher-HR-tendency input. Like hpUmpire, this isn't known/published for
    // every game this far out -- probablePitcher is simply absent until MLB has announced it.
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${date}&endDate=${date}&hydrate=venue,officials,probablePitcher`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0" } });
    if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
    const data = await res.json();
    const games = [];
    for (const d of data.dates || []) {
      for (const g of d.games || []) {
        const venueKey = MLB_TEAM_ID_TO_KEY[g.teams?.home?.team?.id] || null;
        const hpUmpire = (g.officials || []).find((o) => o.officialType === "Home Plate")?.official?.fullName || null;
        const homeProbablePitcher = g.teams?.home?.probablePitcher ? { id: g.teams.home.probablePitcher.id, name: g.teams.home.probablePitcher.fullName } : null;
        const awayProbablePitcher = g.teams?.away?.probablePitcher ? { id: g.teams.away.probablePitcher.id, name: g.teams.away.probablePitcher.fullName } : null;
        games.push({
          gameId: String(g.gamePk),
          startTimeUtc: g.gameDate,
          away: g.teams?.away?.team?.name,
          home: g.teams?.home?.team?.name,
          awayAbbr: MLB_TEAM_ID_TO_KEY[g.teams?.away?.team?.id] || null,
          homeAbbr: venueKey,
          homeTeamId: g.teams?.home?.team?.id || null,
          awayTeamId: g.teams?.away?.team?.id || null,
          venue: g.venue?.name,
          venueKey,
          status: g.status?.detailedState,
          hpUmpire,
          homeProbablePitcher,
          awayProbablePitcher,
        });
      }
    }
    return { sport: "mlb", date, games };
  });
}

// ---- Park factors (Statcast, via Baseball Savant) ----

// Baseball Savant's park-factors leaderboard is server-rendered with the full dataset embedded as
// a plain `var data = [...]` JS array in the page HTML -- no auth, no JS execution needed, and no
// CSV/JSON API endpoint exists for it (checked; `&csv=true` just re-serves the same HTML). Scraping
// one `var data = [...]` assignment out of a page is fragile in the abstract, but this is Baseball
// Savant's own official leaderboard (not a third party), the shape has been stable, and the fetch is
// wrapped in a try/catch by the caller so a future markup change degrades to "no park factor today"
// rather than breaking the whole game response.
async function fetchParkFactors(env) {
  const year = new Date().getUTCFullYear();
  return cached(env, `parkfactors:mlb:${year}`, 24 * 60 * 60, async () => {
    const url = `https://baseballsavant.mlb.com/leaderboard/statcast-park-factors?type=distance&year=${year}&batSide=&stat=index_wOBA&condition=All&rolling=`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" } });
    if (!res.ok) throw new Error(`Baseball Savant park factors ${res.status}`);
    const html = await res.text();
    const match = html.match(/var data = (\[.*?\]);/s);
    if (!match) throw new Error("Baseball Savant park factors: expected data array not found in page");
    const rows = JSON.parse(match[1]);
    const byVenueKey = {};
    for (const r of rows) {
      const venueKey = MLB_TEAM_ID_TO_KEY[Number(r.main_team_id)];
      if (!venueKey) continue;
      byVenueKey[venueKey] = {
        year: Number(r.year),
        // "extra distance" figures are a % of typical fly-ball distance this park adds/removes for
        // a standardized batted ball (90+mph, 24-32deg launch, pulled 0-24deg off center) vs a
        // league-average park under the SAME conditions -- see Savant's own methodology text.
        totalPct: Number(r.extra_distance),
        tempPct: Number(r.temperature_extra_distance),
        elevationPct: Number(r.elevation_extra_distance),
        roofPct: Number(r.roof_extra_distance),
        environmentPct: Number(r.environment_extra_distance), // humidity/wind/etc -- everything not otherwise broken out
      };
    }
    return { year, byVenueKey, source: "Baseball Savant Statcast Park Factors" };
  });
}

// ---- Umpire tendencies (UmpScorecards) ----

// UmpScorecards' own site describes its mission as "measuring the accuracy, consistency, and favor
// of MLB umpires" -- "favor" here is a run-impact-based measure of which team an umpire's incorrect
// calls tended to benefit, NOT a strike-zone-size "hitter-friendly/pitcher-friendly" rating (there's
// no such rating published). Surfaced honestly as accuracy/consistency/favor, matching what the
// source actually measures, rather than relabeling it into a claim it doesn't support.
async function fetchUmpireStats(env) {
  const year = new Date().getUTCFullYear();
  return cached(env, `umpires:mlb:${year}`, 24 * 60 * 60, async () => {
    const url = `https://umpscorecards.com/api/umpires?startDate=${year}-01-01&endDate=${year}-12-31&seasonType=R`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" } });
    if (!res.ok) throw new Error(`UmpScorecards ${res.status}`);
    const data = await res.json();
    const byName = {};
    for (const r of data.rows || []) {
      if (!r.umpire) continue;
      byName[r.umpire] = {
        games: r.n,
        accuracyPct: Math.round(r.overall_accuracy_wmean * 10) / 10,
        consistencyPct: Math.round(r.consistency_wmean * 10) / 10,
        avgFavorRuns: Math.round(r.total_run_impact_mean * 100) / 100,
      };
    }
    return { year, byName, source: "UmpScorecards" };
  });
}

// Real career-long hitter/pitcher lean, requested by the user after the season-only feature above
// shipped without one (UmpScorecards' season leaderboard has no zone-size/hitter-pitcher metric --
// see the comment above). Found while digging into the per-umpire page
// (umpscorecards.com/api/single-umpire?umpire=NAME&startDate=...&endDate=...): each individual game
// row carries home_batter_impact/away_batter_impact/home_pitcher_impact/away_pitcher_impact, and
// checked across a full 97-game sample that (home_batter_impact + away_batter_impact) always exactly
// equals -(home_pitcher_impact + away_pitcher_impact) -- a real zero-sum run-value split between the
// two sides of every pitch, independent of home/away team. Summed across an umpire's whole career
// (2015-present, whatever's covered), that gives a genuine, derivable "did this umpire's misses net
// help batters or pitchers" number -- not a fabrication, and not the same thing as UmpScorecards' own
// team-based "favor" metric already surfaced as avgFavorRuns above.
//
// LEAN_HITTER_THRESHOLD / LEAN_PITCHER_THRESHOLD are the real p75/p25 of perGameBatterImpact across
// all 91 currently-active umpires' full careers (fetched and analyzed 2026-09-04, see DECISIONS.md)
// -- not arbitrary. Top quartile of that snapshot = "leans hitter-friendly", bottom quartile =
// "leans pitcher-friendly", middle 50% = neutral -- same "backtest a real threshold, don't guess"
// approach as CARRY_LEAN_THRESHOLD_FT in rules-engine.js. MIN_CAREER_GAMES gates small-sample noise
// (5 of the 91 active umpires had under 20 career games in that snapshot, one of them a 9-game
// sample sitting at an extreme -0.43 -- not a real signal, just not enough innings yet).
const LEAN_HITTER_THRESHOLD = 0.02;
const LEAN_PITCHER_THRESHOLD = -0.2;
const MIN_CAREER_GAMES = 20;

async function fetchUmpireCareerLean(env, umpireName) {
  // Cached per-umpire, not per-day -- a career aggregate barely moves game to game, so a week-long
  // TTL avoids re-fetching an umpire's entire history on every page load without ever going stale
  // in a way that matters.
  return cached(env, `umpire-career:${umpireName}`, 7 * 24 * 60 * 60, async () => {
    const url = `https://umpscorecards.com/api/single-umpire?umpire=${encodeURIComponent(umpireName)}&startDate=2015-01-01&endDate=${todayIso()}`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" } });
    if (!res.ok) throw new Error(`UmpScorecards single-umpire ${res.status}`);
    const data = await res.json();
    const rows = data.rows || [];
    const games = rows.length;
    let totalBatterImpact = 0;
    for (const r of rows) totalBatterImpact += (r.home_batter_impact || 0) + (r.away_batter_impact || 0);
    const perGame = games ? totalBatterImpact / games : 0;
    const lean =
      games < MIN_CAREER_GAMES
        ? "insufficient data"
        : perGame >= LEAN_HITTER_THRESHOLD
          ? "hitter"
          : perGame <= LEAN_PITCHER_THRESHOLD
            ? "pitcher"
            : "neutral";
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    return {
      games,
      perGameBatterImpact: Math.round(perGame * 1000) / 1000,
      lean,
      sinceYear: dates.length ? Number(dates[0].slice(0, 4)) : null,
    };
  });
}

// ---- Real-time roof status (retractable-roof venues only) ----

// scoreMlbGame always assumed a retractable-roof venue was closed, since roof-open/closed isn't
// knowable in advance from any free source -- documented as a real limitation since early in this
// project. MLB's own live game feed turns out to carry it after all: `gameData.weather.condition`
// reads the literal string "Roof Closed" when shut, or a normal weather condition ("Clear", "Sunny",
// etc., with a real on-site wind reading already phrased relative to the field, e.g. "8 mph, Out To
// CF") when open -- confirmed live across TOR/SEA/MIL (open) and HOU/TEX/ARI/MIA (closed) games.
// Like the umpire-crew hydrate, this is only populated once MLB actually knows it -- confirmed empty
// (`weather: {}`) for a game still hours out in "Scheduled" status, populated by "Pre-Game". So this
// can upgrade the near-game-time detail view once a specific gameId is known, but can't fix the
// pregame preview grid shown hours in advance -- a real limitation of the data itself, not something
// more engineering solves, so handleGame below only calls this for the (non-preview) detail view,
// same reasoning already applied to the umpire lookup.
async function fetchGameRoofStatus(env, gameId) {
  // Short TTL, unlike the day-plus caches above -- this is genuinely time-sensitive (starts unknown,
  // becomes known as game time approaches) rather than slowly-changing season data, so a page
  // reloaded an hour later should have a real chance of picking up a status that just became known.
  return cached(env, `roofstatus:${gameId}`, 10 * 60, async () => {
    const url = `https://statsapi.mlb.com/api/v1.1/game/${gameId}/feed/live`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0 (contact: jvilla10214@gmail.com)" } });
    if (!res.ok) throw new Error(`MLB live feed ${res.status}`);
    const data = await res.json();
    const weather = data.gameData?.weather;
    if (!weather || !weather.condition) return { known: false };
    const roofOpen = weather.condition !== "Roof Closed";
    return { known: true, roofOpen, condition: weather.condition };
  });
}

// ---- Pitcher/team HR tendency (Run Environment Score input) ----
//
// MLB Stats API's own `homeRunsPer9` field is already a correctly-computed rate stat -- no need to
// hand-parse a single pitcher's `inningsPitched` (which uses baseball notation, e.g. "154.1" means
// 154+1/3 innings, NOT 154.1 decimal -- a real gotcha, just not one that hits this specific field
// since the API pre-computes the rate itself). That parsing IS still needed below for the
// league-wide aggregate, which sums raw inningsPitched strings across 30 teams rather than reading
// a single pre-computed rate.
function parseInningsPitched(ip) {
  const n = Number(ip);
  if (!Number.isFinite(n)) return 0;
  const whole = Math.trunc(n);
  const remainder = Math.round((n - whole) * 10); // 0, 1, or 2 -- thirds of an inning, not tenths
  return whole + remainder / 3;
}

// One call each for team-level season pitching and both batting-vs-hand splits (all 30 teams at
// once, confirmed live) gives everything needed for both this game's specific inputs AND the
// league-average baseline each is compared against, without a 30x per-team fetch loop. Cached a
// full day, same as park factors -- these are slow-moving season aggregates.
async function fetchLeagueHrRate(env) {
  const year = new Date().getUTCFullYear();
  return cached(env, `league-hr-rate:${year}`, 24 * 60 * 60, async () => {
    const headers = { "User-Agent": "GiddyUpSports-Weather/1.0" };
    const [pitchingRes, vsLeftRes, vsRightRes] = await Promise.all([
      fetch(`https://statsapi.mlb.com/api/v1/teams/stats?stats=season&group=pitching&season=${year}&sportIds=1`, { headers }),
      fetch(`https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&group=hitting&season=${year}&sportIds=1&sitCodes=vl`, { headers }),
      fetch(`https://statsapi.mlb.com/api/v1/teams/stats?stats=statSplits&group=hitting&season=${year}&sportIds=1&sitCodes=vr`, { headers }),
    ]);
    if (!pitchingRes.ok || !vsLeftRes.ok || !vsRightRes.ok) throw new Error("MLB Stats API team-stats fetch failed");
    const [pitching, vsLeft, vsRight] = await Promise.all([pitchingRes.json(), vsLeftRes.json(), vsRightRes.json()]);

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
    const teamIds = new Set([...Object.keys(vl.byTeamId), ...Object.keys(vr.byTeamId)]);
    const hittingByTeamId = {};
    for (const teamId of teamIds) {
      hittingByTeamId[teamId] = { vsL: vl.byTeamId[teamId] || null, vsR: vr.byTeamId[teamId] || null };
    }

    return {
      year,
      pitcherHr9League,
      hittingLeagueByHand: { L: vl.leagueHrRate, R: vr.leagueHrRate },
      hittingByTeamId,
    };
  });
}

// A starter's own season HR/9 + throwing hand, one clean official-API call (no Statcast scraping
// needed for this input -- see comment above). Cached per pitcher, same TTL/reasoning as park
// factors: a season rate barely moves start to start.
async function fetchPitcherHrTendency(env, pitcherId) {
  const year = new Date().getUTCFullYear();
  return cached(env, `pitcher-hr9:${pitcherId}:${year}`, 24 * 60 * 60, async () => {
    const url = `https://statsapi.mlb.com/api/v1/people/${pitcherId}?hydrate=stats(group=[pitching],type=[season],season=${year})`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0" } });
    if (!res.ok) throw new Error(`MLB Stats API person ${res.status}`);
    const data = await res.json();
    const person = data.people?.[0];
    const stat = person?.stats?.find((s) => s.group?.displayName === "pitching" && s.type?.displayName === "season")?.splits?.[0]?.stat;
    const ip = parseInningsPitched(stat?.inningsPitched);
    return {
      pitcherId: Number(pitcherId),
      throwsHand: person?.pitchHand?.code || null,
      hr9: stat?.homeRunsPer9 != null ? Number(stat.homeRunsPer9) : null,
      inningsPitched: ip,
      qualifies: ip >= MIN_PITCHER_IP,
    };
  });
}

// NFL schedule is intentionally NOT fetched here. ESPN's scoreboard API (site.api.espn.com) sends
// Access-Control-Allow-Origin: * (it's fine with real browsers) but returns 403 to every request
// from a Cloudflare Worker regardless of headers — confirmed by testing identical requests with
// matching browser User-Agent/Referer/Origin headers from a Worker (blocked) vs. a plain machine
// (200 OK). This is ESPN's edge blocking Cloudflare's IP ranges, not a headers problem, so no
// header tweak fixes it from here. The frontend (index.html) fetches ESPN directly from the
// user's own browser instead, which ESPN's CORS policy explicitly allows. See DECISIONS.md.

// ---- Weather ----

const NWS_HEADERS = { "User-Agent": "GiddyUpSports-Weather/1.0 (weather.giddyupsports contact: jvilla10214@gmail.com)" };

// Open-Meteo's "current" wind is a high-resolution model nowcast, not a live instrument reading --
// good in steady conditions, but caught genuinely missing a real thunderstorm live: at the same
// moment Open-Meteo reported 0.7mph "mainly clear," the real METAR for the nearest airport showed
// an active storm ("06012KT ... TS BKN035CB", wind 12kt/13.8mph, lightning) via a SPECI report --
// the kind of sudden, fast-moving convective wind event models nowcast poorly. NWS station
// observations are real ground-truth instrument readings, so they're used as the primary US wind
// source when available, with Open-Meteo as the fallback (covers Toronto, the one non-US venue,
// and any moment NWS's own data pipeline comes back incomplete -- see fetchNwsWind for why that
// needs defensive null-checking too).

async function findNearestNwsStation(env, lat, lon) {
  return cached(env, `nws-station:${lat},${lon}`, 60 * 60 * 24 * 90, async () => {
    const point = await fetch(`https://api.weather.gov/points/${lat},${lon}`, { headers: NWS_HEADERS });
    if (!point.ok) return null;
    const pointData = await point.json();
    const stationsUrl = pointData.properties?.observationStations;
    if (!stationsUrl) return null;
    const stations = await fetch(stationsUrl, { headers: NWS_HEADERS });
    if (!stations.ok) return null;
    const stationsData = await stations.json();
    return stationsData.features?.[0]?.properties?.stationIdentifier || null;
  });
}

async function fetchNwsWind(env, stationId) {
  return cached(env, `nws-obs:${stationId}`, 10 * 60, async () => {
    const res = await fetch(`https://api.weather.gov/stations/${stationId}/observations/latest`, { headers: NWS_HEADERS });
    if (!res.ok) return null;
    const data = await res.json();
    const p = data.properties || {};
    // NWS's structured fields have shown up null (quality code "Z" = missing) even when the raw
    // METAR text clearly had valid wind data for the same report -- a real gap in their JSON
    // pipeline, confirmed live. Rather than parse raw METAR text to work around it, just fall back
    // to Open-Meteo whenever either field is missing -- simpler, and Open-Meteo is a perfectly
    // reasonable fallback for the (presumably minority of) moments this happens.
    if (p.windSpeed?.value == null || p.windDirection?.value == null) return null;
    return {
      windSpeedMph: Math.round(p.windSpeed.value * 0.621371 * 10) / 10, // km/h -> mph
      windFromDeg: p.windDirection.value,
      windGustMph: p.windGust?.value != null ? Math.round(p.windGust.value * 0.621371 * 10) / 10 : null,
      observedAt: p.timestamp,
      source: "NWS",
    };
  });
}

// Hourly point-forecast, cached once per venue per hour (not per specific game/target time) so
// every game at a venue on a given day shares one fetch -- the right hour is picked out of the
// cached array afterward. `timezone=UTC` keeps hourly.time in UTC (no offset suffix; Open-Meteo
// omits it regardless of the requested zone, so a "Z" is appended before parsing) so it lines up
// directly with the schedule's own startTimeUtc without a timezone-conversion step.
async function fetchWeatherForecastHours(env, lat, lon) {
  const hourKey = new Date().toISOString().slice(0, 13);
  return cached(env, `weather-forecast:${lat},${lon}:${hourKey}`, 60 * 60, async () => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=UTC&forecast_days=16`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo forecast ${res.status}`);
    const data = await res.json();
    return data.hourly || null;
  });
}

function pickForecastHour(hourly, targetIso) {
  if (!hourly?.time?.length) return -1;
  const targetMs = new Date(targetIso).getTime();
  let bestIdx = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < hourly.time.length; i++) {
    const diff = Math.abs(new Date(hourly.time[i] + "Z").getTime() - targetMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function fetchWeather(env, lat, lon, targetTimeIso) {
  // A game checked hours before first pitch used to get the RIGHT NOW reading, not a prediction of
  // conditions when the game actually starts -- for a 7:40pm game checked at 2pm, that's showing
  // 2pm's wind and calling it today's read. Within ~90 minutes of the scheduled start (or for a
  // game already underway/in the past), current conditions ARE the best available estimate of
  // game-time conditions, and NWS's live ground-truth reading below is strictly better than a
  // forecast bucket -- so the forecast path is only used outside that window.
  const targetMs = targetTimeIso ? new Date(targetTimeIso).getTime() : NaN;
  const hoursUntilTarget = Number.isFinite(targetMs) ? (targetMs - Date.now()) / (60 * 60 * 1000) : 0;

  if (hoursUntilTarget > 1.5) {
    try {
      const hourly = await fetchWeatherForecastHours(env, lat, lon);
      const idx = pickForecastHour(hourly, targetTimeIso);
      // forecast_days=16 covers every game on the schedule today, but if a target ever falls
      // outside that window, the "closest" hour is really just whatever's left at the edge of the
      // array -- a different day's weather mislabeled as game time, which is worse than admitting
      // there's no forecast and falling back to current conditions instead.
      const pickedDiffMs = idx >= 0 ? Math.abs(new Date(hourly.time[idx] + "Z").getTime() - targetMs) : Infinity;
      if (idx >= 0 && pickedDiffMs <= 3 * 60 * 60 * 1000) {
        // The 7 hours leading straight into the matched game-time hour (not from "now" -- a game
        // days out would otherwise need an oddly long or subsampled trend; anchoring to the game
        // hour instead always gives a fixed, meaningful "wind building/easing into game time" read
        // regardless of how far out the game is).
        const trendStart = Math.max(0, idx - 7);
        const windTrend = [];
        for (let i = trendStart; i <= idx; i++) {
          windTrend.push({ timeIso: hourly.time[i] + "Z", windSpeedMph: hourly.wind_speed_10m[i] });
        }
        return {
          tempF: hourly.temperature_2m[idx],
          humidityPct: hourly.relative_humidity_2m[idx],
          precipProbPct: hourly.precipitation_probability[idx],
          windSpeedMph: hourly.wind_speed_10m[idx],
          windFromDeg: hourly.wind_direction_10m[idx],
          windGustMph: hourly.wind_gusts_10m?.[idx] ?? null,
          observedAt: hourly.time[idx] + "Z",
          source: "Open-Meteo",
          windSource: "Open-Meteo (forecast)",
          isForecast: true,
          forecastForIso: hourly.time[idx] + "Z",
          windTrend,
        };
      }
    } catch {
      // Forecast fetch failed -- fall through to current conditions rather than error the request.
    }
  }

  // Real case caught by the user at Nationals Park: an uncached direct query showed wind
  // direction had swung from 66deg to 252deg -- nearly a full reversal -- in under 30 minutes,
  // because wind that light (0.7-2.7mph) is inherently erratic with no dominant driving force.
  // The 30min cache TTL meant the site could show a snapshot already stale by the time someone
  // looked at it, disagreeing with what they could see/feel in real time. 10 minutes trades a bit
  // more Open-Meteo traffic (still free, still keyless) for meaningfully fresher wind direction.
  const hourKey = new Date().toISOString().slice(0, 13);
  return cached(env, `weather:${lat},${lon}:${hourKey}`, 10 * 60, async () => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    const c = data.current || {};
    const openMeteo = {
      tempF: c.temperature_2m,
      humidityPct: c.relative_humidity_2m,
      precipProbPct: c.precipitation_probability,
      windSpeedMph: c.wind_speed_10m,
      windFromDeg: c.wind_direction_10m,
      windGustMph: c.wind_gusts_10m ?? null,
      observedAt: c.time,
      source: "Open-Meteo",
      isForecast: false,
      forecastForIso: null,
      windTrend: null,
    };

    let nwsWind = null;
    try {
      const stationId = await findNearestNwsStation(env, lat, lon);
      if (stationId) nwsWind = await fetchNwsWind(env, stationId);
    } catch {
      // Any NWS failure (network, parsing, non-US location) just means we keep the Open-Meteo
      // wind -- never let this secondary source take down the primary request.
    }

    return nwsWind
      ? { ...openMeteo, windSpeedMph: nwsWind.windSpeedMph, windFromDeg: nwsWind.windFromDeg, windGustMph: nwsWind.windGustMph ?? openMeteo.windGustMph, windSource: "NWS" }
      : { ...openMeteo, windSource: "Open-Meteo" };
  });
}

// ---- Historical almanac (MLB only) ----
//
// Finds the closest-matching weather day at this venue over the last 15 years, restricted to
// dates the team actually played a home game there (so there's always a real result to show, not
// just a weather coincidence), and pulls that game's final score and home-run count.
//
// Search order matters here: rather than finding the single closest weather day and then hoping
// a game happened to be played, this pulls each year's home-game schedule FIRST (a date range the
// team actually played at home, +/-5 days around today's month/day) and only compares weather
// among those confirmed game dates. Every match is guaranteed to have a real result.

function circularDegDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function weatherDistance(a, b) {
  const tempD = (a.tempF ?? 0) - (b.tempF ?? 0);
  const windD = (a.windSpeedMph ?? 0) - (b.windSpeedMph ?? 0);
  const dirD = circularDegDiff(a.windFromDeg ?? 0, b.windFromDeg ?? 0) / 12; // direction matters less than speed/temp
  return Math.sqrt(tempD * tempD + windD * windD * 1.8 + dirD * dirD);
}

function historicalWindow(year, monthDay, spanDays) {
  const [mm, dd] = monthDay.split("-").map(Number);
  const center = new Date(Date.UTC(year, mm - 1, dd));
  const start = new Date(center);
  start.setUTCDate(start.getUTCDate() - spanDays);
  const end = new Date(center);
  end.setUTCDate(end.getUTCDate() + spanDays);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

async function fetchHistoricalWeatherWindow(env, lat, lon, startDate, endDate) {
  return cached(env, `hist-weather:${lat},${lon}:${startDate}:${endDate}`, 60 * 60 * 24 * 60, async () => {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
      `&start_date=${startDate}&end_date=${endDate}` +
      `&daily=temperature_2m_mean,wind_speed_10m_max,wind_direction_10m_dominant` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  });
}

async function fetchHomeGamesInWindow(env, teamId, startDate, endDate) {
  return cached(env, `hist-games:${teamId}:${startDate}:${endDate}`, 60 * 60 * 24 * 60, async () => {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&hydrate=linescore`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0" } });
    if (!res.ok) return [];
    const data = await res.json();
    const games = [];
    for (const d of data.dates || []) {
      for (const g of d.games || []) {
        if (g.teams?.home?.team?.id === teamId && g.status?.abstractGameState === "Final") {
          games.push({
            date: d.date,
            gamePk: g.gamePk,
            away: g.teams.away.team.name,
            home: g.teams.home.team.name,
            awayScore: g.teams.away.score,
            homeScore: g.teams.home.score,
          });
        }
      }
    }
    return games;
  });
}

async function fetchBoxscoreHomeRuns(env, gamePk) {
  return cached(env, `hist-box:${gamePk}`, 60 * 60 * 24 * 60, async () => {
    const url = `https://statsapi.mlb.com/api/v1/game/${gamePk}/boxscore`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      away: data.teams?.away?.teamStats?.batting?.homeRuns ?? null,
      home: data.teams?.home?.teamStats?.batting?.homeRuns ?? null,
    };
  });
}

// Rather than surfacing one arbitrary closest-matching day (which can read as a coincidence -- a
// single 12-run outlier doesn't tell you what similar weather *usually* does), this pulls every
// candidate day within a "genuinely similar" distance of today's weather and averages their real
// results. If too few days qualify (a real possibility for less-common weather at a given park),
// the cap is relaxed and the closest available days are used instead, flagged via `looseMatch` so
// the UI can be honest that the sample isn't as tightly matched.
const ALMANAC_DIST_CAP = 9; // roughly: within ~7F and ~4mph of today, direction weighted lightly
const ALMANAC_MIN_SAMPLE = 6;
const ALMANAC_MAX_SAMPLE = 20;

async function findAlmanacAggregate(env, venue, teamId, todayWeather) {
  const monthDay = todayIso().slice(5); // "MM-DD"
  const currentYear = new Date().getUTCFullYear();
  const YEARS_BACK = 15;
  const SPAN_DAYS = 5;
  const years = Array.from({ length: YEARS_BACK }, (_, i) => currentYear - 1 - i);

  const perYear = await Promise.all(
    years.map(async (year) => {
      const { startDate, endDate } = historicalWindow(year, monthDay, SPAN_DAYS);
      const [weatherData, games] = await Promise.all([
        fetchHistoricalWeatherWindow(env, venue.lat, venue.lon, startDate, endDate),
        fetchHomeGamesInWindow(env, teamId, startDate, endDate),
      ]);
      return { weatherData, games };
    })
  );

  const candidates = [];
  for (const { weatherData, games } of perYear) {
    if (!weatherData?.daily?.time || !games.length) continue;
    const { time, temperature_2m_mean, wind_speed_10m_max, wind_direction_10m_dominant } = weatherData.daily;
    for (const game of games) {
      const idx = time.indexOf(game.date);
      if (idx === -1) continue;
      const dayWeather = {
        tempF: temperature_2m_mean[idx],
        windSpeedMph: wind_speed_10m_max[idx],
        windFromDeg: wind_direction_10m_dominant[idx],
      };
      candidates.push({ date: game.date, weather: dayWeather, distance: weatherDistance(dayWeather, todayWeather), game });
    }
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => a.distance - b.distance);
  let pool = candidates.filter((c) => c.distance <= ALMANAC_DIST_CAP);
  const looseMatch = pool.length < ALMANAC_MIN_SAMPLE;
  if (looseMatch) pool = candidates.slice(0, ALMANAC_MIN_SAMPLE);
  pool = pool.slice(0, ALMANAC_MAX_SAMPLE);

  const boxscores = await Promise.all(pool.map((c) => fetchBoxscoreHomeRuns(env, c.game.gamePk)));

  const games = pool.map((c, i) => ({
    date: c.date,
    away: c.game.away,
    home: c.game.home,
    awayScore: c.game.awayScore,
    homeScore: c.game.homeScore,
    awayHomeRuns: boxscores[i]?.away ?? null,
    homeHomeRuns: boxscores[i]?.home ?? null,
    tempF: Math.round(c.weather.tempF),
    windSpeedMph: Math.round(c.weather.windSpeedMph),
  }));

  const runsSamples = games.map((g) => g.awayScore + g.homeScore).filter((n) => Number.isFinite(n));
  const hrSamples = games
    .map((g) => (g.awayHomeRuns != null && g.homeHomeRuns != null ? g.awayHomeRuns + g.homeHomeRuns : null))
    .filter((n) => n != null);
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  return {
    sampleSize: games.length,
    looseMatch,
    avgWeather: {
      tempF: Math.round(avg(pool.map((c) => c.weather.tempF))),
      windSpeedMph: Math.round(avg(pool.map((c) => c.weather.windSpeedMph)) * 10) / 10,
    },
    avgCombinedRuns: runsSamples.length ? Math.round(avg(runsSamples) * 10) / 10 : null,
    avgCombinedHomeRuns: hrSamples.length ? Math.round(avg(hrSamples) * 10) / 10 : null,
    hrSampleSize: hrSamples.length,
    games,
  };
}

async function getAlmanacMatch(env, venueKey, venue, todayWeather) {
  const teamId = MLB_KEY_TO_TEAM_ID[venueKey];
  if (!teamId) return null;
  // Cache key prefix changed from "almanac:" to "almanac-agg:" alongside the switch from a single
  // best-match game to an aggregate across many similar-weather games -- the response shape changed
  // entirely, so this avoids serving an old-shaped cached entry under the new code.
  return cached(env, `almanac-agg:${venueKey}:${todayIso()}`, 60 * 60 * 24, () => findAlmanacAggregate(env, venue, teamId, todayWeather));
}

// ---- AI narration ----

async function narrate(env, sport, score, weather, venue, parkFactor, umpire, runEnvironmentScore) {
  const venueLabel = venue.venue;

  // Indoor games (fixed dome, or a retractable roof assumed closed) always land on the same
  // conclusion -- climate-controlled, wind/precip irrelevant to play -- so there's nothing for
  // an AI call to add. Most are air-conditioned too, which is exactly why even the temperature
  // reading isn't meaningful once you're indoors. Skip the model entirely and say so directly;
  // this also means no more "gentle breeze inside a fixed dome" hallucinations (confirmed live
  // on Tropicana Field before this fix), since there's no generation step left to hallucinate in.
  if (score.roofClosed) {
    const certainty =
      venue.roofType === "dome"
        ? "a fixed dome"
        : score.roofStatusConfirmed
          ? "a retractable roof (confirmed closed today)"
          : "a retractable roof (assumed closed today, not yet confirmed)";
    return {
      text: `${venueLabel} is played under ${certainty}. Conditions are climate-controlled, so wind, temperature, and precipitation have no bearing on today's game.`,
      cached: false,
    };
  }

  // Direction has to be part of the key, not just speed/temp -- a swing from "blowing out toward
  // right field" to "blowing in from right field" can happen with speed/temp barely moving (the
  // Nationals Park case that motivated the 10min weather-cache TTL below), which would otherwise
  // leave a stale, direction-wrong insight served for up to 6hrs. The forecast/current flag also
  // has to be in the key -- the model is told to describe one or the other (see conditionsLabel
  // below), and speed/temp could round the same across that transition (forecast checked hours
  // out vs. current once the game's about to start) without busting the key on their own.
  //
  // score.windZone (MLB) is used here instead of the raw windCompass letter -- it's the actual
  // deterministic output the prompt is built from (see mlbWindLine below), not just a proxy for
  // it, so a fix to the rules engine or a venue's cfBearingDeg (like the PIT correction this key
  // choice was found while diagnosing) invalidates any already-cached insight immediately instead
  // of leaving a stale, now-provably-wrong one served for up to 6 more hours. windCompass/windTier
  // stay as the fallback for NFL, which has no windZone.
  // umpire has to be in the key too -- it changes per game (not per venue/day/weather the way the
  // rest of this key does), so without it every game at the same park on the same day with similar
  // weather would share one cached insight regardless of which umpire is actually working it.
  // runEnvironmentScore's tier is in the cache key for the same reason umpire's name is: it can
  // become known/change during the day (starters get announced, a fetch that failed earlier now
  // succeeds) independent of everything else in this key, so a stale "2/5 signals, Neutral" insight
  // shouldn't keep being served for 6hrs once a fuller "4/5 signals, Pitcher Leaning" read is available.
  const cacheKey = `insight:${sport}:${venueLabel}:${todayIso()}:${Math.round(weather.windSpeedMph)}:${Math.round(weather.tempF)}:${score.windZone || score.windCompass || score.windTier || "na"}:${weather.isForecast ? "f" : "c"}:${umpire?.name || "noump"}:${runEnvironmentScore?.tier || "noenv"}`;
  return cached(env, cacheKey, 6 * 60 * 60, async () => {
    if (!env.AI) return { text: "AI narration unavailable (no AI binding configured).", cached: false };
    // Gave up trying to prompt-engineer the model into correctly pairing handedness with field
    // direction after THREE distinct failures caught live, each a different flavor of the same
    // underlying confusion: (1) said wind favored left field while calling it a left-handed edge
    // (backwards -- lefties pull to right field); (2) said a field was getting an absolute "boost"
    // when its actual carry was still negative, just less suppressed than the other pull side;
    // (3) named the correct field but then attributed it to the wrong handedness anyway. Each fix
    // closed the specific failure caught but the model found a new way to conflate "left-handed"
    // with "left field" every time. The deterministic handedness badge in the UI (rules-engine
    // output, never AI-generated) has been correct in all three cases -- so the AI's job now is
    // just to describe the wind/field-carry numbers, and it's told explicitly to leave handedness
    // out of its own prose entirely rather than trying to get it to state the pairing correctly.
    const handedNote =
      score.handedness && score.handedness.favors !== "neutral"
        ? ` Do not mention batter handedness (left-handed/right-handed/platoon/pull side) anywhere in your response — that's shown separately in the UI and you have gotten it backwards before. Describe only the field-direction wind effect using the numbers above.`
        : "";

    // Second real failure, caught by the user at Nationals Park: wind was only 2.7mph (below the
    // 3mph threshold where the rules engine even bothers modeling direction), so windZone was
    // "calm" and all three fieldCarry values were IDENTICAL -- yet the model still invented "balls
    // will carry farther to right field... slightly shorter to left field," a pure fabrication
    // with zero grounding in the numbers it was given. The old prompt's unconditional "be specific
    // about field direction" instruction was actively pushing it to invent one even when none
    // exists. Now that instruction only appears when there's a real directional signal; the calm
    // case gets an explicit ban on directional claims instead.
    //
    // Fourth real failure, same Fenway case as the handedness failures above: even after handedness
    // was removed from its job, the model STILL scrambled which of the three field-carry numbers
    // belonged to which field ("wind blowing in from left field" -- it was right field -- with the
    // left/center/right figures shuffled to the wrong labels too). This isn't a handedness-specific
    // confusion, it's this model being generally unreliable at restating 3+ paired values
    // correctly. Rather than prompt-engineer around that indefinitely, it's no longer asked to: the
    // per-field numbers are already shown correctly in the UI's LF/CF/RF chips (deterministic,
    // never wrong), so the model's only job is the single windZone phrase (one string, not three
    // numbers to pair up) and the overall carry/lean -- much smaller surface area to get wrong.
    const isCalm = score.windZone === "calm";
    // Fifth real failure, live-caught during this audit at Nationals Park: even with an explicit
    // "blowing TOWARD the SSW, not where it's coming from" instruction in the prompt, the model's
    // own free-text sentence still said "...from the southwest" -- flatly backwards (SSW is where
    // the wind was headed; it was blowing FROM the north). Explaining the FROM/TOWARD distinction
    // to the model and trusting it to hold that distinction while composing a fresh sentence didn't
    // work, same class of failure as the field/handedness scrambling above. windZone ("blowing in
    // from left field" / "blowing out toward right field") already states direction unambiguously
    // in plain English with the correct preposition baked in by deterministic code -- so the raw
    // compass letter is no longer given to the model to rephrase at all. It's still shown in the UI
    // stat chips directly from score.windCompass, just never passed through the AI's own wording.
    // Sixth real failure, live-caught by the user at PNC Park: windZone can name ANY of the three
    // fields (whichever the wind is hitting hardest), but this line used to decide REDUCTION vs.
    // INCREASE off score.carryFt -- which is always the CENTER-field number (fieldCarry.center),
    // not the carry for the field windZone actually names. "Blowing in from left field" with a
    // positive center carry (e.g. wind mostly hurting LF while helping CF/RF a little less) told
    // the model "this is an INCREASE," which it then dutifully wrote as "adding distance to left
    // field" -- backwards, since fieldCarry.left was actually negative. windZone's own wording
    // ("out toward" vs. "in from") already unambiguously encodes the correct sign for whichever
    // field it names, so derive the framing from that phrase instead of a different field's number.
    const windIsOut = score.windZone.startsWith("blowing out toward");
    const mlbWindLine = isCalm
      ? `Wind is negligible today — under 3mph, or not meaningfully directional — so carry is the same in every direction: ${score.carryFt}ft vs. a neutral day, from temperature/humidity alone. Do NOT say balls carry farther to any particular field or mention a wind direction advantage — there isn't one today.`
      : `Wind is ${score.windZone} at ${weather.windSpeedMph}mph — this is a ${windIsOut ? "an INCREASE in carry (wind is adding distance, 'adding' or 'boosting' carry toward that field is accurate)" : "REDUCTION in carry (wind is suppressing distance, use words like 'reducing' or 'cutting down' carry toward that field, not just 'carry to' that field, which reads as a gain)"}. Overall estimated carry vs. a neutral day, at the park's center-field bearing: ${score.carryFt}ft -- this may have a different sign than the wind effect on the field named above, since it's a different location in the park; do not treat them as the same number. Use the exact phrase "${score.windZone}" verbatim when describing wind direction — do NOT invent your own compass direction, cardinal letters, or a "from the [direction]" phrasing; the phrase given already states direction correctly. Also do NOT state specific distance numbers for individual fields (left/center/right) — those are already shown separately in the UI and you have gotten them scrambled before. Talk about the wind direction and overall carry only.`;
    // Once fetchWeather started returning a point-forecast for games meaningfully in the future
    // instead of always "right now" (see DECISIONS.md), the model's own wording still defaulted to
    // "current conditions" unprompted -- accurate numbers, misleading framing, since a forecast for
    // 7 hours from now isn't what's happening outside right now. Telling it explicitly which framing
    // to use fixed it in testing; left unprompted it reliably guessed "current."
    const conditionsLabel = weather.isForecast ? "the forecast for game time" : "current conditions";

    // Park factor (Statcast, real, season-aggregate, independent of today's weather): a small,
    // clearly-scoped addition, same "one number, one clear instruction" shape as mlbWindLine above
    // rather than something that invites the model to restate or explain the sub-factors.
    //
    // Seventh real failure, caught in this feature's own first end-to-end test: handed the model a
    // signed percentage (e.g. -3.5), it dropped the minus sign and said "3.5% extra... natural
    // fly-ball advantage" -- exactly backwards, same class of failure as windIsOut above (six
    // prior, documented failures) of this model mishandling a signed number's direction. Fixed the
    // same way: resolve the direction in code and hand it a pre-labeled phrase, not a raw signed
    // number to interpret itself.
    const parkFactorNote =
      sport === "mlb" && parkFactor
        ? ` This park's ${parkFactor.year} Statcast park factor is ${parkFactor.totalPct > 0 ? "hitter-friendly" : parkFactor.totalPct < 0 ? "pitcher-friendly" : "neutral"} for fly-ball distance — ${Math.abs(parkFactor.totalPct)}% ${parkFactor.totalPct >= 0 ? "more" : "less"} distance than a league-average park this season, independent of today's specific weather. Mention this once, briefly, as separate season-long context — do not blend it into the wind/carry numbers above as if it were part of today's forecast, and describe it only in these words (more/less distance) — do not restate it as a raw signed percentage.`
        : "";

    // Umpire tendencies (UmpScorecards): NOT given to the model at all, in either form (season
    // accuracy/consistency, or the real career hitter/pitcher lean from fetchUmpireCareerLean).
    //
    // Three straight failures on this one feature, back to back, each closing the exact gap the
    // last one's instruction opened: (1) told to describe accuracy/consistency, it invented a
    // strikeout-rate claim those numbers don't support; (2) told to also state a real pre-written
    // career-lean sentence but not explain it, it appended "batters are likely to see more balls
    // and fewer strikes" right after; (3) told to insert that sentence "with nothing added before
    // or after it within the same sentence," it obeyed the letter of that instruction and inserted
    // the sentence intact -- then added a NEW sentence with the same fabricated zone-size claim
    // anyway. That's nine total documented failures of this model editorializing beyond what a
    // number supports, across every different way this file has tried to phrase a restriction. No
    // further wording fix was worth trying: the umpire fact is now built as a plain string in code
    // (see below, appended after the AI call) and the model is never told about the umpire at all,
    // for either accuracy/consistency or career lean -- there is nothing left for it to embellish
    // because it doesn't see the data in the first place. Same end state as how the LF/CF/RF field
    // numbers were already handled (shown correctly in the UI, no longer described by the model).
    const prompt =
      sport === "mlb"
        ? `You are a concise baseball weather analyst. Venue: ${venueLabel}. These are ${conditionsLabel}: ${weather.tempF}F, ${weather.humidityPct}% humidity. ${mlbWindLine} Overall lean: ${score.scoringLean}.${handedNote}${parkFactorNote} In 2-3 sentences, explain in plain language what this means for hitters and scoring today. Describe these as ${conditionsLabel}, not as something else. No disclaimers, no hedging filler.`
        : `You are a concise NFL weather analyst. Venue: ${venueLabel}. These are ${conditionsLabel}: ${weather.tempF}F, wind at ${weather.windSpeedMph}mph, precip chance ${weather.precipProbPct}%. Rules-engine read: wind tier ${score.windTier}, passing impact "${score.passingImpact}", field-goal range impact "${score.fgRangeImpact}". Do NOT state a compass direction or cardinal letter for the wind — none is reliably known, so only describe speed/tier and its effect. Describe these as ${conditionsLabel}, not as something else. In 2-3 sentences, explain what this means for the passing game and kicking today. No disclaimers, no hedging filler.`;
    // Deterministic umpire sentence(s), built in code and appended after whatever the model wrote --
    // see the comment above for why this isn't in the prompt. career.lean is only ever "hitter",
    // "pitcher", "neutral", or missing/"insufficient data" (see fetchUmpireCareerLean), so this
    // covers every case without a fallback branch that could silently say nothing wrong but useless.
    function umpireSentence() {
      if (sport !== "mlb" || !umpire) return "";
      let s = ` Home plate umpire ${umpire.name} has a ${umpire.accuracyPct}% ball/strike accuracy and ${umpire.consistencyPct} consistency rating this season (${umpire.games} games).`;
      const c = umpire.career;
      if (c && c.lean === "hitter") {
        s += ` Career games have netted +${c.perGameBatterImpact} runs per game toward batters over ${c.games} games since ${c.sinceYear}.`;
      } else if (c && c.lean === "pitcher") {
        s += ` Career games have netted ${c.perGameBatterImpact} runs per game toward batters (i.e. in pitchers' favor) over ${c.games} games since ${c.sinceYear}.`;
      } else if (c && c.lean === "neutral") {
        s += ` Career record is close to neutral between hitters and pitchers over ${c.games} games since ${c.sinceYear}.`;
      }
      return s;
    }
    // Run Environment Score (see computeRunEnvironmentScore in rules-engine.js): same treatment as
    // umpireSentence above, for the same reason -- not given to the model at all, appended as a
    // plain string after the AI call returns. This composite is explicitly a COMBINATION of
    // several already-hidden-from-the-model facts (umpire lean, park factor's raw sign) that this
    // file has nine documented failures embellishing individually; there's no reason to expect
    // handing the model a sixth, MORE abstract number ("composite score -1.05") would go better.
    function runEnvironmentSentence() {
      if (sport !== "mlb" || !runEnvironmentScore) return "";
      const tierPhrase = {
        "Strong Hitter Environment": "a strong hitter-friendly environment overall",
        "Hitter Leaning": "a hitter-leaning environment overall",
        Neutral: "a roughly neutral environment overall",
        "Pitcher Leaning": "a pitcher-leaning environment overall",
        "Strong Pitcher Environment": "a strong pitcher-friendly environment overall",
      }[runEnvironmentScore.tier];
      if (!tierPhrase) return "";
      return ` Combining today's weather, this park's season factor, umpire tendency, and starter/lineup HR rates (${runEnvironmentScore.inputsUsed.length}/5 signals available today), this profiles as ${tierPhrase}.`;
    }
    try {
      const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      const aiText = result.response?.trim() || "No insight generated.";
      return { text: aiText + umpireSentence() + runEnvironmentSentence(), cached: false };
    } catch (err) {
      return { text: `AI narration failed: ${err.message}`, cached: false };
    }
  });
}

// ---- Router ----

async function handleGame(env, sport, params) {
  const venueKey = params.get("venueKey");
  const preview = params.get("preview") === "1";
  const startTimeUtc = params.get("startTimeUtc");
  const gameId = params.get("gameId");
  const stadiums = sport === "mlb" ? MLB_STADIUMS : NFL_STADIUMS;
  const venue = stadiums[venueKey];
  if (!venue) return json({ error: `Unknown venueKey "${venueKey}" for sport ${sport}` }, 400);

  const weather = await fetchWeather(env, venue.lat, venue.lon, startTimeUtc);

  // Real roof status (see fetchGameRoofStatus): only fetched for the non-preview detail view of a
  // retractable-roof MLB venue with a known gameId -- same "not worth it for cards nobody's opened"
  // reasoning already applied to the AI call and the umpire lookup below. scoreMlbGame falls back to
  // its long-standing "assume closed" default when this is null, so preview mode (and NFL, and
  // fixed-dome/always-open venues) is completely unaffected by this addition.
  let roofStatus = null;
  if (sport === "mlb" && !preview && gameId && venue.roofType === "retractable") {
    try {
      roofStatus = await fetchGameRoofStatus(env, gameId);
    } catch (err) {
      roofStatus = null;
    }
  }

  const score = sport === "mlb" ? scoreMlbGame(weather, venue, roofStatus) : scoreNflGame(weather, venue);

  // Preview mode (used by the front-page quick-look grid, one call per game on the slate) skips
  // the AI narration call entirely -- no point spending Workers AI neurons on insights for games
  // nobody's opened yet. The rules-engine score above is pure JS, so it's free either way. Same
  // reasoning extends to park factors and umpire tendencies here -- both real, but not worth
  // fetching nine times over for cards nobody's opened.
  if (preview) return json({ sport, venue, weather, score, insight: null, parkFactor: null, umpire: null, runEnvironmentScore: null });

  // Both of these are wrapped individually so a scrape hiccup on either external site degrades to
  // "no data today" for that one field, not a broken game page -- neither is load-bearing for the
  // weather/score the rest of this response already delivers.
  let parkFactor = null;
  if (sport === "mlb") {
    try {
      const factors = await fetchParkFactors(env);
      parkFactor = factors.byVenueKey[venueKey] || null;
    } catch (err) {
      parkFactor = null;
    }
  }

  let umpire = null;
  if (sport === "mlb" && gameId) {
    try {
      const schedule = await fetchMlbSchedule(env);
      const game = schedule.games.find((g) => g.gameId === gameId);
      if (game?.hpUmpire) {
        const stats = await fetchUmpireStats(env);
        const umpStats = stats.byName[game.hpUmpire];
        if (umpStats) umpire = { name: game.hpUmpire, ...umpStats };
        // Separate try/catch: the career-lean fetch hits a different endpoint (and, for an umpire
        // not yet cached, a much bigger one -- a full career game log) than the season stats above,
        // so a failure here shouldn't wipe out the season accuracy/consistency that already
        // succeeded. Only attempted when the umpire is otherwise known (umpire !== null).
        if (umpire) {
          try {
            umpire.career = await fetchUmpireCareerLean(env, game.hpUmpire);
          } catch (err) {
            umpire.career = null;
          }
        }
      }
    } catch (err) {
      umpire = null;
    }
  }

  // Run Environment Score (see rules-engine.js): wrapped the same way as park factor/umpire above
  // -- a failure anywhere in this chain (either starter's stats, either team's split, the league
  // aggregate) degrades to "no score today" rather than breaking the rest of the response, since
  // carryFt/parkFactor/umpire already delivered above are each independently useful without it.
  //
  // NOT YET surfaced in the UI or handed to the AI narration -- this stage only computes and
  // returns the raw score/tier so it can be checked against real games before either of those.
  let runEnvironmentScore = null;
  if (sport === "mlb" && gameId) {
    try {
      const schedule = await fetchMlbSchedule(env);
      const game = schedule.games.find((g) => g.gameId === gameId);
      if (game) {
        const leagueRates = await fetchLeagueHrRate(env);

        const [homePitcher, awayPitcher] = await Promise.all(
          [game.homeProbablePitcher, game.awayProbablePitcher].map(async (p) => {
            if (!p) return null;
            try {
              return await fetchPitcherHrTendency(env, p.id);
            } catch (err) {
              return null;
            }
          })
        );

        const qualifyingHr9Deltas = [homePitcher, awayPitcher]
          .filter((p) => p && p.qualifies && p.hr9 != null && leagueRates.pitcherHr9League != null)
          .map((p) => p.hr9 - leagueRates.pitcherHr9League);
        const pitcherHr9Delta = qualifyingHr9Deltas.length
          ? qualifyingHr9Deltas.reduce((a, b) => a + b, 0) / qualifyingHr9Deltas.length
          : null;

        // Each lineup's HR rate vs the OPPOSING starter's throwing hand (home lineup faces the away
        // starter, and vice versa), compared to the league-average rate for that same hand.
        const teamHrDeltas = [];
        if (awayPitcher?.throwsHand && game.homeTeamId) {
          const split = leagueRates.hittingByTeamId[game.homeTeamId]?.[awayPitcher.throwsHand === "L" ? "vsL" : "vsR"];
          const leagueAvg = leagueRates.hittingLeagueByHand[awayPitcher.throwsHand];
          if (split?.hrRate != null && leagueAvg != null) teamHrDeltas.push(split.hrRate - leagueAvg);
        }
        if (homePitcher?.throwsHand && game.awayTeamId) {
          const split = leagueRates.hittingByTeamId[game.awayTeamId]?.[homePitcher.throwsHand === "L" ? "vsL" : "vsR"];
          const leagueAvg = leagueRates.hittingLeagueByHand[homePitcher.throwsHand];
          if (split?.hrRate != null && leagueAvg != null) teamHrDeltas.push(split.hrRate - leagueAvg);
        }
        const teamHrRateDelta = teamHrDeltas.length ? teamHrDeltas.reduce((a, b) => a + b, 0) / teamHrDeltas.length : null;

        // Only a real, large-enough career sample counts as a signal here -- "insufficient data"
        // (see fetchUmpireCareerLean/MIN_CAREER_GAMES) means perGameBatterImpact is noise, not a lean.
        const umpireLeanRunsPerGame = umpire?.career && umpire.career.lean !== "insufficient data" ? umpire.career.perGameBatterImpact : null;

        runEnvironmentScore = computeRunEnvironmentScore({
          carryFt: score.carryFt,
          parkFactorPct: parkFactor?.totalPct ?? null,
          umpireLeanRunsPerGame,
          pitcherHr9Delta,
          teamHrRateDelta,
        });
      }
    } catch (err) {
      runEnvironmentScore = null;
    }
  }

  const insight = await narrate(env, sport, score, weather, venue, parkFactor, umpire, runEnvironmentScore);
  return json({ sport, venue, weather, score, insight: insight.text, parkFactor, umpire, runEnvironmentScore });
}

async function handleAlmanac(env, sport, params) {
  if (sport !== "mlb") return json({ error: "Historical almanac is MLB-only — no free historical box-score API for NFL" }, 400);
  const venueKey = params.get("venueKey");
  const startTimeUtc = params.get("startTimeUtc");
  const venue = MLB_STADIUMS[venueKey];
  if (!venue) return json({ error: `Unknown venueKey "${venueKey}" for sport mlb` }, 400);

  const weather = await fetchWeather(env, venue.lat, venue.lon, startTimeUtc);
  const aggregate = await getAlmanacMatch(env, venueKey, venue, weather);
  return json({ aggregate });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/api/schedule") {
        const sport = url.searchParams.get("sport");
        if (sport === "mlb") return json(await fetchMlbSchedule(env));
        if (sport === "nfl") {
          return json({ error: "NFL schedule is fetched client-side (ESPN blocks Worker IPs) — see index.html and DECISIONS.md" }, 400);
        }
        return json({ error: "sport must be mlb or nfl" }, 400);
      }

      if (url.pathname === "/api/game") {
        const sport = url.searchParams.get("sport");
        if (sport !== "mlb" && sport !== "nfl") return json({ error: "sport must be mlb or nfl" }, 400);
        return await handleGame(env, sport, url.searchParams);
      }

      if (url.pathname === "/api/almanac") {
        return await handleAlmanac(env, url.searchParams.get("sport"), url.searchParams);
      }

      return json({ error: "Not found. Try /api/schedule?sport=mlb or /api/game?sport=mlb&venueKey=COL" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
