// ─────────────────────────────────────────────────────────────────────────────
// Which branch does the featured one-trick card render, for every champion?
//
// WHY IT IMPORTS THE REAL MODULE RATHER THAN RESTATING THE RULES. An earlier
// throwaway version of this probe re-implemented `classifyFeaturedItem` inline
// with a tag-only boots rule and no snowball handling, which is the exact
// failure lib/bootsItems.ts's header is about: a copied rule agrees right up
// until the day it matters. This calls `resolveFullBuild` and
// `classifyFeaturedItem` themselves, so a number it prints is a number the card
// would render — and so raising a threshold in featuredBuild.ts moves this
// output without anyone remembering to edit it.
//
// The only thing it restates is the card's thin-sample floor
// (FeaturedOtpCard.tsx's MIN_SAMPLE_GAMES), which lives in a JSX file this
// script cannot import. It is pinned as a constant below with that note beside
// it.
//
// Read-only: SELECTs plus one ddragon catalog fetch. No Riot calls.
//
//   npx tsx scripts/measure-featured-branches.mts
//   npx tsx scripts/measure-featured-branches.mts 103    # one champion, verbose
// ─────────────────────────────────────────────────────────────────────────────
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./_env.mjs";
import type { ItemDetail } from "@/components/itemDetail";
import { classifyFeaturedItem, resolveFullBuild } from "@/lib/otp/featuredBuild";
import { buildFeaturedModel, type FeaturedMatchRow } from "@/lib/otp/featured";

loadEnvLocal();
const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });

/** FeaturedOtpCard.tsx's MIN_SAMPLE_GAMES. Restated because it lives in a .tsx
 *  file; keep the two in step. */
const MIN_SAMPLE_GAMES = 12;

const only = process.argv[2] ? Number(process.argv[2]) : null;

// ── ddragon catalog, in the shape getItemDetailMap gives the client ─────────
const ver: string = (
  await (await fetch("https://ddragon.leagueoflegends.com/api/versions.json")).json()
)[0];
const raw = (
  await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`)).json()
).data as Record<string, any>;
const META = new Map<number, ItemDetail>();
for (const [id, m] of Object.entries(raw)) {
  META.set(Number(id), {
    id: Number(id),
    name: m.name ?? `Item ${id}`,
    goldTotal: m.gold?.total ?? 0,
    descriptionText: "",
    into: m.into ?? [],
    from: m.from ?? [],
    tags: m.tags ?? [],
    purchasable: m.gold?.purchasable !== false,
  } as ItemDetail);
}
console.log(`ddragon ${ver}: ${META.size} items\n`);

const classOf = (id: number) => classifyFeaturedItem(id, META.get(id), META);
const nameOf = (id: number) => META.get(id)?.name ?? `Item ${id}`;

type FeatRow = { champion_id: number; game_name: string; tag_line: string; puuid: string };
const feats = (await sql`
  SELECT champion_id, game_name, tag_line, puuid
  FROM coachbuild.otp_featured
  ${only ? sql`WHERE champion_id = ${only}` : sql``}
  ORDER BY champion_id
`) as FeatRow[];

const tally: Record<string, number> = {};
const rows: { champ: number; name: string; stored: number; branch: string; games: number }[] = [];

for (const f of feats) {
  const matches = (await sql`
    SELECT win, final_items, runes, spells
    FROM coachbuild.otp_matches
    WHERE puuid = ${f.puuid} AND champion_id = ${f.champion_id}
    ORDER BY game_creation DESC
  `) as FeaturedMatchRow[];

  const model = buildFeaturedModel(matches);
  let branch: string;
  let games = 0;
  if (model.games < MIN_SAMPLE_GAMES) {
    branch = "thin-sample";
  } else {
    const build = resolveFullBuild(model.items, model.gameLog, model.games, classOf);
    branch = build?.method ?? "null";
    games = build?.games ?? 0;
    if (only && build) {
      console.log(`${f.game_name}#${f.tag_line} — champion ${f.champion_id}`);
      console.log(`  stored games : ${model.games}`);
      console.log(`  branch       : ${build.method} (${build.games} game(s))`);
      for (const it of build.items) {
        const mark = it.isSnowball ? "  [SNOWBALL — record only]" : it.isBoots ? "  [boots]" : "";
        console.log(`    ${nameOf(it.itemId).padEnd(28)} ${String(it.pct).padStart(3)}%${mark}`);
      }
      // The distribution the bar is set against.
      const hist = new Map<number, number>();
      let full = 0;
      let sixNoBoots = 0;
      for (const g of model.gameLog) {
        const held = [...new Set(g.items)].filter((id) => {
          const c = classOf(id);
          return c === "completed" || c === "boots" || c === "snowball";
        });
        const boots = held.filter((id) => classOf(id) === "boots").length;
        const nb = held.length - boots;
        hist.set(nb, (hist.get(nb) ?? 0) + 1);
        if (boots >= 1 && nb >= 5 && held.length <= 6) full += 1;
        if (boots === 0 && nb >= 6) sixNoBoots += 1;
      }
      console.log(
        `  non-boots per game : ${[...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join("  ")}`
      );
      console.log(`  full builds (5+boots) : ${full} of ${model.games}`);
      console.log(`  six non-boots, no boots (excluded) : ${sixNoBoots}\n`);
    }
  }
  tally[branch] = (tally[branch] ?? 0) + 1;
  rows.push({ champ: f.champion_id, name: f.game_name, stored: model.games, branch, games });
}

console.log(`branch split across ${rows.length} featured champions:`);
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(3)}  (${Math.round((v / rows.length) * 100)}%)`);
}
const played = rows.filter((r) => r.branch === "most-played-exact");
if (played.length) {
  console.log(`\nplayed-build branch:`);
  for (const r of played) console.log(`  champion ${r.champ} — ${r.name}, ${r.games} of ${r.stored} stored`);
}
const depths = rows.map((r) => r.stored).sort((a, b) => a - b);
console.log(
  `\nstored games per featured account — min ${depths[0]}, median ${depths[Math.floor(depths.length / 2)]}, max ${depths[depths.length - 1]}`
);
