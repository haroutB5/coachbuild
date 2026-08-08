// ─────────────────────────────────────────────────────────────────────────────
// champSelectChipModel.ts — pure model for the GlobalNav rail's small
// "CHAMP SELECT" status chip (v0.51 redesign wave A). Distinct widget from
// this same directory's companionStatusModel.ts (the rail's fuller companion
// status CARD, shown off to the side) -- this is a compact, always-in-flow
// chip meant to catch the eye the moment champ select starts, mirroring the
// mockup's "CHAMP SELECT — SWAIN · TOP" pill.
//
// Input shape deviates from CompanionContextValue on purpose. The real
// companion snapshot (components/live/CompanionProvider.tsx's
// CompanionChampSelectSnapshot, components/live/companionClient.ts) only
// carries championId/roleId as NUMBERS -- there is no championName/role
// STRING anywhere in the wire contract. Resolving a numeric championId to a
// display name requires the app's champion list, which only the page-level
// component holds (fetched once, e.g. app/page.tsx's champion search data) --
// a pure model in this file must not fetch or import that list itself (same
// "pure logic in .ts, JSX/data stays in the component" split every other
// model in this codebase follows, e.g. champSelectFollow.ts's own doc
// comment). So the CALLER (a .tsx component) is expected to resolve
// championId -> name and roleId -> lane label (heroContracts.ts's LANE_LABEL,
// uppercased) BEFORE calling this function, same shape the brief's own
// illustrative signature already used -- verified against the real snapshot
// shape, this is the correct contract, not a shortcut.
// ─────────────────────────────────────────────────────────────────────────────

export interface ChampSelectChip {
  show: boolean;
  label: string;
  tone: "live" | "idle";
}

export interface ChampSelectChipInput {
  /** Raw companion phase string (CompanionContextValue.phase), e.g.
   *  "ChampSelect" | "InProgress" | "None" | null. */
  phase: string | null;
  champSelect: {
    /** Already-resolved display name (e.g. "Swain"), or null when the
     *  companion is in ChampSelect but no champion has resolved yet
     *  (nothing locked/hovered/intent-set). Never a fabricated placeholder
     *  name. */
    championName?: string | null;
    /** Already-resolved short lane label (e.g. "Top"), or null/omitted when
     *  unresolved (role-less lobby, or Leaguepedia-style unmapped role --
     *  see champSelectFollow.ts's own "role-less, fall back" contract). */
    role?: string | null;
  } | null;
  clientConnected: boolean;
  /** False when the phase/snapshot came from a stale /status response. */
  statusFresh?: boolean;
}

/** Not connected, or no champSelect snapshot at all -> hidden. */
function hidden(): ChampSelectChip {
  return { show: false, label: "", tone: "idle" };
}

export function champSelectChipModel(i: ChampSelectChipInput): ChampSelectChip {
  if (i.statusFresh === false) return hidden();
  if (!i.clientConnected) return hidden();

  // Only ChampSelect ever shows this chip -- InProgress/None/lobby phases
  // have nothing "picking" for the rail to surface here (companionStatusModel
  // already covers the general connected/in-game states in its own card).
  if (i.phase !== "ChampSelect") return hidden();
  if (!i.champSelect) return hidden();

  const name = i.champSelect.championName;
  if (!name) {
    // In ChampSelect, but nothing has resolved to a champion yet (fresh
    // lobby, still banning, or a hover that hasn't produced pickIntent/
    // cellChampionId/actionChampionId per champSelectFollow.ts's 3-way
    // priority) -- an honest "still picking" state, not a blank/hidden chip,
    // since the user IS live in champ select right now.
    return { show: true, label: "CHAMP SELECT — PICKING", tone: "live" };
  }

  const role = i.champSelect.role;
  const suffix = role ? ` · ${role.toUpperCase()}` : "";
  return { show: true, label: `CHAMP SELECT — ${name.toUpperCase()}${suffix}`, tone: "live" };
}
