import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
const env = readFileSync('C:/Claude/AI/coachbuild/.env.local','utf8');
const url = env.split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g,'');
const sql = neon(url,{fetchOptions:{cache:'no-store'}});
const r = await sql`SELECT champion_id, champion_name, count(*)::int n FROM coachbuild.prostage_matches WHERE game_id LIKE 'lolesports:%' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 5`;
console.log(JSON.stringify(r));
