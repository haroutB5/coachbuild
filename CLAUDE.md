# CoachBuild — technical reference

**Describes v0.51.3, 2026-07-24.** `package.json`'s `version` is the single source of truth for the app version — if it's moved on since this date, treat anything below with more skepticism the further it's fallen behind (check `CHANGELOG.md` for what shipped after this doc's version).

League of Legends coaching companion. Next.js 14 (App Router) + TypeScript + Tailwind, Vercel (prod: `coachbuild.vercel.app`, personal account). Serverless throughout — no server processes besides Vercel functions + three daily crons, plus a user-run PowerShell companion (`public/companion.ps1`) that bridges the app to the local League client. `NEXT_PUBLIC_APP_VERSION` is injected by `next.config.mjs` from `package.json` and shown in the global nav's rail/tab-bar footer; the SW cache name is version-tied. Read this file before exploring source; it's the map, not a substitute for reading the actual code before changing it.

## Six surfaces, one shell

Every route renders inside `AppShell.tsx` (`app/layout.tsx`, wraps `CompanionProvider`) — a global gold/navy `TopBar` (champion search + live champ-select chip + APPLY RUNES button, `components/hextech/GlobalNav/TopBar.tsx`) plus `DesktopRail` (`≥lg`, branded left rail, PLAY group: Builds/Draft/Companion; DATA group: Pro Players/Patch Movers/My Stats; live companion status card; `PATCH n · vX.Y.Z` footer) or `MobileTabBar` (`<lg`, fixed bottom, exactly 4 destinations: Builds/Pro Players/Patch Movers/My Stats — no Companion, no Draft on mobile, deliberate). Nav data source: `components/hextech/GlobalNav/navItems.ts` (`NAV_ITEMS`, `MOBILE_NAV_ITEMS` derived via a `mobile` flag) + `activeNav.ts`. Champion search is global now (`championSearchBus.ts` — a pub/sub the Builds page subscribes to; searching from any route navigates to `/` and selects the champion).

**Builds (`/`, `app/page.tsx`)** — pick a champion, get the WPA-ranked (Win Probability Added) recommended runes/shards/items/spells, sourced live from coachless.gg's deep-learning stats API (`lib/coachless.ts`, a thin proxy — no key/auth, public endpoint). `lib/recommend.ts` ("THE ENGINE") evaluates every primary tree and every secondary tree and returns up to 3 confidence-weighted variants (`buildRecommendations`). Route: `app/api/build/route.ts` → 200 with `BuildResponse[]`, 404 (`error: "no_data"` / `"not_enough_data"`) when the champ+role lacks data (`NotPlayedInRoleError`), 500 with no detail leak on genuine failure. Optional params: `rank=<bracketId>` (`lib/rankBrackets.ts`, default `all` = legacy High-Elo blend `[5,6,7]`) and `enemyChampionId=<int>` (matchup conditioning — confirmed 403 on every coachless endpoint, `BuildResponse.matchup.supported` always `false`; wired but dormant). v0.51.0 unified the page into one view: lane tabs (TOP/JG/MID/BOT/SUP) + elo tabs (High Elo/Diamond/Emerald/Platinum) live inside `ChampionHero`; a HIGH/MEDIUM/LOW CONFIDENCE chip (`confidence.ts`, games-count banding) replaces the old separate BUILD/PRO BUILDS tab strip. Pro browsing (the old "PROS mode") moved to `/history`. Icon/data CDN URLs and "what patch is live" resolution live in `lib/staticData.ts` — see Gotchas.

**Draft (`/draft`, `app/draft/page.tsx`)** — the "Tactical Draft Analyzer." Suggests statistically-favored PLAY and BAN champions for a lane given the enemies entered (manual picker or auto-filled live via the companion). Sourced from u.gg's stats2 CDN (`lib/draft/ugg.ts`), one tier (Emerald+), ingested into `coachbuild.draft_matchup`/`draft_champ_stats` and scored with a shrinkage-toward-baseline model (`lib/draft/score.ts`: `n/(n+K)`, K=200, floor 30 games; direct-lane-opponent weight 1.0x vs off-lane 0.2x; bans rank by disadvantage × presence, excluded entirely below `BAN_MIN_MATCHUP_GAMES=1000`). v0.51.0 retheme: shared navy/gold shell (cyan HUD retired); ENEMY COMP PROFILE renders as horizontal 0–100 bars (`DraftCompBars.tsx` over the curated 173-champion `lib/draft/compRatings.ts` ratings, replacing the old radar) plus up to 3 tactical takeaway chips (`lib/draft/compTakeaways.ts`, editorial thresholds — honest fallback text like "High ban priority" when a specific claim isn't backed by data, never an invented mechanic like "denies your sustain"). 2-col layout, ban suggestions inline in `MyChampionPanel`, picks table has a GAMES column. `personal`/`personalOverall` per-row badges (My Stats integration, display-only — see hard rules).

**Companion (`/live-setup`, `app/live-setup/page.tsx`)** — install/pairing UI for the PowerShell tray companion. `components/hextech/companion/StatusHeroCard.tsx` shows a 4-step Client→Lobby→Champ Select→In Game progress rail; `AutomationToggles.tsx` are real `role="switch"` controls (auto-apply runes / auto-apply item sets) with a privacy footnote. Connection-test/LNA explainer/rolling error-log machinery (`recordCompanionError`, last 5 shown) sits below the fold. See "Companion integration" below for the LCU bridge contract.

**My Stats (`/mystats`, `app/mystats/page.tsx`)** — personal match tracker for ONE fixed linked Riot account (`MunsterHunter#EUW`, overridable via `MY_RIOT_ID`/`MY_RIOT_REGION`), backfilled from Riot match-v5 into `coachbuild.my_matches` (`lib/mystats/**`). v0.51.0 UI: 4 stat tiles (GAMES / WIN RATE + vs-last-split delta / MAIN / BUILD ADHERENCE), a recent-games list with per-game KDA + WPA-build/off-build chips, a champion-pool card, and an on-build insight line. `MyStatsRefresher.tsx` fires an on-demand incremental refresh (`POST /api/mystats/refresh`, 3-min server-side cooldown, `lib/mystats/refresh.ts`) on every page view. **DISPLAY-ONLY, hard rule** — see below. Scoped to the CURRENT SPLIT (`lib/mystats/season.ts`'s `SPLIT_BOUNDARIES`); adherence/KDA/items/keystone only populate for matches ingested/backfilled after migration 0014 landed AND only resolve `on_wpa_build` when the match's own patch matches the live recommend pipeline's current patch (no historical-patch override exists) — a match on an older patch shows no adherence chip, honestly.

**Patch Movers (`/movers`, `app/movers/page.tsx`)** — v0.51.0 semantic rewrite: per-CHAMPION win-rate shifts (was per-keystone/item WPA swings). `lib/patchMovers.ts` unions a curated per-role candidate pool (`ROLE_CHAMPION_POOL` — coachless has no champion-list/tier-list endpoint, so this is NOT a true ladder top-N) across all 5 lanes, computes win rate via the same occurrence-weighted starter-item formula `lib/heroStats.ts` uses for the hero banner, diffs current vs. previous populated patch, sorts by `|Δpp|`, applies a min-games floor. Single table, no lane pills. Curated one-line patch notes (`lib/patchNotes/`, web-verified per-patch entries only — absent shows "—", never fabricated).

**Pro Players (`/history`, `app/history/page.tsx`)** — search a tracked pro player or a champion, see recent games; player/champion search-first is the page's primary (and, since v0.51.2, only) view — a recent-competitive-games table was added in v0.51.0 and removed in v0.51.2 per user directive (files deleted, do not resurrect without asking). Two independent data sources feeding one unified response shape:
- **Solo queue** — `lib/pro/**`. Roster from lolpros.gg, matches from Riot match-v5 + timeline, stored in `coachbuild.pro_matches`/`pro_accounts`/`pros`.
- **Pro play (on-stage)** — `lib/prostage/**`. Official esports games from Leaguepedia (lol.fandom.com Cargo tables), stored in `coachbuild.prostage_matches`. Item build order reconstructed on first view from lolesports' free livestats feed and persisted.

Both merged by `app/api/pros/route.ts` (`GET /api/pros`) into one `ProGame[]`. `GET /api/players?q=` is player typeahead. `GET /api/prostage/timeline?player=...` computes/serves a pro-play game's item build order on demand. `GET /api/pros/team-players` fetches one game's full per-player team builds on demand when a detail sheet opens.

## API routes (current)

```
app/api/build/route.ts              GET  /api/build?championId=&role=&rank=&enemyChampionId=
app/api/champions/route.ts          GET  /api/champions
app/api/draft/recommend/route.ts    GET  /api/draft/recommend?lane=&enemies=&laneOpp=&hover=
app/api/hero-stats/route.ts         GET  /api/hero-stats?championId=
app/api/patch/route.ts              GET  /api/patch  (best-effort, feeds the rail's patch footer, s-maxage=3600)
app/api/patch-movers/route.ts       GET  /api/patch-movers  (no `role` param since v0.51.0 — whole-roster response)
app/api/players/route.ts            GET  /api/players?q=
app/api/pros/route.ts               GET  /api/pros?championId=|proId=|player=&role=&source=
app/api/pros/team-players/route.ts  GET  /api/pros/team-players?source=&gameId=&championId=|player=
app/api/prostage/timeline/route.ts  GET  /api/prostage/timeline?player=&game=
app/api/mystats/summary/route.ts    GET  /api/mystats/summary  (no-store, private)
app/api/mystats/matchups/route.ts   GET  /api/mystats/matchups  (no-store, private)
app/api/mystats/refresh/route.ts    POST /api/mystats/refresh  (on-demand incremental, cooldown-gated, no auth by design)
app/api/mock-companion/route.ts     dev fixture mirroring the companion bridge wire contract
app/api/ingest/{roster,matches,prostage,draft,mystats}/route.ts   cron-driven, Bearer CRON_SECRET-gated
```

Vercel crons (`vercel.json`): `/api/ingest/matches` 06:00 UTC, `/api/ingest/prostage` 07:00 UTC (one tournament/invocation, staleness-rotated), `/api/ingest/mystats` 20:00 UTC (daily — the Vercel free plan caps cron frequency at once/day; on-demand incremental refresh via the page-view trigger covers the gap between runs). `/api/ingest/draft` runs on a separate schedule for the u.gg matchup refresh.

## Data pipeline map

```
lib/pro/                       — solo-queue pipeline (see prior structure, unchanged since v0.31)
lib/prostage/                  — pro-play (Leaguepedia) pipeline; cargo.ts now supports `offset` pagination
                                  past Cargo's 500-row-per-call cap (both api.php and CargoExport) — the
                                  old ">500-row truncation" risk is closed, not just theoretical anymore.
lib/draft/                     — "Draft" recommender
  ugg.ts                          u.gg stats2 CDN client + patch/matchup/rankings decoders
  score.ts                        shrinkage scoring (K=200, floor 30), rankBans (1000-game floor)
  recommend.ts                    lane-opponent inference, personal-record extension (PersonalPlayResult)
  ingest.ts, ingestGuard.ts       ingest orchestration + cross-source drift guard (>4pt vs coachless fails loud)
  compRatings.ts                  curated 173-champion 0-3 kit-rating table (comp bars input)
  compTakeaways.ts                editorial takeaway-chip thresholds
  difficulty.ts, damageProfile.ts, patch.ts, lolalyticsCheck.ts
lib/mystats/                   — My Stats personal tracker
  types.ts, season.ts             SEASON_START_MS / SPLIT_BOUNDARIES
  ingest.ts, refresh.ts           backfill + on-demand incremental (cooldown-gated)
  extract.ts                      KDA/items/keystone extraction from Riot match-v5
  adherence.ts                    computeAdherence — keystone match + ≥2 core items; DISPLAY ONLY
  aggregate.ts, account.ts, purge.ts
lib/patchNotes/                — curated per-patch one-liners (lookup.ts, notes.ts) — web-verified entries only
lib/buildSlotCap.ts            — 6-slot game-reality cap (see Hard rules below)
lib/patchMovers.ts             — Feature 4 win-rate-shift model (see Patch Movers above)
lib/rankBrackets.ts            — RANK_BRACKETS (tier labels UNCONFIRMED against coachless's own UI — see Open items)

migrations/                    — run via `node scripts/db-migrate.mjs`, coachbuild._migrations tracking table
  0001-0008   pro/prostage base schema, game stats, team comps, ingest-attempt tracking
  0009_draft.sql                  draft_matchup / draft_champ_stats (Emerald+ tier only, v1)
  0010_draft_audit_patches.sql    total_games column + draft_ingest_cursor
  0011_draft_perspective_fix.sql  P0 fix note (u.gg wins-perspective correction — see CHANGELOG 0.37.2)
  0012_mystats.sql                my_account / my_matches / my_ingest_cursor
  0013_mystats_refresh_cooldown.sql   my_ingest_cursor.last_incremental_at
  0014_mystats_build_adherence.sql    my_matches.{kills,deaths,assists,item_ids,primary_keystone,on_wpa_build,split}
```

Component-side helpers: `components/proAssets.ts`, `components/itemDetail.ts`/`runeDetail.ts`/`shardDetail.ts`/`summonerDetail.ts` (tap-to-detail, CDragon-sourced for runes — Gotcha f), `components/favoritesSync.ts`, `components/focusTrap.ts`, `components/useBodyScrollLock.ts`, `components/hextech/runesPage.ts`, `components/hextech/proConsensus.ts` (Pro Consensus card model — see below), `components/hextech/itemSetBody.ts` (LCU item-set export builder), `lib/favorites.ts`.

## Companion integration (LCU bridge)

`public/companion.ps1` — a PowerShell 5.1 tray app, installed via `irm https://coachbuild.vercel.app/companion.ps1 | iex -Install`, versioned independently of the web app (currently 1.6.3; served over `irm|iex` so users must re-run the install one-liner to pick up a bump — check each CHANGELOG entry's "(COMPANION CHANGE → x.y.z — re-install required)" tag). It watches the League client via the LCU API and bridges to the browser over a local HTTP server (127.0.0.1-only, exact-Origin CORS, per-launch or persisted session token).

- **Champ-select follow.** `followKindForRoute(pathname)`: `"/"` → `"builds"`, `"/draft"` → `"draft"`. The `/status` poll sends `&follow=builds|draft`; the companion opens whichever page(s) are missing an attached tab (neither attached → Builds then `/draft`; one attached → only the other; both → no opens). **`follow=1` suppression invariant:** an attached tab (recent `/status` poll within an 8s window) suppresses re-opening a new browser tab on every champ-select hover — this is load-bearing UX, don't regress it into "always open a new tab."
- **Auto-export.** `components/live/AutoExporter.tsx` (mounted once in `CompanionProvider`, app-wide, every route) reacts to champ-select champion resolution and pushes item sets + runes through the same apply pipelines the manual buttons use, deduped per `(championId, laneId)`. Champion resolution is a 3-way fallback: locked cell id → cell pick-intent → local player's own in-progress pick action.
- **Rune pages are two separate LCU pages by design:** the WPA auto-export page (`"CoachBuild <champ> <role>"`) and the manual "Apply pro runes" page (`"CoachBuild <champ> <role> Pro"`) never collide — each apply targets its own exact-title page, PUT-in-place if it exists. **Hard invariant, SelfTest-pinned:** the companion never DELETEs or PUT-overwrites a page whose title doesn't start with `"CoachBuild"`.
- **Item sets — 4KB LCU per-object budget.** One LCU item set per champion+role (title `CoachBuild <champ> <role>`, no variant suffix), with Core/Buy-order/Pro/Highest-WPA/archetype-category lines as BLOCKS inside it. `Merge-ItemSets` (companion-side) keeps only the set(s) being written this call and prunes every other pre-existing `CoachBuild`-titled set (bounds the PUT payload to O(1) regardless of how many champions the user has viewed — this fixed a real HTTP 413 in v0.46.0). A non-`CoachBuild`-titled set is never touched. Every build line is capped at exactly 6 items / exactly 1 boots (`itemSetBody.ts`'s `buildLine`, `LINE_LEN=6`) — **unconditional, regardless of lane**, because a set is a real target loadout (see Hard rules — this is intentionally different from the Builds-page progression cap).
- **Compliance posture (hard, tested):** IDs/champion-names only, zero summoner names anywhere; rune apply is strictly user-clicked or the opt-out-default auto-export (never a polled game action); item sets are treated as an inert shop-panel suggestion (same class as any external auto-import tool); zero game-automation endpoints; no cooldown/timer computation from Live Client Data.

## HARD RULES (do not violate without a new explicit user directive)

1. **6-item build-slot cap, but two different shapes for two different things.** A build-line PROGRESSION (Core Order / Buy Order on the Builds page) caps at **5 full items + 1 boots for every lane except Bot/ADC, which gets 6 full items + 1 boots** (the late-game boots-sell exception) — enforced at the single choke point `lib/buildSlotCap.ts`, wired into `lib/recommend.ts`'s `ItemsBlock` assembly. An LCU item-SET export line is a real target loadout and stays capped at **6 total (5 full + 1 boots) for every lane, bot included, no exception** — enforced independently in `itemSetBody.ts`'s `buildLine`. Do not let these two caps drift into each other; they represent genuinely different things (a shopping-order display vs. a real inventory).
2. **Starter-slot partition.** Starting items (Doran's/Cull/Dark Seal/Tear/World Atlas/etc., `STARTING_ITEM_ALLOWLIST`) never render in a completed-item list — they get their own "Starting" slot everywhere a build or Pro Consensus surface exists. Any new aggregate/recommendation surface must carve starters out the same way boots are already carved out.
3. **Display-only personal data never feeds a score or ranking.** My Stats (`personal`/`personalOverall` fields, adherence, KDA, everything under `lib/mystats/**`) is display-only by hard user directive ("Don't mix my data with the sample size," ratified 2026-07-21) — see `lib/draft/recommend.ts`'s `PersonalPlayResult` doc comment. It may badge a row or filter a list (a pure filter, never a re-scorer), but must never alter a WPA/win-rate/priority number or reorder anything beyond what the server's own ranking already produced.
4. **No fabricated data.** Patch notes absent for a given patch render as "—", not an invented note. Ban reasons/matchup claims in Draft's takeaway chips fall back to honest generic language ("High ban priority") rather than a specific mechanic the data doesn't back. A curated/estimated value (compRatings.ts's ddragon-tag fallback, an item-set "(low data)" line) is always labeled as such — never presented as measured.
5. **Companion page/set ownership.** Never delete or overwrite an LCU rune page or item set whose title doesn't start with `"CoachBuild"`. Never expand the companion's endpoint surface into anything that acts on the game itself (no auto-pick, no auto-ban, no timer/cooldown computation).

## Test conventions

Vitest, pure-function-only — **no JSX rendering harness** (no jsdom/RTL configured). Component test files (`components/__tests__/*.test.ts` / `components/hextech/GlobalNav/__tests__/*.test.ts`, note `.ts` not `.tsx`) import and test exported pure helpers from a component module, never render JSX. **1524 tests as of v0.51.3**, all green (`npx vitest run`). `vitest.config.ts`'s include-glob must cover nested `__tests__` dirs (a v0.51.0 gap silently excluded 3 GlobalNav test files/52 tests for a while — verify a new nested test dir is actually picked up after adding one). Every lib module touching an external feed (Cargo, Riot, u.gg, lolesports livestats, ddragon) uses injectable `deps`/`transport` params so retry/taint/classification logic is unit-testable without a network call — follow that pattern for new integrations.

## Hard-won gotchas

**(a) Neon HTTP driver + Next's patched `fetch` — `cache:"no-store"` is load-bearing.** `lib/pro/db.ts`: `neon(url, { fetchOptions: { cache: "no-store" } })`. Never remove — a real P0 (v0.15.1) had stale `{rows:[]}` responses cached across deployments.

**(b) Never CDN-cache an empty API response.** `Cache-Control: no-store` on any empty/degraded result; only non-empty responses earn a long `s-maxage`. Applies to every route serving possibly-sparse data, including the newer `/api/patch-movers` and `/api/patch` routes (audit-verified in v0.51.0).

**(c) Leaguepedia (lol.fandom.com) rate limiting.** `api.php`'s anonymous limit can trip after ONE call and stay sticky 3+ minutes — every caller serialized through one process-wide pacer (`lib/prostage/cargo.ts`, 30s floor). `Special:CargoExport` has a lighter limit (5s floor) but Node's own fetch gets Cloudflare-403'd against it (TLS/JA3-fingerprint block) — script paths shell out to curl instead (`scripts/_curl-transport.mjs`). Never run two concurrent Leaguepedia consumers. Pagination via `offset` now exists on both transports (past the 500-row-per-call cap).

**(d) Riot API key budget is shared across every process that calls it.** `lib/pro/pacer.ts` serializes all Riot calls (roster/match ingest, `ingest-player.mjs`, audits, My Stats backfill/refresh) through one process-wide 1.3s-interval queue — but only within a single process. Don't parallelize Riot-calling scripts. The My Stats on-demand refresh endpoint (`/api/mystats/refresh`) is cooldown-gated server-side (3 min) specifically so it's safe to call on every page view without contending for this budget.

**(e) Rune icon special cases.** Deathfire Touch (`8992`) and Stormraider's Surge (`8230`) have stale/wrong `Icon` paths in coachless's bundled data and 403 verbatim. Hardcoded in `lib/staticData.ts`'s `runeIconUrl` AND independently in `components/proAssets.ts` — these modules deliberately don't share code, so a third such rename needs updating in both. `IconWithFallback` is the generic safety net for any other icon 403/404.

**(f) Rune tooltip numbers come from CommunityDragon, not ddragon.** `components/runeDetail.ts` fetches CDragon's `perks.json`, client-cached with a 10-day TTL (no per-patch version to key off).

**(g) `purchaseOrder[].ts` (and prostage item-timeline `ts`) is SECONDS into the game, not milliseconds.**

**(h) prostage rows have structural gaps soloq rows don't** — `gameDurationSec` always `0`, `purchaseOrder`/`skillOrder` always `[]`. `role` can be `-1` (unresolved) and must never cause a row to be dropped.

**(i) Don't run two `next build`/`next dev` processes against one checkout** — an orphaned process locks `.next/trace`, `EPERM`s a subsequent build. Deleting an API route needs an extra sweep: clear the matching stale `.next/types/app/api/...` stub before re-running `tsc`, or `verify-fix.sh`'s tsc gate fails on a ghost type (hit in v0.51.2 removing `/api/pros/recent`).

**(j) `GET /api/pros` deliberately omits `allyPlayers`/`enemyPlayers`** from the list response (on-demand via `/api/pros/team-players` instead — a real 23.5kB/44.7kB payload cut). `cleanLeaguepediaName` strips wiki-disambiguation parentheticals at both ingest and read time.

**(k) `public/sw.js` carries a second, UNVERSIONED cache: `coachbuild-icons-v1`**, cache-first for `cdn.coachless.gg`. The `activate` handler's eviction sweep must keep excluding `ICON_CACHE` — a routine version bump must not wipe it.

**(l) `prostage_matches.game_id` is per-MATCH, not per-player** — any client state keyed on it must reset on a cross-player jump.

**(m) `IconWithFallback` is the single `<img>` sink for the whole app** — lazy-loading, explicit dimensions, 403/404 fallback glyph, on-device cache path. New icon call sites should always render through it.

**(n)/(p) `/history` and `/` (Builds) both integrate browser back/forward** via `NavHistoryState`/`useSheetBackNav` — every selection/sheet-open is a self-sufficient history entry. New modal/selection UI on either page must push/pop through the existing mechanism.

**(o) The daily pro-play ingest cron (`/api/ingest/prostage`, 07:00 UTC) has a long-standing untriaged gap** — see Open items below. Don't assume prostage is self-refreshing the way solo-queue is.

**(q) Any component-owned `fetch` in a prop-keyed `useEffect` needs a stale-response guard** (`cancelled`-closure pattern) — a real bug class hit multiple times (`BuildTabContent.tsx` v0.27.1, a lane-flip race in v0.36.0 from a React stale-closure between two effects sharing `state`/`lane`). Any new component fetching off a prop-keyed effect must follow this from day one.

**(r) `public/sw.js`'s `install` handler doesn't call `self.skipWaiting()` unconditionally** — an update sits in `registration.waiting` until the user taps "Refresh" on the update toast. `ServiceWorkerRegister.tsx` gates the toast on `controller` being non-null (so first-ever install never shows it) and now persists dismissal in `localStorage` keyed to the waiting worker's `scriptURL` (v0.51.1 fix — the old `sessionStorage` boolean resurfaced the toast on every new tab/PWA relaunch).

**(s) A flat "top-N by frequency" aggregate must never be assumed positional.** Multiple real bugs (Pro Consensus rune-apply writing empty/wrong-slot pages, v0.48.3/0.48.4) came from treating a frequency-ranked list as if it preserved per-slot/per-row structure. Anything that needs slot-coherence (a full LCU rune page) must resolve per-ROW/per-SLOT modals explicitly (see `components/hextech/perkSlots.ts`), never derive it from a flat top-3.

**(t) A curated/frequency-based data-quality precedence must prefer the MORE SPECIFIC signal.** The `pro_role ?? role` vs `role ?? pro_role` bug (v0.49.1) — a roster-level attribute silently overrode a per-game one, corrupting team ordering. When merging two sources of the same fact at different granularity, the finer-grained one should generally win.

## Environment

`DATABASE_URL` (Neon, `coachbuild` schema on a **shared instance — never touch `public` or any other schema**), `RIOT_API_KEY`, `CRON_SECRET`, `MY_RIOT_ID`/`MY_RIOT_REGION` (My Stats account override, defaults to `MunsterHunter#EUW`). The app degrades to a friendly empty state without any of these. The Builds page needs none of them (coachless.gg + ddragon/CDN are keyless).

## Deploy

`npx vercel --prod --archive=tgz` (plain upload stalls headless). Commit author must be `harout_b5@live.com` (Vercel blocks work-email-authored commits). No separate worker/infra component — one Next.js deployment plus the crons above, plus the independently-versioned companion served as a static file.

## Open items

See `HANDOFF.md` for the current prioritized list (rank-bracket labels, patch-movers curated pool, the prostage cron gap, and today's known-open My Stats/patch-notes caveats).
