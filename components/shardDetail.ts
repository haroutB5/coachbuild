// ─────────────────────────────────────────────────────────────────────────────
// shardDetail.ts — stat shard DATA (name + one-line stat text) for the
// tap-to-detail popover in GameDetailSheet.
//
// Stat shards are NOT in runesReforged.json (they're a client-side rune-page
// concept, not a real "rune" in ddragon's data) — proAssets.ts already keys
// icon/name off a small hardcoded id map (SHARD_ICON / SHARD_NAME) for the
// same reason. This mirrors that map 1:1 (same 9 ids) and adds the stat text
// ddragon has no source for at all.
//
// Values are the long-stable baseline tuning for these shards (unchanged
// across many patches) — treat as "close enough for a tap-to-glance card,"
// not a per-patch-verified balance reference.
// ─────────────────────────────────────────────────────────────────────────────

export interface ShardDetail {
  name: string;
  statText: string;
}

export const SHARD_DETAIL: Record<number, ShardDetail> = {
  5008: { name: "Adaptive Force", statText: "+9 Adaptive Force (5.4 AD or 9 AP)" },
  5005: { name: "Attack Speed", statText: "+10% Attack Speed" },
  5007: { name: "Ability Haste", statText: "+8 Ability Haste" },
  5010: { name: "Move Speed", statText: "+2% Move Speed" },
  5002: { name: "Armor", statText: "+6 Armor" },
  5003: { name: "Magic Resist", statText: "+8 Magic Resist" },
  5001: { name: "Health Scaling", statText: "+10–180 Health (scales with level)" },
  5011: { name: "Health", statText: "+65 Health" },
  5013: { name: "Tenacity", statText: "+10% Tenacity and Slow Resist" },
};
