export interface DraftCountersParams { enemy: number; lane: number }

export interface DraftCounterSuggestion {
  champId: number;
  name: string;
  winRate: number;
  goldAt15: number;
  games: number;
}

export interface DraftCountersResponse {
  enemy: { id: number; name: string; slug: string };
  lane: number;
  sourceUrl: string;
  patch: string;
  fetchedAt: string;
  bestLaneCounters: DraftCounterSuggestion[];
  worstPicks: DraftCounterSuggestion[];
}

