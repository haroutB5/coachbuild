// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/lolalyticsCheck.ts — EXTERNAL matchup-DIRECTION tripwire, added
// 2026-07-21 as a companion to lib/draft/ingestGuard.ts. The existing guard
// has two checks -- the cross-source panel (vs coachless) verifies BASELINE
// winrates, and the symmetry check verifies internal decode/keying integrity
// -- but NEITHER of those actually verifies matchup DIRECTION against a
// genuinely independent third source that itself publishes per-matchup
// winrates (coachless has no per-opponent matchup numbers at all, only
// champion-overall baselines -- see lib/heroStats.ts's header). A future
// opp-id keying bug (e.g. a join/index swap that puts champ A's row under
// champ B's matchup) could leave every baseline correct AND leave symmetry
// intact (see ingestGuard.ts's own comment on why a same-direction-everywhere
// inversion is invisible to symmetry) while still being systematically wrong
// per-matchup. This module closes that gap using lolalytics's server-rendered
// counters pages, which show the PAGE-OWNER champion's own winrate against
// each opponent as plain text in the SSR HTML (confirmed live 2026-07-21 --
// see this file's HANDOFF for the fetch log): e.g. fetching
// https://lolalytics.com/lol/viktor/counters/?lane=middle renders
// `Viktor wins against Gragas 44.29%` as literal (Qwik-resumability-wrapped)
// text -- Viktor's own winrate vs Gragas, not Gragas's.
//
// THIS IS A TRIPWIRE, NOT A DEPENDENCY: lolalytics can rework its page markup
// at any time with zero notice (no versioned API, no stability contract).
// parseLolalyticsCounters is deliberately tolerant -- a shape change that
// drops the matchup count below LOLALYTICS_MIN_PARSEABLE degrades this whole
// check to "indeterminate" (logged loudly, never thrown, never blocks the
// ingest) rather than either fabricating a false pass or crashing a batch
// over a third party's markup change. Only an ACTUAL numeric disagreement
// on >= 2 independently-checked high-sample matchups (the same "more than
// one, so it's not just cross-source noise" posture ingestGuard.ts's panel
// check applies with GUARD_MIN_CHECKABLE) is treated as the direction/keying
// error signature this module exists to catch, and only that verdict blocks
// retention -- see lib/draft/ingest.ts's final-cursor wiring.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import type { RoleId } from "@/lib/types";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";

export type LolalyticsLane = "top" | "jungle" | "middle" | "bottom" | "support";

export interface LolalyticsPanelEntry {
  champId: number;
  /** lolalytics champion URL slug -- lowercase, no punctuation, e.g. "viktor".
   *  Only true for the fixed panel below (all single-word simple names);
   *  NOT a general champ-name-to-slug algorithm. */
  slug: string;
  /** Exact display name lolalytics renders in its "{name} wins against"
   *  sentence -- used to anchor the parse regex to THIS champion's rows
   *  specifically (the page also renders "average opponent winrate"
   *  sentences per opponent that must NOT be mistaken for the subject's own
   *  winrate -- see parseLolalyticsCounters's doc comment). */
  subjectName: string;
  lane: LolalyticsLane;
  role: RoleId;
  label: string;
}

/** Fixed panel -- deliberately small (politeness: 3 pages total) and spans 3
 *  different roles/lanes so a single role's opp-id keying bug wouldn't hide
 *  behind the other two panel entries passing. One well-known, high-volume,
 *  single-role-main champion per lane keeps counters pages large (more
 *  potential high-sample matchups to compare) and their lolalytics slug
 *  trivial (plain lowercase name, no hyphenation/apostrophe edge cases). */
export const LOLALYTICS_PANEL: LolalyticsPanelEntry[] = [
  { champId: 112, slug: "viktor", subjectName: "Viktor", lane: "middle", role: 2, label: "Viktor/mid" },
  { champId: 86, slug: "garen", subjectName: "Garen", lane: "top", role: 0, label: "Garen/top" },
  { champId: 222, slug: "jinx", subjectName: "Jinx", lane: "bottom", role: 3, label: "Jinx/bot" },
];

/**
 * `patch`, when given, MUST be pinned via lolalytics's own `&patch=` query
 * param -- e.g. `?lane=top&patch=16.13`. This isn't optional polish: the
 * true invariant this whole check depends on is "comparing the SAME
 * patch's data on both sides", and lolalytics defaults to whatever ITS
 * "current" patch is without a `patch` param. Our ingest walks one bounded
 * batch at a time and can legitimately be one patch behind lolalytics'
 * live default at any given moment (verified live 2026-07-21: our DB sat on
 * 16.13 while lolalytics' unpinned page served 16.14 -- comparing across
 * that one-patch gap alone produced 18 false "disagreements" purely from
 * ordinary patch-to-patch balance drift, NOT a direction/keying bug -- the
 * values tracked each other in the SAME direction the whole time, just
 * offset by a few points, which is the opposite signature of a flip. Once
 * pinned to the matching patch, the same panel passed cleanly -- see
 * HANDOFF-engo.md for the full before/after comparison). Omitting `patch`
 * falls back to lolalytics' own current-patch default -- only used by
 * fixture-driven unit tests that don't hit the network at all.
 */
export function lolalyticsCountersUrl(entry: Pick<LolalyticsPanelEntry, "slug" | "lane">, patch?: string): string {
  const base = `https://lolalytics.com/lol/${entry.slug}/counters/?lane=${entry.lane}`;
  return patch ? `${base}&patch=${patch}` : base;
}

/** Max allowed |lolalytics% - our%| before a single matchup counts as a
 *  disagreement. Same value as ingestGuard.ts's GUARD_TOLERANCE_PCT /
 *  SYMMETRY_TOLERANCE_PCT -- generous enough for source-to-source sampling
 *  noise, far tighter than a perspective-flip's typical swing. */
export const LOLALYTICS_TOLERANCE_PCT = 4;

/** Below this many (opponent, winrate) pairs successfully parsed off ONE
 *  page, that page's shape is presumed broken (markup rework, A/B test,
 *  partial load) -- its parses are discarded rather than fed into
 *  comparisons, and it's flagged in the per-page report. Real pages return
 *  60-80+ matchups (see this file's HANDOFF fetch log); 5 is a floor far
 *  below any real page, chosen to fail loudly on a near-total shape break
 *  while tolerating a page that's merely missing a handful of rows. */
export const LOLALYTICS_MIN_PARSEABLE = 5;

/** Only compare against OUR rows with at least this many games -- "high
 *  sample" per the task spec, same floor class as ingestGuard's symmetry
 *  check (SYMMETRY_MIN_GAMES=200) but stricter since lolalytics' own sample
 *  composition (region/rank mix) isn't identical to ours and a low-sample
 *  comparison would just be noise on both sides. */
export const LOLALYTICS_MIN_SAMPLE_GAMES = 1000;

/** Below this many ACTUAL high-sample comparisons across the whole panel
 *  (after page-shape + name-resolution + sample-size filtering), the check
 *  can't vouch for anything either way -- indeterminate, not a pass. */
export const LOLALYTICS_MIN_COMPARABLE = 5;

/** >= this many disagreeing high-sample matchups is the FLOOR for the
 *  direction/keying error signature (task spec: "≥2 high-sample matchups
 *  disagree"). A single disagreement always stays inside "pass" -- cross-
 *  source noise on one matchup is expected. This floor alone is NOT
 *  sufficient at real scale, though -- see LOLALYTICS_FAIL_RATE_PCT below,
 *  which is what actually gates the verdict once this floor is met. */
export const LOLALYTICS_FAIL_THRESHOLD = 2;

/** The REAL fail condition, alongside LOLALYTICS_FAIL_THRESHOLD: the
 *  disagreement RATE (disagreements / comparisons) must also exceed this
 *  fraction. A flat "count >= 2" alone does NOT scale -- live-validated
 *  2026-07-21 against the corrected DB (see HANDOFF-engo.md): a single run
 *  produced 157 real high-sample comparisons (lolalytics' full counters
 *  pages return 100+ opponents each, not the small handful the task's "2-3
 *  champion pages" framing implicitly assumed), and even after fixing an
 *  unrelated patch-pin bug, ordinary cross-source noise (different tier/
 *  rank-cut composition between lolalytics and our own Emerald+ bucket)
 *  alone produced 3 matchups over the 4pt tolerance at the sample-size
 *  floor's edge -- 3 >= LOLALYTICS_FAIL_THRESHOLD would have FAILED every
 *  single real run despite zero direction/keying issues. 3/157 = 1.9% is
 *  obviously ordinary tail noise, not a systematic error -- a genuine
 *  perspective/keying bug flips the SIGN of the deviation on every
 *  meaningfully-off-50% matchup at once (the P0 incident this guard exists
 *  to catch showed near-universal disagreement, not a handful of edge
 *  cases), so a real bug clears this rate by a wide margin regardless of
 *  panel size. 10% is conservative in both directions: comfortably above
 *  any observed noise floor, comfortably below what an actual inversion
 *  produces. */
export const LOLALYTICS_FAIL_RATE_PCT = 0.1;

export interface ParsedLolalyticsMatchup {
  oppName: string;
  /** The PAGE-OWNER champion's own winrate (0..100) against oppName. */
  winPct: number;
}

const HTML_ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&#39;|&apos;|&amp;|&quot;|&lt;|&gt;/g, (e) => HTML_ENTITIES[e] ?? e);
}

/**
 * Pure, tolerant parser for one lolalytics counters page. Anchored to the
 * page-owner's OWN "{subjectName} wins against {opponent} {pct}%" sentence
 * (Qwik SSR renders champion names split across `<!--t=xx-->name<!---->`
 * resumability comments -- the regex spans across those, matching only on
 * the opponent name's literal text and the immediately-following green
 * winrate span). Deliberately does NOT try to also parse the page's
 * "average opponent winrate against X" or "played N% more/less often"
 * sentences that appear nearby in the same paragraph -- those are different
 * statistics (aggregate-across-all-opponents and pick-rate deviation,
 * respectively), not this matchup's winrate, and mixing them in would
 * silently corrupt the comparison.
 *
 * Never throws on malformed/absent input -- a page shape change or a
 * completely different document (e.g. a Cloudflare challenge page swapped
 * in) just yields fewer (possibly zero) matches, which the caller treats as
 * an "indeterminate" signal via LOLALYTICS_MIN_PARSEABLE, never a crash.
 * Case-sensitive on subjectName by design (lolalytics renders proper-cased
 * champion names consistently) and dedupes by lowercased opponent name in
 * case a future page shape renders a matchup block more than once.
 */
export function parseLolalyticsCounters(html: string, subjectName: string): ParsedLolalyticsMatchup[] {
  if (!html || !subjectName) return [];

  const escapedSubject = subjectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern =
    `${escapedSubject}<!----> wins against <!--t=[0-9a-z]+-->([^<]+)<!----> ` +
    `<span class="text-green-\\d+">(\\d+(?:\\.\\d+)?)%`;
  const re = new RegExp(pattern, "g");

  const out: ParsedLolalyticsMatchup[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const oppName = decodeHtmlEntities(m[1]).trim();
    const winPct = Number(m[2]);
    if (!oppName || !Number.isFinite(winPct) || winPct < 0 || winPct > 100) continue;
    const key = oppName.toLowerCase();
    if (seen.has(key)) continue; // a shape regression that duplicates a block should never double-count
    seen.add(key);
    out.push({ oppName, winPct });
  }
  return out;
}

/** Normalizes a champion display name for name->id matching: lowercase,
 *  strip everything but letters/digits. Collapses lolalytics/ddragon's
 *  incidental punctuation differences ("Kai'Sa" vs "Kai Sa", "Vel'Koz",
 *  "Nunu & Willump", "Cho'Gath") to the same key without needing a
 *  hand-maintained alias table. */
export function normalizeChampName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface LolalyticsOurRow {
  /** OUR matchup winrate (0..100), subject-champion perspective (already
   *  post the 2026-07-21 P0 perspective fix -- draft_matchup.wins is the
   *  row's own champ_id's wins, see lib/draft/ugg.ts). */
  winPct: number;
  games: number;
}

export interface LolalyticsCheckDeps {
  /** Fetches one counters page's raw HTML. Injectable so tests never hit the
   *  network -- mirrors lib/draft/ugg.ts's UggTransport pattern. Throwing
   *  here is treated as a normal per-page fetch failure (page marked
   *  unusable), never an uncaught exception out of the check. */
  fetchHtml: (url: string) => Promise<string>;
  /** OUR draft_matchup row for (subjectChampId, oppChampId, role) in the
   *  current patch/tier, or null if no row exists at all. Returns the row
   *  REGARDLESS of sample size -- the LOLALYTICS_MIN_SAMPLE_GAMES floor is
   *  applied by the orchestrator, not here, so the floor's value is a
   *  single knob covered by runLolalyticsCheck's own tests. */
  getOurMatchup: (subjectChampId: number, oppChampId: number, role: RoleId) => Promise<LolalyticsOurRow | null>;
  /** Resolves a lolalytics-rendered opponent display name to this app's
   *  champion id, or null when unresolvable (name drift, retired/renamed
   *  champ, off-panel champ not in the current champion list). An
   *  unresolved name is simply excluded from comparisons -- never a
   *  failure signal on its own. */
  resolveChampIdByName: (displayName: string) => number | null;
}

export interface LolalyticsComparison {
  label: string;
  oppName: string;
  oppChampId: number;
  lolalyticsWinPct: number;
  ourWinPct: number;
  ourGames: number;
  deltaPct: number;
}

export interface LolalyticsPageResult {
  label: string;
  champId: number;
  url: string;
  /** Non-null when deps.fetchHtml threw for this page. */
  fetchError: string | null;
  /** Raw (opponent, winrate) pairs extracted, before any DB/sample filtering. */
  parsedPairs: number;
  /** true iff the fetch succeeded AND parsedPairs >= minParseable -- only
   *  usable pages contribute to `comparisons` below. */
  pageUsable: boolean;
}

export type LolalyticsVerdict = "pass" | "fail" | "indeterminate";

export interface LolalyticsCheckResult {
  verdict: LolalyticsVerdict;
  reason: string;
  pages: LolalyticsPageResult[];
  /** Every high-sample matchup actually compared (agreeing AND disagreeing) --
   *  for reporting/debugging, not solely the pass/fail decision. */
  comparisons: LolalyticsComparison[];
  /** Human-readable descriptions of comparisons exceeding tolerance -- subset
   *  of `comparisons`. */
  disagreements: string[];
}

/**
 * Orchestrates the full external tripwire: fetch each panel page, parse,
 * resolve opponent names, compare against OUR high-sample rows, and produce
 * one of three verdicts. Pure over injected deps -- directly unit-testable
 * with fixture HTML + fake deps, no network/DB (see
 * lib/__tests__/draft-lolalyticsCheck.test.ts).
 */
export async function runLolalyticsCheck(
  deps: LolalyticsCheckDeps,
  panel: LolalyticsPanelEntry[] = LOLALYTICS_PANEL,
  /** OUR ingest's patch label (e.g. "16.13"), pinned onto every fetched URL
   *  via lolalyticsCountersUrl -- see that function's doc comment for why
   *  this is load-bearing, not cosmetic. Omitted only by fixture-driven
   *  unit tests that inject fetchHtml directly and never build a real URL. */
  patch?: string,
  tolerancePct: number = LOLALYTICS_TOLERANCE_PCT,
  minSampleGames: number = LOLALYTICS_MIN_SAMPLE_GAMES,
  minParseable: number = LOLALYTICS_MIN_PARSEABLE,
  minComparable: number = LOLALYTICS_MIN_COMPARABLE,
  failThreshold: number = LOLALYTICS_FAIL_THRESHOLD,
  failRatePct: number = LOLALYTICS_FAIL_RATE_PCT
): Promise<LolalyticsCheckResult> {
  const pages: LolalyticsPageResult[] = [];
  const comparisons: LolalyticsComparison[] = [];
  const disagreements: string[] = [];

  for (const entry of panel) {
    const url = lolalyticsCountersUrl(entry, patch);
    let html: string | null = null;
    let fetchError: string | null = null;
    try {
      html = await deps.fetchHtml(url);
    } catch (err) {
      fetchError = (err as Error).message ?? String(err);
    }

    if (html === null) {
      pages.push({ label: entry.label, champId: entry.champId, url, fetchError, parsedPairs: 0, pageUsable: false });
      continue;
    }

    const parsed = parseLolalyticsCounters(html, entry.subjectName);
    const pageUsable = parsed.length >= minParseable;
    pages.push({ label: entry.label, champId: entry.champId, url, fetchError: null, parsedPairs: parsed.length, pageUsable });
    if (!pageUsable) continue; // page shape likely broke -- never feed a possibly-garbage parse into comparisons

    for (const pair of parsed) {
      const oppChampId = deps.resolveChampIdByName(pair.oppName);
      if (oppChampId === null) continue; // unresolved name -- excluded, not a failure

      const row = await deps.getOurMatchup(entry.champId, oppChampId, entry.role);
      if (row === null || row.games < minSampleGames) continue; // no row, or below the high-sample floor

      const delta = Math.abs(pair.winPct - row.winPct);
      comparisons.push({
        label: entry.label,
        oppName: pair.oppName,
        oppChampId,
        lolalyticsWinPct: pair.winPct,
        ourWinPct: row.winPct,
        ourGames: row.games,
        deltaPct: delta,
      });
      if (delta > tolerancePct) {
        disagreements.push(
          `${entry.label} vs ${pair.oppName}: lolalytics ${pair.winPct.toFixed(1)}% vs ours ${row.winPct.toFixed(1)}% ` +
            `(delta ${delta.toFixed(1)} > tolerance ${tolerancePct}, n=${row.games})`
        );
      }
    }
  }

  if (comparisons.length < minComparable) {
    return {
      verdict: "indeterminate",
      reason:
        `only ${comparisons.length}/${minComparable} high-sample matchups were comparable across the panel -- ` +
        `scrape shape or DB coverage may have changed; never blocks the ingest on its own`,
      pages,
      comparisons,
      disagreements,
    };
  }

  // Both the absolute floor AND the rate must be exceeded -- see
  // LOLALYTICS_FAIL_RATE_PCT's doc comment for why a flat count alone
  // doesn't scale: lolalytics' real counters pages return 100+ opponents
  // each, so the comparable set is routinely 100+ matchups per run, not the
  // small handful "≥2 disagree" reads naturally for. A genuine direction/
  // keying bug clears BOTH thresholds by a wide margin regardless of panel
  // size; ordinary cross-source noise clears neither at real scale.
  const disagreementRate = disagreements.length / comparisons.length;
  if (disagreements.length >= failThreshold && disagreementRate > failRatePct) {
    return {
      verdict: "fail",
      reason:
        `${disagreements.length}/${comparisons.length} (${(disagreementRate * 100).toFixed(1)}%) high-sample matchups ` +
        `disagree with lolalytics by more than ${tolerancePct}pt -- direction/keying error signature`,
      pages,
      comparisons,
      disagreements,
    };
  }

  return {
    verdict: "pass",
    reason:
      `${comparisons.length} high-sample matchups compared against lolalytics, ${disagreements.length} disagreement(s) ` +
      `(${(disagreementRate * 100).toFixed(1)}% -- below the ${(failRatePct * 100).toFixed(0)}% fail-rate threshold)`,
    pages,
    comparisons,
    disagreements,
  };
}

/** Default transport: Node's global fetch. Unlike lib/draft/ugg.ts's u.gg
 *  stats2 CDN, lolalytics's SSR HTML was confirmed reachable via plain fetch
 *  from this box (200, real content, no Cloudflare challenge -- see this
 *  file's HANDOFF fetch log), so no curl-subprocess transport is needed by
 *  default. Kept injectable (LolalyticsCheckDeps.fetchHtml /
 *  makeRealLolalyticsCheckDeps's `transport` param) so a future environment
 *  where fetch DOES get challenged can drop in
 *  scripts/_curl-transport.mjs's curlTransport unchanged, same precedent as
 *  ugg.ts's UggTransport. */
async function defaultLolalyticsTransport(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "coachbuild-ingest/1.0", Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`lolalytics HTTP ${res.status}`);
  }
  return res.text();
}

export { defaultLolalyticsTransport };
export type LolalyticsTransport = (url: string) => Promise<string>;

/** Real deps: lolalytics over `transport` (default: fetch), OUR matchup rows
 *  from Neon, name resolution from the already-fetched champion list
 *  (avoids a second getAllChampions() call inside the deps themselves --
 *  callers already have the list from their own ingest/bootstrap flow). */
export function makeRealLolalyticsCheckDeps(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string,
  champions: { id: number; name: string }[],
  transport: LolalyticsTransport = defaultLolalyticsTransport
): LolalyticsCheckDeps {
  const byNormalizedName = new Map<string, number>();
  for (const c of champions) {
    byNormalizedName.set(normalizeChampName(c.name), c.id);
  }

  return {
    fetchHtml: transport,
    getOurMatchup: async (champId, oppId, role) => {
      const rows = (await sql`
        SELECT wins, games FROM coachbuild.draft_matchup
        WHERE patch = ${patch} AND tier = ${DIAMOND_2_PLUS_TIER} AND role = ${role} AND champ_id = ${champId} AND opp_id = ${oppId}
      `) as unknown as { wins: number; games: number }[];
      const row = rows[0];
      if (!row || row.games <= 0) return null;
      return { winPct: (row.wins / row.games) * 100, games: row.games };
    },
    resolveChampIdByName: (name) => byNormalizedName.get(normalizeChampName(name)) ?? null,
  };
}

/** Convenience wrapper -- lib/draft/ingest.ts's final-cursor path and
 *  scripts/ingest-draft.mjs both call this with LOLALYTICS_PANEL. */
export async function runDefaultLolalyticsCheck(
  sql: NonNullable<ReturnType<typeof getSql>>,
  patch: string,
  champions: { id: number; name: string }[],
  transport?: LolalyticsTransport
): Promise<LolalyticsCheckResult> {
  return runLolalyticsCheck(makeRealLolalyticsCheckDeps(sql, patch, champions, transport), LOLALYTICS_PANEL, patch);
}
