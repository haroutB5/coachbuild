// ─────────────────────────────────────────────────────────────────────────────
// lib/status/collect.ts — gathers the FACTS behind /status and hands them to
// the pure verdicts in ./verdicts.ts.
//
// Every fact is fetched under its own try/catch and degrades to "unknown" (a
// fail verdict with the error in the detail) rather than throwing: a status
// page that 500s when the database is down reports nothing about the one
// thing it exists to report.
//
// BOUNDED. A module-level cache + single-flight guard (the same pattern as
// lib/patchMoversCache.ts) means a warm instance answers a burst of requests
// with ONE collection per STATUS_TTL_MS, and the route on top adds
// `s-maxage=60` at the CDN. A page anyone can refresh must not be able to
// turn into a load source against Neon; the whole collection is five cheap
// queries (measured 2026-09-02 on production: 34–255 ms each, the slowest
// being `max(created_at)` over 14,887 pro_matches rows) but "cheap" times "a
// monitor polling every second" is how quotas get spent.
//
// THE ARTIFACT IS READ FROM THE BUILD, not fetched. `public/consensus/
// item-set-consensus.json` is imported at build time, so the patch and
// coverage reported here are those of the file THIS deployment serves — the
// re-bake commits and deploys as one step, so the two cannot disagree — with
// no self-request, no host detection and no CDN read in the way.
// ─────────────────────────────────────────────────────────────────────────────

import { getLatestPatchStatus } from "@/lib/staticData";
import { getSql } from "@/lib/pro/db";
import { resolveServingPatch } from "@/lib/draft/servingPatch";
import { DIAMOND_2_PLUS_TIER } from "@/lib/draft/ugg";
import { getIngestHealth } from "@/lib/ingestHealth";
import { parseConsensusArtifact } from "@/components/hextech/consensusArtifact";
import artifactJson from "@/public/consensus/item-set-consensus.json";
import {
  judgeArtifactAge,
  judgeArtifactPatch,
  judgeCoverage,
  judgeDb,
  judgeDraft,
  judgeLivePatch,
  judgeMatchesIngest,
  overallVerdict,
  type DraftFact,
  type LivePatchFact,
  type StatusCheck,
  type Verdict,
} from "@/lib/status/verdicts";

export const STATUS_TTL_MS = 60 * 1000;

export interface StatusReport {
  /** When these facts were collected (ISO). A CDN or in-process cache hit
   *  reports the ORIGINAL collection time, which is the honest one. */
  generatedAt: string;
  /** The web build answering. */
  version: string | null;
  overall: Verdict;
  checks: StatusCheck[];
}

type Sql = NonNullable<ReturnType<typeof getSql>>;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function livePatchFact(): Promise<LivePatchFact | null> {
  try {
    const p = await getLatestPatchStatus();
    return { label: p.patch.label, ok: p.ok };
  } catch {
    return null;
  }
}

async function dbFact(sql: Sql | null): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  if (!sql) return { ok: false, error: "DATABASE_URL not configured" };
  const t0 = Date.now();
  try {
    await sql`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: `unreachable: ${errMsg(err)}` };
  }
}

async function latestMatchFact(sql: Sql): Promise<string | null> {
  const rows = (await sql`SELECT max(created_at) AS latest FROM coachbuild.pro_matches`) as unknown as {
    latest: string | null;
  }[];
  return rows[0]?.latest ?? null;
}

async function draftFact(sql: Sql): Promise<DraftFact> {
  // resolveServingPatch is THE definition of "which patch is /draft serving";
  // it is reused rather than copied so this page cannot come to a different
  // answer from the route it is checking (lib/draft/servingPatch.ts header).
  const servingPatch = await resolveServingPatch(sql);
  let champs = 0;
  let latestIngestedAt: string | null = null;
  if (servingPatch) {
    const rows = (await sql`
      SELECT count(DISTINCT champ_id)::int AS champs, max(ingested_at) AS latest
      FROM coachbuild.draft_champ_stats
      WHERE tier = ${DIAMOND_2_PLUS_TIER} AND patch = ${servingPatch}
    `) as unknown as { champs: number; latest: string | null }[];
    champs = rows[0]?.champs ?? 0;
    latestIngestedAt = rows[0]?.latest ?? null;
  }
  const health = await getIngestHealth(sql, "draft").catch(() => null);
  return {
    servingPatch,
    champs,
    latestIngestedAt,
    ingestOk: health?.ok ?? null,
    ingestLastError: health?.ok === false ? health.lastError : null,
  };
}

/** One full collection. Exported for tests; production goes through
 *  `collectStatus` below so the cache is never bypassed by accident. */
export async function collectStatusUncached(now: () => number = Date.now): Promise<StatusReport> {
  const t = now();
  const artifact = parseConsensusArtifact(artifactJson);
  const sql = getSql();

  const [live, db] = await Promise.all([livePatchFact(), dbFact(sql)]);

  let latestMatch: string | null = null;
  let draft: DraftFact | null = null;
  const dbErrors: string[] = [];
  if (db.ok && sql) {
    const [m, d] = await Promise.allSettled([latestMatchFact(sql), draftFact(sql)]);
    if (m.status === "fulfilled") latestMatch = m.value;
    else dbErrors.push(`pro_matches: ${errMsg(m.reason)}`);
    if (d.status === "fulfilled") draft = d.value;
    else dbErrors.push(`draft: ${errMsg(d.reason)}`);
  }

  const checks: StatusCheck[] = [
    judgeLivePatch(live),
    judgeArtifactPatch(artifact?.patch ?? null, live?.label ?? null),
    judgeArtifactAge(artifact?.generatedAt ?? null, t),
    judgeDb(db),
    judgeMatchesIngest(latestMatch, t, db.ok && !dbErrors.some((e) => e.startsWith("pro_matches"))),
    judgeDraft(draft, t, db.ok),
    judgeCoverage(artifact?.coverage ?? null),
  ];
  // A query that threw after SELECT 1 succeeded is its own line: the verdict
  // functions above already say "not checked", this says why.
  for (const e of dbErrors) {
    checks.push({ id: "neon-query", label: "Neon query failed", verdict: "fail", detail: e, at: null });
  }

  return {
    generatedAt: new Date(t).toISOString(),
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
    overall: overallVerdict(checks),
    checks,
  };
}

let cached: { report: StatusReport; at: number } | null = null;
let inFlight: Promise<StatusReport> | null = null;

export function __resetStatusCacheForTests(): void {
  cached = null;
  inFlight = null;
}

export function collectStatus(now: () => number = Date.now): Promise<StatusReport> {
  const t = now();
  if (cached && t - cached.at < STATUS_TTL_MS) return Promise.resolve(cached.report);
  if (inFlight) return inFlight;
  inFlight = collectStatusUncached(now)
    .then((report) => {
      cached = { report, at: t };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
