# CoachBuild — technical reference

**Describes desktop 2.0.0, 2026-09-08.** `desktop/src/CoachBuild.Desktop/CoachBuild.Desktop.csproj`'s
`<Version>` is the single source of truth for the app version. If it has moved on
since this date, treat everything below with more skepticism the further it has
fallen behind, and check `CHANGELOG.md` for what shipped after.

**v2.0.0 is a product change, not a refactor: the hosted web app is gone.**
CoachBuild is now one Windows desktop application. There is no website, no
serverless function, no database, no cron and no scheduled task. The repository
still contains a `components/` and `lib/` tree, but those are now a **component
library for the desktop app's embedded UI** rather than a deployed Next.js site.

The v1 document — the six web surfaces, the API route table, the Neon schema, the
ingest fleet, the consensus artifact, and the measurements behind all of it — is
preserved verbatim at **`docs/archive/CLAUDE-v1-web.md`**. Go there to recover a
*reason*; do not go there to look up current behaviour.

---

## The shape of the thing

```
CoachBuild.Desktop (WPF, net8.0-windows, Velopack-installed, per-user)
├── tray                     status, reopen, calibrate, quit
├── overlay                  in-game skill-order overlay (native, DirectComposition)
├── LCU bridge               CompanionHttpServer on 127.0.0.1:{48291,48292,48293}
│                            reads the League client, writes item sets + rune pages
└── WebView2 window, four tabs
    ├── Draft      ← LOCAL static page shipped inside the app  (was "Companion")
    ├── u.gg       ← real site, auto item-set import + runes button
    ├── Coachless  ← real site, auto item-set import
    └── op.gg      ← real site, own profile via LCU riot-id
```

Everything the app knows comes from one of exactly four places, and it is worth
memorising the list because "where did this number come from" was answerable in
v1 only by reading a pipeline:

1. **The League client** (LCU + Live Client Data), through the bridge.
2. **ddragon** (`ddragon.leagueoflegends.com`), a keyless public CDN.
3. **lolalytics**, one HTML page per (enemy champion, lane), fetched on demand.
4. **The three site tabs**, which are the real websites, read by extractor scripts.

There is no fifth. If you find yourself adding one, that is a product decision.

## The Draft tab is a local page (the 2.0.0 core change)

Through 1.3.1 the first tab was called **Companion** and loaded
`https://coachbuild.vercel.app/live-setup`. It now loads a static export shipped
inside the package.

- **Source:** `desktop/ui/` — a Next.js app in `output: "export"` mode with exactly
  one route. `desktop/ui/app/page.jsx` re-exports `desktop/ui/DraftPage.tsx`;
  `layout.jsx` pulls in the repo's `app/globals.css` so the Nocturne styling is
  the same one the web app used. It imports the shared draft components from
  `components/` and `lib/` through the `@/*` path alias.
- **Build:** `npm run build` (`next build desktop/ui`) writes `desktop/ui/out/`.
  The **desktop build runs this itself** — `desktop/build/DraftUi.targets`, imported
  by both `CoachBuild.Desktop.csproj` and `CoachBuild.Desktop.Tests.csproj`, so a
  plain `dotnet build` of the solution always produces a runnable app.
- **Packaging:** the export is copied to `UI/` next to the app binary, on both the
  build and the publish path (`CopyDraftUiToOutput` / `PublishDraftUi`).
- **Serving:** `WebView2Window.ConfigureBrowser` calls
  `SetVirtualHostNameToFolderMapping(_policy.Origin.Host, {BaseDirectory}/UI, DenyCors)`
  for the Companion tab only. The origin is `https://coachbuild.local`
  (`CompanionWire.AppOrigin`) — a *real* https origin with no server behind it,
  which is what keeps `HostedPagePolicy`, the bridge's exact-Origin CORS check and
  the navigation allowlist working unchanged.
- **Entry point:** `HostedPagePolicy.BuildUrl` always resolves to
  `https://coachbuild.local/index.html?session=<token>`. **The file name is
  explicit on purpose** — a virtual-host mapping resolves a URL path to a file and
  serves no default document, so a bare `/` is a dead navigation. Every legacy
  reopen destination (Draft / Builds / Home) collapses to this one page.

### The packaging trap, because it cost real time and leaves no symptom

The first implementation declared the export as `<Content>` items **from inside an
MSBuild target**. MSBuild then paired the copy wrongly: it took the *destination*
names from the Content items that already existed (`Assets\tray-icon.ico`, the
WebView2 loader) and the *sources* from the export, so the output grew a `UI/`
folder containing two files with the app's names and the export's bytes, and **no
`index.html`**. Every gate stayed green — the solution built, 914 tests passed, the
`next build` step printed success — and the shipped app's first tab would have
opened nothing.

Three things now make that non-silent, and none of them is a comment:

- `DraftUi.targets` uses explicit `<Copy>` and `ResolvedFileToPublish` with `->`
  transforms, which pair each source with its own destination by construction.
- `WebView2WindowTests.TheDraftPageIsPackagedNextToTheAppBinary` asserts
  `UI/index.html` exists next to the binary, contains a `/_next/` reference, and
  has at least one script bundle beside it. The test project imports the same
  targets file, so the assertion exercises the shipping mechanism rather than a
  test fixture.
- `desktop/scripts/package.ps1` re-checks both in the publish output before `vpk`
  runs, next to the existing tray-icon assertion.

### The styling trap, which is the same shape and was found the same way

**Tailwind must be configured by `desktop/ui/tailwind.config.cjs` through its own
auto-discovery, and the build must run with `desktop/ui` as cwd.** Both halves are
load-bearing and neither fails loudly.

Passing the config inline — `tailwindcss: { ...config, content: [absolute globs] }`
in `postcss.config.mjs` — **silently does nothing under Turbopack**: the options
object never reaches Tailwind, so it runs with an empty content list. Tailwind's
argument is `configOrPath` (see `node_modules/tailwindcss/lib/plugin.js`), not an
options bag, so even where the object does arrive, `{ config: {...} }` is read as
a config whose only key is `config`. Either way `@tailwind base` still expands, so
preflight lands and the stylesheet looks plausible — **6,287 bytes of it** — while
not one utility class is emitted and the packaged page ships unstyled. The correct
arrangement produces **20,182 bytes**. Running `next build desktop/ui` from the
repo root fails the same way for a different reason: the config's relative content
globs then resolve against the root and match nothing.

`npm run build` is therefore `cd desktop/ui && next build`, and the csproj's
`BuildDraftUi` sets `WorkingDirectory` to the UI directory.

The packaging test asserts three real utility classes (`.mx-auto`, `.rounded-lg`,
`.font-semibold`) are present. **It resolves the stylesheets through
`index.html`'s own `<link href>` values, never by globbing `*.css`** — the copy
step does not remove superseded hashes, so a glob reads a stale stylesheet from an
earlier build and passes regardless of what this build produced. That is not
hypothetical: the first version of this assertion globbed, and a deliberately
broken config passed it. Mutating `content` to `[]` now fails the test.

### What the Draft page does

`desktop/ui/DraftPage.tsx` is a single client component:

- **Champions** from ddragon (`lib/ddragonClient.ts`) — one memoised fetch of
  `versions.json` + `champion.json`, no API and no database. A failure renders an
  explicit alert, never an empty picker that reads as "no champions exist".
- **Live champ select** by polling the bridge's `/status` through the unchanged
  `components/live/companionClient.ts` (1s in ChampSelect, 3s otherwise). Lane,
  enemies and hover auto-fill through `resolveDraftLiveTarget`; the manual-dirty
  latch and the champ-select entry reset are the same
  `components/live/draftLiveSync.ts` logic the web page used, including the
  **v0.128.0 rule that marking a lane opponent must not latch dirty** (it froze
  live auto-fill mid-draft; `draftLaneOppDirty.test.ts` still pins it).
- **Counter picks** via `CounterPicksStrip`, fed by `desktop/ui/localCounters.ts`.
- **Champion pool** from the bridge's new `/draft/pool`.
- **Live setup** collapsed into a status section at the bottom of the same page —
  the old `/live-setup` route is gone, and the header link is an in-page anchor.

## Bridge endpoints added in 2.0.0

Both sit behind the existing gates — exact-Origin check, then session token — and
both are in `CoachBuild.Core/CompanionHttpServer.cs`.

```
GET /draft/pool?session=            the local player's top 20 champions by mastery
                                    points, descending, from the LCU's
                                    /lol-champion-mastery/v1/local-player/champion-mastery.
                                    503 no-client / pool-unavailable; never a
                                    partial list presented as a whole one.
GET /draft/counters-html?slug=&lane=&patch=&session=
                                    fetches ONE fixed upstream URL —
                                    lolalytics.com/lol/{slug}/counters/ at
                                    emerald_plus — and returns the bytes as
                                    text/plain. 502 counters-unavailable on any
                                    non-2xx or transport failure.
```

Three deliberate properties of `/draft/counters-html`:

- **The upstream URL is constructed here, from validated parts, and is not a
  parameter.** `slug` is `^[a-z0-9]{1,40}$`, `lane` is one of five literals,
  `patch` is `^[0-9]{1,3}\.[0-9]{1,3}$`. The endpoint cannot be turned into an
  open proxy by anything the page sends.
- **`AllowAutoRedirect = false`**, so a redirect cannot walk the fetch to another
  host, and the response is capped at 4 MB with a 15 s timeout.
- **It answers `text/plain`, not `text/html`.** The client parses the bytes; the
  browser never executes them. This is why serving lolalytics' markup through the
  app's own origin is not a script-injection surface.

This endpoint exists because the parse used to live in a server route
(`/api/draft/counters`). The parser itself is unchanged and still lives in
`lib/lolalytics/counters.ts`; only the transport moved.
`desktop/ui/localCounters.ts` keeps the 24-hour cache that route's runtime cache
used to provide, in-process, bounded at 30 entries.

## What the Draft page inherits, unchanged and still load-bearing

These are the parts of the v1 draft work that survived, with the reasons that
made them non-obvious. Do not re-derive them.

- **`lib/lolalytics/counters.ts` proves DIRECTION before it trusts a row.** The
  page being parsed is the *enemy's* counters page, so a row champion counts as
  beating the enemy only when the enemy's own win rate against it is below 50%,
  cross-checked against the card's tooltip sentence. A shape change produces a
  typed `LolalyticsCountersError`, never a silent empty list. 500-game floor.
- **`resolveCounterPickPool` is the single precedence seam:** a non-empty
  companion/LCU pool wins, otherwise the overall top five. In v1 the LCU input was
  permanently `null` because the bridge exposed no mastery ids — **`/draft/pool`
  closes that gap**, and the My Stats fallback that stood in for it is gone with
  the rest of My Stats.
- **`ChampionNameKey.Normalize` / `normalizeChampName` is shared, so no per-site
  champion-name table exists to drift.** u.gg serves `monkeyking`; coachless 302s
  it to `wukong`.
- **Champion ids ≥ 60000 are alternate-art entries, not champions.** Filter them
  before any upstream request. Four days of false "unhealthy" in 2026-07 came from
  asking u.gg for 60001.

## What the site tabs do (unchanged from 1.3.x)

`desktop/src/CoachBuild.Desktop/Web/` — `CompanionTabs.cs` is the whole pure layer
(tab model, deep links, nav policy, preferences).

- Each tab is created **lazily on first visit**, into its **own** WebView2 profile
  directory (`WebView2/` for Draft — the legacy root, so an upgrade signs nobody
  out — plus `WebView2/ugg`, `/coachless`, `/opgg`). Cloudflare clearance and
  cookies persist per site without sharing storage with the app session.
- `SiteNavigationPolicy` allows **https only, any host**, and refuses non-http
  schemes so a page cannot hand Windows a `steam:`/`ms-settings:` URI through
  `NewWindowRequested`. There is no address bar, so every navigation still starts
  from a link on a site the user chose.
- **Read-mostly is structural, not a promise.** `SiteTabComplianceTests` fails the
  build if an `ExecuteScriptAsync` call appears outside the four sanctioned
  extractor families (`RunRunesImportAsync`, `RunCoachlessWalkAsync`,
  `ExtractVisibleOnUiAsync`, `FetchViaWorkerAsync`) or if automated navigation
  reaches any call site but the allowlisted worker fetch. **In 2.0.0 the count
  dropped from five to four**: the fifth was the `coachbuild-version` meta read,
  retired with the hosted page.
- **Auto item-set import** (`SiteAutoImport.cs`): on champ-select lock, once per
  champion+role, and on a visible build-page URL change, both sites' item sets are
  fetched in the background and written in **one merged call**, so the per-site
  `CoachBuild import: {Champ} {Role} (u.gg)` / `(Coachless)` titles coexist. Two
  sequential single-set writes would not — the merge drops every `CoachBuild*` set
  it reads, which is exactly why the batch exists.
- **The Import runes button** is u.gg-only, one read-only script per click, hidden
  on Coachless (there is no rune page there).
- **op.gg** resolves `gameName`/`tagLine` and the platform id from the LCU and
  opens the user's own profile; anything missing opens `op.gg` without guessing.

## The web-freshness check is gone

1.0.15 through 1.3.1 read a `coachbuild-version` meta tag out of the loaded page,
showed it in the tray, and re-navigated on champ-select entry when it disagreed
with `GET /api/app-version`. **All of it is deleted** — `WebAppVersionClient.cs`,
`LoadedWebVersion`, `WebVersionObserved`, `CheckWebFreshnessAsync`,
`EnteredChampSelect`, `TrayMenuState.WebVersion`/`WebWindowOpen`/`WebVersionLine`.

It was solving a problem that no longer exists: the page's code now ships with the
app, so the version in the tray *is* the version of the page. Do not reintroduce a
freshness check against a hosted origin; there isn't one.

## Retired in 2.0.0, and why

| Gone | Reason |
|---|---|
| Builds page + `lib/recommend.ts` + consensus artifact | The app's own item recommender is dead by user decision; u.gg/Coachless imports replace it. |
| Post-game, My Stats, Pro Players, Patch Movers | Web surfaces with no desktop equivalent; forgotten by decision. |
| Every `app/api/**` route | Serverless functions with no deployment. |
| `lib/db`, the Neon client, `migrations/` readers | No database. |
| All `scripts/ingest-*`, `generate-consensus-artifact`, `rebuild-controller`, `rebake-consensus`, `register-*-task.ps1` | Nothing to ingest into. |
| SW / PWA plumbing (`public/sw.js`, `manifest.webmanifest`, icons) | No website to install. |
| `RankSampleClient`'s live transport, diagnostics upload | No collection endpoint. Replaced by `RetiredHostedSink`, which rejects every post rather than throwing — see below. |
| `SkillOrderProvider.DefaultEndpoint` | No `/api/skill-order`. The endpoint is now nullable and a null endpoint answers `NoData` without a request. |

**Two retirements were done as *inert seams*, not deletions, and that is
deliberate.** `RetiredHostedSink` still implements `IRankSampleSink` and
`IDiagnosticsSink` and answers `Rejected`; `SkillOrderProvider` still takes an
optional endpoint. Both keep their services constructible and their contract tests
meaningful, so if a local replacement ever arrives there is a seam to fill rather
than a rewrite. Neither makes a network call in production.

**The overlay was reduced honestly.** It rendered skill-order data from
`/api/skill-order`. With no endpoint, `SkillOrderProvider` returns `NoData` and the
overlay draws live ability state from the Live Client Data API only — it does not
invent an order, and it does not fall back to a stale one. The
situational-WPA item-number overlay was already removed in desktop 1.0.23 for
unrelated reasons and did not come back.

## HARD RULES (do not violate without a new explicit user directive)

1. **Never delete or overwrite an LCU rune page or item set whose title does not
   start with `"CoachBuild"`** — with one carve-out: a **manual** rune apply does
   GET → DELETE → POST regardless of title, because a real click is real consent
   and a free account with two rune slots would otherwise have nowhere to put the
   page. The rule is absolute for the automatic path and for item sets.
2. **Exactly one item set per champion+role.** Title/uid are
   `CoachBuild <champ> <role>` / `coachbuild-<champ>-<role>`, byte-identical to
   every shipped version so an existing install is replaced in place. The LCU PUT
   replaces the **whole document** and is rejected all-or-nothing, so the merge
   must post the entire list — never a subset, that deletes the rest. A real
   capture measured 61,060 bytes across 62 sets on a live account: a merge bug is
   someone's data, not a rebuildable cache.
3. **No fabricated data.** A missing value renders as an explicit absence, never a
   plausible number. A curated or estimated value is labelled as such.
4. **Never expand the bridge into anything that acts on the game itself.** No
   auto-pick, no auto-ban, no cooldown or timer computation from Live Client Data.
5. **Compliance posture (tested):** ids and champion names only, zero summoner
   names anywhere; rune apply is user-clicked or the opt-out-default auto-export,
   never a polled game action; item sets are an inert shop-panel suggestion.

## Gates

```
dotnet test desktop/CoachBuild.Desktop.sln -c Release     383 Core + 532 Desktop
npm run typecheck && npm test                             20 files / 427 tests
npm run lint                                              eslint desktop/ui components lib
```

**The SDK is not the `dotnet` on PATH.** `C:\Program Files\dotnet` is runtimes only
and answers `No .NET SDKs were found` — that message names the paths *that probe*
searched, and there is a per-user SDK at
`%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe`. Use it.

**`npm run lint` is path-scoped on purpose.** The repo root carries untracked
`.rose-*` / `.marco-*` / `.cb-*` scratch that a bare `eslint .` fails on. Those are
not yours to delete.

**Smart App Control blocks unsigned binaries produced here.** The symptom is a
mass Desktop-test failure with `Core.Tests` skipped entirely — read one error
before believing it is your change. Never run a built `.exe` to verify something;
assert against the build output or a unit test instead.

**A green suite does not prove the tree is committable.** The C# SDK globs
`**/*.cs` off disk, not off the index, and `tsc`/`vitest` run against the working
tree, not the index — a file referenced but never `git add`ed passes every gate and
fails the build for everyone else. Check a path-scoped commit's file list against
`git status`, never against memory.

## Test conventions

Vitest, **pure functions only** — there is no JSX rendering harness (no
jsdom/RTL). Component test files import and test exported pure helpers from a
component module and never render. Any module touching an external feed takes an
injectable `deps`/`transport`/`fetchImpl` parameter so classification and retry
logic is unit-testable without a network call; follow that for new integrations.

Run `tsc --noEmit` as well as the suite before calling anything green — vitest
transpiles and does not typecheck.

## Release

`desktop/scripts/package.ps1 -Version X.Y.Z` → `dotnet publish` → asserts the tray
icon **and the packaged draft UI** are present → `vpk pack`.
`desktop/scripts/publish.ps1` uploads to `haroutB5/coachbuild-desktop-releases`;
the Velopack updater reads that feed.

Environment failures that recur and are not your bug: `gh`'s stored token is
invalid (the valid PAT comes from the git credential helper), and Smart App
Control blocks `vpk.exe` itself (run the managed `vpk.dll` under the
Microsoft-signed `dotnet.exe`). Verify a release by the published manifest —
`draft:false`, five assets uploaded, manifest SHA256 == served SHA256 — not by an
exit code.

## Environment

**None required.** The app needs no API key, no database URL and no secret. It
reads the League client on loopback and two public CDNs. This is a deliberate
end state, not a gap: every credential v1 needed
(`DATABASE_URL`, `RIOT_API_KEY`, `CRON_SECRET`, `MYSTATS_ACCOUNT_SECRET`) belonged
to a surface that no longer exists.

## Decommission checklist (infrastructure now unused)

Nothing in the repo depends on any of these as of 2.0.0. They are listed so the
teardown is done from evidence rather than memory; see `HANDOFF.md` for status.

- **Vercel project `coachbuild`** (personal account) — the deployment, its
  domain, its four crons and its environment variables.
- **Neon project `ep-sparkling-block-zayzlal1`** — the whole `coachbuild` schema.
  It is a *shared instance*: never touch `public` or any other schema.
- **Windows Scheduled Tasks on this machine:** `CoachBuildOtpPriority`,
  `CoachBuildOtpIngest`, `CoachBuildMatchIngest`, `CoachBuildProstageIngest`,
  `CoachBuildConsensusRebake`. Their registration scripts are deleted from the
  repo; the machine state must be removed separately.
- **The PowerShell companion** `public/companion.ps1`, installed via
  `irm https://coachbuild.vercel.app/companion.ps1 | iex`. Its only distribution
  channel was the Vercel site, so it becomes uninstallable-and-unupdatable the
  moment that project is deleted. It is superseded by the desktop app.
