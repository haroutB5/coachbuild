# Changelog

All notable changes to CoachBuild are documented here.

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
