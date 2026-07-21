// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/compRatings.ts — curated team-comp radar ratings (draft redesign
// plan §2.2). PURE, static, no network/DB — deliberately decoupled from
// lib/staticData.ts (same "derive locally" posture proAssets.ts already
// documents for this codebase) so it stays trivially unit-testable and never
// pulls the recommend.ts pipeline into a ddragon dependency.
//
// Each axis is an EDITORIAL classification of kit identity, NOT a stat pulled
// from any game data — the UI must label the radar "Team profile (curated kit
// ratings)", never imply these are measured. Rubric (0-3 per axis):
//   0 = none      — the kit has essentially nothing on this axis
//   1 = minor      — present but situational / low-impact
//   2 = notable     — a real, reliable contribution
//   3 = defining     — this axis is core to the champion's identity
// Axes: cc, damage, tankiness, mobility, utility, engage.
//
// Worked examples (also pinned as spot-check tests):
//   Leona  (enchanter-adjacent engage tank): cc 3, engage 3, tankiness 3,
//           damage 0, mobility 1, utility 2 — no real damage, but everything
//           else about her kit says "I start (and win) the fight."
//   Malphite (juggernaut-style engage tank): cc 3, tankiness 3, engage 3,
//           damage 1, mobility 1, utility 0 — Unstoppable Force is a signature
//           teamfight-deciding engage; tank-build Malphite deals little.
//   Yuumi  (pure enchanter): utility 3, damage 0, cc 1 (You and Me! is real
//           CC), tankiness 0, mobility 0 (she rides an ally, not herself),
//           engage 0.
//   Zed    (pure assassin): mobility 3, damage 3, cc 1 (Shuriken slow only),
//           tankiness 0, utility 0, engage 3 (Shadow flank is a premier pick
//           tool even without hard CC).
//   Ashe   (CC-marksman hybrid): cc 3 (permaslow passive + a global-stun
//           ultimate — unusual for the ADC class), damage 2, mobility 0,
//           utility 1, engage 2.
//   Ornn   (tank enabler): cc 3, tankiness 3, engage 3, damage 1, mobility 1,
//           utility 2 (his passive item-upgrade mechanic is real team
//           utility, not just personal power).
//
// MAINTENANCE: a new champion added to the live roster is ONE hand-added row
// below (sorted by champion id, name in a trailing comment for reviewability
// — see the file's own CI test asserting every live id resolves). Until a row
// is added, `deriveFallbackRating` (below) supplies a coarse, tag-derived
// vector flagged `estimated: true` so the radar never renders blank for a
// brand-new champion — the UI footnotes "some ratings estimated" whenever any
// resolved entry carries that flag.
// ─────────────────────────────────────────────────────────────────────────────

export interface CompRatingVector {
  cc: number;
  damage: number;
  tankiness: number;
  mobility: number;
  utility: number;
  engage: number;
}

/** A resolved rating plus provenance — `estimated: true` means it came from
 *  `deriveFallbackRating` (no curated row yet), never from hand curation. */
export interface RatedComp extends CompRatingVector {
  estimated: boolean;
}

export interface AggregatedComp extends CompRatingVector {
  /** How many of the aggregated enemies resolved via the fallback path
   *  (estimated, not curated) — the radar's "some ratings estimated"
   *  footnote fires whenever this is > 0. */
  estimatedCount: number;
}

/** ddragon's `info` block (1-10 scale per axis) — same shape
 *  lib/staticData.ts's ChampDataEntry carries, but this file deliberately
 *  does NOT import that module (see header) — callers pass it in directly if
 *  they have it. Optional; `deriveFallbackRating` degrades gracefully to a
 *  tag-only vector when omitted. */
export interface ChampInfo {
  attack: number;
  defense: number;
  magic: number;
}

const AXES: (keyof CompRatingVector)[] = ["cc", "damage", "tankiness", "mobility", "utility", "engage"];

function zeroVector(): CompRatingVector {
  return { cc: 0, damage: 0, tankiness: 0, mobility: 0, utility: 0, engage: 0 };
}

// ── Curated ratings — ~173 live champions (2026-07-21 roster snapshot) ──────
// Sorted by champion id ascending, one line per champion, live champion NAME
// in a trailing comment (reviewability — matches this file's own CI test
// asserting every id in lib/staticData's live roster resolves here).
export const COMP_RATINGS: Record<number, CompRatingVector> = {
  1: { cc: 3, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 2 }, // Annie
  2: { cc: 1, damage: 3, tankiness: 2, mobility: 1, utility: 0, engage: 2 }, // Olaf
  3: { cc: 3, damage: 2, tankiness: 3, mobility: 2, utility: 1, engage: 3 }, // Galio
  4: { cc: 2, damage: 2, tankiness: 0, mobility: 0, utility: 2, engage: 1 }, // Twisted Fate
  5: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Xin Zhao
  6: { cc: 2, damage: 3, tankiness: 2, mobility: 1, utility: 0, engage: 1 }, // Urgot
  7: { cc: 2, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 1 }, // LeBlanc
  8: { cc: 0, damage: 3, tankiness: 2, mobility: 1, utility: 0, engage: 0 }, // Vladimir
  9: { cc: 3, damage: 3, tankiness: 0, mobility: 1, utility: 1, engage: 3 }, // Fiddlesticks
  10: { cc: 1, damage: 3, tankiness: 1, mobility: 1, utility: 2, engage: 0 }, // Kayle
  11: { cc: 0, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 2 }, // Master Yi
  12: { cc: 3, damage: 1, tankiness: 3, mobility: 0, utility: 2, engage: 3 }, // Alistar
  13: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 1, engage: 1 }, // Ryze
  14: { cc: 3, damage: 2, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // Sion
  15: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 2, engage: 0 }, // Sivir
  16: { cc: 1, damage: 1, tankiness: 0, mobility: 0, utility: 3, engage: 0 }, // Soraka
  17: { cc: 2, damage: 2, tankiness: 0, mobility: 1, utility: 1, engage: 0 }, // Teemo
  18: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Tristana
  19: { cc: 2, damage: 2, tankiness: 2, mobility: 2, utility: 1, engage: 3 }, // Warwick
  20: { cc: 2, damage: 1, tankiness: 2, mobility: 1, utility: 1, engage: 3 }, // Nunu & Willump
  21: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Miss Fortune
  22: { cc: 3, damage: 2, tankiness: 0, mobility: 0, utility: 1, engage: 2 }, // Ashe
  23: { cc: 1, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Tryndamere
  24: { cc: 1, damage: 3, tankiness: 2, mobility: 2, utility: 1, engage: 2 }, // Jax
  25: { cc: 3, damage: 2, tankiness: 0, mobility: 0, utility: 2, engage: 2 }, // Morgana
  26: { cc: 2, damage: 1, tankiness: 0, mobility: 1, utility: 3, engage: 0 }, // Zilean
  27: { cc: 1, damage: 1, tankiness: 3, mobility: 2, utility: 1, engage: 1 }, // Singed
  28: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 2 }, // Evelynn
  29: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Twitch
  30: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 0 }, // Karthus
  31: { cc: 3, damage: 2, tankiness: 3, mobility: 0, utility: 0, engage: 2 }, // Cho'Gath
  32: { cc: 3, damage: 1, tankiness: 3, mobility: 0, utility: 0, engage: 3 }, // Amumu
  33: { cc: 2, damage: 1, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // Rammus
  34: { cc: 3, damage: 3, tankiness: 1, mobility: 0, utility: 1, engage: 1 }, // Anivia
  35: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Shaco
  36: { cc: 0, damage: 2, tankiness: 3, mobility: 0, utility: 0, engage: 1 }, // Dr. Mundo
  37: { cc: 2, damage: 2, tankiness: 0, mobility: 0, utility: 3, engage: 1 }, // Sona
  38: { cc: 1, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 2 }, // Kassadin
  39: { cc: 2, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 2 }, // Irelia
  40: { cc: 2, damage: 1, tankiness: 0, mobility: 0, utility: 3, engage: 1 }, // Janna
  41: { cc: 1, damage: 3, tankiness: 1, mobility: 1, utility: 1, engage: 1 }, // Gangplank
  42: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 0 }, // Corki
  43: { cc: 1, damage: 2, tankiness: 0, mobility: 0, utility: 3, engage: 1 }, // Karma
  44: { cc: 2, damage: 1, tankiness: 3, mobility: 0, utility: 3, engage: 2 }, // Taric
  45: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Veigar
  48: { cc: 1, damage: 2, tankiness: 3, mobility: 1, utility: 0, engage: 1 }, // Trundle
  50: { cc: 2, damage: 3, tankiness: 2, mobility: 0, utility: 0, engage: 3 }, // Swain
  51: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 0 }, // Caitlyn
  53: { cc: 3, damage: 1, tankiness: 3, mobility: 0, utility: 1, engage: 3 }, // Blitzcrank
  54: { cc: 3, damage: 1, tankiness: 3, mobility: 1, utility: 0, engage: 3 }, // Malphite
  55: { cc: 0, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 2 }, // Katarina
  56: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 3 }, // Nocturne
  57: { cc: 3, damage: 1, tankiness: 3, mobility: 1, utility: 1, engage: 3 }, // Maokai
  58: { cc: 2, damage: 3, tankiness: 2, mobility: 1, utility: 0, engage: 2 }, // Renekton
  59: { cc: 3, damage: 2, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Jarvan IV
  60: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Elise
  61: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 2, engage: 3 }, // Orianna
  62: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 1, engage: 2 }, // Wukong
  63: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Brand
  64: { cc: 2, damage: 3, tankiness: 1, mobility: 3, utility: 1, engage: 3 }, // Lee Sin
  67: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 0 }, // Vayne
  68: { cc: 1, damage: 3, tankiness: 1, mobility: 1, utility: 0, engage: 1 }, // Rumble
  69: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Cassiopeia
  72: { cc: 3, damage: 2, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // Skarner
  74: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 0 }, // Heimerdinger
  75: { cc: 2, damage: 3, tankiness: 2, mobility: 0, utility: 0, engage: 1 }, // Nasus
  76: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 1, engage: 2 }, // Nidalee
  77: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 2 }, // Udyr
  78: { cc: 3, damage: 1, tankiness: 3, mobility: 1, utility: 0, engage: 2 }, // Poppy
  79: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Gragas
  80: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 3 }, // Pantheon
  81: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 0 }, // Ezreal
  82: { cc: 1, damage: 3, tankiness: 2, mobility: 0, utility: 0, engage: 2 }, // Mordekaiser
  83: { cc: 1, damage: 2, tankiness: 2, mobility: 0, utility: 1, engage: 1 }, // Yorick
  84: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 2 }, // Akali
  85: { cc: 3, damage: 2, tankiness: 0, mobility: 1, utility: 0, engage: 3 }, // Kennen
  86: { cc: 1, damage: 3, tankiness: 3, mobility: 1, utility: 0, engage: 1 }, // Garen
  89: { cc: 3, damage: 0, tankiness: 3, mobility: 1, utility: 2, engage: 3 }, // Leona
  90: { cc: 3, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 2 }, // Malzahar
  91: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 3 }, // Talon
  92: { cc: 2, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 2 }, // Riven
  96: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 0 }, // Kog'Maw
  98: { cc: 1, damage: 1, tankiness: 3, mobility: 1, utility: 2, engage: 1 }, // Shen
  99: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 2, engage: 1 }, // Lux
  101: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Xerath
  102: { cc: 1, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 2 }, // Shyvana
  103: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 2 }, // Ahri
  104: { cc: 1, damage: 3, tankiness: 1, mobility: 1, utility: 0, engage: 1 }, // Graves
  105: { cc: 2, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 2 }, // Fizz
  106: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Volibear
  107: { cc: 2, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 3 }, // Rengar
  110: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 2 }, // Varus
  111: { cc: 3, damage: 1, tankiness: 3, mobility: 1, utility: 0, engage: 3 }, // Nautilus
  112: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Viktor
  113: { cc: 3, damage: 1, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // Sejuani
  114: { cc: 1, damage: 3, tankiness: 1, mobility: 2, utility: 1, engage: 1 }, // Fiora
  115: { cc: 1, damage: 3, tankiness: 0, mobility: 1, utility: 0, engage: 0 }, // Ziggs
  117: { cc: 2, damage: 1, tankiness: 0, mobility: 0, utility: 3, engage: 1 }, // Lulu
  119: { cc: 0, damage: 3, tankiness: 0, mobility: 1, utility: 0, engage: 0 }, // Draven
  120: { cc: 2, damage: 3, tankiness: 2, mobility: 3, utility: 0, engage: 3 }, // Hecarim
  121: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 3 }, // Kha'Zix
  122: { cc: 2, damage: 3, tankiness: 3, mobility: 0, utility: 0, engage: 2 }, // Darius
  126: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Jayce
  127: { cc: 3, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 3 }, // Lissandra
  131: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 3 }, // Diana
  133: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Quinn
  134: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 2 }, // Syndra
  136: { cc: 2, damage: 3, tankiness: 0, mobility: 1, utility: 0, engage: 1 }, // Aurelion Sol
  141: { cc: 1, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 3 }, // Kayn
  142: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Zoe
  143: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 2 }, // Zyra
  145: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Kai'Sa
  147: { cc: 2, damage: 2, tankiness: 0, mobility: 0, utility: 3, engage: 1 }, // Seraphine
  150: { cc: 3, damage: 2, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Gnar
  154: { cc: 3, damage: 1, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // Zac
  157: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Yasuo
  161: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Vel'Koz
  163: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Taliyah
  164: { cc: 2, damage: 3, tankiness: 2, mobility: 3, utility: 0, engage: 3 }, // Camille
  166: { cc: 0, damage: 3, tankiness: 0, mobility: 3, utility: 1, engage: 1 }, // Akshan
  200: { cc: 0, damage: 3, tankiness: 1, mobility: 3, utility: 0, engage: 2 }, // Bel'Veth
  201: { cc: 3, damage: 0, tankiness: 3, mobility: 0, utility: 2, engage: 3 }, // Braum
  202: { cc: 2, damage: 3, tankiness: 0, mobility: 1, utility: 0, engage: 1 }, // Jhin
  203: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 0 }, // Kindred
  221: { cc: 0, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 1 }, // Zeri
  222: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 0 }, // Jinx
  223: { cc: 2, damage: 1, tankiness: 3, mobility: 1, utility: 3, engage: 3 }, // Tahm Kench
  233: { cc: 2, damage: 3, tankiness: 2, mobility: 3, utility: 0, engage: 3 }, // Briar
  234: { cc: 1, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Viego
  235: { cc: 2, damage: 2, tankiness: 0, mobility: 0, utility: 2, engage: 1 }, // Senna
  236: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Lucian
  238: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 3 }, // Zed
  240: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Kled
  245: { cc: 2, damage: 3, tankiness: 1, mobility: 3, utility: 1, engage: 2 }, // Ekko
  246: { cc: 2, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 3 }, // Qiyana
  254: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 3 }, // Vi
  266: { cc: 2, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 2 }, // Aatrox
  267: { cc: 3, damage: 1, tankiness: 0, mobility: 0, utility: 2, engage: 3 }, // Nami
  268: { cc: 2, damage: 3, tankiness: 0, mobility: 1, utility: 1, engage: 2 }, // Azir
  350: { cc: 1, damage: 0, tankiness: 0, mobility: 0, utility: 3, engage: 0 }, // Yuumi
  360: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 2 }, // Samira
  412: { cc: 3, damage: 1, tankiness: 2, mobility: 1, utility: 2, engage: 3 }, // Thresh
  420: { cc: 1, damage: 3, tankiness: 3, mobility: 0, utility: 0, engage: 1 }, // Illaoi
  421: { cc: 1, damage: 3, tankiness: 2, mobility: 3, utility: 0, engage: 3 }, // Rek'Sai
  427: { cc: 2, damage: 1, tankiness: 1, mobility: 1, utility: 2, engage: 2 }, // Ivern
  429: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 1 }, // Kalista
  432: { cc: 2, damage: 1, tankiness: 0, mobility: 1, utility: 3, engage: 2 }, // Bard
  497: { cc: 3, damage: 1, tankiness: 0, mobility: 3, utility: 2, engage: 3 }, // Rakan
  498: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Xayah
  516: { cc: 3, damage: 1, tankiness: 3, mobility: 1, utility: 2, engage: 3 }, // Ornn
  517: { cc: 1, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Sylas
  518: { cc: 2, damage: 3, tankiness: 0, mobility: 1, utility: 1, engage: 2 }, // Neeko
  523: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Aphelios
  526: { cc: 3, damage: 0, tankiness: 3, mobility: 1, utility: 1, engage: 3 }, // Rell
  555: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 1, engage: 3 }, // Pyke
  711: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 0, engage: 1 }, // Vex
  777: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 1, engage: 3 }, // Yone
  799: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Ambessa
  800: { cc: 1, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 1 }, // Mel
  804: { cc: 0, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 1 }, // Yunara
  805: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 0, engage: 2 }, // Locke
  875: { cc: 2, damage: 3, tankiness: 3, mobility: 0, utility: 0, engage: 2 }, // Sett
  876: { cc: 2, damage: 3, tankiness: 1, mobility: 2, utility: 0, engage: 2 }, // Lillia
  887: { cc: 0, damage: 3, tankiness: 1, mobility: 1, utility: 1, engage: 1 }, // Gwen
  888: { cc: 2, damage: 1, tankiness: 1, mobility: 0, utility: 2, engage: 3 }, // Renata Glasc
  893: { cc: 2, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Aurora
  895: { cc: 1, damage: 3, tankiness: 0, mobility: 2, utility: 1, engage: 2 }, // Nilah
  897: { cc: 3, damage: 2, tankiness: 3, mobility: 2, utility: 0, engage: 3 }, // K'Sante
  901: { cc: 1, damage: 3, tankiness: 0, mobility: 1, utility: 0, engage: 1 }, // Smolder
  902: { cc: 0, damage: 1, tankiness: 0, mobility: 0, utility: 3, engage: 0 }, // Milio
  904: { cc: 1, damage: 3, tankiness: 2, mobility: 2, utility: 0, engage: 2 }, // Zaahen
  910: { cc: 2, damage: 3, tankiness: 0, mobility: 0, utility: 1, engage: 1 }, // Hwei
  950: { cc: 1, damage: 3, tankiness: 0, mobility: 3, utility: 0, engage: 2 }, // Naafiri
};

// ── Fallback derivation for un-curated (future) champions ───────────────────
//
// Coarse, deterministic, tag-driven — NOT a substitute for hand curation
// (every currently-live champion above is curated; this only covers the gap
// window between a new champion's release and someone adding its row). Takes
// the MAX contribution across all of a champion's tags per axis (a champion
// tagged both Fighter and Assassin gets the higher of the two tags' mobility,
// not a sum) so multi-tag champions don't get inflated ratings, then optional
// ddragon `info` (attack/defense/magic, 1-10 scale) fills in damage/tankiness
// ONLY when tags gave that axis a flat zero — info never downgrades a
// tag-derived value.
const TAG_BASE: Record<string, Partial<CompRatingVector>> = {
  Tank: { tankiness: 2, cc: 1 },
  Fighter: { damage: 2, tankiness: 1, engage: 1 },
  Mage: { damage: 2, cc: 1 },
  Marksman: { damage: 3, mobility: 1 },
  Assassin: { mobility: 3, damage: 2, engage: 1 },
  Support: { utility: 2 },
};

export function deriveFallbackRating(tags: string[], info?: ChampInfo | null): CompRatingVector {
  const out = zeroVector();
  for (const tag of tags) {
    const base = TAG_BASE[tag];
    if (!base) continue;
    for (const axis of AXES) {
      const v = base[axis];
      if (v !== undefined) out[axis] = Math.max(out[axis], v);
    }
  }
  if (info) {
    if (out.damage === 0) {
      const offense = Math.max(info.attack, info.magic);
      if (offense >= 7) out.damage = 2;
      else if (offense >= 4) out.damage = 1;
    }
    if (out.tankiness === 0 && info.defense >= 7) out.tankiness = 1;
  }
  for (const axis of AXES) out[axis] = Math.min(3, Math.max(0, out[axis]));
  return out;
}

/** Resolves ONE champion's rating: curated row if it exists, else a coarse
 *  fallback. `aggregateEnemyComp` below is fed only champion ids (pinned
 *  contract), so its own internal fallback calls run tag-less/info-less —
 *  a fully-neutral `estimated:true` vector. Any caller that DOES have real
 *  tags/info (e.g. a future radar hover-preview for an un-curated champion)
 *  should call `deriveFallbackRating` directly instead for a sharper guess;
 *  this function is deliberately the conservative default. */
export function getCompRating(champId: number): RatedComp {
  const curated = COMP_RATINGS[champId];
  if (curated) return { ...curated, estimated: false };
  return { ...deriveFallbackRating([]), estimated: true };
}

/** Mean per axis across `enemyIds`' resolved ratings (curated or fallback —
 *  every id resolves to SOMETHING, never blank, per this file's CI test).
 *  Handles 0 enemies (all-zero, estimatedCount 0) and any count 1-5 the same
 *  way — a plain arithmetic mean, no special-casing by count. */
export function aggregateEnemyComp(enemyIds: number[]): AggregatedComp {
  if (enemyIds.length === 0) {
    return { ...zeroVector(), estimatedCount: 0 };
  }
  const sums = zeroVector();
  let estimatedCount = 0;
  for (const id of enemyIds) {
    const r = getCompRating(id);
    if (r.estimated) estimatedCount++;
    for (const axis of AXES) sums[axis] += r[axis];
  }
  const n = enemyIds.length;
  const out: AggregatedComp = { ...zeroVector(), estimatedCount };
  for (const axis of AXES) out[axis] = sums[axis] / n;
  return out;
}
