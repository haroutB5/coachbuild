// ─────────────────────────────────────────────────────────────────────────────
// proGames.fixtures.ts — dev/test fixtures for the Pro Games section, shaped
// exactly like the /api/pros contract (see HANDOFF-fronty.md). Used to verify
// rendering before the live backend route has data for a given champ/role.
// ─────────────────────────────────────────────────────────────────────────────

import type { ProGame } from "./proGames.types";

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 60 * 60 * 1000).toISOString();

// Standard 18-level skill order, R at 6/11/16.
const STANDARD_SKILL_ORDER = [
  "Q", "E", "W", "Q", "Q", "R", "Q", "W", "Q", "W",
  "R", "W", "W", "E", "E", "R", "E", "E",
];

/** Routine win — clean, unremarkable purchase order. */
export const FIXTURE_GAME_WIN: ProGame = {
  id: "fixture-win-1",
  source: "soloq",
  player: { name: "Caps", team: "G2 Esports", role: 2, country: "DK" },
  account: { riotId: "Caps#EUW", region: "EUW" },
  championId: 112,
  championName: "Viktor",
  role: 2,
  patch: "16.13",
  win: true,
  kills: 8,
  deaths: 2,
  assists: 6,
  gameCreation: hoursAgo(3),
  gameDurationSec: 1850, // 30:50
  spells: [4, 14], // Flash, Ignite
  finalItems: [6653, 3020, 3157, 3089, 3135, 4645], // Liandry's, Sorc Shoes, Zhonya's, Rabadon's, Void Staff, Shadowflame
  trinket: 3364, // Oracle Lens
  purchaseOrder: [
    { itemId: 1052, ts: 65 }, // Amplifying Tome
    { itemId: 2003, ts: 65 }, // Health Potion
    { itemId: 3802, ts: 420 }, // Lost Chapter
    { itemId: 3020, ts: 870 }, // Sorcerer's Shoes
    { itemId: 6653, ts: 1240 }, // Liandry's Torment
    { itemId: 3157, ts: 1560 }, // Zhonya's Hourglass
    { itemId: 3089, ts: 1850 }, // Rabadon's Deathcap
  ],
  skillOrder: STANDARD_SKILL_ORDER,
  runes: {
    primaryTree: 8200, // Sorcery
    keystone: 8229, // Arcane Comet
    primary: [8226, 8210, 8237], // Manaflow Band, Transcendence, Scorch
    secondaryTree: 8100, // Domination
    secondary: [8126, 8143], // Cheap Shot, Sudden Impact
    shards: [5008, 5008, 5011], // Adaptive, Adaptive, Health
  },
};

/** A loss — same champ, fewer final items (game ended early), different pro. */
export const FIXTURE_GAME_LOSS: ProGame = {
  id: "fixture-loss-1",
  source: "soloq",
  player: { name: "Bdd", team: "Hanwha Life Esports", role: 2, country: "KR" },
  account: { riotId: "Bdd#KR1", region: "KR" },
  championId: 112,
  championName: "Viktor",
  role: 2,
  patch: "16.13",
  win: false,
  kills: 2,
  deaths: 6,
  assists: 3,
  gameCreation: hoursAgo(9),
  gameDurationSec: 1610, // 26:50
  spells: [4, 12], // Flash, Teleport
  finalItems: [6653, 3020, 3157, 3135],
  trinket: 3340, // Stealth Ward (never upgraded)
  purchaseOrder: [
    { itemId: 1052, ts: 60 },
    { itemId: 2003, ts: 60 },
    { itemId: 2003, ts: 60 },
    { itemId: 3802, ts: 480 },
    { itemId: 3020, ts: 910 },
    { itemId: 6653, ts: 1340 },
    { itemId: 3157, ts: 1610 },
  ],
  skillOrder: STANDARD_SKILL_ORDER.slice(0, 14),
  runes: {
    primaryTree: 8200,
    keystone: 8214, // Summon Aery
    primary: [8226, 8275, 8210], // Manaflow Band, Nimbus Cloak, Transcendence
    secondaryTree: 8400, // Resolve
    secondary: [8446, 8429], // Demolish, Conditioning
    shards: [5008, 5008, 5011],
  },
};

/** Eventful purchase order — potions, control wards, and a trinket upgrade
 *  interspersed with core items, to exercise the consumable-filter toggle
 *  and a longer expandable timeline. */
export const FIXTURE_GAME_EVENTFUL: ProGame = {
  id: "fixture-eventful-1",
  source: "soloq",
  player: { name: "Chovy", team: "Gen.G", role: 2, country: "KR" },
  account: { riotId: "Chovy#KR1", region: "KR" },
  championId: 112,
  championName: "Viktor",
  role: 2,
  patch: "16.12",
  win: true,
  kills: 11,
  deaths: 3,
  assists: 9,
  gameCreation: hoursAgo(27),
  gameDurationSec: 2215, // 36:55
  spells: [4, 14],
  finalItems: [6653, 3020, 3157, 3089, 3135, 4645],
  trinket: 3364,
  purchaseOrder: [
    { itemId: 1052, ts: 60 },
    { itemId: 2003, ts: 60 },
    { itemId: 2055, ts: 190 }, // Control Ward
    { itemId: 2003, ts: 340 },
    { itemId: 3802, ts: 410 },
    { itemId: 2055, ts: 560 }, // Control Ward
    { itemId: 3020, ts: 830 },
    { itemId: 2003, ts: 830 },
    { itemId: 2003, ts: 830 },
    { itemId: 3363, ts: 900 }, // Farsight Alteration (trinket swap)
    { itemId: 6653, ts: 1180 },
    { itemId: 2055, ts: 1260 },
    { itemId: 3157, ts: 1520 },
    { itemId: 2031, ts: 1600 }, // Refillable Potion
    { itemId: 3364, ts: 1690 }, // upgraded to Oracle Lens
    { itemId: 3089, ts: 1900 },
    { itemId: 2055, ts: 1980 },
    { itemId: 3135, ts: 2100 },
    { itemId: 4645, ts: 2215 },
  ],
  skillOrder: STANDARD_SKILL_ORDER,
  runes: {
    primaryTree: 8200,
    keystone: 8214, // Summon Aery
    primary: [8224, 8210, 8236], // Axiom Arcanist, Transcendence, Gathering Storm
    secondaryTree: 8300, // Inspiration
    secondary: [8306, 8321], // Hextech Flashtraption, Future's Market
    shards: [5008, 5008, 5002], // Adaptive, Adaptive, Armor
  },
};

/** Prostage, full runes — everything present except purchase/skill data. */
export const FIXTURE_GAME_PROSTAGE_FULL: ProGame = {
  id: "fixture-prostage-full-1",
  source: "prostage",
  tournament: "MSI 2026",
  player: { name: "Faker", team: "T1", role: 2, country: "KR" },
  account: { riotId: "", region: "MSI 2026" },
  championId: 112,
  championName: "Viktor",
  role: 2,
  patch: "16.13",
  win: true,
  kills: 6,
  deaths: 1,
  assists: 10,
  gameCreation: hoursAgo(48),
  gameDurationSec: 1980, // 33:00
  spells: [4, 14],
  finalItems: [6653, 3020, 3157, 3089, 3135, 4645],
  trinket: 3364,
  purchaseOrder: [],
  skillOrder: [],
  runes: {
    primaryTree: 8200,
    keystone: 8229, // Arcane Comet
    primary: [8226, 8210, 8237],
    secondaryTree: 8100,
    secondary: [8126, 8143],
    shards: [5008, 5008, 5011],
  },
};

/** Prostage, keystone-only runes + unknown game length — exercises the
 *  "hide length when 0", "hide empty patch", and "no empty rune circles"
 *  degradation paths. */
export const FIXTURE_GAME_PROSTAGE_PARTIAL: ProGame = {
  id: "fixture-prostage-partial-1",
  source: "prostage",
  tournament: "LCK Summer 2026",
  player: { name: "Chovy", team: "Gen.G", role: 2, country: "KR" },
  account: { riotId: "", region: "LCK Summer 2026" },
  championId: 112,
  championName: "Viktor",
  role: 2,
  patch: "",
  win: false,
  kills: 3,
  deaths: 4,
  assists: 5,
  gameCreation: hoursAgo(72),
  gameDurationSec: 0, // unknown — hide length
  spells: [4, 12],
  finalItems: [6653, 3020, 3157],
  trinket: null,
  purchaseOrder: [],
  skillOrder: [],
  runes: {
    primaryTree: 8200,
    keystone: 8214, // Summon Aery
    primary: [],
    secondaryTree: 8400,
    secondary: [],
    shards: [],
  },
};

export const FIXTURE_PRO_GAMES: ProGame[] = [
  FIXTURE_GAME_WIN,
  FIXTURE_GAME_LOSS,
  FIXTURE_GAME_EVENTFUL,
  FIXTURE_GAME_PROSTAGE_FULL,
  FIXTURE_GAME_PROSTAGE_PARTIAL,
];
