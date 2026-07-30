"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MostPlayedStrip — the row of overlapping circular champion portraits that
// sits on the "Accounts" heading's baseline in the reference, labelled
// "Most Played Champions:".
//
// Purely decorative-adjacent but NOT invented: every portrait is a champion the
// account has actually played this split, ordered by games summed across roles
// (buildMostPlayedStrip). The count is in each portrait's tooltip and in the
// strip's sr-only sentence, so the visual shorthand always has the real numbers
// behind it.
//
// The overlap is negative margin, not absolute positioning, so the strip's
// width is a real box the flex parent can measure — at 390px it wraps under the
// heading rather than pushing the page into horizontal scroll.
// ─────────────────────────────────────────────────────────────────────────────

import { IconWithFallback } from "@/components/IconWithFallback";
import type { MostPlayedChampion } from "./profileModel";

export interface MostPlayedStripProps {
  champions: MostPlayedChampion[];
  /** Label text; the reference reads "Most Played Champions:". */
  label?: string;
}

export default function MostPlayedStrip({ champions, label = "Most played champions:" }: MostPlayedStripProps) {
  if (champions.length === 0) return null;

  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="text-[10px] tracking-[0.09em] uppercase text-mut font-semibold whitespace-nowrap">
        {label}
      </span>
      {/* `dir=rtl` + row-reverse is the trick that makes the FIRST (most played)
          portrait stack on TOP without a z-index ladder — the leftmost element
          is painted last. */}
      <ul className="flex flex-row-reverse items-center pl-1.5" aria-hidden="true">
        {[...champions].reverse().map((c) => (
          <li
            key={c.championId}
            title={`${c.name} — ${c.games} game${c.games === 1 ? "" : "s"}`}
            className="-ml-1.5 w-7 h-7 sm:w-8 sm:h-8 rounded-full overflow-hidden bg-black/40 ring-1 ring-bg flex items-center justify-center flex-shrink-0"
          >
            <IconWithFallback
              src={c.icon}
              alt=""
              fallbackGlyph={c.name}
              className="w-full h-full object-cover"
              size={32}
            />
          </li>
        ))}
      </ul>
      <span className="sr-only">
        Most played champions this split:{" "}
        {champions.map((c) => `${c.name}, ${c.games} game${c.games === 1 ? "" : "s"}`).join("; ")}.
      </span>
    </div>
  );
}
