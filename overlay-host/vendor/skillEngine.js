// ../lib/championKit.ts
var SPELL_SLOTS = ["Q", "W", "E", "R"];
var TOTAL_LEVELS = 18;
var ULTIMATE_LEVELS = [6, 11, 16];
var ULTIMATE_SEMANTICS = {
  // Single-rank transform/stance (Jayce). Granted at level 1, never ranked
  // again, costs nothing — his 6+6+6 basics already consume all 18 points.
  1: { levels: [1], free: 1 },
  // True ultimate. The standard case, 166 champions plus Aphelios and Yuumi.
  3: { levels: ULTIMATE_LEVELS, free: 0 },
  // Level-1 form-swap ultimate (Elise, Karma, Nidalee). Rank 1 is free at
  // level 1; ranks 2-4 are bought on the ordinary ultimate cadence.
  4: { levels: [1, ...ULTIMATE_LEVELS], free: 1 },
  // Not an ultimate at all — a fourth basic-like ability (Udyr). No level
  // gate whatsoever; his "R" is legitimately ranked at level 2.
  6: { levels: null, free: 0 }
};
var ZERO_FREE = Object.freeze({ Q: 0, W: 0, E: 0, R: 0 });
function kitFromMaxRanks(maxranks) {
  if (!Array.isArray(maxranks) || maxranks.length !== SPELL_SLOTS.length) return null;
  if (!maxranks.every((n) => Number.isInteger(n) && n >= 1)) return null;
  const semantics = ULTIMATE_SEMANTICS[maxranks[3]];
  if (!semantics) return null;
  const maxRanks = Object.freeze({
    Q: maxranks[0],
    W: maxranks[1],
    E: maxranks[2],
    R: maxranks[3]
  });
  const freeRanks = Object.freeze({ ...ZERO_FREE, R: semantics.free });
  const purchasableTotal = maxRanks.Q + maxRanks.W + maxRanks.E + (maxRanks.R - semantics.free);
  return Object.freeze({
    maxRanks,
    freeRanks,
    ultimateLevels: semantics.levels === null ? null : Object.freeze([...semantics.levels]),
    purchasableTotal
  });
}
var STANDARD_KIT = kitFromMaxRanks([5, 5, 5, 3]);
function purchasedRanks(rank, ability, kit) {
  return Math.max(0, rank - kit.freeRanks[ability]);
}
function isUltimateRankLegal(rank, level, kit) {
  if (kit.ultimateLevels === null) return true;
  if (rank < 1 || rank > kit.ultimateLevels.length) return false;
  return level >= kit.ultimateLevels[rank - 1];
}

// ../lib/skillOrderModel.ts
var MAX_RANKS = STANDARD_KIT.maxRanks;
var SOURCE_LEVELS = 15;
var ABILITY_SET = /* @__PURE__ */ new Set(["Q", "W", "E", "R"]);
function isAbility(v) {
  return typeof v === "string" && ABILITY_SET.has(v);
}

// ../lib/nextSkill.ts
var RANKABLE = ["Q", "W", "E", "R"];
var none = (because) => ({ kind: "none", because });
function isNonNegativeInt(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}
function pointsSpent(ranks, kit = STANDARD_KIT) {
  return RANKABLE.reduce((sum, a) => sum + purchasedRanks(ranks[a], a, kit), 0);
}
function resolveNextSkill(input) {
  const { model, level, ranks } = input;
  if (!model) return none("no-model");
  if (model.kit === null) return none("unknown-kit");
  const kit = model.kit ?? STANDARD_KIT;
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) return none("bad-level");
  if (!ranks || typeof ranks !== "object") return none("bad-ranks");
  for (const a of RANKABLE) {
    if (!isNonNegativeInt(ranks[a])) return none("bad-ranks");
  }
  const spent = pointsSpent(ranks, kit);
  if (spent > TOTAL_LEVELS) return none("bad-ranks");
  for (const a of RANKABLE) {
    if (ranks[a] > kit.maxRanks[a]) return none("non-standard-kit");
  }
  const unspent = level - spent;
  if (unspent < 0) return none("over-spent");
  if (unspent === 0) return none("no-unspent");
  const order = model.order;
  if (!Array.isArray(order) || !order.every(isAbility)) return none("bad-order");
  const idx = spent;
  if (idx >= order.length) {
    return none(!model.completed && order.length <= SOURCE_LEVELS ? "model-incomplete" : "order-exhausted");
  }
  const ability = order[idx];
  const fromRank = ranks[ability];
  const toRank = fromRank + 1;
  if (fromRank >= kit.maxRanks[ability]) return none("capped-ability");
  if (ability === "R" && !isUltimateRankLegal(toRank, level, kit)) {
    return none("ultimate-illegal");
  }
  return { kind: "recommend", ability, fromRank, toRank, atLevel: idx + 1, unspent };
}
function isLiveSkillError(r) {
  return typeof r.error === "string";
}
function parseLiveSkillState(raw) {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw;
  if (!isNonNegativeInt(obj.level)) return null;
  if (!obj.abilities || typeof obj.abilities !== "object") return null;
  const src = obj.abilities;
  const out = {};
  for (const a of RANKABLE) {
    const v = src[a];
    if (!isNonNegativeInt(v)) return null;
    out[a] = v;
  }
  return { level: obj.level, abilities: out };
}
export {
  RANKABLE,
  isLiveSkillError,
  parseLiveSkillState,
  pointsSpent,
  resolveNextSkill
};
