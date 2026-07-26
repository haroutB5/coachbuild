# CoachBuild Desktop — plan for review

## Hard constraint (user directive, 2026-07-26)

**The web app stays, mobile included, and keeps being updated.** The desktop shell is a CLIENT of
the web app, never a fork of it. Consequences, and they are not negotiable:

- One codebase, one deployment. A web deploy must update browser, phone and the desktop shell at
  the same moment. This is the argument that settles "remote-load vs bundle" below — bundling means
  the desktop lags every web fix behind its own release cycle, and the phone gets features the
  desktop does not.
- **No desktop-only code inside the web app.** Shell chrome (title bar, overlay window, tray) lives
  in the shell. Anything the web app must know about the shell is feature-detected at runtime, so a
  phone never renders desktop furniture.
- Mobile-specific behaviour that exists today stays exactly as it is: the 4-destination bottom tab
  bar (`<lg`), no Draft and no Companion on mobile (deliberate, see `CLAUDE.md`).
- The UI/UX findings from the 2026-07-26 audit are WEB work, not desktop work — fixing them
  improves phone and browser too. The desktop shell must not become the excuse to stop improving
  them.

## Why at all

Three bugs shipped on 2026-07-26 were all the same bug: **the browser is a process we do not
control.**

- `AttachWindowSeconds = 150` exists only because Chrome throttles hidden-tab timers to ~1/min.
- The `detach=1` beacon exists only because a closed browser is otherwise invisible to us.
- `Test-BrowserProcessRunning` exists only because `pagehide` never fires on a task-kill.
- v1.6.4 itself existed because champ-select re-opened tabs and they stacked 4 deep.

None of those failure modes exist when we own the window. That is the whole argument; everything
else (overlay, hotkeys, tray, auto-start) is a bonus.

## The key insight — the shell is a drop-in `companion.ps1`

`companion.ps1` already speaks a versioned HTTP wire contract to the web app on
`127.0.0.1:48291-48293`: `GET /status`, `GET /live`, `POST /apply-runes`, `POST /apply-itemsets`,
exact-Origin CORS, `?session=<token>` on every request (`components/live/companionClient.ts` is the
client side).

If the desktop shell hosts **the same bridge on the same ports with the same contract**, then:

- the existing web app runs **unchanged** inside the shell — `companionClient` cannot tell the
  difference, so Builds/Draft live-follow, auto-export and Apply Runes all work on day one;
- the same build keeps working in a plain browser with `companion.ps1`, so nothing is orphaned;
- there is exactly one web codebase and one deployment, not a fork.

The shell replaces `Start-Process` (open a browser tab) with `win.loadURL` (navigate our own
window). That is the line where all four bugs above die.

## Stack decision — Electron

| | Tauri | Electron |
|---|---|---|
| Toolchain on this machine | **Rust + MSVC build tools absent** (~2 GB install, slow first build) | `node v24.18.0`, `npm 11.16.0` present |
| Bridge/LCU code | Rust rewrite of `companion.ps1` | Node — same language as the repo, direct port |
| Binary size | ~10 MB | ~90 MB |
| Runtime RAM | lower (system WebView2) | higher (bundled Chromium) |

Choosing **Electron**: the LCU bridge is the bulk of the work and it is a direct port of existing
logic into Node. Tauri's wins are real but they are size/RAM, not capability, and they cost a Rust
toolchain plus a rewrite of the one component that must not regress.

## Architecture

```
electron/
  main.ts          BrowserWindow, tray, single-instance lock, auto-start
  bridge.ts        the companion HTTP bridge (ports 48291-3, same contract)
  lcu.ts           lockfile discovery + gameflow/champ-select polling
  apply.ts         rune pages + item sets (port of Invoke-ApplyRunes / Merge-ItemSets)
  preload.ts       contextIsolated; exposes NOTHING to remote content
```

- **Window loads `https://coachbuild.vercel.app`** (remote, not bundled): one deployment, ships web
  fixes without a desktop release.
- **`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.** Remote content gets zero
  Node. The bridge is reached the same way it is in a browser — over loopback HTTP with the session
  token — so remote content never holds privileged handles.
- **Navigation allowlist**: only `coachbuild.vercel.app` may load in-window; anything else opens in
  the system browser.

## What replaces tabs

`Update-ChampSelectState`'s decision table (open Builds / open /draft / suppress) collapses to:
champ select resolves a champion → the window navigates to the Builds deep link, and Draft is a
second view we can show side by side. No attach window, no open grace, no detach beacon, no browser
process probe — all of it deleted, not ported.

## UI/UX

- Frameless window with a custom title bar matching the app's navy/gold shell.
- **Champ-select overlay mode**: compact always-on-top window (runes + core items + apply button),
  auto-shown on champ select, auto-hidden on game start. This is the thing a browser can never do.
- Tray icon with client/lobby/champ-select/in-game state; click to raise.
- Auto-start on login (opt-in), single-instance lock.
- Global hotkey to raise/hide.

## Ship / risk

- `electron-builder` NSIS installer. **Unsigned → SmartScreen warning** on first run; signing is a
  paid cert and a later decision.
- Auto-update via `electron-updater` against GitHub releases.
- Compliance posture is unchanged from `companion.ps1`: read the LCU, write rune pages and item
  sets, never act on the game. The bright lines in `CLAUDE.md` ("Companion page/set ownership",
  no auto-pick/ban, no cooldown computation) carry over verbatim.
- `companion.ps1` stays supported for browser users; the wire contract is the shared spec.

## Questions I want challenged

1. Electron vs Tauri given no Rust toolchain — is size/RAM worth the toolchain and the rewrite of
   the one safety-critical component?
2. Loopback HTTP from our own window is architecturally silly. Is keeping the bridge (for one
   codebase + browser parity) worth the overhead, or should the desktop path use preload IPC and
   let the web app branch on "am I in the shell"?
3. Remote-load vs bundling the Next.js app. Remote = one deployment; bundled = works offline and
   can't be broken by a bad deploy. Which is right for a tool used mid-champ-select?
4. Is the overlay the actual product and the full window secondary?
5. What breaks that I have not listed?
