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
 *
 * NFL schedule is NOT fetched here — ESPN's scoreboard API blocks Cloudflare Worker IPs but
 * allows browser CORS requests, so the frontend fetches it client-side instead. See DECISIONS.md.
 *
 * Every external call is cached in KV so a burst of page loads doesn't hammer free/unofficial
 * upstream APIs (MLB Stats API, Open-Meteo, Workers AI's free tier).
 */

import { MLB_STADIUMS, NFL_STADIUMS, MLB_TEAM_ID_TO_KEY } from "../data/stadiums.js";
import { scoreMlbGame, scoreNflGame } from "./rules-engine.js";

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

      return json({ error: "Not found. Try /api/schedule?sport=mlb or /api/game?sport=mlb&venueKey=COL" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
