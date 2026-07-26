# CoachBuild — features (current state, v0.58.0, 2026-07-26)

Personal League of Legends coaching companion. Six surfaces — **Builds, Draft, Companion, My Stats, Patch Movers, Pro Players** — under one global navy/gold shell (branded left rail on desktop, bottom tab bar on mobile). No accounts, no ads, no tracking — runs against public/free data plus a small personal Postgres store and one linked personal Riot account.

**Honesty posture (a deliberate feature, not a disclaimer):** every surface labels its data as MEASURED, CURATED, or JUDGMENT — real data speaks for itself; a curated stand-in (no upstream endpoint exists) says so; a judgment call (an editorial threshold, a fallback heuristic) never dresses up as a measured stat. Concretely: patch notes absent for a patch show "—", never an invented note; a Draft takeaway chip without a specific measured claim reads a generic "High ban priority" rather than fabricating a mechanic; an item-set line carries a THREE-state evidence label describing its own contents — bare title when genuinely measured, "(low data)" on thin evidence, "(suggested)" when the line is entirely judgment fill — and a block title never claims an ordering it does not keep (v0.57.0/v0.58.0); My Stats data never touches a recommendation score, however tempting a stat comparison might be.

## Global navigation

Every route shares one champion search (top bar) and one nav. Desktop (`≥lg`): a left rail with two groups — **PLAY** (Builds, Draft, Companion) and **DATA** (Pro Players, Patch Movers, My Stats) — plus a live companion status card (5 real states: unpaired, paired-no-client, client-detected, in champ-select, in-game — never shows "connected" unless it genuinely is) and a `PATCH n · vX.Y.Z` footer. Mobile (`<lg`): a fixed bottom bar with exactly 4 destinations (Builds, Pro Players, Patch Movers, My Stats) — Companion and Draft are desktop-only by design. A gold "APPLY RUNES" button and a live champ-select chip ("CHAMP SELECT — PICKING <champion>") sit in the top bar whenever a companion session is paired.

## Builds (`/`)

Pick a champion, get a ranked recommendation of the strongest runes, item path, and summoner spells — sourced from coachless.gg's deep-learning WPA (Win Probability Added) stats.

- **Champion search + lane/elo tabs, unified.** Champion search lives in the global top bar. Lane tabs (Top/Jungle/Mid/Bot/Support) and rank-bracket/elo tabs (High Elo/Diamond/Emerald/Platinum) sit inside the champion hero card. A HIGH/MEDIUM/LOW CONFIDENCE chip bands the recommendation by sample size.
- **Top-3 setups per champion + lane.** Every primary rune tree AND every secondary tree is evaluated; the app returns up to 3 confidence-weighted variants, preferring different primary trees across variants.
- **Confidence-weighted ranking.** The headline pick in each slot is the most-played choice clearing a global adoption bar (5% of the champion's games in that role, floor 500 games) — the "reliable" pick, not just the flashiest WPA on a tiny sample. Low-sample alternatives are flagged with their real sample count rather than reading as flatly "better."
- **Full rune page, shards, spells.** Keystone + primary tree, secondary tree + 2 runes, all 3 stat shards, up to 2 summoner spells.
- **Core build order + Buy order.** The reliable item path, plus (when it differs) a conditional "if you build X then Y then Z" sequence re-derived with each pick conditioned on already owning the prior one(s). **Both respect real game-slot limits:** every non-bot lane shows at most 5 full items + boots; Bot/ADC lane shows up to 6 full items + boots (the late-game boots-sell exception) — never an impossible 7-tile inventory.
- **Support Item Upgrade card** (support role only) — shows which of the 5 quest-final support items (off the World Atlas → Runic Compass → Bounty of Worlds chain) suits the champion, from real per-champ item data when available, otherwise a labeled "Suggested — not measured" archetype-based fallback.
- **Pro Consensus card.** What real pros/high-soloq actually build/run — a plain pick-frequency view, not WPA. Its own Starting-item and boots partitions (never mixed into the completed-item list). Percentages + sample-size caveats throughout; a genuine fetch failure shows a distinct error line, never silently collapsing into "no data."
- **Rank bracket selector.** Real league tiers (Platinum through Challenger via `rank=`); default is the legacy High-Elo (Diamond/Master/GM) blend.
- **Matchup-conditioned builds — not shipped.** Built end-to-end, but coachless rejects matchup parameters upstream (verified 403 on every endpoint). Degrades gracefully; will auto-activate if upstream ever supports it.
- **Item-set export to the game client** (via the Companion, see below) — Core/Buy order/Pro/Highest-WPA/damage-family archetype lines (AP/Mage, AP Burst, Tank Mage, Bruiser, Lethality/Assassin, Crit/Marksman, On-hit, pure Tank) as blocks inside ONE in-client item set per champion+role, only the archetypes that make sense for that champion's actual damage family. Damage-family resolution requires a decisive margin before an item tally overrides class tags, so tank and enchanter supports are no longer misread as AD (v0.58.0 — one incidentally-tagged support item used to be enough to flip them).
- **Dynamic patch.** Never hardcodes a data patch — probes ddragon's newest versions against coachless and walks backward until data is populated.
- **Graceful degradation.** Insufficient data → friendly empty state; genuine error → distinct "couldn't load, try again" state. Never silently substitutes unrelated sample data.
- **PWA.** Installable, service-worker cache tied to app version. Update toast ("Update ready — Refresh") — dismissal now persists across tabs/relaunches until a genuinely new version ships.

## Draft (`/draft`)

The Tactical Draft Analyzer — statistically-favored PLAY and BAN suggestions for a lane, given the enemies you've entered (manually, or auto-filled live from champ select via the Companion).

- **Comp profile bars.** ENEMY COMP PROFILE renders as horizontal 0–100 bars across 6 axes (from a curated 173-champion kit-rating table), plus up to 3 tactical takeaway chips — honestly worded ("High ban priority" rather than a specific, unbacked claim) whenever the underlying data doesn't support a sharper statement.
- **Suggested picks table**, sorted by CoachBuild's own ranking (any re-sort is labeled "Sorted by X — ranking is CoachBuild's own"), with Win Rate bar, Difficulty (from ddragon's own difficulty rating), Synergy band, and a GAMES column.
- **Suggested bans table**, an honest priority bar (not a fake win percentage) plus a "Beats You" win-rate-against-your-pick column. Excludes any candidate with fewer than 1,000 games in the specific matchup — a well-sampled counter always outranks a tiny-sample fringe pick.
- **Lane-opponent inference.** Automatically infers your direct lane opponent from enemy team composition (with a dominance guard against genuinely ambiguous cases); an explicit tap always overrides.
- **My Stats badges (display-only).** A small muted "you: 8-3" chip when you have personal record data against the resolved matchup — visually distinct from the scored win-rate color, never blended into the ranking. A "My pool" toggle filters (never re-scores) the list to champions you've actually played.
- **Live sync via the Companion** — auto-fills your champion and updates as champ select progresses; a manual edit enters "Manual mode" (clearly bannered) until the next fresh champ select re-attaches live pickup automatically.
- **Staleness honesty.** Shows a one-line notice when the underlying u.gg data is behind the app's own resolved current patch, rather than silently serving old numbers.

## Companion (`/live-setup`)

Setup and status for the optional PowerShell tray companion that bridges the app to your local League client.

- **Status hero card** — a 4-step progress rail (Client detected → Lobby → Champ Select → In Game), reflecting real companion state only (never shows a step as complete unless it genuinely polled that state).
- **One-line install command**, automation toggles (auto-apply runes / auto-apply item sets on champ select, both opt-out-default once paired, both real accessible switches with a privacy footnote) and a connection test.
- **What it does once paired:** entering champ select opens the Builds page (and/or Draft) to your locked/hovered champion automatically; a gold "Apply runes" push writes the recommended page into the client; "Add item builds" writes an in-client item set; an in-game Live panel shows the enemy comp (champion/position only).
- **Compliance, hard and tested:** no summoner names anywhere, no cooldown/timer automation, rune/item writes are either strictly user-clicked or an opt-out-default suggestion-class action (never a silent game-affecting automation), and the companion never deletes or overwrites a rune page / item set it didn't create.
- **Recent errors panel** — the last 5 classified companion failures (network/HTTP/malformed-response/LCU-rejected), so an on-device issue can be diagnosed from one screenshot.

## My Stats (`/mystats`)

Your own recorded League history for one linked personal Riot account — **display-only, current split only, never feeds any recommendation or score.**

- **4 stat tiles:** Games, Win Rate (with a delta vs. your prior split), Main (most-played champion), Build Adherence.
- **Recent games list** — per-game KDA and a WPA-build / off-build chip, shown only when a real comparison was possible (the match's patch must match the live recommend pipeline's current patch; older-patch games honestly show no chip rather than a guessed one).
- **Champion-pool card** with an on-build insight line.
- **On-demand refresh** — the page triggers an incremental sync on every view (cooldown-gated server-side so it can't be spammed), so "today's games" show up without waiting for the nightly cron.
- **Account-not-linked / zero-games / fetch-error states** are all distinct, never a bare spinner.

## Patch Movers (`/movers`)

The biggest champion win-rate shifts between the current and previous patch, across every lane at once — a single table (no more per-lane split), each row showing champion, role, current/previous win rate, the delta, and games. A curated per-role candidate pool (coachless has no champion-list/tier-list endpoint — the pool is a defensible approximation, not a true ladder top-N; the win-rate numbers themselves are real). Each mover carries a curated one-line patch note when one exists for that patch — otherwise "—", never a fabricated note.

## Pro Players (`/history`)

Search a tracked pro player or a champion and see recent games — solo queue and official pro-play, unified into one feed. Search-first (no separate landing table).

- **Two search modes.** Player: debounced typeahead over tracked pros (team, lane, game count). Champion: the same picker as Builds, plus an optional lane filter.
- **Favorites**, independent for players and champions — one-tap chips, 12-item cap each.
- **Source filter** — All / Solo Queue / Pro Play.
- **Game cards** — player/team, region, result, KDA, patch, a role-ordered 5v5 ally+enemy champion strip, a pro-play matchup line, rune/spell summary. Tap for full detail.
- **Game detail sheet** — full teams (every one of the 10 players tappable, including untracked pros), named runes/spells/items with real tap-to-detail popovers (current-patch numeric tooltips, not Riot's placeholder text), item build order (minute-grouped, consumables toggle), skill order (solo queue only — pro-play's broadcast feed carries no ability-level data, and says so explicitly rather than showing a blank grid).
- **Back-gesture navigation** — browser back/forward walks the exact selection/sheet history, no ghost entries.
- **Leaguepedia CC BY-SA attribution** in the page footer.

## Freshness model

Every pro game (solo queue and pro-play) is filtered to a rolling 90-day window. Two-to-three daily Vercel crons keep the store current (solo-queue matches, pro-play, My Stats). A targeted on-demand script exists for jumping one specific player to the front of the pro-play backfill queue.

## Data attribution

- Build recommendations, WPA stats, CDN icon/asset hosting: **coachless.gg**.
- Draft matchup/baseline stats: **u.gg**.
- Solo-queue match data + personal My Stats data: **Riot Games match-v5 API**; pro roster/account discovery via **lolpros.gg**.
- Pro-play (official esports) match data: **Leaguepedia** (lol.fandom.com), CC BY-SA — attributed in the footer.
- Pro-play item build reconstruction: **lolesports' public livestats feed**.
- Rune tooltip numeric descriptions: **CommunityDragon**.

This is a personal, non-commercial project — not endorsed by Riot Games.

## What shipped, by release (0.1.0 → 0.51.3)

The features above are the CURRENT state; this is shipping order for context, not a substitute for `CHANGELOG.md`.

**0.1.0–0.31.1** built the original two-tab app (Builds + Pro's/History): top-3 setups, all-trees evaluation, confidence-weighted ranking, the full solo-queue + pro-play (Leaguepedia) pipelines, favorites, the game-detail experience (runes/spells/build/skill-order/timeline, tap-to-detail popovers), accessibility passes, team-comp strips, performance work (lazy icons, on-demand team-players payload, SW icon cache), browser back/forward integration on both pages, Pro Consensus, the optimized/buy-order item sequence, a rank-bracket selector, and Patch Movers' original (keystone/item WPA-swing) form.

**0.32.0–0.37.0** added the LCU-integrated PowerShell **Companion**: champ-select auto-open, Apply-runes, in-game Live panel, then item-set export, then the **Draft** tactical recommender (u.gg-sourced matchup scoring) — including a real P0 (v0.37.2) where the entire matchup dataset had been ingested mirror-flipped (a user cross-checked against lolalytics and caught it), fixed with a permanent cross-source ingest guard.

**0.38.0–0.42.0** added **My Stats** (personal match tracker, ratified DISPLAY-ONLY per hard user directive) and its Draft integration (personal badges, My-pool filter), then a full cyan-HUD retheme of `/draft` as the "Tactical Draft Analyzer" with a comp radar, honest derived stats, and an accessibility pass.

**0.43.0–0.48.6** iterated the in-client item-set export through several real correctness bugs: a 413 payload-too-large from unbounded cross-session accumulation, duplicate/thin archetype categories, a 2-boots bug, starting items leaking into completed-item lists, and the Pro/WPA rune-apply pages fighting over one shared LCU page (fixed by giving them two separate exact-titled pages). Also added damage-family-scoped item archetypes, a Support Item Upgrade card, a "Beats You" ban win-rate column, and companion diagnosability (rolling error log, classified hints for every failure mode).

**0.49.0–0.51.3** shipped the current six-surface **global navigation redesign** (branded rail/tab-bar shell, `AppShell`), then a full UI reskin of all six surfaces to the user's WPA-Intelligence mockups in two waves: global top bar + champion search bus, the unified Builds view, Draft's gold retheme with comp bars, the Companion status hero, My Stats' tile/recent-games/adherence layout (migration 0014), Patch Movers' rewrite to per-champion win-rate shifts, and Pro Players simplifying back to search-first (a recent-games table added in 0.51.0 was removed in 0.51.2 per user directive). v0.51.3 closed out a real 7-tile-impossible-build display bug with the 6-slot build cap described above.
