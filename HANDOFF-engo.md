<!-- merged into HANDOFF.md 2026-07-20 22:10:29Z; previous content preserved there. Append new rounds below. -->

## 2026-07-21 (Round B) — engo: fix wave on the banked seamlessness-audit findings, v0.37.1 / companion 1.4.1

### Summary

Applied all 6 banked Round-B findings against CURRENT code (post-Draft feature + CompanionProvider poller lift, which had already landed the P1 fix). Re-verified each finding's mechanism before fixing — three findings' underlying code had shifted since the audit ran at v0.36.0, though the fix directions all still applied once re-traced. 1003/1003 tests passing (baseline 973, +30 net), `tsc --noEmit` and `tsc -b --force` both clean, `next lint`/`next build` clean (only pre-existing `<img>` warnings), companion SelfTest/Mock/HarnessTest all PASSED.

### Per-finding

1. **P2 follow-fights-user** — RE-VERIFIED still live post-lift: the follow effect (now in `app/page.tsx`, fed by `CompanionProvider`'s `companion.tick`/`phase`/`champSelect`) still gated on `resolveChampSelectFollow`'s "differs from `champ.id` (currently shown)" check, which re-fires every tick once a manual browse diverges `champ.id` from an unchanged champ-select champion. Fixed by decoupling entirely: new `champSelectFollowState.ts` exports `shouldFollowChampSelectChange`/`markFollowedChampSelectChampion` (tracks the last champ-select championId the follow effect actually acted on, reset on a fresh ChampSelect epoch), paired with `champSelectFollow.ts`'s new `resolveChampSelectRoleId` (role-extraction split out of the old `resolveChampSelectFollow`, which is UNCHANGED and still used by nothing else — kept for its own tests). `app/page.tsx`'s follow effect rewired; `champ.id` deliberately removed from that effect's dep array (that WAS the bug).
2. **P2 LivePanel churn** — `LIVE_POLL_MS` (`companionClient.ts`) 1000 → 3000. `livePanelModel.ts`'s new `sameLivePanelModel` (order-sensitive shallow compare) used in `LivePanel.tsx`'s tick via the functional `setModel(prev => ...)` form to skip the setState entirely when the derived enemy set is unchanged. Both applied (belt and braces, per brief).
3. **P3 companion CIM cost** — `Get-LcuCredentials` (Get-CimInstance) was still called every 1.5s tick unconditionally, unaffected by the Draft/CompanionProvider work (that's all web-side). Added `Get-LcuCredentialsCached`/`Clear-LcuCredentialsCache` (`public/companion.ps1`) — cached after first discovery, injectable `$Resolver` param for testability. `Invoke-GameflowTick` now calls the cached wrapper and invalidates on a connection-refused (StatusCode 0) or 401 response from either of its two per-tick LCU calls (gameflow-phase, champ-select session). New SelfTest section (#9) proves the resolver is called exactly once across 3 ticks and again exactly once after an explicit invalidation. Companion → **1.4.1**.
4. **Dead-code deletion** — RE-GREPPED repo-wide post-Draft: `isAutoExportEligibleBuild` still has zero real call sites (only its own definition, `itemSetsApply.ts`'s re-export, and its own pinned tests). Deleted the function from `autoExportShared.ts`, the re-export + doc comment from `itemSetsApply.ts`, the 3 orphaned tests from `itemSetsApply.test.ts`, and updated a stale comment in `champSelectFollowState.ts` that referenced it. Left the documented-vestigial `shouldAutoExport` (the OTHER, still-live gate) untouched.
5. **P3s:**
   - (a) transient-probe-failure marks-as-done — RE-CHECKED the current shape (unchanged since the audit, in `BuildTabContent.tsx`): `markAutoExported` fired synchronously BEFORE the async attempt, so a companion-not-connected-yet failure (`outcome.attempted === false`) permanently burned the dedup slot. Fixed cleanly (no in-flight flag needed): moved both items'/runes' `markAutoExported` calls into the `.then()`/`.catch()` resolution, gated on `outcome.attempted` — the existing `tryClaimAutoExportLock` localStorage lock (already claimed synchronously, 30s TTL) already prevents a double-fire in the async window, so this was safe to do without extra state.
   - (b) stale toast champion name — new effect in `BuildTabContent.tsx` clears both `itemsToast`/`runesToast` on `[champ.id, lane]` change. (The message text itself was never wrong — it always named the champion actually exported for, closure-captured at export time — the bug was a toast about an OLD champion lingering on screen after the user moved on.)
   - (c) LivePanel dynamic import — `app/page.tsx`'s `LivePanel` import converted to `next/dynamic({ ssr: false })`.
6. **Draft stale-patch honesty** — added `currentPatch: string | null` to `RecommendMeta` (`lib/draft/recommend.ts`, resolved via `resolveDraftPatchLabel()`/`getLatestPatch()`, fail-soft) alongside the existing `patch` (whatever `resolveServingPatch` actually has ingested) — these can diverge for days since the `/api/ingest/draft` cron is Cloudflare-blocked from reaching u.gg on Vercel's egress IP (HANDOFF's "Vercel-egress probe of stats2" finding, out of scope to fix here). Threaded through `components/live/draftRecommend.ts`'s `DraftRecommendMeta`/normalizer. `app/draft/page.tsx` shows a one-line notice under the patch stamp whenever `currentPatch !== patch` (both non-null) and real data is being shown.

### Files touched

- `components/live/champSelectFollow.ts`, `components/live/champSelectFollowState.ts`, `app/page.tsx` — finding 1.
- `components/live/companionClient.ts`, `components/live/livePanelModel.ts`, `components/live/LivePanel.tsx` — finding 2.
- `public/companion.ps1`, `public/companion.version` — finding 3 (1.4.0 → 1.4.1).
- `components/hextech/autoExportShared.ts`, `components/hextech/itemSetsApply.ts` — finding 4.
- `components/hextech/BuildTabContent.tsx` — findings 5(a)/(b).
- `app/page.tsx` (LivePanel import) — finding 5(c).
- `lib/draft/recommend.ts`, `components/live/draftRecommend.ts`, `app/draft/page.tsx` — finding 6.
- Tests: `components/__tests__/champSelectFollow.test.ts`, `components/__tests__/champSelectFollowState.test.ts`, `components/__tests__/livePanelModel.test.ts`, `components/__tests__/itemSetsApply.test.ts` (removals), `components/__tests__/draftRecommend.test.ts`, `lib/__tests__/draft-recommend.test.ts`, `lib/__tests__/draft-recommend-route.test.ts`.
- `package.json` 0.37.0 → 0.37.1; `CHANGELOG.md` new entry.

### Tests

- `npx vitest run` → **1003/1003 passing** (baseline 973; +30 net across the touched/new test files, minus the 3 deleted `isAutoExportEligibleBuild` cases).
- `npx tsc --noEmit` and `npx tsc -b --force` → both clean.
- `npx next lint` / `npx next build` → clean (only pre-existing `<img>` warnings, same files as before).
- `powershell public/companion.ps1 -SelfTest` → PASSED (incl. new LCU-cache section).
- `powershell public/companion.ps1 -Mock -Once` → PASSED.
- `powershell public/companion.ps1 -HarnessTest` → PASSED (real subprocess, confirms the gameflow-poll loop still ticks with the cached-creds path wired in).

### Known issues / not done

- Did not attempt a live-LCU or live-champ-select repro of finding 1 or 3 (no real League client in this environment) — verified via the pure-function/SelfTest layer only, same posture as every other companion-side change in this repo's history.
- Did not touch the Vercel egress block itself (finding 6's root cause) — out of scope per the brief; the notice is an honesty affordance, not a fix.
- `HANDOFF.md`/`HANDOFF-engy.md` again show pre-existing uncommitted changes in this worktree that are not mine — left untouched, not staged (same as prior rounds).

### Ship

- Version bumped: app **0.37.1**, companion **1.4.1** (`public/companion.version` updated).
- Not yet committed/deployed as of this write-up — see final report for commit/deploy confirmation.
