#!/usr/bin/env node
// Local runner for the FEATURED one-trick pipeline (2026-07-29).
//
//   npx tsx scripts/ingest-otp-featured.mjs --champion Viktor
//   npx tsx scripts/ingest-otp-featured.mjs --champions 10      # stalest first
//   npx tsx scripts/ingest-otp-featured.mjs --champion Akshan --matches 100
//
// WHY THIS IS LOCAL-ONLY, like scripts/ingest-otp.mjs before it:
//
//   * onetricks.gg rate-limits plain fetches. A bare GET returns HTTP 429 with
//     a real page body, reproduced repeatedly on 2026-07-29, while a browser
//     context gets 200. So discovery drives Chrome through puppeteer-core,
//     which is a devDependency and must never be imported by the Next app.
//   * Every Riot call is serialised at 1.3s through lib/pro/pacer.ts, shared
//     with every other Riot-calling script. Do NOT run this alongside
//     ingest-matches.mjs / ingest-otp.mjs / ingest-mystats.mjs — they contend
//     for one key budget and the pacer only serialises WITHIN a process
//     (CLAUDE.md gotcha (d)).
//
// BE POLITE TO THE SOURCE. One page load per champion, then a pause. The whole
// point of storing the answer is that we do not have to ask again today.
import { loadEnvLocal } from "./_env.mjs";

loadEnvLocal();

const { parseOneTricksRows, pickFeaturedOneTrick, riotId, MIN_CHAMPION_GAMES } = await import(
  "../lib/otp/onetricks.ts"
);
const { resolveFeaturedAccount } = await import("../lib/otp/featured.ts");
const { getMatchIdsByPuuid, getMatch } = await import("../lib/pro/riot.ts");
const { extractMatch } = await import("../lib/pro/extract.ts");
const { freshStartTimeEpochSec } = await import("../lib/pro/fresh.ts");
const { getAllChampions } = await import("../lib/staticData.ts");
const { getSql } = await import("../lib/pro/db.ts");

const CHROME =
  process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
/** Games pulled per featured account. Deeper than the old 20-per-account
 *  consensus walk on purpose: the card now claims to show ONE player's spread,
 *  and a spread over 20 games is mostly noise. 100 is Riot's page size. */
/** extractMatch reads `timeline.info` unconditionally, so a null timeline
 *  throws. Empty frames is the "we did not fetch one" sentinel, same as
 *  lib/otp/ingest.ts uses. */
const NO_TIMELINE = { info: { frames: [] } };
const DEFAULT_MATCHES = 100;
/** Pause between champion page loads. The source 429s under repeated hits. */
const PAGE_PAUSE_MS = 8000;

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const log = (msg) => console.log(`[otp-featured] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Scrape one champion's ranking page and return the rendered row strings. */
async function fetchRows(page, championKey) {
  const url = `https://www.onetricks.gg/champions/ranking/${encodeURIComponent(championKey)}`;
  const resp = await page.goto(url, { waitUntil: "networkidle2", timeout: 90000 });
  const status = resp ? resp.status() : 0;
  if (status !== 200 && status !== 304) {
    log(`${championKey}: HTTP ${status} from onetricks.gg — skipping (no guess)`);
    return [];
  }
  await sleep(5000);
  return page.evaluate(() =>
    [...document.querySelectorAll('a[href^="/players/"]')].map((a) => {
      // Walk up to the row container that carries the stat cells.
      let row = a;
      for (let i = 0; i < 6 && row.parentElement; i++) {
        row = row.parentElement;
        if ((row.innerText || "").includes("%")) break;
      }
      return (row.innerText || "").replace(/\s+/g, " ").trim();
    })
  );
}

async function ingestChampion(sql, page, champ, matchCount) {
  const rows = parseOneTricksRows(await fetchRows(page, champ.key));
  if (rows.length === 0) {
    log(`${champ.key}: no parseable rows`);
    return false;
  }
  const featured = pickFeaturedOneTrick(rows);
  if (!featured) {
    log(`${champ.key}: ${rows.length} rows, none both OTP-flagged and >= ${MIN_CHAMPION_GAMES} games`);
    return false;
  }
  log(
    `${champ.key}: ${riotId(featured)} — ${featured.tier} ${featured.lp} LP, ` +
      `${featured.games}g ${featured.winratePct}% WR, share ${featured.championSharePct}% (source rank ${featured.rank})`
  );

  const resolved = await resolveFeaturedAccount(featured.gameName, featured.tagLine, log);
  if (!resolved) return false;
  log(`${champ.key}: puuid resolved, matches live on ${resolved.matchRouting}`);

  await sql`
    INSERT INTO coachbuild.otp_featured (
      champion_id, puuid, game_name, tag_line, server, match_routing,
      tier, lp, champion_share_pct, source_games, winrate_pct, kda, source_rank, refreshed_at
    ) VALUES (
      ${champ.id}, ${resolved.puuid}, ${featured.gameName}, ${featured.tagLine},
      ${featured.server}, ${resolved.matchRouting}, ${featured.tier}, ${featured.lp},
      ${featured.championSharePct}, ${featured.games}, ${featured.winratePct},
      ${featured.kda}, ${featured.rank}, now()
    )
    ON CONFLICT (champion_id) DO UPDATE SET
      puuid = EXCLUDED.puuid, game_name = EXCLUDED.game_name, tag_line = EXCLUDED.tag_line,
      server = EXCLUDED.server, match_routing = EXCLUDED.match_routing, tier = EXCLUDED.tier,
      lp = EXCLUDED.lp, champion_share_pct = EXCLUDED.champion_share_pct,
      source_games = EXCLUDED.source_games, winrate_pct = EXCLUDED.winrate_pct,
      kda = EXCLUDED.kda, source_rank = EXCLUDED.source_rank, refreshed_at = now()
  `;

  // PAGINATED since 2026-07-29. Riot caps `count` at 100 PER REQUEST, and this
  // asked for one page from start=0, so a prolific account's history was
  // silently truncated at 100 ranked games however large `--matches` was.
  //
  // Measured on the featured Ahri one-trick: 348 ranked games sit inside the
  // 90-day freshness window, of which we held 60 on this champion. The cap was
  // not the window and not the account — it was this single request. A build
  // that repeats needs depth: at ~3% of games reaching five finished items plus
  // boots, one page yields two such games and no repeat at all.
  //
  // The 90-day window still bounds this — see lib/pro/fresh.ts. Older games
  // predate item overhauls and are actively misleading, so paging deeper must
  // never mean paging PAST the window; `startTime` is passed on every page.
  const ids = [];
  for (let start = 0; start < matchCount; start += 100) {
    const page = await getMatchIdsByPuuid(resolved.matchRouting, resolved.puuid, {
      queue: 420,
      start,
      count: Math.min(100, matchCount - start),
      startTime: freshStartTimeEpochSec(),
    });
    ids.push(...page);
    // A short page means the window is exhausted; asking again returns nothing
    // and just spends a Riot call against a shared key budget.
    if (page.length < 100) break;
  }
  const known = ids.length
    ? new Set(
        (
          await sql`SELECT match_id FROM coachbuild.otp_matches
                    WHERE puuid = ${resolved.puuid} AND match_id = ANY(${ids}::text[])`
        ).map((r) => r.match_id)
      )
    : new Set();
  const fresh = ids.filter((id) => !known.has(id));
  log(`${champ.key}: ${ids.length} recent ranked games, ${fresh.length} not yet stored`);

  let stored = 0;
  for (const matchId of fresh) {
    try {
      // NO_TIMELINE, not null: extractMatch reads timeline.info unconditionally,
      // so null throws. We deliberately do not fetch timelines here — that is a
      // second Riot call per match and the card makes no claim about purchase
      // or skill order.
      const row = extractMatch(await getMatch(resolved.matchRouting, matchId), NO_TIMELINE, resolved.puuid);
      // A one-trick still plays other champions. Only this champion's games are
      // evidence for this champion's card.
      if (!row || row.championId !== champ.id) continue;
      await sql`
        INSERT INTO coachbuild.otp_matches (
          match_id, puuid, champion_id, champion_name, role, patch, win,
          kills, deaths, assists, game_creation, game_duration_sec,
          spells, final_items, trinket, runes
        ) VALUES (
          ${row.matchId}, ${row.puuid}, ${row.championId}, ${row.championName}, ${row.role},
          ${row.patch}, ${row.win}, ${row.kills}, ${row.deaths}, ${row.assists},
          ${row.gameCreation}, ${row.gameDurationSec},
          ${JSON.stringify(row.spells)}, ${JSON.stringify(row.finalItems)},
          ${row.trinket}, ${JSON.stringify(row.runes)}
        )
        ON CONFLICT (match_id, puuid) DO NOTHING
      `;
      stored += 1;
    } catch (err) {
      log(`${champ.key}: match ${matchId} failed — ${err?.message ?? err}`);
    }
  }
  const total = (
    await sql`SELECT count(*)::int AS n FROM coachbuild.otp_matches
              WHERE puuid = ${resolved.puuid} AND champion_id = ${champ.id}`
  )[0].n;
  log(`${champ.key}: stored ${stored} new, ${total} total on champion`);
  return true;
}

async function main() {
  const sql = getSql();
  const only = argValue("--champion", null);
  const howMany = Number(argValue("--champions", "6")) || 6;
  const matchCount = Number(argValue("--matches", String(DEFAULT_MATCHES))) || DEFAULT_MATCHES;

  // `getAllChampions` carries non-Summoner's-Rift variants ("Jade_Ahri",
  // "Jade_Alistar", …). onetricks.gg has no page for them, so each one costs a
  // page load and an entry in the rate limiter to learn nothing. Real Riot
  // champion keys are single tokens — Kai'Sa is "Kaisa", Nunu & Willump is
  // "Nunu" — so an underscore is a reliable marker for a variant.
  const all = (await getAllChampions()).filter((c) => !c.key.includes("_"));
  let targets;
  if (only) {
    targets = all.filter((c) => c.key.toLowerCase() === only.toLowerCase() || String(c.id) === only);
    if (!targets.length) {
      log(`no champion matching "${only}"`);
      return;
    }
  } else {
    // Stalest first, never-fetched before refreshed.
    const seen = new Map(
      (await sql`SELECT champion_id, refreshed_at FROM coachbuild.otp_featured`).map((r) => [
        r.champion_id,
        new Date(r.refreshed_at).getTime(),
      ])
    );
    targets = [...all]
      .sort((a, b) => (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0))
      .slice(0, howMany);
  }

  const { default: puppeteer } = await import("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 2000 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
  );

  try {
    for (const champ of targets) {
      try {
        await ingestChampion(sql, page, champ, matchCount);
      } catch (err) {
        log(`${champ.key}: FAILED — ${err?.message ?? err}`);
      }
      await sleep(PAGE_PAUSE_MS);
    }
  } finally {
    await browser.close();
  }
  log("done");
}

await main();
