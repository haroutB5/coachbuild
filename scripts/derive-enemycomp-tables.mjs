#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// derive-enemycomp-tables.mjs -- the OFFLINE derivation behind
// lib/enemyComp/counterItems.ts and lib/enemyComp/damageType.ts.
//
// It exists because the two obvious runtime shortcuts are both WRONG, measured
// 2026-08-29 against the live 16.16.1 catalogue:
//
//  1. A runtime regex over `descriptionText` for /Grievous Wounds/ finds
//     Mortal Reminder and Morellonomicon and MISSES Thornmail (3075) and
//     Chempunk Chainsword (6609), because on Summoner's Rift those two say
//     "apply 40% Wounds" while only their Arena variants (223075, 226609)
//     spell out "Grievous Wounds". Half the class, silently.
//  2. `maps["11"] === true` is NOT a Summoner's Rift filter. 323075
//     (Thornmail), 323222 (Mikael's) and 663172 (Zephyr) all set it and are
//     mode variants. `id < 10000` is required as well, the same rule
//     MAX_REAL_CHAMPION_ID already applies to champions.
//
// So the tables are PINNED IN SOURCE and this script is their oracle. A CI
// test re-runs the same derivation against a captured catalogue and fails when
// source and derivation disagree, which is what turns "upstream renamed a
// keyword" from a silent empty class into a red build.
//
// Usage:  node scripts/derive-enemycomp-tables.mjs [--patch 16.16.1]
// Writes nothing. Prints the derived tables for review/diff.
// ─────────────────────────────────────────────────────────────────────────────

const PATCH = process.argv.includes("--patch")
  ? process.argv[process.argv.indexOf("--patch") + 1]
  : "16.16.1";
const CDN = (f) => `https://cdn.coachless.gg/static-files/${PATCH}/${PATCH}/data/en_US/${f}`;

/** Real Summoner's Rift entries only. Mirrors lib/staticData.ts's
 *  MAX_REAL_CHAMPION_ID rule for champions; see header trap 2. */
const MAX_REAL_ID = 10000;
const isRealSr = (id, e) => id < MAX_REAL_ID && !!(e.maps && e.maps["11"]) && !!(e.gold && e.gold.purchasable);
const isFinal = (e) => !(e.into && e.into.length);
const strip = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export async function deriveCounterItems(itemJson) {
  const d = itemJson.data;
  const out = { tenacityBoots: [], armorBoots: [], antiHeal: [] };
  for (const [rawId, e] of Object.entries(d)) {
    const id = parseInt(rawId, 10);
    if (!isRealSr(id, e)) continue;
    const tags = e.tags || [];
    const text = strip(e.description);
    // Anti-heal is derived for its NEGATIVE control only (decision 2,
    // 2026-08-29: never injected into a build line). "Wounds", not
    // "Grievous Wounds" -- see header trap 1.
    if (/\bWounds\b/i.test(text)) out.antiHeal.push(id);
    if (!isFinal(e) && !tags.includes("Boots")) continue;
    // Boots are the one class where a COMPONENT is the real buy: Mercury's
    // Treads and Plated Steelcaps both upgrade into a tier-3 enchant, so
    // isFinal() would exclude exactly the ids that ship in the item set.
    if (!tags.includes("Boots")) continue;
    if (tags.includes("Tenacity") || tags.includes("SpellBlock")) out.tenacityBoots.push(id);
    if (tags.includes("Armor")) out.armorBoots.push(id);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => a - b);
  return out;
}

/** The DERIVED half of the damage-type table. `null` means ddragon has no
 *  usable read at all (a 0/0 info block, which four champions carry) -- that is
 *  UNKNOWN, deliberately distinct from a genuinely balanced "mixed", and every
 *  one of them must appear in the source file's corrections table. */
export const DAMAGE_MARGIN = 3;
export function deriveDamageBaseline(championJson) {
  const out = {};
  for (const e of Object.values(championJson.data)) {
    const id = parseInt(e.key, 10);
    if (id >= MAX_REAL_ID) continue;
    const info = e.info;
    if (!info || (info.attack === 0 && info.magic === 0)) { out[id] = null; continue; }
    const delta = info.attack - info.magic;
    out[id] = delta >= DAMAGE_MARGIN ? "ad" : -delta >= DAMAGE_MARGIN ? "ap" : "mixed";
  }
  return out;
}

/** The DERIVED baseline behind lib/enemyComp/championClass.ts.
 *
 *  ddragon `tags` resolved by a FIXED priority, because the tag array is a set
 *  and most champions carry two: Marksman > Assassin > Tank > Mage > Fighter >
 *  Support. The priority is what makes the derivation deterministic; it is not
 *  a claim that it is right. It is measurably not right -- 57 of 173 rows are
 *  corrected in source -- and that is exactly why the table is pinned there and
 *  this function is only its oracle. See that file's header.
 *
 *  A champion with none of the six tags falls to "fighter-bruiser", which no
 *  live champion currently hits; the branch exists so a future tag rename
 *  produces a stable wrong answer that a correction can disagree with, rather
 *  than an undefined the CI test cannot compare. */
export const CLASS_TAG_PRIORITY = [
  ["Marksman", "marksman"],
  ["Assassin", "assassin"],
  ["Tank", "tank"],
  ["Mage", "mage"],
  ["Fighter", "fighter-bruiser"],
  ["Support", "enchanter-support"],
];

export function deriveChampionClassBaseline(championJson) {
  const out = {};
  for (const e of Object.values(championJson.data)) {
    const id = parseInt(e.key, 10);
    if (id >= MAX_REAL_ID) continue;
    const tags = Array.isArray(e.tags) ? e.tags : [];
    let cls = "fighter-bruiser";
    for (const [tag, candidate] of CLASS_TAG_PRIORITY) {
      if (tags.includes(tag)) { cls = candidate; break; }
    }
    out[id] = cls;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("derive-enemycomp-tables.mjs")) {
  const [items, champs] = await Promise.all([
    fetch(CDN("item.json")).then((r) => r.json()),
    fetch(CDN("champion.json")).then((r) => r.json()),
  ]);
  const ci = await deriveCounterItems(items);
  const names = (ids) => ids.map((id) => `${id} ${items.data[id].name}`).join(", ");
  console.log(`patch ${PATCH}`);
  console.log("tenacityBoots:", names(ci.tenacityBoots));
  console.log("armorBoots   :", names(ci.armorBoots));
  console.log("antiHeal     :", names(ci.antiHeal));
  const base = deriveDamageBaseline(champs);
  const counts = { ad: 0, ap: 0, mixed: 0, unknown: 0 };
  for (const v of Object.values(base)) counts[v ?? "unknown"]++;
  console.log("damage baseline (margin >=", DAMAGE_MARGIN + "):", JSON.stringify(counts));
  const byId = new Map(Object.values(champs.data).map((e) => [parseInt(e.key, 10), e.name]));
  console.log("unknown (0/0 info, MUST be corrected in source):",
    Object.entries(base).filter(([, v]) => v === null).map(([id]) => `${id} ${byId.get(+id)}`).join(", "));
  console.log("\n// paste-ready baseline");
  console.log(JSON.stringify(base));
  const cb = deriveChampionClassBaseline(champs);
  const clsCounts = {};
  for (const v of Object.values(cb)) clsCounts[v] = (clsCounts[v] ?? 0) + 1;
  console.log("class baseline:", JSON.stringify(clsCounts));
}
