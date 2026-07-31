// ─────────────────────────────────────────────────────────────────────────────
// components/hextech/mystats/profileModel.ts — pure display shaping for the
// 2026-07-30 /mystats PROFILE redesign (reference: a TrackDIFF player profile
// the user asked to be matched "pixel by pixel").
//
// JSX-free on purpose, same convention as components/hextech/myStats.ts: this
// repo has no JSX rendering harness (CLAUDE.md, Test conventions), so anything
// worth testing has to live in a .ts module and be imported by the .tsx.
//
// ── THE RULE THIS FILE EXISTS TO ENFORCE ────────────────────────────────────
// The reference screenshot carries roughly a dozen figures CoachBuild does not
// hold and in several cases never will: a proprietary composite "Avg Score",
// MVP/ACE counts, per-match placement, "Avg Game ELO", PRO status, country,
// social links, Decay and VODs. HARD RULE 4 (CLAUDE.md) — no fabricated data.
//
// So every slot below is one of exactly two things, and never a third:
//   1. REAL — computed from data the pipeline actually stores. As of engy's
//      2026-07-30 ship (HANDOFF-engy.md §1) that now includes per-champion and
//      per-game CS/min and per-account tier/division/LP. Every one of those is
//      nullable, and a null renders as an em dash with an honest label — never
//      as a plausible-looking placeholder number.
//   2. DROPPED — absent from this model entirely. If it is not in a type here,
//      it cannot be rendered, which is the point.
// A `0` is a real value for most of these fields, so absence is `null`
// throughout and is never coerced — the same null/0 discipline the rest of
// this feature already runs on (see myStats.ts's `numOrNull`).
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountSummary } from "@/components/live/mystatsAccount";
import {
  MYSTATS_LOW_SAMPLE_THRESHOLD,
  myStatsRoleLabel,
  type IconLookup,
  type MyStatsChampionRow,
} from "@/components/hextech/myStats";

// ── Tab strip ───────────────────────────────────────────────────────────────
//
// The reference strip is `Accounts · Live Game · Decay · Match History · VODs`.
// THREE of those five lead nowhere here, and a greyed-out tab is a promise, so
// all three are omitted rather than disabled:
//
//   · Decay — LoL rank decay is a function of tier plus days-since-last-ranked-
//     game at Diamond+, plus the banked-decay-games counter. We now have the
//     tier (engy §1a) but nothing has ever fetched the decay counter — it lives
//     on league-v4 fields this app does not read — and there is no
//     last-ranked-game timestamp distinct from the last stored match. A Decay
//     tab would be a tab onto an empty room.
//   · VODs — no VOD pipeline, no recording, no third-party link source.
//     Nothing to show now, or on any roadmap in this repo.
//   · Live Game — DROPPED after checking what could actually be sourced, which
//     is the part worth recording. `CompanionProvider` (mounted app-wide)
//     exposes exactly three things: `phase`, `champSelect` and
//     `clientConnected`. It does NOT poll the companion's `/live` (allgamedata)
//     endpoint at all — `getLive` exists in companionClient.ts but nothing
//     subscribes to it — so a live scoreboard would mean standing up a new
//     in-game poll, new cadence and all. And the three fields that ARE
//     available already have a home: the global TopBar renders a live
//     champ-select chip on EVERY route, so this tab could only restate a chip
//     the user is already looking at. A tab whose whole content is "your client
//     is in champ select" is the mostly-empty tab the brief rules out.
//     The live state that is real still shows — as the red ring on the hero
//     portrait (isLiveGamePhase above), which is where the reference puts it.
//
// What remains are two tabs, both leading to genuinely populated sections.

/**
 * Is the League client actually IN a game right now?
 *
 * The reference's red `LIVE` ring is the one piece of live state on that hero
 * we can honestly reproduce, because `CompanionProvider` already polls the LCU
 * gameflow phase app-wide (the same poll the global TopBar's champ-select chip
 * reads) — so this costs no new request and no new companion endpoint.
 *
 * Only the two phases where a game is genuinely running count. `ChampSelect` is
 * deliberately NOT live: a red LIVE badge during picks would be wrong for the
 * several minutes before the game starts, and champ select has its own
 * treatment in the global TopBar already. `WaitingForStats`/`EndOfGame` are the
 * post-game screens — the game is over.
 *
 * A null phase (no companion, companion running but League closed, a failed
 * poll) is NOT live. This never guesses a live state from silence.
 */
export function isLiveGamePhase(phase: string | null | undefined): boolean {
  return phase === "InProgress" || phase === "GameStart";
}

export type ProfileTabId = "accounts" | "history";

export interface ProfileTab {
  value: ProfileTabId;
  label: string;
}

/**
 * The tab strip, in reference order minus the two tabs with nothing behind
 * them. Every tab here leads to a section that renders real content or an
 * honest empty state.
 *
 * Shaped as `{ value, label }` so it feeds `components/hextech/HextechTabs`
 * directly — that component already implements the ARIA Tabs keyboard contract
 * (roving tabindex, arrows, Home/End) and the gold-underline treatment the
 * reference's active tab uses, so this strip inherits both rather than
 * hand-rolling a second tab primitive.
 *
 * `Accounts` holds the reference's visible state — the account card grid, the
 * most-played strip and the two-column lower section — so that composition stays
 * intact rather than being split across tabs. `Match History` holds the deeper
 * drill-downs the reference does not show: the per-game list and the
 * per-champion matchup table this page already had.
 */
export function buildProfileTabs(): ProfileTab[] {
  return [
    { value: "accounts", label: "Accounts" },
    { value: "history", label: "Match History" },
  ];
}

// ── "Most played champions" portrait strip ──────────────────────────────────

export interface MostPlayedChampion {
  championId: number;
  name: string;
  icon: string;
  games: number;
}

/**
 * The row of overlapping circular portraits beside the "Accounts" heading.
 *
 * Collapses across ROLE first. `MyStatsChampionRow[]` is one row per
 * (champion, role) pair, so a champion played mid and top appears twice — and
 * an overlapping portrait strip that showed the same face twice would read as
 * a rendering bug. This is the same summing `computeMainChampion` does for the
 * hero, for the same reason.
 *
 * Ties keep the earlier row: `rows` arrives games-DESC from the server and is
 * never re-sorted here (see buildMyStatsRows' no-re-sort posture), so
 * first-seen is the more-played-recently one.
 */
export function buildMostPlayedStrip(rows: MyStatsChampionRow[], limit = 5): MostPlayedChampion[] {
  const totals = new Map<number, MostPlayedChampion>();
  const order: number[] = [];
  for (const r of rows) {
    const existing = totals.get(r.championId);
    if (existing) {
      existing.games += r.games;
      continue;
    }
    totals.set(r.championId, { championId: r.championId, name: r.name, icon: r.icon, games: r.games });
    order.push(r.championId);
  }
  return order
    .map((id) => totals.get(id)!)
    .sort((a, b) => b.games - a.games || a.championId - b.championId)
    .slice(0, Math.max(0, limit));
}

// ── "Most played champions" performance list (lower-left panel) ─────────────

/**
 * WHAT THE REFERENCE'S CENTRE COLUMN HOLDS, AND WHY OURS HOLDS SOMETHING ELSE.
 *
 * The reference row is: portrait | name + CS/min | KDA + K/D/A | win% + games.
 * That KDA column is per-CHAMPION, and we do not have it. `my_matches` stores
 * kills/deaths/assists per row, but the only aggregate the summary route
 * computes per champion is `summarizeByChampion` (lib/mystats/aggregate.ts),
 * which sums games/wins/lastPlayed and nothing else — so `records[]` reaches
 * this page with no KDA on it at all.
 *
 * The tempting move is to compute it from `recentGames[]`, which DOES carry
 * K/D/A. That would be the v0.73.1 bug again, exactly: `recentGames[]` is a
 * short account-wide window and `records[]` is the season, so a champion's
 * "KDA" would be quoted over a handful of games sitting on the same row as a
 * season win rate over hundreds. Two denominators, one row, no label. Not done.
 *
 * So the centre column is the account's RECORD on that champion — real, already
 * in `records[]`, and the same visual shape as the reference (one large
 * coloured figure over a smaller breakdown). The column is headed so the swap
 * reads as a decision rather than as a mislabelled KDA.
 */
export interface ChampionPerformanceRow {
  championId: number;
  role: number;
  roleLabel: string;
  name: string;
  icon: string;
  games: number;
  wins: number;
  losses: number;
  winrate: number;
  lowSample: boolean;
  /** Time-weighted CS/min for this (champion, role) — engy §1b. null when
   *  `csGames` is 0, rendered as an em dash under an honest label. */
  csPerMin: number | null;
  /** Games actually behind `csPerMin`, ALWAYS <= `games` and routinely much
   *  smaller (pre-ship rows carry no CS; sub-300s games are excluded from every
   *  rate). Carried so the UI can refuse the figure on a thin denominator — see
   *  `csRateIsQuotable`. */
  csGames: number;
}

export function buildChampionPerformanceRows(
  rows: MyStatsChampionRow[],
  limit = 5
): ChampionPerformanceRow[] {
  return rows.slice(0, Math.max(0, limit)).map((r) => ({
    championId: r.championId,
    role: r.role,
    roleLabel: r.roleLabel,
    name: r.name,
    icon: r.icon,
    games: r.games,
    wins: r.wins,
    losses: r.losses,
    winrate: r.winrate,
    lowSample: r.lowSample,
    csPerMin: r.csPerMin,
    csGames: r.csGames,
  }));
}

/**
 * May a CS/min figure be shown at all?
 *
 * engy's §1b is explicit that `csGames` is "frequently smaller" than `games` and
 * that a consumer should "render the denominator, or at least refuse to show
 * csPerMin when csGames is tiny". This is that refusal, in one place.
 *
 * The floor is MYSTATS_LOW_SAMPLE_THRESHOLD rather than a new number of its own:
 * this page already mutes a win rate under that threshold, and having CS/min
 * answer to a different bar would mean two adjacent columns on the same row
 * disagreeing about what counts as enough games. One threshold, one meaning.
 *
 * A quotable rate still renders WITH its denominator — this decides whether the
 * number appears, not whether the sample size does.
 */
export function csRateIsQuotable(csPerMin: number | null, csGames: number): boolean {
  return csPerMin !== null && Number.isFinite(csPerMin) && csGames >= MYSTATS_LOW_SAMPLE_THRESHOLD;
}

/**
 * The CS tile's denominator caption (2026-07-31 audit P2 re-score follow-up).
 *
 * "only Ng with CS" is a claim that CS is MISSING for some games — it must
 * only appear when `csGames` is a genuine subset of the games actually
 * played this split (`totalSplitGames`, e.g. `computeMyStatsOverall(records).games`,
 * NOT the capped 20-game display window `games.length`/`chips.n` — a split
 * can hold more games than the window shows). When every game this split
 * already carries CS (`csGames >= totalSplitGames`), "only" is simply false —
 * the real reason the rate is withheld (when it is) is too FEW games overall,
 * not missing data, so the caption drops the qualifier entirely rather than
 * implying a coverage gap that doesn't exist. Bug seen live: an account with
 * exactly 2 games this split, both carrying CS, read "only 2g with CS" —
 * "only" out of what, when 2 IS the whole split?
 */
export function formatCsNote(csGames: number, totalSplitGames: number): string {
  if (csGames <= 0) return "no CS recorded";
  if (csGames < totalSplitGames) return `only ${csGames}g with CS`;
  return `${csGames}g this split`;
}

// ── Account cards ───────────────────────────────────────────────────────────

/**
 * WHAT THE GRID DOES WITH TWO ACCOUNTS, since that is what this install has.
 *
 * The reference is a 3x2 grid of six cells: five accounts plus a "Show all
 * accounts" button in the sixth. Rendering two cards and four holes would read
 * as a broken layout, and stretching two cards across three columns would read
 * as a different component at every account count.
 *
 * So: the grid is `1 / 2 / 3` columns by breakpoint and the cards flow. With
 * two accounts plus the trailing action cell that is exactly one full row of
 * three at `lg` — deliberate, not a gap. The action cell is the sixth-slot
 * affordance from the reference and it is always present, which is also what
 * keeps the row full at 2 accounts.
 *
 * `Show all accounts` only appears once there is something hidden: above
 * `PROFILE_ACCOUNT_CARD_LIMIT` the list truncates and the action cell becomes
 * the reference's "Show all accounts". At or below it, every account is already
 * on screen, so a "show all" would be a button that does nothing — the cell is
 * the LINK-another-account affordance instead, which is a real flow (the
 * detection + secret path in AccountPicker).
 */
export const PROFILE_ACCOUNT_CARD_LIMIT = 5;

export interface AccountCard {
  id: number;
  /** "MunsterHunter" — the part rendered at full contrast. */
  gameName: string;
  /** "EUW" — rendered muted, with the "#" separator, per the reference. */
  tagLine: string;
  riotId: string;
  region: string;
  active: boolean;
  /** Solo-queue games stored for this account, ACCOUNT-WIDE across splits —
   *  a different denominator from the current-split figures elsewhere on the
   *  page. The card labels it as stored games for exactly that reason; the two
   *  numbers legitimately differ and neither is wrong. Since the 2026-07-30
   *  solo-queue-only filter this excludes flex/normal/other entirely, which moved
   *  it materially on at least one live account. */
  games: number;
  /** The account's ranked solo/duo standing, already reduced to what the card
   *  should print — see `formatRank`, which is the ONLY place the
   *  unranked-vs-unknown discriminator is interpreted. */
  rank: RankDisplay;
  /** The account's own win rate over its own stored games — see
   *  `resolveAccountWinrate`. `pct` is null whenever it cannot be quoted
   *  honestly, and the card prints an em dash for that. */
  record: AccountRecord;
}

// ── Per-account win rate ────────────────────────────────────────────────────

/**
 * What the card can honestly print for one account's record.
 *
 * `pct` is a FRACTION (0-1), matching `records[].winrate`, or null. Null is the
 * normal state, not an error: it means either the response did not carry a win
 * rate for this account, or the denominator is too small to quote.
 */
export interface AccountRecord {
  /** 0-1, or null when it cannot be quoted. */
  pct: number | null;
  /** Games behind `pct`. 0 whenever `pct` is null. */
  games: number;
  /** Wins, when the wire gave a count rather than only a rate. Null otherwise —
   *  it is never back-derived from `pct * games`, which would print a rounded
   *  fiction as a W-L. */
  wins: number | null;
  /** Below MYSTATS_LOW_SAMPLE_THRESHOLD games. Quotable, but the card must not
   *  colour it as if it were a verdict. */
  lowSample: boolean;
  /** Hover/assistive text stating the denominator, or why there is no figure. */
  title: string;
}

/**
 * ONE place decides what an account's win rate is, from a wire shape that is
 * deliberately not assumed.
 *
 * The precedence is `wins` (a count) FIRST, then `winrate`/`winRate` (a 0-1
 * fraction), and the order is not arbitrary: a count carries its own units, so
 * it cannot be misread, and it also yields the real W-L for the tooltip. A
 * fraction can be confused with a percentage, so it is accepted ONLY inside
 * [0,1]; a `50` arriving in a field named `winrate` resolves to null rather than
 * being divided by 100 on a hunch. A wrong number rendered confidently is worse
 * than an em dash — this page has shipped that bug (a live game printed under
 * the wrong account's name, v0.84.3) and it is what the em dash is for.
 *
 * `games` is the account's own stored-game count, so this figure is per-account
 * by construction. It is NOT the current-split denominator the season figures
 * use; the card's tooltip says which one it is.
 */
export function resolveAccountWinrate(a: {
  games?: number | null;
  wins?: number | null;
  winrate?: number | null;
  winRate?: number | null;
}): AccountRecord {
  const games = typeof a.games === "number" && Number.isFinite(a.games) && a.games > 0 ? Math.floor(a.games) : 0;
  const absent: AccountRecord = {
    pct: null,
    games: 0,
    wins: null,
    lowSample: false,
    title: "No win rate has been reported for this account yet.",
  };
  if (games === 0) return absent;

  const wins = typeof a.wins === "number" && Number.isFinite(a.wins) && a.wins >= 0 ? Math.floor(a.wins) : null;
  if (wins !== null && wins <= games) {
    return {
      pct: wins / games,
      games,
      wins,
      lowSample: games < MYSTATS_LOW_SAMPLE_THRESHOLD,
      title:
        `${wins}W ${games - wins}L over the ${games} games stored for this account` +
        (games < MYSTATS_LOW_SAMPLE_THRESHOLD ? " — too few to read much into." : "."),
    };
  }

  const raw = [a.winrate, a.winRate].find((v) => typeof v === "number" && Number.isFinite(v)) as number | undefined;
  if (raw === undefined || raw < 0 || raw > 1) return absent;
  return {
    pct: raw,
    games,
    wins: null,
    lowSample: games < MYSTATS_LOW_SAMPLE_THRESHOLD,
    title:
      `Win rate over the ${games} games stored for this account` +
      (games < MYSTATS_LOW_SAMPLE_THRESHOLD ? " — too few to read much into." : "."),
  };
}

// ── Ranked standing ─────────────────────────────────────────────────────────

/**
 * THE THREE STATES A RANK CAN BE IN, collapsed once so no component has to
 * re-derive them (which is how two surfaces eventually disagree).
 *
 * engy §1a ships SEVEN fields for this and the discriminator is `rankUnknown`,
 * not a null tier:
 *   · `rankUnknown: true`  -> we have never successfully read this account's
 *     rank. Every other field is null and means NOTHING. This is NOT "unranked".
 *     It happens routinely: a Riot call is only ever spent on the ACTIVE
 *     account, so a linked-but-inactive account is normally unknown.
 *   · `rankUnknown: false` + `tier: null` -> we looked, and this account has no
 *     ranked standing. Genuinely unranked.
 *   · `rankUnknown: false` + a tier -> the real thing.
 * Collapsing the first two into one blank badge is the confidently-wrong-blank
 * engy added the flag to prevent, so they render as visibly different states.
 */
export type RankDisplayState = "unknown" | "unranked" | "ranked";

export interface RankDisplay {
  state: RankDisplayState;
  /** "Emerald II" / "Challenger" / "Unranked" / "Rank not synced". Always a
   *  real sentence — never an empty string, so a badge is never blank. */
  label: string;
  /** "47 LP", or null when there is no LP to show. Kept apart from `label` so
   *  the two can be typeset differently, per the reference. */
  lp: string | null;
  /** Ranked W-L for the split, or null. */
  record: string | null;
  /** Hover/assistive text saying what state this is and, where relevant, when
   *  it was last read. */
  title: string;
}

/** Riot sends division "I" for these three, where it means nothing — the
 *  reference does not print it there either, and neither do we. */
const APEX_TIERS = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

/** "EMERALD" -> "Emerald". Riot spells tiers in caps; the reference title-cases
 *  them beside the emblem. */
function titleCaseTier(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
}

export interface RankInput {
  tier: string | null;
  division: string | null;
  lp: number | null;
  rankWins: number | null;
  rankLosses: number | null;
  rankUnknown: boolean;
  rankCheckedAt: string | null;
}

export function formatRank(input: RankInput): RankDisplay {
  if (input.rankUnknown) {
    return {
      state: "unknown",
      label: "Rank not synced",
      lp: null,
      record: null,
      title:
        "This account's ranked standing has not been read yet. A rank is only fetched for the account " +
        "that is currently active, so a linked account you have not switched to will sit here. " +
        "This is not the same as being unranked.",
    };
  }
  if (input.tier === null) {
    return {
      state: "unranked",
      label: "Unranked",
      lp: null,
      record: null,
      title: input.rankCheckedAt
        ? `No ranked solo/duo standing when this was last checked (${input.rankCheckedAt}). Placements may be unfinished.`
        : "No ranked solo/duo standing — placements may be unfinished.",
    };
  }
  const tier = input.tier.toUpperCase();
  const showDivision = !APEX_TIERS.has(tier) && input.division !== null && input.division.length > 0;
  const label = showDivision ? `${titleCaseTier(tier)} ${input.division}` : titleCaseTier(tier);
  const hasRecord = input.rankWins !== null && input.rankLosses !== null;
  return {
    state: "ranked",
    label,
    lp: input.lp === null ? null : `${input.lp} LP`,
    record: hasRecord ? `${input.rankWins}W ${input.rankLosses}L` : null,
    title: input.rankCheckedAt
      ? `Ranked solo/duo. Last read from Riot at ${input.rankCheckedAt}.`
      : "Ranked solo/duo.",
  };
}

export interface AccountCardGridModel {
  cards: AccountCard[];
  /** Accounts NOT rendered because the list is truncated. 0 = nothing hidden. */
  hiddenCount: number;
  /** What the trailing cell should offer — see PROFILE_ACCOUNT_CARD_LIMIT. */
  action: "show-all" | "link-another";
}

export function buildAccountCards(
  accounts: AccountSummary[],
  opts: { expanded?: boolean; limit?: number } = {}
): AccountCardGridModel {
  const limit = opts.limit ?? PROFILE_ACCOUNT_CARD_LIMIT;
  const expanded = opts.expanded === true;
  const truncated = !expanded && accounts.length > limit;
  const visible = truncated ? accounts.slice(0, limit) : accounts;
  return {
    cards: visible.map((a) => ({
      id: a.id,
      gameName: a.gameName || a.riotId.split("#")[0] || a.riotId,
      tagLine: a.tagLine || a.riotId.split("#")[1] || "",
      riotId: a.riotId,
      region: a.region,
      active: a.active,
      games: a.games,
      rank: formatRank(a),
      record: resolveAccountWinrate(a),
    })),
    hiddenCount: truncated ? accounts.length - limit : 0,
    action: accounts.length > limit ? "show-all" : "link-another",
  };
}

// ── "Last Active" ───────────────────────────────────────────────────────────

/**
 * The newest `lastPlayed` across every (champion, role) record — i.e. the most
 * recent game we have STORED, which is what the reference's "Last Active"
 * position holds.
 *
 * Returns null on an empty pool or when no record carries a parseable
 * timestamp. It deliberately does not fall back to "now" or to the account's
 * `lastSeenAt` (which is when the COMPANION last saw the client logged in — a
 * different fact, and quoting it under "last active" would be a quiet lie on
 * any account that opens the client without queueing).
 */
export function computeLastActiveMs(records: { lastPlayed: string }[]): number | null {
  let best: number | null = null;
  for (const r of records) {
    const t = Date.parse(r.lastPlayed);
    if (!Number.isFinite(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best;
}

/**
 * "33 minutes ago". Coarse on purpose — this is a freshness cue, not a clock,
 * and second-level precision on a value that only changes when an ingest runs
 * would imply a liveness the pipeline does not have.
 *
 * A future timestamp (clock skew between the browser and Riot's gameCreation)
 * reads as "just now" rather than "in 4 minutes", which would look like a bug.
 * Null in, null out — the caller renders nothing rather than "never".
 */
export function formatRelativeTime(ms: number | null, nowMs: number): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const diff = nowMs - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

// ── Match-performance chip cluster ──────────────────────────────────────────

/**
 * The right-hand chip cluster in the reference reads
 * `rank · LP · Win:12 / Lose:8 / MVP:3 / ACE:0`.
 *
 * MVP and ACE are op.gg/TrackDIFF-side derived awards computed from a full
 * per-game scoreboard (every participant's damage, gold, KP and objective
 * contribution). `my_matches` stores champion ids and a win flag for the other
 * nine participants and nothing else — a deliberate privacy posture, see
 * migration 0012's header — so those two awards are not merely missing, they
 * are uncomputable without changing what this app is willing to store about
 * other players. They are DROPPED, not stubbed.
 *
 * Win/Lose over the shown window is real and stays, and `rank` is real as of
 * engy §1a — but note the two are over DIFFERENT windows and are labelled that
 * way: the W-L counts are over the games shown in this panel, while the ranked
 * record inside `rank` is Riot's own split-long solo-queue tally.
 */
export interface MatchPerformanceChips {
  wins: number;
  losses: number;
  /** Exact size of the window the counts were taken over — never rendered
   *  without it, same rule as computeRecentWinLoss's `n`. */
  n: number;
  lowSample: boolean;
  rank: RankDisplay;
}

export function buildMatchPerformanceChips(
  games: { win: boolean }[],
  rank: RankInput
): MatchPerformanceChips {
  const n = games.length;
  const wins = games.filter((g) => g.win).length;
  return {
    wins,
    losses: n - wins,
    n,
    lowSample: n < MYSTATS_LOW_SAMPLE_THRESHOLD,
    rank: formatRank(rank),
  };
}

// ── Small shared formatters ─────────────────────────────────────────────────

/** One decimal, always — "52.6%". A percentage on this page never renders
 *  without the sample beside it, but that is the caller's job; this only
 *  guarantees the digits are consistent across every surface. */
export function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** CS/min renders to ONE decimal ("7.4"), the convention every LoL stats site
 *  uses. Null in -> null out; the caller renders an em dash. Never "0.0". */
export function formatCsPerMin(v: number | null): string | null {
  return v === null || !Number.isFinite(v) ? null : v.toFixed(1);
}

/** Region as the reference's small uppercase chip. Empty/absent region yields
 *  null so the chip is omitted rather than rendering an empty box. */
export function formatRegionChip(region: string): string | null {
  const r = region.trim().toUpperCase();
  return r.length > 0 ? r : null;
}

export { myStatsRoleLabel, type IconLookup };
