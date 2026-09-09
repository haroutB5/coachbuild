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
- **WebView2:** one owned window with four tabs — Draft, u.gg, Coachless and
  op.gg. Draft is same-origin only, carries the session token, and hosts the
  shipped local page. The public site tabs are **read-mostly**. Automatic import
  fetches u.gg and Coachless on champ-select lock and on a visible build-page
  change. u.gg contributes its embedded items and runes; Coachless items are a
  single read of the initial top-WPA row for Starter, 1st, 2nd, 3rd, 4th+ and
  Boots, while its full rune build comes from its separate runes page. On a
  roleless lock, u.gg's discovered active role is used for the Coachless target
  so the sites cannot silently choose different lanes.

  Item sets keep their per-site `CoachBuild import: {Champ} {Role} (u.gg)` /
  `(Coachless)` titles. Rune pages are automatic and named `u.gg {Champ}` /
  `Coachless {Champ}`, with `(Role)` only when champ select assigned one. There
  is no offer bar or Import runes button. u.gg gets priority when only one
  editable/reusable rune-page slot exists; non-CoachBuild pages are untouched.
  Background fetches reuse a background site tab or hidden worker — never the
  visible tab, a tab switch, or focus — and navigate only to app-built links.

  op.gg remains profile-only and resolves the current summoner's profile when
  League identity is available. All public tabs are HTTPS-only and keep separate
  persistent profiles. u.gg, Coachless, op.gg and import workers reject a narrow
  maintained adtech-domain list at request time; Draft, first-party/CDN hosts and
  consent-management traffic are never filtered. Browsers are created lazily,
  and app-owned loading/error states remain available if creation or navigation
  fails.
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
