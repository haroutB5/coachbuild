<!-- merged into HANDOFF.md 2026-07-27 14:21:11Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 (round 6) — the fallback fix from round 4/5 had its own real bug

Model: Sonnet 5 (claude-sonnet-5).

**The `role=5` catch held up** — the coordinator independently verified
`/api/skill-order?champ=42&role=5` returns `null` in production, confirming last
round's read of `lib/opgg.ts` was correct. But the REPLACEMENT (loop the five real
lanes in fixed TOP/JUNGLE/MID/BOT/SUPPORT order, return the first `ok`) was itself a
bug, caught with real production numbers: Corki's `sampleSize` is 235 at TOP vs.
**7150 at BOT** — the fixed-order loop stopped at TOP (first to answer "ok") and
presented it as the resolved lane for a champion played roughly 30x more often in
BOT. "First lane that had any data" was a fabricated claim dressed as a resolution
— the exact same hard-rule-4 category as the `role=5` mistake, just one layer
deeper.

### Fix — compare `sampleSize` across all five lanes, fetched in parallel

`js/skillOrderData.js`'s `resolveOverlayData`, Tier 3:

- **`Promise.all` over all five lanes**, not a sequential loop — five serial
  round-trips before first paint was flagged as a bad first-run experience; now all
  five fire concurrently.
- **Picks the `ok` result with the largest `model.sampleSize`.** Ties break
  deterministically: strict `>` (not `>=`) against candidates iterated in
  `LANE_TO_ROLE_ID`'s fixed order means the FIRST lane to reach a given sampleSize
  keeps its spot — never random, no separate tiebreak code path needed.
- **`no-data-any-lane` unchanged** — still fires when every lane comes back
  non-`ok`.
- **`laneSource: "auto-fallback"` kept distinct**, and the RENDERED WORDING changed
  from `"auto (tried in order)"` to **`"likely"`** (`renderer/ingame.js`'s
  `laneSourceNote`) — Tier 2 (`"auto"`) is Riot's own reported position, a fact;
  Tier 3 is this app's own inference from relative play rates, and the label must
  not present those with equal confidence. Still non-imperative, still just a
  footer note.
- **Cache coverage verified, not assumed**, per the explicit instruction to check
  rather than trust: `fetchSkillOrder`'s existing per-`(championId,roleId)` cache
  already treats `"ok"` as never-expiring (`cooldown: Infinity`), so calling all
  five lanes again on every later state push (e.g. every level-up) resolves from
  cache with zero new network calls — confirmed by an actual test asserting the
  fetch-call count does not increase on a second `resolveOverlayData` call for the
  same state, not inferred from reading the cache code.

### Verification — used the coordinator's own measured numbers, not synthetic ones

New test (`test_fallback_samplesize.mjs`, 10 assertions), mocking `fetch` but
exercising the REAL `resolveOverlayData`/`fetchSkillOrder` code paths:

- Corki's ACTUAL production sample sizes (TOP=235, JUNGLE=38, MID=1121, BOT=7150,
  SUPPORT=3) resolve to **BOT** — confirmed, not TOP.
- The chosen result carries the correct `sampleSize: 7150`.
- All 5 lane requests were genuinely CONCURRENT — measured max in-flight count of 5
  against an artificial 20ms delay per request (a sequential/await-in-loop
  implementation could never exceed 1 in-flight).
- A second call with the identical state made **zero** additional
  `/api/skill-order` calls (5 total, not 10) — the cache-coverage claim, verified.
- An exact tie (TOP=500, MID=500, everything else empty) resolved to **TOP** — the
  first candidate in fixed order, confirming the deterministic tiebreak.
- All-empty input still correctly produces `no-data-any-lane`.

All pre-existing suites (`gameState.js` CJS: 20 assertions, `mapPositionToLane`: 20
assertions) re-run and still pass — nothing else regressed. `node --check` clean on
both touched files. Relaunched the live Electron app once more (clean boot,
identical log output to prior rounds, no new errors) to confirm the app as a whole
still starts cleanly after this change.

### What remains unverified

Same list as round 4/5 — this fix touched only the fallback-lane SELECTION logic,
not anything that changes what's verifiable without a live game or a real desktop
taskbar. Everything requiring League itself (the live polling path, on-screen
appearance over the actual game, hotkey/tray behavior with League focused,
interactive-mode clicks) and the tray icon's visual appearance (still no taskbar in
this session's screenshots) remain exactly as unverified as reported last round.

### Files touched this round

`overlay-host/js/skillOrderData.js` (Tier 3 rewrite + header docs),
`overlay-host/renderer/ingame.js` (`laneSourceNote` wording only),
`overlay-host/README.md` (lane-resolution section, load/test steps, verification
section). Nothing else. No version bump, no `CHANGELOG.md` edit, no deploy.

## 2026-07-27 (round 4/5) — live-test bugs: lane deadlock + hotkey deadlock, then a lane-design correction mid-fix

Model: Sonnet 5 (claude-sonnet-5).

**Context:** the coordinator's first live in-game test confirmed the overlay
genuinely draws over League (the biggest unknown from round 3) but found two real,
compounding bugs. Mid-fix, the coordinator sent a correction retracting their own
earlier "lane isn't derivable from live data" claim (it was over-generalized from a
Practice Tool capture where `position: "NONE"` is the CORRECT answer, not evidence
the field is useless). I redesigned the lane fix around that correction before
finishing rather than shipping the originally-briefed version.

### BUG 1 — lane could never be set (dead end: "No lane selected")

Root cause was real: `localStorage["coachbuild.overwolf.lane"]` had no writer left
after the Overwolf desktop window was dropped in the pivot, AND even a successful
renderer write is unreliable on a `file://` origin across restarts. Per the fix
brief, lane ownership moved OUT of the renderer entirely:

- **New `lib/laneSettings.js`** (main process, CJS) — `loadLane`/`saveLane` against
  a JSON file under `app.getPath('userData')`. Missing/corrupt file both degrade to
  `null` ("Auto"), never throw.
- **`main.js`** now owns `currentLane` (loaded at startup, logged), exposes
  `setLane()`, and listens on IPC channel `coachbuild-set-lane`. `lane` rides as a
  field on the SAME `gameState` object pushed over `coachbuild-state` — one
  contract, not a second channel, per the brief.
- **`preload.js`** gained `window.coachbuildIPC.setLane(lane)`.
- **`renderer/ingame.js`**'s `selectLane()` no longer touches `localStorage` at
  all — optimistically updates `lastState.lane`, re-renders, and fires
  `coachbuildIPC.setLane(lane)`. Added a 6th "AUTO" lane-bar button (interactive
  mode) that clears the override.

**The role=5 dead end — caught before shipping it, not after.** The original fix
brief said to use `role=5` ("let the API pick") whenever no lane is chosen. I read
`lib/opgg.ts` before wiring that in, because it's the kind of claim worth checking
against the actual backend rather than trusting by reference — and it's verifiably
false for this endpoint: `opggPosition(5)` returns `null` (no op.gg lane
equivalent for "auto"), so `fetchSkillOrder(id, 5)` resolves to `null` unconditionally,
before any request. Wiring role=5 as specified would have replaced one dead end
("no lane selected," at least honestly labeled) with a strictly worse one (always
silently empty, indistinguishable from "no data for this champion"). Implemented
instead: a fixed-order fallback loop over the five real lanes, stopping at the
first one that actually returns data, labeled with the REAL lane that worked. This
deviation is documented in three places now: `js/skillOrderData.js`'s
`LANE_TO_ROLE_ID` header, its `resolveOverlayData` header, and here.

### CORRECTION mid-task — auto-detection is PRIMARY, not a last resort

The coordinator retracted their own "lane isn't derivable" claim: `position: "NONE"`
in the captured Practice Tool payload is correct for a custom game, not evidence
the field is broken. New three-tier resolution, implemented before finishing:

1. **Manual override** (tray/lane-bar) — wins outright when set.
2. **Auto-detected** — `lib/gameState.js`'s new `extractLocalPosition()` reads the
   local player's own `position` off the SAME `/liveclientdata/playerlist` fetch
   already used for champion resolution (no extra request). `js/skillOrderData.js`'s
   new `mapPositionToLane()` maps Riot's vocabulary (TOP/JUNGLE/**MIDDLE**/
   **BOTTOM**/**UTILITY**/NONE — note the spelling divergence from this app's own
   TOP/JUNGLE/MID/BOT/SUPPORT) case-insensitively, returning `null` for NONE or
   anything unrecognized, never throwing/guessing.
3. **Fallback loop** — only reached when neither of the above produced a lane.

The footer shows a quiet, honest source label once a champion resolves: `Mid ·
manual`, `Mid · auto`, or `Mid · auto (tried in order)`.

**Honesty requirement, implemented literally:** `main.js` logs the RAW `position`
string once per game (`positionLoggedThisGame` flag, reset on each game-enter), not
just the mapped result — "so the user's next real game becomes the experiment that
confirms it," per the correction. `lib/gameState.js`'s `extractLocalPosition` and
`js/skillOrderData.js`'s `mapPositionToLane` both have header comments stating
plainly that only `"NONE"` (Practice Tool) has been directly observed on this
machine; a populated value in a matchmade game is Riot's documented behavior, not
independently verified here. `README.md`'s "Lane resolution" section says the same,
and explicitly frames the fallback firing in Practice Tool as CORRECT, not a bug —
so the coordinator/user doesn't misread step 7 of the test checklist as a failure.

Compliance re-checked: `extractLocalPosition` reads only the LOCAL player's own
entry (same one already used for champion name) — nothing about any other player.
No companion dependency was added; the overlay stays fully standalone against the
local Live Client Data API, as instructed.

### BUG 2 — hotkeys inert while League has focus

Near-certain cause per the brief (Windows UIPI + League/Vanguard running elevated)
was not independently re-verified against a live game (can't — no game running in
this environment), but the fix was implemented in full per the brief's 3-step order:

1. **System tray — the primary fix.** `main.js` gained `Tray`/`Menu`/`nativeImage`
   usage: left-click toggles show/hide, right-click menu has Show/Hide, an
   Interactive-mode checkbox, a Lane-override submenu (radio items, Auto + 5 lanes,
   checked state reflects `currentLane`), and Quit. `rebuildTrayMenu()` is called
   after every state change that affects a menu item (`toggleOverlayVisibility`,
   `toggleInteractive`, `setLane`) so the menu never goes stale. No new npm
   dependency — `Tray`/`Menu`/`nativeImage` are core Electron.
   - **New `assets/tray-icon.png`** — a 16×16 solid CoachBuild-gold PNG with a navy
     1px border, hand-built via a raw PNG/zlib encoder script (no image tool
     available) since an invisible icon would defeat the entire point of a tray
     fix. Independently byte-verified: decompressed the IDAT stream back and
     confirmed the corner/center pixels round-trip to the exact intended colors
     before ever handing it to Electron.
2. **Elevation guidance, not a false claim of working hotkeys.** `main.js` logs a
   BEST-EFFORT (explicitly hedged, never asserted as certain) elevation guess at
   startup — attempts to write a throwaway file into `C:\Windows`, success/failure
   is weak evidence either way — plus a static reminder pointing at the tray and at
   `start:admin`. `README.md`'s new "Hotkeys and elevation" section states plainly
   that Ctrl+F10/F11 may not respond with League focused and why, rather than
   silently claiming they work.
3. **`npm run start:admin` + `start-admin.cmd`** — both relaunch
   `node_modules/electron/dist/electron.exe .` elevated via PowerShell's
   `Start-Process -Verb RunAs` (triggers a UAC prompt; no new dependency). **NOT
   exercised in this session** — approving a UAC prompt requires interactive user
   input this agent cannot provide. Documented as unverified, not claimed working.

### Re-verification run (this round)

- `node --check` clean on every touched/new `.js` file (`main.js`, `preload.js`,
  `lib/gameState.js`, `lib/laneSettings.js`, `js/skillOrderData.js`,
  `renderer/ingame.js`) and `package.json` re-validated as JSON after the
  `start:admin` script addition.
- Three separate assertion suites, all passing, 46 assertions total:
  - `lib/gameState.js` (CJS, main-process): 20 assertions, including
    `extractLocalPosition` against the OBSERVED "NONE" Practice Tool shape, an
    unobserved-but-Riot-documented "BOTTOM" shape, a missing-field case, and the
    extended `EMPTY_STATE`/`emptyStateFor` shape.
  - `js/skillOrderData.js`'s `mapPositionToLane` (ESM, renderer-side): 20
    assertions — every Riot position value, case-insensitivity, whitespace,
    non-string/unrecognized input, and that every mapped output round-trips
    through `laneToRoleId` as a valid app lane.
  - `lib/laneSettings.js`: 6 assertions — save/load round-trip, garbage
    normalizing to Auto, corrupt file degrading to Auto without throwing.
- **Launched the app multiple times, live, and did not just read logs:**
  - Clean-boot run: console confirmed `lane override at startup: Auto (none set)`,
    both hotkeys registered, the elevation guess logged, and the full IPC
    readiness round-trip completed — no exception anywhere, including tray
    construction (a failed `nativeImage`/`Tray()` call would have logged a `warn`;
    none appeared).
  - **Took an actual screenshot of the live desktop** (PowerShell
    `CopyFromScreen`) and viewed it: the overlay window is REALLY there, rendering
    transparent, on top of a real other application (a Chrome window open to
    `coachbuild.vercel.app/draft`, not something I opened) — this is independent,
    visual confirmation of the same "draws over another app" result the
    coordinator's own League test found, not inference from logs.
  - **Lane persistence verified end-to-end, not just unit-tested:** wrote
    `{"lane":"JUNGLE"}` directly into the settings file (same effect as
    `setLane()`'s own write path, already unit-tested separately), relaunched,
    confirmed the console logged `lane override at startup: JUNGLE`, AND took a
    second screenshot confirming the overlay's lane bar visually read "JUNGLE"
    instead of "AUTO" after the restart — proof the full chain (disk → main →
    IPC → preload → renderer render) works, not just the file I/O half.
  - Cleaned up after each run: killed all `electron.exe` processes, deleted the
    test settings file to restore a pristine first-run state.

### What remains unverified — explicit

- **The tray icon's on-screen appearance could not be confirmed.** This session's
  desktop shows no Windows taskbar/notification area in either screenshot taken
  (full-screen and a bottom-strip crop both show no taskbar chrome at all) — a
  property of this particular desktop session, not evidence the tray failed.
  `Tray`/`setContextMenu` ran without error every time, and the icon asset was
  independently verified pixel-correct before use, but nobody has actually SEEN
  the tray icon rendered. First thing to check in a normal desktop session.
- Everything requiring a real running League client: the live polling path end to
  end, on-screen appearance specifically over League (vs. the Chrome-window proxy
  confirmed here), hotkeys/tray control with League focused, whether interactive-
  mode clicks land, and — the specific new experiment this round sets up — whether
  a matchmade game actually populates `position` with a real assigned role (only
  `"NONE"` has been directly observed, in Practice Tool).
- `start:admin`'s UAC relaunch path — implemented, not exercised (needs interactive
  UAC approval).
- The elevation heuristic itself is explicitly NOT a certainty — could read wrong
  in either direction under UAC virtualization, and is documented as such
  everywhere it appears (code comments, startup log, README).

### Files touched this round

`overlay-host/main.js`, `overlay-host/preload.js`, `overlay-host/lib/gameState.js`,
`overlay-host/js/skillOrderData.js`, `overlay-host/renderer/ingame.js`,
`overlay-host/README.md`, `overlay-host/package.json` (added `start:admin` script,
no new dependencies). New: `overlay-host/lib/laneSettings.js`,
`overlay-host/assets/tray-icon.png`, `overlay-host/start-admin.cmd`. Nothing under
`overwolf/`, the Next.js app, or `public/companion.ps1` touched. No version bump, no
`CHANGELOG.md` edit, no deploy.
