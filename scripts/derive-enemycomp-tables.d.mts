// Types for the plain-JS derivation oracle so lib/__tests__/enemyComp-tables
// .test.ts can consume it without `any`. The script itself stays .mjs: it is
// run directly by node with no build step, which is what makes it usable as a
// one-command check against the LIVE catalogue.

export type DerivedDamageType = "ad" | "ap" | "mixed";

export interface DerivedCounterItems {
  /** Boots tagged Tenacity or SpellBlock. */
  tenacityBoots: number[];
  /** Boots tagged Armor. */
  armorBoots: number[];
  /** Anything whose description mentions "Wounds", components included. */
  antiHeal: number[];
}

export declare const DAMAGE_MARGIN: number;

export declare function deriveCounterItems(itemJson: unknown): Promise<DerivedCounterItems>;

/** `null` for a champion whose ddragon `info` block is 0/0, which is UNKNOWN
 *  and deliberately distinct from a genuinely balanced `mixed`. */
export declare function deriveDamageBaseline(
  championJson: unknown
): Record<number, DerivedDamageType | null>;

/** Mirrors lib/enemyComp/championClass.ts's own union. Declared here rather
 *  than imported from it, deliberately: the ORACLE must not depend on the table
 *  it is the oracle for, or a wrong value in the table could not disagree with
 *  it. */
export type DerivedChampionItemClass =
  | "mage"
  | "assassin"
  | "marksman"
  | "fighter-bruiser"
  | "tank"
  | "enchanter-support";

/** `[ddragonTag, class]` pairs, in resolution order. */
export declare const CLASS_TAG_PRIORITY: readonly (readonly [string, DerivedChampionItemClass])[];

/** Every live champion id, resolved by CLASS_TAG_PRIORITY. Never null: a
 *  champion carrying none of the six tags falls to "fighter-bruiser". */
export declare function deriveChampionClassBaseline(
  championJson: unknown
): Record<number, DerivedChampionItemClass>;
