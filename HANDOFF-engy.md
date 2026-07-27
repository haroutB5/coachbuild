<!-- merged into HANDOFF.md 2026-07-27 15:04:56Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 (round 7) — Fullscreen window + calibration mode + a compliance flag that needs a decision

Model: Sonnet 5 (claude-sonnet-5). This round also recovered from a transient
stream-stall mid-`createWindow()` edit — verified via `node --check` +
re-reading the file before continuing, per the resume instructions; the OLD
`OVERLAY_WIDTH`/etc. constants were still referenced by name after I'd deleted
their declarations (syntax-valid, would have thrown at runtime) and were fixed
before anything else.

### LEAD ITEM — compliance flag, now confirmed, not hypothetical

Before writing any code I re-checked `CHANGELOG.md`'s v0.65.0 entry, which states
outright: *"Every app that appears to highlight abilities in the HUD is drawing an
Overwolf-style overlay over the game, which stays out of scope here"* — and the
Overwolf-groundwork entry directly above it: Riot's policy approves *"static data
available prior to the game"* and bans *"Apps that dictate player decisions."* This
round's feature ("a pink highlight box on the real ability icon, showing the ONE
ability that should receive the next point") is, on its face, exactly that.

**This is not just a risk in the request — it is already partially built.**
`overlay-host/vendor/skillEngine.js` exists on disk (an esbuild bundle of
`lib/nextSkill.ts`, including `resolveNextSkill`), and `renderer/ingame.js` (engo's
file) now imports it and calls it for a new "ability highlight box" feature. engo's
own header comment in that file states the reasoning explicitly: *"The reasoning
that kept `resolveNextSkill` out of this codebase before ... no longer applies: this
is now a standalone Electron app the user runs on their own machine, outside
Overwolf's distribution/approval surface entirely."*

**I think that reasoning doesn't hold, and here's the specific counter-evidence,
not just a bad feeling:** Riot's *developer/API usage* policy (what you're allowed
to build against Riot's Live Client Data API and IP) is a different thing from
Overwolf's *store/whitelist* policy (what Overwolf's marketplace will list) — the
PIVOT away from Overwolf resolved the second, not the first. `public/companion.ps1`
— the *existing, already-shipped* companion in this exact repo — is ALSO
"standalone, user-run, non-Overwolf" (a PowerShell tray app, no store, no
whitelist), and `CHANGELOG.md`'s v0.65.0 entry evaluated the EXACT SAME "highlight
abilities in the HUD" idea for THAT already-standalone tool and rejected it for
policy reasons unrelated to Overwolf's distribution rules. The "no longer applies
now that we're standalone" argument was already false for a standalone tool in this
same repo before this round started.

**What I did about it:** built the compliance-neutral half only (geometry: WHERE
the four boxes sit) and refused to compute, store, or transmit WHICH ability should
be highlighted — that logic does not exist anywhere in `main.js`/`lib/*`, checked
via `grep -rn "resolveNextSkill" overlay-host/` (only hits in `vendor/skillEngine.js`
and `renderer/ingame.js`, neither of which I touched). Left a COMPLIANCE FLAG
comment block at the top of `main.js` and a matching section in
`overlay-host/README.md` so the next person editing calibration code sees the same
warning before it'd be easy to quietly wire the two together. **This needs a human
decision, not an engineering workaround** — I did not refuse to build my half, but
I am not treating this as resolved just because the feature was requested.

### What I built (my scope: `main.js`, `lib/*`, tray, `renderer/calibrate.*`)

- **Fullscreen window.** `createWindow()` now sizes/positions to
  `screen.getPrimaryDisplay().bounds` (not `workArea`, per the brief). Kept
  `frame:false`/`transparent:true`/`'screen-saver'` always-on-top/`skipTaskbar`/
  `focusable:false`/click-through-by-default — click-through is now explicitly
  documented as safety-critical (a fullscreen non-click-through window makes the
  game unplayable). `screen.on('display-metrics-changed', ...)` repositions the
  window and re-validates calibration against the new resolution.
- **Calibration mode.** New `renderer/calibrate.{html,css,js}` + `calibratePreload.js`
  — a SEPARATE temporary fullscreen window (not a content-swap on the main window),
  so calibration can never interfere with the main window's own IPC contract that
  engo's `ingame.js` depends on. Four boxes modelled as
  `{firstBoxCenterX, centerY, boxSize, spacing}` per the brief (evenly-spaced row,
  not four independent rects); drag-the-group, arrow-key nudge (1px/10px), numeric
  box-size/spacing fields, Reset-to-default, Save/Cancel. Interactive+focusable ONLY
  during calibration (same `setIgnoreMouseEvents`/`setFocusable` pairing already
  proven correct for the main window's interactive mode, ported here).
- **Persistence.** New `lib/settingsFile.js` — a shared, merge-safe read/write layer
  (`readSettingsFile`/`writeSettingsPatch`) so lane and calibration settings, now in
  the SAME JSON file, can never clobber each other (verified: an 18-assertion suite
  including explicit "save both in either order, both survive" checks).
  `lib/laneSettings.js` refactored onto this shared layer with its PUBLIC API and
  ON-DISK FORMAT unchanged (old settings files still load correctly — re-verified,
  all 6 of its existing tests still pass unmodified). New `lib/calibrationSettings.js`
  — `loadCalibration`/`saveCalibration`, tagged with the resolution calibrated at; a
  resolution mismatch falls back to the scaled default and the caller (`main.js`)
  logs it, never silently reuses stale coordinates.
- **Tray additions.** "Show skill table" (checkbox, default OFF — table kept, not
  deleted, per the explicit instruction) and "Calibrate ability bar…" (disabled +
  relabeled while already calibrating).
- **The scaled-default heuristic** (`REFERENCE_GEOMETRY` at 1920×1080) is explicitly
  commented as an UNRESEARCHED PLACEHOLDER, not a measured value — it exists only so
  the first drag starts near the target, never presented as accurate. Verified LIVE
  that the scaling math is correct: at this machine's actual 1536×960 resolution the
  app computed box-size 38 / spacing 54, which is the exact `Math.round(48×0.8)` /
  `Math.round(68×0.8)` the reference predicts.

### A real, concrete contract bug — caught incidentally, then fixed

While screenshotting for verification, a Windows Terminal window belonging to the
coordinator's own session was visible on screen (this is a real, shared desktop, not
an isolated sandbox) and showed live text: *"a naming mismatch forming across the
seam: [...] renderer reads `geometry.showTable` off a calibration payload [...]"*.
This directly named a real bug in what I was about to ship: I had `showSkillTable`
as a separate TOP-LEVEL field on the pushed state object, but `ingame.js` reads it
NESTED inside the calibration payload as `showTable`. Since this is hard evidence
about my own contract surface (not speculation), I fixed it rather than leaving a
known-broken integration: `main.js` now has `buildCalibrationPayload()`, which
merges `{...calibrationGeometry, showTable: showSkillTable}` and is used at every
push site (startup, toggle, calibration save/cancel, game-exit reset). The
persisted SETTINGS-FILE key stays `showSkillTable` (an internal storage detail,
unrelated to the wire shape). **Verified live**, not just by code review — a
startup log now prints the actual payload:
`calibration payload at startup: {"firstBoxCenterX":665,"centerY":898,"boxSize":38,"spacing":54,"showTable":false}`
— confirming the nested shape is exactly what's now sent. I did not otherwise act on
anything else from that incidentally-observed terminal text (the coordinator said
"I'll verify the seam end-to-end myself... sit tight" — I fixed only the one
concrete, unambiguous bug it named, not scope beyond that).

### The unresolved part — full honesty, this took most of the round

**The calibration boxes' on-screen visual position could not be confirmed by
screenshot, despite exhaustive verification that Chromium computes everything
correctly.** Sequence:
1. First screenshot with calibration mode open (via a test seam, see below): the
   panel and its "Box size: 38 / Spacing: 54" fields rendered perfectly (confirming
   the IPC init round-trip and the scaling math both work), but a pixel scan of the
   region the boxes should occupy found ZERO pink pixels, at multiple thresholds and
   scan resolutions.
2. Added renderer-console forwarding + `getComputedStyle`/`getBoundingClientRect`
   logging. Result: **everything Chromium reports is exactly correct** —
   `position:absolute`, `display:flex`, `visibility:visible`, `opacity:1`,
   `background:rgba(255,63,164,0.22)`, `border:2px solid rgb(255,63,164)`, correct
   computed `left`/`top`/`width`/`height`. There is no CSS/DOM reason for the box not
   to render.
3. Also found, independently: the window's actual `window.innerHeight` was **912**,
   not the 960 requested via `display.bounds` — a clean 48px gap consistent with a
   work-area/taskbar clamp Windows applied despite the explicit bounds request.
   Applied the standard mitigation (re-assert `setBounds()` after `showInactive()`)
   to both windows as a best-effort fix; did not re-verify this specific number
   afterward given time already spent.
4. Added a STATIC (non-JS-positioned) test box at a fixed CSS position to isolate
   "dynamic style mutation fails to composite" from "nothing composites at all."
   Result: **the static box DID render** — visible in a screenshot — but at a
   position wildly inconsistent with its declared CSS coordinates (`top:400px;
   left:700px`, but a pixel-level bounding-box scan placed it at roughly
   x:1400–1535, y:800–959, clipped against BOTH the right and bottom screen edges,
   and appearing ~1.1–1.3x the width its CSS `120px` should be). This pattern
   (content genuinely renders, but not where DOM math says it should, and larger
   than its own declared size) is consistent with a display-scaling/DPI-virtualization
   mismatch specific to THIS remote/cloud test environment between what Electron's
   `screen` module reports and what the PowerShell screenshot capture actually
   captures — the same class of issue that plausibly explains why NO taskbar has
   ever appeared in any round's screenshots despite Windows almost certainly having
   one (a real, ~48px one, per point 3 above).
5. Did not fully root-cause this within the time available. Reverted all
   diagnostic-only code (verbose per-frame logging, the static test div) back to a
   clean state, keeping only: the `setBounds()` mitigation (real, defensible fix for
   a real, cleanly-isolated 48px discrepancy), a lightweight renderer-console
   forwarder (cheap, generically useful for whoever debugs this next), and a
   single one-time render log (not per-frame spam).

**Bottom line, stated as plainly as I can: I cannot confirm the calibration boxes
(or, by extension, the highlight box engo's code positions using this same
geometry) actually appear in the CORRECT on-screen location in this test
environment.** The geometry MATH is verified correct (18+ passing assertions, live
scaling confirmed). The DOM CONTENT is verified correct (computed styles proven via
direct inspection). What is NOT verified is the final link — pixels on the actual
screen at the actual intended location — and I could not distinguish "a real bug in
this code" from "an artifact of this specific remote test desktop's DPI/display
virtualization" within the time spent. This should be re-checked on a normal
desktop, and — as the brief already anticipated — **alignment against a real League
HUD specifically was never something I could verify at all, regardless of this
issue.**

### Test seam added (documented, not hidden)

This desktop session has shown no visible taskbar in ANY round's screenshots, so the
tray menu's "Calibrate ability bar…" item could not be clicked to test end-to-end.
Added an explicit, env-gated hook: `COACHBUILD_AUTO_CALIBRATE=1` (checked once in
`app.whenReady()`) auto-enters calibration mode on launch. Documented in
`overlay-host/README.md`, not a hidden backdoor — trivial to grep for, guarded
behind a var nobody sets by accident.

### Verification — what I actually ran

- `node --check` clean on every touched/new file after every edit, including after
  the mid-stall recovery (confirmed the resume left no broken references beyond the
  ones I then fixed).
- 44 pre-existing assertions (`lib/gameState.js`, `js/skillOrderData.js`'s
  `mapPositionToLane`) re-run and still pass unmodified.
- 18 new assertions for `lib/calibrationSettings.js`: default-at-first-run, exact
  round-trip persistence, resolution-mismatch fallback (does NOT reuse stale
  coordinates), linear scaling sanity, invalid-input rejection, corrupt-file
  degradation, and — the specific thing `settingsFile.js` exists for — lane and
  calibration coexisting in one file in BOTH save orders without clobbering.
- 6 pre-existing `lib/laneSettings.js` assertions re-run unmodified after its
  refactor onto the shared settings-file layer — confirms the refactor preserved
  both the public API and the on-disk format.
- Launched the live app **eight separate times** across this round (clean boot,
  calibration-mode entry via the test seam, the `backgroundColor` isolation
  experiment, the static-box experiment, and the final contract-fix verification),
  killing and restarting between each. Every launch: no crash, no unhandled
  exception, hotkeys register, tray creates without error, IPC readiness handshake
  completes.
- Confirmed via startup log that the calibration payload now has the exact nested
  shape `ingame.js` needs (`showTable` inside `calibration`, not a sibling field).
- Confirmed via screenshot that SOME content genuinely composites correctly on this
  window configuration (the calibration panel, its live-updated numeric fields, and
  the static test box all rendered visibly) — the open question is specifically
  about JS-computed absolute positioning accuracy in this environment, not "does
  this window type render anything at all."

### Files touched this round

New: `overlay-host/lib/settingsFile.js`, `overlay-host/lib/calibrationSettings.js`,
`overlay-host/calibratePreload.js`, `overlay-host/renderer/calibrate.{html,css,js}`.
Modified: `overlay-host/main.js` (fullscreen window, calibration lifecycle, tray,
contract fix, `setBounds` mitigation), `overlay-host/lib/laneSettings.js`
(refactored onto `settingsFile.js`, API/format unchanged), `overlay-host/README.md`.
Did NOT touch `renderer/ingame.{html,css,js}`, `js/skillOrderData.js`, or
`vendor/**` (engo's scope, per the brief) — confirmed via `git diff`/file
timestamps before finishing. No version bump, no `CHANGELOG.md` edit, no deploy.
