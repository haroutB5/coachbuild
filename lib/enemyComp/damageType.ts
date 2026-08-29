// ─────────────────────────────────────────────────────────────────────────────
// damageType.ts -- per-champion physical/magic damage lean, for the enemy-comp
// signal's "vs AD" / "vs AP" rule.
//
// CURATED, and it has to be said plainly: this is an EDITORIAL classification
// of kit identity, exactly like lib/draft/compRatings.ts's six axes, and it
// must never be presented as a measured damage split. No such measurement
// exists in this app today. What exists is ddragon's `info.attack` /
// `info.magic`, and that is a 1-10 EDITORIAL rating from Riot, not a split.
//
// HOW THIS TABLE WAS BUILT, and why the derived half alone was not enough.
// The baseline is ddragon's own read at a margin of 3 (see
// scripts/derive-enemycomp-tables.mjs, DAMAGE_MARGIN): 70 ad, 60 ap, 39
// mixed, and **4 champions with an info block of 0/0 and therefore no read at
// all** (Seraphine, Akshan, Rell, Vex). A 0/0 is UNKNOWN, which is a different
// fact from "genuinely balanced", and collapsing the two would have quietly
// filed four champions as mixed on the strength of missing data.
//
// 40 of the 173 rows are then CORRECTED by hand, each marked below with what
// ddragon said and why it is wrong. That correction rate is itself the
// finding: ddragon's info block is not a damage-type source. Gwen reads 7
// attack / 5 magic and is an AP champion; Jax ties at 7/7 and is AD; Thresh
// reads 5/6; Leona reads 4/3 and deals magic. A test asserts every correction
// genuinely DISAGREES with the derived baseline, so a correction that upstream
// later agrees with is flagged as redundant rather than silently kept.
//
// `mixed` is an HONEST ANSWER, not a failure. It means two different things to
// two different callers, and both are the conservative one:
//   * as an ENEMY, the champion counts toward neither damage lean, so
//     `classifyEnemyComp`'s heavy-ad/heavy-ap rules do not fire on them;
//   * as OUR OWN champion, it reaches only a scenario cell's `any` list, so a
//     cell whose answer depends on which kind of damage we deal (Serylda's
//     Grudge vs Void Staff) names nothing rather than guessing.
// Three champions end up there (Corki, Skarner, Ornn) and they belong there. An
// unknown id also resolves to `mixed`: fail closed, never guess a lean.
//
// MAINTENANCE: a new champion is ONE hand-added row, same convention
// lib/draft/compRatings.ts documents for itself. The CI test below fails until
// it is added, so the roster and this table cannot silently drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/** Which damage type a champion's KIT leans on. `mixed` means genuinely both,
 *  or not confidently either -- never "no data", which cannot happen here
 *  because every live id must have a row. */
export type DamageType = "ad" | "ap" | "mixed";

/** 173 rows, one per live champion, sorted by id. Values are FINAL (derived
 *  baseline with the corrections already applied); the comment on a corrected
 *  row records what the derivation said. */
export const CHAMPION_DAMAGE_TYPE: Readonly<Record<number, DamageType>> = {
  1: "ap",        // Annie
  2: "ad",        // Olaf
  3: "ap",        // Galio
  4: "ap",        // Twisted Fate  CORRECTED from mixed (6/6): damage is magic
  5: "ad",        // Xin Zhao
  6: "ad",        // Urgot
  7: "ap",        // LeBlanc
  8: "ap",        // Vladimir
  9: "ap",        // Fiddlesticks
  10: "ap",       // Kayle  CORRECTED from mixed (6/7): damage is magic
  11: "ad",       // Master Yi
  12: "ap",       // Alistar  CORRECTED from mixed (6/5): damage is magic
  13: "ap",       // Ryze
  14: "ad",       // Sion  CORRECTED from mixed (5/3): damage is physical
  15: "ad",       // Sivir
  16: "ap",       // Soraka
  17: "ap",       // Teemo  CORRECTED from mixed (5/7): damage is magic
  18: "ad",       // Tristana
  19: "ad",       // Warwick
  20: "ap",       // Nunu & Willump
  21: "ad",       // Miss Fortune
  22: "ad",       // Ashe
  23: "ad",       // Tryndamere
  24: "ad",       // Jax  CORRECTED from mixed (7/7): damage is physical
  25: "ap",       // Morgana
  26: "ap",       // Zilean
  27: "ap",       // Singed
  28: "ap",       // Evelynn
  29: "ad",       // Twitch
  30: "ap",       // Karthus
  31: "ap",       // Cho'Gath
  32: "ap",       // Amumu
  33: "ap",       // Rammus  CORRECTED from mixed (4/5): damage is magic
  34: "ap",       // Anivia
  35: "ad",       // Shaco  CORRECTED from mixed (8/6): damage is physical
  36: "ap",       // Dr. Mundo  CORRECTED from mixed (5/6): damage is magic
  37: "ap",       // Sona
  38: "ap",       // Kassadin
  39: "ad",       // Irelia  CORRECTED from mixed (7/5): damage is physical
  40: "ap",       // Janna
  41: "ad",       // Gangplank
  42: "mixed",    // Corki
  43: "ap",       // Karma
  44: "ap",       // Taric  CORRECTED from mixed (4/5): damage is magic
  45: "ap",       // Veigar
  48: "ad",       // Trundle
  50: "ap",       // Swain
  51: "ad",       // Caitlyn
  53: "ap",       // Blitzcrank  CORRECTED from mixed (4/5): damage is magic
  54: "ap",       // Malphite  CORRECTED from mixed (5/7): damage is magic
  55: "ap",       // Katarina
  56: "ad",       // Nocturne
  57: "ap",       // Maokai
  58: "ad",       // Renekton
  59: "ad",       // Jarvan IV
  60: "ap",       // Elise  CORRECTED from mixed (6/7): damage is magic
  61: "ap",       // Orianna
  62: "ad",       // Wukong
  63: "ap",       // Brand
  64: "ad",       // Lee Sin
  67: "ad",       // Vayne
  68: "ap",       // Rumble
  69: "ap",       // Cassiopeia
  72: "mixed",    // Skarner
  74: "ap",       // Heimerdinger
  75: "ad",       // Nasus  CORRECTED from mixed (7/6): damage is physical
  76: "ap",       // Nidalee  CORRECTED from mixed (5/7): damage is magic
  77: "ad",       // Udyr
  78: "ad",       // Poppy
  79: "ap",       // Gragas  CORRECTED from mixed (4/6): damage is magic
  80: "ad",       // Pantheon
  81: "ad",       // Ezreal  CORRECTED from mixed (7/6): damage is physical
  82: "ap",       // Mordekaiser
  83: "ad",       // Yorick  CORRECTED from mixed (6/4): damage is physical
  84: "ap",       // Akali
  85: "ap",       // Kennen  CORRECTED from mixed (6/7): damage is magic
  86: "ad",       // Garen
  89: "ap",       // Leona  CORRECTED from mixed (4/3): damage is magic
  90: "ap",       // Malzahar
  91: "ad",       // Talon
  92: "ad",       // Riven
  96: "ad",       // Kog'Maw
  98: "ap",       // Shen  CORRECTED from mixed (3/3): damage is magic
  99: "ap",       // Lux
  101: "ap",      // Xerath
  102: "ad",      // Shyvana
  103: "ap",      // Ahri
  104: "ad",      // Graves
  105: "ap",      // Fizz  CORRECTED from mixed (6/7): damage is magic
  106: "ad",      // Volibear
  107: "ad",      // Rengar
  110: "ad",      // Varus
  111: "ap",      // Nautilus  CORRECTED from mixed (4/6): damage is magic
  112: "ap",      // Viktor
  113: "ap",      // Sejuani  CORRECTED from mixed (5/6): damage is magic
  114: "ad",      // Fiora
  115: "ap",      // Ziggs
  117: "ap",      // Lulu
  119: "ad",      // Draven
  120: "ad",      // Hecarim
  121: "ad",      // Kha'Zix
  122: "ad",      // Darius
  126: "ad",      // Jayce
  127: "ap",      // Lissandra
  131: "ap",      // Diana  CORRECTED from mixed (7/8): damage is magic
  133: "ad",      // Quinn
  134: "ap",      // Syndra
  136: "ap",      // Aurelion Sol
  141: "ad",      // Kayn
  142: "ap",      // Zoe
  143: "ap",      // Zyra
  145: "ad",      // Kai'Sa
  147: "ap",      // Seraphine  CORRECTED from unknown (0/0): ddragon info is 0/0 - no derived read at all
  150: "ad",      // Gnar  CORRECTED from mixed (6/5): damage is physical
  154: "ap",      // Zac
  157: "ad",      // Yasuo
  161: "ap",      // Vel'Koz
  163: "ap",      // Taliyah
  164: "ad",      // Camille
  166: "ad",      // Akshan  CORRECTED from unknown (0/0): ddragon info is 0/0 - no derived read at all
  200: "ap",      // Bel'Veth
  201: "ap",      // Braum  CORRECTED from mixed (3/4): damage is magic
  202: "ad",      // Jhin
  203: "ad",      // Kindred
  221: "ad",      // Zeri
  222: "ad",      // Jinx
  223: "ap",      // Tahm Kench
  233: "ad",      // Briar
  234: "ad",      // Viego
  235: "ad",      // Senna  CORRECTED from mixed (7/6): damage is physical
  236: "ad",      // Lucian
  238: "ad",      // Zed
  240: "ad",      // Kled
  245: "ap",      // Ekko  CORRECTED from mixed (5/7): damage is magic
  246: "ap",      // Qiyana
  254: "ad",      // Vi
  266: "ad",      // Aatrox
  267: "ap",      // Nami
  268: "ap",      // Azir  CORRECTED from mixed (6/8): damage is magic
  350: "ap",      // Yuumi
  360: "ad",      // Samira
  412: "ap",      // Thresh  CORRECTED from mixed (5/6): damage is magic
  420: "ad",      // Illaoi
  421: "ad",      // Rek'Sai
  427: "ap",      // Ivern
  429: "ad",      // Kalista
  432: "ap",      // Bard  CORRECTED from mixed (4/5): damage is magic
  497: "ap",      // Rakan
  498: "ad",      // Xayah
  516: "mixed",   // Ornn
  517: "ap",      // Sylas
  518: "ap",      // Neeko
  523: "ad",      // Aphelios
  526: "ap",      // Rell  CORRECTED from unknown (0/0): ddragon info is 0/0 - no derived read at all
  555: "ad",      // Pyke
  711: "ap",      // Vex  CORRECTED from unknown (0/0): ddragon info is 0/0 - no derived read at all
  777: "ad",      // Yone
  799: "ad",      // Ambessa
  800: "ap",      // Mel
  804: "ad",      // Yunara
  805: "ad",      // Locke
  875: "ad",      // Sett
  876: "ap",      // Lillia
  887: "ap",      // Gwen  CORRECTED from mixed (7/5): damage is magic
  888: "ap",      // Renata Glasc
  893: "ap",      // Aurora
  895: "ad",      // Nilah
  897: "ad",      // K'Sante  CORRECTED from mixed (8/7): damage is physical
  901: "ad",      // Smolder
  902: "ap",      // Milio
  904: "ad",      // Zaahen
  910: "ap",      // Hwei  CORRECTED from mixed (7/8): damage is magic
  950: "ad",      // Naafiri
};

/** The ids whose value was overridden by hand. Exported so the CI test can
 *  assert each one genuinely disagrees with the derived baseline -- a
 *  correction that upstream has since caught up with is dead weight carrying
 *  an authority it no longer has. */
export const DAMAGE_TYPE_CORRECTIONS: readonly number[] = [
  4,    // Twisted Fate
  10,   // Kayle
  12,   // Alistar
  14,   // Sion
  17,   // Teemo
  24,   // Jax
  33,   // Rammus
  35,   // Shaco
  36,   // Dr. Mundo
  39,   // Irelia
  44,   // Taric
  53,   // Blitzcrank
  54,   // Malphite
  60,   // Elise
  75,   // Nasus
  76,   // Nidalee
  79,   // Gragas
  81,   // Ezreal
  83,   // Yorick
  85,   // Kennen
  89,   // Leona
  98,   // Shen
  105,  // Fizz
  111,  // Nautilus
  113,  // Sejuani
  131,  // Diana
  147,  // Seraphine
  150,  // Gnar
  166,  // Akshan
  201,  // Braum
  235,  // Senna
  245,  // Ekko
  268,  // Azir
  412,  // Thresh
  432,  // Bard
  526,  // Rell
  711,  // Vex
  887,  // Gwen
  897,  // K'Sante
  910,  // Hwei
];

/** Fail-closed lookup. An id with no row resolves to `mixed`, which counts
 *  toward neither side and therefore cannot make a rule fire. Never throws:
 *  an unrecognised enemy must degrade the signal, never the export. */
export function getDamageType(championId: number): DamageType {
  return CHAMPION_DAMAGE_TYPE[championId] ?? "mixed";
}
