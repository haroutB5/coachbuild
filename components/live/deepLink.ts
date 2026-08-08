// ─────────────────────────────────────────────────────────────────────────────
// deepLink.ts — pure parsing for the companion's champ-select auto-open URL:
// `https://coachbuild.vercel.app/?championId=<id>&role=<0-4>&session=<token>`
// (companion.ps1's zero-bridge `Start-Process`, plan §2b / §0). Deliberately
// takes a raw query string (window.location.search) rather than
// URLSearchParams or Next's useSearchParams — app/page.tsx reads this on a
// MOUNT-ONLY effect per its own design note on avoiding router-param/
// useSheetBackNav pushState conflicts (see that file). Pure + JSX-free so it
// can be unit-tested from components/__tests__ without a DOM.
// ─────────────────────────────────────────────────────────────────────────────

import type { LaneId } from "@/components/hextech/heroContracts";

/** Companion/champ-select role ids — 0-4 only (never 5/"Auto"; that value is
 *  a coachless-API-only concept for the standalone Builds flow, never
 *  produced by champ-select's assignedPosition mapping). */
export type LiveRoleId = 0 | 1 | 2 | 3 | 4;

export interface LiveDeepLink {
  championId: number;
  /** Absent (undefined) for a ROLE-LESS deep link — companion.ps1 v1.2.0
   *  still opens when champ-select's `assignedPosition` is blank/unmapped
   *  (custom lobbies, blind pick, ARAM — anything without a real draft
   *  role), just without a `role=` param, instead of the old v1.1.0
   *  behavior of silently never opening at all for those modes. The web
   *  side (app/page.tsx) treats this case like a fresh manual champion pick
   *  — falls back to its own most-played-lane resolution rather than
   *  guessing or defaulting to a fixed lane. */
  role: LiveRoleId | undefined;
  /** Pairing token for the browser<->companion bridge. Null when the URL
   *  carries championId (and maybe role) but no session (e.g. a hand-typed
   *  test URL) — the caller still applies the champion/lane, it just has
   *  nothing to persist for the bridge. */
  session: string | null;
}

/** Canonical builds-page URL builder shared by companion-style handoffs.
 * Keep this beside parseLiveDeepLink so every web-side handoff uses the
 * companion's single championId/role/session convention. Role-less links omit
 * `role` entirely, matching companion.ps1. */
export interface LiveBuildDeepLinkInput {
  championId: number;
  role?: LiveRoleId | null;
  session: string;
}

export function buildLiveDeepLink({ championId, role, session }: LiveBuildDeepLinkInput): string {
  const roleParam = role === undefined || role === null ? "" : `&role=${role}`;
  return `/?championId=${encodeURIComponent(String(championId))}${roleParam}&session=${encodeURIComponent(session)}`;
}

const VALID_ROLES: readonly LiveRoleId[] = [0, 1, 2, 3, 4];

/** Parses the companion deep-link query string. Returns null for anything
 *  that isn't a well-formed champ-select link — every failure mode
 *  degrades to "not a live deep link," never a partial/guessed apply:
 *  - missing championId
 *  - non-numeric championId/role (parseInt truncates a stray "2.5" role to 2,
 *    which is accepted — the origin is always our own companion, not
 *    untrusted user input, so a truncated float is treated as a minor
 *    formatting slip rather than a rejection)
 *  - championId <= 0
 *  - role PRESENT but outside 0-4 (companion never emits 5/"Auto") — a
 *    malformed role is rejected outright rather than silently downgraded to
 *    role-less, since our own companion never emits one
 *  `role` itself is OPTIONAL — absent entirely means a role-less link (see
 *  LiveDeepLink.role's doc comment), which is a VALID link, not a rejection.
 *  `session` is likewise read independently and never required for the link
 *  to be considered valid — a missing session just means nothing to
 *  persist. */
export function parseLiveDeepLink(search: string): LiveDeepLink | null {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(qs);

  const championIdRaw = params.get("championId");
  if (!championIdRaw) return null;

  const championId = parseInt(championIdRaw, 10);
  if (!Number.isFinite(championId) || championId <= 0) return null;

  const roleRaw = params.get("role");
  let role: LiveRoleId | undefined;
  if (roleRaw !== null && roleRaw !== "") {
    const parsedRole = parseInt(roleRaw, 10);
    if (!Number.isFinite(parsedRole) || !VALID_ROLES.includes(parsedRole as LiveRoleId)) return null;
    role = parsedRole as LiveRoleId;
  }

  const session = params.get("session");

  return { championId, role, session };
}

const ROLE_TO_LANE: Record<LiveRoleId, LaneId> = {
  0: "top",
  1: "jungle",
  2: "mid",
  3: "bot",
  4: "support",
};

/** LCU/companion RoleId (0-4) -> the app's own LaneId vocabulary — the
 *  inverse of heroContracts.ts's LANE_TO_ROLE_ID. Kept here (not added to
 *  heroContracts.ts) since it's specifically a Live-deep-link concern, not a
 *  general hero-contracts one. */
export function roleIdToLane(role: LiveRoleId): LaneId {
  return ROLE_TO_LANE[role];
}
