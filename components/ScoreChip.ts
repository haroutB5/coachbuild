// Pure, testable logic for the CoachBuild Score chip on ProGameCard's dense
// row + the CS/min and KP micro-stats in its expandable panel. No JSX here —
// same discipline as StatBadge.tsx (vitest 4's oxc transform can't parse JSX
// outside its default scope without extra plugin config, and this file's
// exports are unit-tested under components/__tests__/). ProGameCard.tsx owns
// the markup; this file owns the grade -> color decision and the
// render-or-not guards for null/undefined stat fields.

import type { ProGameGrade } from "./proGames.types";

export const SCORE_CHIP_TITLE =
  "CoachBuild Score — performance grade from KDA, kill participation and CS";

/** Tailwind color classes per grade, green (best) -> red (worst) — the same
 *  graded-performance language app/globals.css's --good/--bad tokens reserve
 *  for "WPA / winrate / performance numbers ONLY". This chip IS a
 *  performance number, so it earns that language, NOT the cyan/lavender
 *  decorative accents used elsewhere on the card. S gets a deeper/more
 *  saturated green than A so the two don't read as the same tier at a
 *  glance; B is neutral gray (neither good nor bad); C is amber (soft
 *  warning, distinct from D's red). */
export function scoreGradeClasses(grade: ProGameGrade): string {
  switch (grade) {
    case "S":
      return "bg-[#10b981]/15 text-[#10b981] border-[#10b981]/30";
    case "A":
      return "bg-good/15 text-good border-good/30";
    case "B":
      return "bg-mut/15 text-mut border-mut/30";
    case "C":
      return "bg-[#f59e0b]/15 text-[#f59e0b] border-[#f59e0b]/30";
    case "D":
      return "bg-bad/15 text-bad border-bad/30";
  }
}

/** Guards the chip's "renders nothing when undefined" behavior — defensive
 *  against a game object missing score/grade (e.g. a stale service-worker-
 *  cached /api/pros payload from before this field existed, or a future
 *  contract change). ProGame types score as a required number and grade as a
 *  required literal, but a value crossing a JSON boundary is never as
 *  trustworthy as its compile-time type. */
export function hasScoreData(
  score: number | null | undefined,
  grade: string | null | undefined
): grade is ProGameGrade {
  return typeof score === "number" && Number.isFinite(score) && typeof grade === "string" && grade.length > 0;
}

/** "CS/min 7.3" — null (not yet backfilled, or a prostage row) renders
 *  nothing, never "CS/min 0.0" or a dash. */
export function formatCsPerMin(csPerMin: number | null): string | null {
  if (csPerMin === null || !Number.isFinite(csPerMin)) return null;
  return `CS/min ${csPerMin.toFixed(1)}`;
}

/** "KP 62%" from a 0-1 fraction — null renders nothing. */
export function formatKp(kp: number | null): string | null {
  if (kp === null || !Number.isFinite(kp)) return null;
  return `KP ${Math.round(kp * 100)}%`;
}
