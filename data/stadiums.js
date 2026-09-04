// Stadium reference data for GiddyUpSports Weather Command Center.
//
// lat/lon and roofType are well-documented public facts, verified against current (2026) roof
// inventories. altitudeFt matters for the MLB air-density model (thin air at elevation = more
// carry).
//
// cfBearingDeg (the compass bearing from home plate through the pitcher's mound toward center
// field, 0=N/90=E/180=S/270=W) was recalibrated 2026-09-03 against Clem's Baseball's per-park
// "CF Orientation" column (andrewclem.com/Baseball/Stadium_statistics.html, sourced from Lowry's
// "Green Cathedrals", Ritter, and the ESPN Sports Almanac) -- a real, individually-researched
// figure for every park, not a guess. This replaced an earlier version of this file that admitted
// in its own comment it had defaulted most parks to a generic 67.5 (ENE, "what MLB Rule 1.04
// recommends") rather than measuring each one; a live user report of an inconsistent-seeming wind
// read at PNC Park (real cfBearingDeg is 112.5/ESE, not the old default's 315, nor this session's
// own first attempt at fixing it to 180 from a pixel-measured aerial photo -- confirmed wrong by
// this same source's own stated rule that "no MLB stadium is oriented toward any direction between
// 150 and 315 degrees") led to backtracking the generic-default approach entirely in favor of this
// real per-park dataset. Values snapped to the nearest 22.5deg compass point, matching Clem's own
// letter-grade precision (N/NNE/NE/ENE/E/ESE/SE/SSE, etc). Two exceptions: DET is flagged "(?)" as
// uncertain by Clem's own source; ATH's temporary AAA facility (Sutter Health Park) predates any
// MLB tenancy and isn't in this database at all, so its old default (45) is kept as a best-effort
// placeholder with no real source behind it.
//
// windSensitivity (added 2026-09-04): a per-park multiplier on the rules engine's wind-carry term
// (see windCarryAt in rules-engine.js), 1.0 = league-average. Real MLB parks vary a lot in how much
// wind actually moves the ball beyond what geometry alone predicts -- PNC Park is famously wind-
// sheltered by its enclosed bowl design, Coors Field and Oracle Park are famously not -- and the
// rules engine had no way to represent that until now. Derived from Baseball Savant's own park-
// factors data (baseballsavant.mlb.com/leaderboard/statcast-park-factors), specifically the
// `environment_extra_distance` sub-factor -- the part of a park's seasonal distance factor NOT
// explained by temperature, elevation, or roof (i.e. humidity/wind/etc, already excludes the
// separately-modeled altitude bonus so this doesn't double-count that). Averaged the absolute value
// of that figure across 5 real seasons (2021-2025) per park, then scaled every park relative to the
// league mean, clamped to [0.5, 1.8] so one noisy season can't produce an extreme multiplier. Two
// real relocations caught and corrected for during this derivation, both because `main_team_id` on
// Savant's leaderboard is stable across a franchise's home-park move within the window: the
// Athletics played 2021-2024 at the since-abandoned Oakland Coliseum before relocating to Sutter
// Health Park in 2025 (only the 2025 datapoint is the park this file actually models, too small a
// sample to trust -- defaulted to a neutral 1.0 instead of using it); the Rays played their 2025
// season at the outdoor George M. Steinbrenner Field after Tropicana Field (the dome this file
// models TB as) was hurricane-damaged, so that one season was excluded from TB's 4-season average.
// Caveat worth remembering: this measures average SEASONAL bias magnitude, not true per-game
// volatility -- a park where wind swings hard in both directions from game to game (blows out half
// the time, in the other half) could show a deceptively moderate number here even if any single
// game there is genuinely more wind-affected than at a calmer park, since the two directions
// partially cancel within a season before the absolute value is taken. Full derivation and the
// backtest re-check after applying it are in DECISIONS.md.
export const MLB_STADIUMS = {
  ARI: { team: "Diamondbacks", venue: "Chase Field", city: "Phoenix, AZ", lat: 33.4455, lon: -112.0667, roofType: "retractable", altitudeFt: 1086, cfBearingDeg: 0, windSensitivity: 1.14 },
  ATL: { team: "Braves", venue: "Truist Park", city: "Atlanta, GA", lat: 33.8908, lon: -84.4678, roofType: "open", altitudeFt: 1050, cfBearingDeg: 157.5, windSensitivity: 1.26 },
  BAL: { team: "Orioles", venue: "Oriole Park at Camden Yards", city: "Baltimore, MD", lat: 39.2839, lon: -76.6217, roofType: "open", altitudeFt: 20, cfBearingDeg: 22.5, windSensitivity: 0.5 },
  BOS: { team: "Red Sox", venue: "Fenway Park", city: "Boston, MA", lat: 42.3467, lon: -71.0972, roofType: "open", altitudeFt: 20, cfBearingDeg: 45, windSensitivity: 0.5 },
  CHC: { team: "Cubs", venue: "Wrigley Field", city: "Chicago, IL", lat: 41.9484, lon: -87.6553, roofType: "open", altitudeFt: 600, cfBearingDeg: 45, windSensitivity: 1.46 },
  CWS: { team: "White Sox", venue: "Rate Field", city: "Chicago, IL", lat: 41.8299, lon: -87.6338, roofType: "open", altitudeFt: 600, cfBearingDeg: 112.5, windSensitivity: 1.15 },
  CIN: { team: "Reds", venue: "Great American Ball Park", city: "Cincinnati, OH", lat: 39.0979, lon: -84.5066, roofType: "open", altitudeFt: 490, cfBearingDeg: 112.5, windSensitivity: 0.5 },
  CLE: { team: "Guardians", venue: "Progressive Field", city: "Cleveland, OH", lat: 41.4962, lon: -81.6852, roofType: "open", altitudeFt: 660, cfBearingDeg: 0, windSensitivity: 1.4 },
  COL: { team: "Rockies", venue: "Coors Field", city: "Denver, CO", lat: 39.7559, lon: -104.9942, roofType: "open", altitudeFt: 5280, cfBearingDeg: 0, windSensitivity: 1.8 },
  DET: { team: "Tigers", venue: "Comerica Park", city: "Detroit, MI", lat: 42.339, lon: -83.0485, roofType: "open", altitudeFt: 585, cfBearingDeg: 157.5, windSensitivity: 1.8 },
  HOU: { team: "Astros", venue: "Daikin Park", city: "Houston, TX", lat: 29.7573, lon: -95.3555, roofType: "retractable", altitudeFt: 40, cfBearingDeg: 67.5, windSensitivity: 1.29 },
  KC: { team: "Royals", venue: "Kauffman Stadium", city: "Kansas City, MO", lat: 39.0517, lon: -94.4803, roofType: "open", altitudeFt: 750, cfBearingDeg: 45, windSensitivity: 0.68 },
  LAA: { team: "Angels", venue: "Angel Stadium", city: "Anaheim, CA", lat: 33.8003, lon: -117.8827, roofType: "open", altitudeFt: 150, cfBearingDeg: 45, windSensitivity: 0.83 },
  LAD: { team: "Dodgers", venue: "Dodger Stadium", city: "Los Angeles, CA", lat: 34.0739, lon: -118.24, roofType: "open", altitudeFt: 340, cfBearingDeg: 22.5, windSensitivity: 0.88 },
  MIA: { team: "Marlins", venue: "loanDepot park", city: "Miami, FL", lat: 25.7781, lon: -80.2196, roofType: "retractable", altitudeFt: 10, cfBearingDeg: 112.5, windSensitivity: 0.53 },
  MIL: { team: "Brewers", venue: "American Family Field", city: "Milwaukee, WI", lat: 43.028, lon: -87.9712, roofType: "retractable", altitudeFt: 635, cfBearingDeg: 135, windSensitivity: 0.5 },
  MIN: { team: "Twins", venue: "Target Field", city: "Minneapolis, MN", lat: 44.9817, lon: -93.2777, roofType: "open", altitudeFt: 815, cfBearingDeg: 90, windSensitivity: 0.7 },
  NYM: { team: "Mets", venue: "Citi Field", city: "Flushing, NY", lat: 40.7571, lon: -73.8458, roofType: "open", altitudeFt: 20, cfBearingDeg: 22.5, windSensitivity: 0.68 },
  NYY: { team: "Yankees", venue: "Yankee Stadium", city: "Bronx, NY", lat: 40.8296, lon: -73.9262, roofType: "open", altitudeFt: 55, cfBearingDeg: 67.5, windSensitivity: 1.22 },
  ATH: { team: "Athletics", venue: "Sutter Health Park", city: "West Sacramento, CA", lat: 38.5805, lon: -121.5133, roofType: "open", altitudeFt: 25, cfBearingDeg: 45, windSensitivity: 1.0 },
  PHI: { team: "Phillies", venue: "Citizens Bank Park", city: "Philadelphia, PA", lat: 39.9061, lon: -75.1665, roofType: "open", altitudeFt: 20, cfBearingDeg: 22.5, windSensitivity: 1.29 },
  PIT: { team: "Pirates", venue: "PNC Park", city: "Pittsburgh, PA", lat: 40.4469, lon: -80.0057, roofType: "open", altitudeFt: 730, cfBearingDeg: 112.5, windSensitivity: 0.71 },
  SD: { team: "Padres", venue: "Petco Park", city: "San Diego, CA", lat: 32.7076, lon: -117.1569, roofType: "open", altitudeFt: 20, cfBearingDeg: 0, windSensitivity: 0.5 },
  SF: { team: "Giants", venue: "Oracle Park", city: "San Francisco, CA", lat: 37.7786, lon: -122.3893, roofType: "open", altitudeFt: 10, cfBearingDeg: 112.5, windSensitivity: 1.8 },
  SEA: { team: "Mariners", venue: "T-Mobile Park", city: "Seattle, WA", lat: 47.5914, lon: -122.3325, roofType: "retractable", altitudeFt: 15, cfBearingDeg: 45, windSensitivity: 0.56 },
  STL: { team: "Cardinals", venue: "Busch Stadium", city: "St. Louis, MO", lat: 38.6226, lon: -90.1928, roofType: "open", altitudeFt: 465, cfBearingDeg: 45, windSensitivity: 1.12 },
  TB: { team: "Rays", venue: "Tropicana Field", city: "St. Petersburg, FL", lat: 27.7683, lon: -82.6534, roofType: "dome", altitudeFt: 10, cfBearingDeg: 45, windSensitivity: 1.48 },
  TEX: { team: "Rangers", venue: "Globe Life Field", city: "Arlington, TX", lat: 32.7473, lon: -97.0817, roofType: "retractable", altitudeFt: 550, cfBearingDeg: 67.5, windSensitivity: 1.8 },
  TOR: { team: "Blue Jays", venue: "Rogers Centre", city: "Toronto, ON", lat: 43.6414, lon: -79.3894, roofType: "retractable", altitudeFt: 300, cfBearingDeg: 337.5, windSensitivity: 0.5 },
  WSH: { team: "Nationals", venue: "Nationals Park", city: "Washington, DC", lat: 38.873, lon: -77.0074, roofType: "open", altitudeFt: 20, cfBearingDeg: 22.5, windSensitivity: 0.5 },
};

// MLB Stats API identifies teams by a stable numeric ID, not abbreviation — this maps that ID to
// our MLB_STADIUMS key so the schedule fetch can attach the right venue/coords to each game.
export const MLB_TEAM_ID_TO_KEY = {
  108: "LAA", 109: "ARI", 110: "BAL", 111: "BOS", 112: "CHC", 113: "CIN", 114: "CLE", 115: "COL",
  116: "DET", 117: "HOU", 118: "KC", 119: "LAD", 120: "WSH", 121: "NYM", 133: "ATH", 134: "PIT",
  135: "SD", 136: "SEA", 137: "SF", 138: "STL", 139: "TB", 140: "TEX", 141: "TOR", 142: "MIN",
  143: "PHI", 144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL",
};

// Reverse of the above, for looking up a team's MLB Stats API ID from our venue key (used by the
// historical-almanac feature to query that team's past home schedule).
export const MLB_KEY_TO_TEAM_ID = Object.fromEntries(
  Object.entries(MLB_TEAM_ID_TO_KEY).map(([id, key]) => [key, Number(id)])
);

// NFL: roofType drives whether wind/precip effects apply at all (a closed dome/retractable roof
// zeroes them out). lat/lon center the aerial map. No CF-bearing equivalent needed for football.
export const NFL_STADIUMS = {
  ARI: { team: "Cardinals", venue: "State Farm Stadium", city: "Glendale, AZ", lat: 33.5276, lon: -112.2626, roofType: "retractable" },
  ATL: { team: "Falcons", venue: "Mercedes-Benz Stadium", city: "Atlanta, GA", lat: 33.7554, lon: -84.4008, roofType: "retractable" },
  BAL: { team: "Ravens", venue: "M&T Bank Stadium", city: "Baltimore, MD", lat: 39.278, lon: -76.6227, roofType: "open" },
  BUF: { team: "Bills", venue: "Highmark Stadium", city: "Orchard Park, NY", lat: 42.7738, lon: -78.787, roofType: "open" },
  CAR: { team: "Panthers", venue: "Bank of America Stadium", city: "Charlotte, NC", lat: 35.2258, lon: -80.8528, roofType: "open" },
  CHI: { team: "Bears", venue: "Soldier Field", city: "Chicago, IL", lat: 41.8623, lon: -87.6167, roofType: "open" },
  CIN: { team: "Bengals", venue: "Paycor Stadium", city: "Cincinnati, OH", lat: 39.0955, lon: -84.516, roofType: "open" },
  CLE: { team: "Browns", venue: "Huntington Bank Field", city: "Cleveland, OH", lat: 41.5061, lon: -81.6995, roofType: "open" },
  DAL: { team: "Cowboys", venue: "AT&T Stadium", city: "Arlington, TX", lat: 32.7473, lon: -97.0945, roofType: "retractable" },
  DEN: { team: "Broncos", venue: "Empower Field at Mile High", city: "Denver, CO", lat: 39.7439, lon: -105.02, roofType: "open" },
  DET: { team: "Lions", venue: "Ford Field", city: "Detroit, MI", lat: 42.34, lon: -83.0456, roofType: "dome" },
  GB: { team: "Packers", venue: "Lambeau Field", city: "Green Bay, WI", lat: 44.5013, lon: -88.0622, roofType: "open" },
  HOU: { team: "Texans", venue: "NRG Stadium", city: "Houston, TX", lat: 29.6847, lon: -95.4107, roofType: "retractable" },
  IND: { team: "Colts", venue: "Lucas Oil Stadium", city: "Indianapolis, IN", lat: 39.7601, lon: -86.1639, roofType: "retractable" },
  JAX: { team: "Jaguars", venue: "EverBank Stadium", city: "Jacksonville, FL", lat: 30.3239, lon: -81.6373, roofType: "open" },
  KC: { team: "Chiefs", venue: "GEHA Field at Arrowhead Stadium", city: "Kansas City, MO", lat: 39.0489, lon: -94.4839, roofType: "open" },
  LAC: { team: "Chargers", venue: "SoFi Stadium", city: "Inglewood, CA", lat: 33.9535, lon: -118.3392, roofType: "dome" },
  LAR: { team: "Rams", venue: "SoFi Stadium", city: "Inglewood, CA", lat: 33.9535, lon: -118.3392, roofType: "dome" },
  LV: { team: "Raiders", venue: "Allegiant Stadium", city: "Las Vegas, NV", lat: 36.0909, lon: -115.1833, roofType: "dome" },
  MIA: { team: "Dolphins", venue: "Hard Rock Stadium", city: "Miami Gardens, FL", lat: 25.958, lon: -80.2389, roofType: "open" },
  MIN: { team: "Vikings", venue: "U.S. Bank Stadium", city: "Minneapolis, MN", lat: 44.9735, lon: -93.2575, roofType: "dome" },
  NE: { team: "Patriots", venue: "Gillette Stadium", city: "Foxborough, MA", lat: 42.0909, lon: -71.2643, roofType: "open" },
  NO: { team: "Saints", venue: "Caesars Superdome", city: "New Orleans, LA", lat: 29.9511, lon: -90.0812, roofType: "dome" },
  NYG: { team: "Giants", venue: "MetLife Stadium", city: "East Rutherford, NJ", lat: 40.8135, lon: -74.0745, roofType: "open" },
  NYJ: { team: "Jets", venue: "MetLife Stadium", city: "East Rutherford, NJ", lat: 40.8135, lon: -74.0745, roofType: "open" },
  PHI: { team: "Eagles", venue: "Lincoln Financial Field", city: "Philadelphia, PA", lat: 39.9008, lon: -75.1675, roofType: "open" },
  PIT: { team: "Steelers", venue: "Acrisure Stadium", city: "Pittsburgh, PA", lat: 40.4468, lon: -80.0158, roofType: "open" },
  SEA: { team: "Seahawks", venue: "Lumen Field", city: "Seattle, WA", lat: 47.5952, lon: -122.3316, roofType: "open" },
  SF: { team: "49ers", venue: "Levi's Stadium", city: "Santa Clara, CA", lat: 37.403, lon: -121.9698, roofType: "open" },
  TB: { team: "Buccaneers", venue: "Raymond James Stadium", city: "Tampa, FL", lat: 27.9759, lon: -82.5033, roofType: "open" },
  TEN: { team: "Titans", venue: "Nissan Stadium", city: "Nashville, TN", lat: 36.1665, lon: -86.7713, roofType: "open" },
  WSH: { team: "Commanders", venue: "Commanders Field", city: "Landover, MD", lat: 38.9077, lon: -76.8645, roofType: "open" },
};
