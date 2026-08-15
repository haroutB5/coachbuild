# Desktop release and rollback

## Release identity

Native releases are .NET 8 Windows x64 per-user packages produced by Velopack.
They are independent of the Electron version and feed. The only native release
repository is:

```text
https://github.com/haroutB5/coachbuild-desktop-releases
```

The default install root is `%LOCALAPPDATA%\CoachBuild\Desktop`; no UAC or
machine-wide Program Files install is required.

## Package

From a Windows machine with the .NET 8 SDK and `vpk` available:

```powershell
pwsh desktop/scripts/package.ps1 -Version 1.0.1
```

The script publishes the WPF app, packs delta-capable Velopack artifacts, and
warns if the Evergreen WebView2 bootstrapper is absent. It does not bundle a
Fixed Version WebView2 runtime.

## Publish

Use a token with permission to publish the dedicated repository:

```powershell
$env:GITHUB_TOKEN = '…'
pwsh desktop/scripts/publish.ps1 -Version 1.0.1
```

Never substitute `coachbuild-overlay-releases`, the old Electron feed.

The script passes `--publish true` to `vpk upload github`, so the release is
live on the feed as soon as it uploads. This is deliberate: `vpk`'s default is a
**draft** release, GitHub never serves a draft as `latest`, and the in-app
Velopack updater therefore never sees it — the 1.0.7 release had to be published
by hand for exactly this reason.

To stage a release without exposing it to the updater, pass `-Draft`:

```powershell
pwsh desktop/scripts/publish.ps1 -Version 1.0.1 -Draft
```

You must then publish it manually (GitHub UI, or
`gh release edit <tag> --draft=false`) before any client will update.

After publishing, verify against the feed:

```powershell
gh release view --repo haroutB5/coachbuild-desktop-releases --json tagName,isDraft,isPrerelease
```

`latest/download/releases.win.json` and `latest/download/RELEASES` must both
return HTTP 200 and advertise the new version.

## Update behavior

Velopack checks in the background and downloads deltas into its transactional
pending state. The app exposes Checking, Downloading, Ready, DeferredBusy,
Applying, and Error in the tray. It does not create an independent pending
marker. If ChampSelect or InProgress is busy, the downloaded update remains
ready/deferred; clearing the gate applies it and lets Velopack relaunch the new
process automatically.

## WebView2 prerequisite

The installer should place the Evergreen per-user bootstrapper under the app's
`WebView2` folder. Startup detects the runtime before WebView2 window creation.
If absent, the app-owned fallback stays usable and the tray repair action runs
the bootstrapper on demand. A retry then opens the hosted `/draft` or Builds
page in the same native window. The default browser is never used as a repair
or navigation fallback.

## Rollback checklist

1. Stop publishing the failing native release and record the release/tag.
2. Use Velopack's previous transactional release to roll back, or install the
   last known-good native package from the dedicated feed.
3. Confirm the shared mutex is released and only one bridge writer remains.
4. If the native app cannot start, temporarily restore the legacy Electron or
   PowerShell companion. The hosted PWA remains available throughout.
5. Re-run bridge parity, write-safety, WebView2 fallback, and one-game overlay
   checks before resuming staged rollout.
