import type { BuildResponse } from "./types";

// Mock BuildResponse used for frontend dev before the live API is wired.
// Real, corrected Viktor-mid data (all-trees: Sorcery primary + PRECISION secondary).
// Icons are live coachless CDN URLs. winrate left null where not yet wired.

const RUNE = "https://cdn.coachless.gg/static-files/16.11.1/img/perk-images/Styles";
const TREE = "https://cdn.coachless.gg/runes";
const SHARD = "https://cdn.coachless.gg/stat-icons";
const ITEM = "https://cdn.coachless.gg/static-files/16.11.1/16.11.1/img/item";
const SPELL = "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/spell";
const CHAMP = "https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion";

export const sampleBuild: BuildResponse = {
  champion: { id: 112, key: "Viktor", name: "Viktor", icon: `${CHAMP}/Viktor.webp` },
  role: 2,
  roleLabel: "Mid",
  patch: "16.11",
  tierLabel: "High Elo",
  runes: {
    primaryTree: { id: 8200, name: "Sorcery", icon: `${TREE}/sorcery.png` },
    secondaryTree: { id: 8000, name: "Precision", icon: `${TREE}/precision.png` },
    keystone: {
      id: 8992, name: "Deathfire Touch", icon: `${RUNE}/Sorcery/DeathfireTouch/DEATHFIRE_TOUCH_KEYSTONE.webp`,
      wpa: 0.04, winrate: null, occurrence: 251471,
    },
    primary: [
      { id: 8226, name: "Manaflow Band", icon: `${RUNE}/Sorcery/ManaflowBand/ManaflowBand.webp`, wpa: 0.01, winrate: null, occurrence: 265291 },
      { id: 8234, name: "Celerity", icon: `${RUNE}/Sorcery/Celerity/CelerityTemp.webp`, wpa: 0.29, winrate: null, occurrence: 78086 },
      { id: 8236, name: "Gathering Storm", icon: `${RUNE}/Sorcery/GatheringStorm/GatheringStorm.webp`, wpa: 1.62, winrate: null, occurrence: 9031 },
    ],
    secondary: [
      { id: 9105, name: "Legend: Haste", icon: `${RUNE}/Precision/LegendHaste/LegendHaste.webp`, wpa: 0.19, winrate: null, occurrence: 54552 },
      { id: 8017, name: "Cut Down", icon: `${RUNE}/Precision/CutDown/CutDown.webp`, wpa: 0.18, winrate: null, occurrence: 57355 },
    ],
    shards: {
      offense: { id: 5008, name: "Adaptive Force", icon: `${SHARD}/adaptiveforce.png`, wpa: 0.97, winrate: null, occurrence: 10531 },
      flex: { id: 5010, name: "Move Speed", icon: `${SHARD}/ms.png`, wpa: 1.68, winrate: null, occurrence: 33578 },
      defense: { id: 5011, name: "Health", icon: `${SHARD}/health.png`, wpa: 0.15, winrate: null, occurrence: 90619 },
    },
  },
  spells: [
    { id: 4, name: "Flash", icon: `${SPELL}/SummonerFlash.webp`, wpa: 0.0, winrate: null, occurrence: 288100 },
    { id: 6, name: "Ghost", icon: `${SPELL}/SummonerHaste.webp`, wpa: 1.25, winrate: null, occurrence: 63700 },
  ],
  items: {
    starter: { id: 1056, name: "Doran's Ring", icon: `${ITEM}/1056.webp`, wpa: 0.01, winrate: null, occurrence: 285500 },
    boots: { id: 3020, name: "Sorcerer's Shoes", icon: `${ITEM}/3020.webp`, wpa: 0.04, winrate: null, occurrence: 124200 },
    first: { id: 2503, name: "Blackfire Torch", icon: `${ITEM}/2503.webp`, wpa: 0.15, winrate: null, occurrence: 215600 },
    second: { id: 3100, name: "Lich Bane", icon: `${ITEM}/3100.webp`, wpa: 1.05, winrate: null, occurrence: 34300 },
    third: { id: 4645, name: "Shadowflame", icon: `${ITEM}/4645.webp`, wpa: 0.32, winrate: null, occurrence: 26100 },
    fourthPlus: [
      { id: 3089, name: "Rabadon's Deathcap", icon: `${ITEM}/3089.webp`, wpa: 0.4, winrate: null, occurrence: 25900 },
      { id: 3135, name: "Void Staff", icon: `${ITEM}/3135.webp`, wpa: -0.13, winrate: null, occurrence: 13100 },
    ],
  },
  generatedAt: "2026-06-14T11:00:00.000Z",
  sources: { provider: "coachless.gg" },
  rank: 1,
  label: "Top pick",
  subtitle: "Precision secondary",
};
