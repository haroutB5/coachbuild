<!-- merged into HANDOFF.md 2026-07-29 11:42:21Z; previous content preserved there. Append new rounds below. -->

## Round: build-slot tap targets + the three unverified requirements (fronty, 2026-07-29)

Scope taken: `.tsx` only. `lib/**` and `components/hextech/itemSetBody.ts` / `proConsensus.ts`
(non-JSX `.ts`) were another engineer's, and were left alone.

Files changed:
- `components/hextech/BuildSlotList.tsx`
- `components/hextech/FeaturedOtpCard.tsx` (one row, see requirement 3)

### The stalled note was STALE — read this before re-doing the work

The previous agent's last note said the tap target was 17px and that it was "making the whole row
the target". It had ALREADY made that change before it stopped. `Row` was already the `<button>`,
already `w-full`. Measured on the tree as I received it, at 390x844x3 mobile emulation, Ahri mid:

| | before this round | after |
|---|---|---|
| go-to row (Pro card, interactive) | 316 x **46** | 316 x **46** |
| alternative row (Pro card, interactive) | 259 x **32** | 259 x **44** |
| go-to row (OTP card, non-interactive) | 324 x **46** | 324 x **46** |
| alternative row (OTP card, non-interactive) | 267 x **32** | 267 x **44** |

So the real remaining defect was not 17px, it was the ALTERNATIVE row at 32px — 12px under the
44px guideline — plus the fact that both heights were content-derived accidents rather than floors.

### What changed

1. `min-h-[46px]` on the go-to row, `min-h-[44px]` on the alternative row. The go-to already
   measured 46px, but only because its content happens to be two lines (name+pct, then bar+
   fraction). A shorter name, a dropped fraction or a font swap could have shrunk it back under
   the line silently. It is a floor now, not a by-product.
2. Alternative spacing `space-y-1.5` -> `space-y-0.5`. The height the 44px floor cost is bought
   back from the gap BETWEEN alternatives, which is the right place to take it from: two adjacent
   44px targets with a 2px seam miss less than two 32px targets with a 6px gap. Net cost is +8px
   per alternative row, not +12px.
3. `FeaturedOtpCard.tsx`'s "Opens" starter row now prints its fraction (`26/37`) beside the
   percentage, with the slash `aria-hidden` and the words supplied — the same `Fraction` shape
   BuildSlotList uses. See requirement 3 below for why.

The `Row` doc comment carried the old "these heights are a deliberate trade under 44px" paragraph.
That is now replaced with the second measurement and what it produced, so the next reader is not
told a stale rationale for a number that no longer holds.

### Evidence

**Tap target, measured not reasoned.** Chrome, `390x844x3,mobile,touch`, `npx next start -p 4733`
off a clean `next build`. Note: `resize_page` alone did NOT take (innerWidth stayed 500) — device
emulation via `emulate` is what actually produced a 390px layout viewport. Anything measured with
`resize_page` alone on this app should be re-measured.

**Clicks land, not just geometry.** 7-point `elementFromPoint` edge scan (4 corners, centre, both
mid-edges) over all 11 visible interactive rows on the Pro card: **77/77 probes landed inside their
own button, 0 misses.** Then a real `click` dispatched at the bottom-LEFT corner of the "or
Blackfire Torch" alternative row — deliberately away from the item name, on the part of the row
that used to be dead — opened the correct item popover (`role="dialog"`, text "Blackfire Torch
2,800 gold ...").

**No horizontal overflow.** `document.documentElement.scrollWidth === 390 === innerWidth`.

### Requirement 1 — the go-to IS visually dominant. Confirmed.

Computed styles pulled off the live DOM, one contested slot (Crimson Lucidity / Spellslinger's
Shoes, Pro card, 390px):

| axis | go-to | alternative |
|---|---|---|
| icon | 34px | 20px (2.9x the area) |
| name | 13px / weight 500 / `rgb(236,231,222)` | 11.5px / weight 400 / `rgb(131,141,132)` |
| percentage | 12.5px / weight 600 / bright | 11.5px / weight 600 / muted |
| left edge | x=33 | x=90 (57px indent) |
| binding rail | none | 1px left border, present only when contested |
| words | — | literal visible "or" prefix |

Six independent axes, none of them colour, none of them load-bearing alone. Screenshot at 390px
read directly: the go-to reads as the row and the alternative reads as a footnote to it, not as a
second item to buy.

### Requirement 2 — a settled slot renders plainly. Confirmed.

Live DOM, Rabadon's Deathcap (Pro card, `alternatives: []`):
`hasAltUl: false`, no `ul[aria-label]`, no left rail, no "or", `li` height **46px** — i.e. exactly
the go-to row and nothing else. Full text content is `Rabadon's Deathcap 29% 58/200`. No empty
tail, no reserved space. Verified again visually on the OTP card (Zhonya's Hourglass 38% 14/37,
screenshot) — it is an ordinary item row.

### Requirement 3 — sampleGames beside every percentage. Confirmed, after ONE fix.

Swept every leaf element containing `%` across both cards at 390px.

Already correct: every BuildSlotList row (`84% 31/37` + `sr-only " in 31 of 37 games"`, on go-to
AND alternative), runes (`49% of 37 games`), summoners (`57% of 37 games`), Pro-card runes
(`93% 186/199`, `58% · 109/187`), hero band (`50.9% WIN · 352,948 GAMES`), KPI strip (career win
rate 62% sits beside CAREER GAMES 409, and the labels say "career" so the two denominators cannot
be confused — this file's own header rule).

**The one exception, now fixed:** FeaturedOtpCard's "Opens" starter row printed `70%` alone. Its
denominator existed only in the section heading meta three lines up ("37 stored games · 54% won").
That satisfies the section-level convention, but it was the single percentage on the card
travelling without its own fraction while every slot row below it printed one. It now reads
`Opens · Dark Seal · 70% · 26/37`. Measured after: row height unchanged at 49px, no wrap, no
overflow.

### Accessibility — unchanged and still intact

The "these compete for one slot" relationship survives without colour or size: alternatives sit in
a nested `<ul aria-label="Built instead of <go-to> in this slot">`, every entry carries the literal
visible word "or" (real text, not an aria-label — survives CSS failing to load), and each
interactive row's `aria-label` restates "built instead of <go-to> in this slot" because a button's
label replaces its inner text. Verified on the live DOM: 7 labelled sub-lists present on Ahri mid.

### Thin-sample floor — not regressed. Verified live.

Found a real thin-sample case rather than reasoning about it: Lee Sin (championId 64) has **7**
stored games for its featured one-trick. At `/?championId=64&role=1`, OTP tab: 0 slot lists
rendered, no Opens row, no build percentages anywhere. Only the hero win rate (with its GAMES
count) and the labelled CAREER KPIs. The card shows WHO the player is (apex predator#of jg,
Grandmaster, 2097 LP, EUW1) plus "Still collecting their games — we hold 7 of the 12 needed".
My Opens-row edit sits inside the `!thinSample` branch, so it cannot leak into this state.

### Gate

`bash scripts/verify-fix.sh C:/Claude/AI/coachbuild` -> **ALL CHECKS PASSED** (tsc clean, lint 0
warnings, 2068 tests passed, build clean, sw versioned, manifest present).

Worth knowing for the merge: the gate FAILED twice on the way here, both times on
`components/hextech/itemSetBody.ts` mid-edit by the other engineer (first a missing
`@/lib/bootsItems` import, then a `downlevelIteration` error), never on my files. It passed on the
third run once that file settled. If it fails again on that file, it is not this round.

### Not verified / left open

- **No `prefers-reduced-motion` check.** Nothing I touched animates; the rows' only motion is the
  pre-existing `active:scale-[0.99]` and a colour transition. Not measured either way.
- **No Lighthouse / CLS number.** The skeleton in FeaturedOtpCard renders `h-10` placeholder rows
  against real rows at 46px — a pre-existing ~6px-per-row difference that my change does not touch
  (it affects go-to rows, which did not change height). I did not measure the resulting CLS.
- **Desktop (lg) not re-measured.** All numbers above are 390px. The Pro card is full width at lg
  and the rows will be much wider there; height should be unaffected but I did not confirm it.
- **Only Ahri mid and Lee Sin jungle were rendered.** A slot with 3+ alternatives (the deepest
  measured here was 1 alternative per slot on Ahri, and Zhonya's on the Pro card had 2) would push
  a single slot to 46 + 8 + 3*46 = ~192px. Not seen live; worth a look if a champion produces one.
- **`scripts/_tmp-fronty-thin.mjs` is still on disk.** I wrote it to find a thin-sample champion
  and could not delete it — the orchestrator's safety gate blocks `rm` and its approval file path
  (`S:/AI/urgot/data/approved.txt`) does not exist on this machine. It is untracked, harmless, and
  sits beside the previous agent's other `_tmp-*` leftovers. Please remove it, along with those.
