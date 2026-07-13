<!-- merged into HANDOFF.md 2026-07-13 13:06:22Z; previous content preserved there. Append new rounds below. -->

## v0.28.1 — narrow polish fix on v0.28.0's BootsStackTile (2026-07-13)

**Defect:** boot names clipped mid-word with no ellipsis in `BootsStackTile` (`components/hextech/ProConsensusCard.tsx`) — "Spellslinge Shoes" for Spellslinger's Shoes, visible on the v0.28.0 smoke screenshot (`.smoke-tools/v0280-consensus-card-390.png`) at 390px. Also asked to check: stacked rows top-aligned vs. sibling tiles centering content.

**Root cause (confirmed via DOM measurement, not box-model guessing):** the name span used `line-clamp-1` inside a flex child that only had `min-w-0` (no `flex-1`), so it had no definite width before `-webkit-line-clamp` height computation ran. Measured the button's actual rendered height at 43.75px for what should be ~22px of real content — Chromium's line-clamp+flex intrinsic-sizing goes wrong without a definite width, and the single-line clamp had no room to render an ellipsis in the ~46px column left after the icon (72px cell − 20px icon − 6px gap).

**Fix (`components/hextech/ProConsensusCard.tsx`, `BootsStackTile`, ~line 158-169):** text column span gets `flex-1` added (alongside existing `min-w-0`) to establish a definite width; name span switches from `line-clamp-1` to `line-clamp-2 break-words leading-tight` — same two-line wrap treatment `ItemTile`'s own name span already uses. Result: full text now always renders (verified "Spellsling" / "er's Shoes" on two lines, no characters lost) instead of clipping. Small `mt-0.5` added to the pct/count line for breathing room now that the name can be 2 lines.

**Vertical alignment:** measured boot-stack's first-icon vertical center against the sibling `ItemTile`'s icon center at 390px — within ~6px, i.e. already effectively centered via the existing `justify-center` on the stack's container div. No change made there; the original defect description's "top-aligned" read didn't fully match what I measured (the row already stretches to match sibling height via flex default `align-items: stretch`, and `justify-center` was already present in the shipped v0.28.0 code). Verified this by rendering and measuring rather than trusting the prior description at face value.

**Verification:** `bash scripts/verify-fix.sh` — tsc/lint/548 tests/build/sw/manifest all PASS. Local repro via puppeteer-core + system Chrome (chrome-devtools MCP was profile-locked, same fallback as v0.28.0) at `emulate 390x844x2,mobile,touch` against local dev server (Viktor Mid, real `/api/pros` data, 83-game sample) — before/after screenshots confirm the clip is gone. Prod re-smoke pending in this same session (see below for the deploy this round shipped).

**Scope discipline:** no changes to `proConsensus.ts`'s aggregation model, tap-for-detail wiring (`onOpenDetail`), or any other ProConsensusCard section — CSS/layout only, as scoped.

