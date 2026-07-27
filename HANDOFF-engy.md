<!-- merged into HANDOFF.md 2026-07-27 17:18:40Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 round — seamless auto-update (overlay-host)

**Task:** make the packaged overlay app update itself without the user quitting
and manually reinstalling on their separate gaming PC — full brief context and
reasoning now lives in `overlay-host/README.md`'s new "Auto-update" section
(elevation reasoning, portable-target caveat, publish command, exactly what
was/wasn't verified — not duplicated here to avoid drift between two copies).

**What changed:**
- `overlay-host/package.json`: added `electron-updater` (^6.8.9, real
  `dependencies`, not dev) — the one new runtime dep approved. Bumped
  `0.1.0` → `0.2.0` (a real delta to test an update against, once published).
  Added `build.publish` (github provider, `haroutB5/coachbuild-overlay-releases`,
  the public binaries-only repo you'd already created empty). Added
  `dist:publish` npm script (three-step build chain + `--publish always`,
  reads `GH_TOKEN` from env — nothing hardcoded).
- `overlay-host/lib/autoUpdater.js` (NEW): owns all `electron-updater` wiring
  — background auto-download, the `inGame`-gated deferred install
  (`quitAndInstall(true, true)` only fires when not in a game), a status
  state machine for the tray, and a periodic 4h check + one 10s-after-launch
  check. Every event logs through the callback passed from `main.js` (so it
  lands in the existing file logger). Guards `!app.isPackaged` (dev `npm
  start` runs) by disabling cleanly rather than failing checks with no feed.
- `overlay-host/main.js`: requires the new module, calls
  `autoUpdaterModule.init(...)` in `app.whenReady()` (after tray/window/
  hotkeys/poll are up), calls `notifyGameEnded()` from the EXISTING
  `inGame = false` transition inside `pollActivePlayer()`'s catch block (the
  same place that already logs "game no longer detected"), calls
  `shutdown()` in `will-quit`, and adds two tray rows: a live, non-clickable
  status row (`Update: checking…` / `downloading 42%` / `ready — installs
  when you finish your game` / `Up to date (vX.Y.Z)` / an error message) and
  a `Check for updates now` manual-trigger row (disabled unpackaged).

**Verified by actually building** (not just written): `npm start` (unpackaged)
confirms the module initializes and logs its dev-disabled state with zero
crash/side-effect on the rest of startup. Full three-step packaging chain
(`dist:unpacked` → `dist:resources` → `dist:package`) ran clean from an empty
`dist/`; confirmed via `npx asar list` that `electron-updater` + deps are
bundled into `app.asar` automatically (production `dependencies` get pulled
in by electron-builder regardless of the explicit `files` allowlist — no
`node_modules/**/*` entry needed); confirmed `dist/latest.yml` is generated
correctly by the `--prepackaged` step (version `0.2.0`, real `sha512`, real
size) — this was the specific risk flagged in the brief and it does NOT
silently fail; re-confirmed the built exe still carries
`requestedExecutionLevel: requireAdministrator`.

**Did NOT publish** — that's explicitly yours to run:
`GH_TOKEN=<token> npm run dist:publish` from `overlay-host/`.

**Not verified, stated plainly:** any real end-to-end update cycle (there is
only one version, unpublished, in existence). Whether a UAC prompt appears
when the already-elevated running app spawns the silent NSIS installer —
reasoned through in the README (child processes inherit an elevated parent's
token, so it should be silent) but not observed. Whether `quitAndInstall`'s
auto-relaunch comes back up cleanly on a real machine. Portable-target
auto-update behavior (untested; NSIS-installed is the verified/intended path).

Files: `overlay-host/package.json`, `overlay-host/lib/autoUpdater.js` (new),
`overlay-host/main.js`, `overlay-host/README.md`.
