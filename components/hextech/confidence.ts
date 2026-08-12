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

// ─── Chip colour, as a function of the band (2026-08-12) ─────────────────────
// Until now the confidence chip was hard-coded to the success green
// (`bg-[#46c79b]/15 text-[#46c79b]`) at EVERY band, so a LOW-confidence build
// wore the exact same green pill as a HIGH one — the word was the only signal,
// and a green pill glanced at reads "good". That inverts this badge's whole
// purpose (hard rule 4: no dishonest signals). Colour is now a function of the
// band, and the three bands are visibly distinct:
//   HIGH   → `good` green (#46c79b)  — positive, well past the noise floor.
//   MEDIUM → amber (#e0a244)         — cautionary; a thinner sample that a
//                                       patch shift can still swing.
//   LOW    → `bad` red (#e8736e)     — warning; treat this build with care.
// The hue is never the ONLY cue — the label itself ("High/Medium/Low
// confidence") carries the meaning for anyone who can't distinguish the
// colours. There is no amber token in the navy/lavender palette, so MEDIUM
// uses a literal warm amber chosen to sit between the existing `good`/`bad`
// signals; `good` and `bad` reuse the app's canonical data-signal tokens.
// Contrast note: all three text colours clear 4.5:1 against the hero
// gradient's dark ground at this 9px size (green ~7:1, amber ~6.7:1, red
// ~4.7:1). Keep this the single source of the chip's colour — see the three
// surfaces referenced in the redesign notes.
const CONFIDENCE_CHIP_CLASS: Record<ConfidenceBand, string> = {
  HIGH: "bg-[#46c79b]/15 text-[#46c79b]",
  MEDIUM: "bg-[#e0a244]/15 text-[#e0a244]",
  LOW: "bg-[#e8736e]/15 text-[#e8736e]",
};

/** Tailwind bg+text classes for the confidence chip at a given band. Pure —
 *  returns a class string, no JSX — so every surface that renders the chip
 *  stays in lockstep on colour. */
export function confidenceChipClass(band: ConfidenceBand): string {
  return CONFIDENCE_CHIP_CLASS[band];
}
