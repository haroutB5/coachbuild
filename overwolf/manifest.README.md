# manifest.json — field-by-field notes

JSON has no comments, so this file carries the annotations that would otherwise sit
next to each field. Read this before changing `manifest.json`.

## `meta`
- `version` — **NOT** CoachBuild's web-app version (`package.json`). This is a
  separate, independently-versioned artifact (an `.opk`/unpacked folder), same
  relationship as `public/companion.ps1`'s own version number. Do not wire this to
  `NEXT_PUBLIC_APP_VERSION`.
- `minimum-overwolf-version` — set to `1.0.0`. **FIXED (S, 2026-07-27 audit):** was
  `0.120.0`, which is older than this code's own success-check convention.
  `owWindows.js`'s wrappers uniformly gate on `result.success` being truthy, a boolean
  that is a later Overwolf addition than the older `{status:"success"}`-string-only
  callback shape — on a client near the old `0.120.0` floor every wrapped window call
  could have rejected outright, sending `setRequiredFeatures` into its retry loop
  until exhaustion for no game-related reason at all. `1.0.0` is not independently
  pinned to an exact changelog entry either (that would need cross-referencing
  Overwolf's own release notes, not done here) — it's a deliberately conservative
  floor chosen to sit safely inside "definitely has the modern boolean convention"
  territory, well below the 1.131.304.3 this machine has installed, and well above
  the pre-1.0 releases the old float would have permitted.
- `icon` / `icon_gray` / `launcher_icon` — **placeholder assets** (`icons/icon.png`,
  `icons/icon_gray.png` are 1×1 transparent PNGs; `icons/launcher_icon.ico` is a
  minimal 1×1 ICO wrapping the same pixel). They exist so the manifest is
  well-formed and the app loads, not because they're real artwork. Replace before
  any real distribution — a 1×1 icon will render as a blank/invisible tray icon.

## `permissions`
- `"GameInfo"` — required for `overwolf.games.*` (detecting League is running,
  `getRunningGameInfo`) and for the GEP calls (`setRequiredFeatures`,
  `onInfoUpdates2`, `getInfo`) that `live_client_data` (level + ability ranks)
  comes through.
- `"Hotkeys"` — required for `overwolf.settings.hotkeys.onPressed` (both
  `toggle_overlay` and `toggle_interactive`).
- `"Web"` — required for `overwolf.web.sendHttpRequest`, which is how
  `js/liveClientHttp.js` reaches `https://127.0.0.1:<port>/liveclientdata/playerlist`
  to resolve the local player's champion name (not available from the GEP feature —
  see `js/gameState.js`'s header comment). Without this permission that call fails
  outright, not silently — you'd see a rejected promise, not a missing champion name
  with everything else intact.

## `data.game_targeting` / `data.game_events`
- `5426` = League of Legends. `10902` = the League **launcher** (client before a
  match starts) — both are targeted because GEP data and game-running detection
  should both fire while the client itself is open, not just mid-match. Both
  researched facts, not derived from docs available to this build environment.

## `data.windows`
- **`background`** — `is_background_page: true` marks it as the controller; it has
  no visible surface and is the only window `overwolf.games.events.*` is called
  from (per Overwolf's own guidance, and echoed in the brief this app was built
  from — GEP calls from a non-background window are the classic way to end up with
  a listener that silently never fires).
- **`ingame`**
  - `transparent` + `clickthrough: true` — starts as a pure passive HUD overlay:
    nothing to click, so nothing should ever intercept a game click by default.
    `clickthrough` here is the window's **initial** style only — see
    `toggle_interactive` below for the runtime flip.
  - `topmost` — stays above the game's own render surface.
  - `in_game_only: true` — Overwolf will not show this window outside of a
    supported running game; background.js still explicitly restores/hides it on
    game-running transitions rather than relying on this alone, since
    `in_game_only` governs *visibility eligibility*, not lifecycle.
  - `resizable: false`, `show_in_taskbar: false` — it's a read-only glanceable
    panel, not a real app window.
  - `size` / `start_position` — **340×520 at top:110, left:24** (upper-left,
    clear of the top edge). Reasoning (single-monitor user, this window is the
    *only* on-screen surface — see HANDOFF-engy.md §"Overlay position"): stays
    clear of the minimap + shop panel (bottom-right), the ability/item bar
    (bottom-center), the scoreboard/kill-feed/objective banners (top-center /
    top-right), and the chat log (bottom-left). Not verified against a live
    client render — the League HUD layout facts above are general knowledge, not
    something observed on this machine's actual game window.
- **`desktop`** — a normal, resizable, taskbar-visible window. This is the ONLY
  place the mandatory Riot disclaimer, lane selector, and (later) any ad/subscription
  surface can live — see `desktop/desktop.html`. It must be reachable before a game
  (champ select / client idle) since, per the one-monitor constraint, it is
  unreachable *during* one. **`background.js` always declares this window at
  startup but only auto-RESTORES (shows) it when launch origin indicates a real user
  action, not the automated `GameLaunch` trigger** — see `decideDesktopAutoOpen()`
  in `background.js` (fix for a P2 audit finding: it previously popped over the
  League client's loading screen on every automated launch).

## `data.hotkeys`
- Both use `"action-type": "custom"` rather than a built-in action, because
  `overwolf.settings.hotkeys.onPressed` in `background.js` decides what happens —
  full control, and it's the only way to run the interactive-state broadcast on
  `toggle_interactive`.
- `"passthrough": true` on both — **CORRECTED (S, 2026-07-27 audit):** this was
  previously documented backwards here. `passthrough: true` means the keystroke is
  delivered to the game IN ADDITION to firing Overwolf's hotkey callback — it is not
  consumed/blocked. (Overwolf still fires `onPressed` regardless of game focus
  either way, which is what actually makes `toggle_overlay` work while the game has
  focus — that part of the original reasoning was fine, the "consumed" claim was
  not.) Harmless for `Ctrl+F10`/`Ctrl+F11` since League doesn't bind either combo by
  default, but get this right before ever picking a hotkey that might collide with
  an actual in-game bind — `passthrough: true` would let both this app AND the game
  react to the same keypress.
- Defaults chosen to avoid League's own binds: **not** Q/W/E/R/D/F (abilities/summs),
  **not** 1–6 (items), **not** Tab (scoreboard), **not** Alt+click (self-cast/etc).
  `Ctrl+F10` / `Ctrl+F11` avoid League's default F1–F5 (select ally/self) and F12
  (commonly reserved by Steam's own screenshot hotkey, which would otherwise fight
  Overwolf for the binding). Neither was tested against a live keybind conflict —
  see HANDOFF-engy.md.

## `data.launch_events`
- `GameLaunch` on both game ids — Overwolf auto-starts the app (its `start_window`,
  i.e. `background`) the moment League's launcher OR the game itself opens, so the
  controller is already running and can restore `desktop` before champ select even
  if the user never manually opened the app. `start_minimized: true` keeps this
  invisible — no window pops up uninvited; `background.js` decides what (if
  anything) to show.
