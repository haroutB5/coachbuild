<!-- merged into HANDOFF.md 2026-07-27 13:24:07Z; previous content preserved there. Append new rounds below. -->

## 2026-07-27 (round 2) — fixes from the Fable 5 adversarial audit

Model: Sonnet 5 (claude-sonnet-5). All six confirmed defects fixed, in `background.js`,
`js/gameState.js`, `js/owWindows.js`, `manifest.json`, `manifest.README.md`, and
`README.md` only — did not touch `ingame/**`, `js/skillOrderData.js`, `vendor/**`
(engo's files, being fixed in parallel per the coordinator's note).

**Cleared by the audit, unchanged:** the `sendMessage` transport deviation, the
message ids, the READY-handshake ordering proof, and every point in `gameState.js`
(Passive exclusion, riotId matching, rawChampionName preference, non-English survival
via ddragon's ASCII `key` + the normalized-fallback rescuing `FiddleSticks`/
`Fiddlesticks` casing). No changes made to anything already cleared.

### 1. (P1) `livePort` coercion + default — `background.js`, exports from `js/gameState.js`
`toFiniteInt` is now exported from `gameState.js` (previously module-private) so
`background.js` can reuse the same coercion `gameState.js`'s own header mandates,
rather than a second hand-rolled check. New `resolvePort()` in `background.js`
coerces `live_client_data.port` through it, falls back to `DEFAULT_LIVE_CLIENT_PORT
= 2999` (matching `companion.ps1`'s four hardcoded call sites) when the coerced
value is absent or `<= 0`, and logs the resolved port once per change — not every
tick, so it's visible without flooding the console. Fixed the exact silent-failure
chain flagged: `fetchPlayerList` was never even attempted when `port` came in as a
string or was missing, and the README's old troubleshooting entry pointed at a
catch-block log that could never fire because the call never happened.
`README.md`'s troubleshooting section rewritten to check the new port-resolution
log FIRST, before the (still-relevant, but now second-in-line) playerlist-fetch log.

**Verified:** new 8-assertion suite against `toFiniteInt` directly (bare number,
stringified number, absent, null, empty string, garbage string, zero, non-integer)
— all pass. It also surfaced a real JS quirk worth flagging for whoever touches this
next: `Number('') === 0`, so `toFiniteInt('')` is `0`, not `null` — harmless here
only because `resolvePort()` already checks `coerced > 0`, not just `!== null`; a
future caller that checks `!== null` alone would treat an empty-string port as
"valid: 0" instead of falling back.

### 2. (P1) `getInfo()` envelope — `seedInitialState()` in `background.js`
Now reads `res.res?.live_client_data ?? res.live_client_data` and treats success as
`res.success === true || res.status === 'success'`, exactly as directed, and logs
which shape (`NESTED under res.res.live_client_data` vs `FLAT under
res.live_client_data`) was actually observed. **Still unverified against a real
call** — this fix makes the first live run self-diagnosing rather than resolving
the ambiguity in advance, which is the most honest thing achievable without a
running League client.

### 3. (P2) Desktop window auto-open on `GameLaunch` — `background.js`
Replaced the unconditional `restoreWindow(desktop)` in `init()` with
`declareDesktopWindow()` (obtains the window without showing it) plus
`decideDesktopAutoOpen(origin)`, driven by `overwolf.extensions.onAppLaunchTriggered`
when available. Default on any ambiguity (event unavailable, never fires within a
2s fallback timeout, or reports an unrecognized origin) is **NOT** to auto-open —
matching what `manifest.README.md` already promised. **Honesty note:**
`onAppLaunchTriggered` and its `origin` field (specifically the string
`"gamelaunchevent"`) are asserted from general knowledge of the Overwolf API
surface, not observed against a live launch on this machine — flagged inline in
`background.js`'s comment and in `manifest.README.md`. Updated `README.md`'s load
checklist (steps 5 and 7) to stop promising the desktop window "should open
automatically" — it now correctly says it may or may not, and how to tell which
happened from the background console log.

### 4. (S) READY handshake delivery — `background.js`, `js/owWindows.js`
`pushState()` and `pushInteractiveChange()` now target `ingameWindowId` (the real
windowId, captured in `openIngameWindow()`) instead of the declared window NAME,
via a new `ingameSendTarget()` helper that falls back to the name only when the id
isn't known yet — and warns loudly when it has to. Both functions now also
explicitly check `result.success === true` on a resolved send (belt-and-braces on
top of `owWindows.js`'s promise already rejecting on `!success`) and log every
failure via `warn(...)`, not the quieter `log(...)` the P1 version used — a dropped
delivery is no longer indistinguishable from routine chatter in the console.
`owWindows.js`'s `sendMessageToWindow` doc comment updated to say the parameter
should be a windowId when the caller has one, name as a fallback only.

### 5. (S) `minimum-overwolf-version` — `manifest.json`
Raised `0.120.0` → `1.0.0`. Not pinned to a specific Overwolf changelog entry
(would need cross-referencing Overwolf's own release notes, not done), but
deliberately conservative: sits inside "definitely has the modern `result.success`
boolean convention every `owWindows.js` wrapper depends on" territory, well below
this machine's installed 1.131.304.3, and well above the pre-1.0 releases the old
floor would have permitted. `manifest.README.md` updated with the full reasoning
and an explicit note that this isn't an exact pin.

### 6. (S) `passthrough` documentation — `manifest.README.md`
Corrected: `passthrough: true` means the keystroke is delivered to the game IN
ADDITION to firing Overwolf's `onPressed` callback — not "consumed and never
forwarded," which is what the doc said before. The part of the original reasoning
that was actually correct (hotkeys fire regardless of game focus either way) is
kept; only the wrong "consumed" claim was replaced. Added an explicit warning for
whoever picks the next hotkey: get this right before choosing a combo that might
collide with a real in-game bind.

### Re-verification run
- `node -e "JSON.parse(...)"` on `manifest.json` — still valid JSON after the
  version-floor edit.
- `node --check` on every touched `.js` file (`gameState.js`, `owWindows.js`,
  `background.js`) — all pass.
- `gameState.js`'s original 17-assertion suite — re-run in full, all still pass
  (no export was removed or changed shape, only one new export added).
- New 8-assertion suite targeting `toFiniteInt` specifically (see fix 1) — all pass.

### Still not verified — unchanged from round 1, restated for this round
Nothing in this round was tested against a real Overwolf process or a real League
client — I have no way to launch either from this environment. Every fix above is a
best-effort correction against documented/reasoned Overwolf behavior, not something
I watched work. The three highest-risk unverified assumptions specific to this
round's fixes: (a) `getInfo()`'s actual envelope shape — the code now tolerates
both, but which one Overwolf actually sends is still unknown until the first live
run's log line reports it; (b) `overwolf.extensions.onAppLaunchTriggered` existing
at all and using `"gamelaunchevent"` as its origin string for a `launch_events`-triggered
start — if this API doesn't exist or the field is named/shaped differently, the 2s
fallback timeout silently takes over and the desktop window simply never
auto-opens on any launch path, which is a safe failure mode (matches the documented
promise) but not necessarily the intended one; (c) whether `overwolf.windows.sendMessage`
genuinely behaves better/more reliably when given a windowId vs. a declared name —
asserted per the audit's finding, not independently re-derived.
