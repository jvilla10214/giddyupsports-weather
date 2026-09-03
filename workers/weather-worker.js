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
import { scoreMlbGame, scoreNflGame, windCompassOrVariable } from "./rules-engine.js";

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
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${date}&endDate=${date}&hydrate=venue`;
    const res = await fetch(url, { headers: { "User-Agent": "GiddyUpSports-Weather/1.0" } });
    if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
    const data = await res.json();
    const games = [];
    for (const d of data.dates || []) {
      for (const g of d.games || []) {
        const venueKey = MLB_TEAM_ID_TO_KEY[g.teams?.home?.team?.id] || null;
        games.push({
          gameId: String(g.gamePk),
          startTimeUtc: g.gameDate,
          away: g.teams?.away?.team?.name,
          home: g.teams?.home?.team?.name,
          awayAbbr: MLB_TEAM_ID_TO_KEY[g.teams?.away?.team?.id] || null,
          homeAbbr: venueKey,
          venue: g.venue?.name,
          venueKey,
          status: g.status?.detailedState,
        });
      }
    }
    return { sport: "mlb", date, games };
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

async function narrate(env, sport, score, weather, venue) {
  const venueLabel = venue.venue;

  // Indoor games (fixed dome, or a retractable roof assumed closed) always land on the same
  // conclusion -- climate-controlled, wind/precip irrelevant to play -- so there's nothing for
  // an AI call to add. Most are air-conditioned too, which is exactly why even the temperature
  // reading isn't meaningful once you're indoors. Skip the model entirely and say so directly;
  // this also means no more "gentle breeze inside a fixed dome" hallucinations (confirmed live
  // on Tropicana Field before this fix), since there's no generation step left to hallucinate in.
  if (score.roofClosed) {
    const certainty = venue.roofType === "dome" ? "a fixed dome" : "a retractable roof (assumed closed today)";
    return {
      text: `${venueLabel} is played under ${certainty}. Conditions are climate-controlled, so wind, temperature, and precipitation have no bearing on today's game.`,
      cached: false,
    };
  }

  // Direction has to be part of the key, not just speed/temp -- a swing from "blowing out toward
  // right field" to "blowing in from right field" can happen with speed/temp barely moving (the
  // Nationals Park case that motivated the 10min weather-cache TTL below), which would otherwise
  // leave a stale, direction-wrong insight served for up to 6hrs. windCompass already folds
  // "variable" (sub-3mph, no dominant direction) into one bucket, so this doesn't over-fragment
  // the cache on direction noise at low speed. The forecast/current flag also has to be in the key
  // -- the model is told to describe one or the other (see conditionsLabel below), and speed/temp
  // could round the same across that transition (forecast checked hours out vs. current once the
  // game's about to start) without busting the key on their own.
  const cacheKey = `insight:${sport}:${venueLabel}:${todayIso()}:${Math.round(weather.windSpeedMph)}:${Math.round(weather.tempF)}:${score.windCompass || score.windTier || "na"}:${weather.isForecast ? "f" : "c"}`;
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
    const mlbWindLine = isCalm
      ? `Wind is negligible today — under 3mph, or not meaningfully directional — so carry is the same in every direction: ${score.carryFt}ft vs. a neutral day, from temperature/humidity alone. Do NOT say balls carry farther to any particular field or mention a wind direction advantage — there isn't one today.`
      : `Wind is ${score.windZone} at ${weather.windSpeedMph}mph — this is a ${score.carryFt < 0 ? "REDUCTION in carry (wind is suppressing distance, use words like 'reducing' or 'cutting down' carry toward that field, not just 'carry to' that field, which reads as a gain)" : "an INCREASE in carry (wind is adding distance, 'adding' or 'boosting' carry toward that field is accurate)"}. Overall estimated carry vs. a neutral day: ${score.carryFt}ft. Use the exact phrase "${score.windZone}" verbatim when describing wind direction — do NOT invent your own compass direction, cardinal letters, or a "from the [direction]" phrasing; the phrase given already states direction correctly. Also do NOT state specific distance numbers for individual fields (left/center/right) — those are already shown separately in the UI and you have gotten them scrambled before. Talk about the wind direction and overall carry only.`;
    // Once fetchWeather started returning a point-forecast for games meaningfully in the future
    // instead of always "right now" (see DECISIONS.md), the model's own wording still defaulted to
    // "current conditions" unprompted -- accurate numbers, misleading framing, since a forecast for
    // 7 hours from now isn't what's happening outside right now. Telling it explicitly which framing
    // to use fixed it in testing; left unprompted it reliably guessed "current."
    const conditionsLabel = weather.isForecast ? "the forecast for game time" : "current conditions";
    const prompt =
      sport === "mlb"
        ? `You are a concise baseball weather analyst. Venue: ${venueLabel}. These are ${conditionsLabel}: ${weather.tempF}F, ${weather.humidityPct}% humidity. ${mlbWindLine} Overall lean: ${score.scoringLean}.${handedNote} In 2-3 sentences, explain in plain language what this means for hitters and scoring today. Describe these as ${conditionsLabel}, not as something else. No disclaimers, no hedging filler.`
        : `You are a concise NFL weather analyst. Venue: ${venueLabel}. These are ${conditionsLabel}: ${weather.tempF}F, wind at ${weather.windSpeedMph}mph, precip chance ${weather.precipProbPct}%. Rules-engine read: wind tier ${score.windTier}, passing impact "${score.passingImpact}", field-goal range impact "${score.fgRangeImpact}". Do NOT state a compass direction or cardinal letter for the wind — none is reliably known, so only describe speed/tier and its effect. Describe these as ${conditionsLabel}, not as something else. In 2-3 sentences, explain what this means for the passing game and kicking today. No disclaimers, no hedging filler.`;
    try {
      const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      return { text: result.response?.trim() || "No insight generated.", cached: false };
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
  const stadiums = sport === "mlb" ? MLB_STADIUMS : NFL_STADIUMS;
  const venue = stadiums[venueKey];
  if (!venue) return json({ error: `Unknown venueKey "${venueKey}" for sport ${sport}` }, 400);

  const weather = await fetchWeather(env, venue.lat, venue.lon, startTimeUtc);
  const score = sport === "mlb" ? scoreMlbGame(weather, venue) : scoreNflGame(weather, venue);

  // Preview mode (used by the front-page quick-look grid, one call per game on the slate) skips
  // the AI narration call entirely -- no point spending Workers AI neurons on insights for games
  // nobody's opened yet. The rules-engine score above is pure JS, so it's free either way.
  if (preview) return json({ sport, venue, weather, score, insight: null });

  const insight = await narrate(env, sport, score, weather, venue);
  return json({ sport, venue, weather, score, insight: insight.text });
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
