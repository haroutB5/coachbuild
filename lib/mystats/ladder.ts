// ─────────────────────────────────────────────────────────────────────────────
// lib/mystats/ladder.ts — (tier, division, lp) -> ONE absolute integer, so two
// rank readings can be subtracted. PURE: no DB, no network, no clock.
//
// WHY THIS EXISTS. `coachbuild.my_account` stores rank as three separate
// fields, and the obvious way to compute "LP this session" is `lp_after -
// lp_before`. That is wrong at every tier boundary in the game: Gold I 90 ->
// Platinum IV 10 is a PROMOTION worth +20 LP, and the naive subtraction reports
// it as -80. The user would see a good session rendered as a bad one, with no
// symptom other than the number being wrong — the failure class this app calls
// HARD RULE 4.
//
// ── THE SCALE ───────────────────────────────────────────────────────────────
//
// Iron IV 0 LP is the origin. Each division is LP_PER_DIVISION (100) points,
// each divisional tier is four divisions (400 points), and divisions run IV
// (lowest) -> III -> II -> I (highest), which is the reverse of their numeric
// order and the second-easiest thing in this file to get backwards.
//
// ── THE APEX TIERS ARE ONE POOL, NOT THREE TIERS ────────────────────────────
//
// This is the part that looks like an ordering problem and is not. Master,
// Grandmaster and Challenger do NOT sit on top of each other 400 points apart.
// They are a SINGLE continuous LP pool above Diamond I 100, and Grandmaster /
// Challenger are simply the top slices of that pool by rank cutoff. Two
// consequences the arithmetic must respect:
//
//   * A player at 400 LP can be Grandmaster on Monday and Master on Tuesday
//     without having played a game, because the cutoff moved. If the three
//     apex tiers had separate bases, that would render as a 400-point loss.
//   * Master 500 -> Grandmaster 520 is +20. It is a 20-LP gain that happened
//     to cross a cutoff.
//
// So all three apex tiers resolve to the SAME base (APEX_BASE), their LP is
// unbounded, and their `division` is IGNORED. Riot sends "I" for apex, where it
// is meaningless (see migrations/0022_mystats_rank.sql); adding the usual 300
// points for "I" would invent 300 LP at the moment of promotion into Master.
//
// APEX_BASE is DERIVED from the divisional tiers rather than written down, so
// the ladder stays continuous by construction: Diamond I 100 and Master 0 are
// the same point, and a future tier inserted below Master moves both together.
//
// ── IT FAILS CLOSED ─────────────────────────────────────────────────────────
//
// Every function here returns `null` for a reading it cannot place: an unknown
// tier, a divisional tier with no division, a missing/negative/non-integer LP,
// or `tier === null` (which means UNRANKED — a state with no position on the
// ladder at all, not a position of zero). Null propagates to
// `confidence: "unavailable"` and renders as a dash. It is never defaulted to
// 0, because a reading placed at Iron IV 0 by accident produces a delta of
// several thousand LP that looks like data.
// ─────────────────────────────────────────────────────────────────────────────

/** LP inside one division, and the width of one division on the scale. */
export const LP_PER_DIVISION = 100;

/** Divisions per divisional tier (IV, III, II, I). */
export const DIVISIONS_PER_TIER = 4;

/** The width of one whole divisional tier on the scale. */
export const LP_PER_TIER = LP_PER_DIVISION * DIVISIONS_PER_TIER;

/** The tiers that HAVE divisions, in ascending order. Riot's spelling,
 *  uppercase, exactly as it arrives from league-v4 and from the LCU. Confirmed
 *  ordering: lib/rankBrackets.ts's header (read out of a production bundle) —
 *  Iron 0 · Bronze 1 · Silver 2 · Gold 3 · Platinum 4 · Emerald 5 · Diamond 6.
 *  EMERALD is real and is easy to forget; omitting it puts every Diamond+
 *  reading a whole tier low. */
export const DIVISIONAL_TIERS = [
  "IRON",
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "EMERALD",
  "DIAMOND",
] as const;

/** The three tiers with no divisions and unbounded LP. See this file's header:
 *  they share ONE base, they are not stacked. */
export const APEX_TIERS = ["MASTER", "GRANDMASTER", "CHALLENGER"] as const;

/** Where the apex pool starts — immediately above Diamond I 100. Derived, so
 *  the ladder cannot develop a gap or an overlap when a tier is added. */
export const APEX_BASE = DIVISIONAL_TIERS.length * LP_PER_TIER;

/** Division -> points ABOVE the tier floor. IV is the bottom of a tier and I is
 *  the top; the numeral order is the opposite of the ladder order. */
const DIVISION_OFFSET: Readonly<Record<string, number>> = {
  IV: 0,
  III: LP_PER_DIVISION,
  II: LP_PER_DIVISION * 2,
  I: LP_PER_DIVISION * 3,
};

/** A rank reading, in the shape the database and the LCU both hand us. Nulls
 *  are expected and meaningful: a null tier is UNRANKED (or never read). */
export interface LadderPosition {
  tier: string | null | undefined;
  division: string | null | undefined;
  lp: number | null | undefined;
}

function normalise(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s.length === 0 ? null : s;
}

/** True only for a tier this module recognises as apex. An UNKNOWN tier is not
 *  apex and is not divisional — it is unplaceable, and `ladderPoints` says so
 *  by returning null. Never guess from the name. */
export function isApexTier(tier: string | null | undefined): boolean {
  const t = normalise(tier);
  return t !== null && (APEX_TIERS as readonly string[]).includes(t);
}

/**
 * The absolute position of a rank reading on one integer scale, or `null` when
 * the reading cannot be placed. Two placeable readings are comparable by plain
 * subtraction; that is the entire point of this function.
 *
 * LP is required to be a non-negative integer. It is NOT capped at 100 for
 * divisional tiers: a reading of 100 is legitimate (it is what a promotion
 * looks like at the instant it is read), and refusing an unexpected 103 would
 * turn a real number into a dash for no safety gain, since the arithmetic is
 * linear either way.
 */
export function ladderPoints(pos: LadderPosition): number | null {
  const tier = normalise(pos.tier);
  if (tier === null) return null; // unranked, or never read

  const lp = pos.lp;
  if (typeof lp !== "number" || !Number.isFinite(lp) || !Number.isInteger(lp) || lp < 0) return null;

  if ((APEX_TIERS as readonly string[]).includes(tier)) {
    // Division deliberately ignored — see this file's header.
    return APEX_BASE + lp;
  }

  const tierIndex = (DIVISIONAL_TIERS as readonly string[]).indexOf(tier);
  if (tierIndex < 0) return null; // a tier we do not know: fail closed

  const division = normalise(pos.division);
  if (division === null) return null;
  const offset = DIVISION_OFFSET[division];
  if (offset === undefined) return null;

  return tierIndex * LP_PER_TIER + offset + lp;
}

/**
 * `to - from` on the absolute scale: the signed LP moved between two readings.
 * Null when EITHER reading is unplaceable — a delta computed against a reading
 * we could not understand would be a fabricated number, and this module would
 * rather return nothing than something.
 */
export function ladderDelta(from: LadderPosition, to: LadderPosition): number | null {
  const a = ladderPoints(from);
  const b = ladderPoints(to);
  if (a === null || b === null) return null;
  const delta = b - a;
  // NORMALISE NEGATIVE ZERO. `0 - 0` is +0 but `-(0)` is -0, and JavaScript
  // keeps them distinct: a UI that formats with an explicit sign renders -0 as
  // "-0 LP", i.e. a session with no LP movement presented as a loss. Cheaper to
  // remove the value than to remember the rule at every render site.
  return delta === 0 ? 0 : delta;
}
