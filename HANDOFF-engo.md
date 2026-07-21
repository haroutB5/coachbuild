<!-- merged into HANDOFF.md 2026-07-21 18:02:23Z; previous content preserved there. Append new rounds below. -->

## 2026-07-21 (Round D) — engo: PLAY sample-size split (main/potential), v0.37.4

### Summary

When a direct lane opponent is resolved, `/api/draft/recommend` now partitions PLAY candidates by matchup sample size vs THAT opponent specifically: `plays` (back-compat name) = "main" top-10 among candidates with >=1,000 games vs the opponent; new `potentialPlays` = top-5 among 30-999 games (same scoring, honestly labeled as leads not conclusions). No row (or <30 games) vs the opponent = excluded from BOTH lists once a lane opponent is resolved. No lane opponent resolved = byte-identical to pre-v0.37.4 behavior. Live-validated against the corrected DB: exact match to the precomputed acceptance table. 1123/1123 tests, `verify-fix.sh` clean, shipped **0.37.4**.

### Implementation

- `lib/draft/score.ts`: extracted the scoring loop out of `rankPlays` into a private `computeScoredPool` helper (unsorted, unsliced) so `rankPlays` and the new `splitPlaysBySampleSize` can never silently drift on the scoring formula itself -- the split is a POST-scoring partition, never a second scoring pass. `rankPlays` itself is otherwise untouched byte-for-byte (still exported, still used as-is for the no-laneOpp case, still covered by its own pre-existing exhaustive tests, all of which pass unmodified). New `PlayResult.winVsLaneOppGames: number | null` -- the direct-opponent matchup row's own game count, deliberately kept SEPARATE from the existing `minGames` (which can be pulled down by a smaller off-lane enemy term or the candidate's own baseline sample, so it is not a reliable stand-in for "games behind this specific matchup" once more than one enemy is in play). New constants `PLAY_MAIN_TOP_N` (10), `PLAY_POTENTIAL_TOP_N` (5), `PLAY_MAIN_SAMPLE_FLOOR` (1000).
- `lib/draft/score.ts`'s `splitPlaysBySampleSize(pool, matchups, enemies)`: when no direct lane opponent is tagged, returns `{ main: <rankPlays' own output>, potential: [] }` (a genuine degenerate case of the same code path, not a special-cased branch) -- pinned by a test asserting `split.main` is `.toEqual()` to a real `rankPlays()` call on the same inputs. When a direct opponent IS resolved, partitions the full scored pool by that opponent's matchup row games (>=1000 -> main, 30-999 -> potential, else excluded from both), then sorts+slices each bucket independently.
- `lib/draft/recommend.ts`: `computeDraftRecommend` calls `splitPlaysBySampleSize` instead of `rankPlays`. `attachPersonalRecords` (Engy's My Stats decoration, already in-flight in this same file when I started) extended to take BOTH lists and decorate them from ONE combined `my_matches` query (never two round-trips) -- each list decorated independently from the same fetched rows, preserving order. `RecommendResult` gains `potentialPlays` (required, always populated -- `[]` on the pending path and the no-laneOpp path).
- `components/live/draftRecommend.ts`: `DraftPlayResult` gains `winVsLaneOppGames`; `DraftRecommendResponse` gains `potentialPlays`. Normalizer defaults BOTH to null/`[]` when absent/malformed -- an older cached response, or a response from before this field existed, degrades gracefully instead of crashing the client.
- `app/draft/page.tsx`: new "Potential counters" section below "Suggested picks", framing line "Promising but under 1,000 games — treat as leads, not conclusions." The existing empty-state check (`data.plays.length === 0`) was WRONG for the new split -- a laneOpp-resolved response can legitimately have an empty main list while `potentialPlays` has real leads; fixed to check both lists before showing "No data yet for this lane." Each row's displayed `n=` now uses `play.winVsLaneOppGames ?? play.minGames` (falls back cleanly to the pre-existing behavior when no lane opponent is resolved, since `winVsLaneOppGames` is null in that case).

### A behavior clash with Engy's in-flight personal-record test (fixed, not a real conflict)

Engy's `draft-recommend.test.ts` had one existing test ("personal is populated ... once a laneOpp IS resolved") whose DB mock supplied NO `draft_matchup` rows at all for `laneOpp: 7` -- under the OLD behavior that's fine (candidates still list on their off-lane/baseline score alone), but under v0.37.4's new "no evidence vs the resolved opponent = no listing" rule, both test candidates would be excluded entirely and the test's `result.plays.find(...)` assertions would throw on `undefined`. This isn't a merge conflict (different code, not different edits to the same lines) -- it's an assumption baked into a fixture that the new feature spec deliberately invalidates. Fixed by adding `>=1000`-game `draft_matchup` rows for both candidates vs opponent 7 to that ONE test's mock, so the personal-decoration behavior it verifies still holds meaningfully under the new partition rule. Every OTHER laneOpp-resolved test in that file only asserts `meta.laneOppInferred`, never `.plays` contents, so they were unaffected.

### Live validation (acceptance table match)

Called `computeDraftRecommend({ lane: 2, enemies: [112], laneOpp: 112, hover: null })` directly against the real Neon DB (patch 16.13) -- not a hand-derived reimplementation, the actual production code path:

```
=== MAIN (plays, top 10) ===
Xerath        -- 52.6% n=16547
Vel'Koz       -- 51.9% n=2268
Syndra        -- 51.5% n=20235
Kassadin      -- 51.5% n=5014
Fizz          -- 51.4% n=9299
Veigar        -- 51.3% n=7087
Twisted Fate  -- 51.0% n=11190
Diana         -- 50.9% n=8414
Akali         -- 50.9% n=13081
Aurelion Sol  -- 50.8% n=2854

=== POTENTIAL (potentialPlays, top 5) ===
Singed             -- 60.3% n=463
Zilean             -- 55.2% n=534
Nunu & Willump     -- 54.3% n=897
Kayle              -- 53.3% n=612
Gwen               -- 52.4% n=496
```

Exact match to the precomputed acceptance table (main leads Xerath/Vel'Koz/Syndra/Kassadin/Fizz; potential = Singed/Zilean/Nunu/Kayle/Gwen) -- zero material differences, ship proceeded as planned.

### Tests

- `lib/__tests__/draft-score.test.ts` -- +11 new: `winVsLaneOppGames` independence from `minGames` and its null-conditions (pinned on `rankPlays`, since the scoring core is shared), then a full `splitPlaysBySampleSize` describe block: partition boundary (n=999 -> potential, n=1000 -> main), no-laneOpp degrades to `rankPlays`' own byte-identical output, no-evidence exclusion (no row / n<30 -> excluded from both), empty-potential, top-N caps enforced independently per bucket, same score formula in both buckets, `PLAY_MAIN_SAMPLE_FLOOR` pinned at 1000.
- `lib/__tests__/draft-recommend.test.ts` -- +6 new (one existing test fixture fixed, see above): no-laneOpp unchanged, partition boundary at the engine level, no-evidence exclusion, potentialPlays decorated with personal-record fields same as plays, empty-potential, pending path reports `potentialPlays: []`.
- `lib/__tests__/draft-recommend-route.test.ts` -- 4 existing mock fixtures updated with `potentialPlays: []` / `winVsLaneOppGames: null` (required field, TS-enforced) + 1 new test proving the route passes `potentialPlays` through unmodified.
- `components/__tests__/draftRecommend.test.ts` -- 2 existing exact-`toEqual` fixtures updated for the new fields; +2 new tests: `potentialPlays` absent degrades to `[]`, a malformed `potentialPlays` entry is dropped without dropping the rest.
- Full suite: **1123/1123 passing** (baseline 1084, +39 net -- working off the same shared checkout as Engy's continuing mystats work, now also touching `lib/mystats/purge`/`season` additions; none of that is mine, see below).
- `bash scripts/verify-fix.sh`: tsc -b clean, lint clean, tests 1123 passed, build clean (one transient build-lock FAIL on the first run of this session, resolved by re-running -- known `.next/trace` stale-lock gotcha, not a real regression), sw/manifest present. ALL CHECKS PASSED.

### Files touched (mine)

- `lib/draft/score.ts`, `lib/draft/recommend.ts` -- core split logic.
- `lib/__tests__/draft-score.test.ts`, `lib/__tests__/draft-recommend.test.ts`, `lib/__tests__/draft-recommend-route.test.ts` -- tests (recommend-route + one recommend fixture updated for the new required fields, rest new).
- `components/live/draftRecommend.ts`, `components/__tests__/draftRecommend.test.ts` -- client type/normalizer.
- `app/draft/page.tsx` -- UI section + empty-state fix + n= display fix.
- `package.json` -- 0.37.3 -> 0.37.4. `CHANGELOG.md` -- new entry.

### NOT mine -- Engy's in-flight mystats work, untouched, not staged

Same discipline as the 0.37.3 ship: `lib/mystats/`, `app/api/mystats/`, `app/api/ingest/mystats/`, `scripts/ingest-mystats.mjs`, `scripts/purge-mystats-preseason.mjs` (new since my last commit), `migrations/0012_mystats.sql`, `lib/__tests__/mystats-*.test.ts` (now includes new `mystats-purge.test.ts`/`mystats-season.test.ts`), `lib/pro/riot.ts`, `lib/pro/puuidResolve.ts`, `vercel.json`, `HANDOFF-engy.md`, `HANDOFF.md` -- all left as-is, not staged by me.

Also untracked, NOT staged: `_scratch_live_validate_split.mjs` (the one-off acceptance-check runner above -- not part of the shipped app; this environment's safety gate blocks `rm`, same as the two 0.37.3-round scratch files, so it's just sitting there, harmless).

### Ship

- `bash scripts/verify-fix.sh` -- ALL CHECKS PASSED.
- Version bumped: app **0.37.3 -> 0.37.4**. Companion unchanged (1.4.1).
- CHANGELOG.md entry added.
- Commit/deploy/prod-check: see final report to Urgot.
