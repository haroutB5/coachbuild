# CoachBuild — technical reference

**Describes desktop 2.4.0, 2026-09-11.** `desktop/src/Directory.Build.props`'s
`<Version>` is the single source of truth for the app version (it moved there in
2.1.0; it is no longer in the csproj). If it has moved on since this date, treat
everything below with more skepticism the further it has fallen behind, and check
`CHANGELOG.md` for what shipped after.

**v2.0.0 is a product change, not a refactor: the hosted web app is gone.**
CoachBuild is now one Windows desktop application. There is no website, no
serverless function, no database, no cron and no scheduled task. The repository
still contains a `components/` and `lib/` tree, but those are now a **component
library for the desktop app's embedded UI** rather than a deployed Next.js site.

**As of 2026-09-09 that is also true of the infrastructure, not just the code.**
The Vercel project, the Neon database and every scheduled task have been deleted
from the accounts and from this machine. See *Decommission* at the bottom. There
is nothing left to deploy to, nothing left to pay for, and no credential the app
needs.

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
└── WebView2 window ("Research window"), four tabs
    ├── Draft      ← LOCAL static page shipped inside the app  (was "Companion")
    ├── u.gg       ← real site, auto item-set + rune-page import; also the
    │                source for draft counters and skill order
    ├── Coachless  ← real site, auto item-set + rune-page import
    └── MyStats    ← op.gg, own profile via LCU riot-id (tab renamed in 2.0.1;
                     the code enum is still CompanionTab.OpGg)
```

Everything the app knows comes from one of exactly four places, and it is worth
memorising the list because "where did this number come from" was answerable in
v1 only by reading a pipeline:

1. **The League client** (LCU + Live Client Data), through the bridge.
2. **ddragon** (`ddragon.leagueoflegends.com`), a keyless public CDN.
3. **The three site tabs**, which are the real websites, read by extractor scripts
   and by hidden single-purpose readers (counters, skill order, import workers).
4. **The user's own `lane-scores.json`**, written by the user, read by nobody else.

There is no fifth. **lolalytics used to be a fifth** — it supplied draft counters
until 2.2.4 moved counters to u.gg. `lib/lolalytics/` is still in the tree and
still unit-tested, but nothing in the shipping UI imports it (verified by grep,
2026-09-10). If you find yourself adding a source, that is a product decision.

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
- **Counter picks** via `CounterPicksStrip`, fed by `desktop/ui/localCounters.ts`
  — **u.gg since 2.2.4, not the bridge and not lolalytics.** `localCounters.ts`
  posts `{type:"ugg-counters", id, slug, lane, enemy}` to `window.chrome.webview`
  and waits for a matching `ugg-counters-result`; the host side is
  `Web/WebView2Counters.cs` + `Web/UggCounters.cs`, which drive a hidden WebView
  and read u.gg's own SSR bucket (`#reactn-preloaded-state` →
  `world_emerald_plus_{lane}`), never arbitrary script execution. 35 s timeout,
  cancellable, 1 h in-process cache bounded at 30 entries. `rankUggCounters`
  (`lib/ugg/counters.ts`) does the ranking; the patch is read off the page title
  and the response is rejected outright if patch or source URL is missing.
- **Lane history / lane scores** via `LaneHistoryPanel` and `LaneScoreCard`
  (2.3.0, below), both talking to the bridge through `desktop/ui/localBridge.ts`.
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

**`/draft/counters-html` is now dead weight, and this doc will not pretend
otherwise.** 2.2.4 moved draft counters to u.gg over the WebView2 host channel
(see the Draft page section). The route still exists in `CompanionHttpServer` and
is still covered by `LocalDraftBridgeTests`, but no shipping UI code path calls
it (grep, 2026-09-10). Treat it as a retained seam, not as live behaviour; delete
it deliberately or keep it deliberately, but do not read it as documentation of
where counters come from.

## Lane scores (2.3.0–2.3.2) — the user's own matchup history, local only

After a **ranked** game ends the companion offers a card: "How did your lane go?",
1-10 against the enemy laner. Those scores aggregate into a champ-select panel,
"Your lane history vs {Enemy}", which sits next to the counters strip and ranks
the user's *own* champions into that enemy.

**The data is local and stays local.** One file,
`%LOCALAPPDATA%\CoachBuild\lane-scores.json`, written atomically (temp file +
`File.Move` overwrite). Nothing is uploaded, and there is no database behind this
feature — Neon was deleted on 2026-09-09 and this was designed for a machine with
no database, not migrated off one. The store is deduped by match id, carries a
`schemaVersion` and a `skipped` set, and preserves unknown keys
(`LaneScoreDocument.Extra`) so a document written by a newer build survives a
write by an older one. The file is a single JSON document rather than JSONL because atomic
writes rewrite the whole file anyway, so JSONL's cheap-append advantage is not
available, while a single document gives `schemaVersion` one unambiguous home.

Code: `CoachBuild.Core/LaneScore{Model,Store,Capture,Aggregator,Service}.cs`.
UI: `components/hextech/draft/LaneScoreCard.tsx` and `LaneHistoryPanel.tsx`.

```
GET  /lane-scores/pending?session=          {"pending": <game>|null}
POST /lane-scores?session=                  {matchId, score 1-10, opponentChampionId?, roleId?, note?}
                                            or {matchId, skip:true} -> {ok, reason?}
GET  /lane-scores/recommendations?enemy=&role=&session=
                                            {enemyChampionId, roleId, totalGames, best[], worst[]}
```

None of the three calls the LCU — they read and write a local file — so the card
still works with the League client shut, which is exactly when a user sits down
to score the game they just played.

Capture joins match-history `participantIdentities[].player.puuid` to
`participants[]` by `participantId`. If a ranked list entry cannot supply the
players, capture requests `/lol-match-history/v1/games/{id}` and verifies its id
before storing it. An already-known game does not end the settle retries.
An unknown player role must be chosen on the card (`roleId`, 0–4) before saving;
skip remains available. Successful submissions refresh the displayed history.
“Last played” uses the game date, rather than the date the score was entered.

The built-page regression check is `node scripts/test-lane-score-ui.mjs` after
`npm run build`. It uses Chromium with a simulated bridge and CDN and never
reads or writes the real lane history. It checks role/opponent selection,
failed-save recovery, polling during a delayed save, history refresh and skip.

Rules that are product decisions, not implementation details:

- **Ranked only**, and the allowed set is one constant (`RankedQueues`: 420 solo,
  440 flex). The accepted consequence is that the card cannot be reached in the
  practice tool, which is why `--lane-score-demo` exists — it fabricates a card
  and writes nothing. Two independent locks keep it out of real data: a demo
  service never touches the store at all, and the store rejects any match id
  carrying `LaneScoreService.DemoMatchIdPrefix`.
- **Never guess the opponent.** If position data is absent or ambiguous the game
  is recorded with `opponentChampionId: null` and the card asks the user to pick
  from the five enemy champions. A wrong opponent silently poisons the
  recommendation forever; an unknown one costs one tap. This is the same
  reasoning that removed index-based lane inference from champ select (audit
  P2-1) — `theirTeam` is compacted, so index is not role.
- **Bot lane is broken apart by role, not by position (2.3.1).** The ADC and the
  support both report lane `BOTTOM`, so position alone made *every* bot-lane game
  `ambiguous:2-enemies-at-bottom` and asked the user. `role`
  (`DUO_CARRY` / `DUO_SUPPORT`) is now a **secondary** discriminator: consulted
  only when position is ambiguous, and only when it narrows to exactly one enemy.
  Top, mid and jungle never consult it. A role that is missing, blank, `NONE` or
  unrecognised is unusable and falls back to asking — never to a coin flip. When
  role breaks the tie, `PositionSource` names both fields
  (`timeline.lane+timeline.role`).
- **A support's own game is role 4, not role 3 (2.3.2).**
  `ComplianceRules.RoleIdFromPosition` maps `BOTTOM` to 3 for both bot laners,
  but champ select reads `assignedPosition` and therefore queries the panel with
  role 4 (utility) for a support. `LaneScoreCapture.ResolveRoleId` overrides
  bottom→4 when — and only when — role says support; absence is not evidence, so
  anything unusable keeps 3. Opponent matching is untouched: a support game is
  filed as role 4 *and* still resolves the enemy support as the opponent.
  **Scores written by earlier builds keep the role id they were saved with;
  nothing on disk is rewritten**, so a pre-2.3.2 support history stays under 3
  and will not appear in the panel.
- **Never infer the inverse matchup.** Volibear 9/10 into Gwen is a fact about
  picking Volibear when Gwen is locked. It says nothing about Gwen into
  Volibear, and no code path reads a record backwards.
- **Sample honesty.** Every mean travels with its `games` count on the wire, and
  n=1 is marked as a single game in the UI. No confidence score, no shrinkage
  toward the middle, no bar length — n and the mean are the only facts there are.
  The panel is also labelled unmistakably as *your games*, because the counters
  strip beside it is thousands of games and the two must not read as one dataset.
- **Trigger.** Capture hangs off the existing `RankCaptureTrigger.GameEnd`, i.e.
  `RankCaptureService.LeftGame`, which counts `Reconnect` as still in-game. This
  matters more than it looks: companion.log shows every game on the dev machine
  finishing `InProgress -> Reconnect -> None` and never touching `PreEndOfGame`
  or `EndOfGame`, so a trigger written against those two phase names would never
  have fired.
- **The prompt never yanks.** It raises `PageRequested`, which the host routes
  through `OpenTargetAsync(userInitiated: false)` / `OpenCompanionAsync` —
  refreshing the hosted page underneath whatever tab the user is reading. If they
  ignore it, the game is already on disk and the card is waiting next time.

**Partly measured, and honest about the rest.** `LaneScoreCapture` was written
with no League client running on the dev machine (companion.log records
`lcu_discovery_failed` across all four discovery layers), so the exact field the
platform uses for a participant's position was not confirmed at design time.
Rather than pick a spelling and hope, the parser probes a candidate list
(`PositionKeys`, then `RoleKeys`), reports which field won in
`LaneScoreGame.PositionSource`, and logs a **names-and-kinds-only** key inventory
(`LaneScoreCapture.Describe` — no values, so no puuids or summoner names reach a
log users are asked to send us).

A real captured participant has since confirmed the shape as
`participant.timeline.lane` + `participant.timeline.role` (the capture in the
`RoleKeys` doc comment: `{"championId":202,"teamId":100,"lane":"NONE","role":"SOLO"}`),
which is why `timeline` is probed and why role leads its own list. **What is
still unmeasured is a real ranked game end-to-end**: whether lane/role carry
usable values there, and whether the opponent resolves to the right champion.
That is the one open item in `HANDOFF.md`, and the evidence is one
`position-source=` line in companion.log. Anything unresolved falls into the
opponent-unknown path above, so a wrong spelling costs a tap, never a wrong fact.

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

## What the site tabs do

`desktop/src/CoachBuild.Desktop/Web/` — `CompanionTabs.cs` is the whole pure layer
(tab model, deep links, nav policy, preferences).

- Each tab is created **lazily on first visit**, into its **own** WebView2 profile
  directory (`WebView2/` for Draft — the legacy root, so an upgrade signs nobody
  out — plus `WebView2/ugg`, `/coachless`, `/opgg`). Cloudflare clearance and
  cookies persist per site without sharing storage with the app session.
  **2.1.0: the hidden import workers use those same folders.** They used to fall
  back to a private `auto-{site}` profile whenever the site tab had not been
  opened, which meant consent accepted in the visible tab did nothing for the
  worker — the standing cause of `Coachless extraction failed (no build on page)`.
- `SiteNavigationPolicy` allows **https only, any host**, and refuses non-http
  schemes so a page cannot hand Windows a `steam:`/`ms-settings:` URI through
  `NewWindowRequested`. There is no address bar, so every navigation still starts
  from a link on a site the user chose.
- **Read-mostly is structural, not a promise.** `SiteTabComplianceTests` fails the
  build if an `ExecuteScriptAsync` call appears outside the sanctioned extractor
  families or if automated navigation reaches a call site that does not assert an
  allowlist first. In 2.2.0 item extractors are reached only through
  `ExtractVisibleOnUiAsync` / `FetchViaWorkerOnUiAsync`; Coachless runes through
  `FetchCoachlessRunesOnUiAsync`; and consent through `DismissConsentAsync`.
  Automated navigation
  has **two** entries, `NavigateWorkerAndWaitAsync` (build pages) and
  `NavigateRunesWorkerAndWaitAsync` (the runes page), each asserting its own
  allowlist before they share `NavigateAndWaitCoreAsync`. Widening either set is a
  deliberate edit to a named list, never a silent drift.
- **Consent walls** (2.1.0): at the start of an import the worker dismisses a
  *recognized* TCF dialog once — `#qc-cmp2-container #accept-btn` (Coachless,
  Quantcast Choice) or `.fc-consent-root button.fc-cta-consent` (u.gg, Google
  Funding Choices), both read off the captured fixtures — and logs
  `{site}: dismissed consent dialog`. Accept controls only; no text matching; an
  unrecognized wall stays up and the import fails honestly.
- **Auto item-set import** (`SiteAutoImport.cs`): on champ-select lock, once per
  champion+role, and on a visible build-page URL change, both sites' item sets are
  fetched in the background and flushed per site in merged batches, so the per-site
  `CoachBuild import: {Champ} {Role} (u.gg)` / `(Coachless)` titles coexist. Two
  sequential single-set writes would not — the merge drops every `CoachBuild*` set
  it reads, which is exactly why the batch exists.
- **Coachless items (2.2.0).** The builds-page extractor performs one read of
  the initial top-WPA row for Starter, 1st, 2nd, 3rd, 4th+ and Boots. There is
  no item click/recompute walk or settle loop; an empty slot is noted and
  omitted. On roleless locks the active role discovered from u.gg forms the
  Coachless target, and Coachless's own roleless extractor reads its rendered
  active role control rather than inventing a first/default button.
- **Runes (2.2.0).** There is no offer bar or Import runes button. Every lock or
  build-page trigger automatically writes both source pages as `u.gg {Champ}`
  and `Coachless {Champ}`, adding `(Role)` only for a champ-select-assigned role.
  The Coachless build comes from its
  separate `/runes/tree/{slug}/{primary}/{secondary}?role=` page
  (`CoachlessRunesTemplate`). The tree pair in the URL is a probe — the site
  redirects to the pair it recommends, so the extractor reads both tree ids off
  the rendered perk icons. Pick rule: top WPA per slot row, best **two rows** for
  the secondary tree; `is-empty` cards (`-.--`) are skipped, never read as zero.
  Any missing part is a typed failure naming it, and nothing partial is written.
  Existing pages with either source prefix or legacy `CoachBuild import:` are
  reusable/owned; foreign pages are never touched. u.gg has priority if only one
  slot exists. Neither page is selected unless an owned page was current before
  the   write, in which case u.gg becomes current.
- **Pro source (2.4.0).** A third automatic source alongside u.gg and
  Coachless: `https://probuildstats.com/champion/{slug}?role={token}` (u.gg's
  sister pro-builds site), fetched in C# over plain `HttpClient`
  (`ProBuildsClient`) — never through a worker, so it runs fully in parallel
  and contends for no browser core. The SSR page's `#apollo-state` blob holds
  one numeric row per pro game; the pick rule takes the rows for the requested
  role (all rows when role-less), keeps the current patch's rows when there
  are at least 3, takes the modal (keystone, sub-style) pair, and writes the
  most recent game with it — falling back row by row through
  `PerkTreeCatalog` validation, never mixing rows. Items come from the same
  row: early `itemPath` buys (timestamps are milliseconds) as Starting Items,
  `completedItems` as Core Items, filtered `finalBuild` as Final Build. Role 4
  maps to `supp` on this builder only. Pages are `Pro {Champ}` (a third owned
  prefix, budget now three, priority u.gg then Coachless then Pro); the item
  set rides the same merged write as `(Pro)`. Role-less lobbies fetch with no
  role and re-pick from the fetched rows for the role u.gg discovers — no
  second request. Pro failing is always one fail-soft
  `runes: Pro yielded no build (...)` line and never delays the other two.
  No Pro browser tab exists; import only.
- **Roles may be absent.** Practice tool and custom lobbies assign no position.
  `SiteImportValidator.RoleLabel` returns **null**, and `PageTitle` /
  `ChampionLabel` omit it — never the literal word "Unknown" (2.0.1 shipped
  `CoachBuild import: Nasus Unknown (u.gg)`).
- **MyStats** (the op.gg tab; renamed from "op.gg" in 2.0.1, with a small italic
  `op.gg` sub-label) resolves `gameName`/`tagLine` and the platform id from the LCU and
  opens the user's own profile; anything missing opens `op.gg` without guessing.
  2.1.0 retries the resolve on the **rising edge of the LCU connection** (the tab
  can be opened before the client is up, which is why a whole field-test session
  produced zero `opgg:` lines), navigating only if the tab is still on op.gg home,
  and logs both branches.
- **Ad requests (2.2.0).** u.gg, Coachless, op.gg and hidden import workers use
  one `CoreWebView2` request filter to reject a maintained adtech-domain list.
  Draft never receives the filter. First-party/CDN and Quantcast/Google Funding
  Choices consent traffic is explicitly allowed; each blocked domain is logged
  once per window session, not once per request.
- **Memory** (2.1.0). Import workers are disposed after every run. A site tab
  invisible for `SiteTabIdlePolicy.IdleTimeout` (10 min, one constant) has its
  WebView2 disposed; the tab button stays and revisiting recreates it lazily, with
  cookies and sign-ins intact in the profile dir. The visible tab and Draft are
  never torn down. `SiteTabIdlePolicy.Decide` is pure and unit-tested.

### Verifying the extractors without a browser

`node _research/site-import/verify-extractors.mjs` runs the **shipped
const-string scripts verbatim** against the **real captured fixtures**
(`ugg-jhin-adc.html`, `coachless-jhin-adc.html`, `coachless-nasus-runes.html`)
through a minimal DOM in that file. It is not part of the build — no DOM on this
box — but it is the only thing that proves the JS reads what the pages contain,
including the exact rune page the runes extractor must produce. Run it after any
extractor edit; the C# suite can only pin anchors and payload shapes.

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
| `SkillOrderProvider.DefaultEndpoint` | No `/api/skill-order`. The endpoint is now nullable and a null endpoint answers `NoData` without a request. **2.2.7 filled the seam**: the provider takes an injectable `fetch` and the data comes from u.gg. |

**Two retirements were done as *inert seams*, not deletions, and that is
deliberate.** `RetiredHostedSink` still implements `IRankSampleSink` and
`IDiagnosticsSink` and answers `Rejected`; `SkillOrderProvider` still takes an
optional endpoint. Both keep their services constructible and their contract tests
meaningful, so if a local replacement ever arrives there is a seam to fill rather
than a rewrite. Neither makes a network call in production.

**The overlay was reduced honestly in 2.0.0, then given a new source in 2.2.7.**
It used to render skill-order data from `/api/skill-order`; 2.0.0 deleted the
endpoint, `SkillOrderProvider` answered `NoData`, and the overlay drew live
ability state from the Live Client Data API only. 2.2.7 restored a recommended
order from **u.gg's published Skill Path** for the selected champion and lane
(World Emerald+ recommended build) — see the next section. The
situational-WPA item-number overlay was already removed in desktop 1.0.23 for
unrelated reasons and did not come back.

## Skill order (restored 2.2.7): u.gg supplies data, the old provider keeps the rules

`Web/UggSkillOrderReader.cs` reads `rec_skill_path` out of u.gg's page for the
champion+role deep link and returns a `SkillOrderResult`. `SkillOrderProvider`
is unchanged in every respect that matters — it now takes an injectable
`Func<int,int,CancellationToken,Task<SkillOrderResult>> fetch` instead of an HTTP
endpoint, and still owns the cache (successful orders never expire within a game,
no-data retries after 60 s, errors after 15 s) and the per-game clear. Role
unset or RoleId 5 still resolves to no-data without a request.

Three properties worth not breaking:

- **A partial path is shown as published, never filled in.** No interpolation, no
  "probably max Q" completion. `OverlaySkillOrder.Completed` / `CompletionBasis`
  carry that distinction to the renderer.
- **The reader owns its own throwaway host.** A 1×1, transparent, non-activating
  `Window` containing a `WebView2`, created per fetch and disposed after, sharing
  the same profile root. It therefore survives the Research window closing at
  game start (which is exactly when the overlay needs it) and can neither
  navigate nor evict the user's item/rune import browsers. One `SemaphoreSlim`
  serialises fetches; 30 s timeout.
- **Every fetch logs one line**: `skill-order: u.gg {Champ} {role} {Status}; N
  levels, M games`.

## HARD RULES (do not violate without a new explicit user directive)

1. **Never delete or overwrite an LCU rune page or item set the app does not own.**
   Rune ownership is `u.gg `, `Coachless ` or legacy `CoachBuild`; item-set
   ownership remains `CoachBuild`. One legacy carve-out remains: a **manual** rune apply does
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
dotnet test desktop/CoachBuild.Desktop.sln -c Release     see the warning below
dotnet test desktop/tests/CoachBuild.Core.Tests/CoachBuild.Core.Tests.csproj -c Release
npm run typecheck && npm test                             21 files / 434 tests
npm run lint                                              eslint desktop/ui components lib
```

Counts measured on this machine at 28b68eb / 2.3.2 (2026-09-10): **Core 577,
Desktop 655, vitest 434 across 21 files**, all green, `tsc --noEmit` clean.

**The solution-level `dotnet test` ran only ONE test assembly.** On 2026-09-10 it
reported `A total of 1 test files matched` and `CoachBuild.Desktop.Tests.dll` →
655 passed, and never touched `CoachBuild.Core.Tests.dll` at all — despite
Core.Tests being one of the four projects in the `.sln`. Running the Core test
csproj directly passes 577. **Do not read a green solution run as "both suites
passed"**; run the Core project explicitly, or check that both assemblies appear
in the output. The known cause of a suite vanishing this way is a compile error
in that project silently dropping it from the run — but Core.Tests compiles and
passes when invoked directly at this commit, so that is not the explanation here
and the real one is undiagnosed. Either way the rule stands: **confirm both
`Passed!` lines**, never just the exit code.

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

`npm run test:ui` runs the exported Draft page in headless Chromium with isolated
fixtures for the bridge, DDragon and native counter replies. Run `npm run build`
first. `BROWSER_PATH` selects a Chromium executable; `DRAFT_UI_ROOT` can point at
the `UI` directory of a published package to verify the actual release assets.
The browser check never connects to League or writes the user's lane history.

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

`publish.ps1` also carries a **Smart App Control smoke-gate**: it launches the
packaged binary with `--self-test` and, on a per-hash SAC block, rebuilds to get a
fresh hash rather than shipping a build that dies on launch. It exists because
2.1.x shipped an `app.manifest` with invalid XML (a `--` inside a comment) that
bricked startup with an SxS error on every machine, and no unit test noticed.
Manifest XML validity is now test-pinned as well.

This is the only release channel there is. There is no web deploy step any more —
if you find yourself reaching for `vercel`, you are working from a stale doc.

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

## Decommission — DONE, 2026-09-09

The teardown listed here as a checklist through 2.3.x has been executed. The app
is fully local: **no database, no hosting, no scheduled task, no cloud bill.**

| Thing | State |
|---|---|
| Vercel project `coachbuild` | **Deleted.** `coachbuild.vercel.app` 404s. Its deployment, domain, crons and environment variables went with it. |
| Vercel project `.cb-deploy-web0123` | **Deleted.** A junk project from an old deploy experiment. |
| Neon marketplace store `coachbuild-db` | **Deleted**, and with it the whole Neon project. The org is empty. |
| 8 Windows Scheduled Tasks | **Disabled** on this machine: `CoachBuildConsensusRebake`, `CoachBuildMatchIngest`, `CoachBuildOtpIngest`, `CoachBuildOtpPriority`, `CoachBuildOtpWalkOneShot`, `CoachBuildProstageIngest`, `CoachBuildRebuildPhase1`, `CoachBuildDraftIngest`. (Disabled, not deleted — nothing runs.) |
| `public/companion.ps1` | Gone with the site that distributed it (`irm https://coachbuild.vercel.app/companion.ps1 | iex`). Superseded by the desktop app. |

**The database was backed up before deletion, in full.**
`data-backups/neon-final-20260909/` holds **22 `.jsonl` table dumps, 297,433 rows,
130 MB**, plus `_schema-columns.json` and the `dump.mjs` that produced them
(counts verified on disk 2026-09-10). This is the only surviving copy of the v1
ingest data — the OTP/pro/prostage match corpus, draft matchups, rank samples and
the consensus inputs. It is a cold archive: nothing reads it, and no code path
knows it exists.

**Consequences to keep in mind when reading old material:** anything in
`docs/archive/`, in `CHANGELOG.md` entries below 2.0.0, or in the historical half
of `HANDOFF.md` that mentions a deploy, a `DATABASE_URL`, an `/api/**` route, a
cron or an ingest run is describing infrastructure that no longer exists. It is
kept for reasoning, not for operations.
