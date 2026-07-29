import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./_env.mjs";
import type { ItemDetail } from "@/components/itemDetail";
import { classifyFeaturedItem, resolveFullBuild } from "@/lib/otp/featuredBuild";
import { buildFeaturedModel, type FeaturedMatchRow } from "@/lib/otp/featured";
loadEnvLocal();
const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
const ver: string = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json())[0];
const raw = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`)).json()).data as Record<string, any>;
const META = new Map<number, ItemDetail>();
for (const [id, m] of Object.entries(raw))
  META.set(Number(id), { id: Number(id), name: m.name, goldTotal: m.gold?.total ?? 0, descriptionText: "", into: m.into ?? [], from: m.from ?? [], tags: m.tags ?? [], purchasable: m.gold?.purchasable !== false } as ItemDetail);
const classOf = (id: number) => classifyFeaturedItem(id, META.get(id), META);
const feats = (await sql`SELECT champion_id, game_name, puuid FROM coachbuild.otp_featured ORDER BY champion_id`) as any[];
for (const f of feats) {
  const matches = (await sql`SELECT win, final_items, runes, spells FROM coachbuild.otp_matches WHERE puuid = ${f.puuid} AND champion_id = ${f.champion_id} ORDER BY game_creation DESC`) as FeaturedMatchRow[];
  const model = buildFeaturedModel(matches);
  if (model.games < 12) continue;
  const b = resolveFullBuild(model.items, model.gameLog, model.games, classOf);
  if (!b) console.log(`NULL branch: champion ${f.champion_id} — ${f.game_name}, ${model.games} stored games`);
}
