// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/seedCrossregion.ts — one-off seed of non-EUW pros (KR/LPL/NA) into
// coachbuild.pros / coachbuild.pro_accounts. lolpros.gg's public ladder is
// EUW-only (see lib/pro/lolpros.ts header), so famous KR/LPL/NA pros (Faker
// etc.) never surface through the regular roster ingest. This module is the
// shared core for scripts/seed-crossregion.mjs — kept separate from
// lib/pro/ingestRoster.ts (ladder-paging path) because the seeding strategy
// is fundamentally different: a curated candidate list + two independent
// lookup tiers, not a single paged feed.
//
// Tier 1 — lolpros profile-by-slug (api.lolpros.gg/es/profiles/{slug}).
//   Many non-EUW pros DO have a lolpros profile even though the public
//   ladder never lists them (ladder = EUW ranked leaderboard; profile =
//   any known player). A 404 just means "try tier 2" for that candidate.
//
// Tier 2 — Leaguepedia Cargo `Players` table, `SoloqueueIds` field. Full
//   roster pull for ~14 hardcoded tier-1 teams (LCK/LPL/LCS), grouped into
//   3 queries (one per league) — covers both the curated candidates AND any
//   other current roster member not in our hand-picked list. Leaguepedia
//   rate-limits aggressively and per-IP/shared -- calls are kept to a
//   minimum (3 total, >=60s apart, one retry after a 4.5min cooldown on a
//   rate-limit hit, then tier 2 is abandoned in favor of keeping tier-1
//   results rather than hammering a hostile limiter).
//
// Account server resolution for tier 2: Leaguepedia's SoloqueueIds field is
// just "gameName#tagLine" with NO explicit server field. We infer the
// server from the tagLine prefix when it matches a known routingForServer
// key (covers the common case of an LPL player's KR bootcamp account, e.g.
// "Xxx#KR1" -> server "KR") and fall back to the candidate's home-region
// hint otherwise. CN is never a valid server for our Riot key (mainland
// China isn't on Riot's global API) -- any account whose resolved server is
// CN is skipped with a log line + a dedicated counter, not silently folded
// into the generic "unresolved" bucket.
//
// pros.id: for lolpros hits we reuse the lolpros uuid (matches the existing
// ingestRoster.ts convention). For Leaguepedia-only hits (no lolpros
// profile at all) there is no uuid, so we synthesize `lp2:<Leaguepedia ID>`
// -- the `lp2:` prefix can never collide with a real lolpros uuid (always
// canonical-UUID-shaped), and Leaguepedia's `ID` field is itself a unique
// wiki page name, so it's a stable, idempotent key across reruns.
// ─────────────────────────────────────────────────────────────────────────────

import { getSql } from "./db";
import { DbUnavailableError } from "./errors";
import { getProfile } from "./lolpros";
import { resolveAccount } from "./puuidResolve";
import { roleFromLolProsPosition } from "./roleMap";
import type { LolProsAccountRaw, ProRoleId } from "./types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Curated candidate list ──────────────────────────────────────────────────
// Best-effort current (2026-07) rosters from training knowledge -- may be a
// season stale on exact team assignments; that's fine, tier 2 (Leaguepedia)
// corrects team/role, and the point of this list is name coverage for tier 1.

interface Candidate {
  name: string;
  team: string;
  role: string; // lolpros-style position hint: top/jungle/mid/adc/sup
  region: "KR" | "CN" | "NA";
}

const CANDIDATES: Candidate[] = [
  // LCK
  { name: "Faker", team: "T1", role: "mid", region: "KR" },
  { name: "Zeus", team: "T1", role: "top", region: "KR" },
  { name: "Oner", team: "T1", role: "jungle", region: "KR" },
  { name: "Gumayusi", team: "T1", role: "adc", region: "KR" },
  { name: "Keria", team: "T1", role: "sup", region: "KR" },
  { name: "Chovy", team: "Gen.G", role: "mid", region: "KR" },
  { name: "Kiin", team: "Gen.G", role: "top", region: "KR" },
  { name: "Canyon", team: "Gen.G", role: "jungle", region: "KR" },
  { name: "Peyz", team: "Gen.G", role: "adc", region: "KR" },
  { name: "Duro", team: "Gen.G", role: "sup", region: "KR" },
  { name: "Zeka", team: "Hanwha Life Esports", role: "mid", region: "KR" },
  { name: "Doran", team: "Hanwha Life Esports", role: "top", region: "KR" },
  { name: "Peanut", team: "Hanwha Life Esports", role: "jungle", region: "KR" },
  { name: "Viper", team: "Hanwha Life Esports", role: "adc", region: "KR" },
  { name: "Delight", team: "Hanwha Life Esports", role: "sup", region: "KR" },
  { name: "ShowMaker", team: "Dplus KIA", role: "mid", region: "KR" },
  { name: "Canna", team: "Dplus KIA", role: "top", region: "KR" },
  { name: "Lucid", team: "Dplus KIA", role: "jungle", region: "KR" },
  { name: "Aiming", team: "Dplus KIA", role: "adc", region: "KR" },
  { name: "Kellin", team: "Dplus KIA", role: "sup", region: "KR" },
  { name: "Bdd", team: "KT Rolster", role: "mid", region: "KR" },
  { name: "PerfecT", team: "KT Rolster", role: "top", region: "KR" },
  { name: "Cuzz", team: "KT Rolster", role: "jungle", region: "KR" },
  // LPL
  { name: "Bin", team: "Bilibili Gaming", role: "top", region: "CN" },
  { name: "Knight", team: "Bilibili Gaming", role: "mid", region: "CN" },
  { name: "Elk", team: "Bilibili Gaming", role: "adc", region: "CN" },
  { name: "Kanavi", team: "JD Gaming", role: "jungle", region: "CN" },
  { name: "369", team: "JD Gaming", role: "top", region: "CN" },
  { name: "Yagao", team: "JD Gaming", role: "mid", region: "CN" },
  { name: "JackeyLove", team: "Top Esports", role: "adc", region: "CN" },
  { name: "TheShy", team: "Weibo Gaming", role: "top", region: "CN" },
  { name: "Xiaohu", team: "Weibo Gaming", role: "mid", region: "CN" },
  { name: "Scout", team: "LNG Esports", role: "mid", region: "CN" },
  { name: "Light", team: "LNG Esports", role: "adc", region: "CN" },
  // LCS / LTA North
  { name: "Impact", team: "Team Liquid", role: "top", region: "NA" },
  { name: "CoreJJ", team: "Team Liquid", role: "sup", region: "NA" },
  { name: "Berserker", team: "Cloud9", role: "adc", region: "NA" },
  { name: "Blaber", team: "Cloud9", role: "jungle", region: "NA" },
  { name: "Jojopyun", team: "Cloud9", role: "mid", region: "NA" },
  { name: "Bwipo", team: "FlyQuest", role: "top", region: "NA" },
  { name: "Massu", team: "FlyQuest", role: "mid", region: "NA" },
];

// ── Leaguepedia tier-1 team rosters, chunked one call per league ───────────
const LEAGUEPEDIA_TEAM_GROUPS: string[][] = [
  ["T1", "Gen.G", "Hanwha Life Esports", "Dplus KIA", "KT Rolster"], // LCK
  ["Bilibili Gaming", "JD Gaming", "Top Esports", "Weibo Gaming", "LNG Esports"], // LPL
  ["Team Liquid", "Cloud9", "FlyQuest", "100 Thieves"], // LCS / LTA North
];

const LEAGUEPEDIA_UA = "coachbuild-personal-use/0.1 (+https://coachbuild.vercel.app)";
const LEAGUEPEDIA_CHUNK_GAP_MS = 60_000;
const LEAGUEPEDIA_RATE_LIMIT_COOLDOWN_MS = 4.5 * 60_000;

// Known routingForServer keys, longest-first (defensive; no real overlaps).
const KNOWN_SERVERS = ["EUNE", "EUW", "LAN", "LAS", "OCE", "TR", "RU", "NA", "BR", "KR", "JP", "VN", "PH", "SG", "TH", "TW"];

function inferServerFromTag(tagLine: string | undefined, fallback: string): string {
  if (tagLine) {
    const upper = tagLine.toUpperCase();
    for (const key of KNOWN_SERVERS) {
      if (upper.startsWith(key)) return key;
    }
  }
  return fallback.toUpperCase();
}

interface LeaguepediaRow {
  ID?: string;
  Player?: string;
  Team?: string;
  Role?: string;
  Country?: string;
  SoloqueueIds?: string;
}

async function fetchLeaguepediaChunk(teams: string[]): Promise<{ rateLimited: boolean; rows: LeaguepediaRow[] }> {
  const teamsClause = teams.map((t) => `"${t.replace(/"/g, '\\"')}"`).join(",");
  const where = `Players.Team IN (${teamsClause})`;
  const fields =
    "Players.ID=ID,Players.Player=Player,Players.Team=Team,Players.Role=Role,Players.Country=Country,Players.SoloqueueIds=SoloqueueIds";
  const url = `https://lol.fandom.com/api.php?action=cargoquery&format=json&tables=Players&fields=${encodeURIComponent(
    fields
  )}&where=${encodeURIComponent(where)}&limit=500`;

  const res = await fetch(url, { headers: { "User-Agent": LEAGUEPEDIA_UA, Accept: "application/json" } });
  if (res.status === 429) return { rateLimited: true, rows: [] };

  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // Cloudflare rate-limit / challenge pages come back as HTML, not JSON.
    return { rateLimited: true, rows: [] };
  }

  if (!res.ok || (isObj(json) && "error" in json)) {
    const info =
      isObj(json) && isObj(json.error) && typeof json.error.info === "string" ? json.error.info : text.slice(0, 200);
    if (/rate|limit|too many/i.test(info)) return { rateLimited: true, rows: [] };
    throw new Error(`leaguepedia ${res.status}: ${info}`);
  }

  const rows: LeaguepediaRow[] = [];
  if (isObj(json) && Array.isArray(json.cargoquery)) {
    for (const item of json.cargoquery) {
      if (!isObj(item) || !isObj(item.title)) continue;
      const t = item.title;
      rows.push({
        ID: typeof t.ID === "string" ? t.ID : undefined,
        Player: typeof t.Player === "string" ? t.Player : undefined,
        Team: typeof t.Team === "string" ? t.Team : undefined,
        Role: typeof t.Role === "string" ? t.Role : undefined,
        Country: typeof t.Country === "string" ? t.Country : undefined,
        SoloqueueIds: typeof t.SoloqueueIds === "string" ? t.SoloqueueIds : undefined,
      });
    }
  }
  return { rateLimited: false, rows };
}

async function queryLeaguepediaTeams(
  teams: string[],
  log: (msg: string) => void,
  result: SeedCrossregionResult
): Promise<LeaguepediaRow[] | null> {
  try {
    let res = await fetchLeaguepediaChunk(teams);
    if (res.rateLimited) {
      log(`leaguepedia rate-limited on [${teams.join(", ")}] -- waiting ~4.5min before one retry`);
      await sleep(LEAGUEPEDIA_RATE_LIMIT_COOLDOWN_MS);
      res = await fetchLeaguepediaChunk(teams);
      if (res.rateLimited) {
        result.errors.push(
          `leaguepedia stayed rate-limited after retry for [${teams.join(", ")}] -- tier 2 stopped, tier 1 results kept`
        );
        log(`leaguepedia still rate-limited after retry -- aborting tier 2 for remaining chunks`);
        return null;
      }
    }
    log(`leaguepedia: ${res.rows.length} roster rows for [${teams.join(", ")}]`);
    return res.rows;
  } catch (err) {
    result.errors.push(`leaguepedia [${teams.join(", ")}]: ${(err as Error).message}`);
    return [];
  }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

async function upsertPro(
  id: string,
  name: string,
  slug: string,
  team: string | null,
  role: ProRoleId | null,
  country: string | null
): Promise<void> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  await sql`
    INSERT INTO coachbuild.pros (id, name, slug, team, role, country, updated_at)
    VALUES (${id}, ${name}, ${slug}, ${team}, ${role}, ${country}, now())
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      slug = EXCLUDED.slug,
      team = COALESCE(EXCLUDED.team, coachbuild.pros.team),
      role = COALESCE(EXCLUDED.role, coachbuild.pros.role),
      country = COALESCE(EXCLUDED.country, coachbuild.pros.country),
      updated_at = now()
  `;
}

async function processAccount(
  proId: string,
  displayLabel: string,
  account: LolProsAccountRaw,
  seenKeys: Set<string>,
  result: SeedCrossregionResult,
  log: (msg: string) => void
): Promise<void> {
  const server = (account.server ?? "").toUpperCase();
  const key = `${(account.gamename ?? account.summoner_name ?? account.encrypted_puuid ?? "").toLowerCase()}#${(
    account.tagline ?? ""
  ).toLowerCase()}`;
  if (seenKeys.has(key)) return;
  seenKeys.add(key);

  if (server === "CN") {
    result.skippedCN += 1;
    log(
      `skip CN account for ${displayLabel}: ${account.gamename ?? account.summoner_name ?? "?"}#${
        account.tagline ?? ""
      } (Riot API does not serve CN mainland accounts)`
    );
    return;
  }

  const resolved = await resolveAccount(account).catch((err) => {
    result.errors.push(`resolve ${displayLabel}/${server || "?"}: ${(err as Error).message}`);
    return null;
  });
  if (!resolved) {
    result.accountsUnresolved += 1;
    return;
  }

  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  await sql`
    INSERT INTO coachbuild.pro_accounts (puuid, pro_id, region, riot_id, active, created_at)
    VALUES (${resolved.puuid}, ${proId}, ${resolved.region}, ${resolved.riotId}, ${resolved.active}, now())
    ON CONFLICT (puuid) DO UPDATE SET
      pro_id = EXCLUDED.pro_id,
      region = EXCLUDED.region,
      riot_id = EXCLUDED.riot_id,
      active = EXCLUDED.active
  `;
  if (resolved.active) {
    result.accountsResolved += 1;
  } else {
    result.accountsUnresolved += 1;
  }
}

// ── Public entrypoint ────────────────────────────────────────────────────────

export interface SeedCrossregionOptions {
  onProgress?: (msg: string) => void;
  skipLeaguepedia?: boolean; // escape hatch for a tier-1-only rerun
}

export interface SeedCrossregionResult {
  candidates: number;
  foundLolpros: number;
  foundLeaguepedia: number;
  accountsResolved: number;
  accountsUnresolved: number;
  skippedCN: number;
  notableMisses: string[];
  errors: string[];
}

export async function runSeedCrossregion(opts: SeedCrossregionOptions = {}): Promise<SeedCrossregionResult> {
  const sql = getSql();
  if (!sql) throw new DbUnavailableError();
  const log = opts.onProgress ?? (() => {});

  const result: SeedCrossregionResult = {
    candidates: CANDIDATES.length,
    foundLolpros: 0,
    foundLeaguepedia: 0,
    accountsResolved: 0,
    accountsUnresolved: 0,
    skippedCN: 0,
    notableMisses: [],
    errors: [],
  };

  const resolvedByName = new Map<string, { id: string; seenKeys: Set<string> }>();

  // ---- Tier 1: lolpros profile-by-slug ----
  log(`tier 1: probing lolpros for ${CANDIDATES.length} candidates...`);
  for (const c of CANDIDATES) {
    let profile;
    try {
      profile = await getProfile(slugify(c.name));
    } catch (err) {
      result.errors.push(`lolpros ${c.name}: ${(err as Error).message}`);
      profile = null;
    }
    await sleep(400);
    if (!profile) continue;

    result.foundLolpros += 1;
    const role = roleFromLolProsPosition(profile.position ?? c.role);
    const team = profile.team?.name ?? c.team;
    const country = profile.country;
    await upsertPro(profile.uuid, profile.name, profile.slug, team, role, country);

    const seenKeys = new Set<string>();
    resolvedByName.set(c.name.toLowerCase(), { id: profile.uuid, seenKeys });

    for (const account of profile.accounts) {
      await processAccount(profile.uuid, c.name, account, seenKeys, result, log);
    }
  }
  log(`tier 1 done: ${result.foundLolpros}/${CANDIDATES.length} candidates have a lolpros profile`);

  // ---- Tier 2: Leaguepedia rosters ----
  if (!opts.skipLeaguepedia) {
    log(`tier 2: querying Leaguepedia for ${LEAGUEPEDIA_TEAM_GROUPS.flat().length} team rosters (3 chunks)...`);
    let firstChunk = true;
    for (const teams of LEAGUEPEDIA_TEAM_GROUPS) {
      if (!firstChunk) {
        log(`leaguepedia: waiting ${LEAGUEPEDIA_CHUNK_GAP_MS / 1000}s before next chunk...`);
        await sleep(LEAGUEPEDIA_CHUNK_GAP_MS);
      }
      firstChunk = false;

      const rows = await queryLeaguepediaTeams(teams, log, result);
      if (rows === null) break; // permanently rate-limited -- keep tier 1 results, stop here

      for (const row of rows) {
        if (!row.Player || !row.SoloqueueIds) continue;
        const nameKey = row.Player.toLowerCase();
        const candidate = CANDIDATES.find((c) => c.name.toLowerCase() === nameKey);

        let entry = resolvedByName.get(nameKey);
        if (!entry) {
          result.foundLeaguepedia += 1;
          const id = `lp2:${row.ID || row.Player}`;
          const role = roleFromLolProsPosition(row.Role ?? candidate?.role ?? null);
          const country = row.Country ?? null;
          await upsertPro(id, row.Player, slugify(row.Player), row.Team ?? candidate?.team ?? null, role, country);
          entry = { id, seenKeys: new Set<string>() };
          resolvedByName.set(nameKey, entry);
        } else {
          result.foundLeaguepedia += 1; // additional accounts merged into an existing (tier-1) pro
        }

        const fallbackRegion = candidate?.region ?? "NA";
        const rawIds = row.SoloqueueIds.split(/[,;]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const raw of rawIds) {
          const idx = raw.indexOf("#");
          if (idx < 0) continue;
          const gameName = raw.slice(0, idx).trim();
          const tagLine = raw.slice(idx + 1).trim();
          if (!gameName || !tagLine) continue;
          const server = inferServerFromTag(tagLine, fallbackRegion);
          const account: LolProsAccountRaw = {
            server,
            gamename: gameName,
            tagline: tagLine,
            summoner_name: `${gameName}#${tagLine}`,
            encrypted_puuid: null,
          };
          await processAccount(entry.id, row.Player, account, entry.seenKeys, result, log);
        }
      }
    }
  } else {
    log("tier 2 skipped (skipLeaguepedia option set)");
  }

  for (const c of CANDIDATES) {
    if (!resolvedByName.has(c.name.toLowerCase())) result.notableMisses.push(c.name);
  }

  return result;
}
