// ─────────────────────────────────────────────────────────────────────────────
// Local types for the Pro Games feature — mirror the /api/pros contract.
// Deliberately NOT imported from lib/types.ts (backend-owned, in-flight in
// parallel with this work) — see HANDOFF-fronty.md for the contract this was
// built against.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProGamePlayer {
  name: string;
  team: string | null;
  role: number;
  country: string | null;
}

export interface ProGameAccount {
  riotId: string;
  region: string;
}

export interface ProGamePurchase {
  itemId: number;
  ts: number; // seconds into the game
}

export interface ProGameRunes {
  primaryTree: number;
  keystone: number;
  primary: number[]; // 3 ids
  secondaryTree: number;
  secondary: number[]; // 2 ids
  shards: number[]; // 3 ids
}

export interface ProGame {
  id: string;
  source: "soloq";
  player: ProGamePlayer;
  account: ProGameAccount;
  championId: number;
  championName: string;
  role: number;
  patch: string; // "16.13"
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  gameCreation: string; // ISO
  gameDurationSec: number;
  spells: [number, number];
  finalItems: number[];
  trinket: number | null;
  purchaseOrder: ProGamePurchase[];
  skillOrder: string[]; // ["Q","W","E","Q",...]
  runes: ProGameRunes;
}

export interface ProGamesApiResponse {
  games: ProGame[];
}
