<!-- merged into HANDOFF.md 2026-07-24 12:28:21Z; previous content preserved there. Append new rounds below. -->

## 2026-07-25 — AUDIT-2026-07-25.md P1-1 (engine)/P1-2 (engine)/P2-5 fixes (engo)

Scope: build-engine + UI files only, per dispatch brief. Did NOT touch lib/prostage/**, scripts/ingest-prostage*, components/hextech/proConsensus.ts, app/api/pros/route.ts, or migrations/ (engy's lane — saw their concurrent edits in `git status`, left them alone).

**P1-1 (engine) — hero-banner stats ignored the active elo pill.** `ChampionHero`'s WIN%/GAMES/CONFIDENCE always queried HIGH_ELO_TIERS regardless of which rank pill was active, while the build panel one row below correctly re-filtered on `&rank=`.
- `lib/heroStats.ts` — `getHeroStats(championId, lane, opts?: FilterOpts)`, threads `opts` into both `getKeystoneData`/`getGlobalItemStatistics` calls. Kept `opts` OPTIONAL and undefined-safe.
- `app/api/hero-stats/route.ts` — reads `rank`, resolves via `resolveRankBracket` (same 400-on-unknown-id posture as `/api/build`), passes `{ leagueTiers: bracket.apiValue }`. No-rank still resolves to the DEFAULT bracket (High Elo `[5,6,7]`) — byte-identical to pre-fix behavior. `isHealthy`/no-store-on-degraded Cache-Control logic (gotcha b) untouched.
- `components/hextech/heroContracts.ts` — client `getHeroStats(championId, lane, rankBracket?)` only appends `&rank=` when non-default (same convention as `BuildTabContent.load()`/`AutoExporter.fetchBuildFor`). `getMostPlayedLane` still calls with NO third argument — verified it still compiles and stays un-bracketed (widest sample for fair lane comparison), per the CRITICAL constraint in the brief.
- `components/hextech/ChampionHero.tsx` — effect deps now `[champ.id, lane, rankBracket]`, passes `rankBracket` through.
- Tests updated/added: `lib/__tests__/heroStats.test.ts` (updated the exact-args assertion for the new trailing param, added bracket-threading + un-bracketed-when-omitted tests), `lib/__tests__/hero-stats-route.test.ts` (new `describe` block for rank→leagueTiers threading + 400-on-invalid-rank), `components/__tests__/heroContracts.test.ts` (new `describe` block pinning the "&rank= only when non-default" contract on the client wrapper).

**P1-2 (engine) — TopBar's APPLY RUNES silently overwrote the bracket-correct page AutoExporter just wrote.** `components/hextech/GlobalNav/ApplyRunesButton.tsx` fetched `/api/build` with no rank (always High-Elo); `AutoExporter.fetchBuildFor` honors the persisted bracket. Both build the identical LCU page title, so the companion's exact-title PUT let this button clobber the correct page while still reporting "Applied in-client." Copied the two lines verbatim from `AutoExporter.fetchBuildFor` (`readStoredRankBracketId()` + the byte-identical-when-default `rankParam` construction). Did not touch `AutoExporter.tsx` itself (reference only, per brief).

**P2-5 — `LivePanel` fetched `/api/build` without the rank bracket.** Same class as P1-2, display-only (in-game situational item panel). Same two-line fix in `components/live/LivePanel.tsx`'s existing champ/lane-keyed effect — did not add `rankBracket` to that effect's deps (matches AutoExporter's own pattern of reading storage fresh at call time, not reactively; the fix scope per the audit was strictly "same two-line fix").

**Verification:**
- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` on the three touched test files — 26/26 pass.
- Full `npx vitest run` — 1547/1548 pass. The one failure (`lib/__tests__/prostage-ingest.test.ts`) is in engy's in-progress `lib/prostage/**` work (file shows modified in `git status` under engy's concurrent edits) — unrelated to anything in this dispatch, not touched by me.
- No version bump, no CHANGELOG edit, no deploy — per constraints.

Files touched: `lib/heroStats.ts`, `app/api/hero-stats/route.ts`, `components/hextech/heroContracts.ts`, `components/hextech/ChampionHero.tsx`, `components/hextech/GlobalNav/ApplyRunesButton.tsx`, `components/live/LivePanel.tsx`, `lib/__tests__/heroStats.test.ts`, `lib/__tests__/hero-stats-route.test.ts`, `components/__tests__/heroContracts.test.ts`.

