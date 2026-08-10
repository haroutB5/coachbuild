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
import { aggregateRecordedSkillOrders } from "../skillOrderAggregate";
import { primaryMinorRow } from "@/components/hextech/perkSlots";
import type { ChampionKit, SkillOrderModel } from "../types";

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

/** One stored game, reduced to what a build view needs: what they finished it
 *  holding, and whether they won it.
 *
 *  `win` is `boolean | null` and the null is meaningful — it is what a response
 *  body predating this field degrades to, and it must never be defaulted to
 *  `false`. A defaulted `false` would caption a real build "a game they lost",
 *  which is a fabricated fact rather than a missing one (HARD RULE 4). */
export interface FeaturedGame {
  /** Deduplicated final inventory (item0..item5, zeros already stripped at
   *  ingest), in stored inventory-slot order. NOT purchase order — the OTP
   *  pipeline may fetch a capped timeline for skill order, but purchase order
   *  is not stored or rendered here, so this remains final inventory only. */
  items: number[];
  win: boolean | null;
}

export interface FeaturedBuildModel {
  /** Games the rates are computed over. The honest denominator. */
  games: number;
  wins: number;
  /** Every completed item they build, most-built first. Boots included —
   *  which boot a one-trick picks is a real decision, not chrome. */
  items: ItemBuildRate[];
  /** PER-GAME record, one entry per row, NEWEST FIRST (the caller's query
   *  orders by `game_creation DESC`, and the featured card's single-game
   *  tiebreak relies on that order — see lib/otp/featuredBuild.ts).
   *
   *  `items` above is a per-item aggregate and cannot answer "which items did
   *  they finish a game holding TOGETHER" — that question needs the games
   *  themselves, and it is what the featured card's build strip rests on
   *  (2026-07-29 user directive: "show at least one FULL build... make the
   *  build make sense"; extended the same day to "show one real complete
   *  build" once the data proved no complete set repeats). Assembling a build
   *  from per-item rates instead would be a synthesis, possibly a combination
   *  nobody ever played, which is a claim this data does not support. So the
   *  raw games travel, and `lib/otp/featuredBuild.ts` decides — with the item
   *  metadata the client holds and the server does not — whether an exact set
   *  repeats or one real game is the honest answer.
   *
   *  ONE ARRAY OF RECORDS, not two parallel arrays. The inventory and the
   *  outcome are facts about the SAME game, and the card labels a build "a
   *  game they won" off the pair; two arrays would let an ingest change or a
   *  filter desynchronise them silently, and the label would then be a lie
   *  with nothing to catch it. Structural alignment beats a documented one.
   *
   *  UNFILTERED beyond `keepItem`, same contract as `items`: this function
   *  counts, it does not classify. Rows whose payload was malformed contribute
   *  an empty `items` array rather than vanishing, so the entry count still
   *  equals `games` and that stays the denominator for everything. */
  gameLog: FeaturedGame[];
  /** The rune page they run most often, with how often, plus a per-slot count
   *  for every rune ON that page. Null when their pages are too scattered to
   *  have a modal one.
   *
   *  `games`/`pct` describe the EXACT page (all slots identical); `slots`
   *  describes each rune INDIVIDUALLY over its own denominator, so the two
   *  numbers legitimately differ and neither can be read off the other. See
   *  `buildRunePageSamples` for the denominator rule. */
  runes: { page: RunePage; games: number; pct: number; slots: OtpRunePageSamples } | null;
  /** Summoner spell pair they run most often. */
  spells: { spells: [number, number]; games: number; pct: number } | null;
  /** Per-level modal skill order over the games whose stored timeline actually
   *  contains a sequence. Null means no timeline-backed order is recorded yet.
   *  This is real timeline data: no 16-18 completion or inferred tail. */
  skillOrder: SkillOrderModel | null;
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
  /** Nullable in coachbuild.otp_matches. `[]` means a timeline was fetched but
   *  carried no usable level-up events; null means no timeline was recorded. */
  skill_order: unknown;
}

// ── Per-slot rune counts (v0.105.2) ──────────────────────────────────────────
//
// The card used to show ONE figure for the whole page — "12 of 40 stored games
// use this exact page" — repeated under every rune, which reads as a per-rune
// count and is not one. This adds the real thing, on the same honesty terms
// `components/hextech/proConsensus.ts` already holds the PRO side to: every
// slot gets its OWN denominator, and a slot the data cannot speak to renders
// empty rather than borrowing a number from somewhere else.
//
// ── THE RULE, in one line per slot ──────────────────────────────────────────
// Every count below describes the rune the card ACTUALLY DRAWS in that slot —
// the modal exact page's rune. It is never a re-derived per-slot modal, so the
// icon and the number under it can never disagree (each sample carries its
// `runeId` back so the renderer can refuse to print a fraction that belongs to
// a different rune; see components/hextech/otpRunePage.ts).
//
//   keystone      numerator: games on the page's PRIMARY TREE that ran this
//                 keystone. denominator: games on that tree carrying ANY
//                 keystone. (Tree-conditioned because a game on another tree
//                 could not have run this keystone — counting it would inflate
//                 the denominator with games that never had the choice.)
//   primary row r numerator: tree-conditioned games whose minor at POSITION r
//                 is this rune. denominator: tree-conditioned games carrying
//                 any minor at position r. Riot serialises the three primary
//                 selections in row order (lib/pro/extract.ts's extractRunes
//                 keeps that order, and otp_matches rows are all soloq), and
//                 position r is exactly what the card draws in row r — so
//                 counting positionally is what makes the number describe the
//                 icon above it.
//   secondary row conditioned on the page's primary tree AND its secondary
//                 tree. Secondary picks are NOT positional (2 of 3 rows, which
//                 2 varies), so each id is resolved to its row through
//                 perkSlots — the same first-claim-wins mapping the card uses
//                 to place them.
//   shard row r   tree-INDEPENDENT (shards belong to no tree), so the whole
//                 sample is the population: games carrying any shard at
//                 position r.
//
// Games whose stored payload carried no usable rune page at all are in NO
// denominator — they had nothing to say about any slot. A slot no game filled
// yields `null`, which the card renders as its existing explicit empty state.
// Nothing here is ever estimated, completed, or filled in from the page-level
// figure: a slot with no sample shows no number.

/** One rune slot on the featured page and the count behind it. */
export interface OtpRuneSlotSample {
  /** The rune this count is ABOUT — the id the card draws in this slot. The
   *  renderer re-checks it before printing the fraction, so an adapter that
   *  drifts out of step with this aggregation degrades to no number rather
   *  than to a wrong one. */
  runeId: number;
  /** Games in this slot's conditioned sample that ran THIS rune here. */
  count: number;
  /** Games in this slot's conditioned sample that ran ANY rune here — this
   *  slot's own denominator. A game that carried no rune in this slot does not
   *  dilute it. */
  sampleSize: number;
}

/** Per-slot counts for the displayed page. Every field is `null` where the
 *  page has no rune for that slot, or where no sampled game carried one. */
export interface OtpRunePageSamples {
  keystone: OtpRuneSlotSample | null;
  /** Length 3, index = primary minor row. */
  primaryRows: (OtpRuneSlotSample | null)[];
  /** Length 3, index = secondary tree row (a real page fills 2 of the 3). */
  secondaryRows: (OtpRuneSlotSample | null)[];
  /** Length 3, index = shard position (0 offense, 1 flex, 2 defense). */
  shards: (OtpRuneSlotSample | null)[];
  /** Games running the displayed page's primary tree — the population every
   *  primary-side slot is a subset of. Context for the reader, never a
   *  substitute for a slot's own denominator. */
  primaryTreeGames: number;
  /** Of those, the games also running the displayed secondary tree. */
  secondaryTreeGames: number;
}

/** A slot with nothing behind it is `null`, never `0/0`. */
function slotSample(runeId: number | null, count: number, sampleSize: number): OtpRuneSlotSample | null {
  if (runeId == null || sampleSize <= 0) return null;
  return { runeId, count, sampleSize };
}

/** row -> runeId for one page's SECONDARY picks. First id to claim a row wins,
 *  ids of unknown row are dropped — byte-for-byte the placement rule the card's
 *  grid adapter applies, so a count can only ever land under the icon it
 *  describes. */
function secondaryRowMap(page: RunePage): Map<number, number> {
  const out = new Map<number, number>();
  if (page.secondaryTree == null) return out;
  for (const id of page.secondary) {
    const row = primaryMinorRow(page.secondaryTree, id);
    if (row === null || out.has(row)) continue;
    out.set(row, id);
  }
  return out;
}

/** Count each rune of `displayed` across `pages` under the rule documented
 *  above. `pages` is one entry per game that carried a usable rune payload. */
export function buildRunePageSamples(
  pages: readonly RunePage[],
  displayed: RunePage
): OtpRunePageSamples {
  // A page with no resolved primary tree cannot be tree-conditioned. Rather
  // than invent a population, the whole sample is used and the primary-side
  // numbers say "of every game with a rune page" — still each slot's own
  // honest denominator, just a wider one. Real Riot payloads always carry the
  // tree, so this is a degradation path, not the normal one.
  const primarySample =
    displayed.primaryTree == null ? [...pages] : pages.filter((p) => p.primaryTree === displayed.primaryTree);
  const secondarySample =
    displayed.secondaryTree == null ? [] : primarySample.filter((p) => p.secondaryTree === displayed.secondaryTree);

  let keystoneCount = 0;
  let keystoneSample = 0;
  for (const p of primarySample) {
    if (p.keystone == null) continue;
    keystoneSample += 1;
    if (p.keystone === displayed.keystone) keystoneCount += 1;
  }

  const primaryRows = [0, 1, 2].map((row) => {
    const shown = displayed.primary[row] ?? null;
    if (shown == null) return null;
    let count = 0;
    let sampleSize = 0;
    for (const p of primarySample) {
      const id = p.primary[row];
      if (id == null) continue;
      sampleSize += 1;
      if (id === shown) count += 1;
    }
    return slotSample(shown, count, sampleSize);
  });

  const shownSecondary = secondaryRowMap(displayed);
  const secondaryMaps = secondarySample.map(secondaryRowMap);
  const secondaryRows = [0, 1, 2].map((row) => {
    const shown = shownSecondary.get(row) ?? null;
    if (shown == null) return null;
    let count = 0;
    let sampleSize = 0;
    for (const map of secondaryMaps) {
      const id = map.get(row);
      if (id == null) continue;
      sampleSize += 1;
      if (id === shown) count += 1;
    }
    return slotSample(shown, count, sampleSize);
  });

  const shards = [0, 1, 2].map((row) => {
    const shown = displayed.shards[row] ?? null;
    if (shown == null) return null;
    let count = 0;
    let sampleSize = 0;
    for (const p of pages) {
      const id = p.shards[row];
      if (id == null) continue;
      sampleSize += 1;
      if (id === shown) count += 1;
    }
    return slotSample(shown, count, sampleSize);
  });

  return {
    keystone: slotSample(displayed.keystone, keystoneCount, keystoneSample),
    primaryRows,
    secondaryRows,
    shards,
    primaryTreeGames: primarySample.length,
    secondaryTreeGames: secondarySample.length,
  };
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
  keepItem: (itemId: number) => boolean = () => true,
  kit?: ChampionKit | null
): FeaturedBuildModel {
  const games = rows.length;
  const itemGames = new Map<number, number>();
  const gameLog: FeaturedGame[] = [];
  const runeGroups = new Map<string, { page: RunePage; n: number }>();
  /** One entry per game that carried a usable rune payload — the population
   *  the per-slot counts run over. Parsed by the SAME `toRunePage` the modal
   *  page comes from, so a count and the icon it sits under can never be
   *  reading two different views of the same row. */
  const runePages: RunePage[] = [];
  const spellGroups = new Map<string, { spells: [number, number]; n: number }>();
  let wins = 0;

  for (const row of rows) {
    if (row.win) wins += 1;

    // Deduplicate within a game: an inventory listing the same id twice is one
    // game that built it, not two.
    const seen = new Set(asNumberArray(row.final_items).filter(keepItem));
    seen.forEach((id) => itemGames.set(id, (itemGames.get(id) ?? 0) + 1));
    // Same Set, so the per-game inventory and the per-item counts can never
    // disagree about what this game built — one dedup, two consumers. The
    // outcome is pushed in the SAME statement as the inventory, which is what
    // makes their pairing structural rather than a convention two loops could
    // drift out of.
    gameLog.push({ items: Array.from(seen), win: row.win });

    const page = toRunePage(row.runes);
    if (page) {
      runePages.push(page);
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

  const topRunes = Array.from(runeGroups.values()).sort((a, b) => b.n - a.n || runeKey(a.page).localeCompare(runeKey(b.page)))[0] ?? null;
  const topSpells = Array.from(spellGroups.values()).sort(
    (a, b) => b.n - a.n || a.spells[0] - b.spells[0] || a.spells[1] - b.spells[1]
  )[0] ?? null;
  const skillOrder = aggregateRecordedSkillOrders(rows.map((row) => row.skill_order), kit);

  return {
    games,
    wins,
    items,
    gameLog,
    runes: topRunes
      ? {
          page: topRunes.page,
          games: topRunes.n,
          pct: pct(topRunes.n),
          slots: buildRunePageSamples(runePages, topRunes.page),
        }
      : null,
    spells: topSpells ? { spells: topSpells.spells, games: topSpells.n, pct: pct(topSpells.n) } : null,
    skillOrder,
  };
}
