// ─────────────────────────────────────────────────────────────────────────────
// lib/pro/teamRegions.ts — curated tier-1 team name -> expected Riot platform
// region. Faker (T1, LCK -> KR) had 4 EUW bootcamp accounts and zero KR
// accounts polluting "recent games" with Oct-2024 pre-item-overhaul builds —
// this map lets ingest/roster logic deactivate a pro's off-region accounts
// rather than serving whichever region happened to get scraped.
//
// Curated, NOT derived: lolpros' `team` string is whatever the ladder/profile
// API returned, unnormalized, and drifts over time (sponsor rebrands — e.g.
// LEC's "MAD Lions KOI" became "Movistar KOI", BOTH observed as real values
// depending on when a pro's row was last refreshed; "Gen.G" vs "Gen.G
// Esports" both appear live in our own roster snapshot). Matched via
// normalizeTeamName (case-insensitive, strips a trailing "esports"/
// "e-sports" token, strips punctuation) so most Esports-suffix variance
// collapses to one key for free — genuinely different name ERAS (like the
// MAD Lions KOI / Movistar KOI rebrand) are listed as separate entries since
// they don't share a textual root.
//
// An unmatched-but-present team string is `{ kind: "unmapped" }` — the
// caller logs it and MUST NOT touch that pro's accounts. A wrong guess would
// silently deactivate a pro's real region (worse than leaving a stale
// bootcamp region active, which is merely misleading, not data-destructive).
// Deliberately excludes academy/challenger rosters (e.g. "Karmine Corp Blue",
// "G2 Hel", "Movistar KOI Fénix") even though several are observed live —
// the brief scopes this to CURRENT TIER-1 teams only; an academy player
// falls through to "unmapped" (logged, untouched) rather than guessed into
// their parent org's region.
// ─────────────────────────────────────────────────────────────────────────────

export type TeamRegionResult =
  | { kind: "region"; region: "KR" | "EUW" | "NA" }
  | { kind: "unreachable" } // LPL/CN — Riot API cannot serve these accounts at all
  | { kind: "unmapped" } // team string present but not in the curated map — log, don't guess
  | { kind: "none" }; // no team on file (null/empty) — ex-pro, streamer, etc.

const LCK_TEAMS = [
  "T1",
  "Gen.G Esports",
  "Hanwha Life Esports",
  "Dplus KIA",
  "KT Rolster",
  "DRX",
  "Nongshim RedForce",
  "BNK FEARX",
  "OKSavingsBank BRION",
  "DN Freecs",
];

const LEC_TEAMS = [
  "G2 Esports",
  "Fnatic",
  "MAD Lions KOI", // pre-rebrand name — kept for older/unrefreshed roster rows
  "Movistar KOI", // confirmed live 2026-07-09 in our own roster snapshot (post-rebrand)
  "Team BDS",
  "SK Gaming",
  "Team Heretics",
  "GIANTX",
  "Karmine Corp",
  "Team Vitality",
  "Rogue",
];

// LTA North (2025 rebrand of LCS) — both names kept for the same reason as
// the LEC rebrand above; lolpros data isn't guaranteed to have caught up.
const LTA_NORTH_TEAMS = [
  "FlyQuest",
  "Team Liquid",
  "Cloud9",
  "100 Thieves",
  "Dignitas",
  "Shopify Rebellion",
  "TSM",
  "Immortals",
  "NRG",
];

// LPL (China) — Riot's public API has no CN platform/regional routing at
// all, so these accounts are structurally unreachable regardless of which
// region string lolpros recorded. Full names (confirmed live where possible)
// plus common short codes, since lolpros data isn't consistent about which
// form it uses per pro.
const LPL_TEAMS = [
  "Bilibili Gaming",
  "BLG",
  "Top Esports",
  "TES",
  "JD Gaming",
  "JDG",
  "Weibo Gaming",
  "WBG",
  "Invictus Gaming",
  "iG",
  "LNG Esports",
  "LNG",
  "EDward Gaming",
  "EDG",
  "Royal Never Give Up",
  "RNG",
  "Oh My God",
  "OMG",
  "ThunderTalk Gaming",
  "TT",
  "Ultra Prime",
  "UP",
  "Anyone's Legend",
  "AL",
  "FunPlus Phoenix",
  "FPX",
  "LGD Gaming",
  "LGD",
  "Ninjas in Pyjamas",
  "NIP",
];

/** lowercase, strip a trailing "esports"/"e-sports" token, then strip all
 *  remaining non-alphanumeric characters. Collapses "Gen.G Esports" and
 *  "Gen.G" to the same key ("geng") without needing to enumerate both. */
export function normalizeTeamName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const withoutSuffix = trimmed.replace(/\s*e-?sports\s*$/i, "");
  return withoutSuffix.replace(/[^a-z0-9]/g, "");
}

function buildMap(): Map<string, TeamRegionResult> {
  const map = new Map<string, TeamRegionResult>();
  for (const t of LCK_TEAMS) map.set(normalizeTeamName(t), { kind: "region", region: "KR" });
  for (const t of LEC_TEAMS) map.set(normalizeTeamName(t), { kind: "region", region: "EUW" });
  for (const t of LTA_NORTH_TEAMS) map.set(normalizeTeamName(t), { kind: "region", region: "NA" });
  for (const t of LPL_TEAMS) map.set(normalizeTeamName(t), { kind: "unreachable" });
  return map;
}

const TEAM_REGION_MAP = buildMap();

/** Resolves a pro's `team` string to its expected-region verdict. Never
 *  throws, never guesses — see the module doc for the "unmapped" contract. */
export function expectedRegionForTeam(team: string | null | undefined): TeamRegionResult {
  if (!team || !team.trim()) return { kind: "none" };
  return TEAM_REGION_MAP.get(normalizeTeamName(team)) ?? { kind: "unmapped" };
}

export interface AccountForRegionRule {
  puuid: string;
  region: string;
  active: boolean;
}

export interface AccountRegionDecision {
  puuid: string;
  /** The rule's verdict for this account. `changed` tells the caller
   *  whether a DB write is actually needed. */
  active: boolean;
  changed: boolean;
}

export interface RegionRuleResult {
  decisions: AccountRegionDecision[];
  /** Set only when the team string is present but not in the curated map —
   *  the caller should log this so the map can be extended later. Never set
   *  for a null/empty team (that's the expected "ex-pro" case, not a gap). */
  unmappedTeam?: string;
}

/** Pure decision function — never touches the DB, never throws. Applies
 *  Directive 1's rule:
 *   - team maps to a concrete region (KR/EUW/NA): active = (account.region
 *     == expected). This CAN flip an account that was inactive for an
 *     unrelated reason (e.g. puuidResolve.ts couldn't validate it against
 *     our Riot key) back to active=true if its region happens to match —
 *     accepted tradeoff, not fixed here: the brief's rule is stated as a
 *     flat assignment, and cross-referencing "was this inactive for a
 *     DIFFERENT reason" wasn't asked for. A reactivated-but-invalid account
 *     just fails again on its next ingest attempt (RiotRequestError,
 *     caught+skipped) — self-correcting, not silently wrong.
 *   - team maps to "unreachable" (LPL/CN): if a KR account exists, ONLY it
 *     becomes/stays active (bootcamp = the only reachable region for a CN
 *     pro); otherwise the WHOLE set is left unchanged (never guess which
 *     unreachable-region account to prefer).
 *   - team is null/unmapped: every account is left EXACTLY as-is (not
 *     force-activated) — this rule only ever DEACTIVATES off-region
 *     accounts for a KNOWN team; it has no opinion on accounts whose
 *     activity state came from a different mechanism (puuid resolution)
 *     when there's no team to check against. */
export function decideAccountRegionActivation(
  team: string | null | undefined,
  accounts: AccountForRegionRule[]
): RegionRuleResult {
  const verdict = expectedRegionForTeam(team);
  const unchanged = (): RegionRuleResult => ({
    decisions: accounts.map((a) => ({ puuid: a.puuid, active: a.active, changed: false })),
  });

  if (verdict.kind === "none") return unchanged();
  if (verdict.kind === "unmapped") return { ...unchanged(), unmappedTeam: team as string };

  if (verdict.kind === "region") {
    const decisions = accounts.map((a) => {
      const active = a.region.toUpperCase() === verdict.region;
      return { puuid: a.puuid, active, changed: active !== a.active };
    });
    return { decisions };
  }

  // verdict.kind === "unreachable"
  const hasKr = accounts.some((a) => a.region.toUpperCase() === "KR");
  if (!hasKr) return unchanged();
  const decisions = accounts.map((a) => {
    const active = a.region.toUpperCase() === "KR";
    return { puuid: a.puuid, active, changed: active !== a.active };
  });
  return { decisions };
}
