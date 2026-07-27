# CoachBuild Overlay (Overwolf) — load & test

A passive, static League of Legends skill-order overlay. It never tells you what to
press — see `HANDOFF-engy.md` / CoachBuild's `CLAUDE.md` for the compliance reasoning.
This is the SHELL: manifest, background controller, window management, and the
`js/gameState.js` normaliser (engy). The in-game table UI and champion data fetching
live in `ingame/` and `js/skillOrderData.js` (engo).

## Load it unpacked

1. Make sure Overwolf is running (tray icon) and you're **logged in** — an unpacked
   app that isn't signed shows "Unauthorized App" if you're logged out.
2. Open the Overwolf tray icon → **Settings (gear)** → **About** → scroll to
   **Development options** → toggle it on if it isn't already.
3. Click **Load unpacked extension**, and select this folder:
   `C:\Claude\AI\coachbuild\overwolf` (the folder containing `manifest.json`
   directly — not a parent or child folder).
4. Overwolf loads the app and should show it in the tray / running-apps list as
   **CoachBuild Overlay**. If it instead shows a load error, the error text names
   the offending manifest field — check `manifest.README.md` for what each field is
   supposed to be.
5. The `desktop` window MAY open automatically shortly after load, or it may not —
   `background.js` now only auto-shows it when it can positively confirm you (a
   person) triggered the launch, not an automated `GameLaunch` trigger (fixed
   2026-07-27, see `manifest.README.md`'s `desktop` window note). Loading via
   **Load unpacked extension** is itself an untested case for that origin check —
   if the desktop window doesn't appear within a couple of seconds, that's expected
   right now, not a bug: open it yourself from Overwolf's running-apps list. The
   background console will log its decision either way (`desktop auto-open
   decision — launch origin: ...`).

## Enable devtools (optional but recommended for first run)

Overwolf's Chromium devtools are gated behind a registry flag:

1. Open `regedit`, navigate to `HKEY_CURRENT_USER\SOFTWARE\Overwolf\CEF`.
2. Set (or create) a string value `enable-features` = `enable-dev-tools`.
3. Restart Overwolf.
4. Right-click any CoachBuild window → **Inspect** (or similar) to get a normal
   Chromium devtools console. `background.js` and `desktop.js` both log with a
   `[CoachBuild:bg]` / no-prefix tag — watch the **background** window's console
   first; that's where GEP registration, game detection, and every state push are
   logged.

## Test with League of Legends

1. Launch League of Legends normally (client, then a game — Practice Tool is the
   fastest way to get into a live match with real Live Client Data).
2. Watch the **background** window's devtools console for, in order:
   - `background controller starting`
   - (once League's client/launcher is detected running) `League detected running —
     entering game session`
   - `GEP features registered: live_client_data` — if this never appears, or you see
     repeated `setRequiredFeatures not ready` lines past ~10 attempts, that's the
     first thing to investigate (see "What to check if it doesn't work" below).
3. Once you're actually in a live game (not champ select — Live Client Data only
   exists once the game itself has loaded), you should see the in-game overlay
   appear in the **upper-left** area of the screen (340×520 starting at top:110,
   left:24 — see `manifest.README.md`'s "Overlay position" note for why there).
4. Level up (or, in Practice Tool, use the built-in level-up console command) and
   confirm the overlay updates. The very first data point may take a few seconds —
   `getInfo()` seeding plus the first GEP tick both need to land.
5. Press **Ctrl+F10** — the overlay should hide. Press it again — it should
   reappear, resend its last known state (not go blank).
6. Press **Ctrl+F11** — the overlay becomes **interactive** and this IS visible:
   an "editable" badge appears, the overlay border changes, and the lane readout
   turns from a plain label into five clickable lane buttons. Click one and the
   table should re-resolve for that lane. Press Ctrl+F11 again to return to
   click-through, where the lane goes back to being a static label.

   That visible difference is the point, not decoration: in click-through mode a
   click passes through to the game, so anything that *looked* pressable but
   wasn't would be the most confusing thing the overlay could do. The background
   console also logs `toggle_interactive -> interactive (clickable)`.

   This is the single most important step for a one-monitor user: it is the only
   way to fix a wrong lane without leaving the game, and a wrong lane means a
   wrong skill path for the whole match.
7. Open the **desktop** window (see step 5 of "Load it unpacked" — it may already
   be open, or you may need to open it yourself from Overwolf's running-apps list)
   — confirm it shows "In game — overlay is active", the lane selector
   works and survives a reload (`localStorage.getItem('coachbuild.overwolf.lane')`
   in its devtools console), and the Riot disclaimer text is visible.
8. Exit the game (or close League entirely) and confirm: the background console
   logs `League no longer running — ending game session`, the overlay disappears,
   and nothing throws/shows an error dialog — "no game running" must be silent and
   normal, not an error state.

## What to check if it doesn't work

- **Nothing loads at all / manifest error on step 3 above** — read the exact error
  Overwolf shows; it names the bad field. Cross-check against `manifest.README.md`.
- **App loads but "Unauthorized App"** — you're not logged into Overwolf. Log in via
  the tray icon.
- **`GEP features registered` never appears** — either League isn't actually being
  detected as running (check the id logged by `getRunningGameInfo` against 5426 /
  10902 — see the `isLeagueId` note in `manifest.README.md` about the untested
  id-suffix fallback), or `setRequiredFeatures` is failing outright rather than
  racing (its `result` object is logged on give-up — read the `result.error`).
- **Features register but the overlay never gets champion-level data** — check
  whether `onInfoUpdates2` is firing at all (add a temporary `console.log(event)`
  at the top of its listener in `background.js` if needed) and whether
  `event.info.live_client_data` actually contains `active_player` — this whole path
  was NEVER exercised against a real running game before this session; see
  `HANDOFF-engy.md` for exactly what's verified vs. assumed.
- **Overlay shows level but never a champion name** — expected to lag
  `championLevel` by design (see `js/gameState.js`'s header comment), but if it
  NEVER resolves, check the background console in this order:
  1. Look for `live client data port resolved to <port> (...)` — this now logs once
     per session (fixed 2026-07-27; it used to be silent, and worse, `livePort`
     could stay `null` forever on a stringified/missing GEP `port` leaf, which
     silently skipped the HTTP call entirely with no log at all). If you don't see
     this line, the GEP tick with `port` on it never arrived — that's a GEP/feature
     problem, not an HTTP one.
  2. If a port WAS resolved, look for `playerlist fetch not ready yet` repeating
     forever — that means the HTTP call to
     `https://127.0.0.1:<port>/liveclientdata/playerlist` is genuinely failing every
     time, not just at match start. Confirm the `Web` permission is present in
     `manifest.json`.
  3. The resolved port defaults to `2999` (matching `companion.ps1`'s own hardcoded
     default) whenever GEP doesn't supply a usable one — if the real port differs
     this session, the fallback log in step 1 will say so explicitly.
- **Hotkeys don't do anything** — confirm they weren't silently reassigned to
  something else by Overwolf's own hotkey settings UI (Settings → Hotkeys), and
  that `overwolf.settings.hotkeys.onPressed` is actually firing (log inside the
  listener). Registered ONLY in `background.js` on purpose — see
  `manifest.README.md`.

## Reloading after an edit

Overwolf does not hot-reload an unpacked app on file save. After editing any file
under `overwolf/`, go back to Settings → About → Development options and use
**Reload** (or unload + re-load unpacked) to pick up changes. A stale background
page silently running old code is a common source of "I fixed it but it's still
broken" — if in doubt, fully unload and re-load.
