import { neon } from '@neondatabase/serverless';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(), l.slice(i+1).trim()]}));
const sql = neon(env.DATABASE_URL);
const q = async (label, text) => { try { const r = await sql.query(text); console.log('\n== '+label+' =='); console.table(r); } catch(e){ console.log('\n== '+label+' == ERR '+e.message); } };

await q('Caps newest pro-stage games', `
  SELECT game_datetime, overview_page, champion_name, win, ingested_at
  FROM coachbuild.prostage_matches WHERE player_link ILIKE '%caps%'
  ORDER BY game_datetime DESC LIMIT 6`);

await q('freshest game per tournament (top 8)', `
  SELECT overview_page, max(game_datetime) AS newest_game, max(ingested_at) AS last_write, count(*) AS rows
  FROM coachbuild.prostage_matches GROUP BY overview_page
  ORDER BY newest_game DESC LIMIT 8`);

await q('EWC rows', `
  SELECT max(game_datetime) AS newest, count(*) AS rows
  FROM coachbuild.prostage_matches WHERE overview_page ILIKE '%World Cup%'`);
