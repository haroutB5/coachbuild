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
  /** 4th+ legendary picks, WPA-sorted best-first. Combined with
   *  first/second/third + boots, the total full-item count is capped at
   *  assembly time (lib/buildSlotCap.ts) to the 6-slot game reality: at most
   *  2 entries here for non-bot lanes (5 full items + boots total), at most 3
   *  for bot/ADC (6 full items + boots — the late-game boots-sell exception).
   *  Never longer than 3 regardless of lane (recommend.ts only ever sources
   *  up to 3 candidates for this slot). */
  fourthPlus: Pick[];
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

// ── Recommended skill order (GET /api/skill-order) ───────────────────────────
// The aggregate "Skill Priority" / "Skill Path" recommendation for a
// champion + role, sourced from op.gg. Distinct from the PER-GAME skillOrder
// on a ProGame (Riot-timeline-extracted, rendered by
// components/skillOrderGrid.ts) — that is one game's measured path, this is a
// recommendation aggregated over many. See lib/skillOrderModel.ts.

export type Ability = "Q" | "W" | "E" | "R";

/**
 * A champion's REAL per-ability rank rules, sourced from Data Dragon's
 * `spells[i].maxrank`. See lib/championKit.ts for how each field is derived
 * and what evidence backs it — that header is the reference, this is the wire
 * shape it travels in.
 *
 * This rides on SkillOrderModel (and therefore across /api/skill-order)
 * deliberately: both the /compact panel and the desktop overlay already pass
 * the API payload through verbatim, so shipping the rules WITH the order means
 * every consumer becomes champion-correct without its own ddragon call.
 */
export interface ChampionKit {
  /** Max ranks per slot, verbatim from ddragon. 5/5/5/3 for 166 champions. */
  maxRanks: Readonly<Record<Ability, number>>;
  /** Ranks granted at level 1 WITHOUT spending a skill point. Nonzero only in
   *  the R slot, and only for form-swap kits (Jayce, Karma, Elise, Nidalee).
   *  Load-bearing: `unspent = level − Σ(spent)` is off by one all game if a
   *  free rank is counted as spent. */
  freeRanks: Readonly<Record<Ability, number>>;
  /** Minimum champion level for each R rank (1-based, counting free ranks),
   *  or null when the R slot is not level-gated at all (Udyr's fourth basic). */
  ultimateLevels: readonly number[] | null;
  /** Σ ranks that cost a point. Equals 18 for the 170 champions who can spend
   *  every point; >18 for Yuumi/Aphelios/Udyr, who must skip something — which
   *  is exactly why their level 16-18 tail is not derivable. */
  purchasableTotal: number;
  /**
   * Recorded timeline data carries an R marker for Aphelios's otherwise
   * automatic R, even though it costs no point. Jayce's R is also automatic
   * but is not serialized in the recorded order. Optional for old hand-built
   * kits; consumers fall back to the verified maxrank-1 Jayce rule.
   */
  rAuto?: boolean;
}

export interface SkillOrderModel {
  /** Max-priority order of the basic abilities, e.g. ["Q","W","E"]. */
  priority: Ability[];
  /** Level numbers (1-18) at which each ability is ranked up. */
  levels: Record<Ability, number[]>;
  /** Sequence by level; index 0 = level 1. Length 15 or 18. */
  order: Ability[];
  /** True only when levels 16-18 were derived by the completion rule.
   *  False means the source's 15 are all we honestly know. */
  completed: boolean;
  /**
   * How many LEADING entries of `order` came VERBATIM from the source.
   * Everything at a higher index was DERIVED by lib/skillOrderModel.ts's
   * completion rule and must not be rendered as measured (CLAUDE.md hard
   * rule #4). 15 on a completed order, `order.length` when nothing was
   * derived.
   *
   * Optional ONLY for back-compat — a response cached before this field
   * existed, or a hand-built fixture, omits it. Never read it raw: call
   * `observedLevelCount(model)` / `isDerivedLevel(model, level)`, which
   * reproduce the old meaning when it is absent.
   */
  observedLevels?: number;
  /**
   * WHICH priority resolved the derived tail:
   *   * `"published"` — op.gg's own `skill_masteries.ids` max order, measured
   *                     over a larger sample than the levelling order itself.
   *   * `"derived"`   — inferred from the observed path by `derivePriority`,
   *                     because the source published none we could validate.
   * Absent when nothing was derived. Diagnostic/provenance, not a score.
   */
  completionBasis?: "published" | "derived";
  /**
   * The levels the derivation REFUSED, filled from the max-priority order so a
   * recommendation surface can render a complete 18 (user directive
   * 2026-07-29). Present only when `completed` is false and something could be
   * inferred; absent whenever the champion's kit could not be resolved.
   *
   * A GUESS, and the field name is the contract. Three rules for consumers:
   *   * It is NOT part of `order`/`levels`/`observedLevels` — those keep their
   *     exact prior meaning, which is why lib/nextSkill.ts's live in-game
   *     refusal past level 15 is untouched by this field's existence.
   *   * Appending it to `order` yields the full 18 levels, in order, starting
   *     at level `order.length + 1`.
   *   * Anything rendering it MUST mark it visibly as inferred (hard rule #4).
   *     It may be SHORTER than the gap it fills, when the priority named
   *     nothing left under a cap; the remaining levels are then genuinely
   *     unknown and must stay empty.
   */
  inferredTail?: Ability[];
  /** Which priority produced `inferredTail` — the source's own published max
   *  order, or one read off the observed path. Provenance, never a score. */
  inferredBasis?: "published" | "derived";
  /** Games behind this order. */
  sampleSize: number;
  /** 0..1, or null when not supplied. */
  winRate: number | null;
  /** Share of games using this order, 0..1, or null. */
  share: number | null;
  /**
   * This champion's real rank rules. THREE distinct states, and the
   * difference between them is the difference between advising and guessing:
   *
   *   * a ChampionKit — resolved from ddragon for THIS champion. Use it.
   *   * `null`        — could not resolve, AND this champion is known to be
   *                     off the 5/5/5/3 model. Consumers must REFUSE; falling
   *                     back to standard here is what produced the blank-Jayce
   *                     bug's wrong arithmetic.
   *   * absent        — no kit travelled with this model (an API response
   *                     cached before this field existed, or a hand-built test
   *                     fixture). Treated as STANDARD_KIT, which is the exact
   *                     behaviour every consumer had before this field.
   */
  kit?: ChampionKit | null;
}

export interface ApiError {
  error: string;
  detail?: string;
}
