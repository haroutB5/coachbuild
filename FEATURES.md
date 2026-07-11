# CoachBuild — features (current state, v0.16.0)

Personal League of Legends coaching companion. Two tabs, `Builds` and `Pro's`, sharing one nav (`components/TabNav.tsx`). No accounts, no ads, no tracking — everything runs client-side against public/free data plus a small personal Postgres store.

## Builds (`/`)

Pick a champion and a lane, get a ranked recommendation of the strongest runes, item path, and summoner spells for that combo — sourced from coachless.gg's deep-learning WPA (Win Probability Added) stats.

- **Champion + lane picker.** `ChampionPicker` is a full keyboard-navigable ARIA combobox (Up/Down/Home/End, Enter to select, opens on the current pick). Lane defaults to "Auto" (all lanes) on a fresh champion pick; `RoleSelector` covers Top/Jungle/Mid/Bot/Support. Landing default is Viktor Mid, so the page shows real data immediately rather than an inert empty state.
- **Top-3 setups per champion + lane.** Not just the single most-popular pairing — every primary rune tree AND every secondary tree is evaluated, and the app returns up to 3 confidence-weighted variants, preferring different primary trees across variants (falling back to secondary-tree variation when one primary genuinely dominates, e.g. Viktor stays Sorcery but varies its secondary).
- **Confidence-weighted ranking.** The headline pick in each slot (rune, item, spell) is the most-played choice that clears a global adoption bar (5% of the champion's total games in that role, floor 500 games) — the "reliable" pick, not just whatever has the flashiest WPA on a tiny sample. Alternatives surface the best-WPA options above a separate, lower noise floor.
- **Per-slot item alternatives.** Each item slot (boots, first/second/third legendary) shows situational "or" swaps — e.g. Plated Steelcaps vs. Mercury's Treads — rather than three fully separate parallel builds. One dominant core path, viable per-slot options around it.
- **Low-sample caution.** Any pick below the adoption/noise bar for its slot is flagged with a quiet warning glyph and its actual sample count shown, so a low-sample alt never reads as flatly "better" than a well-established pick just because its WPA number is higher.
- **"Most played" label.** Surfaces next to a headline keystone whose WPA is negative — explains to the user why the top pick shows a red number (adoption-based ranking is intentional; it isn't a bug).
- **Full rune page, shards, spells.** Keystone + primary tree runes, secondary tree + 2 runes, all 3 stat shards (offense/flex/defense), and up to 2 distinct summoner spells (Smite excluded outside jungle; Flash/Ignite fallback fill if only one spell is adopted).
- **Dynamic patch.** The app never hardcodes a data patch — it probes ddragon's newest versions against coachless and walks backward until it finds one with populated data (coachless typically lags live release by a patch or two), caches that result 6 hours, and falls back to a static known-good patch if every probe fails. Icon/asset URLs are derived from that same resolved patch, so icons can't visibly drift behind the data.
- **Graceful degradation.** A champion/lane combo with insufficient data shows a friendly empty state (never a broken layout); a genuine fetch/server error shows a distinct "couldn't load, try again" state. Neither ever falls back to silently showing unrelated sample data.
- **PWA.** Installable (manifest, icons, theme color), service worker cache tied to the app version — a version bump rotates the cache so an installed copy never serves stale UI.

## Pro's (`/history`)

Search a tracked pro player or a champion and see recent games — solo queue and official pro-play, unified into one feed.

- **Direct-type search, two modes.** A segmented Player/Champion toggle. Player mode: a real text input with debounced typeahead over tracked pros (shows team, lane, game count per result). Champion mode: the same champion picker as the Builds page, plus an optional lane filter (`LanePillRow`).
- **Favorites, independent for players and champions.** Star a player from search results, or a champion from the champion picker — each appears as a chip (with icon, for champions) under its respective search box for one-tap reuse. Two fully separate on-device stores, 12-item cap each, newest-starred first.
- **Source filter.** "All / Solo Queue / Pro Play" toggle over the results, so a search can be scoped to just ranked games or just official broadcast games.
- **Game cards.** Player/team, region, win/loss, KDA, patch, game length (solo queue only — see below), a 5v5 ally + enemy champion-icon strip **role-ordered** Top→Jungle→Mid→Bot→Support so a mid-laner's pick always lands in the middle slot (dpm.lol-style — the searched player's own champion is highlighted within the row), and a rune/spell summary row. Tap any card to open the full game detail.
- **Game detail sheet.** Full-screen on mobile, centered modal on desktop (with a proper focus trap, Escape-to-close, and scroll-locked background that doesn't bleed through on iOS). Contents:
  - Ally + enemy team comps (same role-ordered strip as the card, larger).
  - Named runes with icons — keystone prominent, full primary + secondary trees, stat shards — every rune tappable to open a centered info card showing its real, current-patch numeric description (not Riot's placeholder-stripped public tooltip text — e.g. "heal for 4% of missing health over 10s" rather than a templated stub).
  - Summoner spells, tappable the same way.
  - Final build (6 items + trinket), every item tappable for name/cost/stat-line detail, version-matched to the game's own patch.
  - **Item build order**, matchday-density (28px icons, minute labels tight to their items, no per-group card chrome): minute-grouped, wrapping (never horizontal-scrolling), with a "hide consumables" toggle. Available for solo-queue games directly from the match timeline, and for pro-play games via a build reconstructed from the official broadcast's live-stats feed (computed once per game on first view — a few seconds — then served instantly from the database on every later view).
  - **Skill order**, solo queue only: a per-ability Q/W/E/R × 18-level grid (R row visually distinct). Not available for pro-play games — the broadcast feed carries no ability-level data (an explicit note says so rather than showing a blank/broken grid).
  - Every tappable entity (item/rune/shard/spell) announces its real name to screen readers, not an internal id.
- **Accessibility.** Dialogs trap Tab; closing an info card or the sheet itself returns focus to whatever opened it; the skill-order grid's filled cells meet AA+ contrast (a teal-tinted chip, not the near-invisible fill an earlier version shipped with); reduced-motion is respected throughout.

## Freshness model

Every pro game (solo queue and pro-play alike) is filtered to a rolling **90-day window** — patch-relative builds go stale fast, and a months-old bootcamp game is actively misleading as inspiration rather than merely outdated. This applies at query time (both `/api/pros` and `/api/players`' game counts) AND at ingest time (Riot's `startTime` filter skips fetching old games at all). Two daily Vercel crons keep the store current: solo-queue match ingest at 06:00 UTC, pro-play ingest at 07:00 UTC (one tournament per invocation, rotating so every tracked league gets refreshed rather than the same one winning every day). A targeted on-demand script exists to jump one specific player to the front of the backfill queue outside the daily cadence.

## Data attribution

- Build recommendations, WPA stats, and CDN icon/asset hosting: **coachless.gg**.
- Solo-queue match data: **Riot Games match-v5 API**, roster/account discovery via **lolpros.gg**.
- Pro-play (official esports) match data: **Leaguepedia** (lol.fandom.com), licensed CC BY-SA — attributed in both pages' footers.
- Pro-play item build reconstruction: **lolesports' public livestats feed**.
- Rune tooltip numeric descriptions: **CommunityDragon**.

Both pages' footers carry the "not endorsed by Riot Games" + attribution lines; this is a personal, non-commercial project.

## What shipped, by release (0.1.0 → 0.16.0)

The features above are the CURRENT state; this is the shipping order for context, not a substitute for `CHANGELOG.md`.

0.1.0 stood up the Builds page (top-3 setups, all-trees evaluation, confidence-weighted ranking). 0.2.0–0.3.2 refined variant selection, added full keyboard nav + route-level tests, and closed a bug sweep (off-role 404s, duplicate spells, keystone selection, network-first SW). 0.4.0–0.4.1 made the data patch self-advancing instead of a hardcoded literal and recovered a route that had been silently gitignored out of version control. 0.5.0–0.7.8 built the entire Pro History pipeline from scratch: solo-queue ingest (roster → matches → timeline), the Pro History tab, then official pro-play games via Leaguepedia Cargo (with the rate-limit/query-shape lessons in `CLAUDE.md`'s gotchas), source filtering, cross-region roster seeding, and freshness windowing. 0.8.0 added and then 0.9.0 removed "CoachBuild Score" (a per-game 0-100 grade) per user preference, along with a dpm.lol-inspired visual reskin and direct-type pickers. 0.10.0–0.13.0 built out the full game-detail experience: favorites, the detail sheet itself (runes/spells/build/skill-order/timeline), tap-to-detail item/rune/shard/spell popovers, and an accessibility pass (focus traps, contrast fixes, icon-fallback rendering). 0.14.0–0.14.1 added team comps (ally/enemy strips) and real-number rune tooltips via CommunityDragon, then closed out a 4-item review-driven punch list. 0.15.0 role-ordered every team-comp strip and redesigned the item-build-order layout for density. 0.15.1 fixed the Neon-driver/Next-fetch-cache P0 described in `CLAUDE.md`. 0.16.0 added favorite champions alongside the existing favorite players.
