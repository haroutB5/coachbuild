// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/damageProfile.ts — draft redesign plan §2.3's "Suggested defense"
// replacement for the prototype's fabricated "Key Item Counter" stat. Pure,
// no network/DB — derives a defensive-item DIRECTION (never a specific final
// build slot) from ddragon's own attack/magic axes + tags, labeled as
// DERIVED, never as a measured stat. Mirrors lib/draft/compRatings.ts's
// standalone-module posture (small local type, no cross-file coupling)
// deliberately, same rationale components/proAssets.ts documents for staying
// decoupled from lib/staticData.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface SuggestedDefense {
  label: string;
  /** Short reasoning string, e.g. "their kit leans magic damage" — the UI
   *  sublabels this "(derived from their damage type)"; this field is the
   *  WHY, not a restatement of the label. */
  reason: string;
}

/** ddragon `info` block, 1-10 scale per axis. Deliberately a LOCAL copy of
 *  the same shape lib/draft/compRatings.ts's ChampInfo declares — this file
 *  stays a standalone, independently-testable module (no cross-file type
 *  coupling), same posture components/proAssets.ts documents for its own
 *  CDN-URL builders. */
export interface DamageProfileInfo {
  attack: number;
  defense: number;
  magic: number;
}

/** Tags whose kits are built around locking a target down rather than a
 *  clean damage-type read — Tenacity is the more actionable defensive call
 *  for these regardless of which damage type they lean, so this check runs
 *  BEFORE the magic-vs-attack comparison below. */
const HIGH_CC_TAGS = new Set(["Tank", "Support"]);

/**
 * Suggests a defensive-item DIRECTION for one enemy, derived from their
 * ddragon tags + attack/magic axes:
 *   - Tank/Support tag present -> Tenacity (their threat is being locked
 *     down, not raw damage type).
 *   - Otherwise magic > attack -> Magic Resist.
 *   - Otherwise attack > magic -> Armor.
 *   - Exact tie (rare — most champs lean one way) -> a mixed-defense call,
 *     never a coin-flip guess presented as confident.
 * Returns null only when there's nothing to derive from at all (no tags AND
 * no info) — never a fabricated default.
 */
export function suggestedDefense(tags: string[], info: DamageProfileInfo | null): SuggestedDefense | null {
  const highCC = tags.some((t) => HIGH_CC_TAGS.has(t));
  if (highCC) {
    return {
      label: "Tenacity (Mercury's Treads)",
      reason: "their kit leans on crowd control rather than raw damage type",
    };
  }
  if (!info) return null;
  if (info.magic > info.attack) {
    return {
      label: "Magic Resist / Mercury's Treads",
      reason: "their kit leans magic damage",
    };
  }
  if (info.attack > info.magic) {
    return {
      label: "Armor / Plated Steelcaps",
      reason: "their kit leans physical damage",
    };
  }
  return {
    label: "Mixed (Armor & Magic Resist)",
    reason: "their kit deals a roughly even physical/magic split",
  };
}
