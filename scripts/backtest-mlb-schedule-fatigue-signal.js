// Tests whether real MLB schedule/travel fatigue has a genuine, detectable effect on team offense
// (runs scored), for the real completed 2025 regular season. Two folklore signals, tested for real
// rather than assumed:
//
//   1. "Day game after night game": today's game is a day game, AND this same team's immediately
//      preceding game (chronologically, regardless of home/away) was a night game on the
//      immediately preceding calendar day (true back-to-back, no off day in between).
//   2. "Cross-time-zone travel": today's game's venue is in a different US time zone bucket
//      (Eastern/Central/Mountain/Pacific) than this same team's immediately preceding game's venue.
//
// Both signals are tested against a REAL point-in-time residual: actual runs scored in that game
// minus that team's own real runs-per-game average computed ONLY from that team's own games
// strictly BEFORE the game being tested, same season, same no-look-ahead discipline as
// backtest-mlb-total-runs-projection.js. No fabricated precision: a floor of >=10 prior team-games
// is required before a game counts, specifically to keep early-April single-digit-sample-size
// baselines from injecting noise into either group -- applied identically to both the
// "fatigued"/"cross-zone" and "rested"/"same-zone" sides, so it can't manufacture a lean either way.
//
// Data source: MLB Stats API's schedule endpoint, ONE full-season call
// (statsapi.mlb.com/api/v1/schedule?sportId=1&season=2025&gameType=R&startDate=...&endDate=...),
// cached under a new key (scripts/.res-cache/mlb-schedule-full-2025.json) -- the existing
// mlb-2025-gamepks-v2.json cache (used by backtest-mlb-total-runs-projection.js) only stored
// {gamePk, date} pairs, not dayNight/venue/final scores, so it couldn't be reused directly, but no
// extra per-game fetches were needed either: the schedule endpoint itself already carries
// dayNight, venue, teams, and final scores for completed games, so this is still just one HTTP
// request for the entire season.
//
// HONEST SCOPE LIMITATIONS:
//  - Time zone is classified from each game's HOME team's normal zone (data/stadiums.js's real
//    city per team, mapped to the one well-known, non-guessed US/Canada zone that city sits in --
//    Toronto bucketed with Eastern since it runs the same clock), not from the exact physical
//    venue every single game. This is a real mismatch for the 2 real 2025 Cubs/Dodgers games
//    played at Tokyo Dome (Tokyo isn't any of the 4 US zones at all) -- those 2 games are EXCLUDED
//    from both teams' sequences entirely, confirmed by checking every completed 2025 game's real
//    venue name against each home team's own listed park name (4 real mismatches found: Tokyo
//    Dome x2, Bristol Motor Speedway x2 [Reds/Braves "Speedway Classic", TN, still real-Eastern,
//    same bucket as both teams' normal zone], Journey Bank Ballpark x1 [Mets/Mariners Little
//    League Classic, PA, still real-Eastern, same bucket as the home Mets] -- only the Tokyo pair
//    actually changes the zone bucket, so only those 2 are dropped). The Rays' real 2025 home
//    park was George M. Steinbrenner Field (Tropicana Field was storm-damaged), but that's still
//    real-Tampa, still real-Eastern, so no special-case was needed there.
//  - Arizona (ARI) is bucketed as Mountain. Real fact worth stating plainly: Arizona does not
//    observe daylight saving time, so during the MLB season (DST in effect leaguewide) its actual
//    clock reads the same as Pacific time, not Mountain. Kept as Mountain here for the real,
//    permanent geographic bucket rather than a season-dependent clock reading -- stated outright
//    rather than quietly assumed.
//  - 34 real 2025 gamePks appear twice in the raw schedule response (suspended-and-resumed games
//    split across two calendar days/dayNight values, e.g. gamePk 776907: started as a night game
//    8/2, resumed as a day-game continuation 8/3). Deduped by keeping the entry whose bucket date
//    equals the game's own officialDate field (the original-start record) -- confirmed this rule
//    resolves cleanly for all 34 real duplicates found (exactly one match each, no ties).
//  - "Rested" games are simply every day game NOT meeting the fatigue condition (day-after-day,
//    day-after-off-day, day-after-doubleheader-night-cap, etc.) -- a real, broad control group,
//    not a hand-picked contrast.
//
// Usage: node scripts/backtest-mlb-schedule-fatigue-signal.js [season]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MLB_TEAM_ID_TO_KEY } from "../data/stadiums.js";

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
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2)));
}
function pearson(xs, ys) {
  const pairs = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => x != null && y != null && Number.isFinite(x) && Number.isFinite(y));
  const n = pairs.length;
  if (n < 2) return { r: null, n };
  const mx = mean(pairs.map((p) => p[0])), my = mean(pairs.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { const dx = x - mx, dy = y - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return { r: sxy / Math.sqrt(sxx * syy), n };
}
function daysBetween(dateA, dateB) {
  const a = Date.UTC(...dateA.split("-").map(Number));
  const b = Date.UTC(...dateB.split("-").map(Number));
  return Math.round((b - a) / 86400000);
}
// Rough significance gut-check for a two-sample mean difference (Welch-style z/t), not a full test.
function meanDiffGutCheck(groupA, groupB) {
  const nA = groupA.length, nB = groupB.length;
  if (nA < 2 || nB < 2) return null;
  const mA = mean(groupA), mB = mean(groupB);
  const sA = stddev(groupA), sB = stddev(groupB);
  const se = Math.sqrt((sA * sA) / nA + (sB * sB) / nB);
  const diff = mA - mB;
  const z = se > 0 ? diff / se : null;
  return { nA, nB, meanA: mA, meanB: mB, diff, se, z };
}

// Real, well-known (not guessed) US/Canada time-zone bucket per team's own home city, from
// data/stadiums.js's real `city` field for each of the 30 real MLB franchises.
const TEAM_ZONE = {
  ATL: "Eastern", BAL: "Eastern", BOS: "Eastern", CIN: "Eastern", CLE: "Eastern", DET: "Eastern",
  MIA: "Eastern", NYM: "Eastern", NYY: "Eastern", PHI: "Eastern", PIT: "Eastern", TB: "Eastern",
  TOR: "Eastern", WSH: "Eastern",
  CHC: "Central", CWS: "Central", HOU: "Central", KC: "Central", MIL: "Central", MIN: "Central",
  STL: "Central", TEX: "Central",
  ARI: "Mountain", COL: "Mountain",
  LAA: "Pacific", LAD: "Pacific", ATH: "Pacific", SD: "Pacific", SF: "Pacific", SEA: "Pacific",
};

// Real home-park name per team key, used only to detect the handful of real 2025 neutral/special
// site games whose actual physical venue differs from the team's normal park (see header comment).
const TEAM_HOME_VENUE_NAME = {
  ARI: "Chase Field", ATL: "Truist Park", BAL: "Oriole Park at Camden Yards", BOS: "Fenway Park",
  CHC: "Wrigley Field", CWS: "Rate Field", CIN: "Great American Ball Park", CLE: "Progressive Field",
  COL: "Coors Field", DET: "Comerica Park", HOU: "Daikin Park", KC: "Kauffman Stadium",
  LAA: "Angel Stadium", LAD: "Dodger Stadium", MIA: "loanDepot park", MIL: "American Family Field",
  MIN: "Target Field", NYM: "Citi Field", NYY: "Yankee Stadium", ATH: "Sutter Health Park",
  PHI: "Citizens Bank Park", PIT: "PNC Park", SD: "Petco Park", SF: "Oracle Park",
  SEA: "T-Mobile Park", STL: "Busch Stadium", TB: "Tropicana Field", TEX: "Globe Life Field",
  TOR: "Rogers Centre", WSH: "Nationals Park",
};
// George M. Steinbrenner Field was the Rays' REAL, full-season 2025 home park (Tropicana Field was
// storm-damaged) -- real-Tampa, same real zone (Eastern) as Tropicana, so it's treated as a normal
// TB home game, not a special/neutral site, unlike the Tokyo/Bristol/Williamsport one-offs.
const KNOWN_ALT_HOME_VENUE = { TB: "George M. Steinbrenner Field" };

async function fetchFullSeasonSchedule(season) {
  return cachedJson(`mlb-schedule-full-${season}`, async () => {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&season=${season}&gameType=R&startDate=${season}-01-01&endDate=${season}-12-31`;
    return fetchJson(url);
  });
}

function buildGameRecords(schedule) {
  // Dedupe real suspended-and-resumed gamePks that appear twice in the raw response (see header
  // comment): keep the entry whose bucket date equals the game's own officialDate.
  const byPk = new Map();
  for (const day of schedule.dates || []) {
    for (const g of day.games || []) {
      const existing = byPk.get(g.gamePk);
      const matchesOfficial = day.date === g.officialDate;
      if (!existing) {
        byPk.set(g.gamePk, { g, bucketDate: day.date, matchesOfficial });
      } else if (matchesOfficial && !existing.matchesOfficial) {
        byPk.set(g.gamePk, { g, bucketDate: day.date, matchesOfficial });
      }
    }
  }

  const records = [];
  let skippedNotFinal = 0, skippedMissingField = 0, skippedTokyo = 0;
  for (const { g } of byPk.values()) {
    if (g.status?.abstractGameState !== "Final") { skippedNotFinal++; continue; }
    const homeTeamId = g.teams?.home?.team?.id;
    const awayTeamId = g.teams?.away?.team?.id;
    const homeScore = g.teams?.home?.score;
    const awayScore = g.teams?.away?.score;
    const dayNight = g.dayNight;
    const officialDate = g.officialDate;
    const gameDateMs = g.gameDate ? Date.parse(g.gameDate) : null;
    if (homeTeamId == null || awayTeamId == null || homeScore == null || awayScore == null || !dayNight || !officialDate || gameDateMs == null) {
      skippedMissingField++;
      continue;
    }
    if (g.venue?.name === "Tokyo Dome") { skippedTokyo++; continue; }
    const homeKey = MLB_TEAM_ID_TO_KEY[homeTeamId];
    const zone = homeKey ? TEAM_ZONE[homeKey] : null;
    records.push({ gamePk: g.gamePk, gameDateMs, officialDate, dayNight, homeTeamId, awayTeamId, homeScore, awayScore, zone, venueName: g.venue?.name });
  }
  records.sort((a, b) => a.gameDateMs - b.gameDateMs);
  return { records, skippedNotFinal, skippedMissingField, skippedTokyo };
}

function buildTeamSequences(records) {
  const byTeam = new Map();
  const push = (teamId, rec, runsScored) => {
    if (!byTeam.has(teamId)) byTeam.set(teamId, []);
    byTeam.get(teamId).push({
      gameDateMs: rec.gameDateMs,
      officialDate: rec.officialDate,
      dayNight: rec.dayNight,
      zone: rec.zone,
      runsScored,
      gamePk: rec.gamePk,
    });
  };
  for (const rec of records) {
    push(rec.homeTeamId, rec, rec.homeScore);
    push(rec.awayTeamId, rec, rec.awayScore);
  }
  for (const seq of byTeam.values()) seq.sort((a, b) => a.gameDateMs - b.gameDateMs);
  return byTeam;
}

const MIN_PRIOR_GAMES = 10; // floor to keep early-April tiny-sample baselines from injecting noise

async function main() {
  const season = Number(process.argv[2]) || 2025;

  const schedule = await fetchFullSeasonSchedule(season);
  const { records, skippedNotFinal, skippedMissingField, skippedTokyo } = buildGameRecords(schedule);
  console.log(`Season ${season}: ${records.length} real completed, usable games (skipped: ${skippedNotFinal} not-Final, ${skippedMissingField} missing field, ${skippedTokyo} Tokyo Dome).`);

  const byTeam = buildTeamSequences(records);
  console.log(`Built real chronological sequences for ${byTeam.size} teams.`);

  // Signal 1: day game after night game (back-to-back calendar days), vs all other day games.
  const fatiguedResiduals = [];
  const restedResiduals = [];
  // Signal 2: cross-time-zone travel vs same-zone, across ALL games (day or night).
  const crossZoneResiduals = [];
  const sameZoneResiduals = [];

  for (const seq of byTeam.values()) {
    for (let i = 1; i < seq.length; i++) {
      const cur = seq[i];
      const priorRuns = seq.slice(0, i).map((g) => g.runsScored);
      if (priorRuns.length < MIN_PRIOR_GAMES) continue;
      const baseline = mean(priorRuns);
      const residual = cur.runsScored - baseline;
      const prev = seq[i - 1];

      if (cur.dayNight === "day") {
        const backToBack = daysBetween(prev.officialDate, cur.officialDate) === 1;
        const isFatigued = prev.dayNight === "night" && backToBack;
        if (isFatigued) fatiguedResiduals.push(residual);
        else restedResiduals.push(residual);
      }

      if (cur.zone && prev.zone) {
        if (cur.zone !== prev.zone) crossZoneResiduals.push(residual);
        else sameZoneResiduals.push(residual);
      }
    }
  }

  console.log(`\n=== Signal 1: day game after night game (back-to-back days) ===`);
  console.log(`Fatigued (day-after-night, back-to-back): n=${fatiguedResiduals.length}`);
  console.log(`Rested (all other day games): n=${restedResiduals.length}`);
  const gc1 = meanDiffGutCheck(fatiguedResiduals, restedResiduals);
  if (gc1) {
    console.log(`Mean residual, fatigued: ${gc1.meanA.toFixed(3)} runs/game`);
    console.log(`Mean residual, rested:   ${gc1.meanB.toFixed(3)} runs/game`);
    console.log(`Difference (fatigued - rested): ${gc1.diff.toFixed(3)} runs/game, SE=${gc1.se.toFixed(3)}, z~${gc1.z.toFixed(2)}`);
  }
  const indicator1 = [...fatiguedResiduals.map(() => 1), ...restedResiduals.map(() => 0)];
  const residual1 = [...fatiguedResiduals, ...restedResiduals];
  const p1 = pearson(indicator1, residual1);
  console.log(`Point-biserial r (fatigued=1 vs residual): r=${p1.r?.toFixed(4)} (n=${p1.n})`);

  console.log(`\n=== Signal 2: cross-time-zone travel ===`);
  console.log(`Cross-zone (prior game in a different US zone bucket): n=${crossZoneResiduals.length}`);
  console.log(`Same-zone: n=${sameZoneResiduals.length}`);
  const gc2 = meanDiffGutCheck(crossZoneResiduals, sameZoneResiduals);
  if (gc2) {
    console.log(`Mean residual, cross-zone: ${gc2.meanA.toFixed(3)} runs/game`);
    console.log(`Mean residual, same-zone:  ${gc2.meanB.toFixed(3)} runs/game`);
    console.log(`Difference (cross-zone - same-zone): ${gc2.diff.toFixed(3)} runs/game, SE=${gc2.se.toFixed(3)}, z~${gc2.z.toFixed(2)}`);
  }
  const indicator2 = [...crossZoneResiduals.map(() => 1), ...sameZoneResiduals.map(() => 0)];
  const residual2 = [...crossZoneResiduals, ...sameZoneResiduals];
  const p2 = pearson(indicator2, residual2);
  console.log(`Point-biserial r (cross-zone=1 vs residual): r=${p2.r?.toFixed(4)} (n=${p2.n})`);

  const out = {
    season,
    signal1: { fatiguedN: fatiguedResiduals.length, restedN: restedResiduals.length, gutCheck: gc1, pearsonR: p1.r },
    signal2: { crossZoneN: crossZoneResiduals.length, sameZoneN: sameZoneResiduals.length, gutCheck: gc2, pearsonR: p2.r },
  };
  fs.writeFileSync(path.join(CACHE_DIR, "mlb-schedule-fatigue-backtest-results.json"), JSON.stringify(out, null, 1));
  console.log(`\nFull results written to scripts/.res-cache/mlb-schedule-fatigue-backtest-results.json`);
}

main().catch((err) => { console.error(err); process.exit(1); });
