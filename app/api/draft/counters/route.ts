import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { getAllChampions, getChampionById } from "@/lib/staticData";
import { resolveDraftPatchLabel } from "@/lib/draft/patch";
import { runtimeLastGoodStore } from "@/lib/lastGood";
import {
  LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS,
  LOLALYTICS_COUNTERS_TIER,
  LOLALYTICS_LANE_BY_ROLE,
  LolalyticsCountersError,
  championSlugForCounters,
  resolveCountersForEnemy,
  type CounterSuggestion,
  type LolalyticsCountersRoleId,
  type ResolvedCounters,
} from "@/lib/lolalytics/counters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Runtime-cache namespace for on-demand enemy pages (brief: keys
 *  namespaced `lola:counters:*`; the store itself lives under the shared
 *  getCache() namespace beside the last-good entries in lib/lastGood.ts —
 *  no new tables, no Neon involvement at all). */
export function countersCacheKey(slug: string, lane: string, tier: string, patch: string): string {
  return `lola:counters:v1:${slug}:${lane}:${tier}:${patch}`;
}

export interface DraftCountersResponse {
  enemy: { id: number; name: string; slug: string };
  lane: LolalyticsCountersRoleId;
  tier: string;
  patch: string;
  fetchedAt: string;
  suggestions: CounterSuggestion[];
  /** Whole-page honesty counters (see lib/lolalytics/counters.ts). */
  parsedRows: number;
  skippedCards: number;
  gatedRows: number;
  unmappedRows: number;
  directionAgreements: number;
}

function toResponse(resolved: ResolvedCounters, lane: LolalyticsCountersRoleId): DraftCountersResponse {
  return {
    enemy: { id: resolved.enemyChampId, name: resolved.enemyName, slug: resolved.enemySlug },
    lane,
    tier: resolved.tier,
    patch: resolved.patch,
    fetchedAt: resolved.fetchedAt,
    suggestions: resolved.suggestions,
    parsedRows: resolved.parsedRows,
    skippedCards: resolved.skippedCards,
    gatedRows: resolved.gatedRows,
    unmappedRows: resolved.unmappedRows,
    directionAgreements: resolved.directionAgreements,
  };
}

function parseLane(raw: string | null): LolalyticsCountersRoleId | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const lane = parseInt(raw, 10);
  return lane >= 0 && lane <= 4 ? (lane as LolalyticsCountersRoleId) : null;
}

function parseEnemy(raw: string | null): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GET /api/draft/counters?enemy=<champId>&lane=<0-4>
 *
 * On-demand counter picks for ONE enemy champion in the user's lane: fetches
 * the enemy's own lolalytics counters page (plain GET, ~1.4MB SSR HTML),
 * parses + ranks the champions the enemy is weak against, and caches the
 * result 24h in the runtime cache keyed per (enemy, lane, tier, patch).
 * Populated responses take the same 5-minute edge window as the other draft
 * routes; empties and errors are never edge-cached. Typed upstream/parse
 * failures are 502s with a machine-readable `reason` (the client renders a
 * one-line note, never silent nothing). */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const enemyId = parseEnemy(searchParams.get("enemy"));
  if (enemyId === null) {
    const body: ApiError = { error: "Missing or invalid enemy param (numeric champion id)" };
    return NextResponse.json(body, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const lane = parseLane(searchParams.get("lane"));
  if (lane === null) {
    const body: ApiError = { error: "Invalid lane (must be 0-4 -- 5/auto is not a concrete lane)" };
    return NextResponse.json(body, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const enemy = await getChampionById(enemyId).catch(() => null);
  if (!enemy) {
    const body: ApiError = { error: `Unknown champion id ${enemyId}` };
    return NextResponse.json(body, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const [champions, patch] = await Promise.all([getAllChampions(), resolveDraftPatchLabel()]);
    const laneSlug = LOLALYTICS_LANE_BY_ROLE[lane];
    const store = runtimeLastGoodStore();
    const slug = championSlugForCounters(enemy.name);
    const key = countersCacheKey(slug, laneSlug, LOLALYTICS_COUNTERS_TIER, patch);

    const cached = await store.get<ResolvedCounters>(key);
    if (cached && Array.isArray(cached.suggestions)) {
      return NextResponse.json(toResponse(cached, lane), {
        status: 200,
        headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=600" },
      });
    }

    const resolved = await resolveCountersForEnemy({ id: enemy.id, name: enemy.name }, laneSlug, patch, {
      champions,
    });
    if (resolved.skippedCards > 0 || resolved.unmappedRows > 0) {
      // Partial shape drift or a champion-list gap: served (the ranked rows
      // are still real), but LOUD in the function log — this is the early
      // warning before a full page-shape break turns into 502s.
      console.warn(
        `[/api/draft/counters] ${slug}/${laneSlug}/${patch}: ` +
          `${resolved.parsedRows} parsed, ${resolved.skippedCards} skipped cards, ` +
          `${resolved.unmappedRows} unmapped rows, ${resolved.directionAgreements} direction agreements`
      );
    }
    // Cache the successful parse only — a typed drift/fetch failure must
    // retry next request, never serve a cemented error for 24h.
    await store.set(key, resolved, LOLALYTICS_COUNTERS_CACHE_TTL_SECONDS);

    const populated = resolved.suggestions.length > 0;
    return NextResponse.json(toResponse(resolved, lane), {
      status: 200,
      headers: { "Cache-Control": populated ? "s-maxage=300, stale-while-revalidate=600" : "no-store" },
    });
  } catch (err) {
    if (err instanceof LolalyticsCountersError) {
      console.error(`[/api/draft/counters] ${err.code}: ${err.message}`);
      const body: ApiError & { reason: string } = { error: "Counter-pick data unavailable", detail: err.message, reason: err.code };
      return NextResponse.json(body, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/draft/counters] Unexpected error:", err);
    const body: ApiError = { error: "Internal server error" };
    return NextResponse.json(body, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
