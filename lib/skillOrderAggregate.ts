import {
  BASIC_ABILITIES,
  derivePriority,
  isAbility,
  levelsByAbility,
  MAX_RANKS,
  ULTIMATE_LEVELS,
} from "./skillOrderModel";
import type { Ability, SkillOrderModel } from "./types";

const SKILL_TIE_ORDER: readonly Ability[] = ["Q", "W", "E", "R"];
const ULTIMATE_LEVEL_SET = new Set<number>(ULTIMATE_LEVELS);
const MAX_LEVELS = 18;

/**
 * Assert that a measured prefix can be rendered as a legal standard skill
 * order. A short order is intentional: it represents levels the sample did
 * not reach (or that the aggregate could not assign without inventing a
 * rank), and the grid leaves those later levels empty.
 */
export function assertLegalSkillOrder(order: readonly Ability[]): void {
  if (!Array.isArray(order)) throw new Error("Skill order must be an array");
  if (order.length > MAX_LEVELS) {
    throw new Error(`Skill order has ${order.length} levels; maximum is ${MAX_LEVELS}`);
  }

  const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
  for (let index = 0; index < order.length; index += 1) {
    const ability = order[index];
    const level = index + 1;
    if (!isAbility(ability)) throw new Error(`Invalid ability at level ${level}`);
    if (ability === "R" && !ULTIMATE_LEVEL_SET.has(level)) {
      throw new Error(`R is not legal at level ${level}`);
    }
    counts[ability] += 1;
    if (counts[ability] > MAX_RANKS[ability]) {
      throw new Error(`${ability} exceeds its ${MAX_RANKS[ability]}-rank cap`);
    }
  }
}

/**
 * Parse one stored timeline value without treating malformed data as a real
 * observation. Neon normally returns jsonb arrays, but accepting a JSON string
 * keeps this pure boundary tolerant of driver/cache differences.
 */
export function parseSkillOrder(value: unknown): Ability[] {
  if (typeof value === "string") {
    try {
      return parseSkillOrder(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  // Do not remove an invalid token and shift later points left: that would turn
  // a malformed timeline into a different, apparently valid level sequence.
  if (!value.every(isAbility)) return [];
  return value.slice(0, MAX_LEVELS);
}

/**
 * Aggregate recorded timeline orders into the same model used by the Builds
 * recommendation card.
 *
 * Each level keeps the modal intent from the observations, but assignment is
 * capacity-aware. Basic abilities already at five ranks are skipped. R is
 * only assigned at 6/11/16; when a later R observation exists, it supports the
 * next legal ultimate slot and is normalized there, while a genuinely absent
 * R observation is never invented. If every current modal basic is capped,
 * the walk chooses from the remaining basic observations in future levels.
 *
 * At a current-level count tie, the tie-break is (1) more observations for
 * that ability at this and later levels, then (2) Q > W > E. This preserves
 * aggregate signal while making capacity-forced choices deterministic.
 *
 * The model's sampleSize remains the number of games with a non-empty recorded
 * order; it is never changed to a per-level denominator. A level no game
 * reached simply never enters `order`, so the shared 18-column grid leaves
 * that cell empty. No completion or inferred tail is produced here: these
 * surfaces have real timeline data, not a published 15-level source.
 */
export function aggregateRecordedSkillOrders(values: readonly unknown[]): SkillOrderModel | null {
  const orders = values.map(parseSkillOrder).filter((order) => order.length > 0);
  if (orders.length === 0) return null;

  const maxObservedLevel = Math.max(...orders.map((order) => order.length));
  const order: Ability[] = [];
  const remainingRanks: Record<Ability, number> = { ...MAX_RANKS };

  // Suffix counts are the observations still available when the walk reaches
  // a level. They serve both the explicit tie-break and the honest fallback
  // when the current modal ability has exhausted its rank cap.
  const remainingObservations = (level: number): Record<Ability, number> => {
    const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
    for (const observed of orders) {
      for (let i = level; i < observed.length; i += 1) {
        counts[observed[i]] += 1;
      }
    }
    return counts;
  };

  for (let level = 0; level < maxObservedLevel && level < MAX_LEVELS; level += 1) {
    const counts = new Map<Ability, number>();
    for (const observed of orders) {
      const ability = observed[level];
      if (ability) counts.set(ability, (counts.get(ability) ?? 0) + 1);
    }

    const suffix = remainingObservations(level);
    const isUltimateLevel = ULTIMATE_LEVEL_SET.has(level + 1);
    const observedUltimate = suffix.R > 0;

    // A delayed R is still evidence that this sample supports the rank. Put
    // it at the next legal slot, but leave the slot to the basic walk when no
    // R remains anywhere in the sample (a genuinely skipped ultimate).
    if (isUltimateLevel && observedUltimate && remainingRanks.R > 0) {
      order.push("R");
      remainingRanks.R -= 1;
      continue;
    }

    const availableBasics = BASIC_ABILITIES.filter((ability) => remainingRanks[ability] > 0);
    if (availableBasics.length === 0) break;

    const supportedBasics = availableBasics.filter((ability) => (counts.get(ability) ?? 0) > 0);
    // Prefer abilities observed at this level. If they are all capped, use a
    // future-observation-backed basic rather than fabricate a level from a
    // zero-information tie. A level with no observations is never reached in
    // this loop because maxObservedLevel comes from a real order prefix.
    const candidates =
      supportedBasics.length > 0
        ? supportedBasics
        : availableBasics.filter((ability) => suffix[ability] > 0);
    if (candidates.length === 0) break;

    const selected = [...candidates].sort(
      (abilityA, abilityB) =>
        (counts.get(abilityB) ?? 0) - (counts.get(abilityA) ?? 0) ||
        suffix[abilityB] - suffix[abilityA] ||
        SKILL_TIE_ORDER.indexOf(abilityA) - SKILL_TIE_ORDER.indexOf(abilityB)
    )[0];

    if (!selected) break;
    order.push(selected);
    remainingRanks[selected] -= 1;
  }

  if (order.length === 0) return null;

  assertLegalSkillOrder(order);

  return {
    priority: derivePriority(order),
    levels: levelsByAbility(order),
    order,
    completed: false,
    observedLevels: order.length,
    sampleSize: orders.length,
    winRate: null,
    share: null,
  };
}
