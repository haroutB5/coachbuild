// ─────────────────────────────────────────────────────────────────────────────
// lib/draft/ugg.ts — u.gg stats2 CDN client for the "Draft" recommender's
// ingest pipeline (see _research/draft-feature-plan.md §2,
// _research/counterpick-research.md for the locked, empirically-verified
// endpoint shape). Fetches per-champion matchup + rankings JSON; decoding is
// pure/exported separately from the network call so it's testable against
// fixtures with zero network (see lib/__tests__/draft-ugg-decode.test.ts).
//
// NETWORK STATUS (2026-07-20, this build session, RESOLVED): stats2.u.gg
// REQUIRES a `Referer: https://u.gg/` header (403s without it — an
// app-level gate, not Cloudflare, per counterpick-research.md's original
// probe). This session's environment ALSO hit an unrelated wrinkle worth
// recording: the sandbox's Bash-tool `curl`, the WebFetch tool, and a real
// CDP-driven Chrome browser (mcp__chrome-devtools) were ALL Cloudflare-
// challenged against the entire u.gg zone (even https://u.gg/ itself) —
// but a `child_process.execFile('curl', ...)` spawned directly from Node
// (exactly what scripts/_curl-transport.mjs's curlTransportWithHeaders does,
// i.e. the REAL production path for scripts/ingest-draft.mjs) went through
// clean, every time. Confirmed live: Aatrox(266) vs Mordekaiser(82) at
// region 12/tier 10/role 4 decoded to raw row 3173/6100, and role-dominance
// probes (Garen top/LeeSin jungle/Viktor mid/Jinx adc/Thresh support) all
// confirmed UGG_ROLE_TO_APP_ROLE below is correct, with zero rawWins>games
// rows across every champion probed. So: the sandbox's own shell/tool-level
// HTTP paths are blocked (a real, reproducible finding, just not one that
// affects this feature), but the actual ingest transport is NOT — see
// HANDOFF-engy.md for the full probe log and figures.
//
// P0 CORRECTION (2026-07-21 — see decodeMatchupsJson's own doc comment for
// the full story): that 3173/6100 = 52.02% figure, and the byte-identical
// one counterpick-research.md cites as its "empirically verified" anchor,
// is NOT Aatrox's own winrate against Mordekaiser — it's Mordekaiser's.
// Both this file's original decoder AND the research doc took the raw
// `wins` column at face value as the FILE OWNER's wins; it's actually the
// OPPONENT's. Aatrox's real winrate in that matchup is the complement,
// 2927/6100 = 47.98%. The wins<=games invariant this comment used to cite
// as validation is satisfied by EITHER perspective and was never proof of
// anything here — decodeMatchupsJson now flips at decode time (`wins:
// games - rawWins`), and lib/draft/ingestGuard.ts adds a real cross-source
// sanity check so a future perspective/schema drift is self-detecting.
// decodeMatchupsJson stays defensive regardless (drops+counts anything
// that doesn't fit) as normal engineering hygiene. The rankings
// (champ_stats pickrate/banrate) shape is a SEPARATE, still-open question —
// see decodeRankingsJson's own comment for why this file deliberately does
// NOT trust it for `winrate` (which is derived from the matchups data
// above instead).
// ─────────────────────────────────────────────────────────────────────────────

import type { RoleId } from "@/lib/types";
import { resolveUggSchema, type UggSchemaVersion } from "@/lib/draft/patch";

export const UGG_REFERER = "https://u.gg/";
const USER_AGENT = "coachbuild-ingest/1.0";
const STATS_BASE = "https://stats2.u.gg/lol";

/** World region (empirically anchored per counterpick-research.md). */
export const WORLD_REGION = 12;
/** Emerald+ aggregate tier bucket — the ONLY tier this v1 ships (see plan
 *  §9's v1 scope: "one tier (10/Emerald+, world)"). */
export const EMERALD_TIER = 10;

/** u.gg's own per-endpoint role id -> this app's RoleId convention
 *  (0=TOP 1=JUNGLE 2=MID 3=BOT 4=SUPPORT). MUST be applied at ingest time —
 *  nothing downstream of lib/draft/ingest.ts ever sees a raw u.gg role id. */
export const UGG_ROLE_TO_APP_ROLE: Record<number, RoleId> = {
  4: 0, // top
  1: 1, // jungle
  5: 2, // mid
  3: 3, // adc/bottom
  2: 4, // support
};

export class UggRequestError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UggRequestError";
    this.status = status;
  }
}

/** An HTTP transport: given a URL (with the Referer header already baked in
 *  by the caller for a curl-based transport, or applied via fetch options
 *  for the default), returns the raw response body as text, or throws on
 *  any transport-level failure. Mirrors lib/prostage/cargo.ts's
 *  CargoExportTransport pattern exactly. */
export type UggTransport = (url: string) => Promise<string>;

/** Default transport: Node's global fetch, with the required Referer header
 *  applied here. Known (this session, see header comment) to be blocked by
 *  a network-level Cloudflare challenge in THIS sandbox — kept as the
 *  default because it's the only option app/route code has; the script path
 *  (scripts/ingest-draft.mjs) injects a curl-based transport instead (see
 *  scripts/_curl-transport.mjs's curlTransportWithHeaders), same precedent
 *  as lib/prostage/cargo.ts's cargoExportQuery. */
async function fetchUggTransport(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Referer: UGG_REFERER, "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new UggRequestError(`HTTP ${res.status}`, res.status);
  }
  return res.text();
}

function matchupsUrl(champId: number, patchSeg: string, schema: UggSchemaVersion): string {
  return `${STATS_BASE}/${schema.schema}/matchups/${patchSeg}/ranked_solo_5x5/${champId}/${schema.version}.json`;
}

function rankingsUrl(champId: number, patchSeg: string, schema: UggSchemaVersion): string {
  return `${STATS_BASE}/${schema.schema}/rankings/${patchSeg}/ranked_solo_5x5/${champId}/${schema.version}.json`;
}

async function fetchJson(url: string, transport: UggTransport): Promise<unknown> {
  const text = await transport(url);
  try {
    return JSON.parse(text);
  } catch {
    // A Cloudflare challenge page (or any non-JSON body) — never treat this
    // as "empty data" (would silently mask an outage as "no matchups").
    throw new UggRequestError("u.gg returned a non-JSON response (Cloudflare challenge?)");
  }
}

/** Probes the primary+fallback schema versions (see lib/draft/patch.ts) by
 *  attempting a real matchups fetch for `probeChampId` and checking it
 *  parses to SOME JSON object — used to resolve which schema version is
 *  currently live before the real per-champion walk begins. */
export function makeSchemaProbe(
  probeChampId: number,
  patchSeg: string,
  transport: UggTransport
): (schema: UggSchemaVersion) => Promise<boolean> {
  return async (schema: UggSchemaVersion): Promise<boolean> => {
    try {
      const body = await fetchJson(matchupsUrl(probeChampId, patchSeg, schema), transport);
      return typeof body === "object" && body !== null;
    } catch {
      return false;
    }
  };
}

export interface DecodedMatchupRow {
  oppId: number;
  wins: number;
  games: number;
}

export interface DecodeMatchupsResult {
  /** Rows keyed by APP role id (already mapped from u.gg's own role ids). */
  byRole: Partial<Record<RoleId, DecodedMatchupRow[]>>;
  /** Rows dropped for failing the wins<=games / non-negative / malformed
   *  shape check — counted, never silently included. */
  skippedRows: number;
}

/**
 * Pure decoder for one champion's matchups JSON. Shape (per
 * counterpick-research.md): `data[regionId][tierId][uggRoleId]` ->
 * `[ [rows], meta ]`, row = `[opponentChampionId, rawWins, matches, ...15
 * diff cols]`.
 *
 * P0 PERSPECTIVE FIX (2026-07-21, user-caught with external + internal
 * evidence — see migrations/0011_draft_perspective_fix.sql,
 * lib/draft/ingestGuard.ts, HANDOFF-engy.md): `rawWins` in champion X's OWN
 * matchups file is the OPPONENT's wins in that pairing, NOT X's — this row
 * is written from the opponent's perspective even though it lives in X's
 * file. The original decoder took `rawWins` at face value as X's own wins,
 * which silently mirror-flipped every baseline winrate and matchup delta
 * app-wide (proof: Mel mid's derived baseline landed at 54.6% against a
 * real ~44.8%; Ashe support at 55.2% against a real ~43.7% — near-exact
 * complements; a live Viktor mid "counters" list surfaced off-meta
 * marksmen "beating" him at 58-64%, which is actually VIKTOR crushing
 * THEM, read backwards). The wins<=games invariant and the research's
 * original Aatrox-vs-Mordekaiser 52.02% anchor both hold true under EITHER
 * perspective and could never have caught this alone — see
 * lib/draft/ingestGuard.ts's cross-source sanity check for the fix that
 * makes a future perspective/schema drift self-detecting instead of
 * user-detected.
 *
 * Fix: this champion's own wins is now computed as `games - rawWins`. The
 * raw row still has to satisfy `0 <= rawWins <= games` first (same shape
 * check as before, just applied to the raw value before flipping — a
 * validated raw value can never flip to something negative/out-of-range).
 * Violations are dropped and counted in `skippedRows`, never included.
 * Scoped to WORLD_REGION/EMERALD_TIER only (v1 scope — see this file's
 * header). Never throws on a missing/malformed region-tier-role node — an
 * absent bucket just contributes zero rows for that role, since coachless-
 * style CDN backfill gaps are expected for very new/niche champions.
 */
export function decodeMatchupsJson(
  raw: unknown,
  region: number = WORLD_REGION,
  tier: number = EMERALD_TIER
): DecodeMatchupsResult {
  const result: DecodeMatchupsResult = { byRole: {}, skippedRows: 0 };
  if (!raw || typeof raw !== "object") return result;

  const regionNode = (raw as Record<string, unknown>)[String(region)];
  if (!regionNode || typeof regionNode !== "object") return result;
  const tierNode = (regionNode as Record<string, unknown>)[String(tier)];
  if (!tierNode || typeof tierNode !== "object") return result;

  for (const [uggRoleStr, appRole] of Object.entries(UGG_ROLE_TO_APP_ROLE)) {
    const node = (tierNode as Record<string, unknown>)[uggRoleStr];
    if (!Array.isArray(node) || !Array.isArray(node[0])) continue;

    const rows: DecodedMatchupRow[] = [];
    for (const raw of node[0] as unknown[]) {
      if (!Array.isArray(raw) || raw.length < 3) {
        result.skippedRows += 1;
        continue;
      }
      const [oppId, rawWins, games] = raw as unknown[];
      if (typeof oppId !== "number" || typeof rawWins !== "number" || typeof games !== "number") {
        result.skippedRows += 1;
        continue;
      }
      if (rawWins < 0 || games < 0 || rawWins > games) {
        result.skippedRows += 1;
        continue;
      }
      // P0 fix: rawWins is the OPPONENT's wins in this row — this
      // champion's own wins is the complement.
      rows.push({ oppId, wins: games - rawWins, games });
    }
    result.byRole[appRole as unknown as RoleId] = rows;
  }

  return result;
}

/** Fetches + decodes one champion's matchups for the current patch. */
export async function fetchMatchups(
  champId: number,
  patchSeg: string,
  schema: UggSchemaVersion,
  transport: UggTransport = fetchUggTransport
): Promise<DecodeMatchupsResult> {
  const raw = await fetchJson(matchupsUrl(champId, patchSeg, schema), transport);
  return decodeMatchupsJson(raw);
}

export interface DecodedChampStats {
  /** By APP role id — winrate is ALWAYS null here (this decoder never
   *  fabricates it; see decodeRankingsJson's comment). */
  byRole: Partial<Record<RoleId, { pickrate: number | null; banrate: number | null }>>;
}

/**
 * Pure decoder for one champion's rankings JSON — UNVERIFIED SHAPE (see this
 * file's header comment: this session could not reach u.gg at all, so
 * NEITHER the URL nor the exact column layout below was live-checked).
 * Rather than guess at winrate/pickrate/banrate array indices and risk
 * silently baking a WRONG number into a scoring layer (a "plausible but
 * wrong" fabrication is worse than an honest null here), this decoder
 * currently extracts NOTHING — it always returns null pickrate/banrate for
 * every role, regardless of what `raw` contains. lib/draft/ingest.ts derives
 * `winrate` itself from the (verified-shape, already-fetched) matchups data
 * instead of trusting this endpoint for it at all.
 *
 * This is a deliberate, documented gap, not an oversight: BEFORE this stub
 * is replaced with real extraction logic, scripts/ingest-draft.mjs (or any
 * future run from a network that can actually reach u.gg) must dump a raw
 * rankings response, hand-verify winrate/pickrate/banrate against the LIVE
 * u.gg champion page for 2-3 champions, and only then wire up real index-
 * based extraction here. See HANDOFF-engy.md.
 */
export function decodeRankingsJson(_raw: unknown): DecodedChampStats {
  return { byRole: {} };
}

/** Fetches (and currently no-ops decodes, see decodeRankingsJson) one
 *  champion's rankings file. Kept as a real network call (not stubbed out
 *  entirely) so the URL/transport plumbing is exercised end-to-end and
 *  ready the moment decodeRankingsJson gets real extraction logic — a
 *  fetch failure here is swallowed (returns an empty result) rather than
 *  failing the whole ingest, since pickrate/banrate are optional
 *  (ChampBaseline treats null as "unknown", see lib/draft/score.ts). */
export async function fetchRankings(
  champId: number,
  patchSeg: string,
  schema: UggSchemaVersion,
  transport: UggTransport = fetchUggTransport
): Promise<DecodedChampStats> {
  try {
    const raw = await fetchJson(rankingsUrl(champId, patchSeg, schema), transport);
    return decodeRankingsJson(raw);
  } catch {
    return { byRole: {} };
  }
}

/** Named export of the default transport — lib/draft/ingest.ts resolves ONE
 *  concrete transport up front (opts.transport ?? defaultUggTransport) and
 *  reuses it for the schema probe AND every real fetch in a batch, rather
 *  than relying on each function's own default param independently. */
export { fetchUggTransport as defaultUggTransport };

/** Convenience re-export so ingest.ts's schema resolution doesn't need a
 *  second import path. */
export { resolveUggSchema };
export type { UggSchemaVersion };
