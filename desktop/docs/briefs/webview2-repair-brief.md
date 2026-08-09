# CoachBuild Desktop v1.0.3 — WebView2 repair robustness + diagnosability

Read `C:/Claude/AI/coachbuild/AGENTS.md` FIRST, then `C:/Claude/AI/coachbuild/wiki/*.md` (architecture, gotchas), before exploring source.

## Field incident (today, user's gaming desktop)

App launch shows the WebView2 fallback ("CoachBuild needs WebView2"). User clicks **Repair WebView2 runtime** → gets "WebView2 repair did not complete. Use the installer repair action and retry." We have NO diagnostics: the version probe swallows its exception, the bootstrapper exit code is discarded, nothing is written to the log.

## Researched facts (Microsoft Learn + WebView2Feedback, 2026-08-09 — cited URLs in `C:/Claude/AI/urgot/data/codex/research-webview2-evergreen-bootstrapper-microsof.md`; copy is in this repo's context if you need the code lists)

1. **The current Evergreen bootstrapper installs PER-USER when run unelevated** and per-machine when elevated. Lack of admin does NOT by itself fail `/silent /install`. Do not add any elevation/runas path.
2. **Exit code 0 is NOT proof the runtime is ready** — WebView2Feedback issue #1349: the installer can exit while the child install is still running. Our single immediate re-probe after `WaitForExitAsync` is therefore wrong and is the most likely cause of the user's exact message.
3. Meaningful failure codes exist (not a guaranteed ABI, treat as hints): `0x80070005` access denied/policy; `0x80072EE7` DNS, `0x80072EFE` connection dropped, `0x80072F8F` TLS — the network trio means "check your internet/firewall"; `0x80070643`/`0x80070002`/`0x80070652`/`1603`/`1618` MSI-level failures.
4. Edge being installed does NOT imply the WebView2 runtime is installed (separate products); debloat scripts remove WebView2. A genuinely missing runtime on the user's machine is plausible and the app must handle it gracefully.
5. .NET `GetAvailableBrowserVersionString` throws `WebView2RuntimeNotFoundException` when no runtime is registered (checks both HKLM and HKCU via the loader).

## Changes (scope: files listed below, nothing else)

### 1) `desktop/src/CoachBuild.Desktop/Web/WebView2EnvironmentService.cs`

- **RepairAsync: replace the single post-exit probe with polling.** After the bootstrapper exits: poll `_versionProbe` every ~2s for up to 120s (cancellable). Success = probe returns a version at any point, REGARDLESS of exit code (installer may exit 0 early per fact 2, and a nonzero wrapper code with a completed child install is still a success). Failure = timeout with no version.
- **Expose a structured result instead of bare bool.** New `RepairResult` (e.g. record with `Success`, `ExitCode` (int?, null if bootstrapper missing/unstartable), `BootstrapperFound` (bool), `Elapsed`). Keep an `IsSuccess`-style convenience. Update callers.
- **Stop swallowing probe detail.** `ProbeVersion` currently `catch { return null; }`. Keep the null contract for availability checks, but record the last probe failure (exception type + message) in a property (e.g. `LastProbeFailure`) so callers can log/show it. Distinguish `WebView2RuntimeNotFoundException` ("runtime not installed" — expected shape) from anything else (loader/DLL problems — unexpected, log loudly).
- Injected `_versionProbe` test seam stays.

### 2) `desktop/src/CoachBuild.Desktop/Web/WebView2Window.xaml.cs`

- `OnRepairRequested`: while repairing, keep the "Repairing WebView2 for this Windows user…" message; on failure show WHAT failed using `RepairResult`:
  - bootstrapper missing from install → "The repair helper is missing from this installation. Reinstall CoachBuild with the latest Setup.exe."
  - network-family exit code (0x80072EE7/0x80072EFE/0x80072F8F) → "The WebView2 download failed — check your internet connection or firewall, then retry."
  - otherwise → include the exit code in hex: "WebView2 install did not finish (installer code 0x…). Retry, or install the runtime from Microsoft and relaunch CoachBuild."
- Kill the dead-end copy "Use the installer repair action and retry" everywhere — Velopack Setup.exe has no repair verb; it pointed the user at nothing.
- On failure ALSO write one structured log line (see 3).

### 3) Logging — `desktop/src/CoachBuild.Desktop/App.xaml.cs` (RedactedLog `_log` already exists, log file `%LOCALAPPDATA%/CoachBuild/companion.log`)

- Log edge-triggered (once per state change, not per poll — follow the existing LCU status=0 edge-trigger pattern, see wiki/gotchas):
  - startup probe verdict: `webview2 probe: available <version>` or `webview2 probe: missing (<exception type>: <message>)`
  - repair attempt result: `webview2 repair: ok in <s>s (exit=<code>)` or `webview2 repair: FAILED exit=<hex> bootstrapperFound=<bool> elapsed=<s>s probe=<last probe failure>`
- Wire whatever plumbing is needed so both the tray-command repair path in App.xaml.cs and the window repair path log through the same helper. Keep it small — no new logging framework.

### 4) Version + tests

- Bump `<Version>` in `desktop/src/CoachBuild.Desktop/CoachBuild.Desktop.csproj` to **1.0.3** (NOTE: it still says 1.0.1 — the 1.0.2 ship forgot it; packaging passes --packVersion separately so the feed was right, but the assembly lied. Fix it now.)
- Tests in `desktop/tests/CoachBuild.Desktop.Tests/`: use the injected `_versionProbe` seam + a fake bootstrapper path.
  - repair succeeds when probe turns non-null on 3rd poll even though exit code was 0 immediately (the #1349 shape)
  - repair succeeds when exit code is nonzero but probe turns non-null (completed child install)
  - repair fails after timeout → result carries exit code + BootstrapperFound=true (use a tiny timeout injected for tests — make poll interval/timeout constructor-injectable with production defaults)
  - bootstrapper file absent → BootstrapperFound=false, no process started
  - probe failure detail captured: non-`WebView2RuntimeNotFoundException` exception surfaces in `LastProbeFailure`
- Run the full desktop test suite + `dotnet build` both Debug and Release. Report exact test count and results.

## Constraints

- Absolute paths only; repo root `C:/Claude/AI/coachbuild`, desktop code under `C:/Claude/AI/coachbuild/desktop`.
- Do NOT touch packaging scripts, updater, tray menu structure, or overlay code beyond what's listed.
- Do NOT add elevation (runas) anywhere — per-user unelevated install is the supported path (fact 1).
- No new dependencies.
- Write `HANDOFF-gpty.md` at `C:/Claude/AI/coachbuild/HANDOFF-gpty.md`: files_changed, test results, any wiki update proposals (do not edit wiki/ yourself).

---

# FOLLOW-UP ROUND (same v1.0.3 ship) — tray menu version line

User request: show the app version on right-click of the tray icon.

- In `desktop/src/CoachBuild.Desktop/Tray/TrayController.cs`, in the menu-populate method, add a disabled `StatusItem` as the FIRST line of the status block (just above `Phase: …`): `CoachBuild v<version>`.
- Version source: the entry assembly's informational version, trimmed of any `+buildmetadata` suffix (with the csproj `<Version>` now correctly 1.0.3 this is truthful). Resolve it ONCE (static readonly), not per menu-open. If Velopack's `UpdateManager` exposes the installed version cheaply where the tray state is built, prefer that; otherwise assembly version is fine — do not add plumbing for it.
- Add a `TrayControllerTests` case asserting the version line is present and disabled, and that it matches the assembly version format (don't hardcode 1.0.3 in the assertion).
- Remember the v1.0.1 lesson: the menu is persistent and populated in its Opening handler — do not reintroduce RebuildMenu-on-state-update.
