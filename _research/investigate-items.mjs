import fs from "fs";
const ITEMS = JSON.parse(fs.readFileSync("S:/AI/coachbuild/_research/items.json", "utf8"));
const nm = (id) => ITEMS[id]?.Name || ("#" + id);
const CF = { patch: { major: 16, patch: 11, patchAdditions: 0 }, championIds: [112], matchupChampionIds: null, leagueTiers: [5, 6, 7], regions: null, role: 2 };
const api = (b) => fetch("https://api.coachless.gg/api/ChampionWinprob/GetGlobalItemStatistics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const base = (extra) => ({ itemSlots: null, itemType: 1, keystone: null, starterId: null, firstPurchaseId: null, firstLegendaryId: null, secondLegendaryId: null, commonFilters: CF, ...extra });
const fmt = (arr, n = 6) => arr.slice().sort((a, b) => b.occurrence - a.occurrence).slice(0, n).map((x) => `${nm(x.itemId)} ${x.wpaOverall >= 0 ? "+" : ""}${x.wpaOverall.toFixed(2)}/${x.occurrence}`).join("  |  ");

console.log("=== VIKTOR MID — 1st item options (by occurrence) ===");
const first = await api(base({ itemSlots: [1] }));
console.log(fmt(first, 8));

// pick the top 2-3 distinct first items
const top1 = first.slice().sort((a, b) => b.occurrence - a.occurrence).slice(0, 3);

console.log("\n=== 2nd item, UNCONDITIONED ===");
console.log(fmt(await api(base({ itemSlots: [2] })), 6));

for (const it of top1) {
  console.log(`\n=== 2nd item GIVEN 1st = ${nm(it.itemId)} (firstLegendaryId=${it.itemId}) ===`);
  const cond = await api(base({ itemSlots: [2], firstLegendaryId: it.itemId }));
  console.log(fmt(cond, 6));
}

console.log("\n=== boots options (type 2) ===");
console.log(fmt(await api(base({ itemSlots: null, itemType: 2 })), 6));
console.log("\n=== starter options (type 6) ===");
console.log(fmt(await api(base({ itemSlots: null, itemType: 6 })), 6));
