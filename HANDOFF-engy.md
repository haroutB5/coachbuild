<!-- merged into HANDOFF.md 2026-07-20 23:46:16Z; previous content preserved there. Append new rounds below. -->

# HANDOFF-engy.md — Draft recommender audit patch round + full ship (2026-07-21)

## Status: DONE — shipped as v0.37.0

Audit verdict was SHIP-AFTER-PATCH. All 6 findings (P1-1, P1-2, P2-1, P2-2, P2-3, P3-1) fixed, live-verified against Neon where applicable, then full ship pipeline run.

## Fixes

- **P1-1 (default-screen garbage, e.g. Yuumi 81%/128g in a Top pool):** added `total_games` column to `draft_champ_stats` (migration `0010_draft_audit_patches.sql`, backfilled from existing matchup data) + `filterPoolByTotalGames` (5000-game floor, `lib/draft/score.ts`), wired into the pool query in `lib/draft/recommend.ts`. Also fixed `rankPlays`' empty-enemies path — `minGames`/`confidence` are now seeded from the candidate's own `totalGames` (never a blank "normal" with no sample reported).
  - **Acceptance evidence (live Neon, all 5 lanes, no enemies):** every single candidate across every lane has `minGames` >= 5196 (well above the 5000 floor) — full dump: lane0 `12:5759,51:6485,35:7379,145:7032,64:9429,901:18865,18:5656,202:5400,104:9761,254:5208`; lane1 `29:9892,805:259660,67:5245,238:107041,164:5196,68:5361,63:15730,246:100328,107:180721,80:43836`; lane3 `805:18557,4:7940,800:114040,110:142963,81:738642,804:212517,42:53907,429:91918,236:390949,145:691449`; lane4 `21:12620,81:13490,64:11870,29:17886,800:121454,805:18138,238:5984,22:44816,90:6234,54:25659`. Yuumi(350)/Bard(432)/Braum(201) — the auditor's cited artifacts — appear in NONE of them. Also added a UI hint caption under "Suggested picks" documenting the floor.
- **P1-2 (cron never progressed):** `coachbuild.draft_ingest_cursor` one-row table (same migration). `app/api/ingest/draft/route.ts` reads/persists it when no explicit `?cursor=` is given (wraps to 0 on a completed walk); an explicit cursor still overrides and never touches the persisted state. `lib/draft/ingest.ts` gained `getPersistedCursor`/`setPersistedCursor`.
- **P2-1 (lane-opp auto-detect wrong):** deleted `draftLiveSync.ts`'s `laneOpponentIndex` field/computation and its 3 tests entirely — the index-vs-role assumption was falsified by the companion's own SelfTest fixture (theirTeam compacts unresolved slots). `app/draft/page.tsx` no longer derives a client-side guess from live sync; the enemy-chip highlight now reflects the user's explicit tag OR the server's `meta.laneOppInferred` (never a client index guess), with an "(inferred)" label distinguishing the two.
- **P2-2 (every ban "Low sample n=0"):** `BanResult` (score.ts) gained real `confidence`/`minGames`, computed in `rankBans` from the hover-vs-target matchup row's own `games` — null/low only when there's genuinely no row. `components/live/draftRecommend.ts`'s `DraftBanResult.minGames` is now `number | null` (was defaulting to a fabricated 0).
- **P2-3 (ban score as a green win-%):** `DraftResultRow.tsx`'s ban variant now renders a relative priority bar (scaled against a documented 0.12 ceiling) + raw score subtext — no `pct()`, no green.
- **P3-1 (serving-patch completeness):** `resolveServingPatch` now orders by `(count(DISTINCT champ_id) >= 120) DESC, MAX(ingested_at) DESC` — a genuinely complete older patch outranks a mid-ingest newer one. Bans section gained a "bans that counter your pick in your lane" scope-note caption.

## Tests

986 passing (baseline 973, +13 net: score/ingest/recommend/route/draftLiveSync all extended for the new behavior — draftLiveSync actually shed 2 net tests removing the deleted laneOpponentIndex describe block, offset by new coverage elsewhere). `tsc --noEmit` clean. `verify-fix.sh` full gate: tsc/lint/tests/build/sw-version/manifest all PASS.

## Ship

- Version: app **0.37.0** (was 0.36.1). Companion: **stays 1.4.0** — P2-1's fix was entirely client-side (draftLiveSync.ts/page.tsx); `companion.ps1` was not touched this round.
- CHANGELOG.md: new 0.37.0 entry (Draft feature headline + all 6 audit patches).
- See the deploy + prod-smoke results appended right after this in the same commit's push — Vercel-egress probe of stats2, recommend-endpoint sanity vs u.gg, header discipline, `/draft` real-browser check.
