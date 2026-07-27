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
- **Adjust-in-place mode** (**Ctrl+Shift+A**, or tray → "Adjust overlay position") —
  **the PRIMARY alignment path (2026-07-27 round 8)**, replacing the separate calibration
  window for real use. A real user report made the problem concrete: on one
  monitor, a SEPARATE calibration window covers the game, so you're aiming boxes at
  ability icons you can no longer see. Adjust mode instead nudges the SAME boxes
  already drawn over the SAME running game, live: arrows nudge 1px (Shift: 10px),
  `+`/`-` resize, `[`/`]` adjust spacing, `Enter` saves, `Esc` cancels. The overlay
  becomes interactive+focused only while adjusting (keyboard input is captured by
  the app, not the game) and returns to click-through the instant you exit. This is
  a MAIN-PROCESS + IPC-contract feature — the actual box-drawing/key-handling lives
  in `renderer/ingame.js` (engo's file); see `HANDOFF-engy.md` for the exact
  contract if that's still in progress. **Was Ctrl+F12 until 2026-07-27 round 9** —
  changed because F12 is permanently reserved by Windows for the debugger and can
  never be registered as a global hotkey on any Windows machine; see "Hotkeys and
  bind status" below for the full story.
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

## Hotkeys and bind status

**If a hotkey does nothing, check the tray menu or "Open log file" FIRST** — both
now show the ACTUAL measured bind status per hotkey (`register()`'s real return
value plus a follow-up `isRegistered()` check, added 2026-07-27 round 9), not a
guess. A hotkey that failed to register will never respond no matter what else you
try; a hotkey that DID register but still doesn't respond in-game is a different
problem (see elevation below).

**Root cause found 2026-07-27 round 9 for the specific "Ctrl+F12 does nothing"
report, even genuinely elevated:** F12 is **permanently reserved by Windows for the
debugger**, verbatim from Microsoft's own `RegisterHotKey` documentation — *"F12 is
reserved for use by the debugger at all times, so it should not be registered as a
hot key. Even when you are not debugging an application, F12 is reserved in case a
kernel-mode debugger or a just-in-time debugger is resident."*
(https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-registerhotkey).
Electron's `globalShortcut` is a thin wrapper over `RegisterHotKey`, so
`register('...F12', ...)` returns `false` on **every** Windows machine,
unconditionally — this had nothing to do with elevation, and the elevation
investigation that preceded this finding was chasing the wrong mechanism. The
adjust-in-place hotkey is now **Ctrl+Shift+A** instead (not reserved, not a League
default bind, mnemonic). `main.js`'s `registerHotkeys()` also now refuses to even
attempt registering any accelerator containing F12 and fails loudly (console + log
file + a dedicated tray row) — so if a future edit picks F12 again, it's caught at
startup, not silently dead for an hour like this one was.

- **The tray menu shows one row per hotkey** with its real status, e.g. `Hotkeys:
  Ctrl+Shift+A (adjust overlay position) — active` or `— FAILED to bind` /
  `— FAILED, reserved by Windows`. This is ground truth, not a heuristic.
- **A separate "Elevation: …" row** gives the same best-effort elevation guess as
  before (see below), but is now worded as *one possible factor if a hotkey fails
  only in-game* — not presented as the explanation, because it wasn't one for the
  actual bug found this round. Do not trust it as definitive either way — it's a
  heuristic (attempts to write a throwaway file into `C:\Windows`), and Windows UAC
  virtualization can make it wrong in either direction.
- **Primary fix regardless of any of this: use the tray icon.** Every hotkey has a
  tray equivalent (show/hide, "Adjust overlay position", interactive mode), and the
  tray does not depend on hotkey registration or elevation at all.

**Still open, not yet retested since elevating:** whether Ctrl+F10/Ctrl+F11
specifically respond while League (which runs elevated under Vanguard) has focus.
Those two are NOT reserved keys, so Windows' UIPI (User Interface Privilege
Isolation) not delivering global-hotkey input from a lower-integrity process to a
higher-integrity foreground window remains a live, untested hypothesis for THEM
specifically — just no longer assumed to be the explanation for every hotkey
problem. The tray's per-hotkey rows plus the log file are exactly what will settle
this on the next real test.

- To run elevated: `npm run start:admin`, or double-click `start-admin.cmd`, or
  right-click `node_modules/electron/dist/electron.exe` in a shortcut and choose
  "Run as administrator." **Verified in an earlier round that the underlying
  mechanism genuinely works**: running it triggered a real Windows UAC consent
  prompt, confirmed three independent ways — a `consent.exe` process appeared, a
  screenshot attempt during the prompt failed with "the handle is invalid" (Windows'
  Secure Desktop blocks screen capture during a genuine UAC prompt — a
  fake/scripted dialog would not do this), and the process could not be
  force-killed from an unelevated PowerShell ("Access is denied" — again, real UAC
  prompts are protected this way).

## Log file

`main.js`'s `log()`/`warn()` write to BOTH the console (when one exists) AND a file
at `coachbuild-overlay.log` inside this app's `userData` directory (path logged at
startup, and shown via tray → **"Open log file"**, which opens it in your default
text editor). This exists because `npm run start:admin` launches detached with no
console, and a packaged app (see "Install on another PC" below) has no console at
all — without this, every diagnostic (including the hotkey bind-status lines above)
would be invisible exactly when you need them most. The file is **truncated at
every startup** (not rolled) — it holds one run's worth of lines, so the workflow
is: relaunch, reproduce the issue, then read (or send) the log file.

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

## Install on another PC (2026-07-27, packaging round)

The user doesn't play League on this dev machine — they have a separate gaming
desktop. A git checkout + Node + npm + a held-open terminal is the wrong shape for
that, so this app can be packaged into a normal installable Windows app via
[`electron-builder`](https://www.electron.build/) (the one new devDependency added
this round).

**Build it (on the dev machine, once per release):**

```
cd overlay-host
npm install
npm run dist
```

This is a three-step chain (`npm run dist:unpacked && npm run dist:resources &&
npm run dist:package` — see "Why packaging needs a workaround" below for why it's
three steps instead of electron-builder's normal one-liner) and produces, in
`overlay-host/dist/` (gitignored — build artifacts, never committed):

- **`CoachBuild Overlay-Setup-0.1.0.exe`** — a normal NSIS installer. Recommended:
  double-click, choose an install directory (or accept the default), done. Installs
  per-user (no admin needed to INSTALL), to `%LOCALAPPDATA%\Programs\CoachBuild
  Overlay\` by default.
- **`CoachBuild Overlay-0.1.0-portable.exe`** — a single self-contained exe, no
  installer. Copy it anywhere (a USB stick, a folder) and run it directly. Use this
  if the user would rather not install anything.

**Copy ONE of those two files to the gaming PC** (a USB stick, cloud drive, network
share — however is convenient) and run it there. Nothing else from this repo needs
to go with it — the exe is fully self-contained (Electron runtime + this app's code
bundled inside).

**League of Legends must be running on THAT SAME machine.** This app talks to
`https://127.0.0.1:2999/liveclientdata/*` — Riot's own local API, loopback-only by
design. There is no remote/network mode and there never will be one; running the
overlay on one PC cannot show data for a game running on a different PC.

**The packaged app always launches elevated (Administrator).** This is
intentional and is the primary reason this app is packaged at all — see the exe's
embedded manifest (`requestedExecutionLevel: requireAdministrator` in
`package.json`'s `build.win` config). Every launch triggers a UAC prompt; this is
expected, not a bug or malware warning.

**SmartScreen will warn on first run** — the exe is genuinely unsigned (no code
signing certificate; this is a personal, single-user tool, not a distributed
product). Windows will show "Windows protected your PC". This is expected, not a
sign anything is broken: click **"More info"**, then **"Run anyway"**. This only
happens once per machine per exe (SmartScreen remembers after the first
approval).

**Settings do NOT carry over from a dev-machine test run.** `app.getPath('userData')`
keys off the app's `productName`/`appId` (`CoachBuild Overlay` /
`com.coachbuild.overlay`), which differs from running unpackaged via `npm start`
(which uses the Electron dev default, `Electron`). This means lane override and
ability-bar calibration will be UNSET the first time the packaged app runs on the
gaming PC — expected, not a bug. Just recalibrate once (tray → "Adjust overlay
position" or "Calibrate ability bar…") and it persists from then on, same as any
other run.

### Why packaging needs a workaround (read if `npm run dist` ever breaks)

electron-builder's normal one-command build (`electron-builder --win nsis
portable`) tries to edit the exe's icon/version-info/manifest via a `rcedit`
tool bundled inside its "winCodeSign" vendor package — **even though this app is
deliberately unsigned and no certificate is configured.** That vendor package
also contains macOS-only tooling (2 `.dylib` symlinks under `darwin/10.12/lib/`),
and extracting a `.7z` archive containing Windows symlinks requires either Windows
Developer Mode or an elevated process — confirmed directly on this machine (`mklink`
failed with "You do not have sufficient privilege to perform this operation").
electron-builder treats that as a hard failure and retries the ENTIRE
download+extract forever rather than proceeding without the 2 irrelevant files —
confirmed hanging 280+ seconds with no sign of recovering.

The fix (`scripts/apply-exe-resources.js`, full reasoning in its header comment)
splits the build into three steps:
1. `dist:unpacked` — `electron-builder --dir --win` with
   `build.win.signAndEditExecutable: false`, so electron-builder never attempts its
   own (blocking) resource-edit step.
2. `dist:resources` — `scripts/apply-exe-resources.js` downloads the SAME public
   `winCodeSign-2.6.0.7z` electron-builder would have, but extracts ONLY
   `rcedit-x64.exe`/`rcedit-ia32.exe` **by name** (skipping the macOS symlink
   entries entirely, so the privilege error never triggers), then runs rcedit
   directly with the same flags electron-builder's own code would use — setting
   the icon, version strings, AND (the actual point of packaging this app)
   `requestedExecutionLevel: requireAdministrator`.
3. `dist:package` — `electron-builder --win nsis portable --prepackaged
   dist/win-unpacked` builds the NSIS installer and portable exe from the
   already-edited directory (`--prepackaged` skips electron-builder's own
   packaging/signing step, since it already happened correctly in step 2).

This uses ONLY things already present after `npm install` (electron-builder's own
bundled `7zip-bin` for extraction, plus one HTTPS download of a public GitHub
release asset) — no second new dependency was added. If Windows Developer Mode is
ever turned on for this machine, electron-builder's normal single-command build
would likely work directly and this workaround becomes unnecessary (though it
would still work fine alongside it, just redundantly).

**Verified this round**: built clean from a completely fresh state (`dist/`
removed, the rcedit download cache cleared) — `npm run dist` completed in well
under a minute, produced both a working NSIS installer and a working portable exe,
each independently confirmed (`asar list`, extracting the NSIS/portable payloads
with 7-Zip, and running the unpacked app directly) to: contain every required file
(`main.js`, `preload.js`, `calibratePreload.js`, `lib/**`, `js/**`,
`vendor/skillEngine.js`, `assets/**`, `renderer/**`), carry the
`requireAdministrator` manifest on the ACTUAL app exe (not just the installer/
portable launcher stub, which correctly stays `asInvoker` — per-user installs
don't need elevation to install, only the app itself needs it to run), and launch
successfully end-to-end (renderer ready, IPC handshake completed, hotkeys attempted)
when run non-elevated with a temporary `asInvoker` copy used purely to sidestep UAC
for headless testing. Separately confirmed the REAL (requireAdministrator) exe
genuinely triggers Windows' UAC subsystem at launch — attempting to launch it via
PowerShell's `Start-Process` returned `"This command cannot be run due to the
error: The operation was canceled by the user"`, which is UAC's own cancellation
message after its prompt times out unattended, the same class of evidence used to
verify `start-admin.cmd` earlier in this project. **Not verified**: actually
clicking "Yes" on that prompt and confirming the app opens fully elevated end-to-end
on a real desktop session — that needs a human at the keyboard, same limitation as
every other UAC verification in this README.

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
