<!-- merged into HANDOFF.md 2026-07-26 18:06:31Z; previous content preserved there. Append new rounds below. -->

## v0.63.2 (fronty, sonnet) — Pro Consensus sprawl + RUNES/ITEM BUILD column flip

Built on top of the (already-committed-to-disk, uncommitted) v0.63.1 bottom-rag fix — did not touch its `'pro_pro'` full-width-row area map or `RunesSummonersCard`'s `lg:h-full`, both stay.

**Fix 1 — Pro Consensus sprawl (`components/hextech/ProConsensusCard.tsx`).** At `lg`+ the card's row went from ~466px (old narrow right column) to 1138px (new full-width row), but the content was never adapted: the ITEMS block (flex-wrap) only ever needed ~480px, leaving ~45% of the row empty; the rune/summoner grid used fixed `md:grid-cols-[1.5fr_1.1fr_auto]`, which stretched Primary/Secondary apart from Summoners with large arbitrary gaps unrelated to actual content.

Chose **a real two-column split** over a max-width constrain (approach B in the brief), because a centered/left-aligned max-width just relocates the dead space rather than removing it. At `lg`+ only: Starting+Items become the left column (`lg:grid-cols-[5fr_7fr]`, items ~40%), the rune/summoner grid becomes the right column (~60%). Below `lg` the wrapper carries zero un-prefixed grid/flex classes — plain block stack, byte-identical to before.

Also changed the inner rune/summoner grid from `md:grid-cols-[1.5fr_1.1fr_auto]` (unconditional) to add `lg:grid-cols-[auto_auto_auto] lg:justify-start` (lg-only override). **Verified via computed style, not box-model guessing**: with 3 `auto` tracks and no `fr` track, Chrome's grid sizing algorithm still distributes the container's free space across the 3 columns in the Maximize Tracks step — but proportional to each column's own max-content weight, not the old arbitrary 1.5:1.1:auto ratio. `getComputedStyle(...).gridTemplateColumns` showed fractional pixel track sizes (e.g. `189.859px 212px 153.641px`) summing exactly to the container width across all 3 test champions — confirms it's real content-weighted distribution, not leftover-collects-at-the-end as I originally assumed (comment corrected in the code to match).

Screenshot + pixel-measured (`getBoundingClientRect`) on all three required champion shapes at 1440x900:
- Brand support (63/4, has the support-item OR stack): items wrap 5+1 in the left column, rune group (Sorcery/Precision/Summoners) fills the right column evenly, no dead voids.
- Viktor mid (112/2, no support block): same composition holds, Resolve/Sorcery/Summoners spread evenly.
- Ornn top (516/0): same, no overflow, no sprawl.

**Fix 2 — RUNES/ITEM BUILD column proportion (`components/hextech/BuildTabContent.tsx`).** `BUILD_GRID_CLASS`'s `lg:grid-cols-[7fr_5fr]` flipped to **`lg:grid-cols-[5fr_7fr]`** (RUNES now narrower at ~466px, ITEM BUILD wider at ~652px). Measured BOTH orderings directly on Brand support before deciding, not just reasoned about:
- At `7fr_5fr` (old): row-1 height 804px, RunesSummonersCard content height ~243px (content-grid measured, excludes header) → ~490px dead space under RUNES.
- At `5fr_7fr` (new): row-1 height 674px, RunesSummonersCard content height ~448px → ~155px dead space. **Both metrics improved simultaneously** — RUNES' content wraps more at the narrower width (closing its own gap), AND ItemBuildCard renders MORE compactly with more width (fewer forced item-row wraps), shrinking row height by 130px. Not a tradeoff — the old 7fr/5fr split was actively working against both cards.
- Verified bottom-rag still holds after the flip: both cards measured to the same height/bottom pixel (0px gap) on all three champions, since `RunesSummonersCard`'s `lg:h-full` still stretches to match whatever ItemBuildCard's content now drives.
- Viktor (more situational items -> taller ItemBuildCard) leaves a bigger residual RUNES gap (~238px) than Brand (~155px) since RunesSummonersCard's own content is roughly fixed regardless of champion — expected, still far better than the ~490px+ baseline.

**Constraints honored:**
- Mobile (390x844): re-measured `document.documentElement.scrollHeight` — BUILD tab 2031, PRO tab 1688. **Identical to the stated baseline**, confirming zero mobile regression (all changes are `lg:`-prefixed only; the mobile card stack never touches the new classes).
- Did not touch `/compact`.
- Did not invent new content — no new stats/filler modules added anywhere.
- Did not bump version, edit CHANGELOG, commit, or deploy.
- Used the already-running dev server on port 3001 (chrome-devtools MCP, `new_page`/`emulate` for viewport control — `resize_page` didn't actually resize the OS window in this environment, `emulate({viewport: "390x844x2,mobile,touch"})` was the reliable path).

**verify-fix.sh: ALL CHECKS PASSED** (tsc clean, lint 0 warnings, 1618 tests passed, build clean, sw/manifest versioned).

**Left alone deliberately:** the floating "Update ready / Refresh" dev-server toast that overlaps the ITEM BUILD card's SITUATIONAL label in the Viktor/Ornn screenshots — pre-existing HMR/SW-update banner (`position: fixed`, unrelated to this task's grid changes), not a regression from this change; did not investigate further since it's a dev-only artifact tied to me editing files, not a layout bug.
