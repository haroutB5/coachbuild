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
import { getAllChampions } from "@/lib/staticData";
import type { RoleId } from "@/lib/types";
import {
  EMERALD_TIER,
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
  champions?: { id: number }[];
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
  const champIds = Array.from(new Set(allChampions.map((c) => c.id))).sort((a, b) => a - b);

  const result: DraftIngestResult = {
    patch: "",
    champStart: null,
    champCount: 0,
    rowsUpserted: 0,
    statsUpserted: 0,
    skippedRows: 0,
    nextCursor: null,
    errors: [],
    retentionRan: false,
    guardOk: null,
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

      const rankings = await pacedUggCall(() => fetchRankings(champId, seg, schema, transport));

      for (const role of APP_ROLES) {
        const rows = matchups.byRole[role];
        if (!rows || rows.length === 0) continue;

        for (const row of rows) {
          try {
            await sql`
              INSERT INTO coachbuild.draft_matchup (patch, tier, role, champ_id, opp_id, wins, games, ingested_at)
              VALUES (${patchLabel}, ${EMERALD_TIER}, ${role}, ${champId}, ${row.oppId}, ${row.wins}, ${row.games}, now())
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
            VALUES (${patchLabel}, ${EMERALD_TIER}, ${role}, ${champId}, ${winrate}, ${stats.pickrate}, ${stats.banrate}, ${totalGames}, now())
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
        result.errors.push(`ingest guard (symmetry check) FAILED: ${symmetryResult.failures.join("; ")}`);
      }
    } catch (err) {
      result.guardOk = false;
      result.errors.push(`ingest guard threw unexpectedly (treated as failed, never silently trusted): ${(err as Error).message}`);
    }

    if (result.guardOk) {
      try {
        await pruneOldPatches(sql);
        result.retentionRan = true;
      } catch (err) {
        result.errors.push(`retention prune failed: ${(err as Error).message}`);
      }
    } else {
      log("ingest guard failed -- retention SKIPPED, existing data left in place for investigation");
    }
  }

  return result;
}

// Re-exported so callers (route/script) can reference these without a
// second import path.
export { WORLD_REGION, EMERALD_TIER };
