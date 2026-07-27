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

- One transparent, click-through, always-on-top window in the upper-left of the
  screen showing a static levels 1–18 skill-order table (Q/W/E/R × 18 columns),
  with the player's own current level highlighted. Never imperative copy — see
  "Compliance" below.
- Two global hotkeys, working even while League has focus:
  - **Ctrl+F10** — show/hide the overlay
  - **Ctrl+F11** — toggle interactive mode (lane buttons become clickable; the
    overlay is click-through the rest of the time)
- Polls Riot's local Live Client Data API directly
  (`https://127.0.0.1:2999/liveclientdata/*`) — no GEP, no Overwolf, no companion
  bridge. Silent when no game is running (that's the normal state).
- The Riot disclaimer is rendered in the overlay's footer once a skill order is
  showing (ported from the Overwolf build's `ingame.js`/`ingame.css`, unchanged).

## Reused from the Overwolf build (not rewritten)

- `js/skillOrderData.js` — the data layer (champion resolution, skill-order fetch +
  cache, lane persistence). Copied byte-for-byte from `overwolf/js/skillOrderData.js`.
- `renderer/ingame.html`, `renderer/ingame.css` — copied byte-for-byte.
- `renderer/ingame.js` — copied from `overwolf/ingame/ingame.js`; the ONLY section
  changed is the bottom "Transport" block, which now talks to Electron IPC
  (`window.coachbuildIPC`, exposed by `preload.js`) instead of
  `overwolf.windows.onMessageReceived`/`sendMessage`. The public contract
  (`window.CoachBuildOverlay.onState(state)` /
  `window.CoachBuildOverlay.onInteractiveChange(isInteractive)`) is byte-for-byte
  identical.
- `lib/gameState.js` — ported from `overwolf/js/gameState.js`. Same parsing logic
  (Passive-key exclusion, all-or-nothing level/ability gate, riotId-matched
  champion-name resolution preferring `rawChampionName`), converted from ES module
  exports to CommonJS `module.exports` because it now runs in Electron's Node-based
  main process instead of a browser context.

## Load & test

1. `cd overlay-host && npm install` (installs Electron as a devDependency — this
   does NOT touch or affect the Next.js app's own `package.json`/`node_modules`).
2. `npm start` (runs `electron .`).
3. Confirm the window appears in the upper-left of the screen (340×520 at
   top:110, left:24) — it should be visible even with no game running (idle
   state), since Electron windows aren't gated on `in_game_only` the way the
   Overwolf build's were. It should NOT appear in the taskbar (`skipTaskbar:
   true`).
4. Press **Ctrl+F10** — window hides. Press again — reappears.
5. Press **Ctrl+F11** — nothing should visually change with no game running (the
   overlay shows nothing but the "waiting" message either way), but if you check
   the main process console you should NOT see a crash; the interactive-mode flag
   flips silently.
6. **Set League's display mode to Borderless or Windowed** (see prerequisite
   above), launch a Practice Tool game, and confirm:
   - The overlay updates with your champion's skill table once champion name +
     level resolve (champion name can lag level by a beat or two — see
     `lib/gameState.js`'s header for why that's expected, not a bug).
   - The overlay stays on top of the game.
   - Ctrl+F10/F11 still work with League focused.
   - In interactive mode (Ctrl+F11), the lane buttons are actually clickable —
     **this specific interaction was NOT verified against a live game; see
     HANDOFF-engy.md's honesty section.**
7. Close League (or exit to the loading screen / client) and confirm the overlay
   quietly returns to the "no game" state — no error dialog, nothing alarming.

## What was actually verified before a live game (see HANDOFF-engy.md for full detail)

- `node --check` passes on every `.js` file.
- `lib/gameState.js`'s parsing logic re-verified with a 13-assertion suite,
  including the exact real captured Practice Tool payload shape from
  `_capture/live-client-raw-20260727-140136.jsonl`.
- The Electron app was actually launched (`node_modules/electron/dist/electron.exe .`)
  on this machine with no game running. Confirmed via the process log: it started,
  registered both global hotkeys successfully, created the window, and completed a
  full IPC round-trip (renderer → preload → main → renderer) via the readiness
  handshake — not just "the process didn't crash." Confirmed via `Get-Process` that
  a real OS window (title "CoachBuild Overlay", non-zero window handle) existed.
  Single-instance locking was also verified by launching a second copy, which
  correctly detected the first and exited.
- **NOT verified:** anything requiring a running League client — the live polling
  path, champion/level resolution end-to-end, on-screen appearance over an actual
  game, hotkeys with League focused, and whether clicks actually land in
  interactive mode.
