// ─────────────────────────────────────────────────────────────────────────────
// skillOrderData.js — the data layer for the CoachBuild in-game overlay.
//
// Plain ES module, no build step, no dependencies. Resolves a live champion
// name to coachless's numeric champion id, maps the user's selected lane to
// the API's RoleId, fetches GET /api/skill-order, and caches per
// (championId, roleId) for the current game.
//
// ── The 200-with-null contract (repo-wide convention, see
//    app/api/skill-order/route.ts's header) ─────────────────────────────────
// A successful HTTP 200 whose JSON body is a bare `null` means "we honestly
// have no recommended order for this champion+role" -- NOT an error, and not
// something to retry more eagerly than any other cache entry. This module
// preserves that distinction end-to-end as skillOrder.status === "no-data",
// separate from "error" (a genuine fetch/parse failure, retried on a short
// cooldown) and "ok" (a real SkillOrderModel).
//
// ── "Unavailable" vs "not found" (2026-07-27 audit fix #1) ─────────────────
// A network/DNS/CORS/5xx failure fetching /api/champions is NOT the same
// claim as "the champion list loaded fine and this name isn't in it." The
// first is "we don't know," the second is "we checked." Collapsing both into
// null-means-not-found was a confident lie: every game, on any network
// hiccup, the overlay would tell the player their OWN champion isn't
// recognized. resolveChampionId now returns a discriminated result so the
// caller (resolveOverlayData / ingame.js) can route the two to different,
// honest messages -- "unavailable" reuses the exact same string
// fetchSkillOrder's `error` status already renders, because it's the same
// underlying claim: the network, not the champion, is the problem.
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = "https://coachbuild.vercel.app";

/** ONE prefix Riot's Live Client Data API is known to send on the raw
 *  (non-localized) champion identifier -- see
 *  liveclientdata/playerlist[].rawChampionName, observed live 2026-07-27:
 *  `"game_character_displayname_Corki"`. Stripped defensively here in case
 *  the unstripped raw value ever reaches this module instead of engy's
 *  already-normalized `championName` field -- costs nothing, guards against
 *  a contract drift on his side silently producing "unresolved-champion"
 *  instead of a working champion for every single game. */
const RAW_CHAMPION_PREFIX = "game_character_displayname_";

/** TOP|JUNGLE|MID|BOT|SUPPORT -> RoleId (0-4). Confirmed against
 *  components/hextech/heroContracts.ts's LANE_TO_ROLE_ID (top:0, jungle:1,
 *  mid:2, bot:3, support:4) -- same numbers, upper-cased keys to match the
 *  exact values engy's desktop window persists to
 *  `localStorage["coachbuild.overwolf.lane"]`. Role id 5 ("let the API
 *  pick") is deliberately NOT reachable from here: the overlay only ever
 *  renders a table for the lane the user explicitly selected. */
export const LANE_TO_ROLE_ID = Object.freeze({
  TOP: 0,
  JUNGLE: 1,
  MID: 2,
  BOT: 3,
  SUPPORT: 4,
});

const LANE_LABEL = Object.freeze({
  TOP: "Top",
  JUNGLE: "Jungle",
  MID: "Mid",
  BOT: "Bot",
  SUPPORT: "Support",
});

export function laneLabel(lane) {
  return LANE_LABEL[lane] || lane || "";
}

/** Pure. Returns null for anything that isn't one of the five exact values --
 *  never guesses a fallback role. */
export function laneToRoleId(lane) {
  if (typeof lane !== "string") return null;
  const roleId = LANE_TO_ROLE_ID[lane];
  return roleId === undefined ? null : roleId;
}

/** Re-read on every call, deliberately never cached across calls -- the task
 *  brief is explicit that the lane can change between games and the desktop
 *  window is the source of truth, not this overlay's own memory of it. */
export function readLane() {
  try {
    const raw = window.localStorage.getItem("coachbuild.overwolf.lane");
    return laneToRoleId(raw) !== null ? raw : null;
  } catch {
    // localStorage can throw in some Overwolf window contexts (privacy mode,
    // storage disabled) -- degrade to "no lane selected", never crash the
    // overlay over a read that isn't essential to anything else on screen.
    return null;
  }
}

function normalizeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function stripRawPrefix(name) {
  return name.startsWith(RAW_CHAMPION_PREFIX) ? name.slice(RAW_CHAMPION_PREFIX.length) : name;
}

// ── Champion list (id resolution) ───────────────────────────────────────────

let championList = null; // ChampionRef[] once a fetch has succeeded
let championListLoading = null; // in-flight promise, deduped
let lastChampionListAttempt = 0;
/** Exported so ingame.js can arm its retry timer at the same cadence this
 *  module already gates re-attempts at (audit fix #2). */
export const CHAMPION_LIST_RETRY_COOLDOWN_MS = 5000;

/** @returns {Promise<{status:"ok", list: object[]} | {status:"unavailable"}>} */
async function getChampionList() {
  if (championList) return { status: "ok", list: championList };

  const now = Date.now();
  if (championListLoading) return championListLoading;
  if (now - lastChampionListAttempt < CHAMPION_LIST_RETRY_COOLDOWN_MS) {
    return { status: "unavailable" };
  }
  lastChampionListAttempt = now;

  championListLoading = fetch(`${API_BASE}/api/champions`)
    .then((res) => {
      if (!res.ok) throw new Error(`GET /api/champions -> HTTP ${res.status}`);
      return res.json();
    })
    .then((list) => {
      if (!Array.isArray(list)) throw new Error("GET /api/champions: unexpected shape");
      championList = list;
      return { status: "ok", list: championList };
    })
    .catch((err) => {
      console.warn("[CoachBuild overlay] champion list fetch failed:", err);
      return { status: "unavailable" };
    })
    .finally(() => {
      championListLoading = null;
    });

  return championListLoading;
}

/**
 * Resolve a live champion identifier to coachless's numeric champion id AND
 * its proper display name (audit fix #4 -- the raw/matching string is
 * frequently Riot's INTERNAL name, e.g. "MonkeyKing" for Wukong, and must
 * never be what's shown on screen).
 *
 * The exact string engy's state object carries in `championName` has not
 * been exercised against this resolver end-to-end (see HANDOFF). What IS
 * confirmed live (2026-07-27 capture) is that Riot's Live Client Data API
 * exposes both a LOCALIZED `championName` ("Corki") and a non-localized
 * `rawChampionName` ("game_character_displayname_Corki") on
 * /liveclientdata/playerlist -- and that ddragon/coachless champion keys
 * (what /api/champions' `key` field carries) are non-localized ASCII, so the
 * raw form is the one that actually matches on a non-English client. This
 * function therefore: (1) strips the raw prefix defensively in case it
 * arrives unstripped, (2) tries an exact match against both `key` and
 * `name`, (3) falls back to a normalized (lowercased, non-alnum-stripped)
 * match against both fields.
 *
 * @returns {Promise<{status:"ok", id:number, name:string} | {status:"not-found"} | {status:"unavailable"}>}
 *   "not-found"   -- the champion list loaded fine; this identifier isn't in
 *                    it. Renders the quiet "no skill data" state.
 *   "unavailable" -- the champion list itself could not be fetched. This is
 *                    a network claim, not a champion claim -- see this
 *                    file's header (audit fix #1).
 */
export async function resolveChampionId(championName) {
  if (!championName || typeof championName !== "string") return { status: "not-found" };

  const listResult = await getChampionList();
  if (listResult.status !== "ok") return { status: "unavailable" };
  const list = listResult.list;

  const cleaned = stripRawPrefix(championName);

  const exact = list.find((c) => c.key === cleaned || c.name === cleaned);
  if (exact) return { status: "ok", id: exact.id, name: exact.name };

  const norm = normalizeName(cleaned);
  const fuzzy = list.find((c) => normalizeName(c.key) === norm || normalizeName(c.name) === norm);
  if (fuzzy) return { status: "ok", id: fuzzy.id, name: fuzzy.name };

  return { status: "not-found" };
}

// ── Skill order fetch + per-game cache ──────────────────────────────────────

/** key `${championId}:${roleId}` -> { result, cachedAt } */
const skillOrderCache = new Map();
/** key `${championId}:${roleId}` -> in-flight Promise (audit fix #6). Mirrors
 *  the same in-flight dedup `championListLoading` already does above --
 *  without it, the two `handleState` calls that reliably overlap at load-in
 *  (the first GEP level tick, and champion-name resolution finishing a beat
 *  later) both miss the cache and both fire an identical request. Harmless
 *  today (renderToken already discards the loser's RENDER), but there's no
 *  reason to let the loser's REQUEST go out at all. */
const skillOrderLoading = new Map();

/** A transient network blip should not wedge the overlay for the whole game. */
export const ERROR_RETRY_COOLDOWN_MS = 15000;

/** "no-data" IS RETRIED TOO, and this is the correction of a wrong assumption
 *  worth spelling out, because the obvious reading is the opposite.
 *
 *  It is tempting to treat a 200 + null as settled -- the app genuinely has no
 *  order for some champion/role pairs, and re-asking cannot invent one. But
 *  that is not what a null actually means here. It is OBSERVED, not theorised,
 *  that the upstream source is flaky: during this file's own testing the SAME
 *  champion+role returned `no-data` and then `ok` within seconds of each other,
 *  reproduced by curling `/api/skill-order` directly. So a null conflates two
 *  different states -- "we have nothing for this" and "we briefly could not
 *  reach the source" -- and the wire format gives us no way to tell them apart.
 *
 *  Caching it for the game therefore fails in the worst possible direction: the
 *  overlay's FIRST fetch happens at load-in, and if that one lands in a blip the
 *  player gets an empty overlay for the entire match while a retry seconds later
 *  would have worked. An unnecessary refetch costs one request; a wedged cache
 *  costs the whole feature, for the one game the user actually wanted it.
 *
 *  The API route already agrees with this reading: it serves empty answers with
 *  `Cache-Control: no-store` and only lets a REAL payload earn a long s-maxage
 *  (repo gotcha (b)). It is built so a retry can get a better answer -- so the
 *  client should be built to ask for one.
 *
 *  Longer than the error cooldown because a null is more often genuine than an
 *  error is, so the hit rate on retrying it is lower. Not infinite, because the
 *  cost of being wrong is asymmetric.
 *
 *  A successful "ok" is never re-fetched: a skill order does not change mid-game.
 *
 *  Both exported (audit fix #2) so ingame.js can arm a retry timer using the
 *  SAME cooldown values this cache already enforces, instead of duplicating
 *  the numbers or guessing at them. */
export const NO_DATA_RETRY_COOLDOWN_MS = 60000;

/** Clears the per-game cache. Called on every false -> true transition of
 *  `inGame` (see resolveOverlayData) so a new game -- possibly a different
 *  champion on the same lane, or the same champion re-queued -- never serves
 *  a stale in-memory answer while its own fetch is in flight. Exported for
 *  tests. */
export function clearSkillOrderCache() {
  skillOrderCache.clear();
}

function isSkillOrderModelShape(v) {
  return (
    v &&
    typeof v === "object" &&
    Array.isArray(v.order) &&
    v.order.every((a) => a === "Q" || a === "W" || a === "E" || a === "R") &&
    typeof v.completed === "boolean" &&
    typeof v.sampleSize === "number"
  );
}

async function doFetchSkillOrder(championId, roleId) {
  let result;
  try {
    const res = await fetch(
      `${API_BASE}/api/skill-order?champ=${encodeURIComponent(championId)}&role=${encodeURIComponent(roleId)}`
    );
    if (!res.ok) {
      result = { status: "error", detail: `HTTP ${res.status}` };
    } else {
      const body = await res.json();
      if (body === null) {
        result = { status: "no-data" };
      } else if (isSkillOrderModelShape(body)) {
        result = { status: "ok", model: body };
      } else {
        result = { status: "error", detail: "unexpected /api/skill-order response shape" };
      }
    }
  } catch (err) {
    result = { status: "error", detail: err && err.message ? err.message : String(err) };
  }

  skillOrderCache.set(`${championId}:${roleId}`, { result, cachedAt: Date.now() });
  return result;
}

/**
 * @returns {Promise<{status:"ok", model: object} | {status:"no-data"} | {status:"error", detail:string}>}
 */
export async function fetchSkillOrder(championId, roleId) {
  const key = `${championId}:${roleId}`;

  const cached = skillOrderCache.get(key);
  if (cached) {
    // "ok" is never retried (a skill order does not change mid-game); the two
    // failure-ish answers each get their own cooldown. See the constants above
    // for why "no-data" is retried at all -- it is the non-obvious one.
    const cooldown =
      cached.result.status === "error"
        ? ERROR_RETRY_COOLDOWN_MS
        : cached.result.status === "no-data"
          ? NO_DATA_RETRY_COOLDOWN_MS
          : Infinity;
    if (Date.now() - cached.cachedAt <= cooldown) return cached.result;
  }

  const inFlight = skillOrderLoading.get(key);
  if (inFlight) return inFlight;

  const promise = doFetchSkillOrder(championId, roleId).finally(() => {
    skillOrderLoading.delete(key);
  });
  skillOrderLoading.set(key, promise);
  return promise;
}

// ── Orchestration ────────────────────────────────────────────────────────────

let wasInGame = false;

function normalizeLevel(level) {
  return Number.isInteger(level) && level >= 1 && level <= 18 ? level : null;
}

function normalizeRanks(ranks) {
  if (!ranks || typeof ranks !== "object") return null;
  const out = {};
  for (const a of ["Q", "W", "E", "R"]) {
    const v = ranks[a];
    out[a] = Number.isInteger(v) && v >= 0 ? v : null;
  }
  return out;
}

/**
 * Top-level entry point. Called on every `window.CoachBuildOverlay.onState`
 * push from engy's background controller (and, per audit fix #2, from
 * ingame.js's own retry timer when a prior call landed on a transient
 * failure). Re-reads the lane from localStorage every call (never cached
 * across calls, see readLane) and clears the per-game skill-order cache on
 * every inGame false -> true transition.
 *
 * `championName` arriving as null/undefined while `championLevel` is already
 * populated is a REAL, ORDINARY state (confirmed live: champion identity
 * comes off /liveclientdata/playerlist, a separate call from the level/ranks
 * on /liveclientdata/activeplayer, so one can legitimately land before the
 * other) -- handled as "waiting-for-champion", never as an error.
 *
 * @returns {Promise<object>} a `{ phase, ... }` object for ingame.js to render.
 *   Phases: "not-in-game" | "no-lane" | "waiting-for-champion" |
 *   "unresolved-champion" (champion list loaded, name not in it) |
 *   "unavailable" (champion list itself couldn't be fetched -- audit fix #1) |
 *   "resolved" (carries `skillOrder: {status: "ok"|"no-data"|"error", ...}`).
 */
export async function resolveOverlayData(state) {
  const inGame = !!(state && state.inGame);
  if (inGame && !wasInGame) clearSkillOrderCache();
  wasInGame = inGame;

  if (!inGame) return { phase: "not-in-game" };

  const lane = readLane();
  if (lane === null) return { phase: "no-lane" };

  const championName = state && state.championName;
  if (!championName) return { phase: "waiting-for-champion", lane };

  const champResult = await resolveChampionId(championName);
  if (champResult.status === "unavailable") return { phase: "unavailable", championName, lane };
  if (champResult.status === "not-found") return { phase: "unresolved-champion", championName, lane };

  const roleId = laneToRoleId(lane);
  const skillOrder = await fetchSkillOrder(champResult.id, roleId);

  return {
    phase: "resolved",
    championName,
    championDisplayName: champResult.name,
    championId: champResult.id,
    lane,
    skillOrder,
    championLevel: normalizeLevel(state.championLevel),
    abilityRanks: normalizeRanks(state.abilityRanks),
  };
}
