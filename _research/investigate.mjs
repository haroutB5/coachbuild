import fs from 'fs';
const T = JSON.parse(fs.readFileSync('S:/AI/coachbuild/runes-trans.json','utf8'));
const nameOf = id => (T[id]?.Name) || ('#'+id);
const treeOf = id => { const m=(T[id]?.Icon||'').match(/Styles\/([A-Za-z]+)\//); return m?m[1]:'?'; };
const TREE_ID = {Precision:8000, Domination:8100, Sorcery:8200, Inspiration:8300, Resolve:8400};
const TREE_NAME = Object.fromEntries(Object.entries(TREE_ID).map(([k,v])=>[v,k]));

const CF = (role=2, champ=112) => ({patch:{major:16,patch:11,patchAdditions:0}, championIds:[champ], matchupChampionIds:null, leagueTiers:[5,6,7], regions:null, role});
const api = async (path, body) => {
  const r = await fetch('https://api.coachless.gg/api/'+path, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)});
  if(!r.ok) throw new Error(path+' '+r.status);
  return r.json();
};
const fmt = a => a.map(x=>`${(x.wpaOverall>=0?'+':'')}${x.wpaOverall.toFixed(2).padStart(5)}  ${String(x.occurrence).padStart(7)}  ${nameOf(x.rune)} [${treeOf(x.rune)}]`).join('\n');
const ROLE=2, CHAMP=112;

// 1. ALL keystones across every tree, sorted by WPA
const keys = await api('Rune/GetKeystoneData', {commonFilters:CF(ROLE,CHAMP)});
console.log('=== VIKTOR MID — ALL KEYSTONES (every tree), by WPA ===');
console.log(fmt([...keys].sort((a,b)=>b.wpaOverall-a.wpaOverall)));
const topKey = [...keys].sort((a,b)=>b.occurrence-a.occurrence)[0];
const primaryTree = TREE_ID[treeOf(topKey.rune)] || 8200;
console.log(`\nMost-played keystone: ${nameOf(topKey.rune)} (${topKey.occurrence}) → primary tree = ${TREE_NAME[primaryTree]} (${primaryTree})`);

// 2. Secondary tree playcount
const sec = await api('Rune/GetSecondaryTreePlaycount', {tree:primaryTree, keystone:null, commonFilters:CF(ROLE,CHAMP)});
console.log('\n=== SECONDARY TREE PLAYCOUNT (with '+TREE_NAME[primaryTree]+' primary) ===');
console.log(sec.map(s=>`${TREE_NAME[s.tree]||s.tree}: ${s.occurrence.toFixed(1)}%`).join('  |  '));

// 3. Minor runes for primary + EVERY possible secondary tree, by WPA
const trees = [primaryTree, ...Object.values(TREE_ID).filter(t=>t!==primaryTree)];
for (const t of trees) {
  const r = await api('Rune/GetRunesForKeystoneAndTree', {keystone:null, mainTree:primaryTree, treeToLoad:t, commonFilters:CF(ROLE,CHAMP)});
  const rows = [...(r.rowOnes||[]), ...(r.rowTwos||[]), ...(r.rowThrees||[])];
  const label = t===primaryTree ? 'PRIMARY '+TREE_NAME[t] : 'secondary '+TREE_NAME[t];
  console.log(`\n=== ${label} runes (with ${TREE_NAME[primaryTree]} primary), by WPA ===`);
  console.log(fmt([...rows].sort((a,b)=>b.wpaOverall-a.wpaOverall)));
}

// 4. Shards
const sh = await api('Rune/GetShardsForKeystoneAndTree', {keystone:null, commonFilters:CF(ROLE,CHAMP)});
console.log('\n=== SHARDS by WPA ===');
for (const slot of ['offense','flex','defense']) {
  console.log(slot+':');
  console.log(fmt([...(sh[slot]||[])].sort((a,b)=>b.wpaOverall-a.wpaOverall)));
}
