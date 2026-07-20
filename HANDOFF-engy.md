<!-- merged into HANDOFF.md 2026-07-20 19:36:43Z; previous content preserved there. Append new rounds below. -->

## 2026-07-20 — Urgent hotfix: real-mode gameflow loop blind spot (companion v1.2.1, shipped 0.33.1)

### Root cause (honest, not oversold)
Live report: `/live-setup` showed `PHASE: None` while inside a real Practice Tool champ select (`clientConnected: true`), hover never opened anything, consistent across every test including v1.1.0 draft games. I could NOT conclusively isolate the exact failing statement on this machine — there's no League client here, so the credentials-present branch of `Invoke-GameflowTick` (where the live symptoms point) can't be exercised end to end. What I DID conclusively establish:

1. Added a `/status` `lastPollAt` heartbeat and ran the companion in **real mode** on this machine (`powershell -File public/companion.ps1`, no flags — not `-Install`, killed after). Curled `/status` twice 5s apart: `lastPollAt` advanced (`19:46:07.60` → `19:46:12.12`). **This means the WinForms.Timer + `Application.Run()` harness DOES tick correctly in the no-LCU branch on this box** — the "loop never runs at all" theory is not reproduced here.
2. The one thing structurally undeniable regardless: **`-Mock` calls `Update-ChampSelectState` directly (never runs `Start-Companion`'s loop at all) and `-SelfTest` only ever exercises the bridge server — neither test has EVER executed the real gameflow-poll harness.** That blind spot is real and is now closed for good via `-HarnessTest` (see below).

Given I couldn't fully rule in or rule out the credentials-present path here, I implemented the coordinator's requested fix direction regardless (replacing the WinForms.Timer/event-delegate harness with a plain sequential loop) since it strictly reduces reasoning surface — a straight-line `while` loop has no ".NET event dispatched through a message pump" ambiguity to worry about, and every failure mode (hung HTTPS call, CIM flakiness, an unhandled exception mid-tick) now LOGS via `Write-CompanionLog` instead of vanishing into a bare `catch {}`. `Get-LcuCredentials`'s CIM-query catch, previously silent, now logs too.

### Local repro before/after
- **Before** (heartbeat-instrumented but harness unchanged): real mode run, `lastPollAt` advanced correctly in the no-creds branch — could not reproduce a fully dead loop on this machine.
- **After** (plain-loop harness + `-HarnessTest`): `powershell -File public/companion.ps1 -HarnessTest` — spawns a real `-DebugRunSeconds 10` child (tray suppressed), discovers its persisted session token, polls `/status` twice 3s apart, asserts `lastPollAt` advances and required fields are present, kills the child. Result: `HARNESSTEST PASSED`.

### Fix
- `public/companion.ps1`: `Start-Companion` rewritten — WinForms.Timer/`Application.Run()` replaced with `while ($script:CompanionRunning) { ...; Application.DoEvents(); Start-Sleep -Milliseconds 50 }`, ticking `Invoke-GameflowTick` once per `PollMs` via a `Stopwatch`. New `-RunSeconds`/`-SuppressTray` params (used by the new harness test). `/status` gains `lastPollAt`. `Get-LcuCredentials`'s CIM catch now logs.
- New `-DebugRunSeconds N` / `-HarnessTest` flags + `Invoke-HarnessTest` function — the permanent regression guard for this exact blind spot.
- COMPANION_VERSION → 1.2.1.

### Folded-in audit findings (same ship)
- **P1** (`components/hextech/BuildTabContent.tsx`): wrong-champion race in the item-sets auto-export effect — a fallback build could consume the one-shot export ref before the real deep-linked champion's build resolved, permanently blocking its export (no remount ever corrects it). Fixed with a new pure, tested guard: `itemSetsApply.ts`'s `isAutoExportEligibleBuild`.
- **P2** (`public/companion.ps1`): removed the last 2 non-ASCII bytes (`§` in two comments) — the file's invariant is zero non-ASCII bytes (served over `irm | iex`, no encoding guarantee).

### Gates
`tsc` clean, lint clean, **789** vitest tests passed (up from 786), build clean, sw/manifest present. `-SelfTest`, `-Mock -Once`, and the new `-HarnessTest` all `PASSED` on this machine, re-verified after the version bump.

### Deploy
Committed as `harout_b5@live.com` (v0.33.1 / companion v1.2.1), `vercel --prod --archive=tgz`, prod-verified: `companion.version` → `{"version":"1.2.1"}`; served `companion.ps1` contains `lastPollAt`, `DebugRunSeconds`, `HarnessTest`, `Version = '1.2.1'`, zero non-ASCII bytes (verified on the committed file pre-deploy — identical bytes served); `/live-setup` returns 200.

### User steps
1. Tray icon → **Quit** (stops the running v1.2.0 process).
2. Re-run the one-liner: `irm https://coachbuild.vercel.app/companion.ps1 | iex` — fetches and runs v1.2.1 fresh. No need to re-`-Install`.
3. Confirm: `/live-setup` shows version `1.2.1`; enter a real champ select and confirm the Builds page now opens automatically (the actual end-to-end confirmation this hotfix can't get on a dev machine without a League client — genuinely needs the user's own next game).
4. If it's STILL broken after this: the new `lastPollAt` field on `/status` is the next diagnostic step — if it's null or stuck, the loop truly isn't ticking on their machine specifically (a machine-specific quirk this dev box doesn't share); if it advances but `phase` still never leaves `None` during a real champ select, the bug is downstream in the actual LCU credential/gameflow-phase fetch chain, not the loop itself — worth capturing `%LOCALAPPDATA%\CoachBuild\companion.log` (now logs CIM failures and tick exceptions that were previously silent) for the next round.


## 2026-07-20 — Fast-follow hotfix: TLS handshake dies on scriptblock cert callback (companion v1.2.2, shipped 0.33.2)

User re-tested v1.2.1: still Phase:None during a real champ select. Root cause identified and fixed (see CHANGELOG [0.33.2] entry for full detail):

**`[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }` is a PowerShell scriptblock — scriptblocks are runspace-affine, and .NET invokes this callback on a threadpool thread during the TLS handshake that has NO runspace attached.** It throws there, failing the handshake, so every HTTPS call to the self-signed LCU dies (`Invoke-LcuRaw` returns `Ok=$false`) — `phase` can never leave `'None'`, while `clientConnected` stays true regardless (CIM-only check, never reflects an actual successful LCU call). Invisible on this dev box (no League client → no LCU HTTPS ever attempted).

**Fix:** replaced the scriptblock with a compiled `Add-Type` delegate (`CoachBuildCertPolicy.AlwaysTrue`) — compiled code has no runspace affinity, runs on any thread.

**Addendum (user's `companion.log` tail arrived mid-round):** confirmed the actual failure was being swallowed one layer below where v1.2.1's logging lived — inside `Invoke-LcuRaw`/`Get-LiveClientData`/`Get-LcuCredentials`'s own try/catch blocks. Added a new throttled logger (`Write-ThrottledErrorLog`, ~1 log per 60s per distinct failure) so a persistent failure can't flood the 200KB log, and wired it through all three. `/status` gains `lastError`; also discovered `lastPollAt` (added server-side in 1.2.1) was NEVER wired into `companionClient.ts`'s `CompanionStatus` type or rendered on `/live-setup` — fixed both, so the diagnostics panel now genuinely shows everything in one screenshot.

**Honest validation limit:** the TLS-callback fix itself is untestable without a real self-signed HTTPS peer. Confirmed empirically: the compiled delegate builds and applies with zero errors, and a real HTTPS call (valid cert, `coachbuild.vercel.app`) still succeeds with the callback active — but this can't prove the self-signed-cert-over-threadpool-thread scenario resolves. Genuine confirmation needs the user's own `companion.log`/`/status` on their next real champ select.

**Gates:** tsc/lint clean, **792 tests** passed (up from 789), build clean. `-SelfTest` (incl. a new assertion pinning that a real `Invoke-LcuRaw` failure against an unreachable port populates `lastError`), `-Mock -Once`, and `-HarnessTest` all green.

**Deploy:** v0.33.2 / companion v1.2.2, committed as `harout_b5@live.com`, deployed, prod-verified.

**User steps:** Tray → Quit → re-run `irm https://coachbuild.vercel.app/companion.ps1 | iex` → confirm `/live-setup` shows version `1.2.2` → enter a real champ select → check whether Builds now opens automatically. If not: screenshot `/live-setup`'s connection details (now shows last poll time + last error) — that one screenshot should show exactly what's still failing.
