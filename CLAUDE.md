# GiddyUpSports Weather

Cloudflare Worker (`workers/weather-worker.js` + `workers/rules-engine.js`, deployed with
`npx wrangler deploy`) plus a single-page frontend (`index.html`). Tests: `npm test`.
Why past choices were made lives in `DECISIONS.md` (newest first). Read it before changing a model.

## Where we left off (2026-09-25)

When the user says "pick up what we were last working on", this is it.

**Branch:** `claude/wizardly-gates-47ymb3`. Not merged to `main` yet, so check it out first.

**What was done:** rebuilt the MLB Total Runs call (Suggested Bet "Likely/Lean Over/Under").
- Bug reported: games showed "carry-suppressing conditions" next to "Likely Over". The old model
  compared a league-average total (~8.84) to the market line, so every low line called Over.
- User requirement: the live market line is never adjusted. Conditions *and everything else*
  decide whether the game goes over or under that live line.
- Now: `computeTotalRunsProjection` (rules-engine.js) projects total runs from both offenses
  (runs/game), both starters (ERA regressed by innings), both staffs (ERA, bullpen proxy) and the
  park/weather/umpire slice of the Run Environment Score. `computeTotalRunsCall` compares that to
  the live line as posted. UI "why" line: "We project X runs vs the Y line — reasons".
- Team offense and staff ERA come from `fetchLeagueHrRate` in weather-worker.js (cache key `v2`).

**Status:**
- Tests pass, but it's NOT deployed and NOT checked against live data. The cloud session couldn't
  reach statsapi.mlb.com or deploy to Cloudflare.
- The user was given the three changed files to add by hand. First confirm whether they already
  deployed them before redoing anything.

**Next steps:**
1. Deploy (`npx wrangler deploy`) and check a few real MLB games. Do the projections look sane
   (roughly 6-11 runs)? Do the call and the "why" line agree? Is there no call when team data is missing?
2. Confirm the MLB Stats API team fields used really exist live: hitting `runs`/`gamesPlayed`,
   pitching `earnedRuns`/`inningsPitched`.
3. Backtest the call against historical MLB closing lines. This needs an odds data source first;
   the project has none. The constants (`STARTER_SHARE`, `STARTER_REGRESS_IP`,
   `OFFENSE_REGRESS_GAMES`, `TOTAL_CALL_MARGIN`) are untuned defaults until then.
