// ─────────────────────────────────────────────────────────────────────────────
// runeAutoApply.ts — v1.3.0. The rune-side counterpart to itemSetsApply.ts:
// the ONE shared code path between the manual "Apply runes" button
// (RunesSummonersCard.tsx, mode:'manual') and the champ-select auto-export
// effect (BuildTabContent.tsx, mode:'auto'). Gate logic is imported from
// autoExportShared.ts (generalized there specifically so runes and item
// sets share one implementation, not two that could drift).
//
// COMPLIANCE (v1.3.0 update, see companion.ps1's header for the full
// reasoning): rune writes may now auto-export, same class as item sets —
// an inert loadout suggestion, not a game action. The one bright line that
// does NOT move: mode:'auto' never deletes a rune page it doesn't own
// (enforced companion-side, SelfTest-pinned); this file has no gating
// opinion on that beyond always passing "auto" for the auto-export path.
// ─────────────────────────────────────────────────────────────────────────────

import type { RunesBlock } from "@/lib/types";
import { buildRuneApplyBody } from "./runeApplyBody";
import { applyRunes, getStatus, type ApplyRunesResult, type CompanionPort } from "@/components/live/companionClient";
import { shouldAutoExport, type AutoApplyGateInput } from "./autoExportShared";

export type { AutoApplyGateInput };

export function shouldAutoApplyRunes(input: AutoApplyGateInput): boolean {
  return shouldAutoExport(input);
}

/** The ONE call both the manual button and the auto-export effect make. */
export async function applyRunesForBuild(params: {
  championName: string;
  roleLabel: string;
  runes: RunesBlock;
  port: CompanionPort;
  session: string;
}): Promise<ApplyRunesResult> {
  const body = buildRuneApplyBody(params.championName, params.roleLabel, params.runes);
  return applyRunes(params.port, params.session, body, "auto");
}

export type AutoApplyRunesOutcome = { attempted: false } | { attempted: true; result: ApplyRunesResult };

/** Full auto-export attempt: gate check -> companion probe (getStatus) ->
 *  applyRunesForBuild. Same "probe first, quiet no-op on failure" posture
 *  as itemSetsApply.ts's autoApplyItemSetsIfEligible — a probe failure
 *  never surfaces a toast for something the user never clicked. */
export async function autoApplyRunesIfEligible(
  gate: AutoApplyGateInput,
  build: () => Promise<{ championName: string; roleLabel: string; runes: RunesBlock }>,
  deps: { getStatusImpl?: typeof getStatus; applyFn?: typeof applyRunesForBuild } = {}
): Promise<AutoApplyRunesOutcome> {
  if (!shouldAutoApplyRunes(gate)) return { attempted: false };
  const getStatusFn = deps.getStatusImpl ?? getStatus;
  const applyFn = deps.applyFn ?? applyRunesForBuild;

  const port = gate.port as CompanionPort;
  const session = gate.session as string;
  const status = await getStatusFn(port, session);
  if (!status) return { attempted: false };

  const params = await build();
  const result = await applyFn({ ...params, port, session });
  return { attempted: true, result };
}
