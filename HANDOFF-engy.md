<!-- merged into HANDOFF.md 2026-07-21 19:55:50Z; previous content preserved there. Append new rounds below. -->

## v0.41.0 — champ-select auto-export lifted to the app-wide companion layer (engy, 2026-07-21)

**Bug (real Practice Tool game):** picked Viktor, in-client rune page stayed on a previous game's "CoachBuild Nasus Jungle" — no auto-import fired. Confirmed the orchestrator's root cause against the source: `autoApplyRunesIfEligible`/`autoApplyItemSetsIfEligible` were mounted ONLY in `components/hextech/BuildTabContent.tsx`, which fetches `/api/build` and runs the export effect only when the **Builds page** (`/`, tab==="build") is showing. Since companion 1.5.0 the user drafts from `/draft`, which suppresses opening the Builds page — so nothing ever fetched the picked champion's build and nothing exported. The side-effect chain was implicitly anchored to the Builds page being mounted.

**What I did:**
- **New `components/live/autoExport.ts`** (pure logic + injectable effect body): `resolveAutoExportTarget(phase, champSelect)` (pure trigger → `{championId, roleId}`), `resolveTargetLane(target, getMostPlayed)` (role-bearing → `roleIdToLane`; role-less → most-played fallback), and `executeAutoExport(championId, laneId, deps)` — the async fetch→identity-guard→dedup→apply→mark→toast body, every collaborator injected.
- **New `components/live/AutoExporter.tsx`** — headless component mounted inside `CompanionProvider` (`app/layout.tsx`), keyed on `companion.tick`. Owns the React glue: per-tick trigger, a request-id generation counter backing the identity guard, an in-flight set (keyed by championId), a per-champion most-played-lane memo, the `/api/build` fetch (same endpoint/params/rank-bracket rule as `BuildTabContent.load()`), and an app-wide fixed toast overlay.
- **Removed** `BuildTabContent`'s auto-export effect, the stale-toast-clear effect, the two toast states, the toast JSX, and all now-unused imports. Exactly one owner.
- **Mounted** `<AutoExporter />` in `app/layout.tsx` (inside `CompanionProvider`, alongside `{children}`).
- **Tests:** `components/__tests__/autoExport.test.ts`, 17 new.

**Exact files touched:**
- Added: `components/live/autoExport.ts`, `components/live/AutoExporter.tsx`, `components/__tests__/autoExport.test.ts`
- Modified: `app/layout.tsx`, `components/hextech/BuildTabContent.tsx`, `CHANGELOG.md`, `package.json` (0.40.0 → 0.41.0)

**Design decisions / why:**
- **App-wide mount works where per-page didn't** because the root layout persists across client nav (`/` ↔ `/draft`), so the exporter's refs (gen counter, in-flight set, lane memo) survive the whole champ-select. Load-bearing — documented in the component header.
- **Reused, never re-implemented:** the 3-way champion/role resolution (`resolveCurrentChampSelectChampionId`/`resolveChampSelectRoleId`), the `champSelectFollowState` dedup (latest-wins `(championId,laneId)` per kind, the multi-tab localStorage lock, `markAutoExported` deferred until AFTER an attempt), and the SAME `autoApplyItemSetsIfEligible`/`autoApplyRunesIfEligible` pipelines the manual buttons use.
- **`isCompanionDriven` still gates** — but the champ-select champion is marked driven by `CompanionProvider` every tick (unconditional, its Round-B P1 fix), so the gate passes on `/draft`/any route without depending on `app/page.tsx`'s page-specific follow effect.
- **Identity guard (v0.36 lesson):** two mechanisms, either sufficient for a champion-change-mid-fetch: (a) the generation counter (a newer kickoff bumps it; the stale run's post-fetch check fails), and (b) an explicit `getCurrentChampSelectChampionId() === championId` check at consume time. The stale run returns BEFORE `shouldExportForLane`/`claimLock`/`markExported` are touched, so no dedup slot is consumed — pinned by a test that then runs a fresh export for the same pair and confirms it fires.
- **Role fallback:** Practice Tool carries no `assignedPosition` (`roleId: null`), so `resolveChampSelectRoleId` returns undefined → `getMostPlayedLane(112)` → mid. If most-played resolves null (a champion with zero data anywhere, where `/api/build` would 404 too) the run skips — documented, not silent.
- **Toasts:** moved to a fixed `z-[200]` overlay (`bg-panel` solid so it reads over arbitrary page content), since the export now fires on routes with no Builds-page panel to host the old inline toast. Same message text + 6s dismiss + `.catch()`-into-error-toast hardening as the old effect.
- **Rank bracket:** the fetch honors the user's persisted `readStoredRankBracketId()` and keeps the historical default request byte-identical (rank only appended when non-default) — faithful to `BuildTabContent.load()`.

**Adjacent things I noticed but did NOT fix (out of scope):**
- `app/page.tsx`'s live-follow effect still marks `markCompanionDriven` redundantly with the provider (harmless, idempotent, pre-existing) — left as-is.
- The role-less-then-lane-change-for-SAME-champion mid-fetch case (e.g. Senna Bot→Support while a Senna fetch is in flight) is caught one tick later rather than instantly, because the in-flight guard is keyed on championId only. Champion CHANGES (the actual user bug + the spec's mid-fetch test) are caught immediately since different champions aren't blocked. This self-heals within one 3s tick and never corrupts the per-lane dedup; I judged an instant lane-change-mid-fetch guard not worth the added complexity. Flagged rather than buried.
- `getMostPlayedLane` fires 5 `/api/hero-stats` calls; memoized per-champion in the component so it runs once per champion per session, not every 3s tick.

**Post-deploy real-device confirm should look like:** open `/draft` (or any CoachBuild route) with the companion paired and auto-toggles on, enter a Practice Tool, pick Viktor (no assigned role). Within a poll tick or two a success toast appears ("Runes applied for Viktor." / "Item build added for Viktor — check your shop in game.") and the in-client rune page + item set update to CoachBuild's Viktor Mid — NOT a stale previous-game page. Change champion mid-select → the new champion re-exports (latest-wins). Confirm the Builds page open at the same time does NOT double-push (single export). Verify toggles off on `/live-setup` suppress the respective export.

**HOLD DEPLOY honored:** implemented → `verify-fix.sh` clean (1209 tests, baseline 1192 + 17) → bumped 0.41.0 + CHANGELOG → committed locally as harout_b5@live.com → STOPPED. Did NOT run vercel. Diff is ready for the read-only audit.
