const url = process.argv[2];
const r = await fetch(url);
const arr = await r.json();
if (!Array.isArray(arr)) { console.log("  ERROR:", JSON.stringify(arr)); process.exit(0); }
console.log(`  ${arr.length} variant(s) for ${arr[0]?.champion?.name} ${arr[0]?.roleLabel}`);
for (const b of arr) {
  const rn = b.runes;
  console.log(`  [#${b.rank} ${b.label} — ${b.subtitle}]`);
  console.log(`     ${rn.primaryTree.name}: ${rn.keystone.name} | ${rn.primary.map(p=>p.name).join(', ')}`);
  console.log(`     ${rn.secondaryTree.name}: ${rn.secondary.map(p=>p.name+' '+(p.wpa>=0?'+':'')+p.wpa.toFixed(2)+'/'+p.occurrence).join(', ')}`);
}
const b0=arr[0];
console.log(`  shared shards: ${[b0.runes.shards.offense,b0.runes.shards.flex,b0.runes.shards.defense].map(s=>s.name).join(' / ')}`);
console.log(`  shared items: ${[b0.items.starter,b0.items.first,b0.items.boots,b0.items.second,b0.items.third].map(i=>i.name).join(' -> ')}`);
console.log(`  shared spells: ${b0.spells.map(s=>s.name).join(' + ')}`);
