/** Freshness window for pro games. Builds are patch-relative — a game from a
 *  past bootcamp (e.g. Faker's Oct-2024 Worlds EUW games) predates entire item
 *  overhauls and is actively misleading as inspiration, so anything older than
 *  this is neither served nor ingested. 90 days ≈ 6 patches, generous enough
 *  to keep semi-active accounts visible. */
export const FRESH_WINDOW_DAYS = 90;

/** Epoch seconds cutoff for Riot match-v5 `startTime` filtering. */
export function freshStartTimeEpochSec(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000) - FRESH_WINDOW_DAYS * 86400;
}
