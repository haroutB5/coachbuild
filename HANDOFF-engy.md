<!-- merged into HANDOFF.md 2026-07-24 17:07:57Z; previous content preserved there. Append new rounds below. -->

## 2026-07-25 — AUDIT-2026-07-25.md pipeline fixes (P1-1 pipeline, P2-1, P1-2 pipeline)

Scope: pipeline + consensus files only. Did NOT touch app/api/pros/route.ts,
lib/prostage/liveIngest.ts, migrations/, or any build-engine/UI file owned by
engo (ChampionHero, hero-stats, ApplyRunesButton, LivePanel, itemSetBody.ts).

### P1-1 — 500-row Cargo truncation on the path that actually runs
- `lib/prostage/ingest.ts`: `paginate` now **defaults to `true`** (was
  `false`). The only caller that ever opted in was the deletable
  `scripts/ingest-prostage-seed.mjs` one-off; the real 3-hourly production
  path (`scripts/ingest-prostage.mjs --via-export`) never did, so any
  tournament over 500 rows silently lost its older (out-of-order-backfilled)
  rows forever. Flipped the default rather than patching every call site so
  future callers are safe by construction — pass `paginate: false` explicitly
  to opt out (kept working, tested).
- Added loud-failure detection: `fetchScoreboardRows` now returns
  `{ rows, possiblyTruncated }`. `possiblyTruncated` is true when (a) an
  explicit `paginate:false` call lands on exactly `PAGE_SIZE` (500) rows, or
  (b) the paginated walk exhausts `MAX_PAGES` (10) without ever seeing a
  short final page. Either case pushes a `result.errors` entry + `log(...)`,
  same convention as the `maxGames` cap fix (v0.55.0,
  `lib/prostage/liveIngest.ts`) — a cap hit can no longer look identical to
  "nothing new."
- `scripts/ingest-prostage.mjs`: added a comment at the `runProstageIngest`
  call site explaining why no `paginate` key is passed (inherits the new
  default) — this IS the file that was silently truncating in production.
- `scripts/ingest-prostage-seed.mjs`: untouched — already passed
  `paginate: true` explicitly, still correct.
- Tests (`lib/__tests__/prostage-ingest.test.ts`): rewrote the "paginate
  false is the default" test to prove the NEW default (no `paginate` key at
  all now walks 2 pages), added an explicit `paginate:false` opt-out test,
  added a cap-hit-loud-error test for both the single-call-500 case and the
  MAX_PAGES-backstop case (extended the existing MAX_PAGES test).

### P2-1 — getDdragonMaps memoized a REJECTED promise
- `lib/prostage/ddragon.ts`: added `.catch(() => { cachedMaps = null; throw
  err })` to `getDdragonMaps`, matching `getLeagues` (`lib/prostage/
  lolesports.ts`) and `getChampionKeyByInternalId` (`lib/prostage/
  tournaments.ts`), which already self-clear on failure for the same reason.
  Doubly important since `runLiveProstageIngest` calls this above its own
  try block.
- Test added in `lib/__tests__/prostage-ddragon.test.ts`: a rejected fetch
  no longer poisons a later call — second call gets a fresh attempt.

### P1-2 (pipeline) — Pro Consensus item percentages understated by itemless live rows
- `components/hextech/proConsensus.ts`: added `ProConsensusModel.
  itemsSampleSize` — counts games whose raw `finalItems` array is non-empty
  (mirrors `RuneSlotAccumulator.add`'s own gate). `items`/`boots`/`starters`
  share now all divide by `itemsSampleSize` instead of `gamesTotal`. Added a
  header-comment section documenting the fix (matches the file's existing
  "BUG THIS FIXES" convention) plus updated the three affected field doc
  comments.
- `components/hextech/ProConsensusCard.tsx`: `StartersStackTile`/
  `BootsStackTile`/`ItemTile` now get `denom={model.itemsSampleSize}` instead
  of `model.gamesTotal`. Also fixed the "From N pro games" footer line — it
  now appends an honest item-coverage caveat (`· items/boots/starting from N
  games with item data` or `· no item data in this sample yet`) whenever
  `itemsSampleSize !== gamesTotal`, so the footer never implies item coverage
  the card doesn't have. This touches a file outside the audit's literal file
  list (`proConsensus.ts`) but was necessary — the denominator/label live in
  the rendering component, not the model.
- Tests (`components/__tests__/proConsensus.test.ts`): updated the stale
  "against gamesTotal" test title/assertions (numerically unchanged there —
  every game in that fixture has item data) and added a dedicated dilution
  regression test (2 itemed + 2 itemless games -> itemsSampleSize=2,
  gamesTotal=4, items/boots/starters share 100% not 50%).

### Verification
- `npx tsc --noEmit`: clean, zero errors.
- `npx vitest run` (full suite, PATH-prefixed for node64 shadow): 1549/1550
  passed. The 1 failure (`components/__tests__/itemSetBody.test.ts`, a Tank
  block `.type` read on `undefined`) is in engo's owned file
  (`components/hextech/itemSetBody.ts`, mid-edit per `git status` at time of
  writing) — not touched by this pass, not caused by anything above.
- Scoped test runs (`prostage-ingest.test.ts`, `prostage-ingest-route.test.ts`,
  `prostage-ddragon.test.ts`, `proConsensus.test.ts`): all green in isolation
  too.

### Nothing deviated from the brief except
- Touched `ProConsensusCard.tsx` in addition to `proConsensus.ts` for P1-2,
  as noted above — required to actually thread the new denominator to the
  UI and fix the label, which the brief explicitly asked for.

