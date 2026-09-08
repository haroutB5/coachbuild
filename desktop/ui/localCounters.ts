import { loadDdragon } from "@/lib/ddragonClient";
import { resolveCountersForEnemy, LOLALYTICS_LANE_BY_ROLE, type LolalyticsCountersRoleId } from "@/lib/lolalytics/counters";
import type { DraftCountersParams, DraftCountersResponse } from "@/components/live/draftCounters";
import { localBridgeFetch } from "./localBridge";

const cache = new Map<string, { expires: number; data: DraftCountersResponse }>();
export async function loadLocalCounters(params: DraftCountersParams, signal?: AbortSignal): Promise<DraftCountersResponse> {
  const { version, champions } = await loadDdragon();
  const enemy = champions.find(c => c.id === params.enemy);
  const lane = LOLALYTICS_LANE_BY_ROLE[params.lane as LolalyticsCountersRoleId];
  if (!enemy || !lane) throw new Error("Invalid counter selection");
  const patch = version.split(".").slice(0, 2).join(".");
  const key = `${enemy.id}:${lane}:${patch}`;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  const result = await resolveCountersForEnemy(enemy, lane, patch, {
    champions,
    fetchImpl: (url) => {
      const source = new URL(url);
      const query = new URLSearchParams(source.search);
      query.set("slug", source.pathname.split("/")[2]);
      return localBridgeFetch(`/draft/counters-html?${query}`, signal);
    },
  });
  const data = { ...result, enemy: { id: enemy.id, name: enemy.name, slug: result.enemySlug }, lane: params.lane };
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 86400000, data });
  return data;
}
