<!-- merged into HANDOFF.md 2026-07-27 16:12:19Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 round 9 (engy, Sonnet 5) — file logging + Ctrl+F12 root-cause fix + Windows packaging

Two tasks: make diagnostics visible outside a console (file logging), and package
the app as an installable Windows exe. Mid-task, the coordinator relayed the
confirmed root cause for the "Ctrl+F12 does nothing, even elevated" bug (Microsoft's
own docs: F12 is permanently reserved by Windows for the debugger) — folded that
fix into this round per instruction. All three pieces are in `overlay-host/`, edits
confined to `main.js`, `package.json`, `README.md`, plus one new file,
`scripts/apply-exe-resources.js`. Did NOT touch `renderer/ingame.{html,css,js}`,
`js/skillOrderData.js`, or `vendor/skillEngine.js` (engo's surface) — confirmed via
`git status`-equivalent review before finishing that only the allowed files
changed.

### 1. File logging (`main.js`)

- `log()`/`warn()` now tee to BOTH console (unchanged) and a file at
  `<userData>/coachbuild-overlay.log`. **Truncated at startup, not rolled** — this
  is a per-launch diagnostic file (relaunch, reproduce, read), not a historical
  log, so unbounded growth was never a risk; rolling would have been needless
  complexity. `initLogFile()` runs as the very first statement before the
  single-instance-lock check, so nothing before it can be silently lost.
- `registerHotkeys()` now logs BOTH `globalShortcut.register()`'s return value AND
  a follow-up `globalShortcut.isRegistered()` check, per hotkey, every startup.
  Also flags (WARN, not just log) any mismatch between the two.
- Startup now logs, in one place: app version (`app.getVersion()`),
  `app.isPackaged`, the elevation guess (moved earlier in the boot sequence, see
  below), and the primary display's `bounds` + `scaleFactor` (this dev machine:
  200% scaled, physical 3072x1920 / logical 1536x960 — noted in-log for the next
  person debugging on a different-DPI gaming PC).
- New tray item **"Open log file"** (`shell.openPath`).
- Small correctness fix, free side-effect of reordering for logging: moved
  `logElevationGuidance()` to run BEFORE `createTray()` (was after) — the tray's
  own elevation-guess row previously read the still-default `false` value on its
  very first render, only correcting itself after the next unrelated
  `rebuildTrayMenu()` call. Now correct from the first paint.

**Verified**: ran the app twice (dev-mode `npx electron .` with an isolated
`--user-data-dir`, AND the actual packaged exe with an isolated `--user-data-dir`)
— confirmed the log file is created, truncated on each relaunch, timestamped, and
byte-identical in content to what hit the console in both cases. Full log excerpt
from the packaged run is in this round's chat transcript; not re-pasted here for
length, but the short version: `packaged: true`, all four hotkey states, "renderer
announced ready" all present and correct.

### 2. Ctrl+F12 root cause + fix (`main.js`, `README.md`)

**Root cause (confirmed via Microsoft's own `RegisterHotKey` docs, verbatim quoted
in code comments)**: F12 is PERMANENTLY reserved by Windows for the debugger, in
any modifier combination, on every Windows machine, regardless of elevation.
`globalShortcut.register('...F12', ...)` therefore always returns `false`. This has
nothing to do with the elevation/UIPI theory the earlier rounds pursued — that
theory was chasing the wrong mechanism for over an hour.

- `HOTKEY_TOGGLE_ADJUST` changed from `Control+F12` → **`Control+Shift+A`** (not
  reserved, not a League default bind, mnemonic). Empirically confirmed via a live
  isolated-userData-dir run: `register()` returned `true`, `isRegistered()`
  confirmed `true` — while, in the SAME run, Ctrl+F10/Ctrl+F11 both returned
  `false` (expected: another already-running instance on this machine already
  holds those two globally — RegisterHotKey is exclusive system-wide per
  accelerator, so this is a real, informative signal, not noise).
- Added a startup GUARD: `registerHotkeys()` now regex-matches `/\bF12\b/i`
  against every accelerator BEFORE attempting to register it, refuses to even try,
  and fails loudly (console + log file + a dedicated tray row reading `— FAILED,
  reserved by Windows`) — so a future edit that picks F12 again is caught at
  startup instead of silently producing a dead hotkey for another debugging
  session.
- Tray menu reworked: what was one "Hotkeys: probably/may not respond" row
  (a guess, presented as an explanation) is now ONE ROW PER HOTKEY with its real
  measured status (`— active` / `— FAILED to bind` / `— FAILED, reserved by
  Windows`), plus a SEPARATE "Elevation: …" row explicitly reworded to "one
  possible factor if a hotkey fails only in-game" — no longer presented as THE
  explanation for any given failure.
- `logElevationGuidance()`'s log-file guidance line reworded the same way — check
  the tray/log's per-hotkey status FIRST (a fact), treat elevation as a secondary
  hypothesis only if a hotkey DID bind but still doesn't respond in-game.
- README's old "Hotkeys and elevation" section replaced with "Hotkeys and bind
  status", carrying the full root-cause writeup, the guard's rationale, and an
  explicit "STILL OPEN, not yet retested" note: whether Ctrl+F10/Ctrl+F11
  specifically respond in-game NOW THAT THE APP IS GENUINELY ELEVATED remains
  untested since elevating — those two are not reserved keys, so UIPI/focus
  remains a live, separate, unproven hypothesis for THEM specifically. Do not
  read this round as having resolved that part.

### 3. Windows packaging (`package.json`, `scripts/apply-exe-resources.js`, `assets/icon.ico`, `README.md`)

Added `electron-builder` (`^25.1.8`) as the one approved new devDependency. NSIS
installer + portable exe, both x64, `requestedExecutionLevel: requireAdministrator`
baked into the win config.

**Blocker hit and worked around, fully documented in both
`scripts/apply-exe-resources.js`'s header and README's "Why packaging needs a
workaround"**: electron-builder's normal one-command Windows build always tries to
edit the exe's icon/version/manifest via a `rcedit` tool bundled inside its
"winCodeSign" vendor package — even fully unsigned, even with no cert configured.
That vendor package also bundles 2 macOS-only `.dylib` symlinks, and extracting a
`.7z` with Windows symlinks needs Developer Mode or an elevated process — this
machine has neither (directly confirmed: `mklink` failed with "You do not have
sufficient privilege to perform this operation", and `HKLM\...\AppModelUnlock`'s
`AllowDevelopmentWithoutDevLicense` key doesn't exist). electron-builder treats the
2-file failure as a hard error and retries the ENTIRE download+extract forever
rather than proceeding without them — confirmed hanging 280+ seconds with zero
sign of self-recovery, had to `taskkill` it.

**Fix**: a 3-step build (`dist:unpacked` → `dist:resources` → `dist:package`,
composed by `npm run dist`). Step 2 (`scripts/apply-exe-resources.js`) downloads
the SAME public winCodeSign archive electron-builder would, but extracts ONLY
`rcedit-x64.exe`/`rcedit-ia32.exe` **by explicit filename** (7-Zip's `e` mode),
which never touches the 2 problem symlink entries and so never trips the privilege
error — then runs rcedit directly with the same flags electron-builder's own
`signAndEditResources()` uses. No second dependency was added: the rcedit binaries
and the 7-Zip binary used to extract them are both already transitive dependencies
of electron-builder.

**Verified, from a genuinely clean state** (`dist/` removed, the rcedit download
cache cleared — i.e. this is NOT relying on leftover session cache, it re-downloads
for real): `npm run dist` completed in well under a minute and produced both
installers. Checked, not assumed:
- `asar list` on `dist/win-unpacked/resources/app.asar` — every required file
  present (`main.js`, `preload.js`, `calibratePreload.js`, `lib/**`, `js/**`,
  `vendor/skillEngine.js` — NOT `vendor/_selfTest-highlight.mjs`, excluded on
  purpose, `assets/**`, `renderer/**`), nothing missing, nothing extra.
- Extracted BOTH `CoachBuild Overlay-Setup-0.1.0.exe` and
  `CoachBuild Overlay-0.1.0-portable.exe` with 7-Zip and confirmed the ACTUAL app
  exe inside each carries `requestedExecutionLevel="requireAdministrator"` in its
  manifest (byte-inspected, not inferred) — while the installer/portable LAUNCHER
  stub correctly stays `asInvoker` (per-user install location, no elevation needed
  to install; only the app itself needs elevation to run — this is correct, not a
  miss).
- Ran the packaged app directly (a temporary `asInvoker`-patched copy, used ONLY to
  sidestep UAC for headless testing — the shipped artifacts are untouched
  `requireAdministrator`) with an isolated `--user-data-dir`: full boot succeeded,
  `packaged: true` logged, asar path resolution worked end-to-end (`loadFile`,
  `preload.js`, `lib/*`, `vendor/skillEngine.js` all resolved correctly inside the
  asar), IPC readiness handshake completed ("renderer announced ready"), hotkey
  registration ran and logged correctly (Ctrl+Shift+A bound; Ctrl+F10/F11 correctly
  reported as already-held by the other running dev instance).
- Separately confirmed the REAL (`requireAdministrator`) exe genuinely triggers
  Windows UAC at launch: PowerShell's `Start-Process` against it returned "This
  command cannot be run due to the error: The operation was canceled by the user"
  — UAC's own cancellation message after an unattended prompt times out. Same
  class of evidence as the earlier `start-admin.cmd` verification in this project.

**Also produced**: `assets/icon.ico` (a proper multi-size .ico — 16/24/32/48/64/
128/256 — nearest-neighbor upscaled from the existing 16×16 `tray-icon.png` to
preserve its pixel-art look, built via `sharp`+`png-to-ico` borrowed from
`urgot/.smoke-tools/node_modules` for this one-off, NOT added as a project
dependency).

**NOT verified, stated plainly**:
- Actually clicking "Yes" on a real UAC prompt and confirming the packaged app
  opens fully elevated end-to-end on an interactive desktop — needs a human at the
  keyboard, same limitation every UAC check in this project has had.
- Whether Ctrl+F10/Ctrl+F11 respond while League has focus NOW THAT THE APP IS
  GENUINELY ELEVATED — untested since elevating (see hotkey section above).
- The exe was NOT run on a second/different machine (no gaming PC available to
  this agent) — "copy the exe to another PC and run it" is inherently something
  only the user can complete. Packaging correctness (files present, manifest
  correct, boots and resolves paths) was verified as thoroughly as a single-machine
  agent can.
- SmartScreen's actual warning dialog was not triggered/observed (would require an
  unsigned exe's first run on a machine that hasn't seen it before, plus
  interactive dismissal) — documented in the README from known Windows behavior,
  not from having seen it fire in this session.

**Minor, not fixed**: electron-builder prints `author is missed in the
package.json` on every run. Cosmetic only (doesn't affect the build), but adding an
`author` field would silence it — left alone since inventing a name wasn't this
agent's call to make.

Files touched: `overlay-host/main.js`, `overlay-host/package.json`,
`overlay-host/README.md`, `overlay-host/scripts/apply-exe-resources.js` (new),
`overlay-host/assets/icon.ico` (new). Did not touch
`overlay-host/renderer/ingame.{html,css,js}`, `overlay-host/js/skillOrderData.js`,
or `overlay-host/vendor/skillEngine.js`.
