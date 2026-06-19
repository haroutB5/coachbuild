const url = process.argv[2];
const r = await fetch(url);
const b = await r.json();
if (b.error) { console.log("  ERROR:", b.error, "/", b.detail||""); process.exit(0); }
const rn = b.runes;
console.log(`  ${b.champion.name} ${b.roleLabel} (patch ${b.patch})`);
console.log(`  primary=${rn.primaryTree.name}  secondary=${rn.secondaryTree.name}`);
console.log(`  keystone=${rn.keystone.name} (${rn.keystone.wpa>=0?'+':''}${rn.keystone.wpa})`);
console.log(`  primary: ${rn.primary.map(p=>p.name).join(', ')}`);
console.log(`  secondary: ${rn.secondary.map(p=>p.name+' '+(p.wpa>=0?'+':'')+p.wpa).join(', ')}`);
console.log(`  shards: ${[rn.shards.offense,rn.shards.flex,rn.shards.defense].map(s=>s.name).join(' / ')}`);
console.log(`  items: ${[b.items.starter,b.items.first,b.items.boots,b.items.second,b.items.third].map(i=>i.name).join(' -> ')} | 4th+: ${b.items.fourthPlus.map(i=>i.name).join(', ')}`);
console.log(`  spells: ${b.spells.map(s=>s.name).join(' + ')}`);
console.log(`  alt secondary trees: ${(rn.alts?.secondaryTrees||[]).map(t=>t.tree.name).join(', ')||'none'}`);
