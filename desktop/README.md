# CoachBuild Desktop

CoachBuild Desktop is a per-user .NET 8 WPF host for the parts a browser
cannot own: the Windows tray, fullscreen click-through overlay, League/LCU
polling, loopback bridge, WebView2 windows, and updates. It is a client of the
hosted CoachBuild site, not a second web application.

## Hosted web behavior stays unchanged

The native WebView2 window loads the deployed CoachBuild origin and passes the
same persistent session token in the URL that the existing web app expects.
`components/live/companionClient.ts` continues to use the loopback contract,
including `/status`, `/live`, `/skills`, `/me`, `/apply-runes`, and
`/apply-itemsets`. The native overlay does not call `/skills`; it consumes the
in-process Live Client Data skill snapshot. `/skills` remains serialized on the
bridge solely for the unchanged hosted web app.

The hosted PWA remains first-class for phones. No route, mobile layout, or web
polling behavior is forked for this app. Browser users can continue using the
PowerShell companion while the staged native rollout proves parity.

## Runtime ownership

- **Tray/lifetime:** one STA process, one `NotifyIcon`, and the shared
  `Local\CoachBuildCompanion` mutex. A legacy companion holding that mutex is
  treated as a duplicate during rollout.
- **Overlay:** transparent, borderless, topmost, non-focusable and click-through
  by default. It becomes keyboard-interactive only for calibration/adjustment.
  Calibration is stored by monitor resolution and DPI.
- **WebView2:** one owned window with four tabs — Companion, u.gg, Coachless,
  op.gg (1.3.1). The Companion tab navigates between `/draft` and canonical Builds
  URLs and is same-origin only; it is the only tab carrying the session token
  and the only one whose document is ever scripted unprompted (the version meta
  tag). Site tabs are **read-mostly** with two sanctioned exceptions: the gold
  **Import runes** button in the offer bar reads the rune build off the u.gg
  build page you are viewing (u.gg only — Coachless renders no rune page, so
  the button is hidden there), validates it against the local perk/shard
  catalogs, and writes a rune page via the existing LCU service — once per
  click, only on a build-page URL while the client is connected; and the
  **automatic item import** (1.3.0) fetches both sites' item sets in the
  background on champ-select lock (once per champion+role, plus a re-fetch
  when the visible build page's URL changes) and writes them in one merged
  call under per-site `CoachBuild import: {Champ} {Role} (u.gg)` /
  `(Coachless)` titles so both sets coexist. Background fetches reuse a
  background site tab or a hidden worker webview — never the visible tab,
  never a tab switch, never a focus steal — and navigate only to the exact
  deep-link URLs the app builds for the locked champion+role. Runes never
  flow through the automatic path, items never flow through the button.
  op.gg is profile-only: it never appears in the champ-select offer row or
  automatic import. On first/home navigation it resolves current-summoner's
  Riot ID plus LoginDataPacket's platform id and opens
  `https://op.gg/summoners/{region}/{name}-{tag}`; if League is unavailable or
  identity/region is incomplete it opens op.gg home. Site tabs are restricted
  to https. Each tab's WebView2 is created on
  first visit and gets its own profile directory under `WebView2/`, so cookies
  and site preferences persist without sharing storage with the hosted app.
  A native host remains hidden until its browser is ready, and callbacks arriving
  after close are ignored, so app-owned loading/error states remain usable.
  Missing runtime state stays in an app-owned fallback and never opens the
  default browser; a failed page load is a separate state that names the site
  and offers a retry.
- **Updates:** Velopack checks/downloads in the background, defers application
  while the companion is busy, then applies and relaunches when the gate clears.
  The 2-hour loop is the fallback: game end, companion window close, and resume
  from sleep each request an opportunistic check (no-op if a check ran within
  the last 10 minutes). A release staged behind the open window shows a quiet
  one-line hint in the window's status bar; site messages always win that slot.

## Files and persistent paths

The installer is per-user under:

```text
%LOCALAPPDATA%\CoachBuild\Desktop
```

Runtime data is kept under `%LOCALAPPDATA%\CoachBuild`: the existing durable
`companion-session.txt` token, bounded `companion.log`, native
`desktop-settings.json` calibration/settings file, and WebView2 user-data
folder. Credentials are owned by the LCU/state lane; the UI does not put them
in hosted page URLs.

## Build and package

The expected commands are:

```powershell
dotnet restore desktop/CoachBuild.Desktop.sln
dotnet build desktop/CoachBuild.Desktop.sln -c Release
dotnet test desktop/CoachBuild.Desktop.sln -c Release --no-build
dotnet run --project desktop/src/CoachBuild.Desktop/CoachBuild.Desktop.csproj -- -SelfTest
```

Package and publish native artifacts with:

```powershell
pwsh desktop/scripts/package.ps1 -Version 1.0.1
pwsh desktop/scripts/publish.ps1 -Version 1.0.1
```

The Velopack feed is the dedicated public repository
`haroutB5/coachbuild-desktop-releases`. Do not publish native artifacts to the
legacy Electron feed.

WebView2 is Evergreen per-user: the installer should include the Evergreen
bootstrapper, and the tray/fallback repair action can run it on demand. Fixed
Version runtime binaries are intentionally not shipped.

## Verification and cutover

See [docs/verification.md](docs/verification.md) for the contract replay,
clean-profile, update-gate, and performance matrix. The staged migration and
rollback policy are in [docs/cutover.md](docs/cutover.md) and
[docs/release.md](docs/release.md).
