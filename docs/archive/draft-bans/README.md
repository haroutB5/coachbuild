# Archived — Draft ban suggestions and the pre-redesign /draft components

**Retired 2026-08-01, v0.90.0.** User decision: *"its fine to leave Bans out for now, just keep it
archived in case we want that feature back."*

**Nothing here was broken.** The "Draft Assistant" redesign replaced the whole `/draft` layout and
the new design has no place for a ban list. This is a layout decision, not a data or correctness
problem. Everything below worked when it was retired.

## Why the files are still in `components/hextech/` and not moved into this folder

Deliberate. These modules import each other and are referenced by their own passing tests, so
physically relocating ten files is a build-and-test change with real regression risk and no
functional gain — while `git` already preserves every byte. This README is the index that makes them
findable, which is the part `git log` does not give you.

If you do want them physically out of the tree later, move the whole cluster in one commit and run
the full gate; do not move them one at a time.

## What is dormant

Confirmed by an audit on 2026-08-01: **zero live consumers.** The only mentions of these names in
`app/draft/page.tsx` are in its stale header comment, not imports.

**Components** (`components/hextech/`)
`DraftBansTable.tsx`, `DraftPicksTable.tsx`, `MyChampionPanel.tsx`, `EnemyTeamPanel.tsx`,
`MatchupAnalysisPopover.tsx`, `DraftCompBars.tsx`, `BlindPickTable.tsx`

**Their models** (`components/hextech/`)
`draftBansModel.ts`, `draftPicksModel.ts`, `matchupAnalysis.ts`

**Still computed server-side and still shipped on the wire, just unread:** `/api/draft/recommend`
returns `bans` and `enemyAnalysis`. The scoring lives in `lib/draft/score.ts` and is untouched.

## The ban formula, so it is not lost

From `lib/draft/score.ts` — this is the part worth preserving even if the UI never returns:

```
banScore(m vs t) = max(0, (baselineWr(m) − matchupWr(m, t)) · shrinkFactor(n)) · presence(t)
shrinkFactor(n) = n / (n + K)          K = 200
presence(t)     = pickrate + PRESENCE_BANRATE_WEIGHT · banrate      (0.25)
```

Ban targets ranked by disadvantage × presence, excluded entirely below
`BAN_MIN_MATCHUP_GAMES = 1000`. A ban is worth suggesting when the champion both beats you and gets
picked; either alone is not enough.

**Caveat if you revive it:** `pickrate` and `banrate` are still NULL in `draft_champ_stats` (the
u.gg rankings decoder is a stub), so `presence(t)` degrades. The `laneShare` helper added in v0.89.1
is a working pick-rate proxy and is the obvious substitute — see `lib/draft/score.ts`.

## What else went with it

The redesign also dropped, from the UI only: personal `you: 8-3` badges, LOW SAMPLE confidence
chips, the enemy comp bars, tactical takeaway chips, and the difficulty column (difficulty later
returned in DETAILED RANKINGS).

## To bring bans back

1. Pick a home in the current layout. There is no obvious slot — that is why it was retired. The
   most likely candidate is a fifth tab beside Recommended / Blind Picks / Counters / Comfort Picks.
2. `bans` is already in the `/api/draft/recommend` response. No server work needed.
3. Re-render `DraftBansTable`, or write a new table against the same shape.
4. Fix `presence(t)` first, or the ranking is running on a null term.

## Known dead cost while dormant

Typing in "YOUR PICK" still triggers a full `/api/draft/recommend` refetch plus two extra DB queries
per keystroke. The ban list was that path's only output, so it is currently pure waste. It was left
alone because the debounced, race-guarded fetch is preserved machinery that must not be edited
casually. Making it conditional is a safe, worthwhile follow-up.
