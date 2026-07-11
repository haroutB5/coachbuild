// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/displayName.ts — cleans Leaguepedia's wiki-disambiguation
// suffixes off team/player strings for DISPLAY ONLY. Leaguepedia's Team and
// Link (player_link) Cargo fields carry a trailing parenthetical to
// disambiguate wiki pages — e.g. Team "LYON (2024 American Team)" (there have
// been multiple orgs named LYON) or Link "Zeka (Kim Geon-woo)" (a real-name
// suffix disambiguating this Zeka from any other wiki page called "Zeka").
// Neither belongs in front-end UI.
//
// The RAW string (with the parenthetical) MUST stay untouched everywhere it's
// used as a key: prostage_matches.team/player_link columns, the comps-grouping
// join key in app/api/pros/route.ts (buildProstageCompsMap groups by the RAW
// team string), and lib/prostage/ingest.ts's pro_id name-match lookups (which
// try both the raw and cleaned form — see that file). Only call this at the
// point a string is about to be emitted as `allyTeamName`/`enemyTeamName` or a
// `player`/`TeamCompPlayer.name` field on the API response.
// ─────────────────────────────────────────────────────────────────────────────

/** Strips ONE trailing "(...)" group (and any whitespace around it) off the
 *  end of a string — e.g. "LYON (2024 American Team)" -> "LYON",
 *  "Zeka (Kim Geon-woo)" -> "Zeka", "Zeus" -> "Zeus" (untouched, no trailing
 *  group). Deliberately conservative:
 *   - Only the LAST trailing group is removed — "Name (A) (B)" -> "Name (A)",
 *     never recurses to strip both.
 *   - A parenthetical that ISN'T trailing is left alone — "Mid (Top) Laner"
 *     has no match at the end, so it's returned verbatim.
 *   - If stripping would leave nothing (the whole string was "(...)"), the
 *     original (trimmed) string is returned instead — never emit "".
 *   - A name that legitimately ends in something like "Player (2)" is
 *     stripped too (accepted false positive — the wiki-disambiguation case
 *     this exists for dominates in practice, and a bare "(2)" survivor would
 *     look just as wrong in the UI). */
export function cleanLeaguepediaName(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.replace(/\s*\([^()]*\)\s*$/, "").trim();
  return stripped.length > 0 ? stripped : trimmed;
}
