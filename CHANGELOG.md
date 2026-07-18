# Changelog

All notable changes to CoachBuild are documented here.

## [0.31.0] — 2026-07-18
### Added
- **Optimized item order**: the core build's item sequence re-derived with each pick conditioned on owning the previous one (the coachless API supports 2 priors — verified live), with an adoption-relative floor so thin conditional tails can't surface as advice. Shown under the core path when it differs; a quiet confirmation note when identical.
- **Rank bracket selector**: filter builds by real league tiers (Platinum+ through Challenger; default remains the legacy high-elo blend, byte-identical requests). Persisted per device.
- **Patch Movers page**: biggest headline keystone/item WPA swings between the current and previous patch, per lane, compared daily.
- **Update toast**: new deploys offer "Update ready — Refresh" instead of applying silently on next navigation.

### Not shipped (honest finding)
- Matchup-conditioned builds: the upstream API rejects matchup parameters (verified 403 across endpoints). The engine degrades gracefully and will auto-activate if support ever appears; no UI is shown.

### Fixed (pre-ship audit)
- Patch-movers route gained `maxDuration = 60` (its cold path exceeded the platform default — the first daily visit would have 500'd).
- First-time visitors no longer get a spontaneous reload from the new SW lifecycle (reload now only fires when the user tapped Refresh).

## [0.30.0] — 2026-07-18
Full adversarial codebase review (Fable, cold-start) at v0.29.1: no P0, 1 P1, 2 P2, P3 batch — all implemented, re-verified by the same reviewer (one new seam defect found in re-verify, patched same release).

### Fixed
- **P1: `/api/hero-stats` no longer CDN-caches degraded results.** A transient upstream (coachless) failure returned `{winRatePct: null, gamesCount: null}` with a 6h edge cache — pinning a broken win-rate banner and most-played-lane landing per PoP (the v0.15.1 cached-empty incident class). Degraded and no-data results now go out `no-store`; healthy results keep the cache.
- **P2: prostage cron tournament rotation no longer pins dead tournaments.** Staleness was proxied by `max(ingested_at)`, which never advances on a zero-new-rows pass — a finished tournament would win the rotation every day forever, starving ongoing ones. New `prostage_ingest_attempts` table (migration 0008) stamps every attempt; rotation orders by last attempt.
- **P2: match-ingest cursor walk no longer skips half the backlog.** OFFSET pagination over an ORDER BY that mutates mid-walk (processing bumps `last_fetched_at`) skipped ~batch accounts per step for external pingers. Replaced with a stable walk-start-timestamp predicate; the daily-cron path is unchanged. Re-verify found the rewrite could loop forever on a zero-progress page (e.g. suspended Riot key → all 403s); errored and unmapped-region accounts now stamp `last_fetched_at` so the walk always terminates, and a future cursor is clamped to now.
- Transient Riot blips can no longer stick `active=false` on a healthy pro account (definitive 4xx only).
- Ultra-long game timelines that hit the 500-frame walk cap, and games beyond the 10-page schedule search, are now marked transient (retryable) instead of being persisted as complete/unavailable.
- Team comps are omitted for sides whose role ordering degraded to source order (soloq producer) — the "vs" laner shown can no longer be silently wrong for those rows.
- Pro-consensus: a keystone whose games all lack a resolved rune tree can no longer render above a different keystone's tree (falls back to a consistent tree+keystone pair or a tree-less page).
- Prostage icons no longer resolve against a frozen 16.11.1 CDN folder — the live patch version is derived from the champion icon map, hardcoded version only as last resort.
- Back/forward history entries no longer capture a stale tab/source when a champion's lane correction lands after a mid-flight filter change.

### Changed
- Recommendation engine: alternatives' noise floor lowered 800→400 games so it is always below the headline adoption bar (was inverted for sub-16k-game champ+role combos; sparse combos may show different alternates — intended).
- Ingest auth uses constant-time comparison; prostage cron logs and returns an error count (diagnosing why the scheduled run has never landed data).

### Removed
- Orphan public `/api/lane-defaults` route (zero consumers; its lib remains).
### Fixed
- **Durable pro-account match ingest: fixed the root cause of accounts never getting fetched** (audit 2026-07-13 found 1,312/1,445 active `pro_accounts` permanently stuck at `last_fetched_at IS NULL`, incl. all 6 of pro player Nemesis's EUW accounts, added 2026-07-09 — his tracked gameCount was 0). `lib/pro/ingestMatches.ts`'s account-selection query ordered by `last_fetched_at ASC NULLS FIRST` with NO tiebreaker — Postgres gives no ordering guarantee among equal (all-NULL) sort keys, so an `OFFSET`/`LIMIT` window over a 1,312-row NULL cohort could return an arbitrary subset per invocation with no bounded-time guarantee every account is ever reached. Added `created_at ASC` as a deterministic tiebreaker — oldest-registered never-fetched account goes first, and a fresh fetch pushes an account to `now()` (far behind the remaining NULLs), so the queue is now a strict FIFO that provably drains.
- **Raised the daily cron's effective batch from 5 to 20** (`app/api/ingest/matches/route.ts`'s un-parameterized default — the Hobby-plan cron hits the route with no query string, so this default IS the cron's daily throughput). Worked through the 60s `maxDuration` budget: a never-fetched account can cost up to `1 + 20*2 = 41` paced Riot calls (`getMatchIdsByPuuid` + `getMatch`/`getMatchTimeline` per new match, 1.3s pacer floor) ≈ 53s — nearly the whole budget for ONE account, so neither the new batch of 20 nor the old default of 5 is provably safe against an all-worst-case batch. Raised anyway: ingest is idempotent/resumable at the match level (`ON CONFLICT DO NOTHING` + an `existing`-match filter before fetching), so a mid-batch timeout only delays that account's `last_fetched_at` bump by a day, never loses data — batch=20 maximizes drain rate for the common (incremental, few-new-match) case while degrading gracefully on the worst case. Full math in the route's header comment.
- New test `lib/__tests__/pro-ingestMatches.test.ts` asserts the account-selection query text contains the `created_at ASC` tiebreaker in the same `ORDER BY` clause.

## [0.29.0] — 2026-07-13
### Fixed
- **Fixed an impossible Pro Consensus rune page** (user report on a champion with a modal-only keystone — e.g. Deathfire Touch 16/30): the card showed a page no in-game rune setup could produce — minors mixing two trees (Presence of Mind from Precision sitting next to Sorcery minors), a "secondary tree" equal to the primary tree, and the same rune (Manaflow Band, Celerity) appearing as BOTH a primary minor AND a secondary pick. Root cause: `components/hextech/proConsensus.ts` flat-aggregated `primaryMinors`/`secondaryPicks`/`secondaryTree` over ALL games regardless of each game's primary tree. When the top keystone is only modal (16 of 30 games), the other 14 games ran DIFFERENT primary trees, so their `primary[]` polluted the minors row and their secondary trees/picks polluted the secondary column.
  - **Fix — condition the whole page on the top keystone's TREE, resolved from the game data itself.** Every game already carries `runes.primaryTree` (set by `lib/pro/extract.ts` from Riot's perk styles and `lib/prostage/extract.ts` from Leaguepedia's `PrimaryTree` column, where `primary[]`/`secondary[]` are bucketed by parent tree), so NO hardcoded keystone→tree table is needed. New `resolvePrimaryTree()` picks the tree the modal keystone actually ran under; the page sample is then games whose `primaryTree` matches it. `primaryMinors` aggregate `primary[]` over that page sample only; `secondaryTree` is the modal secondary tree over the page sample EXCLUDING the primary tree (impossible in-game); `secondaryPicks` aggregate only over page-sample games whose secondary tree equals that modal tree — so every pick belongs to the displayed secondary tree and, being a different tree from the primary, can never duplicate a primary minor.
  - The top keystone itself stays modal over ALL games with a resolved keystone (the honest "16/30" is unchanged). Shards, spell pair, items, and boots are tree-independent and remain aggregated over every game.
  - `ProConsensusModel` gains `primaryTree: number | null` and `primaryTreeSampleSize` (N_page). `ProConsensusCard.tsx` now shows the resolved primary tree as the PRIMARY header (icon + name, mirroring the secondary tree header) and names the tree in the conditioned-sample caption ("minors from 18 games running Sorcery").
  - 13 new tests in `components/__tests__/proConsensus.test.ts` (43 total in the file) encode the invariants: no rune id in both minors and picks; `secondaryTree ≠ primaryTree`; a different-tree-keystone game contributes nothing to minors/secondary; a mixed-tree fixture reproducing the screenshot (16 Sorcery + 14 Precision) shows only the Sorcery-conditioned page; conditioned denominators ≠ gamesTotal; graceful degradation to a null primaryTree when no game carries tree data; plus `resolvePrimaryTree` unit coverage. Item/boots/shards/spells tests unchanged and green.

## [0.28.1] — 2026-07-13
### Fixed
- **Fixed a real visible defect in v0.28.0's `BootsStackTile`: boot names clipped mid-word with no ellipsis** ("Spellslinge Shoes" for Spellslinger's Shoes, confirmed on the v0.28.0 smoke screenshot at 390px). Root cause, confirmed via DOM measurement rather than assumed: the name's `line-clamp-1` span sat in a flex child with no definite width (`min-w-0` alone, no `flex-1`) — Chromium's `-webkit-line-clamp` height computation goes wrong inside a flex row without one, and the single-line clamp had no room to show an ellipsis in the ~46px column left after the icon. Fixed by giving the text column `flex-1` (a definite width before line-clamp is evaluated) and switching the name to `line-clamp-2 break-words`, the same two-line wrap treatment `ItemTile`'s own name already uses — a boot name now always wraps (even mid-word for an unbroken token like "Spellslinger's" in this narrow column) instead of losing characters.
- Re-verified the stacked boots cell's vertical alignment against sibling item tiles (existing `justify-center` on the stack's container) — measured boot-stack first-icon center within ~6px of the sibling `ItemTile`'s icon center at 390px; no layout change needed there, already effectively centered.
- CSS/layout only — `components/hextech/proConsensus.ts`'s aggregation model, tap-for-detail wiring, and every other Pro Consensus section are unchanged.

## [0.28.0] — 2026-07-13
### Changed
- **Pro Consensus's rune section is now ONE composed in-game rune page instead of a keystone+tree row followed by a separate flat "Additional Runes" list** (user feedback on a live screenshot: "Put the additional runes as the layout lol runes are set as in game. Don't put them like that separately"). `components/hextech/ProConsensusCard.tsx` now lays out a 3-column grid (stacks to 1 column at 390px) mirroring the BUILD tab's `RunesSummonersCard` vocabulary: **Primary** column — keystone (large, gold ring) with its 3 minor runes below it; **Secondary** column — tree icon+name+fraction header, its 2 picks, then stat shards; **Summoners** column — the spell pair. New `ConsensusRuneTile` renders every rune the same way RunesSummonersCard's `RuneTile` does (icon above name above stat), just driven by a pick-rate percentage instead of a WPA score. Honesty affordances are unchanged in substance, consolidated in form: every tile still shows its own `pct · count/denom` (minors/picks/shards keep their own per-slot sample-size denominators, per `proConsensus.ts`'s module header), and the three "from N games" captions collapse into one small footer line instead of three repeated ones. N=0 hide and N<3 caution behavior unchanged; every rune/shard tile keeps its tap-for-detail popover wiring.
- **Boots now occupy ONE item-grid slot instead of two** (user feedback on the live ITEMS row: Crimson Lucidity 35% and Spellslinger's Shoes 27% were each taking a full item slot on Viktor mid, crowding out a real item). `components/hextech/proConsensus.ts`'s `ProConsensusModel` gains a `boots: ItemFrequency[]` field (top 2 boots by pick rate, partitioned from the same completed-item counts via `itemMeta`'s `tags.includes("Boots")` — an item with no metadata is never classified as boots) — `items` is now top 6 NON-boots, so a real item backfills the slot boots used to double-occupy. New `BootsStackTile` renders both boot choices stacked vertically in one grid cell (icon+name+pct+count each, independent fractions against the same games-total denominator — never merged into a combined stat); hidden entirely when the sample has no boots. Each stacked row keeps its own tap-for-detail popover.
- New tests in `components/__tests__/proConsensus.test.ts` cover the boots partition (tags-based classification, top-2 cap with items backfilling to top-6, an item with no metadata never classified as boots, empty-boots sample). Two pre-existing tests updated to assert boots now surface via `model.boots`, not `model.items`.

## [0.27.5] — 2026-07-13
### Fixed
- **Fixed a real prod P0: the Pro Consensus card could crash on load with "Pro consensus data couldn't load (undefined is not an object (evaluating 'D.tags.includes'))"** (Safari/iOS phrasing — reported from the user's phone PWA). Root cause: `components/itemDetail.ts`'s `readLocalStorageCache` JSON-parsed whatever was stored under `coachbuild:itemdata:v1:<ver>` and trusted its shape blindly; v0.27.1 added `into`/`from`/`tags`/`purchasable` to `ItemDetail` without bumping that cache prefix, so a device still holding a pre-v0.27.1 entry returned an object missing those fields. `components/hextech/proConsensus.ts`'s `isBuildItem`/`isBootsFinal` then called `meta.tags.includes("Boots")` on `undefined`.
  - Bumped the localStorage cache key to `coachbuild:itemdata:v2:` — no stale pre-v0.27.1 entry is ever read again. `readLocalStorageCache` now also normalizes every parsed entry defensively (`into`/`from`/`tags` default to `[]`, `purchasable` defaults to `true`, etc.), so a future shape change degrades instead of crashing. `writeLocalStorageCache` best-effort sweeps any lingering `v1:*` keys on next write.
  - `isBootsFinal`/`isBuildItem` (`proConsensus.ts`) are now defensive independently of the cache fix — `Array.isArray` guards on `tags`/`from`/`into` before touching them, since `meta` ultimately flows from `JSON.parse` and the type signature is only a compile-time guarantee. A malformed/legacy-shape meta now degrades to "exclude" (same "never assume, never invent" posture as the existing `!meta` branch) instead of throwing.
  - New regression test in `components/__tests__/proConsensus.test.ts` asserts `isBuildItem` never throws on a legacy-shape meta object (name/gold/description only, no into/from/tags/purchasable).

## [0.27.2] — 2026-07-13
### Fixed
- **Fixed a real, live-reproduced P0: the BUILD tab could silently render the WRONG champion's entire build** (runes/summoners/items) under the CORRECT champion's header. `BuildTabContent.tsx`'s `/api/build` fetch had no stale-response guard — a champion/lane change starts a new fetch without cancelling the previous one, so two in-flight requests can resolve OUT OF ORDER (a fresh pick's cache-MISS request landing after an OLDER cache-HIT request from a since-abandoned pick, e.g. via a quick browser back). Reproduced live on prod (Slow 3G: search Ahri, immediately hit back to Viktor) — Ahri's Electrocute/Ignite build rendered under the "VIKTOR" header, while `ChampionHero`/`Sidebar` (driven by separate, correctly-guarded page state) kept showing Viktor. Fixed with the same `cancelled`-closure pattern `ProConsensusCard` already used, so a superseded response is now inert regardless of resolution order.
- **A slow `getMostPlayedLane()` correction (v0.26.0) could apply to the wrong view after a browser back/forward.** Every OTHER navigation handler (lane tap, champion pick, player pick, sheet-tap jump) invalidates a pending most-played-lane lookup by bumping a request-id ref; a back/forward restore never did, since it's driven by `useSheetBackNav`'s popstate listener rather than one of those handlers. A lookup that outlived a back-navigation could still land, silently changing the CURRENT (unrelated) view's lane and overwriting its history entry with the STALE champion. `app/page.tsx`'s `restoreMainView` now bumps the same ref on every restore (mount-resume and popstate alike), closing the gap.
- **`ProConsensusCard` no longer conflates a genuine zero-pro-games result with a fetch failure.** Both used to collapse into the same silent "render nothing" state — indistinguishable from the outside, which is what made a live user report ("the Pro Consensus card just isn't there") impossible to triage from a screenshot alone. A real fetch failure now renders a small muted line ("Pro consensus data couldn't load — try refreshing") instead of nothing; a true N=0 (e.g. Viktor Support, essentially never played by pros) still renders nothing, unchanged.
- Investigation note: the originally-hypothesized repro (champion → PROS-mode toggle → player search → back) was tested exhaustively (local dev + live prod, throttled network, forward/back/reload combos) and never reproduced a missing card — that mechanism is ruled out. The two races above were found instead while probing the same suspect file (`BuildTabContent.tsx`) and are real, independently confirmed bugs in the same failure class (unguarded async state updates surviving a navigation change).

## [0.27.1] — 2026-07-13
### Fixed
- **Pro Consensus card refinements** (user feedback on a live Viktor Mid screenshot: Needlessly Large Rod — a component, not a finished item — was showing next to Blackfire Torch; the card only showed keystone + secondary tree NAME, no fraction/percentage anywhere).
  - **Every fraction on the card now shows a percentage** — "90% · 35/39" (percentage primary/bold, fraction muted), applied consistently to items, keystone, secondary tree, and spells (`components/hextech/proConsensus.ts`'s new `formatSharePct`).
  - **Items are now filtered to real finished builds.** New `isBuildItem` predicate (`proConsensus.ts`) excludes mid-build components using REAL ddragon recipe data (`into`/`from`/tags/purchasable, extended onto `ItemDetail` in `components/itemDetail.ts` — same fetch that already resolved item names/gold, no extra network cost): completed = purchasable + no further `into` upgrade, PLUS a boots-specific carve-out (the 2026 boot-mastery rework added a tier-2→tier-3 enchant step, so a tier-2 boot like Sorcerer's Shoes still has an `into` even though "stopped at tier 2" is a totally normal final build), PLUS an explicit starting-item allowlist (Doran's x3, Dark Seal, Tear of the Goddess, Cull, World Atlas, Guardian's Amulet/Shroud — Dark Seal and Tear of the Goddess are the two that actually need it, since both have a real `into` upgrade path; the rest are pinned defensively). Verified against a live 16.13.1 item.json pull: Needlessly Large Rod (1058, `into`: 6 core mage items) is excluded; Crimson Lucidity/Spellslinger's Shoes (tier-3 boot enchants) and Blackfire Torch/Rocketbelt (completed items) still show.
  - **New "Additional Runes" block** — aggregates the FULL rune picture, not just keystone + secondary tree name: top 3 primary-tree minors, top 2 secondary-tree picks, top 3 stat shards, each flat-frequency-ranked (not positionally slotted — Leaguepedia's prostage rune extraction doesn't reliably preserve row order, so claiming "row 1 pick" would overstate the data) with its OWN sample-size denominator (games whose payload actually carried that slot, never gamesTotal) and an honest sub-sample caption ("from 8 solo-queue games" when a slot — shards, structurally, since Leaguepedia never carries shard data — turns out to be soloq-only; a mixed "N games (X solo queue, Y pro play)" note otherwise). Renders via the same tap-for-detail popover wiring the rest of the card already uses (rune/shard EntityKind).

## [0.27.0] — 2026-07-13
### Added
- **New "Pro Consensus" card on the BUILD tab** (user request: "pro players seem to build Rocketbelt on Viktor — create another builds and runes space based on what pro players are often building"). Complements the WPA-ranked recommendation with a plain pick-rate count over the SAME champion-scoped pro-games feed PRO BUILDS already lists (`GET /api/pros?championId=&role=&source=all`, always `source=all` regardless of whatever filter the user has picked for the PRO BUILDS list below — a bigger, independent sample). New pure aggregation module (`components/hextech/proConsensus.ts`, `aggregateProConsensus`): top items by pick rate (deduplicated per game, consumables excluded via the existing `CONSUMABLE_ITEM_IDS` list, boots counted like any other item), top keystone + secondary tree (each with its OWN sample-size denominator — a prostage row can have one resolved without the other, per Leaguepedia's per-field Cargo resolution — so neither fraction silently borrows the other's sample), top summoner-spell pair (canonicalized so Flash-on-D and Flash-on-F count as the same combo). Verified live against Viktor Mid: **Hextech Rocketbelt is built in 35 of 39 recent pro games (90%)**, tied with Blackfire Torch — confirms the user's observation. Card (`components/hextech/ProConsensusCard.tsx`) reuses the tab's existing tap-for-detail popovers (`ItemDetailPopover`/`EntityDetailPopover`) rather than standing up a second popover instance; renders nothing for N=0 (e.g. Viktor Support, essentially never played by pros) and shows a low-sample caution line for N<3; sample-size footer states real fetched totals + source split + up to 3 named tournaments, nothing invented. Placed below SITUATIONAL, above the shared item/entity popover mount.
### Fixed
- **All 5 lanes now fit at 390px with no horizontal scroll** — the collapsed (mobile top-bar) LANES strip was `overflow-x-auto` with a 92px-min-width row, forcing ~492px of content into ~358px of available width, so Support scrolled off-screen. Switched to a fixed 5-column grid (`grid grid-cols-5`) sized to the actual viewport; the per-lane "you are viewing X here" champion-name subtitle (only ever shown on the active row) is dropped on the collapsed bar specifically — it was competing for the 5-column width budget for a fact the hero already states one scroll below — and kept on the desktop vertical list, which has room to spare.

## [0.26.0] — 2026-07-13
### Fixed
- **In-sheet player links from the home shell no longer escape to the legacy `/history` page.** Tapping a player in a game sheet's Teams box — from either PRO BUILDS' or the PROS-mode player view's sheet — previously always fell through to a stashed-selection + `router.push("/history")` fallback, because neither call site ever wired `GameDetailSheet`'s `onSelectPlayer` prop. The tap now closes the sheet and switches the home page's own main content to that player's Hextech view (the same view a PROS sidebar search pick lands on), pushing a history entry (an identity change, matching v0.23.0's back-nav policy). Handles both player kinds a Teams-box row can carry: **tracked** pros (`proId` → `/api/pros?proId=`, hero resolves real team/game-count in the background when not already known) and **link-only untracked** pros (`/api/pros?player=<player_link>`, prostage-only — the games filter locks to Pro Play with an explanatory label, mirroring `/history`'s own `ProHistoryResults` treatment, and the hero omits a game count entirely rather than guessing one). Back reopens the game sheet the tap came from (mirrors `/history`'s already-shipped cross-player-jump policy exactly — the simplest correct option, zero new back-nav branches).
- **Lane taps on the home page now change the LANE for the champion you're viewing, not the champion.** Previously each lane row carried its own most-played champion (Garen/Lee Sin/Ahri/Senna/Thresh-style), so tapping a different lane silently swapped to a different champion. Viewing Ahri and tapping Top now shows Ahri Top (different runes/items/hero-stats for that champ+lane pair, refetched via the existing champ+lane-keyed effects) — lanes are pure lane selectors for the current champion. A fresh champion pick (search or default) now lands on that champion's own most-played lane, derived cheaply (5 calls to the already-public `/api/hero-stats` route, reusing its `gamesCount` — the same keystone-occurrence-sum definition `lib/laneDefaults.ts`'s per-lane sweep uses) rather than a new backend endpoint; resolves in the background without blocking the pick, and a manual lane/champion/player action before it resolves wins outright. `lib/laneDefaults.ts` (most-played champion per lane) keeps its module — this fix removed its now-dead sidebar consumer, not the module itself. PRO BUILDS' existing `role=<selected lane>` filter (already the "use the lane's role" behavior) is unchanged, now documented as the deliberate, consistent choice.

## [0.25.0] — 2026-07-13
### Added
- **The Hextech BUILD tab shows the full recommended rune page, not just the keystone.** `RunesSummonersCard` previously showed only the keystone + secondary tree icon + 3 tiny shard dots — the pre-redesign Builds page's full rune page (primary tree's 3 minors, secondary tree's 2 picks, all named, with per-rune WPA and low-sample ⚠ markers) never got wired into the Hextech shell. Restored via a new pure `buildRunesPageModel` helper (`components/hextech/runesPage.ts`) that assembles it from the same `/api/build` `RunesBlock` payload the compact version already had — no backend change. Desktop keeps a compact 3-column layout (primary | secondary+shards | summoners) inside one card; 390px stacks cleanly to one column per section.
- **Every rune, shard, summoner spell, and item on the BUILD tab is now tap-for-detail** — the CommunityDragon-backed rune tooltips, hardcoded shard stat text, summoner cooldowns, and sanitized item gold/stats/passives (`components/runeDetail.ts` / `shardDetail.ts` / `summonerDetail.ts` / `itemDetail.ts`) all existed already from the pre-redesign Builds page but were never wired into the Hextech cards. `BuildTabContent.tsx` now owns the same activeDetail/lastDetail popover-state pattern `GameDetailSheet.tsx` uses, rendering `EntityDetailPopover` (rune/shard/spell) or the centered `ItemDetailPopover` (starting/core-build-order/situational items). Popovers are overlay state only — never history-backed, consistent with v0.23.0's back-nav policy.
- **New `useBodyScrollLock` hook** (`components/useBodyScrollLock.ts`), extracted from `GameDetailSheet.tsx`'s inline iOS-safe scroll-lock recipe (`position:fixed` pinned at the current offset, not `overflow:hidden` — the latter doesn't stop Safari's rubber-band scroll bleeding the page behind through an overlay). The BUILD tab's popovers have no enclosing sheet to inherit a lock from (unlike GameDetailSheet's own popovers, which sit over an already-locked sheet), so this tab locks scroll itself while a popover is mounted. **Gotcha caught during live verification**: an early version tied the lock to `lastDetail !== null` (the "which popover to keep rendering" flag) instead of a short-lived "currently mounted" flag — since `lastDetail` is deliberately never cleared back to null (so the popover can play its exit fade), that locked page scroll *permanently* after the very first tap. Fixed by tracking mount state separately, released 150ms after close (matching `DetailPopover`'s own exit-transition duration).

## [0.24.0] — 2026-07-13
### Added
- **The All/Solo Queue/Pro Play games filter is back on the Hextech home page** — the pre-redesign `/history` page had this SegmentedControl (still live there, `components/ProGamesSection.tsx`) but the Hextech shell dropped it. Restored on both PRO BUILDS (champion view) and the pro player view, reusing the exact `ProGameSource`/`SOURCE_FILTER_OPTIONS`/empty-state copy `/history` already has (`components/proGames.types.ts`) rather than forking a second copy. PRO BUILDS defaults to **Pro Play**, matching the Hextech spec mockup (`Design/redesign-2026-07/pro-builds-tab.png`) pixel-for-pixel on first load; the player view defaults to **All**, since a player's tracked history is mostly solo queue. Selecting a filter that yields zero games shows the same filter-aware empty-state copy `/history` uses ("No pro-play games tracked yet for Bwipo", etc.) instead of a generic message.
- **The filter is view sub-state, same policy as the BUILD/PRO BUILDS tab**: it survives back/forward within a view (carried in the `WireMainView` wire shape, `components/hextech/homeSearch.ts`) and resets to that view's own default the moment the champion or player identity actually changes (lane tap, champion search pick, or a new player pick) — flipping CHAMPIONS/PROS mode alone, or switching BUILD/PRO BUILDS tabs, leaves it untouched. A filter change while a game sheet is open just closes the sheet first (same documented trade-off as the tab-switch-while-sheet-open case, v0.23.0) rather than swapping the list underneath an open sheet.

## [0.23.0] — 2026-07-12
### Added
- **Back on the home page now walks your view trail** — champion → search a pro (player view) → back returns to the champion you were on; player view → open a game sheet → back closes the sheet (still the player view) → back again returns to the previous champion. Lane taps and champion search picks each get their own back-gesture step; the BUILD/PRO BUILDS tab does not (it's sub-state of a champion view, not a page of its own — switching tabs updates the current step in place instead of adding one). Same `useSheetBackNav` hook `/history` (v0.20.0) and the home PRO BUILDS sheet (v0.21.1) already use, now instantiated with the actual champion/player selection instead of nothing. A same-tab reload preserves whatever view you were on; a fresh tab/hard reload still lands on the default champion (no URL/query-param involvement — see app/page.tsx's design note for why a query-param design was evaluated and not used).
### Fixed
- **Switching tabs while a game sheet was open no longer strands a "ghost" back-stack entry** (previously documented as a known gap: `ProBuildsTab`/`BuildTabContent` unmount on a tab switch, silently orphaning the sheet's history entry, so one extra silent back-press was needed before the page would actually navigate). Tab switches now explicitly close an open sheet via a real back-navigation instead of leaving it behind. The same fix incidentally covers champion/lane/player changes made while a sheet was open, which had the identical gap.

## [0.22.0] — 2026-07-12
### Added
- **Search for a pro player, not just a champion**: the sidebar search now has a CHAMPIONS/PROS toggle (two small uppercase tabs sitting directly on top of the search field, same underline vocabulary as the BUILD/PRO BUILDS tabs). PROS mode searches tracked pros via the same typeahead `/history` uses; picking one swaps the whole main content to a player view — a hero (gold serif name, team, total fresh-game count — no invented imagery, since there's no headshot data anywhere in this app) followed by their recent games across every champion they've played, using the same row/sheet components PRO BUILDS already uses. Opening a game's detail sheet integrates with the same back-gesture history hook, so a back-swipe closes it here too. Switching modes never loses your champion pick — tapping a lane while browsing a player's games exits back to CHAMPIONS for that lane, same as picking a champion from search.
- **Rows now show their own champion** when they can vary game-to-game (`ProBuildRow`'s new `showOwnChampion` prop, opt-in — PRO BUILDS' fixed-champion rows are unaffected): the player view's games span many champions, so each row now carries a small icon + name for the champion actually played, not just the opponent.

## [0.21.1] — 2026-07-12
### Fixed
- **PRO BUILDS rows no longer overflow sideways on mobile** — the Hextech redesign's row kept its desktop horizontal layout at 390px (content ~530px wide inside a 356px card), pushing the whole page into horizontal scroll and clipping KDA, the 4 item icons, and league+date off-screen. The row now reflows into two stacked lines at `<=sm` (badge/identity/KDA, then vs/items/league+date) — every datum stays visible, nothing drops behind a `hidden sm:block` anymore. The BUILD tab was already clean and is unchanged.
- **Opening a game sheet from the home PRO BUILDS tab now integrates with browser/iOS back-gesture**, same as the Pro's page (`/history`, v0.20.0) — previously it pushed no history entry, so a back-swipe navigated away from the app instead of closing the sheet. The pushState/popstate machinery /history originally hand-rolled is now a shared hook (`components/useSheetBackNav.ts`); both pages consume the identical contract instead of a second hand-rolled copy.

## [0.20.2] — 2026-07-12
### Fixed
- **New champions no longer show as a grey "Champion #id" tile the moment they ship** — coachless's static champion bundle is pinned to its own data patch and can lag ddragon by a patch (verified live: Locke, id 805, shipped 16.13.1, missing from coachless's 172-champion 16.12.1 bundle; Bwipo's Locke games rendered blank comp-strip tiles and no portrait on Locke's own card). `getAllChampions`/`getChampionById` (`lib/staticData.ts`, backing `GET /api/champions`) now gap-fill any id missing from coachless with ddragon's own latest champion.json (name + an absolute ddragon icon URL) — coachless stays primary/authoritative for every id it already has, and any ddragon failure degrades to exactly today's behavior (no crash, fallback tile).

## [0.20.1] — 2026-07-11
### Fixed
- **Game cards on the Pro's list are visibly distinct now** — each card gets a brighter surface + clearer border than the page bg (scoped to the game list; other glass surfaces unchanged), a bigger gap between cards, and a win/loss accent edge (green/red, matching the WIN/LOSS pill) so results scan at a glance without reading every card.
- **Fixed a real bug**, not just a tweak: the ally/enemy comp strip at the bottom of each card had an unintentional 60%-opacity white divider (a Tailwind opacity-modifier-on-an-rgba-token gotcha) — ~7.5x brighter than the 8% hairline it was meant to be — which made the strip read as a bolted-on, disconnected element rather than the bottom of the same card. Now a matching faint hairline, so the whole card reads as one unit.

## [0.20.0] — 2026-07-11
### Added
- **Back returns to where you were**: the Pro's page now integrates with browser history — jump from a game sheet to another player's games, swipe back, and you land on the sheet you came from; back again walks to the previous view. Closing a sheet with ✕ never leaves ghost entries.
- **Every player in the Teams boxes is clickable** — including pros not in the tracked roster (their pro-play games load via their Leaguepedia identity; the view locks to Pro Play since they have no tracked solo queue).

## [0.19.0] — 2026-07-11
### Changed
Performance release, driven by a measured audit (the Builds page measured excellent and was untouched):
- **Images lazy-load** across the Pro's page — selecting a player no longer decodes 400+ icons at once (initial requests 414 → 117); all icons carry explicit dimensions so layout never waits on them.
- **Game list payload cut ~53%**: per-player team builds now load on demand when a game's detail sheet opens (new team-players endpoint, day-long cache), instead of shipping with every list.
- **Icons cache on-device**: the icon CDN sends no cache headers, so the service worker now serves repeat visits from a local cache (measured 364ms → 2.4ms per icon).
- Combined-sources game queries overlap their database round-trips (faster first view).

## [0.18.1] — 2026-07-11
### Fixed
- Sheet/card header identity line no longer shows the raw team suffix ("Saint — LYON", not "Saint — LYON (2024 American Team)") — the last uncleaned team field.

## [0.18.0] — 2026-07-11
### Added
- **Tap a player in the Teams boxes to jump to their games** — any tracked pro in either team is a link (name underlined with a chevron); works from the Pro's page and cross-page.
- **Pro-play matchup on top**: "LYON vs HLE"-style line in the game sheet header and on the game cards before the tournament name.
### Fixed
- **Data audit round**: 213 pro-play rows had silently-broken links to their tracked pros (Leaguepedia writes "Zeka (Kim Geon-woo)", roster says "Zeka") — matching fixed at ingest + repaired live. Keystone naming verified correct across tournaments (including Deathfire Touch, a valid 2026 Sorcery keystone).
- **In-game names only**: player names no longer show real-name parentheticals; team names no longer show wiki disambiguation suffixes ("LYON", not "LYON (2024 American Team)").

## [0.17.0] — 2026-07-11
### Added
- **Teams section redesigned, matchday-style**: each team sits in its own highlighted panel (WIN/LOSS chip in the header) with five per-player rows — champion, role, player name, and their full final build as tappable item icons with the usual info cards. Solo-queue games backfilled with per-player data (1,131 games); pro-play games derive it from the tracked rows. Games without the data keep the compact strip.

## [0.16.0] — 2026-07-11
### Added
- **Favorite champions**: star a champion from the search results on the Pro's page — starred champions appear as chips (with icons) under the search box for one-tap reuse. Same on-device storage and 12-champ cap as player favorites, fully independent of them.

## [0.15.1] — 2026-07-11
### Fixed
- **Pro Play intermittently showing "No pro-play games tracked yet" despite tracked games** (P0, prod-only). Root cause: on Vercel, the Neon HTTP driver's query POSTs went through Next.js's patched, Data-Cache-aware `fetch`; a `{rows:[]}` response cached while `prostage_matches` was still being backfilled kept being replayed — keyed on the exact query bytes + params, persisting across deployments — while byte-different variants of the same query (e.g. a different `limit`) returned live rows. The Neon client now opts every driver call out of the fetch data cache (`fetchOptions: { cache: "no-store" }`, lib/pro/db.ts).
- **Empty `/api/pros` responses are no longer CDN-cached**: previously an empty (or degraded-to-empty) result was pinned by `s-maxage=1800` for 30-60 min per URL, amplifying any upstream glitch into a user-visible outage. Empty responses are now `no-store`; only non-empty responses keep the long cache.

## [0.15.0] — 2026-07-11
### Changed
- **Team comps are role-ordered**: both strips read Top → Jungle → Mid → Bot → Support, so a mid-laner's champion sits in the middle slot (all 1,134 solo-queue games re-backfilled; pro-play ordered from tracked roles; falls back to source order when a side's roles don't cleanly resolve). Sheet roster rows carry positional hints.
- **Item build order redesigned** to matchday's density: 28px icons, minute labels tight to their items, no per-group card chrome — roughly a third of the previous height, same tappable items with named labels and consumables toggle.

## [0.14.1] — 2026-07-11
### Fixed
All four findings from the 18/20 anchored review (path to 20):
- Rune-tooltip cache now self-refreshes (10-day TTL) — returning users can't keep stale rune numbers across patch rebalances.
- Item buttons announce real item names to screen readers ("Rabadon's Deathcap", not "item #3152") across final build and build order.
- Modern `mobile-web-app-capable` meta emitted (console deprecation warning gone); search inputs carry stable id/name for autofill association.
- Removed the dead "pending" retry branch from the pro-play timeline client (server never returns it) — state machine simplified to loading/ok/unavailable/error.

## [0.14.0] — 2026-07-11
### Added
- **Ally + enemy team comps on every game** (dpm.lol-style): tiny 5v5 champion icon strips on game cards (your pro's champ highlighted) and a Teams section in the game detail view. Pro-play games have comps immediately; solo-queue games fill in as the backfill completes.
### Changed
- **Rune info cards now show real numbers** — descriptions come from the in-client tooltip data (e.g. Second Wind: "heal for 4% of your missing health over 10s") instead of Riot's placeholder-stripped public text. Item cards verified across all 706 items: every armor/MR stat line already renders.

## [0.13.0] — 2026-07-10
### Added
- **Runes, stat shards, and summoner spells are now tappable** in the game-detail view — same centered info card as items, with names and descriptions.
### Fixed
- **Skill-order grid readability**: filled cells were near-invisible (1.07:1 contrast) — now a teal-tinted chip measured at 7.9:1, with the R row still distinct.
- **Stormraider's Surge keystone rendered as an empty circle** (its icon path 403s on the CDN; special-cased like Deathfire Touch). Any icon that fails to load now shows a lettered placeholder instead of vanishing — everywhere (cards, sheet, Builds page).
- **LCK "Road to MSI" pro-play games couldn't resolve their item timelines** — resolver now finds them on lolesports' schedule.
- Accessibility round (from an adversarial audit): dialogs now trap Tab, the item card returns focus where you were on close, background can't scroll behind the sheet on iOS, picker aria states corrected.

## [0.12.0] — 2026-07-10
### Added
- **Pro-play games now show the in-game item build order** (matchday-style): reconstructed from the official lolesports broadcast feed by walking the game's frames, matched to each player by champion. Computed once per game on first view (a few seconds), then served instantly from the database. Items in the timeline are tappable like everywhere else. Skill order remains unavailable for on-stage games (the feed carries no ability-level data).
### Changed
- **Item detail card now opens centered on screen** (was bottom-anchored on mobile), matchday-style, on all viewports.

## [0.11.0] — 2026-07-10
### Added
- **Tap an item for details**: every item in the game-detail view (final build + build order) opens a mini-sheet with the item's name, gold cost, and stats/passive description, version-matched to the game's patch.
### Changed
- **Item build order wraps into rows** — no more sideways scrolling; each minute group is a self-contained card.
- **Skill order is a per-ability grid**: Q/W/E/R each on their own row across 18 level columns, R row highlighted — fits phone width with no scrolling.

## [0.10.0] — 2026-07-10
### Added
- **Favorite players**: star a player from search results or after selecting them — favorites appear as chips under the search box for one-tap reuse (stored on-device, newest first, up to 12).
- **Game detail view**: tap any game card for a full breakdown — runes with names (keystone prominent), summoner spells, final build, item build order as a minute-by-minute timeline, and a per-level 1–18 skill order. Full-screen on mobile, modal on desktop. Pro-play games show what on-stage data allows, with a note.
### Changed
- The inline "Details" expander on game cards is gone — the whole card opens the detail view.
- Player search no longer shows a "type at least 2 characters" hint while typing.

## [0.9.0] — 2026-07-10
### Removed
- **CoachBuild Score removed** (user preference): the per-game 0-100 score, S–D grade chip, and CS/min + KP micro-stats are gone from the Pro's page and the /api/pros response. The underlying stats columns and ingest stay (data keeps accumulating, nothing shown).
### Changed
- **Pickers are direct-type**: the player and champion search fields are now real inputs — tap, keyboard opens, type, results appear. No more second box opening to type into.
- "Pro History" renamed to **"Pro's"** (tab + page heading).

## [0.8.0] — 2026-07-10
### Added
- **CoachBuild Score**: every solo-queue pro game now carries a 0-100 performance score and S/A/B/C/D grade (blended KDA curve + CS/min pace + kill participation + win bonus — formula documented in `lib/pro/score.ts`). Rendered as a color-graded chip in the Pro History game row; CS/min and KP micro-stats in the expandable panel. All 1134 historical games backfilled with the stats the formula needs (migration 0004: cs, damage to champions, team kills, gold). Pro-play (on-stage) games deliberately show no score — Leaguepedia data can't feed the full formula, and a degraded score next to a full one read as a real performance gap.
### Changed
- **dpm.lol-inspired reskin**: warm charcoal base, glassy translucent cards, cyan/lavender accents, Plus Jakarta Sans, WPA count-up motion (respects reduced-motion), and a denser single-line Pro History game row (full runes moved into the expandable panel). Focus rings on all pills/buttons; AA+ contrast throughout.

## [0.7.8] — 2026-07-10
### Changed
- **Builds and pro games are now fully separate** (user request): the Pro Games section no longer renders inline on the Builds page — pro history lives only in the Pro History tab. Home page loads 100 kB lighter.
### Added
- KR mains for 9 pros (Chovy, Zeus, Canyon, Gumayusi, Kanavi, Keria, Kiin, Oner, Peyz) via Leaguepedia SoloqueueIds, each validated through Riot account-v1 — +129 current KR solo-queue games.

## [0.7.7] — 2026-07-10
### Fixed
- **Pro-play extraction handles CargoExport response shapes**: list fields (Items, SummonerSpells) arrive as JSON arrays and K/D/A as JSON numbers via CargoExport (api.php serves delimited/numeric strings) — extraction now accepts both.
- **Tournament resolver false positives**: league codes are prefix-anchored ("LCK/…"), so LPLOL and "Schneider Electric …" no longer match LPL/LEC; MSI 2026 recognized by its real page name "2026 Mid-Season Invitational".
- `--via-export` retries once (~10s) on a transient Cloudflare challenge.

## [0.7.6] — 2026-07-10
### Added
- **CargoExport ingest transport** (`scripts/ingest-prostage.mjs --via-export`): Leaguepedia's api.php cargoquery anonymous rate limit proved unusably aggressive (trips after ~1 call, sticky, escalating — from every IP tried). `Special:CargoExport` serves the same Cargo queries rate-limit-free; the local backfill now queries it through a curl subprocess transport (Node's TLS fingerprint gets Cloudflare-challenged; curl's mostly doesn't). The prod route/cron keeps the api.php path.

## [0.7.5] — 2026-07-10
### Fixed
- **Pro-play tournament resolver no longer selects unplayed tournaments.** The 90-day window matched future events (next Worlds, unstarted playoffs), which filled all 7 ingest slots ahead of tournaments with real scoreboard data (MSI, LEC Summer, LPL) — the pro-play table stayed empty since v0.7.0. Resolver now requires DateStart <= today and excludes Academy pages (they match tier-1 name patterns but carry no scoreboard rows).

## [0.7.4] — 2026-07-10
### Fixed
- Champion display names on pro-game cards (Wukong, not Riot's internal MonkeyKing).
### Added
- SoloQ account riot ID shown small on each game card (pros have several accounts — now you can tell which one played).
- Bin (BLG) tracked via his active KR account — 20 current games with full build order.

## [0.7.3] — 2026-07-10
### Changed
- **Accounts now follow the player's pro-team region** (T1/LCK → KR, G2/LEC → EUW, etc. — curated tier-1 team map; unmapped/ex-pro teams keep all accounts). Off-region bootcamp smurfs no longer feed match history.
- Faker tracked via his real KR main (Hide on bush#KR1) — 20 current games. Bwipo (ex-pro) added with all accounts.

## [0.7.2] — 2026-07-10
### Fixed
- **Freshness window (90 days)** on all pro-game queries, player game counts, and match ingest (Riot startTime filter). Stale bootcamp history (e.g. Faker's Oct-2024 Worlds EUW games) no longer serves as "recent" — builds are patch-relative and months-old games are misleading.
- New scripts/ingest-player.mjs <name> — targeted on-demand fill for one player (jumps the backfill queue).

## [0.7.1] — 2026-07-09
### Fixed
- Pro-play ingest MWException: `Patch` is not a column on Leaguepedia's `ScoreboardPlayers` (verified against the table's CargoDeclare schema) — removed from the query; pro-stage `patch` is now always null (icon URLs fall back to a pinned version).

## [0.7.0] — 2026-07-09
### Added
- **Official pro-play (on-stage) games** via Leaguepedia (CC BY-SA, attributed): final build, runes, spells, result per player per game, in a new `coachbuild.prostage_matches` table with name→id resolution through ddragon. No purchase/skill order — that data does not exist in any free source for stage games.
- **Source filter** "All | Solo Queue | Pro Play" on the home Pro Games section and both History modes. Pro-play cards: gold badge, tournament name, no timeline panel.
- **Cross-region roster seeding** (`scripts/seed-crossregion.mjs`): ~40 famous non-EUW pros via lolpros profiles (Faker, Chovy, Zeus... searchable now via their EUW bootcamp accounts; KR mains pending a Leaguepedia retry).
- Guarded `/api/ingest/prostage` + staleness-rotated daily cron (stalest tournament first, so all leagues cycle).
### Fixed
- Null-role pro-stage rows stay visible (lane label omitted) instead of silently vanishing — guards against Leaguepedia Role-vocabulary drift.
- Rune/spell row hidden on cards with no rune/spell data (no empty rings).
### Known
- Pro-play table ships empty: Leaguepedia rate limiting + an MWException on the ScoreboardPlayers query blocked the first ingest; query fix + retry queued. UI degrades to a friendly empty state.

## [0.6.0] — 2026-07-09
### Added
- **Pro History tab** (`/history`) — search by pro player name or champion name; games are shown only after a selection. Player mode: debounced typeahead over tracked pros (team, lane, game count). Champion mode: the familiar champion picker + optional lane filter. Player-mode cards show the champion icon + name.
- Tab navigation (Builds | Pro History) on both pages.
- `GET /api/players?q=` — player typeahead search (wildcard-escaped, game counts included).
- `GET /api/pros?proId=` — all recent games by one player (role optional; exactly one of proId/championId required).
### Fixed
- Champion-icon slot no longer renders as an empty circle on cards without a resolved icon.
- Player search: selecting a result now invalidates in-flight searches (stale-list race).

## [0.5.0] — 2026-07-09
### Added
- **Pro Games section** — recent solo-queue games by tracked pro players for the selected champion (+lane when a concrete lane is picked; the default "auto" view shows all lanes with a per-card lane label). Each card: player/team, region, result, KDA, patch, game length, final items + trinket, full rune page (keystone, minors, shards), summoner spells, and an expandable detail with the undo-adjusted item purchase timeline and skill order.
- **Pro data pipeline** (personal-use scale): roster from lolpros.gg (accounts, smurf/rename history, PUUID with riot-id fallback resolution), matches from Riot match-v5 + timeline (rate-paced, idempotent upserts), stored in a dedicated `coachbuild` Postgres schema. Guarded `/api/ingest/*` routes + local runner scripts; daily Vercel cron.
- `GET /api/pros` — champion(+lane) query over ingested pro games; role 5 = all lanes.
### Notes
- Requires `DATABASE_URL`, `RIOT_API_KEY`, `CRON_SECRET` env vars for live data; the app degrades to a friendly empty state without them.

## [0.4.1] — 2026-07-06
### Fixed
- **Icon versions now track the data patch.** Rune/item/champion/spell icon URLs derive from the dynamically-resolved patch (CDN evidence-checked: icons exist for all recent patches, including ones without stats data yet) with a static floor fallback. The hardcoded `RUNE_VER`/`ASSET_VER` pins are gone, so icons can no longer age behind the self-advancing data patch.
- **Patch probe hardened**: 4s timeout per candidate (a hung upstream socket can't stall the first cold request) and a single-flight guard (concurrent cold requests share one probe walk).
- "Most played" label threshold aligned with the visual red cutoff (only shows next to numbers that actually render red); a parametrized test pins the two thresholds together.

## [0.4.0] — 2026-07-06
Review-driven release (2026-07-06 audit: 15.5/20; all findings fixed).
### Fixed
- **Data patch no longer frozen.** `getLatestPatch()` was a hardcoded 16.11 literal; it now probes ddragon's newest versions against coachless and picks the newest one with populated data (16.12 today), cached 6h with last-known-good and a 16.11 static floor as fallbacks. The app self-advances every patch from now on.
- **Recovered `app/api/build/route.ts` into version control.** The `.gitignore` rule `build/` had silently swallowed the route directory — the file serving the entire app was never committed and was missing from this checkout (recovered from the Vercel deployment; rule scoped to `/build/`). Restores the 7 route tests that could not run.
### Added
- **Low-sample caution surfaced.** Item alternatives and rune tiles now show sample counts and a quiet ⚠ on low-sample picks (the `lowSample` flag was computed but never rendered — a 1K-sample alt no longer masquerades as 10x better than a 117K-sample pick).
- **"Most played" label** on headline keystones with negative WPA, explaining the red number on the top pick (most-adopted-keystone ranking is intentional).
### Removed
- Dead `<StatBadge>` component (helpers extracted; glyph now rendered inline).

## [0.3.2] — 2026-06-14
### Added
- Full keyboard navigation + ARIA combobox semantics in the champion picker (Up/Down/Home/End to move, Enter to select, opens at the current pick, `aria-activedescendant`).
- Route-level tests for /api/build status mapping (404 for not-played/empty, 400 for bad params, 500 with no detail leak) — closes the integration-test gap that let the earlier bugs ship. 19 tests total.
### Removed
- Dead `getSecondaryTreePlaycount` export (the engine computes its own secondary ranking).

## [0.3.1] — 2026-06-14
### Fixed (full bug sweep — 3 cold-start audits + 108-combo convergence sweep)
- **Off-role / unknown-champ queries now return 404, not 500** (recommend.ts threw plain `Error` at 3 sites; now `NotPlayedInRoleError`). 0 crashes across 108 champ/role combos.
- **EmptyState now actually shows** for not-played combos instead of a misleading Viktor sample under a wrong heading. The header always reflects the selected champion + role (page.tsx).
- **No more duplicate "Flash, Flash" spells** — distinct-spell selection (`pickSpells`), fills Ignite when only Flash is adopted. Regression tests added.
- **Keystone picks the best-WPA option among adopted** within a tree (Thresh now Guardian over Aftershock), while trees still rank by adoption (no off-meta primary).
- Role label / pill no longer desync on "Auto" (role 5); strict API param validation (rejects `2x`/`86.5`); 500s no longer leak internal error text.
- **Service worker is now network-first for the app shell** (a redeploy serves fresh HTML even without a version bump) and only caches `res.ok` responses.
- Picker closes on Escape; collision-safe React keys; footer text meets AA contrast.

## [0.3.0] — 2026-06-14
### Added
- **Per-slot item alternatives** — each item slot now shows situational swaps (an "or" row), e.g. Plated Steelcaps vs AD, Mercury's vs MR. There is one dominant core path per champ (verified against the data), with viable per-slot options rather than 3 separate item builds.
- **PWA**: installable with a web manifest, icons, theme colour, and a service worker whose cache is tied to the app version.
### Fixed
- Version number now actually renders in the footer (was reading the wrong env var). Single source = package.json, inlined as `NEXT_PUBLIC_APP_VERSION`.
- SW cache name is `coachbuild-v<version>`; bumping the version rotates the cache and evicts stale ones, so installed PWAs never serve an old UI.

## [0.2.0] — 2026-06-14
### Changed
- **Every primary tree is now evaluated**, not just the most-played keystone. Variants can differ in primary tree + keystone + primary runes (e.g. Graves: Dark Harvest vs Fleet Footwork; Yasuo: Lethal Tempo vs Grasp). Variants prefer different primary trees, falling back to secondary variation when one primary dominates (e.g. Viktor stays Sorcery, varies secondary).
- Variant subtitles now show the full rune identity ("Sorcery + Precision").

## [0.1.0] — 2026-06-14
### Added
- Champion + lane rune/item recommender powered by coachless.gg's WPA API (Next.js 14 + TS + Tailwind, serverless proxy).
- **Top-3 setups** per champion + lane (one per best secondary tree), ranked by confidence-weighted WPA.
- **All-trees** rune evaluation: compares every secondary tree, not just the default pairing.
- Confidence-weighted ranking: headline pick = most-played positive (reliable); alternatives = best-WPA above a noise floor; viability filter drops weak trees.
- Role coverage Top/Jungle/Mid/Bot/Support, with support-item slot handling.
- Modern coachless-style UI: rune pages, shards, item path, summoner spells, WPA + win rate + sample per pick.
