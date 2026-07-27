// Pure normaliser for League of Legends live game state.
//
// PORTED 2026-07-27 (Overwolf -> Electron overlay-host pivot) from
// overwolf/js/gameState.js. Overwolf's `live_client_data` GEP feature is gone
// entirely -- main.js polls Riot's Live Client Data API directly
// (https://127.0.0.1:2999/liveclientdata/*) via Node's `https`, so every blob
// this module receives is already a JSON.parse'd object, not a GEP envelope.
// Converted to CommonJS (require/module.exports) because this file now runs in
// Electron's MAIN process (Node), not a browser `<script type="module">` context
// like the Overwolf version did -- this is the one mechanical change; every
// parsing rule, the Passive-key exclusion, the all-or-nothing gate, and the
// riotId-matched champion-name resolution are unchanged and were already
// verified against the real captured Practice Tool payload at
// _capture/live-client-raw-20260727-140136.jsonl (see HANDOFF-engy.md).
//
// The `coerce()` string/object duality helper is KEPT rather than stripped --
// it was GEP-specific in origin (GEP stringifies leaves inconsistently) but
// costs nothing defensively here, and Riot's API returning a stringified
// sub-object is not something this file has independently ruled out.
//
// ---------------------------------------------------------------------------------
// WHY CHAMPION NAME AND LEVEL/ABILITIES ARE RESOLVED SEPARATELY, NOT AS ONE OBJECT
// ---------------------------------------------------------------------------------
// Confirmed against the REAL captured Practice Tool payload (2026-07-27), the full
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
// The two endpoints are polled on different cadences by main.js (activeplayer more
// frequently than playerlist -- see lib/liveClientHttp.js and main.js), so
// championName is allowed to resolve LATER than championLevel/abilityRanks. Callers
// must NOT withhold a state push waiting for championName -- "level known, champion
// not yet" is an ordinary, expected state, not a partial/broken one. Keep these as
// two independent patches merged by mergeState(), never a single all-or-nothing
// object across both sources.
//
// Within EACH source, all-or-nothing still applies: a level/abilities reading missing
// even one of level/Q/W/E/R produces null for BOTH rather than a partially-populated
// object -- a defaulted-zero rank is indistinguishable from "not yet ranked", so treating
// a partial reading as real would silently invert "no data" into "rank 0". The caller
// (main.js) is expected to carry the last full reading forward rather than patch a
// partial one in -- parseLevelAndAbilities() never does that itself; it is a pure
// function of one snapshot, not a stream.
// ---------------------------------------------------------------------------------

const EMPTY_STATE = Object.freeze({
  inGame: false,
  championLevel: null,
  championName: null,
  abilityRanks: null,
  // `lane` -- the user's MANUAL lane override (TOP/JUNGLE/MID/BOT/SUPPORT), or
  // null. Owned and persisted by main.js (lib/laneSettings.js), not this
  // module -- carried here purely as a field of the pushed state object so
  // the renderer's existing onState plumbing picks it up for free (added
  // 2026-07-27, see HANDOFF-engy.md round 4).
  lane: null,
  // `detectedPosition` -- the RAW string off the local player's own
  // /liveclientdata/playerlist entry (Riot's own vocabulary: "TOP",
  // "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY", "NONE"), unmapped. Mapping to
  // this app's lane names happens in js/skillOrderData.js (renderer side),
  // not here -- this module stays a pure pass-through of what was observed.
  detectedPosition: null,
});

const RAW_CHAMPION_NAME_PREFIX = 'game_character_displayname_';
const ABILITY_KEYS = ['Q', 'W', 'E', 'R']; // NOT generic iteration: `abilities.Passive`
// exists in the real payload and has no `abilityLevel` -- summing/iterating it blind
// injects a bogus rank. Only these four named keys are ever read.

// Defensive-only here (see file header) -- not load-bearing the way it was against
// GEP, but costs nothing to keep.
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

function toFiniteInt(value) {
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
function parseLevelAndAbilities(activePlayerRaw) {
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
 * so main.js can match it against the player list. Independent of
 * parseLevelAndAbilities -- a missing/invalid ability reading should not block resolving
 * who the local player is.
 */
function extractLocalRiotId(activePlayerRaw) {
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
 * Compliance note: this ONLY ever reads the entry matching the LOCAL player's own
 * riotId. Nothing about any OTHER player (name, champion, position, team) is
 * extracted, stored, or returned -- see main.js's call site, which discards the
 * rest of the array immediately after this call returns. (`extractLocalPosition`
 * below reads the SAME single entry for the local player's own assigned role --
 * that is the user's own data, same category as their own champion/level, not
 * enemy or teammate data.)
 *
 * @param {*} playerListRaw - array (or JSON string of an array) from
 *   /liveclientdata/playerlist.
 * @param {string|null} riotId - local player's riotId from extractLocalRiotId().
 * @returns {string|null}
 */
function resolveChampionName(playerListRaw, riotId) {
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
 * Pull the local player's RAW `position` string off the same playerlist entry
 * `resolveChampionName` reads (2026-07-27 fix -- lane auto-detection).
 *
 * Riot's documented values: "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY",
 * "NONE". Returned UNMAPPED and un-normalized -- mapping to this app's own
 * lane vocabulary (TOP/JUNGLE/MID/BOT/SUPPORT) happens in the renderer
 * (js/skillOrderData.js's mapPositionToLane), keeping this module a pure
 * pass-through of what was actually observed rather than baking a mapping
 * table into the main process too.
 *
 * HONESTY NOTE: only "NONE" has been directly OBSERVED on this machine (in a
 * Practice Tool capture, where NONE is the objectively correct answer for a
 * custom game with no assigned roles -- see
 * _capture/live-client-report-20260727-140136.txt). That a matchmade game
 * populates this field with a real role is Riot's documented behaviour, not
 * something verified here -- main.js logs the raw value once per game so the
 * next real match is the experiment that confirms it.
 *
 * @returns {string|null} the raw position string, or null if the entry/field
 *   is missing entirely (distinct from a present-but-empty "NONE").
 */
function extractLocalPosition(playerListRaw, riotId) {
  if (!riotId) return null;
  const playerList = coerce(playerListRaw);
  if (!Array.isArray(playerList)) return null;

  const entry = playerList.find((p) => p && coerce(p.riotId) === riotId);
  if (!entry) return null;

  return typeof entry.position === 'string' && entry.position.length > 0 ? entry.position : null;
}

/**
 * Merge a partial patch into the previous state. Used by main.js to apply the two
 * independent update streams (activeplayer poll, playerlist poll) without either
 * one clobbering the other's most recent value.
 */
function mergeState(prev, patch) {
  return Object.assign({}, prev, patch);
}

/**
 * Convenience wrapper for the common "game just stopped" / "no reading yet" case.
 */
function emptyStateFor(inGame) {
  return Object.assign({}, EMPTY_STATE, { inGame });
}

module.exports = {
  EMPTY_STATE,
  toFiniteInt,
  parseLevelAndAbilities,
  extractLocalRiotId,
  resolveChampionName,
  extractLocalPosition,
  mergeState,
  emptyStateFor,
};
