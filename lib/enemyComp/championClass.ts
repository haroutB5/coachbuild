// ─────────────────────────────────────────────────────────────────────────────
// championClass.ts -- which ITEM class a champion builds, for the "For this
// game" block's per-class scenario table (lib/enemyComp/scenarioItems.ts).
//
// THE CLASS NAMES THE ITEMS, NOT THE LANE ARCHETYPE, and that distinction is
// load-bearing. This table exists for exactly one purpose: to answer "which
// counter item does this champion actually buy". So Master Yi is `marksman`
// (he buys crit and attack speed, and his answer to two healers is Mortal
// Reminder, not Chempunk Chainsword) and Gragas is `mage` (he buys Liandry's,
// and his answer to two tanks is Void Staff). Reading these labels as a
// taxonomy of playstyle will produce wrong conclusions; reading them as
// "which column of CLASS_SCENARIO_ITEMS applies" is what they mean.
//
// CURATED, with a DERIVED BASELINE, exactly like damageType.ts. The baseline is
// ddragon's `tags`, resolved by the fixed priority
// Marksman > Assassin > Tank > Mage > Fighter > Support
// (scripts/derive-enemycomp-tables.mjs, `deriveChampionClassBaseline`), and
// **57 of the 173 rows are corrected by hand**. That 33% correction rate is
// itself the finding and the reason the table is pinned in source rather than
// computed at runtime: ddragon files 46 champions as Tank and 39 as Assassin,
// which is not a build-class taxonomy. Urgot, Xin Zhao, Warwick, Olaf, Renekton
// and Jarvan all read `Fighter/Tank` and all buy bruiser items; Master Yi,
// Tryndamere, Yasuo and Yone all read `Assassin` and all buy crit.
//
// A test asserts every id in CHAMPION_CLASS_CORRECTIONS genuinely DISAGREES
// with the derived baseline, so a correction upstream later agrees with is
// flagged as dead weight instead of silently kept, and a second test asserts
// every live champion id has a row.
//
// PURE. No network, no clock, no React. Every input is a champion id and a
// lane the player can already see in champ select.
// ─────────────────────────────────────────────────────────────────────────────

import type { LaneId } from "@/components/hextech/heroContracts";

/** The six item classes. `enchanter-support` is the only one whose name
 *  mentions a role, because it is the only one that IS a role: the same
 *  champion (Senna) buys marksman items bot and enchanter items support. */
export type ChampionItemClass =
  | "mage"
  | "assassin"
  | "marksman"
  | "fighter-bruiser"
  | "tank"
  | "enchanter-support";

/** 173 rows, one per live champion, sorted by id. Values are FINAL (derived
 *  baseline with the corrections already applied); a corrected row's comment
 *  records what the derivation said and which tags it said it from. */
export const CHAMPION_CLASS: Readonly<Record<number, ChampionItemClass>> = {
  1: "mage",                // Annie
  2: "fighter-bruiser",     // Olaf  CORRECTED from tank (tags Fighter/Tank)
  3: "tank",                // Galio
  4: "mage",                // Twisted Fate  CORRECTED from marksman (tags Mage/Marksman)
  5: "fighter-bruiser",     // Xin Zhao  CORRECTED from tank (tags Fighter/Tank)
  6: "fighter-bruiser",     // Urgot  CORRECTED from tank (tags Fighter/Tank)
  7: "assassin",            // LeBlanc
  8: "mage",                // Vladimir
  9: "mage",                // Fiddlesticks
  10: "mage",               // Kayle  CORRECTED from marksman (tags Marksman/Mage)
  11: "marksman",           // Master Yi  CORRECTED from assassin (tags Fighter/Assassin)
  12: "tank",               // Alistar
  13: "mage",               // Ryze
  14: "tank",               // Sion
  15: "marksman",           // Sivir
  16: "enchanter-support",  // Soraka  CORRECTED from mage (tags Support/Mage)
  17: "mage",               // Teemo  CORRECTED from marksman (tags Marksman/Mage)
  18: "marksman",           // Tristana
  19: "fighter-bruiser",    // Warwick  CORRECTED from tank (tags Fighter/Tank)
  20: "tank",               // Nunu & Willump
  21: "marksman",           // Miss Fortune
  22: "marksman",           // Ashe
  23: "marksman",           // Tryndamere  CORRECTED from assassin (tags Fighter/Assassin)
  24: "fighter-bruiser",    // Jax
  25: "mage",               // Morgana
  26: "enchanter-support",  // Zilean  CORRECTED from mage (tags Support/Mage)
  27: "tank",               // Singed
  28: "assassin",           // Evelynn
  29: "marksman",           // Twitch
  30: "mage",               // Karthus
  31: "tank",               // Cho'Gath
  32: "tank",               // Amumu
  33: "tank",               // Rammus
  34: "mage",               // Anivia
  35: "assassin",           // Shaco
  36: "tank",               // Dr. Mundo
  37: "enchanter-support",  // Sona  CORRECTED from mage (tags Support/Mage)
  38: "assassin",           // Kassadin
  39: "fighter-bruiser",    // Irelia  CORRECTED from assassin (tags Fighter/Assassin)
  40: "enchanter-support",  // Janna  CORRECTED from mage (tags Support/Mage)
  41: "fighter-bruiser",    // Gangplank
  42: "marksman",           // Corki
  43: "enchanter-support",  // Karma  CORRECTED from mage (tags Mage/Support)
  44: "enchanter-support",  // Taric  CORRECTED from tank (tags Support/Tank)
  45: "mage",               // Veigar
  48: "fighter-bruiser",    // Trundle  CORRECTED from tank (tags Fighter/Tank)
  50: "mage",               // Swain
  51: "marksman",           // Caitlyn
  53: "tank",               // Blitzcrank
  54: "tank",               // Malphite
  55: "assassin",           // Katarina
  56: "assassin",           // Nocturne
  57: "tank",               // Maokai
  58: "fighter-bruiser",    // Renekton  CORRECTED from tank (tags Fighter/Tank)
  59: "fighter-bruiser",    // Jarvan IV  CORRECTED from tank (tags Fighter/Tank)
  60: "assassin",           // Elise
  61: "mage",               // Orianna
  62: "fighter-bruiser",    // Wukong  CORRECTED from tank (tags Fighter/Tank)
  63: "mage",               // Brand
  64: "fighter-bruiser",    // Lee Sin  CORRECTED from assassin (tags Fighter/Assassin)
  67: "marksman",           // Vayne
  68: "mage",               // Rumble
  69: "mage",               // Cassiopeia
  72: "tank",               // Skarner
  74: "mage",               // Heimerdinger
  75: "fighter-bruiser",    // Nasus  CORRECTED from tank (tags Fighter/Tank)
  76: "assassin",           // Nidalee
  77: "fighter-bruiser",    // Udyr  CORRECTED from tank (tags Fighter/Tank)
  78: "tank",               // Poppy
  79: "mage",               // Gragas
  80: "fighter-bruiser",    // Pantheon  CORRECTED from assassin (tags Fighter/Assassin)
  81: "marksman",           // Ezreal
  82: "mage",               // Mordekaiser
  83: "fighter-bruiser",    // Yorick  CORRECTED from tank (tags Fighter/Tank)
  84: "assassin",           // Akali
  85: "mage",               // Kennen
  86: "fighter-bruiser",    // Garen  CORRECTED from tank (tags Fighter/Tank)
  89: "tank",               // Leona
  90: "mage",               // Malzahar
  91: "assassin",           // Talon
  92: "fighter-bruiser",    // Riven  CORRECTED from assassin (tags Fighter/Assassin)
  96: "marksman",           // Kog'Maw
  98: "tank",               // Shen
  99: "mage",               // Lux
  101: "mage",              // Xerath
  102: "fighter-bruiser",   // Shyvana  CORRECTED from tank (tags Fighter/Tank)
  103: "assassin",          // Ahri
  104: "marksman",          // Graves
  105: "assassin",          // Fizz
  106: "fighter-bruiser",   // Volibear  CORRECTED from tank (tags Fighter/Tank)
  107: "assassin",          // Rengar
  110: "marksman",          // Varus
  111: "tank",              // Nautilus
  112: "mage",              // Viktor
  113: "tank",              // Sejuani
  114: "fighter-bruiser",   // Fiora  CORRECTED from assassin (tags Fighter/Assassin)
  115: "mage",              // Ziggs
  117: "enchanter-support", // Lulu  CORRECTED from mage (tags Support/Mage)
  119: "marksman",          // Draven
  120: "fighter-bruiser",   // Hecarim  CORRECTED from tank (tags Fighter/Tank)
  121: "assassin",          // Kha'Zix
  122: "fighter-bruiser",   // Darius  CORRECTED from tank (tags Fighter/Tank)
  126: "fighter-bruiser",   // Jayce  CORRECTED from marksman (tags Fighter/Marksman)
  127: "mage",              // Lissandra
  131: "assassin",          // Diana
  133: "marksman",          // Quinn
  134: "mage",              // Syndra
  136: "mage",              // Aurelion Sol
  141: "assassin",          // Kayn
  142: "assassin",          // Zoe  CORRECTED from mage (tags Mage)
  143: "mage",              // Zyra
  145: "marksman",          // Kai'Sa
  147: "enchanter-support", // Seraphine  CORRECTED from mage (tags Support/Mage)
  150: "tank",              // Gnar
  154: "tank",              // Zac
  157: "marksman",          // Yasuo  CORRECTED from assassin (tags Fighter/Assassin)
  161: "mage",              // Vel'Koz
  163: "mage",              // Taliyah
  164: "fighter-bruiser",   // Camille  CORRECTED from assassin (tags Fighter/Assassin)
  166: "assassin",          // Akshan  CORRECTED from marksman (tags Marksman/Assassin)
  200: "fighter-bruiser",   // Bel'Veth
  201: "tank",              // Braum
  202: "marksman",          // Jhin
  203: "marksman",          // Kindred
  221: "marksman",          // Zeri
  222: "marksman",          // Jinx
  223: "tank",              // Tahm Kench
  233: "fighter-bruiser",   // Briar  CORRECTED from assassin (tags Fighter/Assassin)
  234: "fighter-bruiser",   // Viego  CORRECTED from assassin (tags Fighter/Assassin)
  235: "marksman",          // Senna
  236: "marksman",          // Lucian
  238: "assassin",          // Zed
  240: "fighter-bruiser",   // Kled
  245: "assassin",          // Ekko
  246: "assassin",          // Qiyana
  254: "fighter-bruiser",   // Vi  CORRECTED from assassin (tags Fighter/Assassin)
  266: "fighter-bruiser",   // Aatrox
  267: "enchanter-support", // Nami  CORRECTED from mage (tags Support/Mage)
  268: "mage",              // Azir  CORRECTED from marksman (tags Mage/Marksman)
  350: "enchanter-support", // Yuumi  CORRECTED from mage (tags Support/Mage)
  360: "marksman",          // Samira
  412: "tank",              // Thresh
  420: "fighter-bruiser",   // Illaoi  CORRECTED from tank (tags Fighter/Tank)
  421: "fighter-bruiser",   // Rek'Sai  CORRECTED from tank (tags Fighter/Tank)
  427: "enchanter-support", // Ivern  CORRECTED from mage (tags Support/Mage)
  429: "marksman",          // Kalista
  432: "enchanter-support", // Bard  CORRECTED from mage (tags Support/Mage)
  497: "enchanter-support", // Rakan
  498: "marksman",          // Xayah
  516: "tank",              // Ornn
  517: "assassin",          // Sylas
  518: "mage",              // Neeko
  523: "marksman",          // Aphelios
  526: "tank",              // Rell
  555: "assassin",          // Pyke
  711: "assassin",          // Vex  CORRECTED from mage (tags Mage)
  777: "marksman",          // Yone  CORRECTED from assassin (tags Fighter/Assassin)
  799: "fighter-bruiser",   // Ambessa  CORRECTED from assassin (tags Fighter/Assassin)
  800: "mage",              // Mel
  804: "marksman",          // Yunara
  805: "assassin",          // Locke
  875: "fighter-bruiser",   // Sett  CORRECTED from tank (tags Fighter/Tank)
  876: "mage",              // Lillia
  887: "mage",              // Gwen  CORRECTED from fighter-bruiser (tags Fighter)
  888: "enchanter-support", // Renata Glasc  CORRECTED from mage (tags Support/Mage)
  893: "assassin",          // Aurora
  895: "marksman",          // Nilah  CORRECTED from assassin (tags Fighter/Assassin)
  897: "tank",              // K'Sante
  901: "marksman",          // Smolder
  902: "enchanter-support", // Milio  CORRECTED from mage (tags Support/Mage)
  904: "fighter-bruiser",   // Zaahen
  910: "mage",              // Hwei
  950: "assassin",          // Naafiri
};

/** The ids whose class was overridden by hand. Exported so the CI test can
 *  assert each one genuinely disagrees with the derived baseline -- a
 *  correction that upstream has since caught up with is dead weight carrying an
 *  authority it no longer has. */
export const CHAMPION_CLASS_CORRECTIONS: readonly number[] = [
  2,    // Olaf
  4,    // Twisted Fate
  5,    // Xin Zhao
  6,    // Urgot
  10,   // Kayle
  11,   // Master Yi
  16,   // Soraka
  17,   // Teemo
  19,   // Warwick
  23,   // Tryndamere
  26,   // Zilean
  37,   // Sona
  39,   // Irelia
  40,   // Janna
  43,   // Karma
  44,   // Taric
  48,   // Trundle
  58,   // Renekton
  59,   // Jarvan IV
  62,   // Wukong
  64,   // Lee Sin
  75,   // Nasus
  77,   // Udyr
  80,   // Pantheon
  83,   // Yorick
  86,   // Garen
  92,   // Riven
  102,  // Shyvana
  106,  // Volibear
  114,  // Fiora
  117,  // Lulu
  120,  // Hecarim
  122,  // Darius
  126,  // Jayce
  142,  // Zoe
  147,  // Seraphine
  157,  // Yasuo
  164,  // Camille
  166,  // Akshan
  233,  // Briar
  234,  // Viego
  254,  // Vi
  267,  // Nami
  268,  // Azir
  350,  // Yuumi
  420,  // Illaoi
  421,  // Rek'Sai
  427,  // Ivern
  432,  // Bard
  711,  // Vex
  777,  // Yone
  799,  // Ambessa
  875,  // Sett
  887,  // Gwen
  888,  // Renata Glasc
  895,  // Nilah
  902,  // Milio
];

/**
 * Champions who build ENCHANTER items when they are in the support role, and
 * something else everywhere else.
 *
 * THREE ROWS, AND THE SHORTNESS IS THE POINT. A champion whose class is the
 * same in every role needs no entry here: Lux support is NOT an enchanter --
 * she buys mage items in the support role exactly as she does mid -- and the
 * absence of a Lux row is what says so. Only a champion whose ITEM class
 * genuinely moves with the role earns a row, and a test asserts every override
 * differs from that champion's base class, so a redundant one cannot hide here.
 */
const ROLE_OVERRIDES: Readonly<Record<number, Partial<Record<LaneId, ChampionItemClass>>>> = {
  147: { mid: "mage" },              // Seraphine -- base enchanter-support; mid Seraphine builds AP mage items
  43: { mid: "mage", top: "mage" },  // Karma -- base enchanter-support; solo-lane Karma builds mage items
  235: { support: "enchanter-support" }, // Senna -- base marksman; support Senna builds enchanter items
};

/** Exported for the CI test that asserts no override is redundant. */
export const ROLE_OVERRIDE_IDS: readonly number[] = Object.keys(ROLE_OVERRIDES).map(Number);

export function getRoleOverride(championId: number, lane: LaneId): ChampionItemClass | undefined {
  return ROLE_OVERRIDES[championId]?.[lane];
}

/**
 * The item class for one champion in one lane.
 *
 * FAIL-CLOSED on an unknown id: `null`, never a guess. Every consumer treats
 * null as "no scenario items for this champion", which degrades the "For this
 * game" block to nothing rather than recommending a marksman item to a
 * champion this table has never heard of. A brand-new champion is ONE hand-added
 * row and the roster-coverage test goes red until it exists.
 */
export function resolveChampionItemClass(championId: number, lane: LaneId): ChampionItemClass | null {
  const override = getRoleOverride(championId, lane);
  if (override) return override;
  return CHAMPION_CLASS[championId] ?? null;
}
