// ─────────────────────────────────────────────────────────────────────────────
// Local types for the Pro History feature — mirror the /api/players contract.
// Deliberately NOT imported from lib/pro/types.ts (backend-owned, in-flight in
// parallel with this work), same discipline as proGames.types.ts. See
// HANDOFF-fronty.md for the contract this was built against.
// ─────────────────────────────────────────────────────────────────────────────

/** 0=Top 1=Jungle 2=Mid 3=Bot 4=Support — matches ProGame.role's numbering. */
export type ProRoleId = 0 | 1 | 2 | 3 | 4;

export interface PlayerRef {
  id: string;
  name: string;
  slug: string;
  team: string | null;
  role: ProRoleId | null;
  country: string | null;
  gameCount: number;
}

export interface PlayersApiResponse {
  players: PlayerRef[];
}

export const PRO_ROLE_LABEL: Record<ProRoleId, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
};
