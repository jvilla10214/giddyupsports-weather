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
 *   /api/game?sport=mlb&venueKey=...                        -> weather + score + AI insight
 *   /api/game?sport=mlb&venueKey=...&preview=1               -> same, minus the AI call (cheap,
 *                                                               used to populate every card in
 *                                                               the quick-look grid at once)
 *   /api/game?sport=nfl&venueKey=...[&preview=1]             -> same, NFL
 *   /api/almanac?sport=mlb&venueKey=...                      -> closest-matching historical
 *                                                               weather day at this venue (last
 *                                                               15 years) plus that day's actual
 *                                                               home-game result. MLB only — no
 *                                                               free historical box-score API for
 *                                                               NFL, see DECISIONS.md.
 *
 * NFL schedule is NOT fetched here — ESPN's scoreboard API blocks Cloudflare Worker IPs but
 * allows browser CORS requests, so the frontend fetches it client-side instead. See DECISIONS.md.
 *
 * Every external call is cached in KV so a burst of page loads doesn't hammer free/unofficial
 * upstream APIs (MLB Stats API, Open-Meteo, Workers AI's free tier).
 */

import { MLB_STADIUMS, NFL_STADIUMS, MLB_TEAM_ID_TO_KEY, MLB_KEY_TO_TEAM_ID } from "../data/stadiums.js";
import { scoreMlbGame, scoreNflGame, degToCompass16 } from "./rules-engine.js";

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

async function fetchWeather(env, lat, lon) {
  const hourKey = new Date().toISOString().slice(0, 13);
  return cached(env, `weather:${lat},${lon}:${hourKey}`, 30 * 60, async () => {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,precipitation_probability,wind_speed_10m,wind_direction_10m` +
      `&temperature_unit=fahrenheit&wind_speed_unit=mph`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    const c = data.current || {};
    return {
      tempF: c.temperature_2m,
      humidityPct: c.relative_humidity_2m,
      precipProbPct: c.precipitation_probability,
      windSpeedMph: c.wind_speed_10m,
      windFromDeg: c.wind_direction_10m,
      observedAt: c.time,
    };
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

async function findAlmanacMatch(env, venue, teamId, todayWeather) {
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

  let best = null;
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
      const distance = weatherDistance(dayWeather, todayWeather);
      if (!best || distance < best.distance) best = { date: game.date, weather: dayWeather, distance, game };
    }
  }
  if (!best) return null;

  const box = await fetchBoxscoreHomeRuns(env, best.game.gamePk);
  return {
    date: best.date,
    weather: {
      tempF: Math.round(best.weather.tempF),
      windSpeedMph: Math.round(best.weather.windSpeedMph),
      windCompass: degToCompass16(best.weather.windFromDeg),
    },
    game: {
      away: best.game.away,
      home: best.game.home,
      awayScore: best.game.awayScore,
      homeScore: best.game.homeScore,
      awayHomeRuns: box?.away ?? null,
      homeHomeRuns: box?.home ?? null,
    },
  };
}

async function getAlmanacMatch(env, venueKey, venue, todayWeather) {
  const teamId = MLB_KEY_TO_TEAM_ID[venueKey];
  if (!teamId) return null;
  return cached(env, `almanac:${venueKey}:${todayIso()}`, 60 * 60 * 24, () => findAlmanacMatch(env, venue, teamId, todayWeather));
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

  const cacheKey = `insight:${sport}:${venueLabel}:${todayIso()}:${Math.round(weather.windSpeedMph)}:${Math.round(weather.tempF)}`;
  return cached(env, cacheKey, 6 * 60 * 60, async () => {
    if (!env.AI) return { text: "AI narration unavailable (no AI binding configured).", cached: false };
    const handedNote =
      score.handedness && score.handedness.favors !== "neutral"
        ? ` Platoon note: right field is carrying ${Math.abs(score.handedness.deltaFt)}ft more than left field, which favors ${score.handedness.favors}-handed pull hitters tonight — mention this briefly.`
        : "";
    const prompt =
      sport === "mlb"
        ? `You are a concise baseball weather analyst. Venue: ${venueLabel}. Conditions: ${weather.tempF}F, ${weather.humidityPct}% humidity, wind ${weather.windSpeedMph}mph ${score.windCompass}. Rules-engine read: estimated carry ${score.carryFt}ft vs. a neutral day (left field ${score.fieldCarry.left}ft, center ${score.fieldCarry.center}ft, right field ${score.fieldCarry.right}ft), wind is ${score.windZone}, overall lean: ${score.scoringLean}.${handedNote} In 2-3 sentences, explain what this means for hitters and scoring today. Be specific about field direction. No disclaimers, no hedging filler.`
        : `You are a concise NFL weather analyst. Venue: ${venueLabel}. Conditions: ${weather.tempF}F, wind ${weather.windSpeedMph}mph ${score.windCompass || ""}, precip chance ${weather.precipProbPct}%. Rules-engine read: wind tier ${score.windTier}, passing impact "${score.passingImpact}", field-goal range impact "${score.fgRangeImpact}". In 2-3 sentences, explain what this means for the passing game and kicking today. No disclaimers, no hedging filler.`;
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
  const stadiums = sport === "mlb" ? MLB_STADIUMS : NFL_STADIUMS;
  const venue = stadiums[venueKey];
  if (!venue) return json({ error: `Unknown venueKey "${venueKey}" for sport ${sport}` }, 400);

  const weather = await fetchWeather(env, venue.lat, venue.lon);
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
  const venue = MLB_STADIUMS[venueKey];
  if (!venue) return json({ error: `Unknown venueKey "${venueKey}" for sport mlb` }, 400);

  const weather = await fetchWeather(env, venue.lat, venue.lon);
  const match = await getAlmanacMatch(env, venueKey, venue, weather);
  return json({ match });
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
