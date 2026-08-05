// Per-patch recommendation signatures used exclusively for measured My Stats
// build adherence. A row is inserted once and then retained unchanged: a game
// is always compared with the signature captured for its own patch, never a
// later live recommendation.

import type { NeonQueryFunction } from "@neondatabase/serverless";

export type MyStatsSql = NeonQueryFunction<false, false>;

export interface RecommendedSignature {
  coreItemIds: number[];
  keystoneId: number;
}

interface SnapshotRow {
  core_item_ids: number[];
  keystone_id: number;
}

export async function findRecommendationSnapshot(
  sql: MyStatsSql,
  patch: string,
  championId: number,
  role: number
): Promise<RecommendedSignature | null> {
  const rows = (await sql`
    SELECT core_item_ids, keystone_id
    FROM coachbuild.my_build_recommendation_snapshots
    WHERE patch = ${patch}
      AND champion_id = ${championId}
      AND role = ${role}
  `) as unknown as SnapshotRow[];
  const row = rows[0];
  if (!row || !Array.isArray(row.core_item_ids) || row.core_item_ids.length !== 3) return null;
  return {
    coreItemIds: row.core_item_ids,
    keystoneId: row.keystone_id,
  };
}

/**
 * Preserve the first recommendation served for this exact patch/champion/role.
 * The conflict branch writes the existing patch value back to itself solely so
 * PostgreSQL returns the canonical stored signature; it never overwrites the
 * rune or items that define what "on build" meant for prior games.
 */
export async function captureRecommendationSnapshot(
  sql: MyStatsSql,
  patch: string,
  championId: number,
  role: number,
  signature: RecommendedSignature
): Promise<RecommendedSignature> {
  const rows = (await sql`
    INSERT INTO coachbuild.my_build_recommendation_snapshots (
      patch, champion_id, role, keystone_id, core_item_ids
    ) VALUES (
      ${patch}, ${championId}, ${role}, ${signature.keystoneId}, ${signature.coreItemIds}::integer[]
    )
    ON CONFLICT (patch, champion_id, role) DO UPDATE
      SET patch = coachbuild.my_build_recommendation_snapshots.patch
    RETURNING core_item_ids, keystone_id
  `) as unknown as SnapshotRow[];
  const canonical = rows[0];
  if (!canonical) throw new Error("recommendation snapshot insert did not return a row");
  return {
    coreItemIds: canonical.core_item_ids,
    keystoneId: canonical.keystone_id,
  };
}
