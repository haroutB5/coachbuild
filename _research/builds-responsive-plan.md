# Builds Page Responsive Overhaul — Implementation Plan

> Authored by the opus Plan agent 2026-07-21 (persisted verbatim by urgot — planner is read-only).
> Target: route `/` (Hextech shell). HEAD v0.42.0; ships as v0.44.0 AFTER the in-flight v0.43.0 lands.

## 0. Summary
Route `/` renders the desktop composition scaled down on mobile: root is `min-h-screen lg:flex` with two `Sidebar` instances (a `collapsed` full-width top bar `lg:hidden`, and a `w-[220px]` left column `hidden lg:flex`), and a `<main>` whose inner content is capped at `max-w-[900px] mx-auto`. That single cap is why desktop wastes width; the mobile top bar plus an overflowing rank control is why mobile reads as "squeezed." Pure composition/CSS change. No data/API/scoring/back-nav changes. Hextech gold theme unchanged (NOT the /draft cyan). Two stages: Stage 1 mobile fix, Stage 2 desktop composition.

## 1. Root-cause findings
- **Mobile right-edge gap (defect 1) + rank clip (defect 2) are the SAME bug.** `BuildTabContent.RankBracketSelector` renders `SegmentedControl` — single `inline-flex` track, no wrap, no scroll. `RANK_BRACKETS` has 7 entries; seven pills far exceed 390px → document scroll-width > 390 → the `w-full` collapsed Sidebar and `<main>` paint to 390 while the page scrolls wider, exposing the `bg` void right of the sidebar. Fix the control's overflow and the gap resolves. All other Build-tab cards use `flex flex-wrap` and do NOT overflow at 390 — the segmented control is the sole horizontal-overflow source.
- **Runes dead space (defect 3):** `RunesSummonersCard` grid `grid-cols-1 md:grid-cols-[1.5fr_1.1fr_auto]` — fr columns stretch while small left-packed tiles don't, leaving stretch gap; summoner `auto` col floats far right. RuneTile has no enforced consistent width → ragged label wraps. Internal regrid required.
- **Desktop underuse:** entirely `max-w-[900px] mx-auto` on `<main>`'s inner wrapper (app/page.tsx:599). All cards single-column except the Starting/Core `md:grid-cols-3` pair.
- **"Skill grid" doesn't exist on the Build tab** (skill order only exists on soloq ProGame rows). Do NOT invent a card; pair Pro Consensus with SituationalCard instead.

## 2. Mobile (≤sm)
### 2a. Full-bleed header (Sidebar `collapsed` branch)
Row 1: wordmark (shrink-0) + SidebarChampionSearch (`flex-1 min-w-0`, drop `max-w-[240px]`) + new "More ▾" trigger (shrink-0). Row 2: LANES `grid grid-cols-5` (unchanged, fits since v0.27.0). REMOVE the dotted utility-links row (collapsed block ~lines 203-242) — links move to the overflow menu.
### 2b. Utility links → overflow menu (decision: menu, NOT scroll row)
5 equal-weight cross-route Links; a dotted scroll row keeps them cramped with sub-44px targets. New `components/hextech/MobileNavMenu.tsx`: local useState disclosure ONLY — **no useSheetBackNav, no pushState** (popovers aren't a nav step, gotcha (p)); links are ordinary Next `<Link>`s. Reuse SidebarChampionSearch's outside-click (`mousedown` on containerRef) + Escape pattern; `aria-haspopup="menu" aria-expanded`; focus returns to trigger on close; NO useBodyScrollLock. Links render from the shared registry (§4 navLinks).
### 2c. Rank bracket — horizontal scroll-snap (decision: NOT 2-row wrap)
7 uneven pills wrap to a ragged 4+3 costing 2 rows; scroll keeps one line. The current failure is no scroll AFFORDANCE → add right-edge gradient fade mask (~24px, `pointer-events-none bg-gradient-to-l from-bg`) + snap. Extend `SegmentedControl` with additive prop `layout?: "inline" | "scroll"` (default "inline" — all existing callers unaffected: /history, ProBuildsTab, mode toggles). "scroll": track `flex w-full overflow-x-auto snap-x scroll-px-1 [scrollbar-width:none]`, buttons `flex-shrink-0 snap-start`. No smooth scroll (reduced-motion-safe by construction). RankBracketSelector: `<sm` label stacked above full-width scroll control; `sm+` inline right-aligned (single `"scroll"` render is fine — degrades to normal row when content fits).
### 2d. Runes card regrid (internal markup only)
Replace fr-stretch: `grid-cols-2 gap-x-6 gap-y-5 md:grid-cols-[auto_auto_auto] md:justify-start md:gap-x-10`. Mobile: primary+secondary trees side-by-side (tiles ~64-68px, two fit at 390), summoners full-width third row (`col-span-2`) — roughly halves card height. Uniform RuneTile rule: `w-[64px]`, name `text-[10px] leading-tight line-clamp-2 min-h-[28px] break-words` applied identically everywhere. Summoners: `flex flex-row gap-2 col-span-2 md:flex-col md:col-span-1 md:justify-center`. ApplyRunesButton/ItemSetsButton LOGIC untouched (they import v0.43.0-frozen modules; only the card's layout grid changes).
### 2e. Systematic 390px audit
Starting/Core/Situational/ProConsensus confirmed non-offenders (flex-wrap). Add defensive `overflow-x-clip` on the `<main>` CONTENT WRAPPER only (never the root or any ancestor of fixed overlays — GameDetailSheet backdrop is `fixed inset-0 z-[100]`; `<main>` has no fixed descendants). The `md:grid-cols-3` Starting/Core sub-grid is superseded by §3c.

## 3. Desktop (≥lg)
### 3a. Free the width
`<main>` inner wrapper: `max-w-[900px] mx-auto` → `max-w-[900px] lg:max-w-none xl:max-w-[1440px] lg:mx-0 xl:mx-auto`. **Only JSX-layout change in app/page.tsx; touch NOTHING above the `return`.**
### 3b. Persistent sidebar
The `hidden lg:flex w-[220px]` Sidebar stays (v0.21 IA). Desktop footer links render from the shared registry so mobile/desktop never drift.
### 3c. Build-tab 2-column composition (ok branch only)
```
<lg: single column, current order.
≥lg: <div className="lg:grid lg:grid-cols-12 lg:gap-5">
  Left  (lg:col-span-7, space-y-5): RunesSummonersCard, CoreBuildOrderCard
  Right (lg:col-span-5, space-y-5): StartingCard, ProConsensusCard, SituationalCard
```
Retire the old `md:grid-cols-3` Starting/Core sub-grid. Hero/HextechTabs/RankBracketSelector full-width above.
### 3d. State re-homing
loading/empty/error early-returns stay FULL-WIDTH (grid wraps only the ok branch). BuildLoadingSkeleton gets a mirrored lg:grid variant (no reflow on resolve). ProConsensusCard hidden→null collapses its cell cleanly. Rank selector renders in every fetch state (must survive empty/error so bracket switching stays possible).
### 3e. Placement: hero full-width; tabs full-width tablist; rank bracket `sm+` inline right-aligned above grid, `<sm` per §2c.

## 4. Pinned contracts
```ts
// SegmentedControl — ADDITIVE
layout?: "inline" | "scroll";   // default "inline"
// components/hextech/MobileNavMenu.tsx — NEW (fronty)
interface MobileNavMenuProps { patch: string | null; }
// components/hextech/navLinks.ts — NEW pure module (engo)
export interface NavLink { href: string; label: string; }
export const NAV_LINKS: NavLink[]; // /history, /movers, /live-setup, /draft, /mystats
```
RunesSummonersCard + BuildTabContent public props UNCHANGED. Sidebar props unchanged; collapsed branch swaps inline utility row → `<MobileNavMenu patch={patch}/>`; desktop branch reads NAV_LINKS.

## 5. File-by-file / split
fronty: app/page.tsx (wrapper classes only), Sidebar.tsx, MobileNavMenu.tsx (new), BuildTabContent.tsx, RunesSummonersCard.tsx, SegmentedControl.tsx.
engo: navLinks.ts (new), optional buildTabLayout.ts (pure left/right column membership helper), navLinks.test.ts + buildTabLayout.test.ts.
**FROZEN (v0.43.0 in flight): itemSetBody.ts, itemSetsApply.ts, companionClient.ts error-paths, app/live-setup/**.**

## 6. Test plan (pure .ts)
navLinks.test.ts: exact 5 {href,label} pairs, exact routes, no dupes. buildTabLayout.test.ts: left=[runes,core], right=[starting,proConsensus,situational], every card exactly once. SegmentedControl layout prop is presentational → covered by puppeteer. Full vitest stays green.

## 7. Risk register
- app/page.tsx effects LOAD-BEARING (deep-link mount, companion.tick follow, sheetNav, handlers) — byte-identical; edit confined to the `<main>` wrapper class string; do NOT reorder/re-prop the two Sidebar renders (shared searchMode/selectedPlayer across breakpoint).
- No new history entries (MobileNavMenu = local state; pushState here corrupts back-nav, gotchas (n)/(p)).
- overflow-x-clip placement per §2e (fixed-overlay clipping hazard).
- SegmentedControl shared — layout MUST default "inline"; regression-check /history + ProBuildsTab + mode toggles.
- Reduced motion: no JS smooth scroll; edge fade is a static gradient.
- Verify RunesSummonersCard companion wiring unchanged post-regrid.
- Rune 2-col at 390: keystone w-14 + minors fit ~180px half-column (tiles w-[64px] wrap) — puppeteer-verify.

## 8. Staged ship
Stage 1 mobile (higher pain): §2 + SegmentedControl prop + MobileNavMenu + navLinks. Stage 2 desktop: §3 + buildTabLayout. No flags; each stage revertable. Ship v0.44.0 after v0.43.0 lands.

## 9. Puppeteer acceptance (emulate, NEVER resize_page)
Mobile 390x844: (1) no horizontal scroll (documentElement.scrollWidth<=clientWidth) — the defect-1/2 gate; (2) 7 rank pills, track scrollable with right-edge fade, "High Elo" single-line, no flush clipping; (3) header bg spans full width (no right void); (4) dotted row gone, More menu opens with all 5 links ≥~40px tall, Escape/outside-click closes, focus returns; (5) runes card height reduced vs baseline, trees side-by-side, labels clamp ≤2 lines, no dead space; (6) other cards no overflow; (7) reduced-motion: no smooth scroll/animated transitions.
Desktop 1280x800 + 1440x900: (8) 220px sidebar + content fills width (not capped at 900); (9) genuine 2-col grid per §3c, hero full-width; (10) no runes dead space; (11) skeleton mirrors grid (no reflow), empty/error full-width, ProConsensus hidden collapses cleanly; (12) BUILD↔PRO BUILDS tabs work, Back after champion search restores prior view, Apply buttons render with seeded session.
Both: zero console errors; vitest green.
