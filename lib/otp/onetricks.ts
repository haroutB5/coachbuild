// lib/otp/onetricks.ts - parse the source page and choose the featured account.
//
// onetricks.gg supplies the champion share and its OTP marker. The active
// otp_accounts roster supplies career champion volume, wins, and the op.gg
// leaderboard standing. Both positions are standing signals: the roster rank
// is the requested live ladder fact, while the source rank prevents a player
// with a poor OTP-source standing from winning on one op.gg snapshot alone.

/** One row of the champion ranking, reduced to the fields the app uses. */
export interface OneTrickRow {
  /** Position in the source site's list, 1-based. */
  rank: number;
  /** e.g. "Challenger", "Grandmaster", "Master". */
  tier: string;
  /** Riot ID name. May contain spaces ("Tears of Winter"). */
  gameName: string;
  /** Riot ID tag. May contain spaces ("0 1" is real source data). */
  tagLine: string;
  /** Platform label as shown, e.g. "EUW1", "NA1", "KR". */
  server: string;
  lp: number;
  /** Share of this account's games that are on this champion, 0-100. */
  championSharePct: number;
  /** Games on this champion according to the source page. */
  games: number;
  /** Winrate on this champion according to the source page, 0-100. */
  winratePct: number;
  /** e.g. 2.93 from "2.93:1". */
  kda: number;
  /** The site's own one-trick marker. */
  isOtp: boolean;
}

/**
 * A parsed source row enriched with active otp_accounts facts. The enrichment
 * is optional so parser-only callers and old captures still work; the scorer
 * falls back to the source row when no matching roster account is available.
 */
export interface FeaturedOtpCandidate extends OneTrickRow {
  puuid?: string | null;
  /** Career games on the champion (otp_accounts.champ_play). */
  championPlays?: number;
  /** Career wins on the champion (otp_accounts.champ_win). */
  championWins?: number;
  /** Current roster standing (otp_accounts.leaderboard_rank). */
  leaderboardRank?: number;
}

/**
 * Relative hysteresis margin. The incumbent keeps its slot unless a challenger
 * beats its score by more than this fraction; this suppresses refresh churn
 * without blocking a real takeover.
 */
export const FEATURED_FLIP_MARGIN = 0.10;

/** Prior strength for empirical-Bayes winrate shrinkage. */
export const WINRATE_PRIOR_GAMES = 200;

/** Winrate is deliberately only a small adjustment to dedication signals. */
export const FEATURED_WINRATE_WEIGHT = 0.20;

/** Rank remains primary, but the square-root dampens rank-one outliers. */
export const FEATURED_RANK_POWER = 0.5;

/** The source ladder is also a standing signal; keep it sub-linear. */
export const FEATURED_SOURCE_RANK_POWER = 0.8;

/**
 * Minimum games on the champion before an account can be featured.
 *
 * 150 is a user directive from 2026-07-29. It keeps a hot streak such as 117
 * games from replacing a deeper, more representative one-trick sample.
 */
export const MIN_CHAMPION_GAMES = 150;

/**
 * One ranking row as rendered text, e.g.
 *   `2 Challenger Dun #NA1 NA1: 2316 LP 67% 627 60% 2.93:1 OTP`
 *
 * Both name and tag can contain spaces, so the tag is matched non-greedily and
 * anchored by the server label that follows it.
 */
const ROW =
  /^(\d+)\s+([A-Za-z]+)\s+(.+?)\s+#(.+?)\s+([A-Za-z]{2,4}\d?):\s*(\d+)\s*LP\s+(\d+)%\s+(\d+)\s+(\d+)%\s+([\d.]+):1(\s+OTP)?\s*$/;

function num(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse rendered ranking rows. Unparseable rows are dropped silently - the
 * caller gets fewer candidates, never a guessed identity or statistic.
 */
export function parseOneTricksRows(lines: readonly string[]): OneTrickRow[] {
  const out: OneTrickRow[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const m = ROW.exec(line.trim());
    if (!m) continue;

    const rank = num(m[1]);
    const lp = num(m[6]);
    const share = num(m[7]);
    const games = num(m[8]);
    const wr = num(m[9]);
    const kda = num(m[10]);
    const gameName = m[3].trim();
    const tagLine = m[4].trim();
    if (rank == null || lp == null || share == null || games == null || wr == null || kda == null) continue;
    if (!gameName || !tagLine) continue;

    out.push({
      rank,
      tier: m[2],
      gameName,
      tagLine,
      server: m[5],
      lp,
      championSharePct: share,
      games,
      winratePct: wr,
      kda,
      isOtp: Boolean(m[11]),
    });
  }
  return out;
}

interface NormalizedFeaturedOtpCandidate extends FeaturedOtpCandidate {
  championPlays: number;
  championWins: number;
  leaderboardRank: number;
}

export interface FeaturedOtpScore {
  score: number;
  /** Natural-log career games term. */
  dedication: number;
  /** Share term, with a non-zero floor so low share is not free. */
  shareFactor: number;
  /** Combined lower-is-better roster and source ladder factors. */
  ladderFactor: number;
  /** Candidate-pool mean used as the Bayesian prior, in percent. */
  poolMeanWinratePct: number;
  /** Shrunk candidate winrate, in percent. */
  shrunkWinratePct: number;
  /** Small multiplicative adjustment derived from the shrunk winrate. */
  winrateFactor: number;
}

export interface FeaturedOtpRankingEntry extends FeaturedOtpScore {
  candidate: FeaturedOtpCandidate;
}

export interface FeaturedOtpSelectionOptions {
  /** PUUID or Riot ID of the row currently stored in otp_featured. */
  incumbentKey?: string | null;
}

export interface FeaturedOtpSelection extends FeaturedOtpRankingEntry {
  reason: "argmax" | "challenger-margin" | "incumbent-hysteresis";
}

function clampPct(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, value));
}

function positiveNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeCandidate(row: FeaturedOtpCandidate): NormalizedFeaturedOtpCandidate {
  const championPlays = positiveNumber(row.championPlays, row.games);
  const fallbackWins = championPlays * clampPct(Number(row.winratePct)) / 100;
  const rawWins = Number(row.championWins);
  const championWins = Number.isFinite(rawWins)
    ? Math.min(championPlays, Math.max(0, rawWins))
    : fallbackWins;
  return {
    ...row,
    championPlays,
    championWins,
    leaderboardRank: Math.max(1, Math.floor(positiveNumber(row.leaderboardRank, row.rank))),
    championSharePct: clampPct(Number(row.championSharePct)),
  };
}

function candidateWinrate(candidate: NormalizedFeaturedOtpCandidate): number {
  return candidate.championWins / candidate.championPlays;
}

function candidatePoolMean(candidates: readonly NormalizedFeaturedOtpCandidate[]): number {
  const totalPlays = candidates.reduce((sum, c) => sum + c.championPlays, 0);
  if (totalPlays <= 0) return 0.5;
  const totalWins = candidates.reduce((sum, c) => sum + c.championWins, 0);
  return totalWins / totalPlays;
}

/** Stable identity used to compare a candidate to the otp_featured row. */
export function featuredCandidateKey(
  candidate: Pick<FeaturedOtpCandidate, "puuid" | "gameName" | "tagLine">
): string {
  return (candidate.puuid?.trim() || riotId(candidate)).trim().toLowerCase();
}

/**
 * Score one candidate. Career games are log-scaled, share and ladder standing
 * are the primary multiplicative signals, and winrate is shrunk to the pool
 * mean before receiving only a small adjustment.
 */
export function scoreFeaturedOtpCandidate(
  row: FeaturedOtpCandidate,
  poolMeanWinratePct?: number
): FeaturedOtpScore {
  const candidate = normalizeCandidate(row);
  const poolMean =
    typeof poolMeanWinratePct === "number" && Number.isFinite(poolMeanWinratePct)
      ? clampPct(poolMeanWinratePct)
      : candidateWinrate(candidate) * 100;
  const priorWins = WINRATE_PRIOR_GAMES * poolMean / 100;
  const shrunkWinratePct =
    ((candidate.championWins + priorWins) / (candidate.championPlays + WINRATE_PRIOR_GAMES)) * 100;
  const winrateFactor =
    1 + FEATURED_WINRATE_WEIGHT * ((shrunkWinratePct - poolMean) / 100);
  const dedication = Math.log1p(candidate.championPlays);
  const shareFactor = 0.5 + candidate.championSharePct / 100;
  const rosterLadderFactor = 1 / Math.pow(candidate.leaderboardRank, FEATURED_RANK_POWER);
  const sourceLadderFactor = 1 / Math.pow(Math.max(1, candidate.rank), FEATURED_SOURCE_RANK_POWER);
  const ladderFactor = rosterLadderFactor * sourceLadderFactor;

  return {
    score: dedication * shareFactor * ladderFactor * winrateFactor,
    dedication,
    shareFactor,
    ladderFactor,
    poolMeanWinratePct: poolMean,
    shrunkWinratePct,
    winrateFactor,
  };
}

/** Rank eligible candidates without applying incumbent hysteresis. */
export function rankFeaturedOtpCandidates(
  rows: readonly FeaturedOtpCandidate[]
): FeaturedOtpRankingEntry[] {
  const eligible = rows
    .map(normalizeCandidate)
    .filter((candidate) => candidate.isOtp && candidate.championPlays >= MIN_CHAMPION_GAMES);
  if (eligible.length === 0) return [];

  const poolMean = candidatePoolMean(eligible);
  return eligible
    .map((candidate) => ({
      candidate,
      ...scoreFeaturedOtpCandidate(candidate, poolMean * 100),
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.championPlays! - a.candidate.championPlays! ||
        a.candidate.leaderboardRank! - b.candidate.leaderboardRank! ||
        riotId(a.candidate).localeCompare(riotId(b.candidate))
    );
}

/**
 * Select the account for a refresh. A missing incumbent uses plain argmax;
 * when the incumbent is present, a challenger must clear the relative margin
 * before the slot changes.
 */
export function selectFeaturedOneTrick(
  rows: readonly FeaturedOtpCandidate[],
  opts: FeaturedOtpSelectionOptions = {}
): FeaturedOtpSelection | null {
  const ranked = rankFeaturedOtpCandidates(rows);
  const top = ranked[0];
  if (!top) return null;

  const incumbentKey = opts.incumbentKey?.trim().toLowerCase();
  if (!incumbentKey) return { ...top, reason: "argmax" };

  const incumbent = ranked.find((entry) => featuredCandidateKey(entry.candidate) === incumbentKey);
  if (!incumbent || featuredCandidateKey(incumbent.candidate) === featuredCandidateKey(top.candidate)) {
    return { ...top, reason: "argmax" };
  }

  if (top.score > incumbent.score * (1 + FEATURED_FLIP_MARGIN)) {
    return { ...top, reason: "challenger-margin" };
  }
  return { ...incumbent, reason: "incumbent-hysteresis" };
}

/** Backward-compatible convenience wrapper for parser callers. */
export function pickFeaturedOneTrick(
  rows: readonly FeaturedOtpCandidate[],
  opts: FeaturedOtpSelectionOptions = {}
): FeaturedOtpCandidate | null {
  return selectFeaturedOneTrick(rows, opts)?.candidate ?? null;
}

/** `Dun#NA1` - the form Riot's account-v1 by-riot-id takes. */
export function riotId(row: Pick<OneTrickRow, "gameName" | "tagLine">): string {
  return `${row.gameName}#${row.tagLine}`;
}
