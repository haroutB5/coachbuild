<!-- merged into HANDOFF.md 2026-07-24 14:43:02Z; previous content preserved there. Append new rounds below. -->

## 2026-07-26 — Mobile BUILD | PRO segmented control on the Builds page

Fixed the ~3,000px single mobile scroll (Runes -> Starting -> Support -> Core
-> Optimized -> Situational -> Pro Consensus) by splitting it into a
BUILD | PRO tab pair, mobile only (`lg:hidden`, matching BUILD_GRID_CLASS's
own existing breakpoint). Default tab is BUILD. Desktop (`lg`+) is untouched —
verified pixel-identical at 1440x900, no control rendered, both blocks still
in the existing 2-column composition.

**Files changed:**
- `components/hextech/HextechTabs.tsx` — generalized. This component's
  render call sites were ALL gone (grep-verified) after the v0.51.0 D1
  retirement of the "/" BUILD/PRO BUILDS mode toggle — only its `HextechTab`
  type was still imported (app/page.tsx's `FIXED_TAB`, homeSearch.ts's
  `WireMainView`). Changed the default export from a hardcoded build/
  proBuilds pair to a generic `options` list (same generics pattern
  SegmentedControl.tsx already uses), so it could be reused for THIS
  unrelated BUILD/PRO pair without a second hand-rolled tab primitive. The
  `HextechTab` type export is untouched — no risk to the existing type
  imports. Added `id`/`aria-controls` (auto-derived from each option's
  `value`: `hextech-tab-<value>` / `hextech-tabpanel-<value>`) and bumped
  the button to `min-h-[44px]` (the original py-3/text-[13px] combo landed
  under 44px — v0.61.0's touch-target fix would have regressed here
  otherwise). Added `motion-reduce:transition-none` on the color transition.
- `components/hextech/BuildTabContent.tsx` — added `mobileTab` state
  (`"build" | "pro"`, defaults `"build"`), renders `<HextechTabs>` in an
  `lg:hidden` wrapper above `BUILD_GRID_CLASS`, and added conditional
  `hidden lg:block` classes (the codebase's standard responsive-visibility
  idiom, same mechanism as any `hidden sm:block`) to the three existing
  `[grid-area:*]` wrapper divs (runes, itembuild, pro) instead of building
  a new panel structure — same class-toggle approach the file already used
  for the 1-col/2-col grid switch.

**Existing control reused:** HextechTabs (generalized), not SegmentedControl.
The role selector (TOP/JG/MID/BOT/SUP) uses SegmentedControl — a pill-in-
track `role="group"` widget with `aria-pressed`, not real tab semantics.
HextechTabs already had `role="tablist"`/`role="tab"`/`aria-selected` (built
for the ORIGINAL Build/Pro Builds page-level toggle, later retired) — the
better-matched primitive for a task that explicitly required "a real tab
interface... not decorative." Kept the hextech gold-underline visual
language byte-identical to its prior look, just made the tab list generic.

**Mount-vs-visibility:** kept ALL THREE cards (RunesSummonersCard,
ItemBuildCard, ProConsensusCard) mounted at all times; only CSS visibility
(`hidden`/`display:none`) toggles per `mobileTab`. Verified via
chrome-devtools network log: `/api/pros` fires exactly once on initial load
(2 requests total incl. item-meta fetch) and does NOT re-fire after
BUILD -> PRO -> BUILD. Did not attempt conditional unmounting — no evidence
mount cost here is free (ProConsensusCard's fetch/effect chain + name
resolution is nontrivial), and the constraint explicitly steered toward
"keep both mounted" as the default.

**A11y:** `role="tablist"`/`role="tab"`/`aria-selected` via HextechTabs
(confirmed in Chrome's own a11y-tree snapshot: `tab "BUILD" selectable
selected` / `tab "PRO" selectable`). Each `[grid-area:*]` wrapper carries
`role="tabpanel"` + `aria-labelledby` pointing at the matching tab's
auto-generated id. One deliberate, disclosed deviation from the textbook
1-tab:1-panel ARIA pattern: the BUILD tab controls TWO physical wrapper
divs (runes + itembuild — they can't be merged into one panel element
without breaking the desktop 2-column grid-template-areas, where runes
spans both rows on the left while itembuild/pro stack independently on the
right), so `aria-labelledby="hextech-tab-build"` is applied to both,
sharing one id given to only the first. A second disclosed trade-off: since
these wrapper divs stay mounted (not remounted) at every breakpoint, their
`role="tabpanel"`/`aria-labelledby` attributes are present even at desktop,
where the tablist itself is `lg:hidden` (i.e. removed from the a11y tree) —
so at `lg`+ the `aria-labelledby` reference is inert (points at an id not in
the a11y tree) rather than semantically wrong. Considered gating the ARIA
attributes behind a `matchMedia`-driven "isMobile" boolean to avoid this,
rejected it — adds an SSR/CSR hydration-mismatch risk (classic Next.js
viewport-at-mount gotcha) for a cosmetic ARIA-purity gain on a breakpoint
where the control isn't even visible. Flagging here in case a future a11y
audit wants it done properly.

Not done: did not add the tab control to the "loading"/"empty"/"error"
branches of BuildTabContent's render — `BuildLoadingSkeleton` still shows
the old single fixed 3-box skeleton at every breakpoint. The control only
appears in the "ok" branch once real content exists to switch between.
Chose not to touch the skeleton since the height problem this task fixes
is specifically about the LOADED page's scroll length, and adding tab
plumbing to a data-less skeleton state seemed like unrequested scope.

**Verify-fix.sh:** ALL CHECKS PASSED (tsc clean, lint 0 warnings, 1618
tests passed, build clean, sw/manifest versioned).

**Browser verification (390px, `/?championId=63&role=4`, Brand support —
chosen because its Pro Consensus card has the support-item OR divider
called out in the brief):**
- BUILD tab is the default on load (confirmed via a11y snapshot:
  `tab "BUILD" ... selected`).
- Switching to PRO renders the Pro Consensus card, including the
  Zaz'Zak's Realmspike / Solstice Sleigh "or" divider — survived the move
  intact.
- Switching PRO -> BUILD -> PRO fired ZERO additional `/api/pros` or
  `/api/build` requests (network log identical request-id set before/after).
- Tab buttons measured 44px tall via `getBoundingClientRect()` (was ~40px
  before the `min-h-[44px]` fix).
- No console errors/warnings on load or on tab switching.
- Desktop (1440x900): tablist computed `display: none`; screenshot confirms
  the pre-existing 2-column composition unchanged (Runes left, Item Build
  top-right, Pro Consensus bottom-right).

**Mobile scroll height (390px, Brand support, `document.body.scrollHeight`):**
- Before (both sections forced visible, simulating the old always-stacked
  layout): **2,861px**.
- After — BUILD tab (default): **1,847px**.
- After — PRO tab: **1,687px**.

Did NOT bump version/CHANGELOG/commit/deploy per the standing instruction —
left that to the user.
