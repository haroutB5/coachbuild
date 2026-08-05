import {
  BASIC_ABILITIES,
  derivePriority,
  isAbility,
  levelsByAbility,
  STANDARD_KIT,
  ULTIMATE_LEVELS,
} from "./skillOrderModel";
import { isUltimateRankLegal } from "./championKit";
import type { Ability, ChampionKit, SkillOrderModel } from "./types";

const SKILL_TIE_ORDER: readonly Ability[] = ["Q", "W", "E", "R"];
const ULTIMATE_LEVEL_SET = new Set<number>(ULTIMATE_LEVELS);
const MAX_LEVELS = 18;

function isStandardRecordedKit(kit: ChampionKit): boolean {
  return (
    kit.maxRanks.Q === STANDARD_KIT.maxRanks.Q &&
    kit.maxRanks.W === STANDARD_KIT.maxRanks.W &&
    kit.maxRanks.E === STANDARD_KIT.maxRanks.E &&
    kit.maxRanks.R === STANDARD_KIT.maxRanks.R &&
    kit.freeRanks.Q === 0 &&
    kit.freeRanks.W === 0 &&
    kit.freeRanks.E === 0 &&
    kit.freeRanks.R === 0 &&
    kit.ultimateLevels?.join(",") === STANDARD_KIT.ultimateLevels?.join(",") &&
    kit.rAuto !== true
  );
}

/**
 * Assert that a measured prefix can be rendered as a legal kit-aware skill
 * order. A short order is intentional: it represents levels the sample did
 * not reach (or that the aggregate could not assign without inventing a
 * rank), and the grid leaves those later levels empty.
 */
export function assertLegalSkillOrder(order: readonly Ability[], kit: ChampionKit = STANDARD_KIT): void {
  if (!Array.isArray(order)) throw new Error("Skill order must be an array");
  if (order.length > MAX_LEVELS) {
    throw new Error(`Skill order has ${order.length} levels; maximum is ${MAX_LEVELS}`);
  }

  const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
  for (let index = 0; index < order.length; index += 1) {
    const ability = order[index];
    const level = index + 1;
    if (!isAbility(ability)) throw new Error(`Invalid ability at level ${level}`);
    if (ability === "R") {
      const rAuto = kit.rAuto === true || kit.maxRanks.R === 1;
      if (rAuto) {
        // Jayce's R is a free transform state and is never a serialized
        // level-up event. Aphelios is the one auto-R kit whose returned
        // aggregate may carry normalized R markers for the grid.
        if (kit.maxRanks.R === 1) {
          throw new Error(`R is not a recorded level-up for this kit at level ${level}`);
        }
        const autoLevels = new Set(
          (kit.ultimateLevels ?? ULTIMATE_LEVELS).filter((candidate) => candidate > kit.freeRanks.R)
        );
        if (!autoLevels.has(level)) throw new Error(`R is not legal at level ${level}`);
      } else if (kit.ultimateLevels !== null) {
        const rank = counts.R + kit.freeRanks.R + 1;
        if (!isUltimateRankLegal(rank, level, kit)) {
          throw new Error(`R is not legal at level ${level}`);
        }
      }
    }
    counts[ability] += 1;
    if (counts[ability] + (ability === "R" ? kit.freeRanks.R : 0) > kit.maxRanks[ability]) {
      throw new Error(`${ability} exceeds its ${kit.maxRanks[ability]}-rank cap`);
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
 * The prefix-conditional walk attempts to keep the aggregate on a real-game
 * basics path: at each basic slot
 * the electorate is the set of games whose basics-only prefix exactly matches
 * the prefix chosen so far. This keeps the aggregate on a path that at least
 * one real game played while that electorate remains non-empty. If no game
 * extends the chosen prefix, the remaining basic slots deliberately degrade
 * to the old per-level marginal counts, suffix counts, and tie order; that
 * fallback is necessary for malformed or irregular samples and is the one
 * place where the real-prefix guarantee no longer applies. Assignment remains
 * capacity-aware under the supplied ChampionKit. Basic abilities at their kit
 * caps are skipped. Standard/R4 ultimates keep the existing 6/11/16
 * normalization; Udyr's R is walked as a fourth basic, Jayce's R markers are
 * dropped, and Aphelios's zero-cost R markers are stripped then reinserted at
 * the canonical auto-rank levels. A genuinely absent standard R observation is
 * never invented. If the conditional winner is capped, the next available
 * candidate is selected using the same suffix/tie ordering.
 *
 * At a count tie in either walk, the tie-break is (1) more observations for
 * that ability at this and later slots, then (2) Q > W > E. This preserves
 * aggregate signal while making capacity-forced choices deterministic.
 *
 * The model's sampleSize remains the number of games with a non-empty recorded
 * order; it is never changed to a per-level denominator. A level no game
 * reached simply never enters `order`, so the shared 18-column grid leaves
 * that cell empty. No completion or inferred tail is produced here: these
 * surfaces have real timeline data, not a published 15-level source.
 */
export function aggregateRecordedSkillOrders(
  values: readonly unknown[],
  kit: ChampionKit | null = STANDARD_KIT
): SkillOrderModel | null {
  const orders = values.map(parseSkillOrder).filter((order) => order.length > 0);
  if (orders.length === 0 || kit === null) return null;

  const rAuto = kit.rAuto === true || kit.maxRanks.R === 1;
  const rIsBasic = kit.ultimateLevels === null;
  const rIsUltimate = !rAuto && !rIsBasic;
  const maxObservedLevel = Math.max(...orders.map((order) => order.length));
  // R is removed from the prefix walk for true ultimates and auto-R kits. An
  // Udyr R is a fourth basic, so it remains in the walk and is counted under
  // its own six-rank cap.
  const basicsOnly = orders.map((observed) =>
    rIsBasic ? [...observed] : observed.filter((ability) => ability !== "R")
  );
  const basicAbilities: readonly Ability[] = rIsBasic ? [...BASIC_ABILITIES, "R"] : BASIC_ABILITIES;
  const order: Ability[] = [];
  const remainingRanks: Record<Ability, number> = { ...kit.maxRanks };
  // A free R rank is known to the kit but never appears as a recorded point.
  // Only purchased R ranks can be normalized into a standard/R4 aggregate.
  if (rIsUltimate) remainingRanks.R = Math.max(0, kit.maxRanks.R - kit.freeRanks.R);

  // Aphelios's R markers are zero-cost timeline events. Reinsert them at the
  // canonical auto-rank levels after stripping the raw markers. Jayce's R is
  // also automatic, but maxrank 1 is an overlay-only state and does not occupy
  // a skill-point column in the returned order.
  const autoMarkerLevels = new Set<number>(
    rAuto && kit.maxRanks.R > 1
      ? (kit.ultimateLevels ?? ULTIMATE_LEVELS).filter((level) => level > kit.freeRanks.R)
      : []
  );

  // Marginal fallback must see the same level alignment as the kit-aware walk:
  // Aphelios's zero-cost markers are stripped and reinserted at canonical
  // levels, while malformed Jayce R tokens are simply removed. Otherwise a
  // fallback vote after an early prefix divergence would count every later
  // basic one slot late.
  const marginalOrders = rAuto
    ? orders.map((observed) => {
        const basics = observed.filter((ability) => ability !== "R");
        if (kit.maxRanks.R === 1) return basics;
        const normalized: Ability[] = [];
        let basicIndex = 0;
        for (let level = 1; level <= observed.length; level += 1) {
          if (autoMarkerLevels.has(level)) normalized.push("R");
          else if (basicIndex < basics.length) normalized.push(basics[basicIndex++]);
        }
        return normalized;
      })
    : orders;

  const selectedBasicsPrefix: Ability[] = [];
  let basicSlot = 0;
  let prefixWalkActive = true;

  const suffixCounts = (
    observations: readonly (readonly Ability[])[],
    start: number
  ): Record<Ability, number> => {
    const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
    for (const observed of observations) {
      for (let i = start; i < observed.length; i += 1) {
        counts[observed[i]] += 1;
      }
    }
    return counts;
  };

  const sortCandidates = (
    candidates: readonly Ability[],
    counts: Record<Ability, number>,
    suffix: Record<Ability, number>
  ): Ability | null => {
    return (
      [...candidates].sort(
        (abilityA, abilityB) =>
          counts[abilityB] - counts[abilityA] ||
          suffix[abilityB] - suffix[abilityA] ||
          SKILL_TIE_ORDER.indexOf(abilityA) - SKILL_TIE_ORDER.indexOf(abilityB)
      )[0] ?? null
    );
  };

  const chooseMarginalBasic = (level: number): Ability | null => {
    const availableBasics = basicAbilities.filter((ability) => remainingRanks[ability] > 0);
    if (availableBasics.length === 0) return null;

    const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
    for (const observed of marginalOrders) {
      const ability = observed[level];
      if (ability) counts[ability] += 1;
    }

    const suffix = suffixCounts(marginalOrders, level);
    const supportedBasics = availableBasics.filter((ability) => counts[ability] > 0);
    const candidates =
      supportedBasics.length > 0
        ? supportedBasics
        : availableBasics.filter((ability) => suffix[ability] > 0);
    return sortCandidates(candidates, counts, suffix);
  };

  const chooseConditionalBasic = (slot: number): { electorate: number; selected: Ability | null } => {
    const electorate = basicsOnly.filter((observed) => {
      if (observed.length <= slot) return false;
      for (let index = 0; index < slot; index += 1) {
        if (observed[index] !== selectedBasicsPrefix[index]) return false;
      }
      return true;
    });

    if (electorate.length === 0) return { electorate: 0, selected: null };

    const availableBasics = basicAbilities.filter((ability) => remainingRanks[ability] > 0);
    if (availableBasics.length === 0) return { electorate: electorate.length, selected: null };

    const counts: Record<Ability, number> = { Q: 0, W: 0, E: 0, R: 0 };
    for (const observed of electorate) counts[observed[slot]] += 1;

    // The suffix tie-break follows the same conditional electorate. If the
    // modal entry is capped, this lets a future-observed available basic win
    // without inventing an ability absent from the remaining sample.
    const suffix = suffixCounts(electorate, slot);
    const supportedBasics = availableBasics.filter((ability) => counts[ability] > 0);
    const candidates =
      supportedBasics.length > 0
        ? supportedBasics
        : availableBasics.filter((ability) => suffix[ability] > 0);

    return { electorate: electorate.length, selected: sortCandidates(candidates, counts, suffix) };
  };

  for (let level = 0; level < maxObservedLevel && level < MAX_LEVELS; level += 1) {
    const suffix = suffixCounts(orders, level);
    const isUltimateLevel = ULTIMATE_LEVEL_SET.has(level + 1);
    const observedUltimate = suffix.R > 0;

    // Preserve the existing standard/R4 behavior: a delayed R observation
    // supports the next legal 6/11/16 slot. Udyr has no ultimate slots, while
    // auto-R kits use the known auto-marker schedule above instead.
    if (rIsUltimate && isUltimateLevel && observedUltimate && remainingRanks.R > 0) {
      order.push("R");
      remainingRanks.R -= 1;
      continue;
    }

    if (autoMarkerLevels.has(level + 1)) {
      order.push("R");
      continue;
    }

    let selected: Ability | null = null;
    if (prefixWalkActive) {
      const conditional = chooseConditionalBasic(basicSlot);
      if (conditional.electorate === 0) {
        // From this point on, preserve the old marginal behavior rather than
        // claiming that a newly selected prefix was played by a real game.
        prefixWalkActive = false;
      } else {
        selected = conditional.selected;
        if (!selected) break;
      }
    }
    if (!selected) selected = chooseMarginalBasic(level);
    if (!selected) break;

    order.push(selected);
    remainingRanks[selected] -= 1;
    basicSlot += 1;
    if (prefixWalkActive) selectedBasicsPrefix.push(selected);
  }

  if (order.length === 0) return null;

  assertLegalSkillOrder(order, kit);

  const model: SkillOrderModel = {
    priority: derivePriority(order, kit),
    levels: levelsByAbility(order),
    order,
    completed: false,
    observedLevels: order.length,
    sampleSize: orders.length,
    winRate: null,
    share: null,
  };
  // Preserve the round-2 standard model byte-for-byte. Non-standard kits
  // carry their resolved rules because the grid needs them for Udyr's basic R
  // and the Jayce/Aphelios automatic-R treatment.
  if (!isStandardRecordedKit(kit)) model.kit = kit;
  return model;
}
