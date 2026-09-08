import type { ChampionRef } from "./types";

let pending: Promise<{ version: string; champions: ChampionRef[] }> | null = null;

/** Browser-only CDN data; no application API or database is involved. */
export function loadDdragon(): Promise<{ version: string; champions: ChampionRef[] }> {
  if (pending) return pending;
  pending = (async () => {
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json", { signal: AbortSignal.timeout(15000) });
    if (!versions.ok) throw new Error("Champion version unavailable");
    const [version] = await versions.json() as string[];
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid champion version");
    const response = await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Champion data unavailable");
    const { data } = await response.json() as { data: Record<string, { key: string; id: string; name: string; info: { difficulty: number }; tags: string[] }> };
    const champions = Object.values(data).map(c => ({
      id: Number(c.key), key: c.id, name: c.name,
      icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${c.id}.png`,
      difficulty: c.info.difficulty, tags: c.tags,
    }));
    if (!champions.length) throw new Error("Empty champion data");
    return { version, champions };
  })().catch(error => { pending = null; throw error; });
  return pending;
}
