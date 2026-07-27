// Pure normaliser for League of Legends live game state, derived from Overwolf's
// live_client_data GEP feature (which mirrors Riot's local Live Client Data API,
// https://127.0.0.1:<port>/liveclientdata/*). NOTHING in this file calls an Overwolf
// API or does I/O -- it only ever receives raw blobs (already fetched by background.js)
// and returns typed, safe-to-render pieces of state. That's what makes it unit-testable
// without a running game or a running Overwolf process.
//
// ---------------------------------------------------------------------------------
// WHY CHAMPION NAME AND LEVEL/ABILITIES ARE RESOLVED SEPARATELY, NOT AS ONE OBJECT
// ---------------------------------------------------------------------------------
// Confirmed against a REAL captured Practice Tool payload (2026-07-27), the full
// top-level key set of /liveclientdata/activeplayer is:
//   abilities, championStats, currentGold, fullRunes, level, riotId,
//   riotIdGameName, riotIdTagLine, summonerName, teamRelativeColors
// There is NO champion-identity field on active_player. Champion name only exists on
// the PLAYER LIST (/liveclientdata/playerlist), matched to the local player by riotId,
// e.g. observed: {"riotId":"MunsterHunter#EUW","championName":"Corki",
// "rawChampionName":"game_character_displayname_Corki","team":"ORDER","position":"NONE"}.
// `rawChampionName` is preferred (strip the "game_character_displayname_" prefix) because
// `championName` is LOCALISED and breaks id resolution on a non-English client.
//
// The two sources arrive on different cadences (GEP push vs. an HTTP poll background.js
// runs separately -- see liveClientHttp.js), so championName is allowed to resolve LATER
// than championLevel/abilityRanks. Callers must NOT withhold a state push waiting for
// championName -- "level known, champion not yet" is an ordinary, expected state, not a
// partial/broken one. Keep these as two independent patches merged by mergeState(), never
// a single all-or-nothing object across both sources.
//
// Within EACH source, all-or-nothing still applies: a level/abilities reading missing
// even one of level/Q/W/E/R produces null for BOTH rather than a partially-populated
// object -- a defaulted-zero rank is indistinguishable from "not yet ranked", so treating
// a partial reading as real would silently invert "no data" into "rank 0". The caller
// (background.js) is expected to carry the last full reading forward rather than patch a
// partial one in -- normalizeGameState()/parseLevelAndAbilities() never do that
// themselves; they are pure functions of one snapshot, not a stream.
// ---------------------------------------------------------------------------------

export const EMPTY_STATE = Object.freeze({
  inGame: false,
  championLevel: null,
  championName: null,
  abilityRanks: null,
});

const RAW_CHAMPION_NAME_PREFIX = 'game_character_displayname_';
const ABILITY_KEYS = ['Q', 'W', 'E', 'R']; // NOT generic iteration: `abilities.Passive`
// exists in the real payload and has no `abilityLevel` -- summing/iterating it blind
// injects a bogus rank. Only these four named keys are ever read.

// GEP stringifies leaves inconsistently -- some scalars/objects arrive as JSON strings,
// others as native values (Overwolf's own docs example: `port` stays a bare number while
// its sibling `events` is stringified). Always go through this before touching a shape.
function coerce(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value; // genuine string (e.g. a name), not JSON -- leave as-is
  }
}

// Exported (not just internal) because it's the same coercion background.js needs
// for `live_client_data.port` -- the one leaf that was found bypassing this module's
// own "always coerce" rule. One coercion helper, used everywhere a GEP leaf needs it,
// rather than a second hand-rolled Number() cast living in background.js.
export function toFiniteInt(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Parse level + Q/W/E/R ranks from one `active_player` blob (string or object).
 * All-or-nothing: returns null unless level and every one of Q/W/E/R resolve to a
 * finite integer. Large single-tick level jumps (observed: a Practice Tool level
 * cheat took 2 -> 7 in one update) are NOT treated as invalid -- there is no delta
 * check here on purpose.
 *
 * @returns {{level: number, abilityRanks: {Q:number,W:number,E:number,R:number}} | null}
 */
export function parseLevelAndAbilities(activePlayerRaw) {
  const activePlayer = coerce(activePlayerRaw);
  if (!activePlayer || typeof activePlayer !== 'object') return null;

  const level = toFiniteInt(activePlayer.level);
  if (level === null) return null;

  const abilitiesRaw = coerce(activePlayer.abilities);
  if (!abilitiesRaw || typeof abilitiesRaw !== 'object') return null;

  const abilityRanks = {};
  for (const key of ABILITY_KEYS) {
    const ability = coerce(abilitiesRaw[key]);
    if (!ability || typeof ability !== 'object') return null;
    const rank = toFiniteInt(ability.abilityLevel);
    if (rank === null) return null;
    abilityRanks[key] = rank;
  }

  return { level, abilityRanks };
}

/**
 * Pull the local player's riotId (e.g. "MunsterHunter#EUW") off an active_player blob,
 * so background.js can match it against the player list. Independent of
 * parseLevelAndAbilities -- a missing/invalid ability reading should not block resolving
 * who the local player is.
 */
export function extractLocalRiotId(activePlayerRaw) {
  const activePlayer = coerce(activePlayerRaw);
  if (!activePlayer || typeof activePlayer !== 'object') return null;
  const riotId = coerce(activePlayer.riotId);
  return typeof riotId === 'string' && riotId.length > 0 ? riotId : null;
}

/**
 * Resolve the local player's champion name from a playerlist response, matched by
 * riotId (present and identical on both /activeplayer and /playerlist entries,
 * tagline included). Prefers rawChampionName (locale-independent) over the localised
 * championName field.
 *
 * @param {*} playerListRaw - array (or JSON string of an array) from
 *   /liveclientdata/playerlist.
 * @param {string|null} riotId - local player's riotId from extractLocalRiotId().
 * @returns {string|null}
 */
export function resolveChampionName(playerListRaw, riotId) {
  if (!riotId) return null;
  const playerList = coerce(playerListRaw);
  if (!Array.isArray(playerList)) return null;

  const entry = playerList.find((p) => p && coerce(p.riotId) === riotId);
  if (!entry) return null;

  const raw = typeof entry.rawChampionName === 'string' ? entry.rawChampionName : null;
  if (raw && raw.startsWith(RAW_CHAMPION_NAME_PREFIX)) {
    const stripped = raw.slice(RAW_CHAMPION_NAME_PREFIX.length);
    if (stripped) return stripped;
  }

  return typeof entry.championName === 'string' && entry.championName.length > 0
    ? entry.championName
    : null;
}

/**
 * Merge a partial patch into the previous state. Used by background.js to apply the
 * two independent update streams (GEP level/abilities tick, HTTP playerlist poll)
 * without either one clobbering the other's most recent value.
 */
export function mergeState(prev, patch) {
  return { ...prev, ...patch };
}

/**
 * Convenience wrapper for the common "game just stopped" / "no reading yet" case.
 */
export function emptyStateFor(inGame) {
  return { ...EMPTY_STATE, inGame };
}
