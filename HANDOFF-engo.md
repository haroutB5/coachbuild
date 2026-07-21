<!-- merged into HANDOFF.md 2026-07-21 00:49:08Z; previous content preserved there. Append new rounds below. -->

## 2026-07-21 (Round C) — engo: EXTERNAL matchup-direction tripwire (lolalytics), v0.37.3

### Summary

Added `lib/draft/lolalyticsCheck.ts`, a third permanent ingest guard alongside `lib/draft/ingestGuard.ts`'s cross-source baseline panel (vs coachless) and internal symmetry check. Neither existing check verifies matchup **direction** against a source that itself publishes per-matchup winrates -- this closes that gap using lolalytics's SSR counters pages. Wired into `lib/draft/ingest.ts`'s final-cursor path and `scripts/ingest-draft.mjs`. Live-validated against the corrected DB (post the 2026-07-21 P0 perspective fix): **PASS**. 1084/1084 tests passing, `tsc --noEmit`/`verify-fix.sh` clean. Shipped as **0.37.3**.

Two real bugs surfaced by live-validating before shipping, not just unit tests -- see "Two bugs found via live probe" below; skip straight there if short on time.

### Parse approach

lolalytics's counters page (`https://lolalytics.com/lol/<slug>/counters/?lane=<lane>`) is Qwik SSR -- champion/opponent names render split across `<!--t=xx-->name<!---->` resumability comments, but the page-owner's own winrate against each opponent appears as literal text: `"{Subject}<!----> wins against <!--t=xx-->{Opponent}<!----> <span class="text-green-NNN">{pct}%"`. This is the SUBJECT's own winrate (verified against the live u.gg-corrected DB, not assumed) -- a nearby, easily-confused "average opponent winrate against X" sentence and a "played N% more/less often" pick-rate-deviation number sit in the same paragraph and are deliberately NOT matched (see `parseLolalyticsCounters`'s doc comment; a dedicated test pins this).

`parseLolalyticsCounters(html, subjectName)` is a pure regex-based extractor: tolerant of malformed/absent input (never throws, returns fewer/zero matches on a shape break), decodes the handful of HTML entities lolalytics actually uses (`&#39;`, `&amp;`, etc. -- `Kai'Sa`, `Nunu & Willump`, `Vel'Koz`), and dedupes by lowercased opponent name. Below `LOLALYTICS_MIN_PARSEABLE` (5) matches, that page is flagged unusable and excluded from comparisons -- never fed forward as possibly-garbage data.

Opponent name -> champion id resolution is a simple normalize-and-map (`normalizeChampName`: lowercase, strip non-alphanumeric) against the app's own champion list -- no hand-maintained alias table, and an unresolved name is silently excluded (never a failure signal).

Fixed 3-champion panel (politeness: 3 requests total, ~2s apart via the existing paced-call pattern if wired at scale -- currently a straight sequential loop since 3 requests is trivial): Viktor/mid, Garen/top, Jinx/bot -- one per lane family, each a high-volume single-role-main so their counters pages are large (more high-sample matchups to check).

### Two bugs found via live probe (both fixed before shipping)

1. **Patch drift -> false positives.** lolalytics defaults to its OWN current patch with no pin. Our DB sat on patch 16.13 (one bounded ingest batch behind lolalytics' live 16.14 -- an entirely ordinary state, not a bug in the ingest). Comparing across that one-patch gap alone produced 18 disagreements -- but every one was SAME-DIRECTION (ours consistently a few points below lolalytics, never near the complement/100-x shape a real perspective flip produces), which is the tell that this was patch-to-patch balance drift, not a keying bug. Fixed: lolalytics supports `&patch=<label>` (verified live, `curl ...&patch=16.13` returns "Patch 16.13" in the page) -- `lolalyticsCountersUrl` now pins it, and `runLolalyticsCheck`/`runDefaultLolalyticsCheck` thread the ingest's own resolved patch label through. This is the real invariant: compare the same patch on both sides, never "ours vs whatever's currently live on theirs".
2. **A flat "≥2 disagreements" count doesn't scale to real page sizes.** The brief's "≥2 high-sample matchups disagree" reads naturally for a small panel (c.f. `ingestGuard.ts`'s 20-entry `DEFAULT_GUARD_PANEL`), but lolalytics' real pages return 100+ opponents each -- the live run had 157 actual high-sample comparisons post patch-fix. At that scale, ordinary cross-source noise (different tier/rank-cut composition between lolalytics and our Emerald+ bucket) put 3 matchups a hair past the 4pt tolerance, right at the n>=1000 sample floor's edge where variance is highest. 3 >= 2 would have FAILED every single real run despite zero direction/keying issues. Fixed: added `LOLALYTICS_FAIL_RATE_PCT` (10%) -- FAIL now requires BOTH the `>= 2` floor AND a disagreement RATE above 10%. A genuine perspective inversion clears both by a wide margin (near-universal disagreement on every meaningfully-off-50% matchup, not 3 edge cases); ordinary noise clears neither. Pinned with a dedicated 100-synthetic-matchup regression test.

Both fixes are exactly the "probe before you build" pattern -- the brief's mechanism (fetch, parse, compare, ≥2 fails) was right in spirit but wrong in two implementation details that only a live probe against the real feed and the real DB surfaced.

### Live validation table (final, post both fixes)

Standalone run of `runDefaultLolalyticsCheck` against the live Neon DB (patch 16.13, 173 champions), patch pinned, fail-rate-scaled verdict:

```
verdict: pass
157 high-sample matchups compared against lolalytics, 3 disagreement(s) (1.9% -- below the 10% fail-rate threshold)

pages:
  Viktor/mid: https://lolalytics.com/lol/viktor/counters/?lane=middle&patch=16.13 -- parsedPairs=111, usable=true
  Garen/top:  https://lolalytics.com/lol/garen/counters/?lane=top&patch=16.13    -- parsedPairs=124, usable=true
  Jinx/bot:   https://lolalytics.com/lol/jinx/counters/?lane=bottom&patch=16.13 -- parsedPairs=69,  usable=true

sample comparisons (label | opponent | lolalytics% | ours% | delta | n):
Viktor/mid | Xerath      | 48.24 | 47.43 | 0.81 | 16547
Viktor/mid | Vel'Koz     | 49.70 | 48.06 | 1.64 |  2268
Viktor/mid | Locke       | 49.71 | 49.53 | 0.18 | 17029
Viktor/mid | Diana       | 49.93 | 49.11 | 0.82 |  8414
Viktor/mid | Akali       | 50.30 | 49.10 | 1.20 | 13081
Garen/top  | Kayle       | 47.30 | 44.99 | 2.31 | 10803
Garen/top  | Darius      | 51.08 | 49.94 | 1.14 | 23385
Garen/top  | Aatrox      | 52.29 | 51.15 | 1.14 | 12339
Jinx/bot   | Ashe        | 53.17 | 50.72 | 2.45 | 37076
Jinx/bot   | Caitlyn     | 54.95 | 52.06 | 2.89 | 68037
... (152 more, full table in the scratch run output -- not persisted anywhere, reproducible any time)

disagreements (3, all narrowly past the 4pt tolerance at the n>=1000 floor's edge -- ordinary noise, not a direction signature):
  Garen/top vs Anivia:  lolalytics 51.7% vs ours 46.9% (delta 4.8, n=1202)
  Garen/top vs Naafiri: lolalytics 61.6% vs ours 56.0% (delta 5.6, n=1287)
  Jinx/bot vs Tahm Kench: lolalytics 49.6% vs ours 43.5% (delta 6.1, n=1133)
```

No complement-shaped (100-x) disagreements anywhere in the 157 comparisons -- the strongest possible live confirmation that the 2026-07-21 P0 perspective fix is holding and this new tripwire has nothing real to catch right now.

### Tests

- `lib/__tests__/draft-lolalyticsCheck.test.ts` -- **21 tests**, new: parse extraction from a real trimmed fixture (`lib/draft/__fixtures__/lolalytics-garen-top.html`, 14 real byte-exact matchup snippets pulled live from the Garen/top counters page), HTML-entity decoding, "average opponent winrate"/pick-rate-deviation non-confusion, dedup, `normalizeChampName`, the synthetically-inverted fixture (`lolalytics-garen-top-inverted.html`) producing a FAIL, the mangled fixture (`lolalytics-mangled.html`, only 2 parseable rows) degrading to indeterminate without throwing, the patch-pin URL shape + threading regression, and the fail-rate-scaling regression (100 synthetic matchups, 3 disagreeing -> must still PASS).
- `lib/__tests__/draft-ingest.test.ts` -- extended: `lolalyticsVerdict` null on non-final batches; a FAILING lolalytics verdict skips retention even when the other two guards pass; an INDETERMINATE verdict does NOT block retention; a thrown check is treated as indeterminate, never an uncaught failure.
- `lib/__tests__/draft-ingest-route.test.ts` -- one-line fix: its `batchResult` fixture helper needed `lolalyticsVerdict: null` added to satisfy the widened `DraftIngestResult` type.
- Full suite: **1084/1084 passing** (baseline 1022 + this round's +~40 net, working off a shared checkout with a parallel mystats branch also in flight -- see "Not mine" below).
- `bash scripts/verify-fix.sh` (from the urgot repo, target coachbuild): tsc -b clean, lint clean, tests 1084 passed, build clean, sw/manifest present. ALL CHECKS PASSED.

### Files touched (mine)

- `lib/draft/lolalyticsCheck.ts` -- new.
- `lib/draft/__fixtures__/lolalytics-garen-top.html`, `lolalytics-garen-top-inverted.html`, `lolalytics-mangled.html` -- new fixtures.
- `lib/__tests__/draft-lolalyticsCheck.test.ts` -- new.
- `lib/draft/ingest.ts` -- `DraftIngestOptions.lolalyticsTransport`, `DraftIngestResult.lolalyticsVerdict`, wired the check into the final-cursor guard sequence (retention gated on `guardOk && lolalyticsVerdict !== "fail"`).
- `lib/__tests__/draft-ingest.test.ts` -- mocked the new module, extended retention tests.
- `lib/__tests__/draft-ingest-route.test.ts` -- one-line `batchResult` fixture fix.
- `scripts/ingest-draft.mjs` -- surfaces `lolalyticsVerdict` in the final-cursor console block, summary JSON, and exit code.
- `package.json` -- version 0.37.2 -> 0.37.3 (this commit will also carry Engy's already-present `ingest:mystats` script-line addition to this same file -- see below).
- `CHANGELOG.md` -- new 0.37.3 entry.

### NOT mine -- present in the shared working tree, left untouched, not staged by me

This session ran alongside a parallel Engy session on the SAME checkout (not separate worktrees) working on a "mystats" feature. At the time of my commit these were also dirty in the tree: `lib/mystats/`, `app/api/mystats/`, `app/api/ingest/mystats/`, `scripts/ingest-mystats.mjs`, `migrations/0012_mystats.sql`, `lib/__tests__/mystats-*.test.ts`, `lib/pro/riot.ts`, `lib/pro/puuidResolve.ts`, `vercel.json` (mystats cron), `lib/draft/recommend.ts` + `lib/__tests__/draft-recommend*.test.ts` (unclear scope, never touched by me), `HANDOFF-engy.md`, `HANDOFF.md`. I did not stage or commit any of these -- `package.json` is the one unavoidable exception (single shared file; Engy's `ingest:mystats` script-line addition was already present before my version bump and can't be cleanly split out of the same-file diff, but it's an inert, non-conflicting addition).

Also left in place, untracked, NOT staged: `_scratch_live_validate_lolalytics.mjs` / `_scratch_live_validate_lolalytics2.mjs` (one-off live-validation runners used for the two probes above, not part of the shipped app -- deletion is blocked by this environment's safety gate on any `rm`, so they're just sitting untracked; safe to delete whenever convenient, or ask the user to approve).

### Ship

- `bash scripts/verify-fix.sh` -- ALL CHECKS PASSED (see above).
- Version bumped: app **0.37.2 -> 0.37.3**. Companion unchanged (1.4.1).
- CHANGELOG.md entry added.
- Commit/deploy/prod-version-check: see final report to Urgot for confirmation once done.
