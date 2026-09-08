import type { DifficultyBand } from "@/lib/draft/difficulty";
import type { SuggestedDefense } from "@/lib/draft/damageProfile";

export interface DraftEnemyAnalysis {
  champId: number;
  isLaneOpponent: boolean;
  winRateVsYou: number | null;
  winRateVsYouGames: number | null;
  laneThreatBand: DifficultyBand | null;
  suggestedDefense: SuggestedDefense | null;
}

