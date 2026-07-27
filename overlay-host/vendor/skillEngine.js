// ../lib/skillOrderModel.ts
var MAX_RANKS = Object.freeze({
  Q: 5,
  W: 5,
  E: 5,
  R: 3
});
var TOTAL_LEVELS = 18;
var SOURCE_LEVELS = 15;
var ULTIMATE_LEVELS = [6, 11, 16];
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
function pointsSpent(ranks) {
  return RANKABLE.reduce((sum, a) => sum + ranks[a], 0);
}
function resolveNextSkill(input) {
  const { model, level, ranks } = input;
  if (!model) return none("no-model");
  if (!Number.isInteger(level) || level < 1 || level > TOTAL_LEVELS) return none("bad-level");
  if (!ranks || typeof ranks !== "object") return none("bad-ranks");
  for (const a of RANKABLE) {
    if (!isNonNegativeInt(ranks[a])) return none("bad-ranks");
  }
  const spent = pointsSpent(ranks);
  if (spent > TOTAL_LEVELS) return none("bad-ranks");
  for (const a of RANKABLE) {
    if (ranks[a] > MAX_RANKS[a]) return none("non-standard-kit");
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
  if (fromRank >= MAX_RANKS[ability]) return none("capped-ability");
  if (ability === "R") {
    if (toRank > ULTIMATE_LEVELS.length) return none("ultimate-illegal");
    if (level < ULTIMATE_LEVELS[toRank - 1]) return none("ultimate-illegal");
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
