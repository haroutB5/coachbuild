<!-- merged into HANDOFF.md 2026-07-27 20:22:26Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 round — overlay-host tray redesign + 8 audited lifecycle fixes

Scope: `overlay-host/` only (per brief). Did NOT touch `app/`, `components/`, `lib/`, or `public/companion.ps1`. Did NOT bump version, commit, publish, or deploy — overlay stays at v0.4.1 in package.json.

### Gates run (from repo root, this round)
- `npx tsc --noEmit` — clean.
- `npx vitest run` — **1919 passed, 0 failed** (up from the 1908+ floor; no test files changed, this is just current head).
- `npm run lint` — clean (only pre-existing `<img>`/next-image warnings, unrelated to this round).
- `node --check` on every JS file touched: `main.js`, `lib/autoUpdater.js`, `scripts/generate-tray-icon.js` (CommonJS) + `node --input-type=module --check` on `renderer/ingame.js` (ESM, loaded via `<script type="module">`) — all clean.
- Every new CSS class (`.cb-highlight--derived`) exists in `renderer/ingame.css`; no new element ids were queried (B7 reuses the existing `#cb-highlight` element already in `els`).

### Two diagnosis corrections (stated per the brief's instruction to flag disagreements)
1. **Icon path.** The brief said `build/icon.ico`. There is no `build/` directory in `overlay-host/`. The real app icon is `assets/icon.ico` — confirmed against `package.json`'s `build.win.icon` and `scripts/apply-exe-resources.js`'s `ICON_PATH`, both of which point there. Backed up and regenerated `assets/icon.ico`, not a nonexistent `build/icon.ico`.
2. **Accent color.** The brief said "the app's accent colour is teal (see `renderer/ingame.css`)." Checked directly: `ingame.css` has no teal token at all — it's a gold/navy "hextech" palette (`--cb-gold: #c8aa6e`, `--cb-bg: #0a0d0b`). The main Next app's `tailwind.config.ts` keeps a color **key** literally named `teal` only so old `bg-teal`/`text-teal` call sites keep resolving; its own comment says the value is "League Hextech gold (was cyan, then lavender-era teal)" — i.e. there is no live teal hue anywhere in this codebase anymore, just a stale class name. The new icon uses the two real current tokens (gold + navy) instead.

### A1 — tray menu redesign
`main.js`'s `buildTrayMenuTemplate()` rewritten. New top-level shape (8 entries + 4 separators):
```
CoachBuild Overlay v0.4.1        (disabled)
Companion: <status>              (disabled, ONE line — was two)
─────────
Hide overlay / Show overlay
Adjust overlay position          (transient "Adjusting… (Enter to save, Esc to cancel)" label unchanged)
─────────
Settings        ▸  Interactive mode · Show skill table · Lane override ▸ (unchanged: Auto + 5 lanes) ·
                    Calibrate ability bar (fallback)… · Start with Windows (elevated, fixes in-game hotkeys)
Updates         ▸  <status line> · Check for updates now
Troubleshooting ▸  Open log file · [poll-stall row, only while stalled] · per-hotkey bind-status rows · elevation guess row
─────────
Quit CoachBuild Overlay
```
Every capability from the old 23-item flat list is preserved — nothing became unreachable, this is a regroup not a cull. "Run elevated at login" was relabeled "Start with Windows (elevated, fixes in-game hotkeys)" per the brief's suggested shape, keeping the original parenthetical so the "why" isn't lost. The two companion rows (`buildCompanionStatusLabel` + `buildCompanionPollHealthLabel`) collapsed to one at top level exactly as instructed; the stall-detail row moved into Troubleshooting.

### A2 — tray icon + app icon
New generator: `overlay-host/scripts/generate-tray-icon.js` (CommonJS, run via `node scripts/generate-tray-icon.js`). Reuses `sharp` + `png-to-ico` from `C:/Claude/AI/urgot/.smoke-tools/node_modules` rather than installing new deps into overlay-host (png-to-ico v3 is pure ESM and its default export only takes file paths + a fixed size set, so the script reaches its named `imagesToIco` export via dynamic `import()` and feeds it raw RGBA frames from sharp instead).

Design: a navy disc (own contrast on a light taskbar) + a slim gold ring (own contrast on a dark taskbar, since a plain navy disc nearly disappears on Windows' near-black dark taskbar) + a bold navy upward chevron cut across the gold field (evokes "next/level up" — literally what the ability-highlight-box feature does). No text, no fine detail.

Backed up before overwriting: `assets/tray-icon.png.bak`, `assets/icon.ico.bak` (both untracked, not committed — delete them once you're happy with the new icon, or restore from them to revert). Wrote:
- `assets/tray-icon.png` — 16x16 (primary tray size).
- `assets/tray-icon@2x.png` — 32x32 (Electron's nativeImage auto-picks this up next to the base path for HiDPI; no main.js change needed).
- `assets/icon.ico` — verified by parsing the ICO header directly (not assumed): 5 entries, exactly 16/24/32/48/256, all 32bpp, byte offsets/sizes internally consistent with the 287,934-byte file.

Visually verified at 16px (nearest-neighbor-magnified renders, not smoothed, so the actual pixel grid was inspected): legible as a bold gold coin with a dark ring and chevron. Composited onto simulated light (`#f3f3f3`) and dark (`#202020`) taskbar strips at true 16px scale (then magnified for viewing) — reads clearly on both; images were generated into the scratch temp dir for inspection, not committed anywhere.

Added `"!assets/*.bak"` to `package.json`'s `build.files` so the backup files don't get bundled into a packaged build (the existing `assets/**/*` glob would otherwise have shipped them).

### B1 (P1) — companion supervisor blind in already-running state — FIXED
`main.js`, the child `exit` handler: the mutex-race branch (`ranMs < COMPANION_MUTEX_RACE_EXIT_MS`) used to inherit an unconditional `stopCompanionStatusPolling()` that ran before the branch was even checked, then returned without ever restarting it. Now calls `startCompanionStatusPolling()` in that branch instead (idempotent — clears any existing timer first) so `/status` polling of the real already-running companion continues. Did NOT change the "never auto-retry the spawn in this case" behavior — that part of the original diagnosis was correct.

### B2 (P1) — champ-select guard — FIXED
Added `isCompanionBusy()` (`inGame || companionStatus.phase === 'ChampSelect'`) as the one shared source of truth, plus `companionBusyReason()` for logging. `attemptCompanionRestart()` now checks `isCompanionBusy()` instead of bare `inGame`. `lib/autoUpdater.js`'s callback renamed `getInGame` → `getIsBusy` throughout (definition, `init()` destructure, `maybeInstallIfIdle()`); `main.js`'s `autoUpdaterModule.init()` call now passes `getIsBusy: () => isCompanionBusy()`. Confirmed `companionStatus.phase` still carries the RAW gameflow value everywhere (B6 below only adds a presentation-layer label map, never touches the stored field) — this check depends on that staying true.

### B3 (P1) — display-metrics-changed desync — FIXED
Added the missing `pushCalibration()` call after `applyCalibrationForCurrentDisplay()` + `pushState()` in the `screen.on('display-metrics-changed', ...)` handler's non-adjusting branch — this was the third of three documented breaks of "the renderer reads calibration geometry only off the dedicated IPC channel, never off `state.calibration`."

### B4 (P2) — restart backoff never escalates — FIXED
Removed the `companionRestartAttempts = 0` line at the end of `spawnCompanion()` (it ran on every spawn, including the spawn that was itself a backed-off restart attempt, undoing the increment every time). The reset already present in `pollCompanionStatusOnce()` on a real successful status poll is the correct signal and was left as-is.

### B5 (P2) — second launch wipes the running instance's log — FIXED
Moved `initLogFile()` from before the `app.requestSingleInstanceLock()` check to inside the `else` branch (only runs once the lock is actually held). The losing branch now logs to console only, not the file, so it can never truncate the real running instance's log out from under its open write stream.

### B6 (P2) — raw LCU phase read as companion health — FIXED
Added `GAMEFLOW_PHASE_LABELS` (presentation-only map: `None` → "idle (client open, no lobby)", `ChampSelect` → "champ select", `InProgress` → "in game", etc.) consulted only inside `buildCompanionStatusLabel()`'s `default` branch. `companionStatus.phase` itself is never rewritten — confirmed this doesn't collide with B2's `isCompanionBusy()` check, which reads the same field and needs the raw value.

### B7 (P2) — highlight box has no derived-level provenance — FIXED
`renderer/ingame.js`'s `renderHighlight()`: added `rec.atLevel - 1 >= observedLevelCount(model)` (reusing the exact index `buildGrid` already compares, so the box and the table can never disagree about which levels are derived) and toggles a new `cb-highlight--derived` class. `renderer/ingame.css`: added `.cb-highlight--derived { border-style: dashed; }` — same pink hue/glow as a published recommendation, dashed instead of solid border for "less certain," consistent in spirit with the grid's own derived-column treatment (which trades a solid fill for an outline, not literally a dashed border — the brief described `.cb-grid td.cb-derived` as "dashed," but it's actually a `box-shadow` outline treatment; there is no dashed border anywhere in the existing CSS to literally match, so I used dashed as the clearest available "provenance differs" convention rather than inventing a new color).

### B8 (P2) — full state push + DOM rebuild every 1.5s — FIXED
Added `computeGameStateSignature(state)` in `main.js`, covering every field `js/skillOrderData.js`'s `resolveOverlayData` actually reads off pushed state (confirmed by reading that function directly): `inGame`, `championName`, `championLevel`, `abilityRanks.{Q,W,E,R}`, `lane`, `detectedPosition`. Deliberately excludes `calibration` — that field rides on `gameState` too but the renderer is contractually forbidden from reading it off the state channel (own dedicated `coachbuild-calibration` push instead), so including it would report changes the renderer never sees. `pollActivePlayer()` now builds a candidate merged state and only commits + `pushState()`s when the signature actually changed, instead of on every successful poll tick unconditionally.

### Unverifiable without a live game
Everything above was verified by reading the code paths and (for B1/B2/B3/B4/B5/B6/B8) tracing the exact call sites named in the brief, plus the gates above. None of it was exercised against a real League client or a real companion process — same caveat this file already carries for `lib/nextSkill.ts`'s live wire shape. In particular: B1's actual tray behavior when a standalone companion is already running, B2's actual timing window during a live champ select, and B8's actual IPC-traffic reduction over a real 40-minute game are all reasoned from the code, not measured live.

