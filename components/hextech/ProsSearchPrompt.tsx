"use client";

import FavoritePlayerChips from "@/components/FavoritePlayerChips";
import type { PlayerRef } from "@/components/proHistory.types";

interface ProsSearchPromptProps {
  onSelectPlayer: (player: PlayerRef) => void;
}

/** v0.44.3: the main-content render for PROS mode before a player has been
 *  picked (gated by homeSearch.ts's `isProsSearchEmpty`) — a quiet prompt
 *  instead of the champion page (hero/tabs/rank bracket/runes/cards)
 *  bleeding through underneath an empty pro-player search. Same empty-state
 *  card shape `PlayerGamesSection.tsx` already uses for its own error/empty
 *  rows (`bg-panel border border-line rounded-xl p-10 text-center`) so this
 *  reads as one family with the rest of the player view rather than a
 *  one-off.
 *
 *  Reuses FavoritePlayerChips as-is (the v0.10.0 one-tap row, already
 *  entity-generalized) — renders nothing when there are no favorited
 *  players. `onSelectPlayer` is app/page.tsx's own `handlePlayerSelect`,
 *  the SAME handler the sidebar's PROS search dropdown calls, so tapping a
 *  favorite here is byte-identical to picking them from the dropdown (same
 *  PROS-mode landing, same history push via wireViewForPlayer). */
export default function ProsSearchPrompt({ onSelectPlayer }: ProsSearchPromptProps) {
  return (
    <div className="bg-panel border border-line rounded-xl p-10 text-center">
      <div className="text-txt font-semibold mb-1">Search for a pro player</div>
      <div className="text-mut text-sm">Use the search box to find a tracked pro and see their recent games.</div>
      <FavoritePlayerChips onSelect={onSelectPlayer} />
    </div>
  );
}
