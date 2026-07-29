"use client";

// ─────────────────────────────────────────────────────────────────────────────
// BuildSlotList — a build rendered as SLOTS, not as a list of items.
//
// Read buildSlotView.ts's header first; it carries the measurement this exists
// for (Ahri: Malignance 71%, Blackfire Torch 23%, co-occurring in ZERO of 111
// games). This file is only the paint.
//
// ── THE ONE THING THIS LAYOUT HAS TO ACHIEVE ─────────────────────────────────
// A reader must land on "this slot is Malignance, but 23% of the time it is
// Blackfire Torch instead" and must NOT land on "buy both". The go-to is
// therefore separated from its alternatives on FIVE independent axes, so no
// single one is load-bearing and none of them is colour:
//
//   1. SIZE      34px icon vs 20px; 13px name vs 11.5px.
//   2. WEIGHT    go-to is `text-txt font-medium`; alternatives are `text-mut`.
//   3. POSITION  go-to leads the row; alternatives are indented beneath it,
//                bound to it by a left hairline that exists ONLY when there are
//                alternatives to bind.
//   4. WORDS     every alternative is prefixed with the literal word "or".
//                This is real text, not an aria-label — it is the carrier that
//                survives a stylesheet failing to load, and it is the same
//                vocabulary SupportFinalStackTile already uses on the Pro card
//                for the same "mutually exclusive" idea.
//   5. THE BAR   one track per SLOT, divided between the options (see
//                `slotSegments`). Two separate bars at 71% and 23% would say
//                "two things, each mostly full", which is the bug. One divided
//                track says "one thing, split", which is the fact. The go-to
//                takes the bright segment; alternatives take dimmer ones.
//
// ── A SETTLED SLOT MUST NOT LOOK BUSY ────────────────────────────────────────
// `alternatives: []` is the common case. It renders as a plain item row: no
// left rail, no "or", no nested list, no reserved space. Every group affordance
// above is inside an `isContested` branch. A settled slot is byte-for-byte the
// ordinary row this card has always shown — which is the point, because the new
// chrome is then a SIGNAL ("this one is a real choice") rather than decoration.
//
// The bar still renders on a settled slot, as one segment, because a bar is a
// per-item fact (how often it is built) that the flat list already showed.
//
// ── DENOMINATORS ─────────────────────────────────────────────────────────────
// `sampleGames` travels with every slot, and this component never prints a
// percentage without the fraction beside it. The section-level statement of the
// same number belongs in the PanelHeading's `meta` — see that component's
// header, and v0.73.1, which this repo shipped over two denominators drifting.
// ─────────────────────────────────────────────────────────────────────────────

import { itemIconUrl } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import { isContested, slotSegments, type SlotView } from "./buildSlotView";

/** "79/111" — visible as a fraction, spoken as a sentence. A screen reader
 *  renders the slash as a division ("79 slash 111", or worse), which is why the
 *  glyph is hidden and the words are supplied instead. The denominator is never
 *  dropped in either form: `sampleGames` is on the contract precisely so a
 *  percentage cannot travel without it. */
function Fraction({ games, sampleGames, dim = false }: { games: number; sampleGames: number; dim?: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`text-[9.5px] tabular-nums flex-shrink-0 w-[52px] text-right ${dim ? "text-mut/60" : "text-mut"}`}
      >
        {games}/{sampleGames}
      </span>
      <span className="sr-only">{` in ${games} of ${sampleGames} games`}</span>
    </>
  );
}

/** Opacity ramp for the divided bar: the go-to, then progressively dimmer
 *  alternatives. Indexed by rank, clamped at the end — a slot with more
 *  alternatives than steps keeps the faintest tone rather than wrapping back
 *  round to the bright one. */
const SEGMENT_TONE = ["bg-teal", "bg-teal/45", "bg-teal/25", "bg-teal/15"] as const;

function toneFor(rank: number): string {
  return SEGMENT_TONE[Math.min(rank, SEGMENT_TONE.length - 1)];
}

/** The slot's single divided track. `aria-hidden`: every number it encodes is
 *  already text in the rows beside it, and the whole slot additionally carries
 *  `slotAccessibleLabel`. */
function SlotBar({ slot }: { slot: SlotView }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-1 w-full rounded-full bg-white/[0.06] overflow-hidden gap-px"
    >
      {slotSegments(slot).map((seg) => (
        <span key={seg.itemId} className={`h-full ${toneFor(seg.rank)}`} style={{ width: `${seg.width}%` }} />
      ))}
    </span>
  );
}

/** Icon box. Non-interactive by default — a tile that looks tappable and does
 *  nothing is worse than one that doesn't (FeaturedOtpCard's own standing note);
 *  the card decides by passing `onOpen` or not. */
function SlotIcon({ id, name, ver, px }: { id: number; name: string; ver: string; px: number }) {
  return (
    <span
      className="rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0"
      style={{ width: px, height: px }}
    >
      <IconWithFallback
        src={itemIconUrl(id, ver)}
        alt=""
        fallbackGlyph={name}
        className="w-full h-full object-contain"
        size={px}
      />
    </span>
  );
}

export interface BuildSlotListProps {
  slots: SlotView[];
  ver: string;
  /** Item id -> display name. The cards already hold `getItemDetailMap`; this
   *  component deliberately does no fetching of its own. */
  nameOf: (itemId: number) => string;
  /** Present on the Pro card (which has detail-popover plumbing), absent on the
   *  featured one-trick card (which does not). Passing it makes every option a
   *  real button; omitting it renders plain text. */
  onOpenItem?: (itemId: number) => void;
}

export default function BuildSlotList({ slots, ver, nameOf, onOpenItem }: BuildSlotListProps) {
  if (slots.length === 0) return null;

  return (
    <ul className="mt-3 space-y-3">
      {slots.map((slot) => {
        const contested = isContested(slot);
        const goToName = nameOf(slot.primary.itemId);
        return (
          <li key={slot.primary.itemId}>
            <Row
              itemId={slot.primary.itemId}
              onOpenItem={onOpenItem}
              label={`View details for ${goToName} — built in ${slot.primary.games} of ${slot.sampleGames} games (${slot.primary.pct}%)`}
              className="w-full flex items-center gap-3 py-1 min-h-[46px]"
            >
              <SlotIcon id={slot.primary.itemId} name={goToName} ver={ver} px={34} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 text-[13px] text-txt font-medium truncate text-left">{goToName}</span>
                  <span className="text-[12.5px] font-semibold text-txt tabular-nums flex-shrink-0">
                    {slot.primary.pct}%
                  </span>
                </span>
                {/* Bar capped rather than full-bleed: on the wide (lg) card a
                    900px rail for one number is a lot of ink and the eye stops
                    tracking it. Same cap the previous rates list used. */}
                <span className="mt-1 flex items-center gap-2 max-w-[420px]">
                  <SlotBar slot={slot} />
                  <Fraction games={slot.primary.games} sampleGames={slot.sampleGames} />
                </span>
              </span>
            </Row>

            {contested && (
              /* ml-[46px] = the 34px icon + its 12px gap, so an alternative's
                 rail sits under the go-to's NAME rather than under its icon —
                 the alternative is a variation on the name, not on the picture.
                 The rail and everything in this block exist only here; a settled
                 slot renders none of it and reserves no space for it.

                 The nested <ul> is the STRUCTURAL half of the relationship: a
                 screen reader announces a labelled sub-list owned by the row
                 above it. `aria-label` names what it is a list OF, in the
                 vocabulary a player would use. The visible word "or" on each
                 entry is the other half, and is real text on purpose — it is
                 what survives CSS failing to load, where indentation, size and
                 the rail all do not. */
              <ul
                aria-label={`Built instead of ${goToName} in this slot`}
                /* space-y-0.5, not the old space-y-1.5: each alternative row is
                   now a full 44px target in its own right, so the gap between
                   two of them is dead space BETWEEN two tap targets. Adjacent
                   targets with a 2px seam miss less than taller-spaced ones,
                   and it buys back most of the height the 44px floor cost. */
                className="mt-2 ml-[46px] pl-2.5 border-l border-line space-y-0.5"
              >
                {slot.alternatives.map((alt) => {
                  const altName = nameOf(alt.itemId);
                  return (
                    <li key={alt.itemId}>
                      <Row
                        itemId={alt.itemId}
                        onOpenItem={onOpenItem}
                        label={`View details for ${altName} — built instead of ${goToName} in this slot, in ${alt.games} of ${slot.sampleGames} games (${alt.pct}%)`}
                        className="w-full flex items-center gap-2 py-1.5 min-h-[44px]"
                      >
                        <span className="text-[9px] uppercase tracking-[0.09em] text-mut/60 font-semibold flex-shrink-0 w-[14px] text-left">
                          or
                        </span>
                        <SlotIcon id={alt.itemId} name={altName} ver={ver} px={20} />
                        <span className="min-w-0 text-[11.5px] text-mut truncate text-left">{altName}</span>
                        <span className="ml-auto flex items-baseline gap-1.5 flex-shrink-0">
                          <span className="text-[11.5px] font-semibold text-mut tabular-nums">{alt.pct}%</span>
                          <Fraction games={alt.games} sampleGames={slot.sampleGames} dim />
                        </span>
                      </Row>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * ONE ROW = ONE TAP TARGET. The whole row is the control, not the name inside
 * it.
 *
 * This was measured, not assumed, twice.
 *
 * The first version made only the item NAME a button, which produced a 109x17px
 * hit area — every edge probe landed, so geometry "passed", and it was still a
 * 17px-tall target replacing the 72x90 tiles the Pro card used to have. Making
 * the row the button fixed the width outright.
 *
 * The second measurement (Chrome, 390x844x3 mobile emulation, Ahri mid, Pro and
 * OTP cards) is what produced the `min-h` values below. Rows are content-sized,
 * so before them a go-to came out at 316x46 and an alternative at 259x32 — the
 * go-to already cleared the 44px guideline by accident of its two-line content,
 * and the alternative, being one line, did not. `min-h-[46px]` / `min-h-[44px]`
 * make both a FLOOR rather than a by-product: a shorter item name, a dropped
 * fraction or a font swap can no longer shrink a target back under the line.
 *
 * The height that cost is bought back from the gap BETWEEN alternatives
 * (space-y-1.5 -> space-y-0.5), which is the right place to take it from: two
 * adjacent 44px targets with a 2px seam are easier to hit than two 32px targets
 * with a 6px gap, and the net is +8px per alternative row, not +12px.
 *
 * Non-interactive when `onOpenItem` is absent (the featured one-trick card has
 * no popover plumbing) — rendering a control that looks tappable and does
 * nothing is worse than rendering none, which is FeaturedOtpCard's own standing
 * note. In that case the row's own text is what a screen reader reads, and the
 * visible "or" plus the labelled nested list carry the relationship.
 *
 * `aria-label` on the interactive variant restates the relationship ("built
 * instead of <go-to> in this slot") because a button's label REPLACES its inner
 * text for a screen reader, and losing the "or" there would drop the one fact
 * this component exists to convey.
 */
function Row({
  itemId,
  onOpenItem,
  label,
  className,
  children,
}: {
  itemId: number;
  onOpenItem?: (itemId: number) => void;
  label: string;
  className: string;
  children: React.ReactNode;
}) {
  if (!onOpenItem) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpenItem(itemId)}
      aria-label={label}
      className={`${className} rounded-md -mx-1 px-1 hover:bg-white/[0.03] active:scale-[0.99] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel`}
    >
      {children}
    </button>
  );
}
