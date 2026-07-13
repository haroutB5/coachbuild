"use client";

import { useEffect, useState } from "react";
import type { PlayersApiResponse } from "@/components/proHistory.types";
import type { PlayerSubject } from "./homeSearch";

interface PlayerHeroProps {
  subject: PlayerSubject;
}

interface ResolvedMeta {
  team: string | null;
  gameCount: number | null;
}

function metaFromSubject(subject: PlayerSubject): ResolvedMeta {
  return subject.kind === "tracked" ? { team: subject.team, gameCount: subject.gameCount } : { team: null, gameCount: null };
}

/** Player-mode counterpart to ChampionHero (v0.22.0) — same shape, spacing,
 *  and gold-serif-display-name typography so the two hero states read as one
 *  family, but there's no equivalent to champion splash art for a person: no
 *  headshot data exists anywhere in this app's pipeline (ProGame carries
 *  stats, not portraits). Rather than inventing/stock-photo-ing an image,
 *  this renders a subtle dark gradient (derived from the same panel palette
 *  every other Hextech surface uses) and a lettered avatar tile — the same
 *  fallback-glyph treatment IconWithFallback already uses app-wide for a
 *  failed icon, just applied intentionally here instead of as a failure
 *  state.
 *
 *  v0.26.0: `subject` (not a plain PlayerRef) covers a Teams-box sheet-tap
 *  now too, not just a sidebar PROS search pick — the two arrive with very
 *  different amounts of known data:
 *   - Search pick (tracked, gameCount already non-null): every field is
 *     real, no extra fetch needed — the common case stays exactly as fast as
 *     before.
 *   - Sheet-tap on a TRACKED player (only id/name/team known synchronously,
 *     gameCount null): resolves team+gameCount in the background via
 *     /api/players?q=<name>, matched by id — the SAME real data a search
 *     pick would have had, just arriving a beat later. Never fabricated as
 *     0/"Free agent" in the meantime — the games-count line shows the same
 *     "—" placeholder ChampionHero already uses while loading (CLS-safe,
 *     resolves in place).
 *   - Sheet-tap on a LINK-ONLY (untracked) player: no cheap endpoint gives a
 *     team or a total game count for a player identified only by a raw
 *     Leaguepedia player_link (the games list itself is the only source, and
 *     it's capped/filtered — see PlayerGamesSection) — so this never
 *     attempts a lookup and never shows a games-count line at all (a
 *     permanent, deterministic omission, not a transient loading state). */
export default function PlayerHero({ subject }: PlayerHeroProps) {
  const [meta, setMeta] = useState<ResolvedMeta>(() => metaFromSubject(subject));

  useEffect(() => {
    setMeta(metaFromSubject(subject));
    if (subject.kind !== "tracked" || subject.gameCount !== null) return; // already known, or link (no lookup — see doc comment)
    let cancelled = false;
    const { id, name } = subject;
    fetch(`/api/players?q=${encodeURIComponent(name)}`)
      .then((res) => (res.ok ? (res.json() as Promise<PlayersApiResponse>) : null))
      .then((data) => {
        if (cancelled || !data) return;
        const match = data.players?.find((p) => p.id === id);
        if (match) setMeta({ team: match.team, gameCount: match.gameCount });
      })
      .catch(() => {
        // Upstream failure — stays on the placeholder state, never invents a
        // number (same posture as ChampionHero's own getHeroStats catch).
      });
    return () => {
      cancelled = true;
    };
  }, [subject]);

  const initial = subject.name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative rounded-xl overflow-hidden border border-line">
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            "radial-gradient(120% 140% at 12% 15%, rgba(200,170,110,0.12) 0%, rgba(200,170,110,0) 55%), linear-gradient(180deg, #12160f 0%, #0a0d0b 100%)",
        }}
      />

      <div className="relative flex items-center gap-4 px-5 py-6 min-h-[128px]">
        <div className="flex-shrink-0 w-[76px] h-[76px] rounded-lg overflow-hidden border-2 border-teal shadow-[0_0_22px_rgba(200,170,110,0.3)] bg-panel2 flex items-center justify-center">
          <span className="font-display text-teal text-[30px] font-semibold select-none" aria-hidden="true">
            {initial}
          </span>
        </div>

        <div className="min-w-0">
          <h2 className="font-display text-teal text-[30px] sm:text-[36px] font-semibold uppercase tracking-[0.02em] leading-none truncate">
            {subject.name}
          </h2>
          <div className="mt-2 flex items-center gap-2 text-[12.5px] tabular-nums">
            <span className="text-mut font-semibold uppercase tracking-[0.05em] truncate">
              {meta.team ?? (subject.kind === "link" ? "Untracked pro" : "Free agent")}
            </span>
            {/* Games count only for tracked subjects — a link-only player has
                no cheap total-count source at all (see this component's
                header doc comment), so this is a permanent omission, not a
                loading state; never renders an invented/placeholder number
                for it. Tracked subjects always render the segment, showing
                "— GAMES" (matching ChampionHero's own placeholder
                convention) until the background lookup resolves — CLS-safe,
                fills in place. */}
            {subject.kind === "tracked" && (
              <>
                <span className="text-mut/50" aria-hidden="true">
                  &middot;
                </span>
                <span className="text-mut">
                  {meta.gameCount !== null ? `${meta.gameCount.toLocaleString()} GAMES` : "— GAMES"}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
