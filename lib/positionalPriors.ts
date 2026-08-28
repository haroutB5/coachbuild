// ─────────────────────────────────────────────────────────────────────────────
// positionalPriors.ts — the fallback positional signals, for the blocks that
// `lib/purchasePositions.ts` cannot measure.
//
// ── The defect this module closes ───────────────────────────────────────────
//
// RC-2 (2026-08-27) made a consensus block claim a buy order ONLY when it could
// measure one from its own timelines, and titled everything else "most built"
// so it stopped lying. That was correct and it was not enough: in the committed
// patch-16.16 artifact the honest-but-unordered case is **236 of 442 pro
// entries and all 297 OTP entries**, and every one of them still ships as a
// left-to-right row in a League shop panel. A player reads a row.
//
// The user's verdict, by value, 2026-08-28:
//
//   Viktor Mid, "OTP most built"
//     Blackfire -> Spellslinger's -> Liandry's -> Zhonya's -> ROCKETBELT -> Rabadon's
//     "Rocketbelt is always bought in the first two items, never later."
//   Urgot Top, "Pro most built"
//     STERAK'S -> Steelcaps -> Black Cleaver -> Jak'Sho -> Kaenic -> Hullbreaker
//     "Black Cleaver is always first."
//
// Both are frequency order. Rocketbelt is in 17% of those one-tricks' final
// inventories and Zhonya's in 23%, so frequency puts Zhonya's first; the pro
// corpus for the same champion-role measures Rocketbelt at median purchase
// position 2 and Zhonya's at 5. Urgot's pro sample is ONE game (measured:
// `/api/pros?championId=6&role=0&limit=200&proMin=100&source=all` returns
// `games: 1`, zero of them carrying a timeline), so its "Pro" block is a
// 1-game frequency ranking of three items and Sterak's leads it by an id
// tiebreak.
//
// DIRECTIVE (user, 2026-08-28): frequency order is not an acceptable fallback
// anywhere a block reads as a build.
//
// ── The two priors, and why they are ranked in this order ───────────────────
//
// 1. CROSS-SOURCE (`orderedIdRanks`). Order this source's items by the OTHER
//    source's measured median purchase positions for the same champion-role.
//    Still a real timeline measurement of real games of this exact champion in
//    this exact lane — just drawn from a different population.
//
//    In practice this means "order the OTP block by the pro corpus", and the
//    reason it is one-directional is measured, not assumed: `/api/otp` sets
//    `purchaseOrder: []` UNCONDITIONALLY (its ingest skips the match-v5
//    timeline call on purpose), so the OTP side contributes exactly zero
//    timelines to any pool. Re-measured 2026-08-28 on live prod across four
//    champion-roles — Ahri Mid 186 OTP games / 0 timelines, Jax Top 98 / 0,
//    Viktor Mid 111 / 0, Urgot Top 200 / 0. Pooling the two corpora and taking
//    medians over the union is therefore, today, arithmetically identical to
//    reading the pro side's medians, which is what the pro entry's `p` already
//    is. So the prior is applied by RANK TRANSFER rather than by re-deriving a
//    pooled median, and that choice buys three things: it needs no artifact
//    change (so it ships without waiting on a re-bake), it works identically on
//    the live-query path and the artifact path, and it cannot introduce a
//    number the bake did not already publish.
//
// 2. WPA PER-SLOT (`wpaSlotRanks`). `/api/build` returns, for every champion-
//    role it covers, a pool of candidate items PER LEGENDARY SLOT — `first`,
//    `second`, `third`, `fourthPlus`, each with its `alts` — and every entry
//    carries its own `occurrence`, the number of games that built that item in
//    that slot. An item's modal slot is therefore a purchase-position
//    measurement over the whole ranked population, and it exists for every
//    champion-role the shop export can be produced for at all (the export needs
//    a `BuildResponse`; without one there is no item set).
//
//    It is ranked BELOW the cross-source prior because it is not a measurement
//    of this block's population: it is where the Diamond+ ladder buys the item,
//    not where these pros or these one-tricks buy it.
//
// ── What these priors deliberately do NOT do ────────────────────────────────
//
// They do not COMPOSE. A block takes the best single prior available and any
// item that prior did not rank stays behind every item it did, in share order.
// Mixing was tried against live data first and it is worse: Viktor's OTP block
// carries Rod of Ages, which the pro sample never positioned but which the WPA
// slot-1 pool ranks at 1,200 occurrences. Filling it in from the weaker prior
// promotes a 13%-share item to the head of the block and pushes a
// pro-positioned item out of the six visible slots — a CONTENT change bought
// with the weakest evidence in the cascade. Trailing is the conservative
// answer and it is the reason a rescued block's contents stay recognisably the
// same block.
//
// They also do not invent a floor of their own for the OWN-timeline prior.
// `MIN_POSITION_GAMES` / `MIN_POSITION_OBSERVATIONS` in purchasePositions.ts
// still decide whether a source can measure its own order; this module only
// answers what happens after that says no.
// ─────────────────────────────────────────────────────────────────────────────

/** An order is a relation between at least two things. One ranked item among
 *  six is a fact about that item, not an ordering of the block — and a title
 *  that calls the block a build on that basis would be the same overclaim RC-2
 *  removed, wearing a smaller number. Shared by both priors on purpose: the
 *  bar for "this block is now in purchase order" must not depend on which
 *  signal cleared it. */
export const MIN_PRIOR_POSITIONED = 2;

/** Which signal produced a block's order. Diagnostic AND load-bearing: the
 *  block title is a claim about its contents, so `null` here is what keeps the
 *  residual saying "most built" instead of "build". */
export type PositionPrior = "timeline" | "cross-source" | "wpa-slot";

// ── Prior 1: rank transfer from another source's measured order ─────────────

/** `orderedIds` (a `ConsensusArtifactSource.p`, i.e. ids in median purchase
 *  position order) as an id -> rank lookup.
 *
 *  `null`, never an empty Map, when there is nothing to transfer. The two are
 *  different answers at the call site: an empty Map is a prior that fired and
 *  positioned nothing, `null` is "this signal does not exist, try the next
 *  one", and collapsing them would let a source with no order silently consume
 *  the cascade slot belonging to one that has a weaker order but a real one.
 *
 *  A repeated id keeps its FIRST index. `p` is generated as a permutation and
 *  should never repeat; if a hand-edited or future artifact ever does, the
 *  earliest position is the conservative reading (an item is bought once, at
 *  the first moment it is seen). */
export function orderedIdRanks(
  orderedIds: readonly number[] | null | undefined
): Map<number, number> | null {
  // `length === 0` is a SECOND-LINE guard and is deliberately kept: the
  // load-bearing one is the `ranks.size > 0` test at the bottom, which an
  // empty input reaches with the same answer. Mutating this line away leaves
  // the whole suite green (proved, `.cb-order/q_mutants5.py`) — it is here to
  // say what the function refuses, not to be the only thing refusing it.
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return null;
  const ranks = new Map<number, number>();
  orderedIds.forEach((id, index) => {
    if (!Number.isFinite(id)) return;
    if (!ranks.has(id)) ranks.set(id, index);
  });
  return ranks.size > 0 ? ranks : null;
}

// ── Prior 2: the WPA model's own per-slot pools ─────────────────────────────

/** The minimum `/api/build` `items` shape this module reads. Structural rather
 *  than an import of `ItemsBlock` so the module stays a leaf: it needs four
 *  arrays of `{id, occurrence}` and nothing else, and a caller with the same
 *  numbers from anywhere else is a legitimate caller. */
export interface WpaSlotPick {
  id: number;
  occurrence: number;
}

export interface WpaSlotSource {
  first?: WpaSlotPick | null;
  second?: WpaSlotPick | null;
  third?: WpaSlotPick | null;
  fourthPlus?: readonly WpaSlotPick[] | null;
  /** Ranked alternatives per slot key, exactly `ItemsBlock.alts`. The `boots`
   *  and `starter` keys are present here and are deliberately never read. */
  alts?: Record<string, readonly WpaSlotPick[] | undefined> | null;
  /** Declared so an `ItemsBlock` passes as a literal, and typed `unknown` so
   *  reading either one is a compile error rather than a judgement call. A
   *  starter is not a block item, and boots do not compete for a legendary
   *  slot — see `WPA_SLOT_KEYS`. */
  starter?: unknown;
  boots?: unknown;
}

/** The four legendary slot keys, in purchase order. `boots` and `starter` are
 *  absent BY DESIGN, not by omission: boots do not compete for a legendary
 *  slot — `buildLine` lifts them out of the pool and reinserts them at
 *  `BOOTS_LINE_INDEX` (slot 2, measured over 978 pro timelines, RC-1) — and a
 *  starter is not a block item at all. Ranking Sorcerer's Shoes at "slot 1"
 *  here would put a real claim about a real position into a list that is then
 *  ignored, which is the sort of dead signal that gets read as live by the
 *  next person. */
const WPA_SLOT_KEYS = ["first", "second", "third", "fourthPlus"] as const;

/** Modal legendary slot (1-based) per item id, from the per-slot occurrence
 *  pools.
 *
 *  The estimator is `argmax` over the item's OWN per-slot occurrences, which is
 *  the item's best slot by occurrence share: the denominator of that share is
 *  the item's total occurrence across slots, so it is constant per item and
 *  drops out of the comparison. Normalising by the POOL total instead would
 *  answer a different question — "which slot is this item most distinctive
 *  for" — and would systematically pull items into the small late-game pools
 *  (Viktor Mid, live: slot-1 pool totals 36,868 against fourthPlus's 4,964).
 *
 *  Worked example, Liandry's Torment on Viktor Mid, patch 16.16: slot-2 pool
 *  5,145, slot-3 pool 865. It is a second item, and taking the first pool an id
 *  appears in — or the last — would both get that wrong.
 *
 *  Returns `null` when nothing was rankable, so the caller can fall through to
 *  the residual instead of treating an empty ranking as a fired prior.
 *
 *  KNOWN LIMIT, stated because it bounds what this number is worth: the pools
 *  are TRUNCATED top-N lists, so an item's absence from a slot is not evidence
 *  it is never bought there. The estimate is therefore biased toward slots the
 *  item ranked highly enough in to be listed. That is acceptable for a coarse
 *  1-2-3-4 ordering and it is strictly better than frequency, which carries no
 *  positional information at all — but it is not a median and it is not
 *  presented as one. */
export function wpaSlotRanks(items: WpaSlotSource | null | undefined): Map<number, number> | null {
  if (!items) return null;

  const occurrenceBySlot = new Map<number, number[]>();
  const add = (pick: WpaSlotPick | null | undefined, slotIndex: number): void => {
    if (!pick || !Number.isFinite(pick.id)) return;
    const occurrence = Number.isFinite(pick.occurrence) ? Number(pick.occurrence) : 0;
    // A zero-occurrence pick is not a position. recommend.ts emits an
    // EMPTY_PICK (id 0, occurrence 0) for a slot with no candidate at all, and
    // reading it as evidence would seat a phantom item at the head of a block.
    //
    // EQUIVALENT UNDER MUTATION, and stated so nobody re-derives it: relaxing
    // this to `< 0` changes no output, because a zero can never win the argmax
    // below and the `slots[best] > 0` test drops an item whose only appearance
    // is a zero. What this line adds is that such an item never enters the map
    // at all, which is the difference between "we considered it and it scored
    // nothing" and "it was never evidence". Negative occurrences are impossible
    // and excluded by both readings.
    if (occurrence <= 0) return;
    const slots = occurrenceBySlot.get(pick.id) ?? [0, 0, 0, 0];
    slots[slotIndex] += occurrence;
    occurrenceBySlot.set(pick.id, slots);
  };

  WPA_SLOT_KEYS.forEach((key, slotIndex) => {
    const primary = items[key];
    if (Array.isArray(primary)) for (const pick of primary) add(pick, slotIndex);
    else add(primary as WpaSlotPick | null | undefined, slotIndex);
    for (const pick of items.alts?.[key] ?? []) add(pick, slotIndex);
  });

  const ranks = new Map<number, number>();
  for (const [itemId, slots] of occurrenceBySlot) {
    let best = 0;
    // Strictly greater, so an exact tie keeps the EARLIER slot. Ties are rare
    // and the early reading is the safe one: a block is read as a sequence and
    // an item placed too early is a suggestion, whereas one placed too late is
    // an instruction to delay a purchase the player has already made.
    for (let slotIndex = 1; slotIndex < slots.length; slotIndex++) {
      if (slots[slotIndex] > slots[best]) best = slotIndex;
    }
    if (slots[best] > 0) ranks.set(itemId, best + 1);
  }
  return ranks.size > 0 ? ranks : null;
}

// ── Applying a prior ────────────────────────────────────────────────────────

export interface PositionRankResult<T> {
  entries: T[];
  /** How many entries the prior actually placed. Never counts a `front` id. */
  positioned: number;
}

export interface ApplyPositionRanksOptions {
  /** Ids pinned to the head of the result and excluded from the evidence
   *  count. Boots, always: `buildLine` lifts them out of this pool and
   *  reinserts them at `BOOTS_LINE_INDEX`, so their place here is not a claim
   *  about anything — but leaving them to fall into the unranked TAIL would
   *  make the pool unreadable, and letting one count toward
   *  `MIN_PRIOR_POSITIONED` would let a block claim to know a legendary order
   *  on the strength of a boot. */
  front?: ReadonlySet<number>;
}

/** `entries` (share-desc, as every consensus source produces them) reordered by
 *  `ranks` — or `null` when the prior placed fewer than
 *  `MIN_PRIOR_POSITIONED` of them.
 *
 *  Always a PERMUTATION. Nothing is dropped and nothing is invented, which is
 *  what makes a prior safe to try and discard: the worst case is the order it
 *  came in with. Ranked items first in rank order, ties broken by the incoming
 *  order (share-desc, then the source's own id tiebreak), then every unranked
 *  item in the order it arrived. */
export function applyPositionRanks<T extends { itemId: number }>(
  entries: readonly T[],
  ranks: ReadonlyMap<number, number> | null | undefined,
  opts: ApplyPositionRanksOptions = {}
): PositionRankResult<T> | null {
  // `size === 0` is the same second-line guard as in `orderedIdRanks`: an
  // empty ranking positions nothing, so `MIN_PRIOR_POSITIONED` below rejects
  // it anyway. Kept because "an empty prior is not a prior" is the rule, and a
  // reader should not have to derive it from an arithmetic accident.
  if (!ranks || ranks.size === 0) return null;

  const front: T[] = [];
  const ranked: { entry: T; rank: number; index: number }[] = [];
  const unranked: T[] = [];

  entries.forEach((entry, index) => {
    if (opts.front?.has(entry.itemId)) {
      front.push(entry);
      return;
    }
    const rank = ranks.get(entry.itemId);
    if (rank === undefined) unranked.push(entry);
    else ranked.push({ entry, rank, index });
  });

  if (ranked.length < MIN_PRIOR_POSITIONED) return null;

  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return {
    entries: [...front, ...ranked.map((r) => r.entry), ...unranked],
    positioned: ranked.length,
  };
}
