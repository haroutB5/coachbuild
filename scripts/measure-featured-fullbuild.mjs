// Measures what a featured one-trick's stored games can actually support as an
// example build: how many carry a full inventory, how many carry enough
// FINISHED items to be a build, and whether the modal exact set repeats.
//
// This is the evidence behind lib/otp/featuredBuild.ts's EXACT_SET_MIN_ITEMS
// and behind the claim in its header that comparing RAW inventories makes every
// game look unique. Re-run it if the item pool or the ingest changes shape:
//
//     node scripts/measure-featured-fullbuild.mjs [championId]     (default 103, Ahri)
//
// Read-only. Needs DATABASE_URL in .env.local and reaches ddragon for the item
// catalog, because item classification is a CLIENT-side fact in this app (the
// route deliberately ships raw ids).
//
// The classifier below MIRRORS lib/otp/featuredBuild.ts's `classifyFeaturedItem`
// rather than importing it — the app's copy takes a ddragon `ItemDetail`, this
// one takes a raw catalog entry. If the app's precedence changes, change this
// too or the numbers stop describing what ships.
import { neon } from "@neondatabase/serverless";
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();
const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });

const CHAMP = Number(process.argv[2] ?? 103); // Ahri

// ddragon item catalog (same source components/itemDetail.ts uses)
const verRes = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
const ver = (await verRes.json())[0];
const itemRes = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/en_US/item.json`);
const catalog = (await itemRes.json()).data;
console.log("ddragon", ver, "items", Object.keys(catalog).length);

const STARTERS = new Set([
  1054, 1055, 1056, 1082, 1083, 3070, 3850, 3854, 3858, 3862, 2051, 1039, 1101, 1102, 1103,
]);
const SNOWBALL = new Set([1082, 3041]);

function classify(id) {
  const m = catalog[String(id)];
  if (STARTERS.has(id)) return "starter";
  if (SNOWBALL.has(id)) return "snowball";
  if (!m) return "excluded";
  if (m.gold?.purchasable === false) return "excluded";
  const tags = m.tags ?? [];
  if (tags.includes("Consumable") || tags.includes("Trinket")) return "excluded";
  const into = m.into ?? [];
  const from = m.from ?? [];
  if (tags.includes("Boots") && from.length > 0) return "boots";
  return into.length === 0 ? "completed" : "excluded";
}
const nameOf = (id) => catalog[String(id)]?.name ?? `#${id}`;

const feat = await sql`
  SELECT game_name, tag_line, puuid FROM coachbuild.otp_featured WHERE champion_id = ${CHAMP} LIMIT 1
`;
if (!feat.length) {
  console.log("no featured account for champion", CHAMP);
  process.exit(0);
}
console.log("featured:", feat[0].game_name + "#" + feat[0].tag_line);

const rows = await sql`
  SELECT match_id, win, final_items, game_creation
  FROM coachbuild.otp_matches
  WHERE puuid = ${feat[0].puuid} AND champion_id = ${CHAMP}
  ORDER BY game_creation DESC
`;
console.log("stored games:", rows.length, "wins:", rows.filter((r) => r.win).length);

const games = rows.map((r) => ({
  id: r.match_id,
  win: r.win,
  items: Array.from(new Set((r.final_items ?? []).filter((x) => typeof x === "number" && x > 0))),
}));

const bySize = {};
for (const g of games) bySize[g.items.length] = (bySize[g.items.length] ?? 0) + 1;
console.log("inventory sizes:", bySize);

const rules = {
  "6 slots, any content": (g) => g.items.length === 6,
  "6 slots, no consumable/trinket/unpurchasable": (g) =>
    g.items.length === 6 && g.items.every((id) => classify(id) !== "excluded"),
  "6 slots, no excluded + no snowball": (g) =>
    g.items.length === 6 && g.items.every((id) => !["excluded", "snowball"].includes(classify(id))),
  "6 slots, completed/boots only": (g) =>
    g.items.length === 6 && g.items.every((id) => ["completed", "boots"].includes(classify(id))),
};
for (const [label, fn] of Object.entries(rules)) {
  const el = games.filter(fn);
  const counts = new Map();
  for (const g of el) {
    const k = [...g.items].sort((a, b) => a - b).join(",");
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.values()].sort((a, b) => b - a)[0] ?? 0;
  console.log(
    `  ${label}: ${el.length} eligible, ${counts.size} distinct, modal repeats ${top}x, wins ${el.filter((g) => g.win).length}`
  );
}

// What the chosen rule would actually select (won > most completed > most recent)
const eligible = games.filter(rules["6 slots, no consumable/trinket/unpurchasable"]);
const completedCount = (g) => g.items.filter((id) => ["completed", "boots"].includes(classify(id))).length;
const ranked = [...eligible]
  .map((g, i) => ({ ...g, idx: i }))
  .sort(
    (a, b) =>
      Number(b.win) - Number(a.win) ||
      completedCount(b) - completedCount(a) ||
      games.indexOf(eligible[a.idx]) - games.indexOf(eligible[b.idx]) ||
      (a.id < b.id ? -1 : 1)
  );
const pick = ranked[0];
if (pick) {
  console.log("\nselected game:", pick.id, pick.win ? "WON" : "LOST", "completed:", completedCount(pick));
  for (const id of pick.items) console.log("   ", id, nameOf(id), `[${classify(id)}]`);
}

// ── FINISHED-ITEM exact-set grouping, the branch that actually ships ────────
for (const minItems of [3, 4, 5]) {
  const el = games
    .map((g, i) => ({
      ...g,
      idx: i,
      finished: g.items.filter((id) => ["completed", "boots"].includes(classify(id))),
    }))
    .filter((g) => g.finished.length >= minItems && g.finished.length <= 6);
  const counts = new Map();
  for (const g of el) {
    const k = [...g.finished].sort((a, b) => a - b).join(",");
    if (!counts.has(k)) counts.set(k, []);
    counts.get(k).push(g);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const top = ranked[0];
  console.log(
    `\nFINISHED >= ${minItems}: ${el.length} eligible, ${counts.size} distinct, ` +
      `${ranked.filter(([, v]) => v.length > 1).length} repeating, modal ${top ? top[1].length : 0}x`
  );
  if (top && top[1].length > 1) {
    for (const id of top[0].split(",").map(Number)) console.log("     ", id, nameOf(id), `[${classify(id)}]`);
    console.log("      wins in that group:", top[1].filter((g) => g.win).length, "/", top[1].length);
  }
}

// ── deeper histogram ────────────────────────────────────────────────────────
const hist = {};
const histNonExcluded = {};
for (const g of games) {
  const c = g.items.filter((id) => ["completed", "boots"].includes(classify(id))).length;
  hist[c] = (hist[c] ?? 0) + 1;
  const nc = g.items.filter((id) => classify(id) !== "excluded").length;
  histNonExcluded[nc] = (histNonExcluded[nc] ?? 0) + 1;
}
console.log("\ncompleted+boots per game:", hist);
console.log("non-excluded slots per game:", histNonExcluded);

const tally = (cls) => {
  const m = new Map();
  for (const g of games) for (const id of g.items) if (classify(id) === cls) m.set(id, (m.get(id) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
console.log("\nexcluded occupants:");
for (const [id, n] of tally("excluded")) console.log("   ", n, nameOf(id), id);
console.log("starter occupants:");
for (const [id, n] of tally("starter")) console.log("   ", n, nameOf(id), id);
console.log("snowball occupants:");
for (const [id, n] of tally("snowball")) console.log("   ", n, nameOf(id), id);
