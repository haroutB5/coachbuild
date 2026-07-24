<!-- merged into HANDOFF.md 2026-07-24 14:07:37Z; previous content preserved there. Append new rounds below. -->

## Addendum — P1 fix (/mystats blank extended data) + KDA backfill script (engo scope)

### P1 root cause, confirmed exactly as reported

`components/hextech/myStats.ts`'s `normalizeMyStatsSummary` rebuilt its return object with ONLY `accountUnresolved`/`season`/`riotId`/`records` — every field added to `/api/mystats/summary` this same wave (`buildAdherencePct`, `winrateOnBuild`, `winrateOffBuild`, `priorSplitWinrate`, `recentGames`) was silently dropped on the way through the normalizer, even though the server was already sending real data (prod-verified: 5 `recentGames` rows, `priorSplitWinrate=0.5185`). `app/mystats/page.tsx`'s own `MyStatsSummaryExtended extends MyStatsSummary` cast made TypeScript think those fields existed on the normalized result, so nothing caught the mismatch at compile time — every real page load silently degraded to `undefined`/`[]` via the page's own `?? []`/`?? null` fallbacks. This is exactly the reported symptom.

**Fix**: `normalizeMyStatsSummary` now passes all five fields through with the same defensive-per-field posture the file already uses elsewhere (`numOrNull`: non-finite/wrong-typed → `null`, never `0` or `NaN`; new `normalizeRecentGame`: malformed entry dropped without tainting the rest of the list, `role` missing → `-1` not a crash, `onWpaBuild` coerced via `boolOrNull` — anything non-boolean → `null`, never fabricated as `false`). `MyStatsSummary`'s five new fields are declared **optional** (`?`) rather than required — required-in-base + optional-in-derived is a real TS2430 "incorrectly extends" error against `app/mystats/page.tsx`'s already-committed `MyStatsSummaryExtended`, so optional was the only compile-safe choice without touching that `.tsx` file (out of scope). New `MyStatsRecentGame` interface is structurally IDENTICAL to `RecentGamesList.tsx`'s own `RecentGameRow` (verified by reading that file) specifically so the two stay mutually assignable regardless of which interface ends up extending which.

**Test coverage added to `components/__tests__/myStats.test.ts`**: a `PROD_PAYLOAD` fixture built from the exact reported prod shape (5 `recentGames` rows, `priorSplitWinrate=0.5185`, plus `buildAdherencePct`/`winrateOnBuild`/`winrateOffBuild`) with a full passthrough assertion — this is the test that would have caught the regression before ship. Plus: zero-value fields survive (never coerced to `null`), non-finite/wrong-typed fields degrade to `null`, a malformed `recentGames` entry is dropped without dropping the rest, missing `role` degrades to `-1`, `onWpaBuild` coercion for every non-boolean input, and a non-array `recentGames` degrades to `[]`. Two PRE-EXISTING exact-match (`toEqual`) tests had to be updated to include the new default fields (`buildAdherencePct: null` etc.) — otherwise they'd now fail on the extra keys, not because their own assertions were wrong.

**Verification**: `npx tsc --noEmit` (whole repo, including the untouched `app/mystats/page.tsx`) → clean. `npx vitest run` → 111 files / 1526 tests, all green.

### KDA/items/keystone backfill (feature, not just the P1)

`scripts/backfill-mystats-kda.mjs` (new) — mirrors `scripts/ingest-mystats.mjs`'s conventions exactly (`loadEnvLocal`, dynamic `.ts` imports via `tsx`, same error-name checks on exit). `SELECT match_id FROM coachbuild.my_matches WHERE kills IS NULL ORDER BY game_creation DESC`, then for each row STRICTLY sequentially (a plain `for` loop, never `Promise.all`): `lib/pro/riot.ts`'s `getMatch` (already paced through the shared process-wide `lib/pro/pacer.ts` queue — no extra throttling needed), `lib/mystats/extract.ts`'s `extractMyMatch` for the KDA/items/keystone, and **the exact same `resolveRecommendedBuild` lib/mystats/ingest.ts's live ingest path uses** — exported it from `ingest.ts` for this reuse rather than reimplementing the cache/patch-gate contract a second time. `on_wpa_build` only resolves for rows whose own patch equals today's live recommend-pipeline patch (documented limitation, unchanged from the ingest path) — never guessed otherwise. Idempotent/resumable by construction (`WHERE kills IS NULL` never re-selects an already-updated row).

**Ran it**: `npx tsx scripts/backfill-mystats-kda.mjs`
```
110 row(s) missing KDA/items/keystone.
Current recommend-pipeline patch: 16.13
Updated 110 of 110 attempted row(s). on_wpa_build resolved (non-null) for 21.
0 failures.
```
(110, not the ~56 estimated in the ask — verified live, not a discrepancy worth chasing: the account had more historical rows predating migration 0014 than the estimate assumed.) The 21 resolved rows are exactly the ones on patch 16.13 (today's live recommend-pipeline patch at run time); every other row — patches 16.1 through 16.14 — correctly got `on_wpa_build: null`, including the newest patch 16.14 rows (coachless lags the newest patch, so `getLatestPatch()` still resolves 16.13 — same lag pattern `lib/staticData.ts`'s header already documents). Safe to re-run any time; will no-op on all 110 now-populated rows.
