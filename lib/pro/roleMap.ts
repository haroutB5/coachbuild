// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/roleMap.ts — role numbering used across the pro pipeline (0-4, no
// "auto" sentinel — pro data always resolves to a concrete role or is skipped).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProRoleId } from "./types";

/** Riot match-v5 participant.teamPosition -> ProRoleId. */
const TEAM_POSITION_MAP: Record<string, ProRoleId> = {
  TOP: 0,
  JUNGLE: 1,
  MIDDLE: 2,
  BOTTOM: 3,
  UTILITY: 4,
};

/** Returns null (caller must skip+log) for empty/unrecognized positions —
 *  Riot leaves teamPosition "" on some remade/edge-case games. */
export function roleFromTeamPosition(teamPosition: string | undefined | null): ProRoleId | null {
  if (!teamPosition) return null;
  const id = TEAM_POSITION_MAP[teamPosition.toUpperCase()];
  return id === undefined ? null : id;
}

/** lolpros ladder/profile "position" field -> ProRoleId, e.g. "20_jungle",
 *  "30_mid", "40_adc", "10_top", "50_support" (verified live 2026-07-09).
 *  Matches on the suffix after the underscore so numeric-prefix drift is safe. */
const LOLPROS_POSITION_MAP: Record<string, ProRoleId> = {
  top: 0,
  jungle: 1,
  jgl: 1,
  mid: 2,
  middle: 2,
  adc: 3,
  bot: 3,
  bottom: 3,
  support: 4,
  sup: 4,
  supp: 4,
  utility: 4,
};

export function roleFromLolProsPosition(position: string | undefined | null): ProRoleId | null {
  if (!position) return null;
  const suffix = position.includes("_") ? position.split("_").slice(1).join("_") : position;
  const id = LOLPROS_POSITION_MAP[suffix.toLowerCase()];
  return id === undefined ? null : id;
}

export const SKILL_SLOT_LABEL: Record<number, string> = {
  1: "Q",
  2: "W",
  3: "E",
  4: "R",
};
