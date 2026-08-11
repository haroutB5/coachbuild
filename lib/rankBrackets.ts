// ─────────────────────────────────────────────────────────────────────────────
// rankBrackets.ts — coachless `leagueTiers` mapping. ONE bracket: Diamond+.
//
// ── THE ENUM, CONFIRMED (2026-08-11) ─────────────────────────────────────────
// Read verbatim out of coachless's own production JS bundle
// (https://coachless.gg/chunk-4QOXHN7Z.js), which ships the enum as a literal:
//
//   e[e.Iron=0]="Iron", e[e.Bronze=1]="Bronze", e[e.Silver=2]="Silver",
//   e[e.Gold=3]="Gold", e[e.Platinum=4]="Platinum", e[e.Emerald=5]="Emerald",
//   e[e.Diamond=6]="Diamond", e[e.Master=7]="Master",
//   e[e.Grandmaster=8]="Grandmaster", e[e.Challenger=9]="Challenger"
//
//   Iron 0 · Bronze 1 · Silver 2 · Gold 3 · Platinum 4 · Emerald 5
//   Diamond 6 · Master 7 · Grandmaster 8 · Challenger 9
//
// Cross-checked against their live filter UI's network payloads (checkboxes
// clicked on https://coachless.gg/builds/viktor?role=mid) for tiers 3-7. Tiers
// 8 and 9 come from the bundle enum ONLY — their free UI exposes no checkbox
// for Grandmaster or Challenger, so those two are confirmed one way, not two.
//
// ── WHAT THIS FILE USED TO SAY, AND WHY IT WAS WRONG ─────────────────────────
// Every label here was previously INFERRED from ladder-population shape, and
// every one of them was wrong BY EXACTLY ONE RANK (it called tier 5 "Diamond";
// tier 5 is Emerald). The old default `[5,6,7]`, shipped under the label
// "High Elo", was really Emerald + Diamond + Master — it EXCLUDED Grandmaster
// and Challenger, which no comment or label in the app ever admitted.
//
// The old header also claimed tier 9 was empty. That is stale: a live probe on
// Viktor mid, patch 16.14, returned 693 occurrences at tier 9. Full live
// histogram at the time of this change:
//   3 = 104,022 · 4 = 115,460 · 5 = 112,884 · 6 = 53,886
//   7 = 9,683 · 8 = 2,784 · 9 = 693
//
// ── WHY THERE IS ONLY ONE BRACKET NOW ────────────────────────────────────────
// User directive: show data from Diamond II and above only. coachless's
// `leagueTiers` is TIER-level and has no division axis — their own UI has one
// checkbox per tier and no division control — so "Diamond II+" cannot be
// expressed against this API at all. `[6,7,8,9]` is the closest available
// superset and is therefore the ONLY bracket the app offers. It is slightly
// LOOSER than asked (it includes Diamond III and IV) and there is no stricter
// option; the UI says so in words rather than implying an exactness the data
// does not have (see ChampionHero.tsx's scope note).
//
// With one bracket there is nothing to select, so the rank selector UI is gone.
// Do not re-add a bracket here without also restoring a selector — several call
// sites treat "the stored id" as a constant in practice.
// ─────────────────────────────────────────────────────────────────────────────

export interface RankBracket {
  id: string;
  /** Short display label. */
  label: string;
  /** Longer, honest description of the sample this bracket actually covers. */
  description: string;
  /** coachless `leagueTiers` value. */
  apiValue: number[];
}

/** Diamond (all divisions) + Master + Grandmaster + Challenger.
 *
 *  The id is deliberately NOT the old `"all"`: every previously-stored id
 *  (`all`, `challenger`, `grandmaster`, `master`, `diamond`, `emerald`,
 *  `platinum`) must fail validation in rankBracketStorage.ts so a returning
 *  user is migrated onto this bracket instead of silently keeping an id whose
 *  MEANING changed underneath them. `"all"` in particular used to mean
 *  `[5,6,7]`; reusing the string would have made a stale value look valid. */
export const DIAMOND_PLUS_BRACKET: RankBracket = {
  id: "diamond-plus",
  label: "Diamond+",
  description: "Diamond, Master, Grandmaster and Challenger",
  apiValue: [6, 7, 8, 9],
};

export const RANK_BRACKETS: RankBracket[] = [DIAMOND_PLUS_BRACKET];

export const DEFAULT_RANK_BRACKET = DIAMOND_PLUS_BRACKET;

/** Resolve a rank id to its bracket, or null if unknown. `null`/`undefined`/''
 *  resolve to the default bracket — an absent param is never an error. Unknown
 *  ids still return null so the API routes keep answering 400 on garbage
 *  rather than quietly serving something the caller did not ask for. */
export function resolveRankBracket(id: string | null | undefined): RankBracket | null {
  if (id == null || id === "") return DEFAULT_RANK_BRACKET;
  return RANK_BRACKETS.find((b) => b.id === id) ?? null;
}

/** True when more than one bracket exists — i.e. the UI should render a
 *  selector. False today, and ChampionHero renders a static scope note
 *  instead of a pill row. */
export const RANK_FILTERING_SUPPORTED = RANK_BRACKETS.length > 1;

/** The `&rank=` query fragment for a bracket id, for `/api/build` and
 *  `/api/hero-stats`.
 *
 *  THIS ALWAYS EMITS THE PARAM, and that inversion is the point. Every call
 *  site used to OMIT `&rank=` for the default bracket, deliberately, to keep
 *  the request byte-identical to the pre-rank-feature URL and therefore reuse
 *  its cache entry. That goal is now exactly backwards: both routes send
 *  `Cache-Control: s-maxage=21600, stale-while-revalidate=86400`, so an
 *  unchanged URL would let a shared cache keep serving builds computed from
 *  the OLD `[5,6,7]` tiers for hours after this change — same URL, same key,
 *  different intended meaning. Emitting `rank=diamond-plus` moves the key.
 *
 *  Centralised here rather than repeated as a ternary at each call site: the
 *  old duplicated `rank !== DEFAULT.id ? ... : ""` expression existed in five
 *  files and all five had to agree for the cache key to be right. */
export function rankQueryParam(id: string | null | undefined): string {
  const bracket = resolveRankBracket(id) ?? DEFAULT_RANK_BRACKET;
  return `&rank=${encodeURIComponent(bracket.id)}`;
}
