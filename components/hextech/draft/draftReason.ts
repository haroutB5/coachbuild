import type {
  DraftAssistantCandidate,
  DraftMatchupPreview,
} from "../draftAssistantModel";

export interface DraftReasonInput {
  candidate: DraftAssistantCandidate;
  laneOpponentName: string | null;
  preview: DraftMatchupPreview | undefined;
  floor: number | null;
  compTakeaway: string | null;
  /** True once the user has entered enemies or pinned a lane opponent. The
   *  best-matchup sentence is a claim about an enemy field, so without it the
   *  sentence is suppressed rather than rendered against "popular" picks
   *  nobody entered (2026-09-03: the no-enemy default card read "It holds up
   *  well into popular enemy picks" beside the table's own "No enemies picked
   *  yet" note). Hard rule 4: a matchup claim with no matchup is fabricated
   *  data, however plausible. */
  hasEnemyInfo: boolean;
}

/** THE CALL's verdict chip + one-line reason. Display-only: it never
 *  reorders, filters, or scores — the honest server order stays intact. */
export function reasonForCandidate(args: DraftReasonInput): { chip: string | null; reason: string | null } {
  const parts: string[] = [];
  let chip: string | null = null;
  if (args.laneOpponentName && typeof args.candidate.synergyDelta === "number" && args.candidate.synergyDelta > 0) {
    chip = `Favored into ${args.laneOpponentName}`;
    parts.push(`It answers ${args.laneOpponentName} with the strongest available matchup evidence.`);
  }
  const bestMatchup = args.preview?.best[0];
  if (bestMatchup && args.hasEnemyInfo) {
    parts.push(`It holds up well into ${bestMatchup.oppId === args.candidate.champId ? "the current enemy field" : "popular enemy picks"}.`);
  }
  if (args.floor !== null) {
    chip = chip ?? "Blind-safe";
    parts.push("Its first-pick floor stays useful before the enemy lane is known.");
  }
  if (args.compTakeaway) {
    const plainTakeaway = args.compTakeaway.split(" — ")[0].toLowerCase();
    parts.push(`The enemy read is ${plainTakeaway}, so this keeps the call focused.`);
  }
  return { chip, reason: parts.length > 0 ? parts.join(" ") : null };
}
