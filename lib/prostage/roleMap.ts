// ─────────────────────────────────────────────────────────────────────────────
// lib/prostage/roleMap.ts — Leaguepedia ScoreboardPlayers.Role -> ProRoleId.
// Separate from lib/pro/roleMap.ts (that file maps Riot/lolpros vocab; this
// one maps Leaguepedia's own convention, which is prose-cased "Top"/"Jungle"/
// "Mid"/"Bot"/"Support" per public Cargo docs, matched case-insensitively).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProRoleId } from "@/lib/pro/types";

// Keys are SPACE-STRIPPED (see roleFromCargoRole's normalization) so "AD
// Carry", "ad carry", and "adcarry" all resolve through the one "adcarry"
// entry — added after a >50%-null-role ingest warning surfaced "AD Carry" as
// a real Leaguepedia Role value on some tournaments/eras, distinct from the
// "ADC" abbreviation already covered.
const CARGO_ROLE_MAP: Record<string, ProRoleId> = {
  top: 0,
  jungle: 1,
  jgl: 1,
  mid: 2,
  middle: 2,
  bot: 3,
  bottom: 3,
  adc: 3,
  adcarry: 3,
  support: 4,
  sup: 4,
  supp: 4,
  utility: 4,
};

/** Returns null (caller must leave role nullable) for empty/unrecognized
 *  values — pro-stage rows without a resolvable role still get stored,
 *  unlike soloQ ingest which skips them (identity here doesn't hinge on role).
 *  Normalizes by stripping ALL whitespace (not just trim), not just
 *  lowercasing — covers "AD Carry" / "ad carry" / "adcarry" with one map key
 *  instead of enumerating every spacing variant. */
export function roleFromCargoRole(role: string | undefined | null): ProRoleId | null {
  if (!role) return null;
  const key = role.trim().toLowerCase().replace(/\s+/g, "");
  const id = CARGO_ROLE_MAP[key];
  return id === undefined ? null : id;
}
