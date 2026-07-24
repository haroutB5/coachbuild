// ─────────────────────────────────────────────────────────────────────────────
// confidence.ts — pure sample-size confidence banding (v0.51 redesign wave A,
// draft/builds hero mockup's "HIGH/MEDIUM/LOW confidence" badge). A single
// shared banding function so every surface that shows a games-based
// confidence label (builds hero, draft picks, pro consensus) uses the same
// thresholds rather than each inventing its own cutoffs.
//
// Thresholds (rationale): this repo's existing confidence signals bottom out
// around a ~1000-2000 game "low sample" floor (e.g. BAN_MIN_MATCHUP_GAMES-
// style gates elsewhere, DraftConfidence's own low/normal split) and top out
// in the tens of thousands for a genuinely well-established meta pick.
// 15,000+ games is comfortably past noise for a single champion+role slice;
// under 4,000 is thin enough that a patch shift or a small pro-play sample
// can swing the number meaningfully. These are deliberately coarse (3 bands,
// not a continuous score) -- the badge is meant to be skimmed, not audited.
// ─────────────────────────────────────────────────────────────────────────────

export type ConfidenceBand = "HIGH" | "MEDIUM" | "LOW";

const HIGH_FLOOR = 15000;
const MEDIUM_FLOOR = 4000;

/** `adoption` (0..1 pick/adoption rate, when available) is accepted for a
 *  future refinement (a high-games-but-vanishingly-rare pick reads
 *  differently than a high-games staple) but is NOT currently used to move
 *  the band -- games alone already covers the honesty bar this badge needs,
 *  and fabricating an adoption-driven adjustment without a validated
 *  threshold would be exactly the kind of pseudo-precision this codebase's
 *  other honesty gates (see lib/draft/compRatings.ts's header) warn against.
 *  Accepted as a parameter now so call sites don't need a signature change
 *  later if that refinement is added. */
export function confidenceBand(games: number | null, adoption?: number): ConfidenceBand {
  void adoption;
  if (!games || games <= 0) return "LOW";
  if (games >= HIGH_FLOOR) return "HIGH";
  if (games >= MEDIUM_FLOOR) return "MEDIUM";
  return "LOW";
}
