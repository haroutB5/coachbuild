// ─────────────────────────────────────────────────────────────────────────────
// lib/otp/leaderboard.ts — WHO the one-tricks are.
//
// Wraps op.gg's `lol_list_champion_leaderboard` MCP tool: "the top master+
// players for a champion/region." That is the only source in this app that
// answers "who spams this champion," which is the whole premise of the OTP
// section (user request, 2026-07-28).
//
// READ lib/opgg.ts's header first — this is the SAME undocumented endpoint
// and every discipline it establishes applies verbatim here:
//   * FAIL TO NULL/EMPTY, NEVER TO WRONG. Any transport error, JSON-RPC
//     error, unexpected field set or unparseable value yields an empty list,
//     which yields no OTP card. A missing card is fine; a card built from a
//     mis-read payload is not.
//   * MAP FIELDS BY NAME. The payload declares its own field order and that
//     order is NOT stable (live-verified on the analysis tool). Positional
//     indices would silently read `win` as `play`.
//
// ── WHAT THIS DOES *NOT* GIVE US (verified live 2026-07-28) ─────────────────
// The leaderboard's `puuid` is NOT usable against our Riot key: every one
// probed returns `400 Bad Request - Exception decrypting <puuid>` from both
// account-v1 and match-v5. It is an op.gg-scoped identifier, not a Riot one.
// So the puuid is deliberately NOT read here. `game_name` + `tagline` are,
// and lib/otp/ingest.ts re-resolves them to a real PUUID through Riot's
// account-v1 by-riot-id — exactly the fallback lib/pro/puuidResolve.ts
// already does for lolpros-supplied accounts.
// ─────────────────────────────────────────────────────────────────────────────

import {
  OPGG_MCP_URL,
  extractCall,
  extractEnvelopeText,
  parseClassHeader,
  parseEnvelope,
  sameFieldSet,
  splitTopLevelArgs,
  type OpggTransport,
} from "../opgg";
import { fetchWithTimeout } from "../fetchTimeout";

/** One leaderboard entry, reduced to the fields this app actually uses. */
export interface OtpCandidate {
  /** op.gg leaderboard position, 1-based. */
  rank: number;
  gameName: string;
  tagLine: string;
  /** Games this player has on THIS champion (the leaderboard's own count). */
  championPlays: number;
  championWins: number;
  /** Highest tier op.gg lists for them, e.g. "CHALLENGER". Null when absent —
   *  never defaulted to a tier we didn't read. */
  tier: string | null;
}

// Field sets we require, BY NAME. Captured live 2026-07-28 against
// champion=VIKTOR, region=EUW with the desired_output_fields below.
const LEADERBOARD_FIELDS = ["rank", "summoner", "most_champion_stat"] as const;
const SUMMONER_FIELDS = ["puuid", "game_name", "tagline", "level", "league_stats"] as const;
const MOST_CHAMPION_FIELDS = ["id", "play", "win", "lose", "op_score"] as const;
const TIER_INFO_FIELDS = ["tier", "division", "lp"] as const;

/** Builds the JSON-RPC request. `desired_output_fields` keeps the payload to
 *  the ~2.6 kB we parse instead of the full profile dump. */
export function buildLeaderboardRpc(region: string, champion: string): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "lol_list_champion_leaderboard",
      arguments: {
        region,
        champion,
        desired_output_fields: [
          "champion",
          "region",
          "leaderboard[].rank",
          "leaderboard[].most_champion_stat.{id,play,win,lose,op_score}",
          "leaderboard[].summoner.{puuid,game_name,tagline,level}",
          "leaderboard[].summoner.league_stats[].tier_info.{tier,division,lp}",
        ],
      },
    },
  };
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseQuotedString(raw: string | undefined): string | null {
  if (raw == null) return null;
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(raw.trim());
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
}

/**
 * Parse a `lol_list_champion_leaderboard` text payload into candidates.
 *
 * Exported because this is where a provider reshape gets caught — unit-tested
 * against a real captured payload.
 *
 * `expectChampionId` is checked against every row's `most_champion_stat.id`:
 * the leaderboard is champion-scoped, so a row whose stat block is for a
 * DIFFERENT champion means we have misunderstood the payload, and its play
 * count would be "games on some other champion" — the exact plausible-but-
 * wrong number this module exists to refuse. Such rows are dropped.
 *
 * Returns [] on any deviation from the expected shape.
 */
export function parseLeaderboard(text: string, expectChampionId: number): OtpCandidate[] {
  if (typeof text !== "string" || !text.length) return [];

  const classes = parseClassHeader(text);
  const lbFields = classes.get("Leaderboard");
  const sumFields = classes.get("Summoner");
  const mcsFields = classes.get("MostChampionStat");
  if (!lbFields || !sameFieldSet(lbFields, LEADERBOARD_FIELDS)) return [];
  if (!sumFields || !sameFieldSet(sumFields, SUMMONER_FIELDS)) return [];
  if (!mcsFields || !sameFieldSet(mcsFields, MOST_CHAMPION_FIELDS)) return [];
  // TierInfo is OPTIONAL: an unrecognised tier shape costs us the tier label
  // only, never the candidate. Smallest-granularity failure, same asymmetry
  // lib/opgg.ts applies to SkillMasteries vs Skills.
  const tierFields = classes.get("TierInfo");
  const tierReadable = Boolean(tierFields && sameFieldSet(tierFields, TIER_INFO_FIELDS));

  // Body only — never let a `class ...` header line parse as a call.
  const headerEnd = text.indexOf("\n\n");
  const body = headerEnd >= 0 ? text.slice(headerEnd + 2) : text;

  const out: OtpCandidate[] = [];
  let cursor = 0;
  for (;;) {
    const entry = extractCall(body, "Leaderboard", cursor);
    if (!entry) break;
    cursor = entry.start + 1;

    const args = splitTopLevelArgs(entry.inner);
    if (args.length !== lbFields.length) continue;
    const lbField = (name: string) => args[lbFields.indexOf(name)];

    const rank = parseNumber(lbField("rank"));
    if (rank == null) continue;

    const summoner = extractCall(lbField("summoner") ?? "", "Summoner");
    const stat = extractCall(lbField("most_champion_stat") ?? "", "MostChampionStat");
    if (!summoner || !stat) continue;

    const sArgs = splitTopLevelArgs(summoner.inner);
    const mArgs = splitTopLevelArgs(stat.inner);
    if (sArgs.length !== sumFields.length || mArgs.length !== mcsFields.length) continue;

    const championId = parseNumber(mArgs[mcsFields.indexOf("id")]);
    if (championId !== expectChampionId) continue;

    const gameName = parseQuotedString(sArgs[sumFields.indexOf("game_name")]);
    const tagLine = parseQuotedString(sArgs[sumFields.indexOf("tagline")]);
    const plays = parseNumber(mArgs[mcsFields.indexOf("play")]);
    const wins = parseNumber(mArgs[mcsFields.indexOf("win")]);
    if (!gameName || !tagLine || plays == null || wins == null) continue;

    let tier: string | null = null;
    if (tierReadable) {
      const ti = extractCall(sArgs[sumFields.indexOf("league_stats")] ?? "", "TierInfo");
      if (ti) {
        const tArgs = splitTopLevelArgs(ti.inner);
        if (tArgs.length === tierFields!.length) {
          tier = parseQuotedString(tArgs[tierFields!.indexOf("tier")]);
        }
      }
    }

    out.push({ rank, gameName, tagLine, championPlays: plays, championWins: wins, tier });
  }

  return out;
}

const defaultTransport: OpggTransport = async (body) => {
  const res = await fetchWithTimeout(OPGG_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // MCP streamable-HTTP negotiates down to plain JSON for us, but the SSE
      // type must still be advertised or it 406s.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
    // Discovery runs from an ingest job, not a page render, and the whole
    // point is to notice roster churn — so no Next data-cache revalidate
    // window here (unlike lib/opgg.ts's 6 h skill-order cache). The DB row's
    // own `last_discovered_at` is the rate limiter.
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`op.gg mcp → ${res.status} ${res.statusText}`);
  return parseEnvelope(await res.text());
};

/**
 * Fetch the top one-trick candidates for a champion in one region.
 *
 * Returns [] — never throws — for every "we don't have this" case, so an
 * ingest loop can treat a dead provider as "no new candidates this pass"
 * rather than a failed run.
 *
 * `opggChampion` is the UPPER_SNAKE_CASE name; callers get it from
 * lib/opgg.ts's `opggChampionName` so there is exactly one champion-name
 * transform in the codebase.
 */
export async function fetchOtpCandidates(
  opggChampion: string,
  championId: number,
  region: string,
  transport: OpggTransport = defaultTransport
): Promise<OtpCandidate[]> {
  try {
    const envelope = await transport(buildLeaderboardRpc(region, opggChampion));
    const text = extractEnvelopeText(envelope);
    if (!text) return [];
    return parseLeaderboard(text, championId);
  } catch {
    return [];
  }
}
