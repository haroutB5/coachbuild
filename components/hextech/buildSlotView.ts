// ─────────────────────────────────────────────────────────────────────────────
// buildSlotView.ts — the pure half of the competing-slot row.
//
// ── THE PROBLEM THIS SHAPE EXISTS TO FIX ──────────────────────────────────────
// Both build cards rendered a flat list: one item per row, one percentage per
// row. That layout makes exactly one claim — "here are the things they build" —
// and a reader assembles it into a build by reading down the list. For a large
// class of items that reading is WRONG, because the items do not stack, they
// COMPETE.
//
// Measured over 12,910 stored one-trick games before this was built:
//   Ahri,   111 games: Malignance 71%, Blackfire Torch 23% — 0 games together.
//   Annie,   87 games: Malignance 46%, Blackfire Torch 39% — 0 games together.
// Not "rarely". Not once. Meanwhile genuine companions look nothing like that:
// Malignance + Zhonya's co-occur in 33% of games, Blackfire + Shadowflame 33%.
//
// So two rows at 71% and 23% were telling the reader to buy both, when the true
// statement is "this slot is Malignance, and 23% of the time it is Blackfire
// Torch INSTEAD." One slot, one go-to, its alternatives attached to it.
//
// ── WHY THIS FILE DECLARES ITS OWN VIEW TYPES ────────────────────────────────
// The engine-side contract (`BuildSlot`/`BuildSlotOption`, lib/) carries whatever
// the aggregation needs. This module carries only what a ROW needs to paint, and
// the two are structurally compatible — a `BuildSlot` is assignable to
// `SlotView` — so the card passes engine values straight in and TypeScript
// checks the fit at the call site. Nothing is copied, cast or re-mapped.
//
// The point is that a field added to the engine contract cannot silently change
// what this renders, and this file has no import edge into lib/ (the same reason
// featuredBuild.ts's own header gives for owning its classifier outright).
//
// ── NO SLOT NUMBERS, EVER ────────────────────────────────────────────────────
// A tempting label for these rows is "Slot 1 … Slot 6". It is banned here for
// the same reason FeaturedOtpCard's build strip carries a "not a purchase order"
// caption: `otp_matches` is written from Riot match-v5 detail with NO timeline
// call, so nothing we store says what was bought first. Numbering the slots
// would invent that order out of a render decision. Slots are an unordered set
// of decisions, ranked by how often the go-to is built — nothing more.
//
// No JSX in this file so it stays importable from a plain .ts test file (the
// same constraint proConsensus.ts and runesPage.ts already document — vitest 4's
// oxc transform cannot parse JSX outside its default scope).
// ─────────────────────────────────────────────────────────────────────────────

/** One option competing for a slot. Structurally the engine's
 *  `BuildSlotOption` — `{ itemId, games, pct }`. */
export interface SlotOptionView {
  itemId: number;
  games: number;
  pct: number;
}

/** One slot. Structurally the engine's `BuildSlot`.
 *
 *  `alternatives: []` is the COMMON case and must render as a plain item row —
 *  no group chrome, no left rail, no empty tail. See `isContested`. */
export interface SlotView {
  primary: SlotOptionView;
  alternatives: SlotOptionView[];
  /** The denominator every pct on the slot is quoted against. On the contract
   *  precisely so a percentage never appears without it. */
  sampleGames: number;
}

/** A slot with something to choose between. The single predicate the render
 *  branches on: false means "settled", and a settled slot gets NONE of the
 *  grouping affordances — it is indistinguishable from an ordinary item row. */
export function isContested(slot: SlotView): boolean {
  return slot.alternatives.length > 0;
}

/** One painted segment of a slot's bar. */
export interface SlotSegment {
  itemId: number;
  /** Percent of the bar's full width. Already floored and normalised. */
  width: number;
  /** Index in the slot: 0 is the go-to, 1+ are alternatives in given order. */
  rank: number;
}

/**
 * The slot's bar, as ONE track split between the options that compete for it.
 *
 * This is the visual that carries the whole idea: a slot is a fixed thing, and
 * the options divide it. Two independent bars at 71% and 23% would say the
 * opposite (two things, each mostly-full). The unfilled remainder is real and
 * deliberately left empty — it is the games where the slot held neither, and
 * padding it out to 100% would invent coverage.
 *
 * Two defensive steps, in this order:
 *  1. A floor of `MIN_SEGMENT_WIDTH` on any non-zero option, so a 2% alternative
 *     is still a visible sliver rather than a sub-pixel nothing.
 *  2. If the floors (or genuinely overlapping input) push the total past 100,
 *     scale every segment proportionally so the bar never overflows its track.
 *     Overflow would be a lie in the other direction — a slot filled past full.
 *
 * A zero-pct option yields no segment at all rather than a floored sliver: it
 * was never built, and a visible mark would say it was.
 */
export function slotSegments(slot: SlotView): SlotSegment[] {
  const options = [slot.primary, ...slot.alternatives];
  const raw = options
    .map((o, rank) => ({ itemId: o.itemId, rank, width: o.pct > 0 ? Math.max(MIN_SEGMENT_WIDTH, o.pct) : 0 }))
    .filter((s) => s.width > 0);
  const total = raw.reduce((sum, s) => sum + s.width, 0);
  if (total <= 100) return raw;
  return raw.map((s) => ({ ...s, width: (s.width / total) * 100 }));
}

/** Below this a segment is not reliably visible at 390px (a 358px content box
 *  makes 1% ≈ 3.6px, and the bar is inset further than that). */
const MIN_SEGMENT_WIDTH = 2;

/**
 * Build a `SlotView` from the Pro card's own `ItemFrequency` vocabulary
 * (`{ itemId, count, share }`, where `share` is a 0-1 fraction against
 * `itemsSampleSize`).
 *
 * WHY THIS EXISTS RATHER THAN A SECOND ROW COMPONENT: three groups on that card
 * are ALREADY competing slots and were already modelled as top-plus-runners-up,
 * they just each grew their own near-identical stacked tile —
 * `BootsStackTile`, `StartersStackTile`, `SupportFinalStackTile`. The
 * support-final one even carried an "or" rule between the top pick and the rest,
 * because the five finals are mutually exclusive by construction. That is this
 * component's whole idea, arrived at independently three times. Funnelling them
 * through one adapter is what stops the card speaking two vocabularies for one
 * relationship once the item slots start rendering as rows.
 *
 * The conversion is arithmetic only. It re-ranks nothing, merges no fractions,
 * and invents no combined "the family was built X%" number — each option keeps
 * its own honest percentage against the one shared denominator, exactly as those
 * three tiles already did (see `ProConsensusModel.supportFinals`' doc comment on
 * why a merged family stat would describe a choice nobody made).
 *
 * Returns null for an empty group so a caller renders NOTHING rather than an
 * empty slot — the "absent, not empty" convention `boots`/`starters` established.
 */
export function slotFromFrequencies(
  entries: readonly { itemId: number; count: number; share: number }[],
  sampleGames: number
): SlotView | null {
  if (entries.length === 0) return null;
  const toOption = (e: { itemId: number; count: number; share: number }): SlotOptionView => ({
    itemId: e.itemId,
    games: e.count,
    // Rounded here so the row and `formatSharePct` — which every other fraction
    // on that card goes through — can never print two different numbers for one
    // item. Same rounding, one place.
    pct: Math.round(e.share * 100),
  });
  return {
    primary: toOption(entries[0]),
    alternatives: entries.slice(1).map(toOption),
    sampleGames,
  };
}

/* NO `slotAccessibleLabel` HERE, DELIBERATELY (and do not add one back).
 *
 * The first draft of this module built one spoken sentence per slot and the row
 * rendered it into an `sr-only` span with the visual half `aria-hidden`. That is
 * the wrong shape twice over: the visual half contains focusable buttons on the
 * Pro card (a focusable element inside `aria-hidden` is a real defect, not a
 * lint nit), and it makes the spoken and seen versions two artefacts that can
 * drift — the same failure mode as two denominators, which this repo has already
 * shipped a bug over.
 *
 * The relationship is carried by the MARKUP instead: alternatives live in a
 * nested `<ul>` labelled "Built instead of <go-to> in this slot", and every
 * entry is prefixed with the literal, visible word "or". One artefact, seen and
 * spoken, no duplication to drift. See BuildSlotList.tsx. */
