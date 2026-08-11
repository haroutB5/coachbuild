# Gotchas

Verified facts that cost real debugging time. Cite these before touching the relevant area.

## Champ-select window model (companion v1.13.0 / app v0.103.0, 2026-08-08)

- **ONE window per champ select, draft-first.** The v1.6.0 two-page model
  (Builds + /draft) is retired — user directive after app-window mode made
  pairs heavy. The companion opens ONLY the draft deep link, and only when NO
  follow-capable page is attached (either attach kind counts). Champion
  changes open nothing while anything is attached; the pages live-follow.
  Builds is reached via /draft's locked-pick banner (renders on
  cellChampionId>0, canonical deep-link params from
  components/live/deepLink.ts — never invent a second param convention).
  Tray Reopen is phase-aware: draft link in champ select, builds link after.
- App windows via `--app=<url>` (companion v1.12.0): chromium-family default
  browsers only; ProgId-resolved exe; -NoAppWindow or non-chromium falls
  back to tabs.

## Draft page invariant (v0.102.0, 2026-08-08 — user-reported mismatch)

- **TOP RECOMMENDATIONS cards, WORST MATCHUPS PREVIEW, and the DETAILED RANKINGS
  sidebar are ONE ranked list** — `resolveVisibleDraftAssistantRanking` over the
  active tab's rows with the active sort/filters; cards are its first three.
  Never reintroduce independent card selection (the old BEST OVERALL / SAFEST
  BLIND / RELIABLE PICK logic disagreed with the visible list, which read as a
  bug). Corollary the audit caught: `handleViewDetails` must select within the
  CURRENT tab — forcing `setAssistantView("recommended")` dead-ended blind-only
  champions. Card buttons are bottom-pinned with `mt-auto` (min-h floors on
  wrapping text blocks do NOT equalize card internals).

## Auto-export ownership + SW updates (v0.101.0 / companion v1.11.0, 2026-08-07)

- **Champ-select auto-export dedup is PER BROWSER DOCUMENT and always will be.**
  `champSelectFollowState.ts` is a module singleton and its phase epoch is a
  counter that document increments — a tab opened mid-champ-select starts fresh
  and re-exports. The companion opens replacement tabs whenever its 150s attach
  window lapses, so this happens routinely. Never place a correctness guarantee
  about "export only once" in the web layer.
- **The rune-overwrite guard therefore lives in `public/companion.ps1`,
  `Invoke-ApplyRunes` STEP 2**, keyed off what the companion itself last wrote
  (a per-champ-select ledger in the bridge's Sync hashtable, cleared on
  ChampSelect ENTRY). In AUTO mode: page contents == what we'd write → write
  nothing AND do not re-select (re-selecting drags a user off the page they
  chose); contents != our last write → `user-modified`, touch nothing. MANUAL
  mode bypasses all of it — a click is consent. Four SelfTest cases pin it,
  including the manual-still-overwrites block direction.
  Fixture gotcha: any SelfTest rune case that hands a CoachBuild-titled page
  contents this run never wrote must reset `$bridge.Sync.RuneWrites` first, or
  the guard correctly reads it as a user edit.
- **A rune apply now has THREE success shapes, not two:** `ok:true`,
  `ok:true + unchanged:true` (no write, no re-select — must not toast), and
  `ok:false + reason:"user-modified"` (not an error — toasts "Kept your rune
  changes"). `selected:false` no longer implies "tell the user to go pick the
  page in the client".
- **No SW update prompt exists any more.** sw.js calls `skipWaiting()` on
  install; `ServiceWorkerRegister.tsx` is registration only. The toast rendered
  off `reg.waiting`, and a waiting worker persists until applied, so ignoring it
  once meant it re-appeared on every later load — v0.51.1's dismiss-persistence
  fix could not reach that. Fetches are network-first, so nothing was ever
  stale. Do not reintroduce a forced reload here: a reload mid-champ-select
  re-fires the auto-export.
- **`companion.log` status=0 failures are EDGE-triggered** (one line entering
  the unreachable state, one recovering). They used to log every 60s forever
  while League was closed and had flushed 200KB of real history away. Real HTTP
  rejections keep `Write-ThrottledErrorLog`'s 60s throttle.
- **The companion does not hot-update, and the overlay path is stricter.** The
  standalone install re-downloads on launch (`irm .../companion.ps1 | iex`), so
  quit + relaunch gets the new version. The Electron overlay instead bundles
  companion.ps1 at BUILD time (`overlay-host` extraResources from
  `../public/companion.ps1`) and supervises that copy — **a companion fix does
  not reach overlay users until an overlay release is built and published**
  (`npm run dist:publish` in overlay-host, GH_TOKEN from ~/.git-credentials,
  publishes to haroutB5/coachbuild-overlay-releases). Verified live 2026-08-08:
  companion 1.11.0 shipped a day earlier, the overlay's /status still reported
  1.10.0 until overlay v0.4.4 was published. Every companion-side ship must
  ask: does this need an overlay release too?

## Build-surface invariants (v0.100.1, 2026-08-06 — all three user-reported on Jax)

- **Hidden-gem pools dedupe by item id, keeping the largest-occurrence entry** — the pool
  merges core + optimizedPath + situational, and the same id arrives from different
  conditioned fetches with different stats. The dedupe lives INSIDE `selectHiddenGemPicks`
  (components/hextech/itemSetBody.ts) so the build-page card and the exported shop block
  cannot disagree. Dedupe happens BEFORE the median baseline, on purpose.
- **OPTIMIZED ORDER only reorders the WPA build's own legendary ids** (`wpaBuildItemIds` in
  lib/recommend.ts → `buildOptimizedPath`'s `allowedItemIds`). The constraint is enforced via
  `conditionedLeader`'s EXCLUSION predicate, never by pre-filtering the pool: the
  adoption-relative floor (`OPTIMIZER_ADOPT_FRAC`) is a fraction of the conditioned slot's
  TOTAL games, and a pre-filter shrank that total up to 8.7x (measured: Lee Sin floor
  8,707→999), re-admitting the thin-adoption spikes the floor exists to reject. LATENT: the
  dead matchup path can replace first/second/third AFTER the set is built — see the warning
  comment at the `wpaBuildItemIds` site before waking that path up. Known product question:
  the constrained chain can surface a negative-WPA step (Lee Sin: Black Cleaver −0.17).
- **OTP builds backfill to 5 full items + boots when the 15% display floor is sparse**
  (`MIN_FULL_ITEMS_FOR_BUILD` in lib/otp/featuredBuild.ts), showing real low percentages.
  Two guards discovered the hard way: (1) support-quest finals are excluded from
  recommendation surfaces for non-support lanes (`excludeSupportFinalItems` — mis-roled
  stored games put Bloodsong in Jax TOP's exported item set; `fullBuild` stays untouched,
  it is a record); (2) the slots include-set is floor-clearing ids ∪ displayed ids — capping
  it at the displayed six re-priced contested pairs and silently dropped deep-sampled
  champions' sixth item (Viktor lost Rabadon's).
- **`npm run dev` is broken on this machine** (Turbopack can't spawn its PostCSS worker,
  `0xc0000142`; every page 500s). Use `npx next dev --webpack` for local browser checks.

## Riot timeline / skill orders (2026-08-04 session, all verified live)

- **`SKILL_LEVEL_UP` events are NOT all skill points.** `levelUpType: "EVOLVE"` fires for
  Viktor augments, Kha'Zix evolutions, Kai'Sa evolutions — counting them as ranks stores
  impossible orders (6 Q ranks). `buildSkillOrder` in `lib/pro/extract.ts` filters to NORMAL
  (missing field tolerated as NORMAL). Verified: match NA1_5614721385, Viktor participant,
  22 events = 18 NORMAL + 4 EVOLVE.
- **Aphelios' auto-R IS serialized** as NORMAL SKILL_LEVEL_UP events even though it costs no
  point (contradicts docs-inference; every stored game shows R markers at exactly the auto-rank
  positions). His R events are stripped as zero-cost markers (`rAuto` in `lib/championKit.ts`)
  so his 18 stat points land one per level. Jayce's auto-R emits NO events — same mechanic,
  different serialization. Do not assume consistency across champions.
- **Viego possession produces phantom skill-ups** under Viego's participantId (all NORMAL,
  distinct timestamps, survive dedupe; e.g. EUW1_7937343328 stored 4 R ranks). The timeline
  exposes no possessed-champion marker. `buildSkillOrder`'s kit-aware budget guard drops events
  exceeding the champion's own caps; under-cap phantoms are undetectable and accepted.
- **Dropped events shift kept positions.** The extract guard removes phantom events, so a kept
  R taken at champion level 11 can sit at position 10. This is fine: no surface renders otp
  per-game orders raw, and the aggregate re-slots R by evidence at 6/11/16. Do not "fix"
  position gaps by re-inserting anything.
- **Sequence position ≠ champion level** when a player banks a skill point (real games show R at
  position 5: Kled, Sona, Zeri) or for Yuumi (one extra starting point, ±1 skew). The grids
  render position-as-level as an approximation; the aggregate's R normalization to 6/11/16
  absorbs the R case.
- **Seven champions break the 5/5/5/3 model** (Udyr, Jayce, Aphelios, Yuumi, Elise, Nidalee,
  Karma — see `lib/championKit.ts` header for the measured ddragon sweep). Any code that
  hardcodes standard caps or `ULTIMATE_LEVELS` for recorded data is wrong for them. Kits thread
  through `aggregateRecordedSkillOrders` and all skill grids; keep it that way.
- **The same `skill_order` shape lives in TWO tables**: `coachbuild.otp_matches` AND
  `coachbuild.pro_matches` (53k rows), both written by `extractMatch`. Any extractor fix needs a
  backfill of BOTH — missing pro_matches shipped a live impossible grid once.
  (`prostage_matches` has no skill_order column.)

## Operational

- **Scheduled ingest jobs hold pre-fix code in memory.** `ingest-otp-priority.mjs` (--max-hours
  12) and `ingest-matches.mjs` run long; after fixing extractor code, kill or cycle them, then
  mop-up backfill — they re-contaminated data for 2+ hours after a fix landed and starved the
  shared Riot API key (backfill at 55s/row vs 1.3s paced).
- **`scripts/backfill-skill-orders.mjs`** re-fetches timelines and rewrites skill_order:
  `--table otp_matches|pro_matches`, `--dry-run`, `--limit/--offset` chunking. Full runs take
  ~1-2s/row × thousands of rows — run DETACHED (nohup), never inline in an agent shell (a 70-min
  inline dry-run died on the tool timeout with all work lost). 404'd timelines → skill_order
  NULL (absent beats wrong). Candidate selection is kit-aware; Udyr/Jayce/Aphelios/Yuumi rows
  that conform to their own kits are not candidates.
- **`lib/otp/ingest.ts` writes skill_order only `WHERE skill_order IS NULL`** — backfilled rows
  are safe from re-clobbering, but a bad non-NULL row never self-heals; it needs an explicit
  backfill.

## Aggregation

- **Never aggregate skill orders by per-level marginal vote.** An ability every game takes early
  (at varying levels) can lose every single-level vote and surface at level 9 (the original
  Zaahen bug). `aggregateRecordedSkillOrders` uses a prefix-conditional walk: electorate at slot
  b = games whose basics-prefix matches the chosen prefix; marginal fallback only when the
  electorate empties. While the electorate is non-empty, every emitted basics-prefix is one some
  real game played.

## Featured-OTP selection (v0.103.2, 2026-08-09 — user-reported wrong pick)

- **The selector was LP-ONLY and silently flipped picks** (Zaahen: Numbers#PLUH displaced
  ozneviik despite rank 2 + 917 games vs rank 4 + 579). Now `lib/otp` scores by log-scaled
  career champion games + champion share + ladder standing (leaderboard AND source rank),
  with BAYESIAN-SHRUNK winrate toward the candidate-pool mean (small samples can't win on
  winrate) and **10% incumbent hysteresis** (a challenger must clearly beat the current
  featured pick — refreshes must not churn the face of the tab). Fixture-pinned on the real
  Zaahen numbers. Scoped refresh: `npx tsx scripts/ingest-otp-featured.mjs --champion <id>`.
- **Companion liveness is freshness-gated** (same release): any live badge/tile/banner needs
  a successful /status poll within ~3 poll intervals; connection-refused, 403 (token rotates
  on companion restart) and timeouts all clear cached phase state. A dead companion must
  LOOK dead — the 2026-08-08 incident had "Live — syncing" showing through a real champ
  select with no bridge listening.

## CoachBuild Desktop (v1.0.0, 2026-08-09 — native replacement for companion.ps1 + overlay-host)

- **desktop/ is the companion now**: .NET 8 WPF tray app, in-process LCU client (lockfile-first,
  WMI fallback — NEVER ReadProcessMemory, anti-cheat signature), same loopback bridge + wire
  contract (web app unchanged, PWA untouched), WebView2 windows (one shared environment),
  layered click-through overlay (redraw-gated, created only in game), Velopack per-user updates
  (feed: haroutB5/coachbuild-desktop-releases; install root %LOCALAPPDATA%\CoachBuild\Desktop;
  no UAC, auto-relaunch). Build needs the local SDK: DOTNET_ROOT=%LOCALAPPDATA%\Temp\coachbuild-dotnet-sdk.
- **Review history that must not be relearned** (4 Opus rounds, 24 findings — see
  brain/memory in urgot for the full ledger): the follow-tracker MUST be the shared
  CompanionState instance (a test that injects its own tracker proves nothing — assert IDENTITY
  through the built host); skill-order lane resolution is THREE tiers (manual override reaches
  the FETCH, detected position, five-lane max-sampleSize fallback for NONE-position modes);
  /live validation is single-pass over assembled chunks (incremental Utf8JsonReader without
  BytesConsumed carry-forward false-rejects every multi-read TLS body — regression tests MUST
  drip-feed, ByteArrayContent is single-shot theater); VelopackApp.Build().Run() first in Main.
- **Cutover state**: companion.ps1 stays SERVED (phone-adjacent standalone users + rollback)
  but is deprecated; overlay-host retired once the user migrates. Real-game overlay behavior,
  clean-machine install, and update-apply remain unverified until first use on the gaming
  desktop — the honest-ledger items live in desktop/docs/.

## WebView2 repair (v1.0.3, 2026-08-09 — field-reported dead repair on the gaming desktop)

- **The Evergreen bootstrapper exits BEFORE the child install completes** (WebView2Feedback
  #1349): exit code 0 + immediate probe = false "repair did not complete". RepairAsync polls
  the version probe up to 120s after exit; success is "probe returns a version", NEVER the
  exit code alone (nonzero wrapper + completed child install is still success). Network exit
  codes (0x80072EE7/EFE/F8F) cap the poll short so no-network answers in seconds.
- **Per-user unelevated install is the supported path** — the current bootstrapper installs
  per-user when unelevated (per-machine when elevated). Do NOT add a runas/elevation path.
- **Edge installed ≠ WebView2 installed** (separate products; debloat scripts strip WebView2).
  Probe failures are classified: WebView2RuntimeNotFoundException = genuinely missing;
  anything else = app-side loader fault where installing the runtime will NOT help (fallback
  message says so and points at companion.log). Probe verdicts + repair results log
  edge-triggered to companion.log.
- **package.ps1 now FAILS if the bootstrapper download fails** (was a warning that silently
  shipped builds with a dead Repair button). -SkipWebView2Bootstrapper keeps the old opt-out.
- Velopack `vpk upload github` creates a DRAFT release — publish it via the API (PATCH
  draft:false, make_latest) or /releases/latest/download keeps serving the previous version.

## LCU lockfile reads (v1.0.4, 2026-08-09 — P0: the app NEVER attached to a running client)

- **The League client holds the lockfile open for writing. Any read MUST open with
  FileShare.ReadWrite | FileShare.Delete** (FileStream + StreamReader). File.ReadAllText
  (FileShare.Read) throws a sharing violation on every read while the client runs — swallowed,
  it reported "missing-or-unreadable" across all four discovery layers, so v1.0.0–1.0.3 could
  only attach when League was NOT running. Proven live both directions during the audit.
- Empty lockfile → one bounded 100ms retry (client writes it non-atomically at start).
- Discovery reasons distinguish `missing` (File.Exists false) from `unreadable:<ExceptionType>`
  (type NAME only — messages can embed newlines/paths; the structured line must stay one line).
- **SelfTest credential fixtures MUST isolate live ProgramData AND fixed-drive discovery**
  (programDataDirectory: temp path + fixedDriveLockfilePathsProvider: empty). Once lockfile
  reads succeed, an unisolated fixture resolves the REAL host client and SelfTest fails on
  exactly the machines it verifies. SelfTestRunner has end-to-end test coverage now — keep it.
- Field note: the retired PowerShell companion may still autostart on user machines and writes
  the same log file — interleaved formats in companion.log are two processes, not one.

## Autostart (v1.0.5)

- HKCU Run key `CoachBuild` → quoted VELOPACK STUB path (%LOCALAPPDATA%\CoachBuild\Desktop\CoachBuild.Desktop.exe) + `--autostart`. Never point at current\<version> paths — they die on update.
- Default-ON exactly once via `autostartConfigured` settings flag; a user toggle OFF is never re-enabled. Tray "Start with Windows" toggle reads the registry in the menu Opening handler.
- `--autostart` = tray-only launch (no WebView2 window); everything else runs normally.
- Tests use an injected registry subkey, never the real Run key.

## Web redesign / build-verification traps (v0.104.x, 2026-08-09)

- **`pkill -f "next start"` does NOT free port 3000 on this machine** — the process survives and
  serves a STALE build, so screenshots photograph old code and "verified" means nothing. Kill by
  port owner: `Get-NetTCPConnection -LocalPort 3000 -State Listen | Select -Expand OwningProcess
  -Unique | % { Stop-Process -Id $_ -Force }`. Then confirm a marker from the new build in the HTML
  before trusting any shot. Cost two false eyeballs during the redesign.
- **Parallel UI lanes must not share `.next`** — concurrent builds corrupt it, which is why lanes
  were barred from building/serving and every visual defect round-tripped through the orchestrator.
  Next multi-lane UI job: worktree per lane, own port, lane self-verifies in a browser.
- **Search-param consumers need a `<Suspense>` boundary or `npm run build` fails at prerender**
  (`missing-suspense-with-csr-bailout`, hit on /mystats). Lane-level typecheck+lint+test cannot see
  it — only a real build can.
- **Puppeteer needs a FRESH `userDataDir` per verification run** (PWA service worker serves the
  pre-change shell otherwise) — and a stored champion in a reused profile makes `/` render the build
  view instead of the landing, which reads as a missing landing page.
- **`vercel --prod --archive=tgz` dying on "fetch failed" mid-upload was NOT transient — the archive
  was 1.3GB** (CORRECTED 2026-08-10; the earlier "retry, it's flaky" reading was wrong, and a retry
  happening to succeed once is what hid it). There was no `.vercelignore`, so the CLI archived
  `overlay-host/` (~1.9GB, carries its own `node_modules`) and `desktop/` (~191MB) alongside the
  Next app. Neither is part of the web build. `.vercelignore` now excludes both plus `_research/`
  and the root API scratch dumps; the archive is back to seconds. If a deploy ever slows down
  again, check the upload SIZE in the CLI output first — that number is the diagnosis. Always parse
  `readyState` + smoke the SERVED version afterwards regardless — a failed deploy leaves the
  previous deployment aliased and returning 200.

## Runes + the Pro/OTP path strip (v0.105.x, 2026-08-10)

- **`RuneCircle` (`components/hextech/builds/BuildVisuals.tsx`) is THE picked/unpicked rune
  primitive for the whole app.** Every surface routes through it — BuildVisuals, ProConsensusCard,
  FeaturedOtpCard, RunesSummonersCard, GameDetailSheet, RunePage, ProGameCard. Unpicked = grayscale
  + dimmed, picked = full colour + purple ring/glow, keystone brightest. The pre-v0.105.0 version
  distinguished the states with a tint and an opacity step only, leaving the ICON ART full colour in
  both — user-reported as "i cant tell which runes are highlighted". Desaturation is what does the
  work; do not reintroduce a colour-only distinction, and do not draw a rune circle anywhere else.
- **Pro/OTP rune pages render the FULL static tree** (all options per row from `perkSlots.ts`'s
  `PERK_TREES`), not just the picked column. A picked-only column was the first attempt and was
  rejected — "like the runes in WPA build" means the whole grid.
- **Feed a rune page from `model.runePage`, never from `primaryMinors`/`secondaryPicks`.** Those are
  flat frequency rankings with no row structure and can put two runes in one slot; `runePage` is the
  slot-coherent one (see the long header in `components/hextech/proConsensus.ts`).
- **OTP DOES have per-slot rune counts** (added 2026-08-10; the earlier "page-level only, do not
  synthesise per-row counts" note here was true for about a day and is now wrong). The per-game page
  was always in `otp_matches.runes` — `lib/otp/featured.ts` was collapsing it to one group count and
  discarding the rest. `buildRunePageSamples` aggregates it: keystone and primary minors conditioned
  on the page's primary tree, secondary rows conditioned on BOTH trees, shards over the whole sample
  (they belong to no tree). Each slot therefore has its OWN denominator and they legitimately differ
  across one page. The exact-page figure survives separately and is labelled apart. `slotGridSample`
  refuses to draw a fraction whose `runeId` does not match the icon above it, so aggregation/adapter
  drift shows up as a MISSING number rather than a wrong one. Still never synthesise: a slot nothing
  filled renders the empty dash.
- **Most-built path positions must exclude items already placed.** `mostBuiltPath` resolved each
  position's modal independently, so an item that was modal at two positions rendered twice
  (user-reported: Blackfire Torch twice on Viktor and Malzahar). It now walks positions left to
  right carrying a `used` set. Raw counts and the `pathGames` denominator are unchanged, so a later
  position can legitimately show a HIGHER percentage than an earlier one — that is honest, not a bug.
  Lives in `components/hextech/mostBuiltPath.ts`: it was extracted out of the `.tsx` precisely so
  vitest can import it, since this repo cannot import JSX-bearing modules from a plain `.ts` test.
- **`DetailPopover`'s backdrop is a SIBLING of the dialog, never an ancestor.** An `aria-hidden`
  ancestor removes the whole dialog subtree from the accessibility tree — this codebase has already
  shipped that P1 once.

## Desktop overlay is the pink highlight and nothing else (desktop 1.0.6, 2026-08-10)

- The in-game overlay draws ONLY the pink next-ability highlight over the skill bar. The skill
  table, the header/lane/message lines, the disclaimer text, the `ShowSkillTable` setting and its
  tray toggle were all removed by user directive ("remove the whole overlay just keep the pink skill
  order"). Do not reintroduce an on-screen panel without being asked.
- `OverlayState.HasRenderableData` additionally requires a non-empty skill order, so a champion with
  no published path draws nothing at all rather than an empty box.
- Confirmed working in a real match by the user on 2026-08-10 — the first live confirmation of the
  native overlay since the desktop cutover.

## Tier badges and the absence of a tier (v0.106.0, 2026-08-11)

- **There is NO genuine per-champion-per-lane tier in this app, and `TierBadge` must never render
  without an explicit value.** The champion hero rendered `<TierBadge />` with no prop and fell
  through to a hardcoded `"S+"` default, so every champion in every lane claimed top tier — Yuumi at
  48.6% WR, Viktor on JUNGLE with no data at all, Aatrox on MID while the app's own landing list put
  him last. All three candidate sources were traced and none can answer the question:
  `BuildsLanding`'s tier list is POSITIONAL inside an arbitrary ≤8-champion mid-lane sample sorted by
  win rate; `/api/draft/recommend` and `/api/draft/blind-pick` are real per-lane ladders but capped
  at `meta.topN: 10` of ~173 and `blindScore` ranks blind-pick SAFETY, not strength; `/api/hero-stats`
  carries win rate and games only. The badge is therefore REMOVED from the hero. No badge is honest;
  a defaulted one was not. If a real ladder endpoint ever lands, render it in the hero and nowhere
  else.

## Mobile navigation is the bar PLUS the More sheet (v0.106.0, 2026-08-11)

- **`NAV_ITEMS.mobile` means "in the bottom bar", NOT "reachable on mobile".** `MOBILE_NAV_ITEMS` and
  `MOBILE_OVERFLOW_NAV_ITEMS` are exact complements and a test pins the partition, so an item cannot
  land in neither — which is how `/draft`, `/mystats?intent=game-detail` and `/live-setup` were
  unreachable at 390px for weeks, `/live-setup` being the companion PAIRING page (a phone user could
  not pair at all).
- Five cells at 390px is 78px each, so a label over ~52px wraps and spills its 56px cell.
  `NavItem.shortLabel` exists for that ("Pro Players"→"Players", "Patch Movers"→"Movers"). It must be
  a SUBSTRING of `label` (WCAG 3.2.4) and must never be paired with an `aria-label` carrying the full
  form (WCAG 2.5.3). The desktop rail still shows full labels.
- The sheet's backdrop is a SIBLING of the dialog — same rule as `DetailPopover`, same P1 behind it.

## The OTP feed is champion-scoped, and the UI must say so (v0.106.0, 2026-08-11)

- `app/api/otp/featured` reads only `championId`, and `featuredOtpRequestInputs` deliberately omits
  lane — one row per champion. **Do not make it lane-scoped.** The lane and rank pills therefore
  cannot move the OTP tab; `OtpLaneScopeNote` in `FeaturedOtpCard.tsx` is what stops that reading as
  a broken control. The payload carries no role or lane for the featured player, so the caption must
  not name one.
- Corollary: a lane-scoped empty state (`/api/build` 404, e.g. Viktor Support) must NOT blank the OTP
  tab. `FeaturedOtpCard`'s `build` prop is nullable precisely so it renders there, with only the WPA
  comparison and the two apply buttons withheld. Before this, all three tabs on a dataless lane
  flipped `aria-selected` and rendered no tabpanel at all — three live controls doing nothing, while
  the OTP tab's 230 games sat available the whole time.

## Rune labels and the shard icon table (v0.106.0, 2026-08-11)

- **A labelled rune row is a CSS grid, never a flex row of fixed-width boxes.** `align-items: center`
  on a fixed-width flex column sizes the label to its CONTENT, so the label's own `overflow`/clamp
  never fires and a name wider than the box paints over its neighbour. Measured before the fix:
  "Transcendence" 66.0px inside a 38px column, 7.7px neighbour overlap, in EVERY rune modal at both
  390px and 1260px. Rows now share the tree column across equal `1fr` tracks; `runeLabelColumns` puts
  a four-keystone row (Precision, Sorcery) in 2x2 because four tracks in the ~166px column leave
  ~38px. The modal shell is `max-w-sm`, so widening is not available without changing `DetailPopover`.
- **The Magic Resist stat-shard icon is `mr.png`, not `magicresist.png`** — the long name 403s on the
  CDN; `mr` matches the short-name convention the siblings already use. The shard table is DUPLICATED
  in `lib/staticData.ts` (server data layer) and `components/proAssets.ts` (client bundle) and neither
  can import the other, so both must move together; `proAssets.test.ts` now pins them to each other.
  A wrong filename here renders a bare fallback glyph, and the inline OTP rune card draws shards with
  NO labels, so the user just sees an unexplained letter.

## Building while a dev server is up (v0.106.0, 2026-08-11)

- `npm run build` cannot share `.next` with a running dev server and there is no `distDir` override in
  `next.config.mjs`. Kill the server by PORT OWNER first
  (`Get-NetTCPConnection -LocalPort 3000 -State Listen | Select -Expand OwningProcess -Unique |
  % { Stop-Process -Id $_ -Force }`) — `pkill -f "next start"` does not free it.
- An isolated `git worktree` is a workable substitute BUT only with `next build --webpack`: Turbopack
  rejects a junctioned/symlinked `node_modules` outright (`Symlink [project]/node_modules is invalid,
  it points out of the filesystem root`). A webpack build in a worktree does NOT prove the default
  Turbopack build passes — run the real one on the real tree before shipping.

## Rank tiers are coachless's enum, and the app has exactly ONE bracket (v0.107.0, 2026-08-11)

- **The confirmed enum**, read out of coachless's own production bundle
  (`https://coachless.gg/chunk-4QOXHN7Z.js`, which ships it as a literal) and cross-checked by
  watching their live filter UI's `GetKeystoneData` payloads:
  `Iron 0 · Bronze 1 · Silver 2 · Gold 3 · Platinum 4 · Emerald 5 · Diamond 6 · Master 7 ·
  Grandmaster 8 · Challenger 9`. Tiers 3–7 are confirmed BOTH ways; 8 and 9 from the bundle only
  (their free UI has no checkbox for those two).
- **Every label in the old `rankBrackets.ts` was off by one**, because it was inferred from
  ladder-population shape and never checked. `[5,6,7]`, shown everywhere as "High Elo", was really
  **Emerald + Diamond + Master** — it silently excluded Grandmaster AND Challenger. The DATA was
  always right; only the names lied. Never infer a label from a distribution curve again when the
  provider ships the enum.
- **Tier 9 is populated** (693 occurrences, Viktor mid, patch 16.14). The older "tier 9 is empty"
  note is dead and the app had simply never queried that far.
- One bracket now: `diamond-plus` = `[6,7,8,9]`. `DIAMOND_PLUS_TIERS` in `lib/coachless.ts` and
  `DIAMOND_PLUS_BRACKET.apiValue` in `lib/rankBrackets.ts` are two literals pinned to each other by a
  test — they must move together.
- **Division-level filtering does not exist.** coachless filters by tier with no division axis, so
  "Diamond II and above" is not expressible; the shipped bracket is the closest superset and the UI
  says so in a second line rather than implying exactness.
- Old bracket ids (`all`, `diamond`, `emerald`, …) are PURGED from localStorage on read rather than
  mapped, because stored `diamond` meant tier `[5]` — mapping it would reintroduce the off-by-one.

## Rank scope must be in the URL, always (v0.107.0, 2026-08-11)

- `/api/build` and `/api/hero-stats` send `Cache-Control: s-maxage=21600` keyed on the QUERY STRING.
  Every call site used to omit `&rank=` for the default bracket, so changing what a bracket MEANS
  would have served six hours of old-tier data under the new label from a shared cache. `rankQueryParam()`
  in `lib/rankBrackets.ts` now ALWAYS emits the param and every call site uses it. The
  omit-when-default rule is retired and must not come back. Same reasoning killed `recommend.ts`'s
  "send `{}` for the default bracket" shortcut.

## Hero actions and the build the hero cannot see (v0.107.0, 2026-08-11)

- `ChampionHero` and `BuildTabContent` are SIBLINGS under `app/page.tsx`, so the hero cannot see the
  fetch state. Two features have now had to work around this. The hero reads the build from
  `builds/currentBuildStore.ts`, which `BuildTabContent` publishes from an effect. **`BuildTabContent`
  stays the only `/api/build` call site** — giving the hero its own fetch reopens the duplicated
  `rank=` problem `rankQueryParam` exists to close.
- Every snapshot carries `buildRequestKey(champ, lane, rankBracket)` and consumers pass the key they
  expect; a mismatch reads as `loading`. Without it the hero can arm a button with the PREVIOUS lane's
  build mid-change.
- **One action, one implementation:** `builds/applyActions.ts` owns both companion writes and three
  buttons call it. Do not copy the read-session / build-body / POST / map-result sequence again.
- IMPORT BUILD and APPLY RUNES were pure `scrollIntoView` wearing action labels for a long time, and
  on a lane with no build data both anchors were absent so they did nothing at all. They now perform
  the real actions, and when they cannot act they are DISABLED WITH A VISIBLE REASON — never live and
  inert. The scroll is gone: both anchors sit inside `display:none` tabpanels on two of the three tabs.
- Disabled hero controls drop their FILL; they do not dim their text. Dimming measured 1.74:1 and
  2.55:1. The current treatment measures 5.30:1.

## A corrupt byte passes tsc AND eslint (v0.107.0, 2026-08-11)

- A `perl` in-place edit wrote a raw `0x97` byte into a `.ts` route file. **`npx tsc --noEmit` and
  `eslint .` both passed on it**; only the swc loader inside `next build` rejected it, surfacing as a
  500 at runtime. Typecheck and lint are not encoding checks — a green pair of those two does not mean
  a file is valid UTF-8. Prefer Write/Edit over stream editors on source files, and never treat
  tsc+lint as a substitute for a real build.

## u.gg's tier enum is a DIFFERENT enum, and the draft side has its own bracket (v0.108.0, 2026-08-11)

- **Two providers, two unrelated tier numberings. Never carry one across.** coachless is
  Iron 0 … Challenger 9 (see the section above). u.gg, read out of
  `static.bigbrain.gg/lol/static/js/main.0b1ef45712f1b0d3f4e3.js`, is:
  `UNRANKED 0 · CHALLENGER 1 · MASTER 2 · DIAMOND 3 · PLATINUM 4 · GOLD 5 · SILVER 6 · BRONZE 7 ·
  OVERALL 8 · UNKNOWN 9 · PLATINUM_PLUS 10 · DIAMOND_PLUS 11 · IRON 12 · GRANDMASTER 13 ·
  MASTER_PLUS 14 · DIAMOND_2_PLUS 15 · EMERALD 16 · EMERALD_PLUS 17`.
- `EMERALD_TIER = 10` was a GUESSED name and was wrong for months: tier 10 is `PLATINUM_PLUS`, so
  `/draft` served Platinum+ data while Builds served Diamond+. Nothing on screen said "Emerald", so
  there was no visible contradiction — the wrongness was the population, not a label. This is the
  second time in one day a guessed provider enum turned out wrong; **check the provider's bundle.**
- **Any naming claim here is checkable by arithmetic on ONE live file.** The aggregates nest exactly:
  tier 10 = tier 4 + tier 17; tier 17 = tier 16 + tier 11; tier 11 = tier 3 + tier 14; tier 8 is the
  sum of all ten single ranks. No rounding. If a claimed name breaks the nesting, it is wrong.
- **`tier` is a PARTITION KEY** on `draft_matchup` and `draft_champ_stats`. Changing the constant
  orphans the old partition and the draft page reads empty — it requires a full re-ingest
  (`scripts/ingest-draft.mjs`, ~42 minutes for 173 champions), not a rename. The old `16.14/tier10`
  partition is left in place, orphaned and harmless.
- **Second-order effect to expect on ANY narrowing:** the fixed thresholds bite harder on a smaller
  bucket. `BAN_MIN_MATCHUP_GAMES = 1000` and the K=200 confidence floor in `lib/draft/score.ts` are
  unchanged, so ban-producing champions per lane fell from 47-67 to 26-30, and the share of matchup
  rows over 200 games fell from ~20% to ~9%. That is correct behaviour on less data, not a
  regression. Do not lower a threshold to make a list look full without deciding it on merit.
- Tier 15 is NOT sparse: after ingest, champion-lanes clearing the 30-game floor are top 168/173,
  jungle 110/169, mid 164/173, bot 156/173, support 159/173. The four champion-lanes present at tier
  10 but absent at 15 are all off-role noise (Senna jungle, Yuumi jungle, two at 5-6 games).

## Thresholds and the rank bucket (v0.109.0, 2026-08-11)

- **Draft thresholds split into two kinds, and they behave OPPOSITELY when the bucket moves.**
  **Popularity floors are RELATIVE** — `POOL_MIN_LANE_SHARE` is 0.1% of lane games, which is exactly
  July's live-verified 5,000-of-4,859,727 bar rewritten so it cannot rot. **Evidence floors are
  ABSOLUTE** — `N_FLOOR` 30, `K` 200, `MASS_GATE_MIN_GAMES` 30, `SYMMETRY_MIN_GAMES` 200 stay put,
  because evidence does not get cheaper just because there is less data. Mechanically scaling
  `MASS_GATE_MIN_GAMES` by the population ratio would have given 4 games, which is not evidence in
  any bucket.
- **The measured tier-10 to tier-15 population ratio is 8.08x** (4,859,727 to 601,375 lane games,
  patch 16.14). **Any flat game-count threshold carried across that boundary is wrong by that
  factor.** v0.108.0 moved the bucket and revisited only `BAN_MIN_MATCHUP_GAMES`; five other
  thresholds were left mis-calibrated and silently trimmed real data.
- **`MASS_COVERAGE_GATE` is a pathology guard, not a trimmer.** Set clear of the whole observed
  distribution (0.75 against a 0.88 worst case); excluding 0 candidates is the correct resting state.
  At 0.9 it was excluding 4 real top-lane candidates.
- **`BAN_MIN_MATCHUP_GAMES` stays 1000 because it is a USER DIRECTIVE naming that figure, not a
  calibration.** Do not re-derive it from data, and do not pin same-class thresholds equal to each
  other — that is how one measurement silently became five.
- **`tier` is a partition key and the OLD partition is still there**, so any "is this patch complete"
  count must carry a tier predicate. One shared resolver now: `lib/draft/servingPatch.ts`. There were
  three copies of that query and the predicate was missing from all three.
- **lolalytics accepts `&tier=d2_plus`** (the page echoes "D2+"; unknown slugs 404 rather than
  silently defaulting). Both sides of the cross-check must be pinned to the same bracket AND the same
  patch. Measured: unpinned rank gave 9.1% disagreement against a 10% fail bar — one matchup from a
  false alarm — and 21.0% at the lower sample floor. Pinned, 0%.
- **A missing u.gg tier partition is now LOUD** (`DecodeMatchupsResult.tierMissing`). It used to
  decode as `{byRole:{}, skippedRows:0}` — a clean, successful, empty run.
- **A client-side default filter must never subtract from what the server chose to serve.** The
  draft page's `minimumGames` default of 1000 was stricter than the server's own floor and was
  hiding rows the server had deliberately included (Olaf mid, 869 games, now visible at rank 2).
- **`pruneOldPatches` remains tier-blind** — it keeps the 2 most recent patch labels across all
  tiers, so the orphaned tier-10 partition keeps 16.14 looking "recent". Harmless (it only ever
  refuses to delete) but it is a known gap, not an oversight.
