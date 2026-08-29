"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ForThisGameCard.tsx — the Builds-page half of the `For this game` item-set
// block (0.120.0, user directive 2026-08-29).
//
// SAME DECISION, SAME REASONS, SAME ORDER as the shop block. Both surfaces call
// `resolveForThisGamePlan` + `applyForThisGameLine` on the same inputs, and the
// reason strings are built once inside `scenarioReason` rather than re-worded
// here. A page and a shop disagreeing about a block with the same name is the
// defect class this repo keeps paying for (see itemSetBody.ts's Hidden gem
// note), and it is worse here than usual because the two are read minutes
// apart: the page during champ select, the block mid-game.
//
// THE JUDGMENT LABEL IS THE POINT OF THE CARD. Every other build surface in
// this app is measured — WPA, pro share, one-trick share. This one is not: the
// scenario read is a curated kit classification and the item choice is an
// editorial table. FEATURES.md's honesty posture requires that to be stated on
// the surface rather than buried, so the label is rendered before the line, not
// after it, and `measured: false` picks are marked individually.
//
// RENDERS NOTHING outside champ select, and nothing when the comp is
// incomplete. There is no "waiting for the enemy team" state on purpose: an
// empty labelled card during every draft trains the reader to ignore the label.
// ─────────────────────────────────────────────────────────────────────────────

import type { BuildResponse, Pick as PickType } from "@/lib/types";
import type { LaneId } from "./heroContracts";
import { IconWithFallback } from "@/components/IconWithFallback";
import { useCompanion } from "@/components/live/CompanionProvider";
import { normalizeDraftEnemyIds } from "@/components/live/draftLiveSync";
import {
  resolveForThisGamePlan,
  applyForThisGameLine,
  FOR_THIS_GAME_BLOCK_TITLE,
  type ForThisGameSwap,
} from "@/lib/enemyComp/forThisGame";
import { isBootsItem } from "@/lib/bootsItems";

interface ForThisGameCardProps {
  championId: number;
  lane: LaneId;
  build: BuildResponse;
  onItemClick: (id: number) => void;
}

/** Every Pick the response mentions, so the card can render a name and an icon
 *  for a line that is just ids. A scenario item the champion's own data never
 *  offered has no Pick anywhere — that is exactly what `measured: false` means
 *  — so the card degrades to the id with no icon rather than inventing one. */
function pickIndex(build: BuildResponse): Map<number, PickType> {
  const items = build.items;
  const out = new Map<number, PickType>();
  const add = (p: PickType) => out.set(p.id, p);
  add(items.starter);
  add(items.boots);
  add(items.first);
  add(items.second);
  add(items.third);
  for (const p of items.fourthPlus) add(p);
  for (const p of items.optimizedPath ?? []) add(p);
  for (const slot of Object.values(items.alts ?? {})) for (const p of slot) add(p);
  return out;
}

export default function ForThisGameCard({
  championId,
  lane,
  build,
  onItemClick,
}: ForThisGameCardProps) {
  // Read from the live provider rather than from champSelectFollowState's
  // singleton, deliberately: this is a render, and a render has to re-run when
  // the comp changes, which a module singleton would not make it do. Both paths
  // derive from the same `theirTeam` on the same poll tick.
  const companion = useCompanion();
  const inChampSelect = companion.phase === "ChampSelect" && companion.statusFresh;
  const enemies = normalizeDraftEnemyIds(companion.champSelect?.theirTeam ?? []);

  const plan = inChampSelect
    ? resolveForThisGamePlan({ enemyChampionIds: enemies, championId, lane, items: build.items })
    : null;
  if (!plan) return null;

  // The SAME spine the exported block is built from: the champion's own WPA
  // order. itemSetBody assembles it through `buildLine` with padding pools this
  // page does not hold, so the two can differ on a champion with thin data —
  // the SWAPS are what both surfaces are really showing, and those are
  // identical because the plan is.
  const items = build.items;
  const spine = [
    items.first.id,
    items.boots.id,
    items.second.id,
    items.third.id,
    ...items.fourthPlus.map((p) => p.id),
  ].slice(0, 6);
  const bootsIds = new Set<number>([
    items.boots.id,
    ...(items.alts?.boots ?? []).map((p) => p.id),
    ...(plan.boots ? [plan.boots.itemId] : []),
  ]);
  for (const id of spine) if (isBootsItem(id, undefined, new Map())) bootsIds.add(id);

  const line = applyForThisGameLine(spine, plan, bootsIds);
  if (line.swaps.length === 0) return null;

  const byId = pickIndex(build);
  const swapById = new Map<number, ForThisGameSwap>(line.swaps.map((s) => [s.itemId, s]));

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 flex-wrap mb-1">
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">
          {FOR_THIS_GAME_BLOCK_TITLE}
        </p>
        <span
          className="text-[9px] tracking-[0.12em] uppercase font-bold text-accent border border-accent/40 rounded px-1 py-[1px]"
          title="An editorial call, not a measured stat"
        >
          Judgment
        </span>
      </div>
      <p className="text-[10px] text-mut leading-snug mb-3">
        Your build with{" "}
        <span className="text-txt">
          {line.swaps.length} swap{line.swaps.length === 1 ? "" : "s"}
        </span>{" "}
        for this enemy comp. Curated kit ratings and an editorial item table, not a measured stat.
      </p>
      <ol className="flex flex-wrap gap-2">
        {line.ids.map((id, i) => {
          const pick = byId.get(id);
          const swap = swapById.get(id);
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onItemClick(id)}
                aria-label={
                  swap
                    ? (pick?.name ?? "Item " + id) + ", swapped in: " + swap.reason
                    : "View details for " + (pick?.name ?? "item " + id)
                }
                className={
                  "flex items-center gap-2 bg-panel2/70 border rounded-lg px-2.5 py-2 min-w-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel active:scale-[0.98] " +
                  (swap ? "border-accent/50 ring-1 ring-accent/25" : "border-line hover:border-line-gold")
                }
              >
                <span className="text-[9px] tabular-nums text-mut/70 w-3 text-right flex-shrink-0">
                  {i + 1}
                </span>
                <span className="w-7 h-7 rounded-md bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                  {pick ? (
                    <IconWithFallback
                      src={pick.icon}
                      alt={pick.name}
                      fallbackGlyph={pick.name}
                      className="w-full h-full object-contain"
                      size={28}
                    />
                  ) : (
                    <span className="text-[9px] text-mut">?</span>
                  )}
                </span>
                <span className="leading-tight min-w-0 text-left">
                  <span className="block text-[11.5px] text-txt font-medium truncate">
                    {pick?.name ?? "Item " + id}
                  </span>
                  {swap && (
                    <span className="block text-[10px] text-accent truncate">{swap.reason}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <ul className="mt-3 space-y-1">
        {line.swaps.map((s) => (
          <li key={s.itemId} className="text-[10px] text-mut leading-snug">
            <span className="text-txt">{byId.get(s.itemId)?.name ?? "Item " + s.itemId}</span>
            {": " + s.reason}
            {s.replacedId !== null && (
              <> {"— in place of " + (byId.get(s.replacedId)?.name ?? "item " + s.replacedId)}</>
            )}
            {/* Stated per swap rather than once for the card: within one line
                one pick can come from the champion's own data and the other
                from the curated table, and collapsing them would overclaim the
                weaker one. */}
            {!s.measured && <> {"— not in this champion's own data"}</>}
          </li>
        ))}
      </ul>
    </div>
  );
}
