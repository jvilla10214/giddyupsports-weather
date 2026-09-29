# GiddyUpSports Weather

Cloudflare Worker (`workers/weather-worker.js` + `workers/rules-engine.js`, deployed with
`npx wrangler deploy`) plus a single-page frontend (`index.html`). Tests: `npm test`.
Why past choices were made lives in `DECISIONS.md` (newest first). Read it before changing a model.

## Where we left off (2026-09-29)

When the user says "pick up what we were last working on", this is it.

**Branch:** `claude/wizardly-gates-47ymb3`. Still not merged to `main` — check it out first. Don't
merge or open a PR without asking; this doc gets updated in place as work continues on it.

**What was done (2026-09-25):** rebuilt the MLB Total Runs call (Suggested Bet "Likely/Lean
Over/Under").
- Bug reported: games showed "carry-suppressing conditions" next to "Likely Over". The old model
  compared a league-average total (~8.84) to the market line, so every low line called Over.
- User requirement: the live market line is never adjusted. Conditions *and everything else*
  decide whether the game goes over or under that live line.
- `computeTotalRunsProjection` (rules-engine.js) projects total runs from both offenses (runs/game),
  both starters (ERA regressed by innings), both staffs (ERA, bullpen proxy) and the park/weather/
  umpire slice of the Run Environment Score. `computeTotalRunsCall` compares that to the live line
  as posted. UI "why" line: "We project X runs vs the Y line — reasons".
- Team offense and staff ERA come from `fetchLeagueHrRate` in weather-worker.js (cache key `v2`).

**Status (2026-09-29): deployed and verified against real live data.**
- Worker deployed via `npx wrangler deploy` (account confirmed `jvillamta@gmail.com` first, per
  DECISIONS.md's account-mapping entry). Both `WEATHER_KV` and `AI` bindings came back intact.
- Confirmed live against MLB Stats API directly: `hitting` splits carry real `runs`/`gamesPlayed`
  for all 30 teams; `pitching` splits carry real `earnedRuns`/`inningsPitched` (cross-checked one
  team's derived staff ERA against the API's own reported `era` field — matched exactly).
- Pulled all 4 of today's real MLB games through the live `/api/game` endpoint and ran the actual
  `mlbTotalWhyText` function (extracted and executed directly, not hand-traced) against each real
  response. All 4: projection landed in the sane 6-11 range (6.92-8.5), the call and the "why"
  reasons agreed in every case (verified programmatically, not just by eye), the market line came
  back exactly as `fetchTotalLines` posted it (never adjusted -- confirmed by reading
  `computeTotalRunsCall`'s return, which passes `marketLine` through unmodified).
- Didn't get a real live example of "team data missing" (season's basically over, every active team
  has ~full-season stats) -- covered by the existing unit test instead
  (`rules-engine.test.js`: "Missing team offense should yield no projection"), plus static
  confirmation that `handleGame` never assigns `totalRunsCall` when `computeTotalRunsProjection`
  returns null.
- No bugs found. No code changes were needed this pass.

**Next steps:**
1. Backtest the call against historical MLB closing lines. This needs an odds data source first;
   the project has none. The constants (`STARTER_SHARE`, `STARTER_REGRESS_IP`,
   `OFFENSE_REGRESS_GAMES`, `TOTAL_CALL_MARGIN`) are still untuned defaults until then.
2. The frontend (`index.html`) on this branch has NOT been deployed anywhere public yet (GitHub
   Pages serves `main`, and this branch isn't merged) -- verification above went through the
   Worker's own `/api/game` endpoint and running the real frontend function in isolation, not a
   live page render. If a visual check is ever wanted, serve this branch's `index.html` locally
   from a hostname other than `localhost`/`127.0.0.1` (see `WORKER_BASE` in index.html) so it talks
   to the real deployed Worker instead of a local `wrangler dev` that isn't running.
