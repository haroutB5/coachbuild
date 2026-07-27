<!-- merged into HANDOFF.md 2026-07-27 15:34:35Z; previous content preserved there. Append new rounds below. -->

# HANDOFF — engo, adjust-in-place mode (round 8), 2026-07-27

Model: Sonnet 5 (claude-sonnet-5).

Context: the pink highlight box works live (confirmed by the coordinator, every level-up, real game). The one problem — boxes not exactly aligned, user couldn't fix it — traced to a design mistake in the (now-retired) separate calibration WINDOW: on one monitor, that window covered the exact ability bar the user needed to see to aim at it. Fix this round: adjust the same geometry live, in the main overlay window, directly over the running game, via ordinary `keydown` input this renderer owns (main.js only flips the window to interactive+focused — it does not intercept or forward keys). Scope: `overlay-host/renderer/ingame.{html,css,js}` only. Did not touch `main.js`, `preload.js`, `lib/**`, `calibrate.*`, or the tray — read `preload.js` to confirm the exact contract (channel names, payload shapes) before writing anything against it, did not edit it.

## What I built

- **`workingGeometry`** (module-level, `{firstBoxCenterX, centerY, boxSize, spacing} | null`) — a LOCAL, unsaved copy. Nudging it never touches `calibration` (the committed value driving the normal single highlight box) until Enter, and main.js re-validates before persisting even then, per `preload.js`'s own comment.
- **`setAdjustMode(next)`** — the renderer's ONLY place `isAdjusting` is ever set, and it's called ONLY from `window.coachbuildIPC.onAdjustModeChange`. Deliberately reactive-only: the Enter/Escape handlers below call `saveAdjustedGeometry`/`cancelAdjustedGeometry` and then do nothing else locally — they wait for main.js's own subsequent `onAdjustModeChange(false)` push to actually tear the UI down, exactly matching the contract's framing ("fires false when it closes by ANY path... including your own save/cancel"). This avoids a race between an optimistic local teardown and what main.js actually decided.
- **`renderAdjustBoxes()`** — positions all FOUR boxes (Q/W/E/R, all at once, not just the current recommendation) from `workingGeometry` using the exact same `firstBoxCenterX + slot*spacing` math the single highlight box already uses (shared mental model, verified to generalize correctly to slot 1/W in the self-test, not just slot 0/Q which could hide an off-by-one). Also positions the legend, anchored via CSS `transform: translate(-50%, -100%)` against a `left`/`top` this function sets to the row's horizontal midpoint and top edge — so the legend always sits just above the row regardless of calibration, without ever needing to know its own rendered size.
- **`handleAdjustKeydown(e)`** — attached/detached entirely by `setAdjustMode` (`document.addEventListener`/`removeEventListener`), never left registered outside an active session. Every handled key calls `preventDefault()`; every unhandled key passes through untouched (verified explicitly in the self-test — an unrelated keypress must not get swallowed). Arrows nudge `firstBoxCenterX`/`centerY` by 1, or 10 with Shift. `+`/`=` grow `boxSize`, `-`/`_` shrink it (clamped 10–200). `[`/`]` shrink/grow `spacing` (clamped 10–300). `Tab` is a deliberate no-op (see judgement call below) but still `preventDefault()`'d so it can never leak focus out of the window. Enter/Escape call the two IPC sends.
- **No DPI compensation anywhere**, per the brief — the whole app already operates in CSS/logical pixels end-to-end, consistent with main.js's window bounds and the calibration geometry it persists. Documented inline specifically so a future reader doesn't "fix" this by scaling the step constants.

## Judgement call: Tab

The brief flagged Tab as something "engy suggests" keeping simple (whole-row model, matching `{firstBoxCenterX, centerY, boxSize, spacing}` everywhere else) and asked me to document whatever I chose. I made it a genuine no-op: there's no per-box independent position in this model, so there's nothing for Tab to cycle between. It still calls `preventDefault()` so it can't leak focus out of the (normally non-focusable) window into whatever's behind it while adjust mode holds keyboard input. Verified in the self-test that Tab changes nothing about the geometry.

## The legend

Always visible while adjusting (`#cb-adjust-legend`, inside the same `#cb-adjust` wrapper toggled by `setAdjustMode`) — four short lines: arrows+Shift, +/-/[/], Enter/Esc. Reuses `<kbd>` styling and the app's existing `--cb-interactive` blue accent (the SAME hue `.cb-overlay--interactive`/the "editable" badge already use for "input is being captured right now") for its border — one visual language for that concept across the file, not a second color invented for the same idea. That reuse IS the "unmistakable visual state" requirement: a solid, high-contrast panel in a color that means exactly one thing everywhere else in this app.

## Visual design carried over from the highlight box, unchanged

The four adjust boxes reuse `.cb-highlight`'s exact pink-outline-plus-glow treatment (mostly-transparent fill, layered dark-ring + pink-glow `box-shadow` for legibility against both bright and dark HUD patches) so it still reads as "the same feature." One deliberate difference: **no pulse animation on the adjust boxes**, even outside `prefers-reduced-motion: reduce`. While the user is precisely nudging pixel positions, motion would make it harder to judge alignment against the real icon underneath — the opposite of what the pulse is for on the single recommendation box. Each adjust box also gets a small Q/W/E/R letter label (white text, dual text-shadow instead of a background chip, so it doesn't add another opaque rectangle inside an already-small box) so the four boxes are unambiguous even at a glance.

## Don't-regress checks, done explicitly

- `renderHighlight(data)` now short-circuits to hidden whenever `isAdjusting` is true, BEFORE it ever touches `calibration`/`computeNextSkillRecommendation` — the single box and the 4-box preview never render at the same time.
- Leaving adjust mode (`setAdjustMode(false)`) ends with `handleState(lastState)`, which restores the single highlight box from `calibration` — verified in the self-test that it reflects the NEWLY SAVED geometry (811 in the test trace), not the pre-adjustment value (800), and that a cancel correctly leaves it at the LAST SAVED geometry (the discarded nudge never took effect).
- The `onCalibration` transport comment block was stale ("Not yet wired as of this commit") from the previous round — updated to state it's wired and confirmed live, since leaving a false "not wired" claim sitting in code that demonstrably now works would mislead the next reader.

## Testing

Extended `overlay-host/vendor/_selfTest-highlight.mjs` (still the same hand-rolled DOM shim importing the REAL `ingame.js`, not a reimplementation) rather than writing a second file. Added: `document.addEventListener`/`removeEventListener` + a `dispatchKeydown(key, {shiftKey})` helper that drives the actual registered listener; `onAdjustModeChange`/`saveAdjustedGeometry`/`cancelAdjustedGeometry` on the `window.coachbuildIPC` shim, with call-count + payload capture.

**Caught two of my own arithmetic mistakes while writing the expected values** (not code bugs — traced and fixed rather than loosened the assertions): I mis-hand-computed the running `firstBoxCenterX` after the coarse Shift+Arrow step in two places, and once used a stale value from an earlier draft of the save/cancel sequence. Recomputed the FULL keydown trace by hand from `{800,950,60,70}` through all ten dispatches to `{811,960,60,70}` before fixing the assertions, rather than adjusting them to whatever the code produced without checking it was actually right. Also found and fixed a genuine self-test SHIM gap (not an ingame.js bug): the shim doesn't parse `ingame.html`, so `#cb-adjust`'s real `hidden` attribute was never reflected in the fake element's initial state — fixed by seeding the shim's initial `hidden` values from the actual markup instead of asserting against a coincidentally-matching default.

```
node --check overlay-host/renderer/ingame.js          -> OK
node --check overlay-host/vendor/_selfTest-highlight.mjs -> OK
CSS brace balance (ingame.css)                          -> 47 open / 47 close, balanced

node overlay-host/vendor/_selfTest-highlight.mjs
  53 passed, 0 failed
```
Covers (new this round, beyond the round-7 highlight-box assertions still in the same file and still passing): adjust UI hidden by default; becomes visible + all four boxes correctly positioned from the committed calibration on `onAdjustModeChange(true)`; single highlight suppressed while adjusting; fine vs. coarse (Shift) arrow steps on both axes; box-size and spacing keys, including that spacing correctly leaves Q (slot 0) untouched while moving W (slot 1); Tab as a genuine no-op that still preventDefaults; an unrelated key passing through untouched; Enter sending exactly the four geometry fields (no `showTable`) and staying open until `onAdjustModeChange(false)` actually arrives; the keydown listener being genuinely detached on close (a further keypress does nothing); the restored single highlight reflecting the newly-saved geometry; reopening snapshotting the LATEST calibration rather than stale state; and Escape/cancel leaving the highlight at the last-saved value with the discarded nudge never taking effect.

## What I could not verify

Same limitation as every prior round: alignment against a REAL League HUD. This is exactly the gap adjust-in-place mode exists to close for the user directly (no calibration window in the way anymore), but I have no running game to nudge boxes against. Everything above is verified at the level of "the geometry math and state machine are correct, real functions, real IPC contract" — not "the boxes land on the actual icons," which is now the user's own live loop.

No version bump, no `lib/`/`app/` changes, no deploy. Files touched this round: `overlay-host/renderer/ingame.html`, `ingame.css`, `ingame.js`, `overlay-host/vendor/_selfTest-highlight.mjs`.
