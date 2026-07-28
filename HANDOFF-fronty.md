<!-- merged into HANDOFF.md 2026-07-27 22:55:07Z; previous content preserved there. Append new rounds below. -->

## 2026-07-28 — Builds page back-nav P0: back landed on Viktor instead of the hub

**Bug:** `useSheetBackNav`'s `seedInitialSelection` in `app/page.tsx` unconditionally seeded a `kind: "champion"` entry using mount-time `champ` state (still the Viktor seed) — there was never a history entry representing the hub, so `history.back()` from any champion always bottomed out on Viktor. Confirmed live on prod before starting (cleared storage → hub → picked Bard → back() → landed on Viktor).

**Fix implemented exactly as briefed:**
- `components/hextech/homeSearch.ts` — `MainView` gained `{ kind: "prompt" }`. Added `wireViewForPrompt(tab, source)` (the new seed) and `champChosenAfterRestore(kind)` (pure, testable decision the restore path uses — extracted specifically because `app/page.tsx` has no JSX rendering harness). `HomeRestoreState` now carries `kind`. `applyWireMainView` branches on it.
- `app/page.tsx` — `seedInitialSelection` now returns `wireViewForPrompt(...)` unconditionally, so `/`'s base history entry is always the hub. A new effect declared *after* `sheetNav` (`restoredChampionPushedRef` guard, fires once when `lastChampHydrated` flips true) pushes the restored last champion on top when `sessionChosenRef.current` is true, giving `[hub, champion]`. `restoreMainView` now does `setChampChosen(champChosenAfterRestore(applied.kind))` unconditionally — the old Viktor-id special case is gone (it can't happen anymore, since the seed is never a champion now).

**Real bug found and fixed beyond the brief, in the shared `components/useSheetBackNav.ts` hook** (used by both `/` and `/history`): making the restore decision unconditional surfaced a **React 18 StrictMode dev-only double-invoke defect** that pre-dates this change. `next.config.mjs` has `reactStrictMode: true`. On mount, React runs all effects twice against the *same* render (no re-render between). The hook's mount effect reads `window.history.state` live; its first invoke calls `window.history.replaceState(seed)` — a real, un-rolled-back browser mutation. Its *second* invoke then sees that leftover seed and wrongly takes the "resume an existing entry" branch, replaying `onApplySelection` with the stale seed value and clobbering `champChosen` right after the session-restore effect had legitimately set it true. Caught this empirically via puppeteer against `next dev` — the stored-champion case rendered the hub instead of the champion despite `history.state` being correct. Fixed at the root: `useSheetBackNav` now snapshots `window.history.state` once via a ref computed during the first render (same "compute once during render" idiom used elsewhere in this file), so both StrictMode invokes agree. This bug would never surface in a production build (StrictMode double-invoke is dev-only) but was real and worth fixing at the source rather than working around in `page.tsx`. All 1923 tests still pass after this change; `/history` (the hook's other consumer) verified unaffected via puppeteer.

**Verified live via puppeteer against `next dev` (port 3417, `.next` cleared first)** — observed `history.state` at every step, not just screenshots:
- Cleared storage, fresh load: hub renders, `history.state.selection.view.kind === "prompt"`.
- Clicked Bard: pushed entry, `kind: "champion"`, `champ.key: "Bard"`.
- `history.back()`: `kind: "prompt"`, hub renders (not Bard, not Viktor).
- Seeded `coachbuild:lastChampion:v1` with Bard, fresh nav: lands on Bard immediately (`kind: "champion"`), one `back()` reaches the hub.
- Picked Cassiopeia then Darius (via TopBar search, no back in between) → stack `[hub, Cassiopeia, Darius]` → `back()` → Cassiopeia → `back()` → hub. Matches spec exactly.
- Fresh user, nothing stored: hub renders, no push occurs (only one entry exists to back out of).
- Same-tab refresh while on a champion (Cassiopeia): resumes Cassiopeia, `history.length` unchanged (no duplicate push).
- Same-tab refresh while on the hub (despite a stored champion existing): stays on the hub, not bounced to the champion.
- `/history` sanity-checked separately (shared hook) — loads and seeds normally, unaffected.

**Gates:** `npx tsc --noEmit` clean. `npx vitest run` → 1923 passed, 0 failed (was 1919; +4 new: `applyWireMainView` prompt-kind mapping, `wireViewForPrompt`, `champChosenAfterRestore` true/false — the explicit "back from a champion lands on the prompt view" regression pin). `npm run lint` clean (pre-existing `<img>` warnings only, unrelated).

**Not done:** version not bumped, nothing committed/deployed, per instructions.

Files touched: `components/hextech/homeSearch.ts`, `app/page.tsx`, `components/useSheetBackNav.ts`, `components/__tests__/homeSearch.test.ts`.

