# CoachBuild Overlay Host (Electron)

Replaces the Overwolf app entirely. **Why:** loading an unpacked Overwolf app
requires the developer's Overwolf account to be whitelisted, whitelisting requires
an approved App Proposal, Overwolf does not approve private/personal apps, and
Overwolf will not approve any app that doesn't integrate Overwolf ads or Overwolf
subscriptions (verified verbatim at
`https://dev.overwolf.com/ow-native/getting-started/project-roadmap/`). A real
"Unauthorized App" was hit on this machine while logged in — this is enforced, not
advisory, and a personal one-machine tool cannot clear it. The `overwolf/` app is
left in place (not deleted) but is not the path forward.

This is a normal, always-on-top Electron window instead: no whitelist, no store
approval, no ads requirement — just a window that draws over the game.

## HARD PREREQUISITE — read this before testing

**League of Legends must be running in Borderless or Windowed display mode, NOT
exclusive Fullscreen.** An always-on-top window (any of them — this one, Discord's
overlay, MSI Afterburner, anything) cannot draw over an exclusive-fullscreen
surface; the game owns the whole screen at the driver level and nothing else gets
composited on top. This is a genuine platform limitation, not a bug in this app.
Check League's video settings before testing: **Settings → Video → Display Mode**.

## What it is

- **The overlay window is FULLSCREEN** (2026-07-27 round), covering the entire
  primary display (`screen.getPrimaryDisplay().bounds`, not `workArea` — a running
  game covers the taskbar). Transparent, click-through, always-on-top at the
  `'screen-saver'` level. Click-through is safety-critical at this size: a fullscreen
  window that ever fails to be click-through makes the game unplayable.
- The old top-left levels 1–18 skill table still exists (never deleted), now behind
  a tray toggle **"Show skill table" — defaults OFF**. The new default surface is a
  highlight box drawn directly over the real Q/W/E/R ability icons (engo's renderer
  work, `renderer/ingame.js` — this file does not draw it, only supplies WHERE the
  icons are, see "Compliance" below).
- A **system tray icon** (notification area) — the PRIMARY control surface. Left-click
  toggles show/hide; right-click opens a menu: show/hide, interactive mode, "Show
  skill table", "Calibrate ability bar…", a lane override submenu
  (Top/Jungle/Mid/Bot/Support + "Auto"), and Quit. This exists because global
  hotkeys are expected to be unreliable while League has focus — see "Hotkeys and
  elevation" below — and the tray works regardless.
- Two global hotkeys as a secondary/convenience path — **may require running as
  Administrator to work while League has focus, see below**:
  - **Ctrl+F10** — show/hide the overlay
  - **Ctrl+F11** — toggle interactive mode (lane buttons become clickable; the
    overlay is click-through the rest of the time)
- **Adjust-in-place mode** (Ctrl+F12, or tray → "Adjust overlay position") — **the
  PRIMARY alignment path (2026-07-27 round 8)**, replacing the separate calibration
  window for real use. A real user report made the problem concrete: on one
  monitor, a SEPARATE calibration window covers the game, so you're aiming boxes at
  ability icons you can no longer see. Adjust mode instead nudges the SAME boxes
  already drawn over the SAME running game, live: arrows nudge 1px (Shift: 10px),
  `+`/`-` resize, `[`/`]` adjust spacing, `Enter` saves, `Esc` cancels. The overlay
  becomes interactive+focused only while adjusting (keyboard input is captured by
  the app, not the game) and returns to click-through the instant you exit. This is
  a MAIN-PROCESS + IPC-contract feature — the actual box-drawing/key-handling lives
  in `renderer/ingame.js` (engo's file); see `HANDOFF-engy.md` for the exact
  contract if that's still in progress.
- **Calibrate ability bar (separate window, fallback)** — the original approach,
  kept for a second monitor or a dry run without a game running. Four draggable
  Q/W/E/R boxes, modelled as one rigid group (`{firstBoxCenterX, centerY, boxSize,
  spacing}`) since the real icons sit evenly spaced on one row. Drag any box to move
  all four; arrow keys nudge 1px (Shift: 10px); number fields adjust box
  size/spacing; "Reset to default" recomputes a resolution-scaled starting point
  (from an UNRESEARCHED 1920×1080 reference — see `lib/calibrationSettings.js`'s
  header, this is a rough starting drag point, never presented as accurate). Both
  paths persist to the same settings file, tagged with the resolution calibrated
  at — a resolution change falls back to the scaled default (logged) rather than
  silently reusing stale coordinates.
- Polls Riot's local Live Client Data API directly
  (`https://127.0.0.1:2999/liveclientdata/*`) — no GEP, no Overwolf, no companion
  bridge. Silent when no game is running (that's the normal state). This also means
  lane auto-detection is fully standalone — no companion app needed.
- The Riot disclaimer is rendered in the overlay's footer once a skill order is
  showing (ported from the Overwolf build's `ingame.js`/`ingame.css`, unchanged).

## COMPLIANCE — read this before touching main.js's calibration code

`main.js` computes and pushes ONLY geometry (WHERE the four ability boxes sit). It
does NOT compute, store, or push WHICH ability should be highlighted, and never
will from this file. A live pink box on the real ability icon, computed from
current ranks, telling the player which one to press next, is the exact feature
`CHANGELOG.md`'s v0.65.0 entry already ruled out on POLICY grounds: *"Every app
that appears to highlight abilities in the HUD is drawing an Overwolf-style overlay
over the game, which stays out of scope here."* `renderer/ingame.js` (engo's file,
not this one) has reintroduced `resolveNextSkill` for the highlight box, reasoning
that leaving Overwolf's distribution/approval surface changes the policy calculus.
See `HANDOFF-engy.md`'s round-7 entry for the full flag raised on this, including
why that reasoning is contestable (Riot's *developer/API* policy is separate from
Overwolf's *store/whitelist* policy, and `public/companion.ps1` — already
standalone, already non-Overwolf — was evaluated against the SAME "highlight
abilities in the HUD" question and rejected for the same policy reason, undercutting
the "no longer applies once standalone" argument). This file's own scope stayed
compliance-neutral throughout; the concern is about `renderer/ingame.js`, not
anything in `main.js`/`lib/*`.

## Lane resolution — three tiers, auto-detection first

1. **Manual override** (tray menu or the in-overlay lane buttons, in interactive
   mode) — wins outright whenever set. Persisted to disk, survives a restart, and
   holds until you clear it back to "Auto."
2. **Auto-detected** from the local player's own `position` field on
   `/liveclientdata/playerlist` (TOP/JUNGLE/MIDDLE/BOTTOM/UTILITY → this app's
   TOP/JUNGLE/MID/BOT/SUPPORT). **Expected to work in a real matchmade game** (Riot's
   documented behavior — assigned role). **Expected to come back empty ("NONE") in
   Practice Tool, custom games, and ARAM**, where League genuinely has no assigned
   role to report — if you test in Practice Tool and see the fallback tier kick in
   instead of a detected lane, that is CORRECT behavior, not a bug. The main process
   logs the raw value once per game (`detected local player position (raw, from
   /liveclientdata/playerlist): "..."`) so your next real match is the point where
   this gets independently confirmed against a real assigned role — it has only
   been directly observed as "NONE" (Practice Tool) so far.
3. **Fallback by highest sample size** — no override, nothing usable detected:
   queries all five real lanes IN PARALLEL and picks whichever comes back with the
   LARGEST `sampleSize`, labeled `<lane> · likely` (deliberately not "auto" — see
   below). (Role `5`, "let the API pick," is NOT used here — verified dead against
   this backend: `lib/opgg.ts`'s `opggPosition(5)` returns `null`, so
   `/api/skill-order?role=5` always answers empty.)

   **Corrected 2026-07-27** from an earlier, real bug: the first version returned
   the FIRST lane (fixed Top→Jungle→Mid→Bot→Support order) that had ANY data,
   which is a fabricated claim, not an answer. Measured live: Corki (champion 42)
   has `sampleSize: 235` at TOP vs. `sampleSize: 7150` at BOT — the old logic
   picked TOP and presented it with full confidence. Ties (possible with tiny
   samples) break deterministically by sample size first, then the fixed lane
   order — never randomly. See `js/skillOrderData.js`'s `resolveOverlayData`
   header for the full trace.

The overlay's footer shows a quiet source label once a champion resolves — `Mid ·
manual`, `Mid · auto`, or `Mid · likely` — so if the shown lane looks wrong, you can
tell at a glance whether this app detected it, you pinned it, or it's a best guess
(`likely` is deliberately a lower-confidence word than `auto`: Tier 2 is Riot's own
reported position, a fact; Tier 3 is this app's own inference from win/play counts).

## Hotkeys and elevation

**If Ctrl+F10 / Ctrl+F11 / Ctrl+F12 do nothing while a League game has focus, you
need to run this app as Administrator — run `npm run start:admin` (or
double-click `start-admin.cmd`) once, and keep using that from then on.** The tray
icon works either way and does not need this — see below.

**Why:** League/Vanguard runs elevated. Windows' UIPI (User Interface Privilege
Isolation) does not deliver global-hotkey input from a lower-integrity process to a
higher-integrity foreground window — so the three hotkeys are expected to not
respond while League has focus, unless this app is also running elevated. This is
not a bug; every hotkey registers successfully on every launch (confirmed in every
test run below) and simply may not receive the keypress once a higher-privilege
window is focused.

- **Primary fix regardless of elevation: use the tray icon.** Every hotkey has a
  tray equivalent (show/hide, "Adjust overlay position", interactive mode), and the
  tray does not depend on elevation at all.
- **The tray menu itself tells you the elevation guess** — a row reading either
  "Hotkeys: probably active (elevated)" or "Hotkeys: may not respond in-game (not
  elevated)". The app also logs the same best-effort (NOT certain) guess on every
  startup. Do not trust either as definitive — it's a heuristic (attempts to write
  a throwaway file into `C:\Windows`), and Windows UAC virtualization can make it
  wrong in either direction.
- To run elevated: `npm run start:admin`, or double-click `start-admin.cmd`, or
  right-click `node_modules/electron/dist/electron.exe` in a shortcut and choose
  "Run as administrator." **Verified this round that the underlying mechanism
  genuinely works**: running it triggered a real Windows UAC consent prompt,
  confirmed three independent ways — a `consent.exe` process appeared, a
  screenshot attempt during the prompt failed with "the handle is invalid" (Windows'
  Secure Desktop blocks screen capture during a genuine UAC prompt — a
  fake/scripted dialog would not do this), and the process could not be
  force-killed from an unelevated PowerShell ("Access is denied" — again, real UAC
  prompts are protected this way). **What could NOT be verified**: actually
  clicking "Yes" and confirming the app relaunches elevated — that needs a human at
  the keyboard, which this automated test cannot provide. The prompt was left to
  time out on its own (Windows' default ~150s UAC timeout) rather than force-closed.

## Reused from the Overwolf build (not rewritten)

- `renderer/ingame.html`, `renderer/ingame.css` — copied byte-for-byte, untouched.
- `renderer/ingame.js` — copied from `overwolf/ingame/ingame.js`; changed sections:
  the bottom "Transport" block (now Electron IPC via `window.coachbuildIPC`, exposed
  by `preload.js`, instead of `overwolf.windows.onMessageReceived`/`sendMessage`;
  public contract `window.CoachBuildOverlay.onState`/`.onInteractiveChange` is
  unchanged), and the lane-control section (2026-07-27 fix: lane buttons now send an
  IPC message instead of writing `localStorage`, plus a 6th "AUTO" button to clear
  an override).
- `js/skillOrderData.js` — the data layer (champion resolution, skill-order fetch +
  cache). Originally copied byte-for-byte from `overwolf/js/skillOrderData.js`;
  since diverged (2026-07-27 lane fix) to read the lane from pushed state instead of
  `localStorage`, add `mapPositionToLane()` for auto-detection, and replace the old
  "no lane selected" dead end with the three-tier resolution described above.
- `lib/gameState.js` — ported from `overwolf/js/gameState.js`. Same parsing logic
  (Passive-key exclusion, all-or-nothing level/ability gate, riotId-matched
  champion-name resolution preferring `rawChampionName`), converted from ES module
  exports to CommonJS `module.exports` because it now runs in Electron's Node-based
  main process instead of a browser context. Extended (2026-07-27) with
  `extractLocalPosition()` for lane auto-detection, off the same playerlist fetch
  already used for champion resolution — no extra request.

## Load & test

1. `cd overlay-host && npm install` (installs Electron as a devDependency — this
   does NOT touch or affect the Next.js app's own `package.json`/`node_modules`).
2. `npm start` (runs `electron .`).
3. Confirm the window appears in the upper-left of the screen (340×520 at
   top:110, left:24), showing "CoachBuild" / "AUTO" with no game running. It
   should NOT appear in the taskbar (`skipTaskbar: true`). Confirm a tray icon
   appears in the Windows notification area (a solid gold square with a dark
   border) — check the overflow/"show hidden icons" chevron if it's not
   immediately visible; Windows often defaults a new app's tray icon there.
4. Right-click the tray icon: confirm the menu shows Show/Hide overlay,
   Interactive mode (checkbox), a Lane override submenu (Auto + the 5 lanes, with
   the current one checked), and Quit.
5. Pick a lane from the tray submenu. Confirm the overlay's lane bar updates (it
   will only be visibly different from "AUTO" once you check — with no game
   running the body stays empty either way, only the small lane-bar text changes).
   Quit and relaunch (`npm start` again) — confirm the console logs `lane override
   at startup: <the lane you picked>`, not `Auto`.
6. Press **Ctrl+F10** — window hides. Press again — reappears. Press **Ctrl+F11** —
   no crash, interactive-mode flag flips silently (confirm via console or the tray
   menu's checkbox).
7. **Set League's display mode to Borderless or Windowed** (see prerequisite
   above), launch a Practice Tool game, and confirm:
   - The overlay updates with your champion's skill table once champion name +
     level resolve (champion name can lag level by a beat or two — expected).
   - The lane bar reads "AUTO" and the footer (once a champion resolves) shows
     `<lane> · likely` — Practice Tool is EXPECTED to report no assigned position
     (see "Lane resolution" above), so falling to the sample-size fallback tier
     is correct here, not a bug. The lane shown should be the one with the most
     games behind it, not necessarily the first one alphabetically/positionally.
   - The overlay stays on top of the game.
   - The tray icon's Show/Hide and Interactive-mode controls work with League
     focused. Ctrl+F10/F11 may not — see "Hotkeys and elevation" above.
   - In interactive mode, the lane buttons are actually clickable — **not verified
     against a live game; see HANDOFF-engy.md's honesty section.**
8. In a REAL matchmade game (not Practice Tool), check the console for `detected
   local player position (raw, ...): "..."` — this is the first real-world
   confirmation of whether Riot populates `position` with an actual assigned role
   outside Practice Tool. Confirm the lane bar/footer reflect it as `<lane> · auto`
   (not `<lane> · likely`) if it resolves to a real lane.
9. Close League (or exit to the loading screen / client) and confirm the overlay
   quietly returns to the "no game" state — no error dialog, nothing alarming.

## What was actually verified before a live game (see HANDOFF-engy.md for full detail)

- `node --check` passes on every `.js` file.
- `lib/gameState.js`'s parsing logic verified with a 20-assertion suite (level/
  ability parsing, the real captured Practice Tool payload shape, champion-name
  resolution, and the new `extractLocalPosition`/`EMPTY_STATE` lane fields).
- `js/skillOrderData.js`'s `mapPositionToLane()` verified with a 20-assertion suite
  (every Riot position value, case-insensitivity, whitespace, unrecognized/non-string
  input, and that every mapped output is a valid app lane).
- `lib/laneSettings.js` verified with a 6-assertion suite: save/load round-trip,
  garbage input normalizing to Auto, and a corrupted settings file degrading to
  Auto rather than throwing.
- **The sample-size fallback fix verified with real measured numbers, against a
  mocked-but-code-real `resolveOverlayData`** (10 assertions): using Corki's
  ACTUAL production `sampleSize` per role as measured by the coordinator (TOP=235,
  JUNGLE=38, MID=1121, BOT=7150, SUPPORT=3), confirmed the fallback resolves to
  BOT — not TOP, which the earlier first-match version would have picked.
  Separately confirmed: all 5 lane requests are genuinely CONCURRENT (observed
  max in-flight count of 5 against an artificial network delay, not sequential);
  a second `resolveOverlayData` call for the same champion makes ZERO additional
  network calls (the existing per-lane cache covers the fan-out, verified rather
  than assumed); an exact sample-size tie breaks deterministically to the fixed
  TOP/JUNGLE/MID/BOT/SUPPORT order; and `no-data-any-lane` still fires correctly
  when every lane is genuinely empty.
- The Electron app was actually launched multiple times on this machine with no
  game running. Confirmed via console log: starts clean, registers both hotkeys,
  logs the elevation guess, completes a full IPC round-trip (readiness handshake).
  Confirmed via `Get-Process` in an earlier round that a real OS window exists.
  **Confirmed via an actual screenshot** (this round) that the overlay window
  genuinely renders transparent and always-on-top over another real application
  window on this machine (a Chrome window, standing in for what a live test
  separately confirmed works over League itself) — visible proof, not inference
  from logs alone.
- **Lane persistence verified end-to-end, live, not just unit-tested**: wrote a
  lane value to the settings file the same way `setLane()` would, relaunched the
  app, confirmed the startup log reported the correct loaded value, AND confirmed
  via a second screenshot that the overlay's lane bar visually updated from "AUTO"
  to the persisted lane after the restart.
- **NOT verified — the tray icon's on-screen appearance specifically.** This
  session's desktop has no visible Windows taskbar/notification area in a
  screenshot (checked both the full screen and a bottom-strip crop — neither shows
  a taskbar at all, in either test run), so the tray icon's actual visual
  appearance could not be confirmed by screenshot. This is a limitation of this
  particular desktop session, not evidence the tray failed — `new Tray(icon)` and
  `setContextMenu()` both ran with no exception/warning across every launch, and
  the icon file itself was independently byte-verified as a valid, correctly
  round-tripping 16×16 PNG before ever being loaded by Electron.
- **NOT verified — anything requiring a running League client or a UAC prompt.**
  The live polling path, champion/level resolution end-to-end, on-screen
  appearance over League specifically, hotkeys/tray with League focused, whether
  clicks land in interactive mode, `start:admin`'s UAC relaunch (requires
  interactive approval this agent cannot give), and whether a matchmade game
  actually populates `position` with a real role (only "NONE" in Practice Tool has
  been directly observed).
