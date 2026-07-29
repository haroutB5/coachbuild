// TEMPORARY measurement harness — competing-slot threshold. Delete after use.
//
// Question: when two items "compete" for one build slot, how far below chance
// does their co-occurrence sit, and where is the gap that separates a genuine
// either/or from an ordinary pair of companions?
//
// Measures LIFT = observed_together / expected_together_if_independent, where
// expected = (a/N) * (b/N) * N. Lift ~0 = mutually exclusive. ~1 = independent.
// >1 = companions. A raw co-occurrence COUNT can't tell "never together" from
// "both rare", which is exactly the mistake a threshold must not bake in.
import { loadEnvLocal } from "./_env.mjs";
loadEnvLocal();
import { neon } from "@neondatabase/serverless";
import type { ItemDetail } from "@/components/itemDetail";
import { classifyFeaturedItem } from "@/lib/otp/featuredBuild";

const VER = "16.13.1";

async function itemMetaMap(): Promise<Map<number, ItemDetail>> {
  const res = await fetch(`https://cdn.coachless.gg/static-files/${VER}/${VER}/data/en_US/item.json`);
  if (!res.ok) throw new Error(`item.json ${res.status}`);
  const json: any = await res.json();
  const map = new Map<number, ItemDetail>();
  for (const [id, e] of Object.entries<any>(json.data ?? {})) {
    map.set(Number(id), {
      id: Number(id), name: e.name ?? "", goldTotal: e.gold?.total ?? 0, descriptionText: "",
      into: Array.isArray(e.into) ? e.into : [], from: Array.isArray(e.from) ? e.from : [],
      tags: Array.isArray(e.tags) ? e.tags : [], purchasable: e.gold?.purchasable !== false,
    });
  }
  return map;
}

async function main() {
  const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
  const meta = await itemMetaMap();
  const nameOf = (id: number) => meta.get(id)?.name ?? `#${id}`;

  const total = (await sql`select count(*)::int n from coachbuild.otp_matches`) as { n: number }[];
  console.log(`otp_matches rows: ${total[0].n}`);

  const combos = (await sql`
    select champion_id, max(champion_name) champion_name, count(*)::int n
    from coachbuild.otp_matches
    where final_items is not null
    group by champion_id
    having count(*) >= 60
    order by n desc
    limit 8
  `) as { champion_id: number; champion_name: string; n: number }[];

  const allPairs: { lift: number; label: string; obs: number; exp: number }[] = [];

  for (const c of combos) {
    const rows = (await sql`
      select final_items from coachbuild.otp_matches
      where champion_id = ${c.champion_id} and final_items is not null
    `) as { final_items: unknown }[];

    const games: number[][] = [];
    for (const r of rows) {
      const raw = Array.isArray(r.final_items) ? (r.final_items as number[]) : [];
      const kept = Array.from(new Set(raw.filter((x) => typeof x === "number" && x > 0))).filter((id) => {
        const k = classifyFeaturedItem(id, meta.get(id));
        return k === "completed" || k === "boots";
      });
      if (kept.length > 0) games.push(kept);
    }
    const N = games.length;
    if (N < 40) continue;

    const single = new Map<number, number>();
    const pair = new Map<string, number>();
    for (const g of games) {
      for (const a of g) single.set(a, (single.get(a) ?? 0) + 1);
      for (let i = 0; i < g.length; i++)
        for (let j = i + 1; j < g.length; j++) {
          const [x, y] = g[i] < g[j] ? [g[i], g[j]] : [g[j], g[i]];
          const k = `${x},${y}`;
          pair.set(k, (pair.get(k) ?? 0) + 1);
        }
    }

    // Only pairs where BOTH items are built often enough that "never together"
    // could not plausibly be chance: expected co-occurrence >= 3 games.
    const top = Array.from(single.entries()).filter(([, n]) => n / N >= 0.15).sort((a, b) => b[1] - a[1]);
    const lines: string[] = [];
    for (let i = 0; i < top.length; i++)
      for (let j = i + 1; j < top.length; j++) {
        const [a, an] = top[i];
        const [b, bn] = top[j];
        const exp = (an / N) * (bn / N) * N;
        if (exp < 3) continue;
        const [x, y] = a < b ? [a, b] : [b, a];
        const obs = pair.get(`${x},${y}`) ?? 0;
        const lift = obs / exp;
        const label = `${nameOf(a)} ${Math.round((an / N) * 100)}% + ${nameOf(b)} ${Math.round((bn / N) * 100)}%`;
        allPairs.push({ lift, label, obs, exp });
        lines.push(`    lift ${lift.toFixed(2)}  obs ${obs}/exp ${exp.toFixed(1)}  ${label}`);
      }
    console.log(`\n${c.champion_name} — ${N} games with items (${c.n} stored)`);
    lines.sort((p, q) => parseFloat(p.slice(9)) - parseFloat(q.slice(9)));
    for (const l of lines.slice(0, 6)) console.log(l);
    if (lines.length > 6) console.log(`    ... ${lines.length - 6} more pairs`);
  }

  allPairs.sort((a, b) => a.lift - b.lift);
  console.log(`\n=== LIFT DISTRIBUTION over ${allPairs.length} qualifying pairs ===`);
  const buckets = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 0.9, 1.1, 99];
  let prev = 0;
  for (const b of buckets) {
    const n = allPairs.filter((p) => p.lift >= prev && p.lift < b).length;
    if (n > 0) console.log(`  lift ${prev.toFixed(2)}–${b === 99 ? "inf" : b.toFixed(2)}: ${n} pairs`);
    prev = b;
  }
  console.log(`\nLowest 12 (candidate competitors):`);
  for (const p of allPairs.slice(0, 12)) console.log(`  ${p.lift.toFixed(3)}  obs ${p.obs}/exp ${p.exp.toFixed(1)}  ${p.label}`);
}

// ── LIVE SMOKE: run the REAL shipped grouper over prod rows ─────────────────
// Not a second implementation — imports `resolveBuildSlots` itself, so what
// prints here is exactly what the cards render. `npx tsx <this file> slots`.
async function smokeSlots() {
  const { resolveBuildSlots } = await import("@/lib/buildSlots");
  const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
  const meta = await itemMetaMap();
  const nameOf = (id: number) => meta.get(id)?.name ?? `#${id}`;
  const combos = (await sql`
    select champion_id, max(champion_name) champion_name, count(*)::int n
    from coachbuild.otp_matches where final_items is not null
    group by champion_id having count(*) >= 60 order by n desc limit 6
  `) as { champion_id: number; champion_name: string; n: number }[];

  for (const c of combos) {
    const rows = (await sql`
      select final_items from coachbuild.otp_matches
      where champion_id = ${c.champion_id} and final_items is not null
    `) as { final_items: unknown }[];
    const games = rows.map((r) => (Array.isArray(r.final_items) ? (r.final_items as number[]) : []));
    const slots = resolveBuildSlots(games, c.n, {
      include: (id) => classifyFeaturedItem(id, meta.get(id)) === "completed",
    });
    const contested = slots.filter((s) => s.alternatives.length > 0).length;
    console.log(`\n${c.champion_name} (${c.n} stored games) -> ${slots.length} slots, ${contested} contested`);
    for (const s of slots) {
      const alts = s.alternatives.map((a) => ` / or ${nameOf(a.itemId)} ${a.pct}%`).join("");
      console.log(`  ${nameOf(s.primary.itemId)} ${s.primary.pct}%${alts}`);
    }
  }
}

const run = process.argv[2] === "slots" ? smokeSlots : main;
run().catch((e) => { console.error(e); process.exit(1); });
