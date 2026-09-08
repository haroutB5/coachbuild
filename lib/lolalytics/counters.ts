// ─────────────────────────────────────────────────────────────────────────────
// lib/lolalytics/counters.ts — counter-pick suggestions from lolalytics's
// server-rendered counters pages (user directive 2026-09-08).
//
// QUESTION ANSWERED: "enemy locked/hovered X in my lane — what beats X?"
// Fetch X's OWN counters page
//   https://lolalytics.com/lol/{slug}/counters/?lane={lane}&tier=emerald_plus&patch={patch}
// and take the champions X is WEAK against (X's losing matchups), ranked by
// the candidate's win rate vs X, descending.
//
// DIRECTION CONVENTION (proven, not assumed — two independent witnesses):
//   1. Every card's tooltip sentence reads "{Page} wins against {Row} {WR}%",
//      where {WR} is byte-identical to the card's WR column (verified 101/101
//      on the Viktor/middle fixture, see parseCountersPage's direction pin).
//      So the WR column is the PAGE champion's own win rate vs the row
//      champion — a LOW value means the page champion LOSES that matchup.
//   2. lib/draft/lolalyticsCheck.ts's header independently confirms the same
//      sentence shape live ("Viktor wins against Gragas 44.29%" = Viktor's
//      own winrate vs Gragas, not Gragas's).
// Hence: candidateWinRateVs(enemy) = 1 - pageWr, candidateDelta1pp = allWr -
// pageWr (the candidate's change from its own field baseline in this
// matchup), candidateDelta2pp = -pageDelta2. The Viktor fixture agrees
// with the user's own example session: Viktor's row on his own page would be
// meaningless, but Vel'Koz's card (Viktor WR 48.63, 1,530 games) correctly
// resolves to "Vel'Koz beats Viktor 51.4%", and Smolder's card (Viktor WR
// 65.93) to "Smolder loses to Viktor" — matching the page header's own
// "strongest counter to Smolder" copy.
//
// PARSING ANCHORS (derived from
// _research/site-import/lolalytics-viktor-counters.html, 101 cards; a trimmed
// 4-card extract lives at lib/lolalytics/__fixtures__/ for tests):
//   - Card chunk: `<div class="mb-2 h-[254px] w-[118px]` … (one per matchup).
//   - Row identity: `<a href="/lol/{page}/vs/{row}/build/{?query}">` — the
//     query is `?vslane={lane}` on most cards but ABSENT on ~1/3 of them
//     (e.g. xerath), so it must be optional; the row NAME div
//     (`text-center text-[15px]">…<!--t=..-->NAME<!---->`) is the champId
//     resolution key (normalizeChampName, same as the tripwire), the slug is
//     diagnostics only.
//   - Page-champ WR: `text-green-300"…><!--t=..-->NN.NN<!---->%` (class is
//     constant green-300 across the whole 43.81–65.93 range — never branch on
//     it).
//   - Deltas: `Δ<sub>1</sub> X</span> • <span class="text-yellow-100">Δ<sub>2</sub> Y</span>`.
//   - Field-average WR: `alt="All Champs"><div class="text-xs text-green-500"…>NN.NN`
//     (Δ1 == WR − AllWR verified 101/101: it is the page champ's edge over
//     the field, hence negated for the candidate).
//   - Sample: `N,NNN Games</div>`.
//   - Section membership: the captured SSR page has ONE sortable counters
//     table (`q:key="counters_viktor_middle_ranked_list_emerald_plus_16.17_all__all"`)
//     with Name / WR vs / All Champs WR / Δ1 / Δ2 / Games headers. There is
//     no separate Weak/Strong tab marker in these bytes; weak-side rows are
//     therefore established explicitly as pageWinPct < 50 after parsing.
//   - Direction pin: the tooltip `{Subject}<!----> wins against
//     <!--t=..-->{Opp}<!----> <span class="text-green-..">NN.NN%`.
// NOT on this page (the phone screenshots' Pick Rate column lives on the
// build-page counters widget, not the SSR counters page): pick rate. Only
// games is available as a sample figure — the sample gate uses it.
//
// DRIFT HONESTY (same rule as the site importers): every failure mode is a
// typed LolalyticsCountersError, never a silent empty list. A page whose
// title is not a Counters page, zero card chunks, zero fully-parseable rows,
// a slug that doesn't match the requested champion (redirect/wrong page),
// an unresolvable direction (no tooltip agreement anywhere), or a page whose
// every row name is unmapped all THROW. Individual malformed cards are
// skipped but COUNTED (skippedCards) and surfaced in the result meta so a
// partial shape change is visible in logs, not invisible.
// ─────────────────────────────────────────────────────────────────────────────

import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetchTimeout";
import { normalizeChampName } from "./championName";
import type { RoleId } from "@/lib/types";

/** lolalytics rank-bracket slug for the counter-pick sample. Emerald+ (the
 *  site's default bracket, matching the user's evidence screenshots) — NOT
 *  the d2_plus pin lib/draft/lolalyticsCheck.ts uses. The tripwire pins
 *  Diamond II+ because it must compare like-with-like against OUR Diamond-II
 *  bucket; counter picks want the WIDEST honest sample so the 500-game gate
 *  below admits real matchups instead of starving (Emerald+ is ~4x the
 *  Diamond-II population). */
export const LOLALYTICS_COUNTERS_TIER = "emerald_plus";

/** Minimum matchup sample for a suggestion. lolalytics' own page floor is
 *  100 games ("a minimum of 100 games" header copy); counter-pick WR at that
 *  floor is noise (e.g. Viktor vs Olaf 43.81% on n=105), so the strip hides
 *  everything under 500. Rows below the gate are COUNTED (gatedCards), not
 *  silently dropped — the route reports the count. */
export const LOLALYTICS_MIN_GAMES = 500;

/** On-demand per-(enemy, lane, tier, patch) cache TTL. No Neon tables: the
 *  full matrix is never ingested, only the single enemy page the user is
 *  actually facing, via the runtime cache (lib/lastGood.ts's store — the
 *  same getCache() path, keys namespaced `lola:counters:*`). */
export const LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** How many ranked suggestions the server returns per enemy. The client
 *  shows "your pool" (up to 5) + "overall" (top 5); 15 gives the pool
 *  intersection room to find the user's champions below the global top 5. */
export const LOLALYTICS_MAX_SUGGESTIONS = 15;

export type LolalyticsCountersLane = "top" | "jungle" | "middle" | "bottom" | "support";
export type LolalyticsCountersRoleId = Exclude<RoleId, 5>;

/** App RoleId (0-4) -> lolalytics `lane`/`vslane` slug. */
export const LOLALYTICS_LANE_BY_ROLE: Record<LolalyticsCountersRoleId, LolalyticsCountersLane> = {
  0: "top",
  1: "jungle",
  2: "middle",
  3: "bottom",
  4: "support",
};

/** Where the parse stands on the page-shape contract. */
export type LolalyticsCountersErrorCode =
  | "not-counters-page"
  | "no-cards"
  | "page-mismatch"
  | "no-usable-rows"
  | "direction-unproven"
  | "unmapped-champions"
  | "fetch-failed";

export class LolalyticsCountersError extends Error {
  readonly code: LolalyticsCountersErrorCode;
  constructor(code: LolalyticsCountersErrorCode, message: string) {
    super(message);
    this.name = "LolalyticsCountersError";
    this.code = code;
  }
}

export function countersPageUrl(slug: string, lane: LolalyticsCountersLane, patch: string): string {
  return (
    `https://lolalytics.com/lol/${slug}/counters/` +
    `?lane=${lane}&tier=${LOLALYTICS_COUNTERS_TIER}&patch=${encodeURIComponent(patch)}`
  );
}

/** Folded champion names whose lolalytics URL slug diverges from the plain
 *  fold. Seeded ONLY with fixture-proven entries: the Viktor fixture's
 *  Nunu card links `/lol/viktor/vs/nunu/build/` while the display name folds
 *  to "nunuwillump". Everything else folds directly (viktor, wukong —
 *  fixture-proven via `/lol/wukong/counters/` — velkoz, chogath, kaisa,
 *  drmundo, masteryi, xinzhao, leesin, ksante). A wrong guess here cannot go
 *  silent: the page-mismatch guard throws when the fetched page's own
 *  vs-links name a different page champion. Grow this map on live 404s. */
export const LOLALYTICS_SLUG_OVERRIDES: Record<string, string> = {
  nunuwillump: "nunu",
};

/** Champion display name (ddragon `name`, e.g. "Nunu & Willump") -> the
 *  `{slug}` this champion's own counters page lives at. */
export function championSlugForCounters(displayName: string): string {
  const folded = normalizeChampName(displayName);
  return LOLALYTICS_SLUG_OVERRIDES[folded] ?? folded;
}

/** One fully-parsed matchup card, page-champion perspective (raw page
 *  numbers, before the direction flip in rankCounterSuggestions). */
export interface ParsedCounterRow {
  /** Row champion display name as rendered ("Nunu &amp; Willump" decoded). */
  oppName: string;
  /** vs-link slug (diagnostics only — champId resolution keys on oppName). */
  oppSlug: string;
  /** Page champion's own win rate vs this row champion, 0..100. */
  pageWinPct: number;
  /** Average opponent's win rate vs this row champion, 0..100. */
  fieldWinPct: number;
  /** pageWinPct - fieldWinPct, percentage points. */
  delta1pp: number;
  /** Normalised edge, percentage points (page-champion perspective). */
  delta2pp: number;
  games: number;
}

export interface ParseCountersResult {
  rows: ParsedCounterRow[];
  /** Cards present but missing at least one field — partial shape drift made
   *  visible, not silent. */
  skippedCards: number;
  /** Tooltip↔card WR agreements — the in-page direction proof; >= 1 always
   *  (else direction-unproven throws). */
  directionAgreements: number;
}

const HTML_ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

function decodeCountersEntities(s: string): string {
  return s.replace(/&#39;|&apos;|&amp;|&quot;|&lt;|&gt;/g, (e) => HTML_ENTITIES[e] ?? e);
}

/**
 * Pure parser for one lolalytics counters page. See this file's header for
 * the anchor derivations. Throws LolalyticsCountersError on every drift
 * shape — including `direction-unproven` when no tooltip sentence anywhere
 * on the page agrees with its card (without the tooltip the WR column could
 * be either champion's, and ranking it would be a guess).
 */
export function parseCountersPage(
  html: string,
  expected: { slug: string; subjectName: string }
): ParseCountersResult {
  if (!html || !html.includes("<title") || !/>[^<]*Counters[^<]*<\/title>/.test(html)) {
    throw new LolalyticsCountersError(
      "not-counters-page",
      `lolalytics counters parse: document has no Counters title (slug=${expected.slug})`
    );
  }

  const chunks = html.split('<div class="mb-2 h-[254px] w-[118px]');
  if (chunks.length < 2) {
    throw new LolalyticsCountersError(
      "no-cards",
      `lolalytics counters parse: 0 matchup cards for slug=${expected.slug} (page shape changed?)`
    );
  }

  // The page champion must be who we asked for — a redirect (renamed champ,
  // wrong slug guess) otherwise serves a valid-looking page for the WRONG
  // champion, and every suggestion would answer the wrong question.
  const firstLink = chunks[1].match(/<a href="\/lol\/([^/]+)\/vs\//);
  if (!firstLink || firstLink[1].toLowerCase() !== expected.slug.toLowerCase()) {
    throw new LolalyticsCountersError(
      "page-mismatch",
      `lolalytics counters parse: requested slug=${expected.slug} but page serves slug=${firstLink?.[1] ?? "?"}`
    );
  }

  const rows: ParsedCounterRow[] = [];
  let skippedCards = 0;
  for (let k = 1; k < chunks.length; k++) {
    // Bound the card: it ends where the NEXT card begins. The tooltip
    // template always sits inside this window (verified: every card's own
    // "wins against" sentence agrees with its WR 101/101 on the fixture).
    const nextCard = chunks[k].indexOf('<div class="mb-2 h-[254px] w-[118px]');
    const card = nextCard >= 0 ? chunks[k].slice(0, nextCard) : chunks[k];
    const link = card.match(/<a href="\/lol\/[^/]+\/vs\/([^/]+)\/build\/?(?:\?[^"]*)?"/);
    const name = card.match(/text-center text-\[15px\]">[^<]*<!--t=[0-9a-z]+-->([^<]+)<!----><\/div>/);
    const wr = card.match(/text-green-300"[^>]*><!--t=[0-9a-z]+-->([\d.]+)<!---->%/);
    const deltas = card.match(/Δ<sub>1<\/sub> ([-\d.]+)<\/span> • <span class="text-yellow-100">Δ<sub>2<\/sub> ([-\d.]+)<\/span>/);
    const field = card.match(/alt="All Champs"><div class="text-xs text-green-500"[^>]*><!--t=[0-9a-z]+-->([\d.]+)<!---->%/);
    const games = card.match(/([\d,]+) Games<\//);
    if (!link || !name || !wr || !deltas || !field || !games) {
      skippedCards += 1;
      continue;
    }
    const pageWinPct = Number(wr[1]);
    const fieldWinPct = Number(field[1]);
    const gamesCount = Number(games[1].replace(/,/g, ""));
    if (
      !Number.isFinite(pageWinPct) || pageWinPct < 0 || pageWinPct > 100 ||
      !Number.isFinite(fieldWinPct) || fieldWinPct < 0 || fieldWinPct > 100 ||
      !Number.isFinite(gamesCount) || gamesCount <= 0
    ) {
      skippedCards += 1;
      continue;
    }
    rows.push({
      oppName: decodeCountersEntities(name[1]).trim(),
      oppSlug: link[1],
      pageWinPct,
      fieldWinPct,
      delta1pp: Number(deltas[1]),
      delta2pp: Number(deltas[2]),
      games: gamesCount,
    });
  }

  if (rows.length === 0) {
    throw new LolalyticsCountersError(
      "no-usable-rows",
      `lolalytics counters parse: ${chunks.length - 1} cards present but 0 fully parseable (slug=${expected.slug})`
    );
  }

  // DIRECTION PIN: the tooltip sentence is the only in-page statement of
  // whose win rate the WR column is. Require agreement — a redesign that
  // flips the column to the ROW champion's perspective without touching the
  // card layout must throw here, not silently invert every suggestion.
  const tooltipRe = new RegExp(
    `<!--t=[0-9a-z]+-->([^<]+)<!----> wins against <!--t=[0-9a-z]+-->([^<]+)<!----> ` +
      `<span class="text-green-\\d+">([\\d.]+)%`,
    "g"
  );
  const tooltipWr = new Map<string, number>();
  let m: RegExpExecArray | null;
  while ((m = tooltipRe.exec(html)) !== null) {
    const subject = decodeCountersEntities(m[1]).trim();
    if (normalizeChampName(subject) !== normalizeChampName(expected.subjectName)) continue;
    tooltipWr.set(decodeCountersEntities(m[2]).trim().toLowerCase(), Number(m[3]));
  }
  let directionAgreements = 0;
  for (const row of rows) {
    const t = tooltipWr.get(row.oppName.toLowerCase());
    if (t === undefined) continue;
    if (Math.abs(t - row.pageWinPct) > 0.005 + 1e-9) {
      throw new LolalyticsCountersError(
        "direction-unproven",
        `lolalytics counters parse: tooltip says ${expected.subjectName} vs ${row.oppName} ${t}% but card says ${row.pageWinPct}% — column perspective changed?`
      );
    }
    directionAgreements += 1;
  }
  if (directionAgreements === 0) {
    throw new LolalyticsCountersError(
      "direction-unproven",
      `lolalytics counters parse: no tooltip sentence agreed with any card (slug=${expected.slug}) — cannot prove whose win rate the WR column is`
    );
  }

  return { rows, skippedCards, directionAgreements };
}

/** One ranked counter suggestion, CANDIDATE perspective (the flip applied):
 *  how the suggested champion fares against the enemy. */
export interface CounterSuggestion {
  champId: number;
  name: string;
  /** Candidate's win rate vs the enemy, 0..1 (== 1 - pageWr). */
  winRate: number;
  /** Candidate's matchup change from its own field baseline, percentage
   *  points (== fieldWinPct - pageWinPct, i.e. negated page Δ1). */
  delta1pp: number;
  /** Normalised edge, percentage points (negated page Δ2). */
  delta2pp: number;
  games: number;
}

export interface RankCountersResult {
  suggestions: CounterSuggestion[];
  /** Rows hidden by the sample gate (games < minGames). */
  gated: number;
  /** Rows whose display name resolved to no known champion. */
  unmapped: number;
}

/**
 * Pure direction flip + sample gate + ranking. Sort is the site's own
 * "countered most by" order — page WR ascending == candidate winRate
 * descending — tie-broken by sample then champId for determinism. Throws
 * `unmapped-champions` when NOTHING resolves (a champion-list gap would
 * otherwise render as "no counters", which is a lie about the data).
 */
export function rankCounterSuggestions(
  rows: ParsedCounterRow[],
  champions: ReadonlyMap<string, { id: number; name: string }>,
  minGames: number = LOLALYTICS_MIN_GAMES,
  maxSuggestions: number = LOLALYTICS_MAX_SUGGESTIONS
): RankCountersResult {
  let gated = 0;
  let unmapped = 0;
  let counterRows = 0;
  const suggestions: CounterSuggestion[] = [];
  for (const row of rows) {
    if (row.games < minGames) {
      gated += 1;
      continue;
    }
    // This endpoint answers "what beats the enemy?", not "show every
    // matchup." The counters page is one sortable table (there is no
    // separate Weak tab in the captured SSR bytes), so pageWinPct < 50 is
    // the explicit weak-side membership test. Including >=50 rows would
    // recommend champions that actually lose to the selected enemy.
    if (row.pageWinPct >= 50) continue;
    counterRows += 1;
    const champ = champions.get(normalizeChampName(row.oppName));
    if (!champ) {
      unmapped += 1;
      continue;
    }
    suggestions.push({
      champId: champ.id,
      name: champ.name,
      winRate: 1 - row.pageWinPct / 100,
      delta1pp: row.fieldWinPct - row.pageWinPct,
      delta2pp: -row.delta2pp,
      games: row.games,
    });
  }
  if (suggestions.length === 0 && counterRows > 0 && unmapped === counterRows) {
    throw new LolalyticsCountersError(
      "unmapped-champions",
      `lolalytics counters: ${unmapped} rows resolved to no known champion — champion list gap, not "no counters"`
    );
  }
  suggestions.sort((a, b) =>
    b.winRate !== a.winRate ? b.winRate - a.winRate : b.games !== a.games ? b.games - a.games : a.champId - b.champId
  );
  return { suggestions: suggestions.slice(0, maxSuggestions), gated, unmapped };
}

export type CountersFetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

/** Plain fetch with a normal UA — the site served browser loads with no
 *  Cloudflare challenge on 2026-09-08 (brief), and lib/draft/lolalyticsCheck.ts's
 *  defaultLolalyticsTransport already confirmed plain-fetch reachability from
 *  a server box. If lolalytics starts challenging Vercel egress, the fallback
 *  is the companion's hidden worker webview (1.3.0 auto-import pattern) —
 *  this function's throw sites (LolalyticsCountersError fetch-failed) are
 *  where that fallback would plug in. */
export async function fetchCountersHtml(
  url: string,
  fetchImpl: CountersFetchImpl = fetch,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<string> {
  let res: Response;
  try {
    const init = { headers: { "User-Agent": "coachbuild-counters/1.0", Accept: "text/html" } };
    // Production stays on the repository's shared timeout choke point. An
    // injected transport is used verbatim so fixture tests (and any future
    // worker-webview fallback) do not accidentally escape to the live site.
    res = fetchImpl === fetch
      ? await fetchWithTimeout(url, init, timeoutMs)
      : await fetchImpl(url, init);
  } catch (err) {
    throw new LolalyticsCountersError(
      "fetch-failed",
      `lolalytics counters fetch failed for ${url}: ${(err as Error).message ?? String(err)}`
    );
  }
  if (!res.ok) {
    throw new LolalyticsCountersError("fetch-failed", `lolalytics counters HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

export interface CountersResolveDeps {
  fetchImpl?: CountersFetchImpl;
  /** All known champions (id + display name) for row-name resolution. */
  champions: { id: number; name: string }[];
}

export interface ResolvedCounters {
  enemyChampId: number;
  enemyName: string;
  enemySlug: string;
  lane: LolalyticsCountersLane;
  tier: string;
  patch: string;
  fetchedAt: string;
  suggestions: CounterSuggestion[];
  parsedRows: number;
  skippedCards: number;
  gatedRows: number;
  unmappedRows: number;
  directionAgreements: number;
}

/**
 * Full orchestration: URL -> fetch -> parse (typed drift failures) ->
 * resolve names -> gate -> rank. Pure over injected deps (champions list +
 * optional fetch), so tests cover everything below the real network.
 */
export async function resolveCountersForEnemy(
  enemy: { id: number; name: string },
  lane: LolalyticsCountersLane,
  patch: string,
  deps: CountersResolveDeps,
  now: () => number = Date.now
): Promise<ResolvedCounters> {
  const enemySlug = championSlugForCounters(enemy.name);
  const url = countersPageUrl(enemySlug, lane, patch);
  const html = await fetchCountersHtml(url, deps.fetchImpl);
  const parsed = parseCountersPage(html, { slug: enemySlug, subjectName: enemy.name });
  const byName = new Map<string, { id: number; name: string }>();
  for (const c of deps.champions) byName.set(normalizeChampName(c.name), c);
  const ranked = rankCounterSuggestions(parsed.rows, byName);
  return {
    enemyChampId: enemy.id,
    enemyName: enemy.name,
    enemySlug,
    lane,
    tier: LOLALYTICS_COUNTERS_TIER,
    patch,
    fetchedAt: new Date(now()).toISOString(),
    suggestions: ranked.suggestions,
    parsedRows: parsed.rows.length,
    skippedCards: parsed.skippedCards,
    gatedRows: ranked.gated,
    unmappedRows: ranked.unmapped,
    directionAgreements: parsed.directionAgreements,
  };
}
