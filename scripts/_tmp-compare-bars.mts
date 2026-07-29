// Before/after on ONE methodology. The OLD bar (4 total finished items,
// snowball EXCLUDED) and the NEW bar (5 non-boots + boots, snowball INCLUDED),
// both using the real classifier. The new-bar column is cross-checked against
// resolveFullBuild itself so the inline grouping below can be trusted.
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./_env.mjs";
import type { ItemDetail } from "@/components/itemDetail";
import { classifyFeaturedItem, resolveFullBuild } from "@/lib/otp/featuredBuild";
import { buildFeaturedModel, type FeaturedMatchRow } from "@/lib/otp/featured";

loadEnvLocal();
const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
const MIN_SAMPLE_GAMES = 12;

const ver: string = (await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json())[0];
const raw = (await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`)).json()).data as Record<string, any>;
const META = new Map<number, ItemDetail>();
for (const [id, m] of Object.entries(raw)) {
  META.set(Number(id), { id: Number(id), name: m.name, goldTotal: m.gold?.total ?? 0, descriptionText: "", into: m.into ?? [], from: m.from ?? [], tags: m.tags ?? [], purchasable: m.gold?.purchasable !== false } as ItemDetail);
}
const classOf = (id: number) => classifyFeaturedItem(id, META.get(id), META);

const feats = (await sql`SELECT champion_id, game_name, puuid FROM coachbuild.otp_featured ORDER BY champion_id`) as any[];
const old_: Record<string, number> = {};
const new_: Record<string, number> = {};
const newReal: Record<string, number> = {};

for (const f of feats) {
  const matches = (await sql`SELECT win, final_items, runes, spells FROM coachbuild.otp_matches WHERE puuid = ${f.puuid} AND champion_id = ${f.champion_id} ORDER BY game_creation DESC`) as FeaturedMatchRow[];
  const model = buildFeaturedModel(matches);
  if (model.games < MIN_SAMPLE_GAMES) {
    old_["thin-sample"] = (old_["thin-sample"] ?? 0) + 1;
    new_["thin-sample"] = (new_["thin-sample"] ?? 0) + 1;
    newReal["thin-sample"] = (newReal["thin-sample"] ?? 0) + 1;
    continue;
  }
  const branchFor = (keepSnowball: boolean, fullRule: (nb: number, boots: number, total: number) => boolean, floor: number) => {
    const counts = new Map<string, number>();
    let showable = 0;
    for (const g of model.gameLog) {
      const held = [...new Set(g.items)].filter((id) => {
        const c = classOf(id);
        return c === "completed" || c === "boots" || (keepSnowball && c === "snowball");
      });
      if (held.length < floor || held.length > 6) continue;
      showable++;
      const boots = held.filter((id) => classOf(id) === "boots").length;
      if (!fullRule(held.length - boots, boots, held.length)) continue;
      const k = [...held].sort((a, b) => a - b).join(",");
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    if (showable === 0) return "null";
    return Math.max(0, ...counts.values()) >= 2 ? "most-played-exact" : "single-game";
  };
  // OLD: snowball out, 4 total finished, and the vote ran over the same pool.
  const o = branchFor(false, () => true, 4);
  // NEW, restated inline.
  const n = branchFor(true, (nb, boots) => boots >= 1 && nb >= 5, 4);
  // NEW, from the shipped function.
  const r = resolveFullBuild(model.items, model.gameLog, model.games, classOf)?.method ?? "null";
  old_[o] = (old_[o] ?? 0) + 1;
  new_[n] = (new_[n] ?? 0) + 1;
  newReal[r] = (newReal[r] ?? 0) + 1;
}
console.log("OLD bar (4 finished items, snowball excluded):", old_);
console.log("NEW bar, inline restatement            :", new_);
console.log("NEW bar, from resolveFullBuild          :", newReal);
