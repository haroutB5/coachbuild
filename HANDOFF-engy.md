<!-- merged into HANDOFF.md 2026-07-27 13:50:29Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 (round 3) — PIVOT: Overwolf blocked, built `overlay-host/` (Electron) instead

Model: Sonnet 5 (claude-sonnet-5).

**Why the pivot is real, not precautionary:** Overwolf requires an approved App
Proposal to whitelist API access, doesn't approve private apps, and won't approve
any app that skips Overwolf ads/subscriptions — verified verbatim at
`https://dev.overwolf.com/ow-native/getting-started/project-roadmap/`. The user hit
"Unauthorized App" on this real machine while logged in. `overwolf/` is left
untouched on disk (not deleted, per instruction) but is not the path forward.

### What's new: `C:/Claude/AI/coachbuild/overlay-host/`

```
package.json          own deps (electron devDependency only) -- does NOT touch
                       the Next.js app's package.json/node_modules
main.js                Electron main process: window, hotkeys, polling, IPC
preload.js              contextBridge -> window.coachbuildIPC (renderer stays
                        contextIsolation:true + sandbox:true, no Node access)
lib/gameState.js        ported from overwolf/js/gameState.js, CommonJS
lib/liveClientHttp.js   new -- Node https client for Riot's local API,
                        loopback-scoped TLS bypass
renderer/ingame.html    copied byte-for-byte from overwolf/ingame/ingame.html
renderer/ingame.css     copied byte-for-byte from overwolf/ingame/ingame.css
renderer/ingame.js      copied from overwolf/ingame/ingame.js -- ONLY the bottom
                        "Transport" block changed (Overwolf sendMessage -> IPC)
js/skillOrderData.js    copied byte-for-byte from overwolf/js/skillOrderData.js
README.md               prerequisite (Borderless/Windowed, not Fullscreen),
                        load/test steps, what's verified vs not
```

### What was reused as-is vs. what changed

- **`js/skillOrderData.js`, `renderer/ingame.html`, `renderer/ingame.css`** —
  byte-for-byte copies. Zero changes. All of engo's audit-hardened logic (the
  9 audit fixes noted in `ingame.js`'s comments, the compliance-critical
  level-indexed-not-points-spent highlight logic, the 200-with-null contract)
  carries over untouched.
- **`renderer/ingame.js`** — copied, then ONLY the "Transport" section at the
  bottom replaced (Overwolf's `overwolf.windows.onMessageReceived`/`sendMessage`
  → `window.coachbuildIPC.onState`/`.onInteractiveChange`/`.ready()`, exposed by
  `preload.js`'s `contextBridge`). The public contract
  (`window.CoachBuildOverlay.onState(state)` /
  `.onInteractiveChange(isInteractive)`) is unchanged — same function names, same
  payload shapes. The READY-handshake reasoning is preserved verbatim (a push
  sent before the renderer's listener attaches is dropped, not buffered, in
  Electron's `webContents.send` exactly as it was in Overwolf's `sendMessage`).
- **`lib/gameState.js`** — ported from `overwolf/js/gameState.js`. Same parsing:
  the `Passive`-key exclusion (only `['Q','W','E','R']` iterated), the
  all-or-nothing gate on level+abilities, `riotId`-matched champion resolution
  preferring `rawChampionName`. Only mechanical change: ES module exports →
  CommonJS `module.exports`, because this file now runs in Electron's Node-based
  main process instead of a browser `<script type="module">` context. The
  `coerce()` string/object-duality helper was KEPT (not stripped) — GEP-specific
  in origin but costs nothing defensively against Riot's direct API.
- **Everything else is new**: `main.js` (window lifecycle, hotkeys, polling loop,
  IPC), `preload.js` (contextBridge surface), `lib/liveClientHttp.js` (the Node
  `https` client with the loopback-scoped TLS bypass).

### Window requirements — implemented exactly as specified

`frame:false`, `transparent:true`, `alwaysOnTop:true` set via
`setAlwaysOnTop(true, 'screen-saver')` (the level that actually stays above a
game, not the constructor's plain flag alone), `skipTaskbar:true`,
`resizable:false`, `focusable:false`. Click-through by default via
`setIgnoreMouseEvents(true, {forward:true})`, toggled at runtime by
`toggleInteractive()`. Window created with `show:false` and shown via
`showInactive()` on `ready-to-show` (NOT `show()`, since the window is
non-focusable — `showInactive()` is the documented way to display without ever
attempting to take focus). Position: 340×520 at top:110/left:24, same
upper-left reasoning as the Overwolf build (ported verbatim from
`manifest.README.md`'s note, same caveat: general LoL HUD-layout knowledge, not
an observed screenshot on this machine).

### Data path — direct polling, no GEP

`lib/liveClientHttp.js` polls `/liveclientdata/activeplayer` (every 1.5s while a
game is detected, 5s while idle) and `/liveclientdata/playerlist` (every 4s,
only while in-game and champion name is still unresolved). There is no separate
"is League running" check — a successful `/activeplayer` call IS the definition
of "in game" in `main.js`; any failure (connection refused, timeout, bad JSON,
non-2xx) is treated identically as "no game," silently, matching the brief.
TLS: a single `https.Agent({rejectUnauthorized:false})` in `lib/liveClientHttp.js`,
constructed once, used ONLY by the two fetch functions in that file — never a
global bypass, never touching `app.on('certificate-error')` (which would apply to
BrowserWindow navigation too; the Agent approach is strictly narrower since the
renderer never itself makes HTTPS calls to Riot's API). Matches
`public/companion.ps1`'s `Initialize-TlsShim` scoping precedent, ported to Node's
own idiom rather than copied literally (PowerShell's cert-callback approach
doesn't apply to Node's `https` module).

### Compliance — unchanged, re-confirmed

Still a passive static levels 1–18 table, current level highlighted, no
imperative copy. `resolveNextSkill` is not imported anywhere in `overlay-host/`
(same as the Overwolf build — grep-confirmed). `resolveChampionName` in
`lib/gameState.js` reads ONLY the local player's own `riotId`-matched entry off
the player list; `main.js`'s `resolveChampionNameNow()` discards the rest of the
array immediately after the call returns — nothing about any other player is
stored, logged, or rendered. Riot disclaimer text is unchanged, rendered by the
reused `ingame.html`/`ingame.css`/`ingame.js`.

### Verification — what I actually ran, not what should work

1. `node --check` on every `.js` file in `overlay-host/` (`main.js`,
   `preload.js`, `lib/gameState.js`, `lib/liveClientHttp.js`,
   `renderer/ingame.js`, `js/skillOrderData.js`) — all pass.
2. A 13-assertion CommonJS port of the `gameState.js` test suite — level/ability
   parsing, `Passive`-key exclusion, all-or-nothing gate, `riotId` extraction,
   `rawChampionName`-preferred champion resolution, `mergeState`/`emptyStateFor`,
   `toFiniteInt` coercion, **plus a new assertion using the EXACT real captured
   payload shape from `_capture/live-client-raw-20260727-140136.jsonl`'s RAW
   `/activeplayer` dump** (level=1, all four ability ranks legitimately 0 —
   confirms real zeros parse as zeros, not as "missing"). All 13 pass.
3. `npm install` in `overlay-host/` — succeeded, Electron 32.3.3 binary present
   at `node_modules/electron/dist/electron.exe` (confirmed the postinstall
   binary download actually completed despite an `allow-scripts` warning in the
   npm output).
4. **Actually launched the app**: `node_modules/electron/dist/electron.exe .`,
   run in the background, no game running. Captured console output:
   ```
   [CoachBuild:main] CoachBuild Overlay Host starting
   [CoachBuild:main] hotkeys registered: Control+F10 (show/hide), Control+F11 (interactive toggle)
   [CoachBuild:main] renderer announced ready — replaying current state
   ```
   The third line is the important one: it's not just "the process didn't
   crash" — it's a full IPC round-trip (preload's `contextBridge` exposed
   `window.coachbuildIPC` correctly → `renderer/ingame.js`'s transport code ran
   and called `.ready()` → `main.js`'s `ipcMain.on('coachbuild-ready')` fired →
   replied with `pushState()`/`pushInteractiveChange()`), proving the whole
   plumbing chain works, not just window creation.
5. Confirmed a REAL OS window was created (not just a Node process): launched a
   second instance to exercise the single-instance lock (it correctly detected
   the first and quit, logging `another instance is already running`), then
   independently confirmed via `Get-Process electron | Select Id,
   MainWindowTitle, MainWindowHandle`: PID 15364 had `MainWindowTitle:
   "CoachBuild Overlay"` and a non-zero `MainWindowHandle` (460330). The other 3
   `electron.exe` processes had no window handle, which is the normal Chromium
   multi-process architecture (GPU/renderer/network helper processes), not a
   problem.
6. Let it run ~15 seconds total with no game — no further log lines appeared
   (correct: idle polling every 5s is silent by design, no exceptions), then
   force-killed all `electron.exe` processes via `Stop-Process` to clean up.
   (The background bash job that launched it then reported `status: failed,
   exit code 127` — that's the job-control system reporting the external kill,
   not a launch failure; the log capture and `MainWindowHandle` evidence above
   were both gathered BEFORE the kill, while the app was genuinely running.)

### What remains unverified — explicit, before anyone trusts this live

- **The entire live data path against a real game** — `/activeplayer` and
  `/playerlist` have never actually been polled by `lib/liveClientHttp.js`
  against a running League client from this exact code. The endpoint shapes are
  taken from the real capture file (captured by a DIFFERENT tool,
  `companion.ps1`'s TLS-shimmed path) and Riot's published API, not from this
  file having been exercised end-to-end.
- **On-screen appearance over an actual game** — never seen rendered on top of
  League. The upper-left position reasoning is carried over from the Overwolf
  build and was already flagged there as unverified; still unverified here.
- **Global hotkeys with League actually focused and in Borderless/Windowed
  mode** — registered successfully with no game running (confirmed above), but
  Electron's `globalShortcut` behavior specifically while an exclusive input
  context (a game) holds focus was not tested.
- **Interactive-mode clicking** — `setIgnoreMouseEvents(false)` was called
  successfully (no exception) when toggling via a manual test, but whether the
  lane buttons actually RECEIVE and register clicks on a `focusable:false`
  window is a genuine, real platform question I could not resolve by reasoning
  alone and did not have a live scenario to click-test against. This is the
  single highest-risk unverified item — worth checking first.
- **The Borderless/Windowed-only prerequisite** — stated as fact from general
  Windows compositor/game-overlay knowledge (this is why Discord/Overwolf/every
  such tool carries the same caveat), not from testing this app against League
  in exclusive Fullscreen mode specifically.

### Files touched this round
New: everything under `overlay-host/`. Nothing under `overwolf/`, `js/`,
`app/`, `components/`, `lib/` (the Next.js app's, not `overlay-host/lib/`), or
`public/companion.ps1` was touched. No version bump, no `CHANGELOG.md` edit, no
deploy.
