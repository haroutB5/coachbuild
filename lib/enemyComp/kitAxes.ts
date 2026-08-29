// ─────────────────────────────────────────────────────────────────────────────
// kitAxes.ts -- the three enemy-comp axes that lib/draft/compRatings.ts does
// NOT already carry: `assassin`, `heal`, `shield`.
//
// THREE AXES, NOT FIVE, AND THE OMISSIONS ARE THE DESIGN. The "For this game"
// block classifies an enemy comp on five things: heavy CC, 2+ tanks, 2+
// assassins, 2+ healers and 2+ shielders. Two of those five already exist as
// curated axes on this roster:
//
//   * CC        -> `compRatings.cc`, aggregated, cut at `CC_HEAVY_FLOOR` (2.2),
//                  which is `compTakeaways`' own exported constant. The draft
//                  page's "Heavy CC" chip and this block's Mercury's Treads
//                  therefore mean the same thing about the same comp.
//   * tankiness -> `compRatings.tankiness`, cut at 3, the top band of that
//                  file's own published 0-3 rubric ("defining"). Not a magic
//                  number: it is the rubric's own word for "this axis IS the
//                  champion", which is exactly the population that builds
//                  resistances and therefore the population penetration answers.
//
// Re-curating either here would create two numbers for one fact, which is the
// defect class this repo keeps paying for (see itemSetBody.ts's header, and
// CLAUDE.md gotcha (dd)). So this file adds only what is genuinely missing.
//
// WHY `assassin` CANNOT BE DERIVED FROM WHAT EXISTS. The obvious proxy is
// `mobility 3 && damage 3`, and it is wrong in both directions on the current
// table: it admits Zeri (mobility 3, damage 3) and Camille, neither of whom is
// the threat "2+ assassins" is about, and ddragon's own `Assassin` tag admits
// Tryndamere, Irelia, Fiora and Vi while missing nobody useful. Both readings
// need hand correction, so the hand correction is the table.
//
// EDITORIAL, AND IT MUST NEVER BE PRESENTED AS MEASURED. Same posture as
// compRatings.ts and damageType.ts: this is a classification of kit identity on
// a 0-3 rubric, not a statistic. Nothing in this app measures how much a
// champion heals. Every surface that acts on these values carries the JUDGMENT
// label (see components/hextech/ForThisGameCard.tsx).
//
//   0 = none       the kit has essentially nothing on this axis
//   1 = minor      present but situational / low-impact
//   2 = notable    a real, reliable contribution -- THE THRESHOLD every scenario
//                  in scenarios.ts counts at
//   3 = defining   this axis is core to the champion's identity
//
// UNLIKE damageType.ts THERE IS NO DERIVED BASELINE TO CORRECT AGAINST, and
// saying so is more honest than inventing one: ddragon carries no healing or
// shielding signal at all, so a "baseline" of all-zeros would make every
// non-zero row a trivially-passing "correction" and the CI test would assert
// nothing. What the tests assert instead is roster coverage, rubric range, and
// a set of DELIBERATE spot rows chosen because they are the ones a careless
// edit would break (see lib/__tests__/enemyComp-kitAxes.test.ts).
//
// MAINTENANCE: a new champion is ONE hand-added row. The coverage test fails
// until it is added, so the roster and this table cannot silently drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/** One champion's read on the three axes compRatings.ts does not carry. */
export interface KitAxes {
  /** Burst-and-delete threat to a squishy target. */
  assassin: number;
  /** Healing the kit itself provides, to self or allies. Excludes healing that
   *  comes from ITEMS (lifesteal, Bloodthirster) -- an item choice is not a
   *  comp fact and cannot be read off champ select. */
  heal: number;
  /** Shielding the kit itself provides, to self or allies. Same item exclusion.
   *  Kept separate from `heal` because the counter items are completely
   *  different (Morellonomicon vs Serpent's Fang) and a merged axis would have
   *  to pick one of them arbitrarily. */
  shield: number;
}

/** 173 rows, one per live champion, sorted by id. */
export const CHAMPION_KIT_AXES: Readonly<Record<number, KitAxes>> = {
  1: { assassin: 1, heal: 0, shield: 2 },        // Annie
  2: { assassin: 0, heal: 2, shield: 0 },        // Olaf
  3: { assassin: 0, heal: 1, shield: 2 },        // Galio
  4: { assassin: 1, heal: 0, shield: 0 },        // Twisted Fate
  5: { assassin: 1, heal: 1, shield: 0 },        // Xin Zhao
  6: { assassin: 0, heal: 0, shield: 0 },        // Urgot
  7: { assassin: 3, heal: 0, shield: 0 },        // LeBlanc
  8: { assassin: 0, heal: 3, shield: 0 },        // Vladimir
  9: { assassin: 1, heal: 0, shield: 0 },        // Fiddlesticks
  10: { assassin: 0, heal: 1, shield: 0 },       // Kayle
  11: { assassin: 3, heal: 2, shield: 0 },       // Master Yi
  12: { assassin: 0, heal: 2, shield: 0 },       // Alistar
  13: { assassin: 0, heal: 0, shield: 0 },       // Ryze
  14: { assassin: 0, heal: 1, shield: 2 },       // Sion
  15: { assassin: 0, heal: 0, shield: 2 },       // Sivir
  16: { assassin: 0, heal: 3, shield: 0 },       // Soraka
  17: { assassin: 0, heal: 0, shield: 0 },       // Teemo
  18: { assassin: 1, heal: 0, shield: 0 },       // Tristana
  19: { assassin: 1, heal: 3, shield: 0 },       // Warwick
  20: { assassin: 0, heal: 2, shield: 0 },       // Nunu & Willump
  21: { assassin: 0, heal: 0, shield: 0 },       // Miss Fortune
  22: { assassin: 0, heal: 0, shield: 0 },       // Ashe
  23: { assassin: 1, heal: 2, shield: 0 },       // Tryndamere
  24: { assassin: 1, heal: 1, shield: 0 },       // Jax
  25: { assassin: 0, heal: 0, shield: 3 },       // Morgana
  26: { assassin: 0, heal: 1, shield: 0 },       // Zilean
  27: { assassin: 0, heal: 0, shield: 0 },       // Singed
  28: { assassin: 3, heal: 0, shield: 0 },       // Evelynn
  29: { assassin: 1, heal: 0, shield: 0 },       // Twitch
  30: { assassin: 0, heal: 0, shield: 0 },       // Karthus
  31: { assassin: 0, heal: 1, shield: 0 },       // Cho'Gath
  32: { assassin: 0, heal: 0, shield: 0 },       // Amumu
  33: { assassin: 0, heal: 0, shield: 0 },       // Rammus
  34: { assassin: 0, heal: 0, shield: 0 },       // Anivia
  35: { assassin: 3, heal: 0, shield: 0 },       // Shaco
  36: { assassin: 0, heal: 3, shield: 0 },       // Dr. Mundo
  37: { assassin: 0, heal: 3, shield: 2 },       // Sona
  38: { assassin: 3, heal: 0, shield: 0 },       // Kassadin
  39: { assassin: 2, heal: 2, shield: 0 },       // Irelia
  40: { assassin: 0, heal: 2, shield: 3 },       // Janna
  41: { assassin: 0, heal: 0, shield: 0 },       // Gangplank
  42: { assassin: 0, heal: 0, shield: 0 },       // Corki
  43: { assassin: 0, heal: 1, shield: 3 },       // Karma
  44: { assassin: 0, heal: 3, shield: 1 },       // Taric
  45: { assassin: 1, heal: 0, shield: 0 },       // Veigar
  48: { assassin: 0, heal: 2, shield: 0 },       // Trundle
  50: { assassin: 0, heal: 3, shield: 0 },       // Swain
  51: { assassin: 0, heal: 0, shield: 0 },       // Caitlyn
  53: { assassin: 0, heal: 0, shield: 0 },       // Blitzcrank
  54: { assassin: 0, heal: 0, shield: 0 },       // Malphite
  55: { assassin: 3, heal: 0, shield: 0 },       // Katarina
  56: { assassin: 3, heal: 0, shield: 2 },       // Nocturne
  57: { assassin: 0, heal: 2, shield: 0 },       // Maokai
  58: { assassin: 0, heal: 1, shield: 0 },       // Renekton
  59: { assassin: 1, heal: 0, shield: 0 },       // Jarvan IV
  60: { assassin: 2, heal: 0, shield: 0 },       // Elise
  61: { assassin: 0, heal: 0, shield: 2 },       // Orianna
  62: { assassin: 1, heal: 0, shield: 0 },       // Wukong
  63: { assassin: 0, heal: 0, shield: 0 },       // Brand
  64: { assassin: 1, heal: 0, shield: 2 },       // Lee Sin
  67: { assassin: 1, heal: 0, shield: 0 },       // Vayne
  68: { assassin: 0, heal: 0, shield: 0 },       // Rumble
  69: { assassin: 0, heal: 0, shield: 0 },       // Cassiopeia
  72: { assassin: 0, heal: 1, shield: 0 },       // Skarner
  74: { assassin: 0, heal: 0, shield: 0 },       // Heimerdinger
  75: { assassin: 0, heal: 1, shield: 0 },       // Nasus
  76: { assassin: 3, heal: 2, shield: 0 },       // Nidalee
  77: { assassin: 0, heal: 2, shield: 2 },       // Udyr
  78: { assassin: 0, heal: 0, shield: 0 },       // Poppy
  79: { assassin: 0, heal: 1, shield: 0 },       // Gragas
  80: { assassin: 2, heal: 0, shield: 0 },       // Pantheon
  81: { assassin: 0, heal: 0, shield: 0 },       // Ezreal
  82: { assassin: 0, heal: 2, shield: 0 },       // Mordekaiser
  83: { assassin: 0, heal: 0, shield: 0 },       // Yorick
  84: { assassin: 3, heal: 0, shield: 0 },       // Akali
  85: { assassin: 0, heal: 0, shield: 0 },       // Kennen
  86: { assassin: 0, heal: 2, shield: 0 },       // Garen
  89: { assassin: 0, heal: 0, shield: 0 },       // Leona
  90: { assassin: 0, heal: 0, shield: 2 },       // Malzahar
  91: { assassin: 3, heal: 0, shield: 0 },       // Talon
  92: { assassin: 2, heal: 0, shield: 2 },       // Riven
  96: { assassin: 0, heal: 0, shield: 0 },       // Kog'Maw
  98: { assassin: 0, heal: 0, shield: 2 },       // Shen
  99: { assassin: 0, heal: 0, shield: 2 },       // Lux
  101: { assassin: 0, heal: 0, shield: 0 },      // Xerath
  102: { assassin: 0, heal: 0, shield: 0 },      // Shyvana
  103: { assassin: 2, heal: 0, shield: 0 },      // Ahri
  104: { assassin: 1, heal: 0, shield: 0 },      // Graves
  105: { assassin: 3, heal: 0, shield: 0 },      // Fizz
  106: { assassin: 1, heal: 2, shield: 0 },      // Volibear
  107: { assassin: 3, heal: 0, shield: 0 },      // Rengar
  110: { assassin: 0, heal: 0, shield: 0 },      // Varus
  111: { assassin: 0, heal: 0, shield: 0 },      // Nautilus
  112: { assassin: 0, heal: 0, shield: 0 },      // Viktor
  113: { assassin: 0, heal: 0, shield: 0 },      // Sejuani
  114: { assassin: 2, heal: 2, shield: 0 },      // Fiora
  115: { assassin: 0, heal: 0, shield: 0 },      // Ziggs
  117: { assassin: 0, heal: 1, shield: 3 },      // Lulu
  119: { assassin: 0, heal: 0, shield: 0 },      // Draven
  120: { assassin: 1, heal: 2, shield: 0 },      // Hecarim
  121: { assassin: 3, heal: 0, shield: 0 },      // Kha'Zix
  122: { assassin: 0, heal: 0, shield: 0 },      // Darius
  126: { assassin: 0, heal: 0, shield: 0 },      // Jayce
  127: { assassin: 0, heal: 0, shield: 0 },      // Lissandra
  131: { assassin: 3, heal: 0, shield: 0 },      // Diana
  133: { assassin: 1, heal: 0, shield: 0 },      // Quinn
  134: { assassin: 1, heal: 0, shield: 0 },      // Syndra
  136: { assassin: 0, heal: 0, shield: 0 },      // Aurelion Sol
  141: { assassin: 3, heal: 2, shield: 0 },      // Kayn
  142: { assassin: 2, heal: 0, shield: 0 },      // Zoe
  143: { assassin: 0, heal: 0, shield: 0 },      // Zyra
  145: { assassin: 1, heal: 0, shield: 0 },      // Kai'Sa
  147: { assassin: 0, heal: 2, shield: 2 },      // Seraphine
  150: { assassin: 0, heal: 0, shield: 0 },      // Gnar
  154: { assassin: 0, heal: 2, shield: 0 },      // Zac
  157: { assassin: 1, heal: 0, shield: 0 },      // Yasuo
  161: { assassin: 0, heal: 0, shield: 0 },      // Vel'Koz
  163: { assassin: 0, heal: 0, shield: 0 },      // Taliyah
  164: { assassin: 2, heal: 0, shield: 0 },      // Camille
  166: { assassin: 2, heal: 0, shield: 0 },      // Akshan
  200: { assassin: 1, heal: 2, shield: 0 },      // Bel'Veth
  201: { assassin: 0, heal: 0, shield: 2 },      // Braum
  202: { assassin: 0, heal: 0, shield: 0 },      // Jhin
  203: { assassin: 0, heal: 0, shield: 0 },      // Kindred
  221: { assassin: 0, heal: 0, shield: 0 },      // Zeri
  222: { assassin: 0, heal: 0, shield: 0 },      // Jinx
  223: { assassin: 0, heal: 2, shield: 2 },      // Tahm Kench
  233: { assassin: 2, heal: 2, shield: 0 },      // Briar
  234: { assassin: 2, heal: 2, shield: 0 },      // Viego
  235: { assassin: 0, heal: 2, shield: 0 },      // Senna
  236: { assassin: 1, heal: 0, shield: 0 },      // Lucian
  238: { assassin: 3, heal: 0, shield: 0 },      // Zed
  240: { assassin: 0, heal: 1, shield: 0 },      // Kled
  245: { assassin: 3, heal: 0, shield: 2 },      // Ekko
  246: { assassin: 3, heal: 0, shield: 0 },      // Qiyana
  254: { assassin: 2, heal: 0, shield: 0 },      // Vi
  266: { assassin: 0, heal: 3, shield: 0 },      // Aatrox
  267: { assassin: 0, heal: 2, shield: 0 },      // Nami
  268: { assassin: 0, heal: 0, shield: 0 },      // Azir
  350: { assassin: 0, heal: 3, shield: 0 },      // Yuumi
  360: { assassin: 2, heal: 0, shield: 0 },      // Samira
  412: { assassin: 0, heal: 0, shield: 0 },      // Thresh
  420: { assassin: 0, heal: 2, shield: 0 },      // Illaoi
  421: { assassin: 2, heal: 1, shield: 0 },      // Rek'Sai
  427: { assassin: 0, heal: 2, shield: 2 },      // Ivern
  429: { assassin: 0, heal: 0, shield: 0 },      // Kalista
  432: { assassin: 0, heal: 0, shield: 0 },      // Bard
  497: { assassin: 0, heal: 0, shield: 2 },      // Rakan
  498: { assassin: 0, heal: 0, shield: 0 },      // Xayah
  516: { assassin: 0, heal: 0, shield: 0 },      // Ornn
  517: { assassin: 2, heal: 3, shield: 0 },      // Sylas
  518: { assassin: 0, heal: 0, shield: 0 },      // Neeko
  523: { assassin: 0, heal: 0, shield: 0 },      // Aphelios
  526: { assassin: 0, heal: 0, shield: 2 },      // Rell
  555: { assassin: 3, heal: 1, shield: 0 },      // Pyke
  711: { assassin: 1, heal: 0, shield: 0 },      // Vex
  777: { assassin: 2, heal: 1, shield: 0 },      // Yone
  799: { assassin: 2, heal: 0, shield: 0 },      // Ambessa
  800: { assassin: 0, heal: 0, shield: 2 },      // Mel
  804: { assassin: 0, heal: 0, shield: 0 },      // Yunara
  805: { assassin: 2, heal: 0, shield: 0 },      // Locke
  875: { assassin: 0, heal: 2, shield: 2 },      // Sett
  876: { assassin: 2, heal: 0, shield: 0 },      // Lillia
  887: { assassin: 1, heal: 2, shield: 0 },      // Gwen
  888: { assassin: 0, heal: 1, shield: 3 },      // Renata Glasc
  893: { assassin: 2, heal: 0, shield: 0 },      // Aurora
  895: { assassin: 2, heal: 0, shield: 1 },      // Nilah
  897: { assassin: 0, heal: 1, shield: 0 },      // K'Sante
  901: { assassin: 0, heal: 0, shield: 0 },      // Smolder
  902: { assassin: 0, heal: 3, shield: 0 },      // Milio
  904: { assassin: 1, heal: 1, shield: 0 },      // Zaahen
  910: { assassin: 0, heal: 0, shield: 2 },      // Hwei
  950: { assassin: 3, heal: 1, shield: 0 },      // Naafiri
};

/** The rubric level at which an axis COUNTS toward a scenario. 2, "notable",
 *  and it is the same cut on all three axes on purpose: a comp rule that fired
 *  on `heal >= 2` and `shield >= 3` would be two rules wearing one name, and
 *  the reason string ("2 healers") would mean something different depending on
 *  which half of it you read. */
export const AXIS_COUNT_FLOOR = 2;

/** All-zero. Returned for an id with no row, which is the conservative
 *  direction: an unrecognised enemy counts toward NO scenario and therefore can
 *  never make a rule fire. Never throws -- an enemy this table has not heard of
 *  must degrade the block, never the export.
 *
 *  This is deliberately NOT compRatings' `deriveFallbackRating` shape. That
 *  function guesses from tags so a RADAR never renders blank; here a guess would
 *  put a curated item in a real player's shop on the strength of a tag, which is
 *  the fabrication HARD RULE 4 exists to stop. */
const ZERO_AXES: KitAxes = Object.freeze({ assassin: 0, heal: 0, shield: 0 });

export function getKitAxes(championId: number): KitAxes {
  return CHAMPION_KIT_AXES[championId] ?? ZERO_AXES;
}

/** How many of `enemyIds` reach `AXIS_COUNT_FLOOR` on `axis`. The one counting
 *  helper every scenario rule uses, so "2 healers" and "2 assassins" are
 *  literally the same arithmetic and cannot drift into meaning different
 *  things. */
export function countAtOrAbove(enemyIds: readonly number[], axis: keyof KitAxes): number {
  let n = 0;
  for (const id of enemyIds) if (getKitAxes(id)[axis] >= AXIS_COUNT_FLOOR) n++;
  return n;
}
