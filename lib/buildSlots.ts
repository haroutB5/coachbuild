// ─────────────────────────────────────────────────────────────────────────────
// buildSlots.ts — grouping a flat "what they build" ranking into SLOTS, where a
// slot is one decision and the items that compete for it are attached to it.
//
// The render half is components/hextech/buildSlotView.ts + BuildSlotList.tsx;
// this is the engine half. `BuildSlot`/`BuildSlotOption` below are structurally
// identical to that module's `SlotView`/`SlotOptionView`, deliberately: the card
// passes engine values straight in and TypeScript checks the fit at the call
// site, with no adapter and no import edge between the two files.
//
// ── THE CLAIM A FLAT LIST MAKES, AND WHY IT IS OFTEN FALSE ──────────────────
// A list of "Malignance 71% / Blackfire Torch 23%" reads down as a build: buy
// both. For a large class of items that reading is wrong — they do not stack,
// they COMPETE, and the true statement is "this slot is Malignance, and 23% of
// the time it is Blackfire INSTEAD."
//
// ── MUTUAL EXCLUSIVITY IS PER CHAMPION **AND ROLE**. Not a detail ───────────
// Every count here is taken WITHIN one champion+role's own stored games, and
// the caller must pass nothing else. Pooling the roster first does not give a
// noisier answer, it gives a meaningless one: two items belonging to different
// champions trivially "never co-occur" because they are never in the same game
// to begin with, so a pooled measurement ranks lane starters as mutually
// exclusive with late-game legendaries. That mistake was made and thrown away
// before the numbers below were taken.
//
// Role matters as well as champion, and by more than it looks. Live, 2026-07-29:
// Ahri has 111 stored games across all roles but 102 in Mid, and champions like
// Jax (Top 72 / Jungle 59) or Xerath (Mid 73 / Bot 51) build genuinely different
// items per lane. Splitting by role costs sample and buys correctness.
//
// ── HOW COMPETITION IS DETECTED: LIFT, NOT A RAW CO-OCCURRENCE COUNT ────────
// For items A and B over N games:
//     expected_together = (games_A / N) * (games_B / N) * N     [if independent]
//     lift              = observed_together / expected_together
// lift ~0 means mutually exclusive, ~1 independent, >1 companions.
//
// A raw count cannot do this job: "never seen together" is equally true of two
// items that genuinely exclude each other and of two items that are simply both
// rare. Lift divides that out, which is the whole reason it is the measure here.
//
// ── LIFT vs. the JOINT RATE, since the brief for this work named the latter ──
// The joint rate — of the games holding EITHER item, the share holding BOTH
// (Jaccard) — separates the same two populations on this corpus: alternatives
// measured 0-10%, companions 25%+. Lift was chosen over it, and the two are not
// interchangeable at the margin. Where they disagree, lift is the STRICTER of
// the pair, and strictness is the direction that matters here:
//
//   A in 50% of games, B in 50%, together in 10%
//     joint rate 0.11  -> "competing"      lift 0.40 -> not competing
//   A in 20%, B in 20%, together in 2%
//     joint rate 0.05  -> "competing"      lift 0.50 -> not competing
//
// In both cases the items co-occur about as often as chance would produce, and
// the joint rate calls them mutually exclusive purely because they are not
// built THAT often in absolute terms. Grouping two items that genuinely stack
// is a fabrication — the build then shows five items where the player buys six
// and hides the sixth behind a "vs" the data does not support — so the measure
// that refuses those cases is the correct one. Every pair the joint-rate
// measurement identified (all of them at exactly 0 co-occurrence) has lift 0
// and is caught here too; nothing found by the joint rate is lost.
//
// ── THE THRESHOLD IS MEASURED, NOT CHOSEN ──────────────────────────────────
// Probed live against `coachbuild.otp_matches` on 2026-07-29 (8 champions with
// 60+ stored games each — Shen 181, Gangplank 181, Morgana 178, Heimerdinger
// 172, Alistar 171, ...; 193 qualifying pairs). The distribution is BIMODAL,
// which is what makes a threshold defensible at all rather than a taste call:
//
//     lift 0.00–0.05 : 16 pairs      <- exact zeros, against 5–34 expected games
//     lift 0.05–0.30 :  8 pairs
//     lift 0.30–0.50 :  6 pairs      <- the empty quarter
//     lift 0.50–0.90 : 43 pairs
//     lift 0.90+     : 120 pairs     <- independent and companion pairs
//
// So `COMPETES_MAX_LIFT = 0.35` sits in the sparse middle, not on a slope. Real
// pairs it catches, all at lift 0.00 with double-digit expected co-occurrence:
//   Morgana    Blackfire Torch 46% vs Luden's Echo 17%      (exp 13.7, obs 0)
//   Gangplank  Lord Dominik's 52%  vs Mortal Reminder 17%   (exp 15.6, obs 0)
//   Alistar    Celestial Opp. 61%  vs Solstice Sleigh 32%   (exp 33.5, obs 0)
//   Shen       Plated Steelcaps41% vs Mercury's Treads 24%  (exp 17.8, obs 0)
// Pairs it correctly leaves alone: Heimerdinger's whole build (lowest lift 0.69
// — Shadowflame + Blackfire at 33 observed vs 47.9 expected). Heimerdinger
// produces ZERO contested slots, which is the honest answer for a settled build
// and the case `isContested` renders as a plain row.
//
// Re-run `scripts/measure-item-cooccurrence.mts` if the item pool changes
// shape; the number above is an observation with a date on it, not a constant
// of nature. (That script groups by CHAMPION only. It set the threshold, which
// is a distribution-shape question the pooling does not distort much, but do
// not read its per-champion slot output as what a surface would render — that
// needs the champion+role split this module requires of its callers.)
//
// ── WHAT IT DOES ON REAL DATA ──────────────────────────────────────────────
// Run against every champion+role in `otp_matches` with >=40 stored games
// (97 combos, 2026-07-29), through this exact function: 87 of 413 slots (21.1%)
// come back contested, on 63 of 97 combos (64.9%). The user's own example
// resolves exactly as he described it:
//
//   Ahri Mid (n=102)
//     [Malignance 70% | Blackfire Torch 25%]   <- the either/or he named
//     Zhonya's Hourglass 34%                   <- companion of Malignance, kept apart
//     [Lich Bane 29% | Cosmic Drive 26%]       <- a second either/or
//     Shadowflame 26%                          <- companion of Blackfire, kept apart
//
// It also generalises two fixes this repo previously made by hand, without
// being told about either: support-quest finals (Maokai Support returns
// [Solstice Sleigh 67% | Celestial Opposition 29%]) and split boot preferences
// land in one slot because they measure as mutually exclusive, not because
// anyone enumerated them.
//
// ── TWO KNOWN LIMITATIONS, seen in the live run (`... slots`) ──────────────
// 1. GREEDY GIVES A CONTESTED ITEM TO ONE SLOT, AND THE LOSER LOOKS SETTLED.
//    Morgana live: Rocketbelt competes with BOTH Blackfire Torch (44%) and
//    Rylai's (20%). It attaches to Blackfire, the bigger claim, so Rylai's then
//    renders as a settled slot even though it has a real competitor that has
//    already been claimed. Nothing shown is false — Rylai's IS built in 20% of
//    games — but the row under-states the choice. A proper fix is clustering
//    rather than greedy assignment; that is a bigger change than this feature
//    justified, so it is documented rather than hidden.
// 2. A THREE-WAY TIE HAS NO REAL GO-TO. Shen live: Protoplasm Harness 18% /
//    Hollow Radiance 18% / Thornmail 17%. The "primary" is decided by the
//    id tie-break, which carries no meaning at those margins. The slot is still
//    true as a set of competing options; the promotion of one to go-to is not
//    evidence of anything. Do not add a "recommended" affordance to the primary
//    without fixing this first.
//
// ── WHAT THIS DOES NOT CLAIM ───────────────────────────────────────────────
// Not causation, and not a recommendation. "These two never appear together"
// is a statement about this player's games, nothing more — it does not say the
// items conflict mechanically, and the slot's go-to is simply the one built more
// often, never the one scored better. There is also NO ordering between slots
// beyond the go-to's build rate: `otp_matches` is written from Riot match-v5
// detail with no timeline call, so nothing here knows purchase order and the
// render must not number the slots (buildSlotView.ts's header says the same).
// ─────────────────────────────────────────────────────────────────────────────

import { isSnowballStackItem } from "./snowballStacks";

/** One option competing for a slot. */
export interface BuildSlotOption {
  itemId: number;
  /** Games this player finished holding it. */
  games: number;
  /** 0-100, over `BuildSlot.sampleGames`. */
  pct: number;
}

/** One build decision: the go-to, plus what gets built INSTEAD of it.
 *
 *  `alternatives: []` is the COMMON case and means "settled" — the render shows
 *  it as an ordinary item row with no grouping chrome (`isContested`). */
export interface BuildSlot {
  primary: BuildSlotOption;
  alternatives: BuildSlotOption[];
  /** The denominator every pct on this slot is quoted against. On the slot
   *  itself so a percentage can never travel without it. */
  sampleGames: number;
}

/**
 * Lift at or above which two items are NOT treated as competing.
 * Measured, see the module header. 0.35 sits inside the empty quarter between
 * the mutually-exclusive cluster and the independent mass.
 */
const COMPETES_MAX_LIFT = 0.35;

/**
 * Expected co-occurrence, in games, below which no competition claim is made
 * however low the observed count is.
 *
 * This is the honesty guard and it matters more than the lift threshold. Two
 * items each built in 15% of 40 games have an expected overlap of 0.9 games —
 * seeing zero is the single most likely outcome under pure independence, so
 * calling it "they never build these together" would be reading structure out
 * of noise. Below this floor the item simply gets its own slot, which claims
 * nothing.
 */
const MIN_EXPECTED_COOCCURRENCE = 3;

/**
 * Item-bearing games below which NO grouping happens at all — every eligible
 * item comes back as its own settled slot.
 *
 * Be clear about what this is and is not. The STATISTICAL guard is
 * MIN_EXPECTED_COOCCURRENCE above; it is per-pair, which is strictly better
 * than any blanket sample size, and it is what stops a 0% co-occurrence across
 * a handful of games being read as a finding. This floor is a PRODUCT guard on
 * top of it, and it earns its place on one specific case the pair guard lets
 * through: 10 games with A in 6 and B in 5 expects exactly 3 shared games, so
 * it clears the pair guard, and the two items are FORCED by pigeonhole to share
 * at least one — at which point lift is 0.33 and a contested slot appears out of
 * arithmetic rather than out of behaviour.
 *
 * That pigeonhole floor on lift is scale-invariant (two items at 60% and 50%
 * bottom out at lift 0.33 whatever N is), so raising this number does not fix
 * it and no number would. 20 is set where a champion's slot list stops churning
 * completely between ingests, and the honest reading of it is "not enough games
 * to have an opinion", not "statistically insufficient".
 */
const MIN_SAMPLE_GAMES = 20;

/**
 * Build rate below which an item is not considered for a slot at all.
 *
 * Deliberately equal to the band the threshold was MEASURED over (the probe
 * only compared pairs where both items were >= 15%). Defaulting lower would be
 * extrapolating the 0.35 lift threshold past its evidence — the real signals
 * sat right at the bottom of this band (Luden's Echo 17%, Mortal Reminder 17%),
 * so there is no headroom to give away.
 */
const DEFAULT_MIN_PCT = 15;

/** Inventory slots. Same number, same reason, as lib/buildSlotCap.ts. */
const DEFAULT_MAX_SLOTS = 6;

/** Top pick plus at most two runners-up, matching the footprint the boots and
 *  support-final stacks already use elsewhere in the app. */
const DEFAULT_MAX_ALTERNATIVES = 2;

export interface BuildSlotOptions {
  /** Which ids may take part. Use this to pass a classified pool (e.g. only
   *  `completed` items, or only boots) rather than pre-filtering `gameItems`. */
  include?: (itemId: number) => boolean;
  maxSlots?: number;
  maxAlternatives?: number;
  minPct?: number;
}

/**
 * Group a player's per-game inventories into slots.
 *
 * @param gameItems   one entry per game, item ids, duplicates tolerated
 * @param sampleGames the denominator for every pct. Supplied by the caller
 *                    rather than derived from `gameItems.length` ON PURPOSE:
 *                    it must be the SAME denominator the rest of the card
 *                    quotes, or a slot's "46%" and the items list's "46%" would
 *                    silently describe different populations. That divergence
 *                    is the v0.73.1 class of bug.
 *
 * Returns slots ranked by their go-to's build rate, most-built first. Never
 * throws; an empty or all-excluded input returns `[]`.
 */
export function resolveBuildSlots(
  gameItems: readonly (readonly number[])[],
  sampleGames: number,
  opts: BuildSlotOptions = {}
): BuildSlot[] {
  const include = opts.include ?? (() => true);
  const maxSlots = opts.maxSlots ?? DEFAULT_MAX_SLOTS;
  const maxAlternatives = opts.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES;
  const minPct = opts.minPct ?? DEFAULT_MIN_PCT;

  // Dedup within a game first: an inventory listing an id twice is one game
  // that built it, and letting it count twice would inflate both the single
  // counts and the pair counts. Same rule buildFeaturedModel already applies.
  const games: number[][] = [];
  for (const raw of gameItems) {
    // The snowball-stack exclusion is UNCONDITIONAL — ANDed with the caller's
    // predicate rather than left to it. Every slot this module produces is a
    // COMPLETED build slot, Mejai's is not a build item (hard user directive,
    // 2026-07-29), and the raw `final_items` arrays callers hand in carry it.
    // All three live callers already exclude it in their own classifier, so this
    // changes nothing today; it is here so the DEFAULT (`include: () => true`)
    // is safe rather than merely unused. Same rule, same list, one import — not
    // a second mechanism (lib/snowballStacks.ts).
    //
    // It cannot regress Dark Seal's opener row: this module has no opener
    // concept and never produces one. A caller wanting a STARTER slot must not
    // use this function.
    const kept = Array.from(new Set(raw)).filter(
      (id) => id > 0 && !isSnowballStackItem(id) && include(id)
    );
    if (kept.length > 0) games.push(kept);
  }
  const n = games.length;
  if (n === 0 || sampleGames <= 0) return [];

  const single = new Map<number, number>();
  const pairs = new Map<string, number>();
  const pairKey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const g of games) {
    for (const id of g) single.set(id, (single.get(id) ?? 0) + 1);
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const k = pairKey(g[i], g[j]);
        pairs.set(k, (pairs.get(k) ?? 0) + 1);
      }
    }
  }

  const toPct = (count: number) => Math.round((count / sampleGames) * 100);
  const pool = Array.from(single.entries())
    .map(([itemId, count]) => ({ itemId, games: count, pct: toPct(count) }))
    .filter((o) => o.pct >= minPct)
    // Most-built first, ties by id — the deterministic order the rest of the
    // app uses, so the same sample always produces the same slots.
    .sort((a, b) => b.games - a.games || a.itemId - b.itemId);

  /**
   * Do these two items compete? Lift below the measured threshold, and only
   * when the sample could have shown otherwise (see MIN_EXPECTED_COOCCURRENCE).
   * Note `n`, not `sampleGames`, is the population here: co-occurrence is a
   * statement about games that CARRIED items, and mixing in itemless rows would
   * deflate every expectation and manufacture competition out of nothing.
   */
  const competes = (a: { itemId: number; games: number }, b: { itemId: number; games: number }): boolean => {
    if (n < MIN_SAMPLE_GAMES) return false;
    const expected = (a.games / n) * (b.games / n) * n;
    if (expected < MIN_EXPECTED_COOCCURRENCE) return false;
    const observed = pairs.get(pairKey(a.itemId, b.itemId)) ?? 0;
    return observed / expected < COMPETES_MAX_LIFT;
  };

  // Greedy, highest build rate first. An item that competes with two different
  // go-tos attaches to the more-built one; that is deterministic and reads
  // correctly, since the stronger claim is the one about the bigger slot.
  const slots: BuildSlot[] = [];
  const taken = new Set<number>();
  for (const candidate of pool) {
    if (taken.has(candidate.itemId)) continue;
    if (slots.length >= maxSlots) break;
    taken.add(candidate.itemId);

    const alternatives: BuildSlotOption[] = [];
    for (const other of pool) {
      if (taken.has(other.itemId)) continue;
      if (alternatives.length >= maxAlternatives) break;
      if (!competes(candidate, other)) continue;
      taken.add(other.itemId);
      alternatives.push({ itemId: other.itemId, games: other.games, pct: other.pct });
    }

    slots.push({
      primary: { itemId: candidate.itemId, games: candidate.games, pct: candidate.pct },
      alternatives,
      sampleGames,
    });
  }
  return slots;
}
