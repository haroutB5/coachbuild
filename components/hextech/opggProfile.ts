// ─────────────────────────────────────────────────────────────────────────────
// OP.GG profile links for a Riot account.
//
// Pure, no JSX, vitest-importable — the region mapping is the whole reason this
// is a module instead of a template string in FeaturedOtpCard's header.
//
// THE REGION IS THE TRAP. `otp_accounts.server` (surfaced as
// FeaturedOtpResponse.player.server) is a Riot PLATFORM id — live values seen
// 2026-07-29 are `EUW1`, `NA1`. OP.GG's URL wants its own region slug, and that
// slug is NOT a lowercased platform: `EUW1` -> `euw`, `EUN1` -> `eune`,
// `LA1` -> `lan`. A naive `server.toLowerCase()` produces `euw1`, which is a
// live 404 on a stranger's profile — worse than not linking at all.
//
// UNKNOWN PLATFORM -> null, ALWAYS. A guessed slug is a dead link to someone
// else's page, so an unmapped or missing platform must fall back to plain text
// at the call site rather than to a best-effort URL.
//
// DO NOT reach for `match_routing` here. That column is the regional ROUTING
// CLUSTER (`europe` / `americas` / `asia`) that Riot's match-v5 calls need, and
// this repo has already banked the lesson that a leaderboard's server label and
// the routing that actually holds an account's games can disagree. OP.GG asks
// "which shard is this account on", which is the platform. Different field,
// different question.
// ─────────────────────────────────────────────────────────────────────────────

/** Riot platform id (uppercase, as stored) -> OP.GG region slug. */
const PLATFORM_TO_OPGG_REGION: Readonly<Record<string, string>> = {
  BR1: "br",
  EUN1: "eune",
  EUW1: "euw",
  JP1: "jp",
  KR: "kr",
  LA1: "lan",
  LA2: "las",
  ME1: "me",
  NA1: "na",
  OC1: "oce",
  PH2: "ph",
  RU: "ru",
  SG2: "sg",
  TH2: "th",
  TR1: "tr",
  TW2: "tw",
  VN2: "vn",
};

/** The OP.GG region slug for a Riot platform id, or null when the platform is
 *  missing, blank, or one we have no verified slug for. Case/whitespace
 *  tolerant on input because the value travels through JSON from a scraped
 *  source, not from a typed enum. */
export function opggRegion(server: string | null | undefined): string | null {
  if (typeof server !== "string") return null;
  const key = server.trim().toUpperCase();
  if (key === "") return null;
  return PLATFORM_TO_OPGG_REGION[key] ?? null;
}

/**
 * Canonical OP.GG profile URL for a Riot ID, or null when it cannot be built
 * honestly.
 *
 * The canonical host/path is `https://op.gg/lol/summoners/<region>/<name>-<tag>`
 * — verified 200 live on 2026-07-29. `www.op.gg/summoners/...` and
 * `op.gg/summoners/...` both 308 to it, so this links the canonical form
 * directly rather than depending on a redirect that can be retired.
 *
 * Name and tag are `encodeURIComponent`d individually. Game names legitimately
 * contain spaces ("TWTV Peng04"), and the separator between name and tag is a
 * literal `-` that must NOT be encoded — which is exactly why the two halves
 * are encoded separately instead of the whole path being encoded at once.
 */
export function opggProfileUrl(
  server: string | null | undefined,
  gameName: string | null | undefined,
  tagLine: string | null | undefined
): string | null {
  const region = opggRegion(server);
  if (region === null) return null;
  if (typeof gameName !== "string" || gameName.trim() === "") return null;
  if (typeof tagLine !== "string" || tagLine.trim() === "") return null;
  return `https://op.gg/lol/summoners/${region}/${encodeURIComponent(gameName)}-${encodeURIComponent(tagLine)}`;
}
