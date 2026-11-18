---
name: verify-coachbuild
description: "Builds the real CoachBuild Draft UI (the Next static export the Windows desktop app embeds) from an empty state, loads it in a real browser under the app's own origin, drives the Draft tab's lane-opponent counters and keeps screenshots and a log as proof. Use before committing any change to desktop/ui, components/hextech/draft, components/live, lib/ugg or the counter tables."
---

# Verify CoachBuild

Surface: CoachBuild is a Windows-only WPF + WebView2 desktop app. It cannot be built, launched or driven on this Linux laptop (and a freshly built exe must never be launched locally: Smart App Control blocks it). What this laptop can run is the embedded UI: `desktop/ui/` is a Next.js static export that the app serves from a folder under `https://coachbuild.local`. This skill builds that export and drives it in a real browser the way the app's window does.

Run it from your own worktree, from the repo root. One command:

```bash
bash .claude/skills/verify-coachbuild/scripts/verify.sh
```

It builds, runs the doctor, drives feature 1, copies the evidence, and always cleans up. Exit 0 is PASS, 1 is a failed feature step, 2 is a launch or doctor failure. The time is printed on the last line, with any heavy-job queue wait shown apart from work (see `qa/verify-skills/coachbuild/BUILD.md` in the dev-team repo for measured numbers).

On this team, run the build through the heavy-job gate:

```bash
VERIFY_WRAP='env -u NODE_ENV bash /home/harout/Claude/AI/dev-team/tools/heavy-job.sh --label coachbuild-verify --' bash .claude/skills/verify-coachbuild/scripts/verify.sh
```

## What this proves and what it does not

It proves the web UI: the export builds, the Draft page renders from the same files the app ships, live champion select data shows as picks, the first visible enemy's counters load with no mark, marking an enemy as the lane opponent adds the pill, switching enemy asks the native u.gg reader for the right slug and lane, and `rankUggCounters` plus `CounterPicksStrip` turn the rows into the two tables (order, flip, pick-rate cut, dedupe, small-sample warning).

It does **not** prove: the WPF shell, the tray, the overlay, the League client bridge (`CompanionHttpServer`), the u.gg page reader, item-set or rune-page writes, Velopack updates, or WebView2 behaviour. Those are the two .NET suites and in-game checks on the gaming PC (`ssh gamingpc`, `desktop/scripts/run-gates.ps1`). The three things outside the page (bridge on `127.0.0.1`, ddragon JSON, `window.chrome.webview`) are fixtures installed by the drive script. Do not use this skill to claim a bridge route, an import or an item-set write works.

## Launch

`scripts/launch.sh` does the following from an empty state.

1. Refuses if the checkout has an `.env` or `.env.*` file (other than `*.example`). A clean worktree has none. CoachBuild needs no credential at all.
2. `npm ci` only if `node_modules` is missing, then `npm run build` (`cd desktop/ui && next build`, static export to `desktop/ui/out/`), both under `env -i` with only `PATH`, `HOME` and `NEXT_TELEMETRY_DISABLED=1`. The old `out/` is removed first so a stale export cannot pass.
3. Records the build stamp (HEAD sha plus a hash of the uncommitted diff) in `.scratch/verify-coachbuild/state.env`.
4. Ready means usable: `out/index.html` exists. The log line is `launch: ready, export at ...`.

There is no server and no port. The app itself has none either (a WebView2 virtual host maps the folder). The drive script serves `out/` by request interception under the same origin. Two worktrees can therefore run side by side.

## Doctor

`bash .claude/skills/verify-coachbuild/scripts/doctor.sh` is read-only. Run it first whenever anything looks off. It checks that the export matches the checkout (so an edit after the build reads as stale), that `index.html` holds the Draft markup, that every `/_next/...` asset it references exists, that the roster fixture and `puppeteer-core` are present and that a Chromium browser is installed. Exit 0 means worth driving.

## Drive

`scripts/drive-draft-counters.mjs` drives feature 1 with puppeteer-core and the system browser (Brave or Chromium, or set `CHROME_PATH`). Viewport 1280 x 900, fresh incognito context, every host except `coachbuild.local` and the ddragon icon CDN is unreachable (`--host-resolver-rules=MAP * ~NOTFOUND`) and unexpected requests fail the run.

```bash
node .claude/skills/verify-coachbuild/scripts/drive-draft-counters.mjs --ui desktop/ui/out --root . --out <dir> --profile .scratch/verify-coachbuild/browser
```

Handles it uses, all from this repo:
- `[aria-label="Change your champion from Ahri"]` (live own pick), `[aria-label="Mark Aatrox as your lane opponent"]`, `[aria-label="Aatrox is your lane opponent"]`.
- `#d25-table-best` and `#d25-table-worst`, each `.d25-trow` with `.d25-cname`, `.d25-val-gold` or `.d25-val-wr`, `.d25-games`; `.d25-badge`, `.d25-warn`.
- `.d25-chead-title` (`Counters vs Aatrox`), `.d25-pill-laneopp` (`Lane opponent`, present only after a mark), `.d25-meta` (`Patch 16.18`), `.d25-warn`.
- Champion icons are a 1 px fixture image (ddragon PNGs are stubbed), so portraits show white squares in screenshots.

The fixture rows are synthetic, one set per enemy and different from each other (Aatrox ten rows with a small-sample warning, Darius twelve rows without), and the expected tables are written into the script by hand from the rules in `lib/ugg/counters.ts`, not computed by the app. Other features in `features/` are mapped but not yet scripted. Add a drive script per feature there and call it from `verify.sh`.

## Evidence

`.scratch/verify-coachbuild/evidence/<UTC stamp>/`, with `evidence/latest` pointing at the newest.

- `01-draft-live.png`, `02-counters-aatrox.png`, `03-counters-darius.png` (1280 x 900), plus `failure.png` on a failed step.
- `drive.log` (each step, both tables as read, the u.gg requests) and `drive.json` (u.gg requests, bridge calls, lane-score submissions, blocked external requests, page errors).
- `run.log`, `build.log`, `npm-ci.log`.

Proof standard: the action and the state it caused. The drive clicks the real lane-opponent button and reads what the user sees: each table must be a visible box that nothing covers, and rows are read from visible rows as `innerText`, so a table hidden by CSS fails even though its rows are in the DOM. Visually hidden text is never asserted. It also reads what the page sent outward: the native u.gg request list (slug, lane, enemy id) and the bridge call list, which must hold no POST, PUT or DELETE. Do not set React state or `window.__draftTest` yourself and call that a UI proof.

## Cleanup

`bash .claude/skills/verify-coachbuild/scripts/cleanup.sh`. It stops the browser pid recorded in `state.env` (if the drive died before closing it) and removes that file. It never kills by name. It keeps `desktop/ui/out`, logs and every evidence directory. `verify.sh` runs it on exit, also after a failure. After any failed or interrupted attempt run it by hand, or the next launch refuses with "earlier run is not cleaned up".

## Isolation

No shared instance exists to corrupt: nothing listens on a port and nothing touches `%LOCALAPPDATA%\CoachBuild`, the League client, the loopback bridge ports 48291-48293, or any real account. Never point this skill at a real bridge: it would let a page write item sets and rune pages. The `out/` folder is per checkout, so run one verify per worktree at a time.

## Maintenance

Run `/maintain-verification-skill` when the Draft page, the counter tables or `lib/ugg` change, so the map and selectors stay true. Add the failing journey to `features/` Gotchas instead of weakening a step.
