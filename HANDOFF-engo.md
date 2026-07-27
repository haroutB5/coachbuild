<!-- merged into HANDOFF.md 2026-07-27 13:24:07Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engo, audit fix round, 2026-07-27

Model: Sonnet 5 (claude-sonnet-5).

Fable 5's adversarial cold-start audit reviewed the overlay and cleared the compliance shape, the champion-level highlight decision, and confirmed `resolveNextSkill`/`pointsSpent` are imported by nothing under `overwolf/`. It found 8 real defects. All 8 fixed, in my files only (`ingame/**`, `js/skillOrderData.js`, `vendor/**`), plus the two API routes the coordinator explicitly lifted the no-edit restriction on for this round. `background/**`, `desktop/**`, `js/gameState.js`, `js/owWindows.js`, `js/liveClientHttp.js`, `manifest.json` untouched.

**1. (P1) Network failure reported as "champion not recognized."** `getChampionList()` now returns `{status:"ok", list} | {status:"unavailable"}` instead of collapsing every failure to `null`. `resolveChampionId` threads it through as its own `{status:"unavailable"}` result, distinct from `{status:"not-found"}`. `resolveOverlayData` surfaces a new `"unavailable"` phase. `ingame.js` routes it to the exact same `"Skill order unavailable."` string `fetchSkillOrder`'s `error` status already used — pulled both into a shared `MSG_UNAVAILABLE` constant so they can't drift apart.

**2. (P1) Retry cooldowns never triggered.** Added `retryDelayMs(data)` + `scheduleRetry(data)` in `ingame.js`: after every render, if the phase is `"unavailable"` or `"resolved"` with `skillOrder.status` `"error"`/`"no-data"`, arms a single `setTimeout(() => handleState(lastState), cooldown + 1000)`. Always clears the existing timer first (no stacking), and any phase that isn't one of those three falls through to `null` delay, which — combined with the always-clear — satisfies "clear on game exit and on successful resolve" without a separate code path. The three cooldown constants (`CHAMPION_LIST_RETRY_COOLDOWN_MS`, `ERROR_RETRY_COOLDOWN_MS`, `NO_DATA_RETRY_COOLDOWN_MS`) are now `export`ed from `skillOrderData.js` so `ingame.js` uses the SAME numbers the cache enforces, not a duplicated guess. `selfTest.mjs` pins their exact values — a renamed/missing export is a silent `undefined` on an ES import, not a thrown error, so this is the only thing that would have caught that regression class.

**3. (P2) Lane buttons destroyed on every GEP push.** `renderLaneBar()` now computes `signature = `${isInteractive}:${lane}`` and short-circuits (`return`) when unchanged since the last build, before touching `innerHTML`. Only rebuilds when interactive mode or the stored lane actually changed. Left the main grid's full-rebuild-every-render approach untouched, per the audit's explicit instruction — that one has no click-loss consequence and incrementalizing it would reintroduce the first-render/steady-state divergence I deliberately removed.

**4. (P2) Header showed Riot's internal name.** `resolveChampionId` now returns `{status:"ok", id, name}` — `name` is the matched `ChampionRef`'s own display name, not the raw/matching identifier used for lookup. `resolveOverlayData` carries it as `championDisplayName`. `renderResolved` renders `data.championDisplayName || data.championName`, so a genuine no-match fallback still shows SOMETHING rather than going blank. Verified end-to-end in `selfTest.mjs` with the Wukong/MonkeyKing case specifically (key and display name deliberately diverge).

**5. (P2) `!completed` was the wrong proxy for "16-18 unknown."** Footer now checks `order.length < TOTAL_LEVELS` directly instead of `!model.completed` — `completed:false` also covers `refusedBecause:"already-complete"` (source published all 18 itself), where the old code printed "Levels 16-18 not published" under a fully-marked 18-column grid. `buildGrid` was already correct (it always used `order.length`, never `completed`) — only the footer needed the fix.

**6. (P2) No in-flight dedup on `fetchSkillOrder`.** Added `skillOrderLoading` Map mirroring `championListLoading`'s existing pattern — a concurrent second call for the same `(championId, roleId)` while a fetch is outstanding gets the SAME in-flight promise instead of issuing a duplicate request. `doFetchSkillOrder` extracted as the actual network+cache-write logic so `fetchSkillOrder` itself is just cache-check → dedup-check → dispatch.

**7. (P2) Dropped the vendored bundle.** Deleted `overwolf/vendor/` entirely (`skillEngine.js` + my own `_engineEntry.ts` barrel from the first round) and removed the `overwolf:bundle` script from `package.json`. `ingame.js` now has `const TOTAL_LEVELS = 18;` inlined with a comment naming `lib/skillOrderModel.ts` as the source of truth. Confirmed nothing else under `overwolf/` imported from `vendor/` (grepped after deleting — only remaining hit is the explanatory comment in `ingame.js` itself, not a live import).

**8. (CORS) Added `Access-Control-Allow-Origin: *`** to `app/api/champions/route.ts` (success + 500 paths) and `app/api/skill-order/route.ts` (payload, empty, and all three 400 paths — every response this route can produce). Did not touch either route's existing `Cache-Control` logic (gotcha (b) preserved exactly). Not deployed, so not live-verifiable yet — `curl -I` against prod confirms no CORS header present today, as expected pre-deploy.

**Wording nit (not mine to fix):** `desktop.html`'s "…to pick the right skill order" is the closest thing to advisory language in the tree. `desktop.html` is engy's file — flagging here per the coordinator's note rather than editing it. Suggested replacement if he wants it: "the matching skill order."

## Verification (all re-run after all 8 fixes)

```
node --check overwolf/js/skillOrderData.js   -> OK
node --check overwolf/ingame/ingame.js       -> OK
node --check overwolf/js/selfTest.mjs        -> OK

node overwolf/js/selfTest.mjs
  [CoachBuild overlay] champion list fetch failed: Error: GET /api/champions -> HTTP 500   (expected -- the "unavailable" test's own mocked failure)
  --- LIVE smoke test against https://coachbuild.vercel.app (real network) ---
  GET /api/champions -> resolved "Ahri" to id 103
  GET /api/skill-order?champ=103&role=2 -> status=ok
  48 passed, 0 failed        (was 38 before this round; 10 new assertions cover fixes #1, #2, #4, #6)

npm run typecheck   -> clean
npm run lint         -> clean (same 5 pre-existing <img> warnings, unrelated files)
npx vitest run       -> 1806 tests passed (unchanged)
```

No version bump, no CHANGELOG edit, no deploy, per the coordinator's instruction.
