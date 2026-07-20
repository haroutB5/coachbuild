// ─────────────────────────────────────────────────────────────────────────────
// champSelectFollow.ts — v1.3.0 attached-tab live-follow. Pure decision of
// "should this /status poll change which champion the page is showing,"
// split out from app/page.tsx's poll effect so it's unit-testable without
// mounting React (same "pure logic in .ts, JSX stays in .tsx" convention as
// deepLink.ts / itemSetsApply.ts's own gate functions).
//
// Works for BOTH a deep-link-opened tab AND a tab the user opened manually
// (no deep link at all) — session+port presence is the only gate elsewhere
// (companionClient); this module doesn't care how the tab got its session.
// ─────────────────────────────────────────────────────────────────────────────

import type { CompanionChampSelectSnapshot } from "./companionClient";
import type { LiveRoleId } from "./deepLink";

const VALID_ROLES: readonly LiveRoleId[] = [0, 1, 2, 3, 4];

export interface ChampSelectFollowInput {
  phase: string;
  champSelect: CompanionChampSelectSnapshot | null;
  /** The champion currently shown on the page — the follow only fires when
   *  the resolved target differs from this. */
  currentChampionId: number;
}

export interface ChampSelectFollowTarget {
  championId: number;
  /** Undefined when champSelect never resolved a role (blank/unmapped
   *  assignedPosition — custom lobby, blind pick, ARAM, or a malformed
   *  value) — same "role-less, fall back to most-played-lane" contract as
   *  deepLink.ts's own LiveDeepLink.role. */
  roleId: LiveRoleId | undefined;
}

/** Returns the champion+role the page should switch to, or null when
 *  nothing should change (not in ChampSelect, no resolvable championId
 *  yet, or it's already showing the resolved champion). Mirrors
 *  companion.ps1's own 3-way champion resolution priority (cellChampionId
 *  -> pickIntent -> actionChampionId) so the web side and the companion
 *  agree on "what champion is this, right now." */
export function resolveChampSelectFollow(input: ChampSelectFollowInput): ChampSelectFollowTarget | null {
  if (input.phase !== "ChampSelect") return null;
  if (!input.champSelect) return null;

  const cs = input.champSelect;
  const championId = cs.cellChampionId ?? cs.pickIntent ?? cs.actionChampionId ?? null;
  if (!championId || championId <= 0) return null;
  if (championId === input.currentChampionId) return null;

  const rawRole = cs.roleId;
  const roleId = rawRole !== null && VALID_ROLES.includes(rawRole as LiveRoleId) ? (rawRole as LiveRoleId) : undefined;
  return { championId, roleId };
}
