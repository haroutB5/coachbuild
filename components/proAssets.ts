import type { DifficultyBand } from "@/lib/draft/difficulty";

export interface ChampionIconEntry {
  name: string;
  icon: string;
  /** Draft redesign plan §2.1 (additive, v0.42.0) — mirrors ChampionRef's own
   *  `difficulty`/`tags` fields (lib/types.ts) as served by /api/champions.
   *  null/undefined when the source entry never carried it (older cached
   *  response, or a ddragon gap-fill entry with no info block) — never a
   *  fabricated value. */
  difficulty?: number | null;
  /** Pre-banded via lib/draft/difficulty.ts's difficultyBand() at map-build
   *  time so every consumer (DraftPicksTable, DraftBansTable, …) reads the
   *  same band without re-deriving it per row. */
  difficultyBand?: DifficultyBand | null;
  tags?: string[];
}

