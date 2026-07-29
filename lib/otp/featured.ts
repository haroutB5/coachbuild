// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/featured.ts — turning "this is the account" into "these are their
// builds".
//
// Two jobs, both of which have a trap in them that cost real time on 2026-07-29:
//
//   1. RESOLVE. onetricks.gg gives a Riot ID, not a Riot puuid — the id in its
//      URLs is site-scoped and Riot answers "Bad Request - Exception decrypting"
//      for it, exactly like op.gg's. So the name+tag goes through account-v1.
//
//   2. FIND WHERE THEY PLAY. The server label on the leaderboard is where the
//      account is LISTED, not necessarily where its matches are. Phanta #107
//      resolves through the americas routing and has ZERO matches there; their
//      games are on europe. A single-routing lookup reports an empty history and
//      looks exactly like an inactive account. So we probe, then remember the
//      answer in otp_featured.match_routing.
//
// Build rates are computed over the account's OWN games only. That is the whole
// point of the feature: an average over eight one-tricks is a build nobody
// plays, whereas one player's spread is something you can copy — including the
// fact that they build a given item in 6 games out of 10 and not always.
// ─────────────────────────────────────────────────────────────────────────────

import { getAccountByRiotId, getMatchIdsByPuuid } from "../pro/riot";

/** Riot regional routings, in the order worth trying. */
export const ROUTINGS = ["europe", "americas", "asia"] as const;
export type Routing = (typeof ROUTINGS)[number];

export interface ResolvedAccount {
  puuid: string;
  gameName: string;
  tagLine: string;
  /** Where this account's matches actually live. */
  matchRouting: Routing;
}

/**
 * Riot ID -> puuid + the routing that actually has their matches.
 *
 * account-v1 is global: any routing answers for any account, so the first 200
 * wins and tells us nothing about where they play. match-v5 is NOT global, so
 * the routing is found by asking each for a single match id and taking the
 * first that returns one.
 *
 * Returns null when the account does not exist, or exists but has no recent
 * ranked-solo games anywhere. Both are "no featured card", never a guess.
 */
export async function resolveFeaturedAccount(
  gameName: string,
  tagLine: string,
  log: (msg: string) => void = () => {}
): Promise<ResolvedAccount | null> {
  let puuid: string | null = null;
  for (const routing of ROUTINGS) {
    try {
      const acct = await getAccountByRiotId(routing, gameName, tagLine);
      if (acct?.puuid) {
        puuid = acct.puuid;
        break;
      }
    } catch {
      // Try the next routing — account-v1 is global, so a failure here is
      // transport noise rather than "no such account".
    }
  }
  if (!puuid) {
    log(`${gameName}#${tagLine}: account-v1 found nothing on any routing`);
    return null;
  }

  // An ERROR and an EMPTY LIST are not the same answer, and conflating them is
  // how a third of a backfill vanished on 2026-07-29: under rate limiting every
  // probe threw, the catch moved on, and the account was written off as having
  // no games. Both accounts checked afterwards had plenty — aa5a#aaa on asia,
  // Barsas#BRAND on europe, which is the FIRST routing tried.
  //
  // So: only conclude "no matches anywhere" when every routing answered
  // CLEANLY with an empty list. If any probe errored, say so and return null
  // with a different message, so the champion is retried on the next pass
  // instead of being silently skipped forever.
  let cleanEmpty = 0;
  let lastError: unknown = null;
  for (const routing of ROUTINGS) {
    try {
      const ids = await getMatchIdsByPuuid(routing, puuid, { queue: 420, start: 0, count: 1 });
      if (ids.length > 0) return { puuid, gameName, tagLine, matchRouting: routing };
      cleanEmpty += 1;
    } catch (err) {
      lastError = err;
    }
  }

  if (cleanEmpty === ROUTINGS.length) {
    log(`${gameName}#${tagLine}: resolved, but no ranked-solo matches on any routing`);
  } else {
    log(
      `${gameName}#${tagLine}: routing probe INCONCLUSIVE — ${cleanEmpty}/${ROUTINGS.length} answered, ` +
        `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}. Will retry.`
    );
  }
  return null;
}

// ── Build rates ──────────────────────────────────────────────────────────────

/** One item and how often this player finishes a game holding it. */
export interface ItemBuildRate {
  itemId: number;
  /** Games this item was in their final inventory. */
  games: number;
  /** 0-100, share of the player's games on this champion. */
  pct: number;
}

export interface FeaturedBuildModel {
  /** Games the rates are computed over. The honest denominator. */
  games: number;
  wins: number;
  /** Every completed item they build, most-built first. Boots included —
   *  which boot a one-trick picks is a real decision, not chrome. */
  items: ItemBuildRate[];
  /** PER-GAME final inventories, one entry per row, deduplicated within a game
   *  and in stored (inventory-slot) order.
   *
   *  `items` above is a per-item aggregate and cannot answer "which SIX did
   *  they finish a game holding TOGETHER" — that question needs the games
   *  themselves, and it is what the featured card's full-build slot rests on
   *  (2026-07-29 user directive: "show at least one FULL build... make the
   *  build make sense"). Assembling a build from per-item rates instead would
   *  be a synthesis, possibly a combination nobody ever played, which is a
   *  claim this data does not support without saying so. So the raw sets
   *  travel, and `lib/otp/featuredBuild.ts` decides — with the item metadata
   *  the client holds and the server does not — whether an exact repeated set
   *  exists or a labelled synthesis is the honest answer.
   *
   *  UNFILTERED beyond `keepItem`, same contract as `items`: this function
   *  counts, it does not classify. Rows whose payload was malformed contribute
   *  an empty array rather than vanishing, so index alignment with the row
   *  list is preserved and `games` stays the denominator for everything. */
  gameItems: number[][];
  /** The rune page they run most often, with how often. Null when their pages
   *  are too scattered to have a modal one. */
  runes: { page: RunePage; games: number; pct: number } | null;
  /** Summoner spell pair they run most often. */
  spells: { spells: [number, number]; games: number; pct: number } | null;
}

export interface RunePage {
  primaryTree: number | null;
  keystone: number | null;
  primary: number[];
  secondaryTree: number | null;
  secondary: number[];
  shards: number[];
}

/** A stored otp_matches row, reduced to what the model needs. */
export interface FeaturedMatchRow {
  win: boolean;
  final_items: unknown;
  runes: unknown;
  spells: unknown;
}

function asNumberArray(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && x > 0) : [];
}

/** Stable key for grouping identical rune pages. */
function runeKey(r: RunePage): string {
  return [
    r.primaryTree ?? "-",
    r.keystone ?? "-",
    r.primary.join("."),
    r.secondaryTree ?? "-",
    [...r.secondary].sort((a, b) => a - b).join("."),
    [...r.shards].sort((a, b) => a - b).join("."),
  ].join("|");
}

function toRunePage(v: unknown): RunePage | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const page: RunePage = {
    primaryTree: typeof o.primaryTree === "number" ? o.primaryTree : null,
    keystone: typeof o.keystone === "number" ? o.keystone : null,
    primary: asNumberArray(o.primary),
    secondaryTree: typeof o.secondaryTree === "number" ? o.secondaryTree : null,
    secondary: asNumberArray(o.secondary),
    shards: asNumberArray(o.shards),
  };
  // A page with no keystone AND no tree carries no information — treat it as
  // absent rather than letting empty pages win the modal count by volume.
  if (page.keystone == null && page.primaryTree == null) return null;
  return page;
}

/**
 * Build rates over one player's games.
 *
 * `isFullItem` is intentionally NOT applied here: the caller passes the item
 * metadata filter it wants. This function's job is counting, and counting
 * wrongly because it guessed at item metadata is the failure mode to avoid.
 * Pass `keepItem` to drop components/consumables.
 */
export function buildFeaturedModel(
  rows: readonly FeaturedMatchRow[],
  keepItem: (itemId: number) => boolean = () => true
): FeaturedBuildModel {
  const games = rows.length;
  const itemGames = new Map<number, number>();
  const gameItems: number[][] = [];
  const runeGroups = new Map<string, { page: RunePage; n: number }>();
  const spellGroups = new Map<string, { spells: [number, number]; n: number }>();
  let wins = 0;

  for (const row of rows) {
    if (row.win) wins += 1;

    // Deduplicate within a game: an inventory listing the same id twice is one
    // game that built it, not two.
    const seen = new Set(asNumberArray(row.final_items).filter(keepItem));
    seen.forEach((id) => itemGames.set(id, (itemGames.get(id) ?? 0) + 1));
    // Same Set, so the per-game inventory and the per-item counts can never
    // disagree about what this game built — one dedup, two consumers.
    gameItems.push(Array.from(seen));

    const page = toRunePage(row.runes);
    if (page) {
      const k = runeKey(page);
      const g = runeGroups.get(k);
      if (g) g.n += 1;
      else runeGroups.set(k, { page, n: 1 });
    }

    const sp = asNumberArray(row.spells);
    if (sp.length === 2) {
      const pair: [number, number] = sp[0] <= sp[1] ? [sp[0], sp[1]] : [sp[1], sp[0]];
      const k = pair.join(".");
      const g = spellGroups.get(k);
      if (g) g.n += 1;
      else spellGroups.set(k, { spells: pair, n: 1 });
    }
  }

  const pct = (n: number) => (games > 0 ? Math.round((n / games) * 100) : 0);

  const items = Array.from(itemGames.entries())
    .map(([itemId, n]) => ({ itemId, games: n, pct: pct(n) }))
    .sort((a, b) => b.games - a.games || a.itemId - b.itemId);

  const topRunes = Array.from(runeGroups.values()).sort((a, b) => b.n - a.n)[0] ?? null;
  const topSpells = Array.from(spellGroups.values()).sort((a, b) => b.n - a.n)[0] ?? null;

  return {
    games,
    wins,
    items,
    gameItems,
    runes: topRunes ? { page: topRunes.page, games: topRunes.n, pct: pct(topRunes.n) } : null,
    spells: topSpells ? { spells: topSpells.spells, games: topSpells.n, pct: pct(topSpells.n) } : null,
  };
}
