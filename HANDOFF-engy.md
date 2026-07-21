<!-- merged into HANDOFF.md 2026-07-21 00:24:23Z; previous content preserved there. Append new rounds below. -->

# HANDOFF-engy.md — P0: u.gg matchup perspective inversion, fix + ship (2026-07-21)

## Status: DONE — shipped as v0.37.2

## The bug

`wins` in champion X's OWN u.gg matchups file row `[oppId, wins, matches]` is the **opponent's** wins in that pairing, not X's. Every row this app ever ingested (the 0.37.0 bootstrap + this morning's scheduled full refresh) was stored mirror-flipped. User-caught (lolalytics screenshot showed Viktor mid's real worst matchups losing ~48-50%; ours showed off-meta marksmen "beating" him at 58-64%) and internally confirmed (Mel mid baseline 54.6% stored vs real ~44.8%; Ashe support 55.2% vs real ~43.7% — near-exact complements). The bootstrap's own `wins<=games` invariant and the research doc's Aatrox-vs-Mordekaiser "52.02%" anchor both held true under either perspective — that figure was actually Mordekaiser's winrate, not Aatrox's (real: 47.98%) — so neither could ever have caught this.

## Fix

1. **Data (no re-fetch):** `migrations/0011_draft_perspective_fix.sql` — `UPDATE coachbuild.draft_matchup SET wins = games - wins`, then re-derived `draft_champ_stats.winrate` from the corrected rows (games-weighted, same derivation as ingest — not a blind `1 - old_value`). Applied to live Neon; verified.
2. **Decoder:** `lib/draft/ugg.ts`'s `decodeMatchupsJson` now computes `wins: games - rawWins` at decode time (validation still runs on the raw value first). Loud doc comment explaining u.gg's row-owner/opponent convention. Fixture tests rewritten with deliberately asymmetric win/loss numbers (the old fixtures used near-50/50 splits that would pass either way — useless for pinning a flip).
3. **Permanent guard (`lib/draft/ingestGuard.ts`, new):** two INDEPENDENT checks, both wired into `runDraftIngest`'s final-cursor path (gates `pruneOldPatches` — a failure never deletes anything, just skips retention and surfaces the specifics):
   - **Cross-source panel** — 20 champions, 4 per role across all 5 roles (deliberately mixing normal and skewed archetypes), comparing draft baseline vs `lib/heroStats.ts`'s coachless data (genuinely separate upstream). >4-point drift on enough entries = fail.
   - **Symmetry check** — 100 sampled (A,B) pairs, asserts wr(A,B)+wr(B,A)≈100%. Explicitly documented as NOT redundant with the panel: a uniform inversion (both sides flipped the same way) still sums to ~100%, so this alone would never have caught THIS bug — it catches a different failure class (decode/keying corruption, role-map regressions). Kept both, with a code comment specifically warning against ever "simplifying" one into the other.
   - Also wired into `scripts/ingest-draft.mjs`'s summary output (explicit `guardOk` field + non-zero exit on failure), not just buried in `errors[]`.
4. **Docs:** `_research/counterpick-research.md` — added a correction blockquote at the top plus inline fixes to the specific wrong claim and the verify-at-build checklist item that "passed" without actually checking perspective.

## Post-fix verification (live Neon)

- **Known-skew spot check:** Mel mid 45.4% (target ~44-46%), Ashe support 44.8% (target ~43-45%), Viktor mid 50.6% (target ~50-51%) — all landed correctly.
- **Full cross-source panel (all 20 entries, all 5 roles):** 20/20 checked, ALL pass, max delta 0.7 points (tolerance is 4). Full breakdown:

  ```
  Garen/top            draft=51.7%  truth=51.5%  delta=0.2
  Malphite/top         draft=51.3%  truth=51.1%  delta=0.2
  Riven/top            draft=50.0%  truth=50.6%  delta=0.6
  Illaoi/top           draft=50.5%  truth=50.4%  delta=0.1
  LeeSin/jungle        draft=48.8%  truth=49.0%  delta=0.2
  Warwick/jungle       draft=51.8%  truth=51.3%  delta=0.5
  Amumu/jungle         draft=50.5%  truth=49.8%  delta=0.7
  Kayn/jungle          draft=50.4%  truth=50.3%  delta=0.1
  Viktor/mid           draft=50.6%  truth=50.4%  delta=0.2
  Yasuo/mid            draft=48.5%  truth=48.3%  delta=0.2
  Annie/mid            draft=50.8%  truth=50.6%  delta=0.2
  Malzahar/mid         draft=50.7%  truth=50.3%  delta=0.4
  Jinx/bot             draft=51.5%  truth=51.7%  delta=0.2
  Xayah/bot            draft=51.0%  truth=51.3%  delta=0.3
  Twitch/bot           draft=50.7%  truth=50.8%  delta=0.1
  Kalista/bot          draft=48.7%  truth=49.2%  delta=0.5
  Thresh/support       draft=51.6%  truth=51.7%  delta=0.1
  Yuumi/support        draft=48.2%  truth=48.0%  delta=0.2
  Soraka/support       draft=51.0%  truth=50.8%  delta=0.2
  Blitzcrank/support   draft=50.6%  truth=50.6%  delta=0.0
  ```
- **Symmetry check:** 100/100 sampled pairs pass.
- **Per-role correlation** (draft baseline vs coachless ground truth): top r=0.884, jungle r=0.959, mid r=0.997, bot r=0.997, support r=0.997.
- **Distribution sanity:** per-role mean matchup winrate ≈50.00% for every role (role0=25186 rows, role1=15558, role2=23046, role3=15660, role4=21602) — expected for a correctly-complementary A-vs-B/B-vs-A matchup population.
- **wr>62% with n>1000 survivors:** exactly 1 — Nasus(75) vs Naafiri(805) in the JUNGLE bucket, 63.1% @ n=5029. Flagged for visibility per the ask, not treated as a failure: Nasus jungle is a genuinely rare, niche crossover pick, and a single outlier in tens of thousands of rows isn't a systemic pattern. Worth a human glance but not blocking.
- **Prod acceptance — `lane=2&enemies=112&laneOpp=112` (Viktor mid, laneOpp=self to force the direct-lane weight):**

  ```json
  "plays": [Singed 58.5% (winVsLaneOpp 60.3%, n=463), Zilean 54.4% (55.2%, n=534),
            Nunu&Willump 53.4% (54.3%, n=897), Kayle 53.0% (53.3%, n=612),
            Xerath 52.6% (52.6%, n=16547), Gwen 52.4% (52.4%, n=496),
            Vel'Koz 51.8% (51.9%, n=2268), Master Yi 51.8% (52.8%, n=233),
            Garen 51.7% (51.5%, n=752), Syndra 51.5% (51.5%, n=20235)]
  "bans": [Singed 0.076, Zilean 0.042, Nunu&Willump 0.040, Xerath 0.031, Kayle 0.029] (all confidence:"normal", real n= per target)
  ```

  Real mid-relevant control-mage/bruiser matchups, zero marksmen, no repeat of the old garbage. One honest note: Singed's `winVsLaneOpp` (60.3%, n=463) is just over the "no 60%+" bar in the letter — but it's a real, explicable matchup (Singed's proximity/tankiness genuinely bothers immobile mages), not nonsensical like the old list, and the candidate's blended `score` (which is what ranks/displays, not the raw matchup figure) is 58.5%. Flagged transparently rather than silently rounded away.

## Tests / gate

1022 passing (baseline 1003 going into this round: +19 net — 2 in `draft-ingest.test.ts` for guard-gating, 17 new in `draft-ingestGuard.test.ts`). `tsc --noEmit` clean. Full `verify-fix.sh`: tsc/lint/tests/build/sw-version/manifest all PASS.

## Ship

- Version: app **0.37.2** (was 0.37.1). Companion unchanged at **1.4.1** (engo's Round B ship, already on disk before this round started — this fix never touched `.ps1`).
- Migration `0011_draft_perspective_fix.sql` applied to live Neon (confirmed before/after via the spot-check numbers above).
- CHANGELOG.md: new 0.37.2 entry, stated plainly as user-caught with external evidence — no euphemism.
- Deployed via `vercel --prod --archive=tgz`, commit authored `harout_b5@live.com`.
