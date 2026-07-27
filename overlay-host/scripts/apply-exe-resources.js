#!/usr/bin/env node
// Applies exe resources (icon, version info, and the requireAdministrator
// manifest) to dist/win-unpacked/CoachBuild Overlay.exe -- the step
// electron-builder itself would normally do via its `signAndEditExecutable`
// pipeline, which this project cannot use as-is. See the big comment below
// for why, and see package.json's "dist" script for how this fits into the
// three-step build (`dist:unpacked` -> this script -> `dist:package`).
//
// WHY THIS EXISTS (2026-07-27, packaging round):
//
// electron-builder's default Windows resource-editing step
// (WinPackager.signAndEditResources, called whenever `signAndEditExecutable`
// is not explicitly false) always shells out to a `rcedit-x64.exe` binary
// bundled inside its "winCodeSign" vendor package -- EVEN when no code
// signing is configured or intended, and even for the parts of that step
// (icon, version strings, the exe manifest) that have nothing to do with
// signing. On THIS machine, extracting that vendor package fails: it's a
// single archive containing tooling for Windows, macOS, and Linux, and 2 of
// its entries (macOS-only .dylib symlinks under darwin/10.12/lib/, needed by
// NOTHING in a Windows build) cannot be extracted without Windows Developer
// Mode enabled or an elevated process (`SeCreateSymbolicLinkPrivilege`) --
// confirmed directly with `mklink`, which failed with "You do not have
// sufficient privilege to perform this operation." electron-builder treats
// that as a hard extraction failure and retries the ENTIRE download+extract
// indefinitely rather than proceeding with the (fully valid) 99% of the
// archive it doesn't need -- verified this hangs for 280+ seconds with no
// sign of ever recovering on its own.
//
// The fix here downloads the SAME public archive electron-builder would have
// (no auth, no new dependency -- see below) and extracts ONLY the two named
// files this project actually needs (`rcedit-x64.exe`/`rcedit-ia32.exe`) via
// 7-Zip's "extract specific file by name" mode, which never touches the
// problematic macOS symlink entries at all and so never hits the privilege
// error. Then it runs rcedit directly with the exact flags electron-builder's
// own signAndEditResources() would have used (see
// node_modules/app-builder-lib/out/winPackager.js).
//
// NOT a new project dependency: the actual `rcedit-x64.exe`/`rcedit-ia32.exe`
// binaries and the 7-Zip binary used to extract them (`7zip-bin`) are BOTH
// already transitive dependencies of `electron-builder` -- the one new
// devDependency this round was scoped to add. This script only adds ~120
// lines of plain Node using what's already in node_modules plus one HTTPS
// download of a public GitHub release asset (same URL electron-builder's own
// binDownload.js would fetch).
//
// If Windows Developer Mode is ever enabled on the build machine (Settings ->
// Update & Security -> For Developers), electron-builder's own pipeline would
// likely work directly and this whole workaround becomes unnecessary -- this
// script would still work fine alongside it, just redundantly.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WIN_UNPACKED_EXE = path.join(ROOT, 'dist', 'win-unpacked', 'CoachBuild Overlay.exe');
const ICON_PATH = path.join(ROOT, 'assets', 'icon.ico');

/** Windows version resources are a 4-part numeric tuple; package.json's semver
 *  is 3 parts, so pad. Anything non-numeric (a `-beta` suffix) is stripped —
 *  rcedit rejects a non-numeric component outright, and failing the whole build
 *  over a prerelease tag would be a worse outcome than dropping it. */
const EXE_VERSION = (() => {
  const semver = String(require(path.join(ROOT, 'package.json')).version || '0.0.0');
  const parts = semver.split('.').map((p) => parseInt(p, 10)).filter((n) => Number.isFinite(n));
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join('.');
})();
const SEVEN_ZA = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');

// Same public archive + version electron-builder's own codeSign/windowsSignToolManager.js
// (getSignVendorPath -> binDownload.getBin('winCodeSign')) would fetch.
const WINCODESIGN_URL =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';

// Cached under the OS temp dir, not inside the repo -- this is a downloaded
// build tool, not project source, same category as node_modules.
const CACHE_DIR = path.join(require('os').tmpdir(), 'coachbuild-overlay-rcedit-cache');
const ARCHIVE_PATH = path.join(CACHE_DIR, 'winCodeSign-2.6.0.7z');
const RCEDIT_X64 = path.join(CACHE_DIR, 'rcedit-x64.exe');

function log(msg) {
  console.log(`[apply-exe-resources] ${msg}`);
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl, redirectsLeft) => {
      https
        .get(currentUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectsLeft <= 0) {
              reject(new Error('too many redirects downloading ' + url));
              return;
            }
            res.resume();
            request(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`download failed: HTTP ${res.statusCode} for ${currentUrl}`));
            res.resume();
            return;
          }
          const fileStream = fs.createWriteStream(destPath);
          res.pipe(fileStream);
          fileStream.on('finish', () => fileStream.close(() => resolve()));
          fileStream.on('error', reject);
        })
        .on('error', reject);
    };
    request(url, 5);
  });
}

async function ensureRceditBinary() {
  if (fs.existsSync(RCEDIT_X64)) {
    log(`using cached rcedit at ${RCEDIT_X64}`);
    return RCEDIT_X64;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (!fs.existsSync(ARCHIVE_PATH)) {
    log(`downloading ${WINCODESIGN_URL}`);
    await downloadFile(WINCODESIGN_URL, ARCHIVE_PATH);
  }

  log('extracting rcedit-x64.exe / rcedit-ia32.exe by name (skips the macOS-only entries that fail to extract without Windows Developer Mode)');
  execFileSync(SEVEN_ZA, ['e', '-y', `-o${CACHE_DIR}`, ARCHIVE_PATH, 'rcedit-x64.exe', 'rcedit-ia32.exe'], {
    stdio: 'inherit',
  });

  if (!fs.existsSync(RCEDIT_X64)) {
    throw new Error(`extraction did not produce ${RCEDIT_X64}`);
  }
  return RCEDIT_X64;
}

async function main() {
  if (!fs.existsSync(WIN_UNPACKED_EXE)) {
    throw new Error(`expected exe not found at ${WIN_UNPACKED_EXE} -- run the "dist:unpacked" step first`);
  }
  if (!fs.existsSync(ICON_PATH)) {
    throw new Error(`expected icon not found at ${ICON_PATH}`);
  }

  const rcedit = await ensureRceditBinary();

  // Same fields/flags as WinPackager.signAndEditResources() in
  // node_modules/app-builder-lib/out/winPackager.js, minus the actual signing
  // call (this app is deliberately unsigned -- see README).
  const args = [
    WIN_UNPACKED_EXE,
    '--set-version-string', 'FileDescription', 'CoachBuild Overlay',
    '--set-version-string', 'ProductName', 'CoachBuild Overlay',
    '--set-version-string', 'LegalCopyright', 'Personal use',
    '--set-version-string', 'InternalName', 'CoachBuild Overlay',
    '--set-version-string', 'OriginalFilename', 'CoachBuild Overlay.exe',
    // Read from package.json, NOT hardcoded. These were pinned at '0.1.0.0'
    // and stayed there when the app moved to 0.2.0 -- a hardcoded version in
    // the one step that stamps the exe is a value that can only ever drift,
    // and it drifts SILENTLY: nothing fails, the exe just misreports itself in
    // its properties dialog and in any crash report keyed on file version.
    // (It does not affect auto-update, which compares package.json/latest.yml.)
    '--set-file-version', EXE_VERSION,
    '--set-product-version', EXE_VERSION,
    '--set-icon', ICON_PATH,
    // CHANGED 2026-07-27 ("one app" round) from 'requireAdministrator' to
    // 'asInvoker'. This is the ACTUAL stamping step for the built exe --
    // package.json's build.win.requestedExecutionLevel does nothing here,
    // because signAndEditExecutable:false means electron-builder never runs
    // its own manifest step at all; THIS rcedit call is the only place the
    // manifest gets set (found by building and checking the real exe with
    // findstr, exactly as instructed -- the package.json edit alone silently
    // did not take effect the first time). requireAdministrator was added
    // chasing a hotkey-vs-Vanguard theory that root-caused elsewhere (F12 is
    // permanently reserved by Windows, see main.js's HOTKEY_TOGGLE_ADJUST
    // header) and is strictly worse for autostart: an elevated app cannot be
    // silently autostarted, it UAC-prompts at every sign-in. See
    // HANDOFF-engy.md for the full reasoning.
    '--set-requested-execution-level', 'asInvoker',
  ];

  log(`applying resources to ${WIN_UNPACKED_EXE}`);
  execFileSync(rcedit, args, { stdio: 'inherit' });
  log('done -- verify with: findstr /c:"requireAdministrator" "' + WIN_UNPACKED_EXE + '" (or see README)');

  writeAppUpdateYml();
}

/**
 * Write `resources/app-update.yml` — the file electron-updater reads at runtime
 * to learn WHERE to check for updates.
 *
 * WHY THIS IS HERE AND NOT ELECTRON-BUILDER'S JOB
 * -----------------------------------------------
 * Normally it IS electron-builder's job: it emits this during its packaging
 * step. But this project cannot use that step (see the long comment at the top
 * of this file), and packages via `--prepackaged` against an already-built
 * directory — which electron-builder does not inject into. So the file was
 * simply never produced, and the shipped app failed at runtime with:
 *
 *   Update: check failed (ENOENT: no such file or directory,
 *                         open '...\resources\app-update.yml')
 *
 * Caught only because the tray surfaces updater errors. With the error confined
 * to a log file nobody opens, this would have looked exactly like "auto-update
 * silently does nothing" — the failure mode the whole feature exists to avoid,
 * and one that would have been indistinguishable from "no update available".
 *
 * Derived from package.json's `build.publish` so it can never disagree with
 * where the release was actually published to.
 */
function writeAppUpdateYml() {
  const pkg = require(path.join(ROOT, 'package.json'));
  const publish = Array.isArray(pkg.build && pkg.build.publish)
    ? pkg.build.publish[0]
    : (pkg.build || {}).publish;

  if (!publish || publish.provider !== 'github' || !publish.owner || !publish.repo) {
    // Loud, not silent: shipping without this file produces an app that looks
    // fine and can never update itself.
    throw new Error(
      'build.publish is missing or not a complete github provider — refusing to ' +
      'build an app that cannot check for updates. Fix package.json.'
    );
  }

  const lines = [
    'provider: github',
    `owner: ${publish.owner}`,
    `repo: ${publish.repo}`,
    // electron-updater namespaces its download cache by this; it defaults to
    // the app name, and a stable explicit value avoids a surprise rename
    // stranding a half-downloaded update in an orphaned folder.
    `updaterCacheDirName: ${pkg.name}-updater`,
    '',
  ];

  const target = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app-update.yml');
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
  log(`wrote ${target}`);
}

main().catch((err) => {
  console.error('[apply-exe-resources] FAILED:', err.message);
  process.exit(1);
});
