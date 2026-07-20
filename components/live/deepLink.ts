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
  role: LiveRoleId;
  /** Pairing token for the browser<->companion bridge. Null when the URL
   *  carries championId/role but no session (e.g. a hand-typed test URL) —
   *  the caller still applies the champion/lane, it just has nothing to
   *  persist for the bridge. */
  session: string | null;
}

const VALID_ROLES: readonly LiveRoleId[] = [0, 1, 2, 3, 4];

/** Parses the companion deep-link query string. Returns null for anything
 *  that isn't a well-formed champ-select link — every failure mode
 *  degrades to "not a live deep link," never a partial/guessed apply:
 *  - missing championId or role
 *  - non-numeric championId/role (parseInt truncates a stray "2.5" role to 2,
 *    which is accepted — the origin is always our own companion, not
 *    untrusted user input, so a truncated float is treated as a minor
 *    formatting slip rather than a rejection)
 *  - championId <= 0
 *  - role outside 0-4 (companion never emits 5/"Auto")
 *  `session` is read independently and is never required for the link to be
 *  considered valid — a missing session just means nothing to persist. */
export function parseLiveDeepLink(search: string): LiveDeepLink | null {
  const qs = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(qs);

  const championIdRaw = params.get("championId");
  const roleRaw = params.get("role");
  if (!championIdRaw || !roleRaw) return null;

  const championId = parseInt(championIdRaw, 10);
  if (!Number.isFinite(championId) || championId <= 0) return null;

  const role = parseInt(roleRaw, 10);
  if (!Number.isFinite(role) || !VALID_ROLES.includes(role as LiveRoleId)) return null;

  const session = params.get("session");

  return { championId, role: role as LiveRoleId, session };
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
