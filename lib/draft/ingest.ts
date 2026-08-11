// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/ingest.ts — batch ingest for the "Draft" recommender (see
// _research/draft-feature-plan.md §2). Chunked by champion, mirroring
// lib/prostage/ingest.ts's per-tournament chunking: cursor = index into the
// full (deterministic, id-sorted) champion list, BATCH_SIZE champs per
// invocation (well under a 60s route maxDuration even with polite pacing).
//
// baselineWr (coachbuild.draft_champ_stats.winrate) is DERIVED from the same
// matchups payload this ingest already fetched (aggregate wins/games across
// every opponent row for that champion+role), NOT read from u.gg's rankings
// endpoint — see lib/draft/ugg.ts's decodeRankingsJson comment for why:
// this session couldn't live-verify the rankings JSON's column layout at
// all (network-blocked, see ugg.ts's header), and guessing indices risks
// silently wrong numbers in a scoring layer. pickrate/banrate DO come from
// the rankings fetch and are simply null until that decoder is filled in.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "@/lib/pro/db";
import { DbUnavailableError } from "@/lib/pro/errors";
import { getAllChampions, MAX_REAL_CHAMPION_ID } from "@/lib/staticData";
import type { RoleId } from "@/lib/types";
import {
  DIAMOND_2_PLUS_TIER,
  WORLD_REGION,
  defaultUggTransport,
  fetchMatchups,
  fetchRankings,
  makeSchemaProbe,
  resolveUggSchema,
  type UggTransport,
} from "@/lib/draft/ugg";
import { patchSegment, resolveDraftPatchLabel } from "@/lib/draft/patch";
import { runDefaultIngestGuard, runSymmetryCheck } from "@/lib/draft/ingestGuard";
import { recordIngestRun } from "@/lib/ingestHealth";
import {
  DIRECTION_CHECK_INGEST_KEY,
  runDefaultLolalyticsCheck,
  type LolalyticsTransport,
} from "@/lib/draft/lolalyticsCheck";

/** Champions per invocation. ~170 champs / 9 per batch ≈ 19 batches; at
 *  ~1.5s pacing and 2 requests (matchups+rankings) per champ, one batch is
 *  ~27s worst case — comfortably under a 60s maxDuration. */
export const BATCH_SIZE = 9;
/** Politeness pacing floor between successive u.gg requests — this is a
 *  static CDN, not a documented-limiter API like Cargo, but the plan is
 *  explicit: "no hammering". Mutable (not const) so tests can zero it out —
 *  see __setDraftPaceMsForTests. */
let paceMs = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function pacedUggCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const wait = Math.max(0, lastCallAt + paceMs - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return fn();
  };
  const scheduled = chain.then(run, run);
  chain = scheduled.then(
    () => undefined,
    () => undefined
  );
  return scheduled;
}

/** Test/script-only escape hatch: resets the shared pacer clock (mirrors
 *  lib/pro/pacer.ts / lib/prostage/cargo.ts's identical pattern). */
export function __resetDraftPacerForTests(): void {
  chain = Promise.resolve();
  lastCallAt = 0;
}

/** Test-only: override the pacing floor (real production callers never call
 *  this — the 1500ms default is intentional politeness pacing against a
 *  real CDN). Vitest's suite would otherwise spend real wall-clock seconds
 *  per test on a mocked transport that doesn't need pacing at all. */
export function __setDraftPaceMsForTests(ms: number): void {
  paceMs = ms;
}

export interface DraftIngestOptions {
  cursor?: number;
  /** Overrides the champion list entirely (index by numeric id only) —
   *  skips getAllChampions(). Used by tests, and available to a future
   *  script that already resolved the list once itself. */
  champions?: { id: number; name?: string }[];
  onProgress?: (msg: string) => void;
  /** Injectable HTTP transport — app/route code stays on the default fetch
   *  transport; scripts/ingest-draft.mjs injects a curl-based one (see
   *  scripts/_curl-transport.mjs's curlTransportWithHeaders — u.gg REQUIRES
   *  a Referer header the plain curlTransport doesn't send). */
  transport?: UggTransport;
  /** See DraftIngestOptions doc note on lib/draft/ingest.ts's header — no
   *  known u.gg rate-limit/cooldown contract exists (unlike Cargo); this
   *  only governs whether a 403/429-shaped failure aborts the REST of the
   *  batch immediately (route, tight 60s budget) vs. is logged per-champion
   *  and the walk continues (script, default, long-running). */
  fastFailOnRatelimit?: boolean;
  /** Injectable HTTP transport for lib/draft/lolalyticsCheck.ts's external
   *  matchup-direction tripwire -- defaults to plain fetch (confirmed
   *  reachable from this box, see that module's header); a script/future
   *  environment can override with a curl-based transport the same way
   *  scripts/ingest-draft.mjs overrides `transport` for u.gg. */
  lolalyticsTransport?: LolalyticsTransport;
}

export interface DraftIngestResult {
  patch: string;
  /** First champion id this batch attempted (diagnostic only). */
  champStart: number | null;
  /** How many champions this batch actually attempted (<= BATCH_SIZE). */
  champCount: number;
  rowsUpserted: number;
  statsUpserted: number;
  /** Sum of decodeMatchupsJson's per-champion skippedRows — the empirical
   *  wins<=games assertion the plan's ship-sequence calls for. */
  skippedRows: number;
  /** v0.109.0 — champions in this batch whose payload arrived intact but did
   *  not contain the tier partition we serve (see DecodeMatchupsResult's
   *  `tierMissing`). Each one also pushes an entry into `errors`, so a u.gg
   *  tier renumber fails the run's health instead of reporting a successful
   *  ingest that wrote nothing. */
  tierMissingChamps: number;
  nextCursor: number | null;
  errors: string[];
  /** True only on the batch where nextCursor became null AND retention
   *  pruning (keep last 2 distinct patch labels) actually ran. */
  retentionRan: boolean;
  /** P0 permanent guard (2026-07-21, see lib/draft/ingestGuard.ts): null on
   *  every batch except the final one (nextCursor === null), where BOTH the
   *  cross-source panel AND the internal symmetry check must pass before
   *  retention is allowed to run. false means retention was SKIPPED this
   *  walk even though the walk itself completed — the data stays in place
   *  (never silently trusted), but the last-known-good patch is NOT pruned
   *  until a human investigates (see the pushed errors for specifics). */
  guardOk: boolean | null;
  /** EXTERNAL matchup-direction tripwire (2026-07-21, see
   *  lib/draft/lolalyticsCheck.ts's header): null on every batch except the
   *  final one. "fail" blocks retention exactly like a `guardOk===false`
   *  above; "indeterminate" (lolalytics scrape shape broke, or too few
   *  high-sample matchups were comparable) logs loudly but does NOT block --
   *  this is a tripwire against a THIRD PARTY's markup, not a dependency,
   *  and a scrape break must never be confused with a real ingest failure. */
  lolalyticsVerdict: "pass" | "fail" | "indeterminate" | null;
}

const APP_ROLES: RoleId[] = [0, 1, 2, 3, 4];

/** Audit P1-2 fix: the ingest cron previously always started at cursor=0
 *  (no persisted state), so a bounded per-invocation walk could never
 *  advance past its first slice across daily runs — the feature strands on
 *  a small partial pool forever. This one-row table (migration
 *  0010_draft_audit_patches.sql) is the persisted "where did the last
 *  cursorless (cron) run leave off" pointer. Returns 0 if the row is
 *  somehow missing (defensive — the migration seeds it, but never crash a
 *  cron tick over a missing row). */
export async function getPersistedCursor(sql: NonNullable<ReturnType<typeof getSql>>): Promise<number> {
  const rows = (await sql`SELECT cursor FROM coachbuild.draft_ingest_cursor WHERE id = 1`) as unknown as {
    cursor: number;
  }[];
  return rows[0]?.cursor ?? 0;
}

/** Persists the cursor a cursorless (cron) run ended on — 0 wraps a
 *  completed walk back to the start for the next patch. An explicit
 *  `?cursor=` request (manual/debug driving) never calls this, so it can't
 *  disturb the cron's own automatic progression. */
export async function setPersistedCursor(sql: NonNullable<ReturnType<typeof getSql>>, cursor: number): Promise<void> {
  await sql`
    INSERT INTO coachbuild.draft_ingest_cursor (id, cursor, updated_at) VALUES (1, ${cursor}, now())
    ON CONFLICT (id) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()
  `;
}

/** v0.109.0 — MAKE A SILENT RETIREMENT IMPOSSIBLE.
 *
 * The lolalytics direction tripwire is the ONLY check in this codebase that
 * verifies matchup DIRECTION against a source that publishes per-matchup
 * winrates (the cross-source panel compares baselines; symmetry is internal —
 * see each module's header). It has, by design, a verdict that is not a
 * failure: "indeterminate" means it could not run — the scrape shape broke, or
 * too few high-sample matchups were comparable. That verdict correctly does not
 * block retention. It also, until now, went nowhere a human would ever look: the
 * run recorded `ok: true` with `last_error: null`, so the app's only external
 * direction guard could stop guarding permanently and every surface would keep
 * reporting healthy.
 *
 * A run's OWN health row is the wrong place for it (the ingest genuinely did
 * succeed, and flipping it to `ok: false` would raise a false data-integrity
 * warning on /draft). So the CHECK gets its own health row, under its own key.
 * `ok` there means "the tripwire actually ran and vouched for the data" —
 * anything else stamps `last_error` with the reason and a timestamp, and
 * `last_success_at` keeps answering "when did this last really guard us".
 * No migration: coachbuild.ingest_health is keyed by pipeline NAME.
 *
 * Best-effort like every other health write — losing the status must never be
 * confused with the ingest failing.
 *
 * The KEY itself lives in lib/draft/lolalyticsCheck.ts, next to the check it
 * describes: /draft's read path needs it too, and importing this module (which
 * pulls the whole u.gg fetch + champion-list layer) into a request handler to
 * borrow one string would be a real cost for no reason. */
async function recordDirectionCheckHealth(
  sql: NonNullable<ReturnType<typeof getSql>>,
  verdict: "pass" | "fail" | "indeterminate",
  reason: string
): Promise<void> {
  try {
    await recordIngestRun(sql, DIRECTION_CHECK_INGEST_KEY, {
      ok: verdict === "pass",
      error: verdict === "pass" ? null : `${verdict}: ${reason}`,
    });
  } catch {
    // Deliberately swallowed: see this function's doc comment.
  }
}

async function pruneOldPatches(sql: NonNullable<ReturnType<typeof getSql>>): Promise<void> {
  // Keep only the 2 most-recently-ingested distinct patch labels (by
  // MAX(ingested_at), NOT by lexical label sort — "16.9" < "16.14" as plain
  // strings would misorder a >=10 minor version, see this file's own
  // header-adjacent reasoning). Applied to BOTH tables using draft_matchup's
  // recency (they're always ingested in lockstep by this same function).
  const recentRows = (await sql`
    SELECT patch FROM coachbuild.draft_matchup
    GROUP BY patch ORDER BY MAX(ingested_at) DESC LIMIT 2
  `) as unknown as { patch: string }[];
  const keep = recentRows.map((r) => r.patch);
  if (keep.length === 0) return; // nothing ingested yet -- nothing to prune
  await sql`DELETE FROM coachbuild.draft_matchup WHERE patch <> ALL(${keep}::text[])`;
  await sql`DELETE FROM coachbuild.draft_champ_stats WHERE patch <> ALL(${keep}::text[])`;
}

export async function runDraftIngest(opts: DraftIngestOptions = {}): Promise<DraftIngestResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();

  const log = opts.onProgress ?? (() => {});
  const cursor = opts.cursor ?? 0;
  const transport = opts.transport ?? defaultUggTransport;
  const fastFail = opts.fastFailOnRatelimit ?? false;

  const allChampions = opts.champions ?? (await getAllChampions());
  const champIds = Array.from(
    new Set(allChampions.filter((c) => c.id < MAX_REAL_CHAMPION_ID).map((c) => c.id))
  ).sort((a, b) => a - b);

  const result: DraftIngestResult = {
    patch: "",
    champStart: null,
    champCount: 0,
    rowsUpserted: 0,
    statsUpserted: 0,
    skippedRows: 0,
    tierMissingChamps: 0,
    nextCursor: null,
    errors: [],
    retentionRan: false,
    guardOk: null,
    lolalyticsVerdict: null,
  };

  if (champIds.length === 0 || cursor < 0 || cursor >= champIds.length) {
    return result; // nothing to do
  }

  const patchLabel = await resolveDraftPatchLabel();
  const seg = patchSegment(patchLabel);
  result.patch = patchLabel;

  const schema = await resolveUggSchema(makeSchemaProbe(champIds[0], seg, transport));

  const batch = champIds.slice(cursor, cursor + BATCH_SIZE);
  result.champStart = batch[0];
  result.champCount = batch.length;
  result.nextCursor = cursor + BATCH_SIZE < champIds.length ? cursor + BATCH_SIZE : null;

  for (const champId of batch) {
    try {
      const matchups = await pacedUggCall(() => fetchMatchups(champId, seg, schema, transport));
      result.skippedRows += matchups.skippedRows;

      // A retired/renumbered u.gg tier decodes to zero rows and zero skips —
      // indistinguishable from a clean run — unless it says so. It says so.
      // This app shipped Platinum+ data under an "Emerald+" belief for months
      // because a guessed tier id was wrong; the next renumber gets to be an
      // error on the first run instead of a silent no-op (see
      // DecodeMatchupsResult.tierMissing).
      if (matchups.tierMissing) {
        result.tierMissingChamps += 1;
        result.errors.push(
          `champ ${champId}: u.gg tier ${DIAMOND_2_PLUS_TIER} partition ABSENT from an otherwise valid matchups payload ` +
            `(region ${WORLD_REGION} present) -- tier retired or renumbered? Re-read u.gg's bundle before ingesting again.`
        );
        log(`champ ${champId}: TIER ${DIAMOND_2_PLUS_TIER} MISSING from payload`);
      }

      const rankings = await pacedUggCall(() => fetchRankings(champId, seg, schema, transport));

      for (const role of APP_ROLES) {
        const rows = matchups.byRole[role];
        if (!rows || rows.length === 0) continue;

        for (const row of rows) {
          try {
            await sql`
              INSERT INTO coachbuild.draft_matchup (patch, tier, role, champ_id, opp_id, wins, games, ingested_at)
              VALUES (${patchLabel}, ${DIAMOND_2_PLUS_TIER}, ${role}, ${champId}, ${row.oppId}, ${row.wins}, ${row.games}, now())
              ON CONFLICT (patch, tier, role, champ_id, opp_id)
              DO UPDATE SET wins = EXCLUDED.wins, games = EXCLUDED.games, ingested_at = now()
            `;
            result.rowsUpserted += 1;
          } catch (err) {
            result.errors.push(`champ ${champId} role ${role} opp ${row.oppId}: ${(err as Error).message}`);
          }
        }

        // baselineWr derived from the SAME rows just upserted above — sum
        // wins/games across every opponent this champion has a row against
        // in this role, NOT from the rankings fetch (see this file's header).
        const totalWins = rows.reduce((sum, r) => sum + r.wins, 0);
        const totalGames = rows.reduce((sum, r) => sum + r.games, 0);
        if (totalGames <= 0) continue; // nothing to derive a baseline from
        const winrate = totalWins / totalGames;
        const stats = rankings.byRole[role] ?? { pickrate: null, banrate: null };

        try {
          await sql`
            INSERT INTO coachbuild.draft_champ_stats (patch, tier, role, champ_id, winrate, pickrate, banrate, total_games, ingested_at)
            VALUES (${patchLabel}, ${DIAMOND_2_PLUS_TIER}, ${role}, ${champId}, ${winrate}, ${stats.pickrate}, ${stats.banrate}, ${totalGames}, now())
            ON CONFLICT (patch, tier, role, champ_id)
            DO UPDATE SET winrate = EXCLUDED.winrate, pickrate = EXCLUDED.pickrate, banrate = EXCLUDED.banrate,
              total_games = EXCLUDED.total_games, ingested_at = now()
          `;
          result.statsUpserted += 1;
        } catch (err) {
          result.errors.push(`champ ${champId} role ${role} stats: ${(err as Error).message}`);
        }
      }

      log(`champ ${champId}: ${matchups.skippedRows} skipped rows`);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      result.errors.push(`champ ${champId}: ${message}`);
      const status = (err as { status?: number }).status;
      if (fastFail && (status === 403 || status === 429)) {
        log(`champ ${champId}: fast-failing batch on ${status}`);
        break;
      }
    }
  }

  if (result.nextCursor === null) {
    // P0 PERMANENT GUARD (2026-07-21 — see lib/draft/ingestGuard.ts's header
    // for the full incident this closes): a full walk finishing is NOT
    // enough evidence the data is trustworthy — the perspective-inversion
    // bug that prompted this guard satisfied every internal invariant
    // (wins<=games, a stale empirical anchor) while being systematically
    // wrong. Two independent checks must BOTH pass before retention (which
    // deletes the last known-good patch) is allowed to run: the
    // cross-source panel (vs coachless, catches a perspective/schema
    // inversion) and the symmetry check (vs itself, catches decode/keying
    // corruption — see that function's own comment for why these are NOT
    // redundant with each other). A guard failure never deletes anything
    // that's already there — it just refuses to prune, and surfaces the
    // specific failures so a human can investigate before the next run.
    try {
      const [panelResult, symmetryResult] = await Promise.all([
        runDefaultIngestGuard(sql, patchLabel),
        runSymmetryCheck(sql, patchLabel),
      ]);
      result.guardOk = panelResult.ok && symmetryResult.ok;
      if (!panelResult.ok) {
        result.errors.push(`ingest guard (cross-source panel) FAILED: ${panelResult.failures.join("; ")}`);
      }
      if (!symmetryResult.ok) {
        // "could not check" vs "checked and found a problem" — see
        // SymmetryResult.inconclusive. Both skip retention; only one is a
        // reason to go looking at the data.
        result.errors.push(
          symmetryResult.inconclusive
            ? `ingest guard (symmetry check) INCONCLUSIVE: ${symmetryResult.failures.join("; ")}`
            : `ingest guard (symmetry check) FAILED: ${symmetryResult.failures.join("; ")}`
        );
      }
    } catch (err) {
      result.guardOk = false;
      result.errors.push(`ingest guard threw unexpectedly (treated as failed, never silently trusted): ${(err as Error).message}`);
    }

    // EXTERNAL matchup-direction tripwire (2026-07-21, see
    // lib/draft/lolalyticsCheck.ts's header): the two checks above verify
    // BASELINES (cross-source panel) and INTERNAL decode/keying integrity
    // (symmetry) -- neither actually verifies matchup DIRECTION against a
    // third-party source that itself publishes per-matchup winrates. This
    // check does that via lolalytics's SSR counters pages. "fail" (>=2
    // high-sample matchups disagree) blocks retention exactly like the
    // checks above; "indeterminate" (lolalytics markup changed, or too few
    // high-sample matchups were comparable) is logged loudly but NEVER
    // blocks retention on its own -- this guards a third party's page shape,
    // not a dependency this ingest can require to be up.
    try {
      const lolalyticsResult = await runDefaultLolalyticsCheck(
        sql,
        patchLabel,
        allChampions.map((c) => ({ id: c.id, name: c.name ?? "" })),
        opts.lolalyticsTransport
      );
      result.lolalyticsVerdict = lolalyticsResult.verdict;
      if (lolalyticsResult.verdict === "fail") {
        result.errors.push(`lolalytics matchup-direction tripwire FAILED: ${lolalyticsResult.disagreements.join("; ")}`);
      } else if (lolalyticsResult.verdict === "indeterminate") {
        log(`lolalytics matchup-direction tripwire: indeterminate (${lolalyticsResult.reason}) -- not blocking retention`);
      }
      await recordDirectionCheckHealth(sql, lolalyticsResult.verdict, lolalyticsResult.reason);
    } catch (err) {
      // A thrown check (vs. an in-band "indeterminate" verdict) is treated
      // the SAME as indeterminate, not as a failure -- this is a tripwire
      // against a third party's page, never a hard ingest dependency.
      result.lolalyticsVerdict = "indeterminate";
      log(`lolalytics matchup-direction tripwire threw unexpectedly (treated as indeterminate, non-blocking): ${(err as Error).message}`);
      await recordDirectionCheckHealth(sql, "indeterminate", `check threw: ${(err as Error).message}`);
    }

    const retentionSafe = result.guardOk && result.lolalyticsVerdict !== "fail";
    if (retentionSafe) {
      try {
        await pruneOldPatches(sql);
        result.retentionRan = true;
      } catch (err) {
        result.errors.push(`retention prune failed: ${(err as Error).message}`);
      }
    } else if (!result.guardOk) {
      log("ingest guard failed -- retention SKIPPED, existing data left in place for investigation");
    } else {
      log("lolalytics matchup-direction tripwire FAILED -- retention SKIPPED, existing data left in place for investigation");
    }
  }

  return result;
}

// Re-exported so callers (route/script) can reference these without a
// second import path.
export { WORLD_REGION, DIAMOND_2_PLUS_TIER };
