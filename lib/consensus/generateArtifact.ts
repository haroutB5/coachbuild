// ─────────────────────────────────────────────────────────────────────────────
// generateArtifact.ts — the generation core for the per-patch precomputed
// shop-export consensus (components/hextech/consensusArtifact.ts).
//
// This is deliberately a LIBRARY, not the body of a script. The thing being
// generated is a file the in-game shop panel trusts absolutely — an entry
// written as `null` tells the export "this champion genuinely has no pro data,
// omit the block" and the export does not second-guess it — so the rules about
// what may and may not be written need tests, and a `.mts` entry point that
// parses argv and calls `process.exit` cannot have any. `scripts/generate-
// consensus-artifact.mts` is the CLI: argv, stdout, file write. Everything
// that decides CONTENT is here.
//
// Every I/O edge is injected (`deps`), so the whole generator runs against
// fixtures with no network, no deployment and — crucially, while the Neon
// quota is exhausted until ~2026-09-01 — no database.
// ─────────────────────────────────────────────────────────────────────────────

import type { ChampionRef } from "@/lib/types";
import type { ItemDetail } from "@/components/itemDetail";
import type { ProGame, ProGamesApiResponse } from "@/components/proGames.types";
import { aggregateProConsensus } from "@/components/hextech/proConsensus";
import {
  CONSENSUS_ARTIFACT_SCHEMA,
  consensusArtifactKey,
  consensusRequestPath,
  currentConsensusQuery,
  normalizePatchLabel,
  reduceConsensusModel,
  type ConsensusArtifact,
  type ConsensusArtifactEntry,
  type ConsensusArtifactSource,
  type ConsensusSource,
} from "@/components/hextech/consensusArtifact";

/** The five real lanes, as RoleIds. Role 5 ("auto", the Builds page's default
 *  state) is deliberately NOT generated: the export always resolves a concrete
 *  lane before it builds a set (`LANE_TO_ROLE_ID`), so a role-5 entry could
 *  never be looked up and would only inflate the file. */
export const ARTIFACT_ROLES = [0, 1, 2, 3, 4] as const;

export interface GenerateDeps {
  /** Absolute-URL fetch. Given the full URL, returns the parsed body. Must
   *  THROW on a non-2xx — a failed combo has to be distinguishable from an
   *  empty one here for exactly the same reason it does in the export. */
  fetchJson: <T>(url: string) => Promise<T>;
  listChampions: () => Promise<ChampionRef[]>;
  /** ddragon item metadata at the version derived from the patch. */
  loadItemMeta: (patch: string) => Promise<Map<number, ItemDetail>>;
  now?: () => Date;
  onProgress?: (done: number, total: number) => void;
}

export interface GenerateOptions {
  base: string;
  /** `major.minor`. When absent, read off a real `/api/build` response — see
   *  `resolveArtifactPatch`. */
  patch?: string | null;
  championIds?: number[] | null;
  concurrency?: number;
  /** Fraction of attempted champion-roles that must resolve before anything is
   *  returned. Below it, `generateConsensusArtifact` THROWS. */
  minCoverage?: number;
}

export interface GenerateReport {
  artifact: ConsensusArtifact;
  attempted: number;
  resolved: number;
  coverage: number;
  /** One line per failed (combo, source). Never silently dropped. */
  failures: string[];
}

/** The patch label the artifact is stamped with, read off a REAL `/api/build`
 *  response rather than derived from ddragon.
 *
 *  This is the other operand of the export's freshness test: at export time the
 *  client compares `artifact.patch` against `BuildResponse.patch`. Deriving it
 *  independently would create a second definition of "the current patch", and
 *  any formatting or timing difference between the two would leave the artifact
 *  permanently STALE — a fallback that silently never fires, which is the
 *  worst failure mode available here because everything continues to work while
 *  the entire point of the exercise is quietly disabled. Reading the exact
 *  string the comparison will see removes the class outright.
 *
 *  Walks the roles because a given champion is not played in every one of them
 *  (`/api/build` answers 404 for those) — one unlucky seed must not abort a run. */
export async function resolveArtifactPatch(
  opts: GenerateOptions,
  deps: GenerateDeps,
  seedChampionId: number
): Promise<string> {
  if (opts.patch) {
    const normalized = normalizePatchLabel(opts.patch);
    if (!normalized) throw new Error(`patch "${opts.patch}" is not a major.minor label`);
    return normalized;
  }
  for (const role of ARTIFACT_ROLES) {
    try {
      const build = await deps.fetchJson<{ patch?: string }>(
        `${opts.base}/api/build?champ=${seedChampionId}&role=${role}`
      );
      const normalized = normalizePatchLabel(build?.patch);
      if (normalized) return normalized;
    } catch {
      /* not played in this role, or a transient probe failure — try the next */
    }
  }
  throw new Error(
    `Could not read a patch label from ${opts.base}/api/build for championId=${seedChampionId}. ` +
      `Pass an explicit patch.`
  );
}

interface ComboResult {
  key: string;
  entry: ConsensusArtifactEntry | null;
  errors: string[];
}

/** One (champion, role), both sources.
 *
 *  PARTIAL SUCCESS IS FAILURE, and that is the single most important rule in
 *  this file. Writing `{pro: <data>, otp: null}` when the OTP request never
 *  answered publishes "this champion has no one-tricks" as a fact, and the
 *  export believes stored nulls without falling back — so one flaky request
 *  during generation would silently delete a block from the shop panel for the
 *  rest of the patch. An omitted combo, by contrast, is read as "not covered"
 *  and answered with a live query. Omission is recoverable; a wrong `null` is
 *  not. */
export async function resolveArtifactCombo(
  opts: GenerateOptions,
  deps: GenerateDeps,
  championId: number,
  role: number,
  itemMeta: Map<number, ItemDetail>
): Promise<ComboResult> {
  const key = consensusArtifactKey(championId, role);
  const errors: string[] = [];
  const out: Partial<Record<ConsensusSource, ConsensusArtifactSource | null>> = {};

  for (const source of ["pro", "otp"] as const) {
    try {
      const body = await deps.fetchJson<ProGamesApiResponse>(
        `${opts.base}${consensusRequestPath(source, championId, role)}`
      );
      const games = (Array.isArray(body?.games) ? body.games : []) as ProGame[];
      // Mirrors the live path exactly, including its order: the empty-sample
      // check comes first and means genuine absence, and everything else goes
      // through the one shared reduction.
      out[source] = games.length === 0 ? null : reduceConsensusModel(aggregateProConsensus(games, itemMeta));
    } catch (err) {
      errors.push(`${source} ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (errors.length > 0) return { key, entry: null, errors };
  return { key, entry: { pro: out.pro ?? null, otp: out.otp ?? null }, errors };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function generateConsensusArtifact(
  opts: GenerateOptions,
  deps: GenerateDeps
): Promise<GenerateReport> {
  const minCoverage = opts.minCoverage ?? 0.95;
  const all = await deps.listChampions();
  const champions = opts.championIds ? all.filter((c) => opts.championIds!.includes(c.id)) : all;
  if (champions.length === 0) throw new Error("No champions resolved — check the champion filter / CDN reachability.");

  const patch = await resolveArtifactPatch(opts, deps, champions[0].id);

  // ONE item-metadata map for the whole run, at the version the browser derives
  // from the same patch label. The classification chain (isBootsItem /
  // isBuildItem, the starter and support-final partitions) reads this map, so a
  // version difference here would change what the numbers MEAN, not just which
  // icons render.
  const itemMeta = await deps.loadItemMeta(patch);
  if (itemMeta.size === 0) {
    // An empty map is not a degraded run, it is a wrong one: `isBuildItem`
    // treats an unknown id as "not a completed item" (its own documented
    // tradeoff), so every sample would reduce to nothing and every entry would
    // be written as an explicit `null` — a patch-long outage, baked into a file
    // and served with confidence. The live path can afford to degrade here
    // because its result lives for one export; this one lives for a patch.
    throw new Error(
      `Item metadata for patch ${patch} came back EMPTY. Refusing to generate — every entry would ` +
        `reduce to null and the artifact would suppress every Pro and OTP block for the whole patch.`
    );
  }

  const combos: Array<{ championId: number; role: number }> = [];
  for (const champ of champions) for (const role of ARTIFACT_ROLES) combos.push({ championId: champ.id, role });

  let done = 0;
  const results = await mapWithConcurrency(combos, opts.concurrency ?? 4, async (combo) => {
    const r = await resolveArtifactCombo(opts, deps, combo.championId, combo.role, itemMeta);
    deps.onProgress?.(++done, combos.length);
    return r;
  });

  const entries: Record<string, ConsensusArtifactEntry> = {};
  const failures: string[] = [];
  let pro = 0;
  let otp = 0;
  for (const r of results) {
    if (!r.entry) {
      failures.push(...r.errors);
      continue;
    }
    entries[r.key] = r.entry;
    if (r.entry.pro) pro++;
    if (r.entry.otp) otp++;
  }

  const resolved = Object.keys(entries).length;
  const coverage = resolved / combos.length;
  if (coverage < minCoverage) {
    throw new Error(
      `Coverage ${(coverage * 100).toFixed(1)}% is below the ${(minCoverage * 100).toFixed(1)}% floor — ` +
        `refusing to produce an artifact. A thin one suppresses blocks for a whole patch cycle, and the ` +
        `previous artifact (or the live query) is a better answer than a bad one. ` +
        `First failure: ${failures[0] ?? "none recorded"}`
    );
  }

  return {
    artifact: {
      schema: CONSENSUS_ARTIFACT_SCHEMA,
      patch,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      query: currentConsensusQuery(),
      coverage: { combos: resolved, pro, otp },
      entries,
    },
    attempted: combos.length,
    resolved,
    coverage,
    failures,
  };
}
