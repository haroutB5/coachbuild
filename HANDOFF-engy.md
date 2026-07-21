<!-- merged into HANDOFF.md 2026-07-21 19:39:19Z; previous content preserved there. Append new rounds below. -->

# HANDOFF-engy — CoachBuild v0.39.1 (2026-07-21)

## Ship: fast-follow on v0.39.0's Task-4 finding — "LOW SAMPLE" badge false-positive

**Deployed:** v0.39.1 → https://coachbuild.vercel.app (prod). `verify-fix.sh` clean, 1179 tests (baseline 1177 + 2 net new).

### What shipped

v0.39.0's report flagged (Task 4) that every /draft main-list row showed "LOW SAMPLE" despite huge headline samples (Sylas n=24030), and proposed a fast-follow rather than fixing it inline since it touched `score.ts`'s `confidence` contract. Orchestrator ruled the confidence badge is a display/labeling contract, not the scoring formula — the standing "don't retune scoring" constraint doesn't bind it, so this round implements exactly the proposed fix.

**Root cause (confirmed, matches v0.39.0's diagnosis):** `computeScoredPool` in `lib/draft/score.ts` flipped `confidence: "low"` whenever ANY contributing matchup term (including 0.2-weight off-lane terms, once they clear `N_FLOOR=30`) had `n < K=200`. Since `POOL_MIN_TOTAL_GAMES=5000 >> K`, a pooled candidate's own baseline never trips it — in practice the flag was always driven by a thin off-lane term (e.g. Udyr-mid barely played in the resolved lane), a term whose contribution to `score` is already shrunk to near-zero by `W_OFFLANE=0.2`. The badge was flagging the exact noise the shrink math neutralizes.

**Fix (`lib/draft/score.ts`, `computeScoredPool`):** `confidence` now only tracks the row's DOMINANT evidence term:
- baseline `totalGames < K` (unchanged, audit-P1-1 clause), OR
- when a direct lane opponent is resolved, that direct-opp matchup term (`enemy.isDirectLaneOpp`) has `row.games < K`.

Off-lane terms no longer touch the flag (`minGames` is unaffected — still tracks the smallest contributing term across all terms, that field's contract is untouched). Weights/K/N_FLOOR/floors — the actual scoring formula — untouched, exactly as scoped.

**Tests** (`lib/__tests__/draft-score.test.ts`): the old audit-P1-1 pinned test (line ~166, "confidence is low iff a CONTRIBUTING term has n<K") is superseded — kept, retitled to explain the supersession, re-asserted `"normal"` (it's a pure off-lane-thin-term case, which is now the reason NOT to flag). Two new tests pin the new contract directly:
- main-tier row, fat direct-opp (`n=24030`) + thin off-lane term (`n=100`) → `confidence: "normal"`.
- potential-tier row via `splitPlaysBySampleSize`, direct-opp `n=150` (clears `N_FLOOR=30`, under `K=200`, under `PLAY_MAIN_SAMPLE_FLOOR=1000`) → `confidence: "low"` — the badge's honest job when the direct-opp term IS the dominant evidence.

**Doc comments updated:** `PlayResult.confidence`'s JSDoc rewritten to state the new contract and explicitly flag it as superseding the old "ANY contributing term" rule (with the prod repro cited), and the loop's `if (enemy.isDirectLaneOpp && row.games < K)` line has an inline comment pointing back to it.

**CLAUDE.md:** the stale v0.38.0-era sentence ("`resolveLaneOpponent` only infers … when pickrate is non-null, currently always null") corrected to describe the v0.39.0 `total_games` proxy + `LANE_OPP_DOMINANCE_RATIO` mechanism (this was flagged stale by the v0.39.0 report, done in this round).

**PROD SMOKE:**
```
GET /api/draft/recommend?lane=2&enemies=266,103,77,222
→ meta.laneOppInferred = 103 (Ahri), main plays report confidence:"normal"
  (Swain n=1568, Veigar n=9975, Sylas n=24030 — all normal, no off-lane false-positive)
→ potential-tier plays (direct-opp n in 30-999) still report confidence per the n<K rule where applicable
```
/draft UI: Sylas/Swain/Veigar main-list rows render WITHOUT the "Low sample" badge.

### Not touched / out of scope
- `BanResult.confidence` (`rankBans`) — untouched, not part of this defect (bans were never reported as false-positive; their contract is single-row/single-term already, no off-lane-term ambiguity to fix).
- Scoring formula (`K`, `N_FLOOR`, `W_DIRECT`, `W_OFFLANE`, `POOL_MIN_TOTAL_GAMES`, `PLAY_MAIN_SAMPLE_FLOOR`) — all constants unchanged, this was purely the confidence-flag derivation.
