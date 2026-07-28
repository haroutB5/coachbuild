// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/onetricks.ts — WHICH one-trick we feature, and why that one.
//
// Replaces op.gg's champion leaderboard as the SELECTION source (2026-07-29,
// user directive). op.gg is still fine data, but it answers a different
// question: its "rank 1" is whoever has the most games on the champion, so for
// Viktor it returned a Diamond player while a Challenger sat at rank 2. It also
// only exposes ten players per region, which is why the account the user
// actually wanted for Akshan (Phanta #107) never appeared in it at all.
//
// onetricks.gg publishes the list the user reads, sorted by LP, and — the part
// that matters — it marks which accounts are genuinely ONE-TRICKS rather than
// merely good players who own the champion. That flag is the whole reason the
// two disagreed:
//
//   Viktor  #1 Splash  2486 LP  33% champion share  — NOT flagged OTP
//   Viktor  #2 Dun     2316 LP  67% champion share  — flagged OTP
//
// Ranking by LP alone gives Splash. Ranking by LP among OTP-FLAGGED accounts
// gives Dun, which is the answer the user expects and the more useful one: a
// build from someone who plays this champion two games in three is worth more
// than one from a better player who picks it a third of the time.
//
// ── WHAT THIS MODULE IS NOT ──────────────────────────────────────────────────
// No network. It parses row TEXT and applies the selection rule, nothing more.
// The transport lives in scripts/ingest-otp-featured.mjs because the site
// rate-limits plain fetches (HTTP 429, reproduced repeatedly) and only serves a
// real browser, which belongs in the local ingest and not in the Next app.
// Keeping the rule pure is what makes it unit-testable against captured rows.
//
// ── FAIL TO EMPTY, NEVER TO WRONG ────────────────────────────────────────────
// Same discipline as lib/opgg.ts and lib/otp/leaderboard.ts: a row that does
// not match the expected shape is DROPPED, not guessed at. A missing featured
// player costs us one card. A misparsed one puts a stranger's build in front of
// someone mid-game.
// ─────────────────────────────────────────────────────────────────────────────

/** One row of the champion ranking, reduced to the fields the app uses. */
export interface OneTrickRow {
  /** Position in the site's own list, 1-based. Sorted by LP descending. */
  rank: number;
  /** e.g. "Challenger", "Grandmaster", "Master". */
  tier: string;
  /** Riot ID name. May contain spaces ("Tears of Winter"). */
  gameName: string;
  /** Riot ID tag. May contain spaces — "Splash #0 1" has the tag "0 1". */
  tagLine: string;
  /** Platform label as shown, e.g. "EUW1", "NA1", "KR". */
  server: string;
  lp: number;
  /** Share of this account's games that are on this champion, 0-100. */
  championSharePct: number;
  /** Games on this champion. */
  games: number;
  /** Winrate on this champion, 0-100. */
  winratePct: number;
  /** e.g. 2.93 from "2.93:1". */
  kda: number;
  /** The site's own one-trick marker. Load-bearing — see the module header. */
  isOtp: boolean;
}

/**
 * Minimum games on the champion before an account can be featured.
 *
 * 150, a hard user directive (2026-07-29). It is not arbitrary: the same
 * capture that motivated it has Phantasm #TWTV0 at 2982 LP with a 77% winrate
 * on **117 games** of Akshan, which reads as the best player on the page until
 * you notice the sample. A build derived from a hot streak is worse than no
 * build. The floor also happens to exclude every non-OTP-flagged account in the
 * captured samples, so the two guards agree rather than fight.
 */
export const MIN_CHAMPION_GAMES = 150;

/**
 * One ranking row as rendered text, e.g.
 *   `2 Challenger Dun #NA1 NA1: 2316 LP 67% 627 60% 2.93:1 OTP`
 *
 * Both name and tag can contain spaces, so the tag is matched non-greedily and
 * anchored by the server label that follows it — `Splash #0 1 EUW1:` has to
 * yield tag `0 1` and server `EUW1`, which a greedy match gets wrong.
 */
const ROW =
  /^(\d+)\s+([A-Za-z]+)\s+(.+?)\s+#(.+?)\s+([A-Za-z]{2,4}\d?):\s*(\d+)\s*LP\s+(\d+)%\s+(\d+)\s+(\d+)%\s+([\d.]+):1(\s+OTP)?\s*$/;

function num(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse rendered ranking rows. Unparseable rows are dropped silently — the
 * caller gets fewer candidates, never a wrong one.
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

/**
 * The account to feature: highest LP among rows that are BOTH flagged as
 * one-tricks and past the games floor.
 *
 * LP is re-sorted here rather than trusting the source's order. The site does
 * sort by LP today, but "the list happens to arrive sorted" is not a property
 * worth depending on when the cost of being wrong is featuring the wrong
 * player's build.
 *
 * Returns null when nothing qualifies — a champion with no eligible one-trick
 * simply has no featured card, which is the honest outcome.
 */
export function pickFeaturedOneTrick(rows: readonly OneTrickRow[]): OneTrickRow | null {
  const eligible = rows.filter((r) => r.isOtp && r.games >= MIN_CHAMPION_GAMES);
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => b.lp - a.lp || b.games - a.games || a.rank - b.rank)[0];
}

/** `Dun#NA1` — the form Riot's account-v1 by-riot-id takes. */
export function riotId(row: Pick<OneTrickRow, "gameName" | "tagLine">): string {
  return `${row.gameName}#${row.tagLine}`;
}
