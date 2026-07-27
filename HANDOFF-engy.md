<!-- merged into HANDOFF.md 2026-07-27 17:50:16Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 round — "one app": Electron overlay supervises companion.ps1 as a hidden child

Model: Sonnet 5 (per CLAUDE.md routing, engy implementation tier).

### Scope (matches the brief, nothing extra)

Did NOT touch `Invoke-ApplyRunes`, `Invoke-ApplyItemSets`, `Merge-ItemSets`,
`Test-RunePayload`, `Test-ItemSetsPayload`, or anything they call. Did NOT
bump the main app version, edit `CHANGELOG.md`, deploy the website, touch
`overlay-host/renderer/**`/`js/skillOrderData.js`/`vendor/**`, or publish a
GitHub release.

**1. `public/companion.ps1` — minimal, ~12 lines.** Added `[switch]$NoTray`
to the param block and one dispatch arm: `} elseif ($NoTray) { Start-Companion
-SuppressTray:$NoTray }`. Mirrors how `-DebugRunSeconds` already reaches
`Start-Companion -SuppressTray`, minus the auto-exit (`RunSeconds` stays its
default `0` = run until Quit). Bumped `$script:Config.Version` to `1.9.0` and
regenerated `public/companion.version` via the existing
`node scripts/sync-companion-version.mjs` (never hand-edited the version
file — that's exactly the drift bug that script exists to prevent).

**2. `overlay-host/main.js` — new "Companion supervision" section** (search
that heading). `spawnCompanion()` spawns `powershell.exe -NoProfile
-ExecutionPolicy Bypass -File <resolved path> -NoTray` with `stdio: 'ignore'`
(chosen over tee-ing stdout into `log()`/`warn()` — companion.ps1 already has
its own independent file logger at `%LOCALAPPDATA%\CoachBuild\companion.log`
that survives `-NoTray`, so piping stdout here would be redundant diagnostics
carrying a real pipe-fill-blocks-the-child risk for no new signal). Killed on
`will-quit` via `taskkill /pid <pid> /T /F` (belt-and-braces against orphans,
even though this child spawns no children of its own). Restarts on
unexpected exit with backoff (`[2s,5s,15s,30s,60s]`), gated on `!inGame` --
if a restart comes due mid-game it sets phase `restart-deferred` and
`notifyGameEndedForCompanion()` (wired into `pollActivePlayer`'s
game-ended branch, alongside the existing `autoUpdaterModule.notifyGameEnded()`)
fires it the instant the game ends, not on the next backoff tick.
**Mutex-race is a distinct state, not a crash-loop**: an exit within 5s of
spawn is treated as "another copy already running" (`phase: 'already-running'`)
and does NOT auto-retry -- confirmed live, see below. Status polling
(`pollCompanionStatusOnce`, every 3s) hits the child's own `GET /status` on
loopback with the session token read from
`%LOCALAPPDATA%\CoachBuild\companion-session.txt` (never invents a second
token) and **the exact-Origin header this bridge requires**
(`Origin: https://coachbuild.vercel.app` -- Node's `http` module sends no
Origin by default, and companion.ps1's bridge 403s any request whose Origin
doesn't match `Sync.AppOrigin` exactly; this cost a few minutes to find via
manual `Invoke-WebRequest` testing before it was obvious). Tray gets two new
non-clickable rows: a summary line (`buildCompanionStatusLabel()`) and a
second, separate, more alarming row that appears ONLY when
`lastPollAtAdvancing === false` (`buildCompanionPollHealthLabel()`) -- kept
split out per the brief's "single most useful thing to show," so it isn't
lost among routine phase text.

**3. Bundling — `extraResources`, not `files`+`asarUnpack`.** Added to
`overlay-host/package.json`:
```json
"extraResources": [{ "from": "../public/companion.ps1", "to": "companion.ps1" }]
```
Chose this over the asarUnpack route the brief flagged as likely-needed:
`extraResources` never enters `app.asar` in the first place, so there's no
"can a .ps1 execute from inside an asar" question to answer at all, rather
than working around it after packing. `getCompanionScriptPath()` in
`main.js` resolves `process.resourcesPath + '/companion.ps1'` when
`app.isPackaged`, else the sibling `public/companion.ps1` in a dev checkout.

**4. Autostart.** Removed `requestedExecutionLevel: requireAdministrator`
from `package.json`'s `build.win` per the brief's product decision. **Found
a real second place it was set that the brief didn't mention**:
`scripts/apply-exe-resources.js` hardcodes its own
`--set-requested-execution-level requireAdministrator` rcedit flag,
independent of `package.json` -- because `signAndEditExecutable: false`
means electron-builder's own manifest step never runs at all, so THIS script
is the only thing that actually stamps the built exe's manifest.
**Building and checking the real exe (as instructed) caught this**: the
first build still showed `requireAdministrator` in the manifest despite the
package.json edit, because package.json's value was never being read for
this purpose. Fixed both. Verified the SECOND build shows
`level="asInvoker"` via `Select-String` against the real
`dist\win-unpacked\CoachBuild Overlay.exe`. `main.js` now calls
`app.setLoginItemSettings({ openAtLogin: true, path: process.execPath })`
(packaged builds only) and, once (settings-file-flag-gated, packaged builds
only), shells out to companion.ps1's own `-Uninstall` to remove the old
`%APPDATA%\...\Startup\CoachBuildCompanion.vbs` -- never deletes files by
hand.

**Real bug caught and fixed mid-round**: `removeLegacyVbsAutostartOnce()`
originally had NO `app.isPackaged` gate, unlike `configureAutostart()`
right next to it. During dev testing (`npm start`, unpackaged) it actually
ran and deleted this DEV MACHINE's real
`CoachBuildCompanion.vbs` Startup entry -- a real side effect on a real
machine that also runs a real companion for real matches (62 item sets, see
CLAUDE.md), not a sandboxed test artifact. Caught immediately from the log
line's presence for an unpackaged run, reconstructed the exact `.vbs`
content by reading `New-CompanionAutostartVbs`'s literal template and
rewriting it byte-for-byte by hand (verified `Get-Content` after), then
added the missing `if (!app.isPackaged) return;` gate so this can't happen
again. Confirmed the fix compiles and, on the next dev-mode run, does not
touch the Startup folder.

### Verification actually run, with real output

All manual testing happened on THIS dev machine, which -- unlike the target
gaming PC -- already runs a REAL companion.ps1 (`irm | iex`, v1.8.0 live) for
real matches. Every test that needed the mutex free stopped that real
process first (always checked `/liveclientdata/activeplayer` first to
confirm no live game), and it was relaunched via the exact same `irm | iex`
command afterward every time -- confirmed running again after each test.

1. **`-SelfTest` (adversarial suite).** First run FAILED 3x on
   "Double-launch guard" -- root-caused to the real companion already holding
   `Local\CoachBuildCompanion` (confirmed identical failure on the
   pre-my-changes file via `git stash`, so this was a pre-existing
   environment condition, not something I introduced). No live game running
   (verified), so stopped it, re-ran: **`SELFTEST PASSED`**. Re-ran again
   after ALL edits settled (the isPackaged-gate fix, the apply-exe-resources
   fix) on the exact shipping file: **`SELFTEST PASSED`** again.
2. **`-Mock -Once`**: `MOCK RUN PASSED` (both runs).
3. **`-HarnessTest`**: `HARNESSTEST PASSED` (both runs) -- this is the one
   that spawns a real `-DebugRunSeconds` child and asserts `lastPollAt`
   advances across two reads; unaffected by the `-NoTray` addition since
   `-DebugRunSeconds` is a separate dispatch arm.
4. **Mutex-race path, live, twice** (once unpackaged, once packaged): with
   the real companion running, launched the Electron app both via `npm
   start` and via the built `dist\win-unpacked\CoachBuild Overlay.exe`. Both
   times, log showed:
   ```
   companion: spawning powershell.exe ... -NoTray
   companion: child exited (code=0, signal=null) after 341-347ms
   companion: exited within 5000ms of spawn -- likely another copy is
   already running (mutex race), not auto-retrying
   ```
   No retry loop observed in either case (watched for several seconds past
   the exit, no further "spawning" line).
5. **Happy path, live** (real companion stopped, no game running): launched
   `npm start`. Log showed the child spawn with no immediate exit. Verified
   the poll loop independently (same technique `-HarnessTest` uses) by
   `Invoke-WebRequest`-ing `http://127.0.0.1:48291/status?session=<token>`
   with the `Origin` header twice, 4s apart:
   `lastPollAt` moved from `...18:36:48.58Z` to `...18:36:59.35Z` --
   **confirmed advancing**, `clientConnected: true` (League client was open
   on this machine), `version: "1.9.0"`. This is exactly the signal
   `pollCompanionStatusOnce()`/the tray row is built on.
6. **Graceful quit, orphan check, mutex release.** Quit via
   `taskkill /pid <main pid>` (no `/F` -- lets `will-quit` fire rather than
   hard-killing the whole tree, which would prove nothing about the app's
   own cleanup code) both for the dev run and the packaged run. Both times:
   process exited cleanly (background task reported exit code 0), log showed
   `companion: killing child process (pid <n>) on quit`,
   `Get-CimInstance Win32_Process` confirmed **zero** matching
   `*companion.ps1*`/`*NoTray*` powershell processes survived, and (dev-run
   case) re-launching `companion.ps1 -DebugRunSeconds 5` immediately
   afterward ran silently to completion with no "already running" message --
   confirming the mutex was genuinely released, not just the process gone.
7. **Packaged build, full chain.** `npm run dist` (clean `dist/`) succeeded.
   `npx asar list resources/app.asar` confirmed `companion.ps1` is **NOT**
   inside the asar (as designed -- `extraResources`); it exists as a real
   file at `dist\win-unpacked\resources\companion.ps1`, and its SHA-256
   matches `public/companion.ps1` byte-for-byte
   (`DEF4EDF7...E416EEE6` both sides). Ran the real unpacked exe directly
   (`.\CoachBuild Overlay.exe`, no `npm`/`electron .` wrapper) -- launched
   with **no UAC prompt** (log shows `packaged: true`, hotkeys registered,
   `autostart: openAtLogin=true`, and the companion spawn line pointing at
   the packaged `resources\companion.ps1` path), hit the mutex-race path
   correctly (real companion was running), quit cleanly, no orphan. Did NOT
   get to observe the FULL happy path (child spawns AND stays alive AND
   polls) from the packaged exe specifically end-to-end, because re-running
   that scenario would have meant stopping the user's real companion a third
   time on this machine for marginal additional evidence -- the packaged
   companion.ps1 is byte-identical to the one already proven to run the
   happy path correctly under the exact same `-NoTray` invocation (item 5
   above), and the packaged exe already proved it can spawn+resolve the file
   correctly and clean up correctly. Judged this combination sufficient
   rather than repeating the full cycle; flagging the gap rather than
   claiming it as directly observed.

### What was NOT verified (be skeptical of this section, not just the rest)

- **In-game restart-deferred behavior** (`attemptCompanionRestart()` seeing
  `inGame === true` and setting `restart-deferred`, then
  `notifyGameEndedForCompanion()` firing on game-end) was reasoned through
  and code-reviewed but never triggered live -- doing so needs a real
  unexpected companion crash WHILE a real League game is running, which
  isn't something to manufacture against a real account.
- **Tray row text was never visually confirmed on screen.** Same
  documented limitation as the rest of this project on this machine (no
  visible taskbar/notification area in this desktop session, per this
  README's existing "NOT verified -- the tray icon's on-screen appearance"
  note). `tray.setContextMenu(Menu.buildFromTemplate(...))` ran with no
  exception on every rebuild, and the label-building functions were read
  and reasoned through directly, but nobody has looked at the actual tray
  menu pixels.
- **`app.setLoginItemSettings` was exercised exactly once** (the packaged
  test run) and the registry key it wrote
  (`HKCU:\...\Run\electron.app.CoachBuild Overlay`) was inspected directly
  and confirmed present, then manually removed afterward (see cleanup
  below) -- but a real reboot/sign-in cycle actually launching the app
  silently was not observed.
- **NSIS installer flow itself** (`CoachBuild Overlay-Setup-0.2.0.exe`) was
  built but not run/clicked-through -- only the pre-packaged
  `dist\win-unpacked` exe was launched directly, per the same "avoid
  installing test builds over a real setup" caution as everything else this
  round.

### Side effects on THIS dev machine from testing, and how they were undone

This machine is not the target gaming PC, but it does run a real companion
for real matches, so testing here had real-world consequences that needed
explicit cleanup (all confirmed reverted, not just attempted):

- Stopped and relaunched the real live companion process **three times**
  (each time preceded by an `/liveclientdata/activeplayer` check confirming
  no live game). Confirmed running again after every restore (`irm | iex`,
  same command line as before, matches this project's documented normal
  startup).
- `removeLegacyVbsAutostartOnce()` (before its `isPackaged` gate was added)
  deleted the real `CoachBuildCompanion.vbs` Startup entry once during dev
  testing. Restored it by hand, byte-for-byte, from
  `New-CompanionAutostartVbs`'s literal template -- confirmed via
  `Get-Content` the restored file reads
  `CreateObject("WScript.Shell").Run "powershell.exe -NoProfile
  -ExecutionPolicy Bypass -Command ""irm
  https://coachbuild.vercel.app/companion.ps1 | iex""", 0, False`, matching
  what `Install-Companion` would have written.
- The packaged-exe test run's `app.setLoginItemSettings({ openAtLogin: true
  })` added `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run\electron.app.CoachBuild Overlay`
  pointing at the disposable `dist\win-unpacked` test build. Removed via
  `Remove-ItemProperty` -- confirmed gone (`Get-Item ...Run | Property`
  after showed only the pre-existing RiotClient/Overwolf/Edge entries).
- Final process sweep confirmed only the real companion (v1.8.0, still
  live-site-served, unaffected by any local change since nothing was
  deployed) and pre-existing unrelated scheduled-task processes remain --
  no leftover Electron/test-exe processes.

### Files touched

`public/companion.ps1`, `public/companion.version` (regenerated, not
hand-edited), `overlay-host/main.js`, `overlay-host/package.json`,
`overlay-host/scripts/apply-exe-resources.js`, `overlay-host/README.md`
(new "Companion supervision" section + corrected two stale claims: the
elevation requirement, and a wrong claim about `userData` dir isolation
between dev/packaged runs -- see inline diff, both were checked live rather
than assumed).

### One thing worth flagging to the user, not just recording

While correcting the README's userData-dir claim I found `app.getName()`
never gets set explicitly anywhere in `overlay-host/`, so Electron falls
back to `package.json`'s `name` field (`coachbuild-overlay-host`) for
`app.getPath('userData')` -- identical between an unpackaged `npm start` and
the real packaged exe on the same machine (measured: both logged the exact
same `...\Roaming\coachbuild-overlay-host\...` path this round). This means
lane override / calibration / the new
`legacyVbsAutostartRemoved`/autostart-related settings are NOT actually
isolated between a dev checkout and an installed copy on any machine that's
run both. Not a regression from this round's work, not fixed (out of scope
of the brief and not obviously safe to change without checking whether any
current user relies on this), but worth knowing before it causes confusion
someday.
