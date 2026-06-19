const BASE = "http://localhost:3000";
const champs = {112:"Viktor",103:"Ahri",86:"Garen",64:"LeeSin",51:"Caitlyn",412:"Thresh",157:"Yasuo",104:"Graves",222:"Jinx",117:"Lulu",89:"Leona",16:"Soraka",266:"Aatrox",24:"Jax",42:"Corki",136:"AurelionSol",427:"Ivern",50:"Swain"};
let problems = [];
let n200=0,n404=0,n500=0,nother=0;
for (const [id,name] of Object.entries(champs)) {
  for (const role of [0,1,2,3,4,5]) {
    const res = await fetch(`${BASE}/api/build?champ=${id}&role=${role}`);
    if (res.status===500) { n500++; problems.push(`500: ${name} r${role}`); continue; }
    if (res.status===404) { n404++; continue; }
    if (res.status!==200) { nother++; problems.push(`HTTP${res.status}: ${name} r${role}`); continue; }
    n200++;
    const arr = await res.json();
    if (!Array.isArray(arr)||!arr.length) { problems.push(`empty-array: ${name} r${role}`); continue; }
    for (const b of arr) {
      const sp = b.spells.map(s=>s.id);
      if (new Set(sp).size !== sp.length) problems.push(`DUP-SPELL: ${name} r${role} #${b.rank} [${b.spells.map(s=>s.name)}]`);
      if (b.spells.length!==2) problems.push(`SPELL-COUNT ${b.spells.length}: ${name} r${role} #${b.rank}`);
      if (b.runes.secondary.length!==2) problems.push(`SEC-COUNT ${b.runes.secondary.length}: ${name} r${role} #${b.rank}`);
      if (b.runes.primary.length!==3) problems.push(`PRIM-COUNT ${b.runes.primary.length}: ${name} r${role} #${b.rank}`);
      const path=[b.items.starter,b.items.first,b.items.boots,b.items.second,b.items.third,...b.items.fourthPlus].map(i=>i.id);
      if (new Set(path).size!==path.length) problems.push(`DUP-ITEM: ${name} r${role} #${b.rank}`);
      if (/Item #/.test(JSON.stringify(b.items))) problems.push(`UNRESOLVED-ITEM: ${name} r${role} #${b.rank}`);
      if (b.rank===1 && b.runes.keystone.wpa < -0.3) problems.push(`NEG-KEYSTONE ${b.runes.keystone.name} ${b.runes.keystone.wpa}: ${name} r${role}`);
    }
  }
}
console.log(`scanned: 200=${n200} 404=${n404} 500=${n500} other=${nother}`);
console.log(problems.length? "PROBLEMS:\n  "+problems.join("\n  ") : "NO PROBLEMS — all combos clean");
