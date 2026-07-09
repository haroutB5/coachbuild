// ─────────────────────────────────────────────────────────────────────────────
// proHistory.fixtures.ts — dev/test fixtures for the Pro History /players
// typeahead, shaped exactly like the /api/players contract (see
// HANDOFF-fronty.md). Used to verify rendering before the live backend route
// has real data. Not imported by any shipped component — same discipline as
// proGames.fixtures.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { PlayerRef } from "./proHistory.types";

export const FIXTURE_PLAYERS: PlayerRef[] = [
  { id: "p-faker", name: "Faker", slug: "faker", team: "T1", role: 2, country: "KR", gameCount: 41 },
  { id: "p-chovy", name: "Chovy", slug: "chovy", team: "Gen.G", role: 2, country: "KR", gameCount: 33 },
  { id: "p-caps", name: "Caps", slug: "caps", team: "G2 Esports", role: 2, country: "DK", gameCount: 27 },
  { id: "p-bdd", name: "Bdd", slug: "bdd", team: "Hanwha Life Esports", role: 2, country: "KR", gameCount: 19 },
  { id: "p-showmaker", name: "ShowMaker", slug: "showmaker", team: "Dplus KIA", role: 2, country: "KR", gameCount: 0 },
];
