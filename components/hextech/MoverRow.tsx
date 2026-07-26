"use client";

// ─────────────────────────────────────────────────────────────────────────────
// MoverRow — /movers' single-table row (mockup 7.png, v0.51 wave B). Rewired
// to the REWRITTEN /api/patch-movers contract (engo, concurrent) — one row
// per CHAMPION overall win-rate swing (deltaPp/wrNow/wrPrev/games/note), not
// the pre-wave per-keystone/per-item mover shape (kind/name/iconHint/delta/
// prevWpa/currWpa) the old lib/patchMovers.ts PatchMover type used.
//
// The `Mover` type below is declared LOCALLY (not imported from
// lib/patchMovers.ts) — that file is engo's concurrent rewrite target this
// wave; a local structural type means this component compiles independent of
// exactly when that rewrite lands, and only needs the WIRE JSON to match at
// runtime, not a shared TS type identity.
//
// CORRECTED (cross-checked against lib/patchMovers.ts's own header comment,
// added concurrently by engo to components/hextech/patchMoversFormat.ts):
// wrNow/wrPrev are ALREADY 0-100 percentages (e.g. 52.4, not 0.524) — NOT 0-1
// fractions like this codebase's other winrate fields (myStats.ts/proGames).
// deltaPp is already percentage points on both sides, matching the mockup's
// 2-decimal "+1.80pp". wrText below does NOT multiply by 100.
// ─────────────────────────────────────────────────────────────────────────────

import Link from "next/link";
import { IconWithFallback } from "@/components/IconWithFallback";

export interface Mover {
  championId: number;
  championName: string;
  role: number;
  wrNow: number; // 0-100 percentage, e.g. 52.4
  wrPrev: number; // 0-100 percentage
  deltaPp: number; // already percentage points, e.g. 1.80 or -1.20
  games: number;
  note: string | null;
}

function formatGamesK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function deltaText(deltaPp: number): string {
  return `${deltaPp >= 0 ? "+" : ""}${deltaPp.toFixed(2)}pp`;
}

function wrText(pct: number): string {
  return `${pct.toFixed(1)}%`;
}

interface MoverRowProps {
  mover: Mover;
  championIcon: string;
}

export default function MoverRow({ mover, championIcon }: MoverRowProps) {
  const positive = mover.deltaPp >= 0;
  const deltaClass = positive ? "text-good" : "text-bad";

  // Every row is a route into the thing this app is FOR. Twenty-odd champions
  // with a win-rate swing and no way to reach their build was a dead end on the
  // app's own primary surface. `role` only rides along when it is a real lane
  // (0-4) — parseLiveDeepLink rejects the entire link on a malformed role, so a
  // bad value would break the navigation rather than degrade it.
  const href =
    mover.role >= 0 && mover.role <= 4
      ? `/?championId=${mover.championId}&role=${mover.role}`
      : `/?championId=${mover.championId}`;

  return (
    <Link
      href={href}
      aria-label={`See the build for ${mover.championName}`}
      className="block rounded-md transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
    >
      {/* Desktop / tablet — single-line table row, columns match the header
          row rendered by app/movers/page.tsx. */}
      <div className="hidden sm:grid grid-cols-[1.7fr_110px_90px_80px_1.4fr] items-center gap-3 py-3 border-b border-line last:border-b-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
            <IconWithFallback
              src={championIcon}
              alt={mover.championName}
              fallbackGlyph={mover.championName}
              className="w-full h-full object-cover"
              size={32}
            />
          </span>
          <span className="text-[13px] text-txt font-semibold truncate">{mover.championName}</span>
        </div>

        <span className={`text-[13px] font-bold tabular-nums text-right ${deltaClass}`}>{deltaText(mover.deltaPp)}</span>
        <span className="text-[13px] text-txt font-bold tabular-nums text-right">{wrText(mover.wrNow)}</span>
        <span className="text-[11px] text-mut tabular-nums text-right">{formatGamesK(mover.games)}</span>
        <span className="text-[11.5px] text-mut truncate">{mover.note ?? "—"}</span>
      </div>

      {/* Mobile — stacked card: champion + delta prominent, WR/games and the
          patch note demoted below (brief's explicit mobile spec). */}
      <div className="sm:hidden py-3 border-b border-line last:border-b-0">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="w-8 h-8 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
              <IconWithFallback
                src={championIcon}
                alt={mover.championName}
                fallbackGlyph={mover.championName}
                className="w-full h-full object-cover"
                size={32}
              />
            </span>
            <span className="text-[13.5px] text-txt font-semibold truncate">{mover.championName}</span>
          </div>
          <span className={`text-[14px] font-bold tabular-nums flex-shrink-0 ${deltaClass}`}>{deltaText(mover.deltaPp)}</span>
        </div>
        <div className="flex items-center gap-2 mt-1.5 pl-[42px] text-[11px] text-mut tabular-nums">
          <span className="text-txt font-semibold">{wrText(mover.wrNow)}</span>
          <span aria-hidden="true">&middot;</span>
          <span>{formatGamesK(mover.games)} games</span>
        </div>
        {mover.note && <p className="mt-1 pl-[42px] text-[11px] text-mut truncate">{mover.note}</p>}
      </div>
    </Link>
  );
}
