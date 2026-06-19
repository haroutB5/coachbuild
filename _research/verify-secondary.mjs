import fs from 'fs';
const T = JSON.parse(fs.readFileSync('S:/AI/coachbuild/_research/runes-trans.json','utf8'));
const nameOf = id => (T[id]?.Name) || ('#'+id);
const CF = {patch:{major:16,patch:11,patchAdditions:0}, championIds:[112], matchupChampionIds:null, leagueTiers:[5,6,7], regions:null, role:2};
const api = (p,b)=>fetch('https://api.coachless.gg/api/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
const TREES={Precision:8000,Domination:8100,Inspiration:8300,Resolve:8400}; // secondary candidates (primary=Sorcery 8200)
// confidence-weighted score: shrink WPA toward 0 by sample. lcb ~ wpa - z*sd; we approximate with shrinkage k.
const shrink=(wpa,occ,k=8000)=> wpa*occ/(occ+k);

for(const [tn,tid] of Object.entries(TREES)){
  const r=await api('Rune/GetRunesForKeystoneAndTree',{keystone:null,mainTree:8200,treeToLoad:tid,commonFilters:CF});
  const rows=[r.rowOnes||[],r.rowTwos||[],r.rowThrees||[]];
  // best per row by RAW wpa and by SHRUNK wpa
  const pick=(row,fn)=>row.slice().sort((a,b)=>fn(b)-fn(a))[0];
  const rawTop=rows.map(row=>pick(row,x=>x.wpaOverall)).filter(Boolean);
  const shrTop=rows.map(row=>pick(row,x=>shrink(x.wpaOverall,x.occurrence))).filter(Boolean);
  const best2=(arr,fn)=>arr.slice().sort((a,b)=>fn(b)-fn(a)).slice(0,2);
  const rawAgg=best2(rawTop,x=>x.wpaOverall).reduce((s,x)=>s+x.wpaOverall,0);
  const shrAgg=best2(shrTop,x=>shrink(x.wpaOverall,x.occurrence)).reduce((s,x)=>s+shrink(x.wpaOverall,x.occurrence),0);
  console.log(`\n=== ${tn} (secondary) ===`);
  console.log('  RAW best/row: '+rawTop.map(x=>`${nameOf(x.rune)} ${x.wpaOverall>=0?'+':''}${x.wpaOverall.toFixed(2)}/${x.occurrence}`).join('  |  '));
  console.log('  SHRUNK best/row: '+shrTop.map(x=>`${nameOf(x.rune)} ${shrink(x.wpaOverall,x.occurrence).toFixed(2)} (raw ${x.wpaOverall.toFixed(2)}/${x.occurrence})`).join('  |  '));
  console.log(`  AGG raw(best2)=${rawAgg.toFixed(2)}   AGG shrunk(best2)=${shrAgg.toFixed(2)}`);
}
