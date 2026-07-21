// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/difficulty.ts — pure banding for ddragon's champion.json
// `info.difficulty` (1-10 scale). Draft redesign plan §2.1: display-only,
// never enters lib/draft/score.ts's scoring formula. No network — the raw
// difficulty number is already fetched/carried by lib/staticData.ts.
// ─────────────────────────────────────────────────────────────────────────────

export type DifficultyBand = "Low" | "Medium" | "High";

/** Named per the plan's exact banding: 1-3 Low, 4-6 Medium, 7-10 High. */
export const DIFFICULTY_LOW_MAX = 3;
export const DIFFICULTY_MEDIUM_MAX = 6;

/** `null` in -> `null` out (no fabricated band for a champion with no
 *  difficulty data, e.g. a gap-filled ddragon entry that predates this
 *  field, or a genuinely malformed value). */
export function difficultyBand(difficulty: number | null): DifficultyBand | null {
  if (difficulty === null || !Number.isFinite(difficulty)) return null;
  if (difficulty <= DIFFICULTY_LOW_MAX) return "Low";
  if (difficulty <= DIFFICULTY_MEDIUM_MAX) return "Medium";
  return "High";
}
