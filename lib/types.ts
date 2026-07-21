// ─────────────────────────────────────────────────────────────────────────────
// SHARED CONTRACT — the single handshake between backend (app/api) and frontend.
// Backend: GET /api/build?champ=<id>&role=<0-5>  -> BuildResponse
//          GET /api/champions                    -> ChampionRef[]
// Frontend renders BuildResponse. Do NOT diverge from these shapes without
// updating both sides. Icons are absolute coachless CDN URLs (hotlinked).
// ─────────────────────────────────────────────────────────────────────────────

/** Role enum as used by the coachless API (verified live). */
export type RoleId = 0 | 1 | 2 | 3 | 4 | 5;
//  0 = TOP, 1 = JUNGLE, 2 = MIDDLE, 3 = BOTTOM(ADC), 4 = UTILITY(SUPPORT), 5 = auto/primary
export const ROLE_LABEL: Record<RoleId, string> = {
  0: "Top",
  1: "Jungle",
  2: "Mid",
  3: "Bot",
  4: "Support",
  5: "Auto",
};

/** Riot rune tree style IDs. */
export type TreeId = 8000 | 8100 | 8200 | 8300 | 8400;
export const TREE_NAME: Record<TreeId, string> = {
  8000: "Precision",
  8100: "Domination",
  8200: "Sorcery",
  8300: "Inspiration",
  8400: "Resolve",
};

export interface ChampionRef {
  id: number; // Riot numeric key, e.g. 112
  key: string; // Riot string key, e.g. "Viktor"
  name: string; // display name
  icon: string; // absolute URL
  /** Draft redesign plan §2.1 (additive, v0.42.0): ddragon champion.json's
   *  info.difficulty (1-10). null when unknown (a ddragon gap-fill entry
   *  that predates this field, or a genuinely missing/malformed value) --
   *  never fabricated. Absent entirely on an OLDER cached response; treat
   *  missing the same as null. Display-only, never feeds lib/draft/score.ts. */
  difficulty?: number | null;
  /** ddragon champion.json's tags[] (e.g. ["Fighter","Tank"]) -- coarse
   *  archetype basis for lib/draft/compRatings.ts's deriveFallbackRating.
   *  Additive; absent/missing degrades to []. */
  tags?: string[];
}

export interface TreeRef {
  id: TreeId;
  name: string;
  icon: string;
}

/** A single recommendable element (rune / shard / item) with stats. */
export interface Pick {
  id: number;
  name: string;
  icon: string; // absolute URL
  wpa: number; // wpaOverall
  winrate: number | null; // winrateObserved (%) when available
  occurrence: number; // sample size / confidence signal
  lowSample?: boolean; // true when below the confidence guard threshold
  /** Feature 1 (matchup): present ONLY on slots that participate in matchup
   *  conditioning when an `enemyChampionId` was requested. `true` = this pick
   *  came from matchup-conditioned data; `false` = matchup data was missing /
   *  below threshold for this slot and it fell back to the unconditioned pick.
   *  Undefined when no matchup was requested. */
  matchupConditioned?: boolean;
}

export interface ShardSet {
  offense: Pick;
  flex: Pick;
  defense: Pick;
}

export interface RunesBlock {
  primaryTree: TreeRef;
  secondaryTree: TreeRef;
  keystone: Pick;
  primary: Pick[]; // exactly 3 (one per primary row)
  secondary: Pick[]; // exactly 2 (from the best secondary tree)
  shards: ShardSet;
  /** Ranked alternatives for expandable slots (v0.2; frontend may ignore). */
  alts?: {
    keystones?: Pick[];
    primaryByRow?: Pick[][];
    secondaryTrees?: { tree: TreeRef; runes: Pick[] }[];
  };
}

export interface ItemsBlock {
  starter: Pick;
  boots: Pick;
  first: Pick;
  second: Pick;
  third: Pick;
  fourthPlus: Pick[]; // 2-3 items
  /** Ranked alternatives per slot key: "starter"|"boots"|"first"|... (v0.2). */
  alts?: Record<string, Pick[]>;
  /** Feature 2 (sequential item optimizer): a greedy WPA-optimal core-item
   *  chain — each pick after the first is conditioned on OWNING the previous
   *  picks (coachless `firstLegendaryId`/`secondLegendaryId`). Max length 3
   *  (the API conditions on at most 2 prior legendaries — `thirdLegendaryId`
   *  is verified to be a no-op). Each Pick's `occurrence`/`wpa` are the
   *  CONDITIONAL sample size + WPA at that depth. Truncated (shorter, or
   *  omitted) when conditioned samples collapse below the guard threshold —
   *  the UI renders exactly what exists. */
  optimizedPath?: Pick[];
}

export interface BuildResponse {
  champion: ChampionRef;
  role: RoleId;
  roleLabel: string; // "Mid"
  patch: string; // "16.11"
  tierLabel: string; // "High Elo"
  runes: RunesBlock;
  spells: Pick[]; // length 2
  items: ItemsBlock;
  generatedAt: string; // ISO timestamp
  sources: { provider: "coachless.gg" };
  // Present when returned as one of the top-3 variants:
  rank?: number; // 1 = top recommendation
  label?: string; // e.g. "Top pick", "Alternative"
  subtitle?: string; // e.g. "Precision secondary"
  /** Feature 3 (rank brackets): the resolved rank-bracket id this build was
   *  computed for (e.g. "all", "challenger"). Absent → historical default
   *  ("all" / High Elo). `tierLabel` mirrors the bracket's display label. */
  rankBracket?: string;
  /** Feature 1 (matchup): present ONLY when an `enemyChampionId` was requested.
   *  `supported: false` means coachless returned no usable matchup-conditioned
   *  data (today it ALWAYS 403s → always false) and the build fell back to the
   *  standard unconditioned recommendation; the UI should show a "matchup data
   *  unavailable, showing standard build" note. `gamesCount` is the conditioned
   *  sample total (0 when unsupported). */
  matchup?: {
    enemyChampionId: number;
    gamesCount: number;
    supported: boolean;
  };
}

/** Top-3 recommended setups for a champion + role. */
export type BuildsResponse = BuildResponse[];

export interface ApiError {
  error: string;
  detail?: string;
}
