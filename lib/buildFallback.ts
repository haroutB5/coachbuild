// ─────────────────────────────────────────────────────────────────────────────
// lib/buildFallback.ts — degrade instead of empty: the /api/build decision
// between a fresh answer, a labelled stale copy, a real 404 and a real error.
//
// Lives in lib/ rather than the route so it can be tested with an injected
// store and a throwing compute function (route files export only handlers).
//
// THE CONTRACT, in order:
//   fresh       compute() returned at least one build. Remembered under `key`
//               (awaited, swallowed — the write is one runtime-cache call and
//               a serverless function may not outlive an un-awaited promise)
//               and returned unchanged.
//   not-played  compute() threw NotPlayedInRoleError or returned nothing. A
//               REAL ANSWER about the data, not a failure, so it is NOT
//               papered over with an old copy: a champion-role that dropped
//               off the new patch must read as absent, exactly as it would
//               with no cache, or coverage numbers and the 404 contract stop
//               meaning anything.
//   stale       compute() threw anything else (a coachless 403, a timeout, a
//               5xx) and the store holds a copy. Every build in the copy is
//               returned with `stale: true` and `asOf` set to when the copy was
//               stored, so the UI can say so quietly and nothing downstream
//               has to guess.
//   error       threw, and no copy. The same 500 as before this module.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse } from "@/lib/types";
import { NotPlayedInRoleError } from "@/lib/recommend";
import { LAST_GOOD_TTL_SECONDS, type LastGoodStore } from "@/lib/lastGood";

/** Bumped when BuildResponse changes shape in a way an old copy must not
 *  satisfy. Part of the key, so a deploy that bumps it simply misses. */
export const BUILD_LAST_GOOD_SCHEMA = 1;

export interface StoredBuild {
  builds: BuildResponse[];
  /** ISO. When this copy was computed — the `asOf` the stale response carries. */
  asOf: string;
}

export type BuildResolution =
  | { kind: "fresh"; builds: BuildResponse[] }
  | { kind: "stale"; builds: BuildResponse[]; asOf: string }
  | { kind: "not-played"; detail: string }
  | { kind: "error"; error: unknown };

/** One key per (champion, role, bracket, matchup). The matchup dimension is
 *  dead upstream today (coachless 403s it) but it changes the response when it
 *  is not, so it belongs in the key. */
export function buildLastGoodKey(
  championId: number,
  roleId: number,
  rankBracketId: string,
  enemyChampionId: number | null
): string {
  return `build:${BUILD_LAST_GOOD_SCHEMA}:${championId}:${roleId}:${rankBracketId}:${enemyChampionId ?? "-"}`;
}

export async function resolveBuildWithFallback(opts: {
  key: string;
  compute: () => Promise<BuildResponse[]>;
  store: LastGoodStore;
  now?: () => number;
  ttlSeconds?: number;
}): Promise<BuildResolution> {
  const now = opts.now ?? Date.now;
  let builds: BuildResponse[];
  try {
    builds = await opts.compute();
  } catch (err) {
    if (err instanceof NotPlayedInRoleError) return { kind: "not-played", detail: err.message };
    const copy = await opts.store.get<StoredBuild>(opts.key);
    if (copy && Array.isArray(copy.builds) && copy.builds.length > 0 && typeof copy.asOf === "string") {
      return {
        kind: "stale",
        asOf: copy.asOf,
        builds: copy.builds.map((b) => ({ ...b, stale: true as const, asOf: copy.asOf })),
      };
    }
    return { kind: "error", error: err };
  }
  if (!builds || builds.length === 0) return { kind: "not-played", detail: "no builds" };
  const stored: StoredBuild = { builds, asOf: new Date(now()).toISOString() };
  await opts.store.set(opts.key, stored, opts.ttlSeconds ?? LAST_GOOD_TTL_SECONDS);
  return { kind: "fresh", builds };
}
