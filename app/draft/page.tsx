"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /draft — "Draft" recommender (plan §6a/§6c). Standalone shell page, same
// convention as /movers and /live-setup (not the two-Sidebar main layout —
// this is an auxiliary surface, reachable from Sidebar's "Draft" link).
//
// Compliance (plan §7 — enforced structurally, not just by copy choice):
// this file never calls applyRunes/applyItemSets or any companion POST; the
// shared ApplyRunesButton is rendered as a separate, user-triggered control.
// It only reads championId/name/icon — never a summoner/riotId field.
// Copy is framed as suggestions ("statistically favored"), never "pick this."
//
// Live mode: consumes CompanionProvider READ-ONLY via useCompanion() (plan
// §6c) — auto-fills lane/enemies/hover from champ select through
// draftLiveSync.ts's pure resolveDraftLiveTarget, but a manual edit always
// wins until "Reset to live" (the dirty latch — see the live-sync effect
// below). No companion at all is simply the quiet default; nothing here
// nags the user to connect one (manual-first UX, plan §6a).
//
// GOLD RESKIN (v0.51.0, CoachBuild redesign wave — mockup 3): the preserved
// live-sync effect, entryStateRef, dirty latch, and debounced/race-guarded
// fetch remain unchanged. Presentation-only state and handlers below support
// the Draft Assistant controls. The retired cyan
// `.draft-tactical`/`.dt-*` HUD theme (app/globals.css) is gone — this page
// now uses the app-wide navy/gold tokens, same as Builds — and DraftCompRadar
// is replaced by DraftCompBars (6 horizontal bars, mockup 3's "ENEMY COMP
// PROFILE" card) and DraftBansTable's row rendering is absorbed into
// MyChampionPanel (mockup 3 shows ban suggestions inline in that card, not a
// separate page section). No pushState/history integration exists on this
// page (see gotchas (n)/(p)) and none was added — MatchupAnalysisPopover is
// rendered inline by EnemyTeamPanel, never a routed/portalled surface.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { LANE_ORDER, LANE_TO_ROLE_ID, LANE_LABEL, type LaneId } from "@/components/hextech/heroContracts";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { getSplashUrl } from "@/lib/splash";
import { POOL_MIN_PICKRATE } from "@/lib/draft/score";
import { useCompanion } from "@/components/live/CompanionProvider";
import {
  resolveDraftLiveTarget,
  shouldShowResetToLive,
  resolveChampSelectEntry,
  INITIAL_CHAMP_SELECT_ENTRY_STATE,
  MAX_DRAFT_ENEMIES,
  type ChampSelectEntryState,
} from "@/components/live/draftLiveSync";
import {
  fetchDraftRecommend,
  type DraftRecommendResponse,
  type DraftRecommendMeta,
  type DraftPlayResult,
} from "@/components/live/draftRecommend";
import ChampionPicker from "@/components/ChampionPicker";
import { IconWithFallback } from "@/components/IconWithFallback";
import ApplyRunesButton from "@/components/hextech/GlobalNav/ApplyRunesButton";
import {
  DEFAULT_DRAFT_ASSISTANT_FILTERS,
  filterComfortCandidates,
  filterCounterCandidates,
  filterDraftAssistantCandidates,
  isOffMetaLaneShare,
  resolveVisibleDraftAssistantRanking,
  resolveTopRecommendationCards,
  resolveRecommendedDetailCandidates,
  type DraftAssistantCandidate,
  type DraftAssistantCard,
  type DraftAssistantDetailSort,
  type DraftLaneStat,
  type DraftMatchupPreview,
} from "@/components/hextech/draftAssistantModel";
import type { BlindPickResult } from "@/lib/draft/blindPick";

const RECOMMEND_DEBOUNCE_MS = 300;

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: DraftRecommendResponse }
  | { status: "pending"; meta?: DraftRecommendMeta }
  | { status: "empty"; meta: DraftRecommendMeta }
  | { status: "error" };

interface BlindPickResponse {
  picks: BlindPickResult[];
  meta: {
    patch: string | null;
    tier: number;
    lane: number;
    fetchedAt: string | null;
    poolCandidates: number;
    qualifiedCandidates: number;
    excludedByLaneShare: number;
    excludedByMassGate: number;
    excludedUncomputable: number;
    returnedCandidates: number;
    topN: number;
  };
  pending?: boolean;
}

type BlindPickFetchState =
  | { status: "loading" }
  | { status: "ok"; data: BlindPickResponse }
  | { status: "pending"; data: BlindPickResponse }
  | { status: "empty"; data: BlindPickResponse }
  | { status: "error" };

function normalizeBlindPickResponse(raw: unknown): BlindPickResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Partial<BlindPickResponse> & { meta?: Partial<BlindPickResponse["meta"]> };
  const meta = body.meta;
  if (
    !meta ||
    (typeof meta.patch !== "string" && meta.patch !== null) ||
    typeof meta.tier !== "number" ||
    typeof meta.lane !== "number" ||
    (typeof meta.fetchedAt !== "string" && meta.fetchedAt !== null) ||
    ![
      meta.poolCandidates,
      meta.qualifiedCandidates,
      meta.excludedByLaneShare,
      meta.excludedByMassGate,
      meta.excludedUncomputable,
      meta.returnedCandidates,
      meta.topN,
    ].every(
      (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
    )
  ) {
    return null;
  }

  const picks: BlindPickResult[] = [];
  if (Array.isArray(body.picks)) {
    for (const rawPick of body.picks) {
      if (!rawPick || typeof rawPick !== "object") continue;
      const pick = rawPick as Partial<BlindPickResult>;
      if (
        typeof pick.rank !== "number" ||
        typeof pick.champId !== "number" ||
        typeof pick.blindScore !== "number" ||
        typeof pick.fieldWr !== "number" ||
        typeof pick.es10 !== "number" ||
        typeof pick.badMass !== "number" ||
        typeof pick.totalGames !== "number" ||
        typeof pick.coverageMass !== "number" ||
        ![pick.rank, pick.champId, pick.blindScore, pick.fieldWr, pick.es10, pick.badMass, pick.totalGames, pick.coverageMass].every(
          (value) => Number.isFinite(value)
        )
      ) {
        continue;
      }
      const worst = pick.worstMatchup;
      const worstMatchup =
        worst &&
        typeof worst === "object" &&
        typeof worst.oppId === "number" &&
        typeof worst.wr === "number" &&
        typeof worst.games === "number" &&
        Number.isFinite(worst.oppId) &&
        Number.isFinite(worst.wr) &&
        Number.isFinite(worst.games)
          ? { oppId: worst.oppId, wr: worst.wr, games: worst.games }
          : null;
      picks.push({
        rank: pick.rank,
        champId: pick.champId,
        blindScore: pick.blindScore,
        fieldWr: pick.fieldWr,
        es10: pick.es10,
        badMass: pick.badMass,
        worstMatchup,
        totalGames: pick.totalGames,
        coverageMass: pick.coverageMass,
      });
    }
  }

  return {
    picks,
    meta: {
      patch: meta.patch,
      tier: meta.tier,
      lane: meta.lane,
      fetchedAt: meta.fetchedAt,
      poolCandidates: meta.poolCandidates,
      qualifiedCandidates: meta.qualifiedCandidates,
      excludedByLaneShare: meta.excludedByLaneShare,
      excludedByMassGate: meta.excludedByMassGate,
      excludedUncomputable: meta.excludedUncomputable,
      returnedCandidates: meta.returnedCandidates,
      topN: meta.topN,
    },
    pending: body.pending === true,
  };
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-8 text-center">
      <div className="text-txt font-semibold mb-1 text-[13.5px]">{title}</div>
      <div className="text-mut text-[12px]">{body}</div>
    </div>
  );
}

function BlindPickSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 motion-reduce:animate-none animate-pulse space-y-3" aria-label="Loading blind picks">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-panel2 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-24 bg-panel2 rounded" />
            <div className="h-2 w-14 bg-panel2 rounded" />
          </div>
          <div className="h-3 w-10 bg-panel2 rounded flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

const MAX_ALLIED_ADDITIONAL = 4;
type AssistantView = "recommended" | "blind" | "counters" | "comfort";
type DetailSort = DraftAssistantDetailSort;

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function formatGames(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString() : "—";
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function championEntry(champIcons: Map<number, ChampionIconEntry>, id: number) {
  const entry = champIcons.get(id);
  return {
    name: entry?.name ?? `Champion #${id}`,
    icon: entry?.icon ?? "",
    difficultyBand: entry?.difficultyBand ?? null,
  };
}

function championSplashUrl(entry: ChampionIconEntry | ReturnType<typeof championEntry>): string {
  const keyFromIcon = entry.icon.match(/\/([^/]+)\.(?:webp|png|jpg)(?:\?.*)?$/i)?.[1];
  return getSplashUrl(keyFromIcon ?? entry.name.replace(/\s+/g, "")) ?? entry.icon;
}

interface TeamSlotsProps {
  label: "ALLIED TEAM" | "ENEMY TEAM";
  primaryId: number | null;
  additionalIds: number[];
  champIcons: Map<number, ChampionIconEntry>;
  placeholder: string;
  onAdd: (champ: ChampionRef) => void;
  onRemove?: (id: number) => void;
  onToggleLaneOpponent?: (id: number) => void;
  effectiveLaneOpponentId?: number | null;
  laneOpponentId?: number | null;
}

function TeamSlots({
  label,
  primaryId,
  additionalIds,
  champIcons,
  placeholder,
  onAdd,
  onRemove,
  onToggleLaneOpponent,
  effectiveLaneOpponentId = null,
  laneOpponentId = null,
}: TeamSlotsProps) {
  const slotIds = label === "ENEMY TEAM" ? additionalIds : [primaryId, ...additionalIds];
  const slots = Array.from({ length: 5 }, (_, index) => slotIds[index] ?? null);
  const selectedIds = new Set(slotIds.filter((id): id is number => id !== null));
  // Which empty slot (if any) currently has the picker open. A native <select>
  // used to live invisibly over each "+" — it worked, but Windows draws its
  // dropdown in OS chrome: a white panel with a blue highlight, unstyleable by
  // CSS, in the middle of a dark page (2026-08-01, user-reported). Replaced with
  // the app's own ChampionPicker, which already portals a themed listbox with
  // filtering and keyboard nav.
  const [addingSlot, setAddingSlot] = useState<number | null>(null);
  return (
    <div className="min-w-0">
      <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2">{label}</p>
      <div className="grid grid-cols-5 gap-1.5">
        {slots.map((id, index) => {
          const entry = id !== null ? championEntry(champIcons, id) : null;
          const isYourPick = label === "ALLIED TEAM" && index === 0;
          const isLaneOpponent = id !== null && effectiveLaneOpponentId === id;
          const isServerInferredOnly = isLaneOpponent && laneOpponentId === null;
          return (
            <div
              key={`${label}-${index}-${id ?? "empty"}`}
              className={`group relative flex aspect-square min-w-0 items-center justify-center rounded-lg border bg-panel2/60 ${
                isLaneOpponent ? "border-teal" : id !== null ? "border-line" : "border-dashed border-line"
              }`}
            >
              {id !== null ? (
                <>
                  <IconWithFallback
                    src={entry?.icon ?? ""}
                    alt={entry?.name ?? `Champion #${id}`}
                    fallbackGlyph={entry?.name}
                    className="w-full h-full object-cover rounded-lg"
                    size={52}
                  />
                  {!isYourPick && onRemove && (
                    <button
                      type="button"
                      onClick={() => onRemove(id)}
                      aria-label={`Remove ${entry?.name ?? "champion"} from ${label.toLowerCase()}`}
                      className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-panel text-[10px] leading-none text-mut hover:text-bad"
                    >
                      ×
                    </button>
                  )}
                  {onToggleLaneOpponent && (
                    <button
                      type="button"
                      onClick={() => onToggleLaneOpponent(id)}
                      aria-pressed={isLaneOpponent}
                      aria-label={isLaneOpponent ? `${entry?.name ?? "Champion"} is the lane opponent` : `Mark ${entry?.name ?? "Champion"} as lane opponent`}
                      title={isServerInferredOnly ? "Auto-detected lane opponent" : "Toggle lane opponent"}
                      className={`absolute bottom-0.5 left-1/2 -translate-x-1/2 rounded px-1 text-[7px] font-bold uppercase tracking-[0.03em] ${
                        isLaneOpponent ? "bg-teal text-bg" : "bg-bg/80 text-mut opacity-0 group-hover:opacity-100"
                      }`}
                    >
                      {isLaneOpponent ? "lane" : "+lane"}
                    </button>
                  )}
                </>
              ) : isYourPick ? (
                <span className="text-xl font-light text-mut/70" aria-hidden="true">+</span>
              ) : (
                <button
                  type="button"
                  aria-label={`Add a champion to ${label.toLowerCase()} slot ${index + 1}`}
                  aria-expanded={addingSlot === index}
                  onClick={() => setAddingSlot(addingSlot === index ? null : index)}
                  className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <span className="text-xl font-light text-mut/70" aria-hidden="true">+</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Rendered UNDER the row rather than inside the 40px slot: the picker is
          a search input plus a listbox, and neither fits a square tile. Closing
          on select keeps the interaction as short as the old native one. */}
      {addingSlot !== null && (
        <div className="mt-2">
          <ChampionPicker
            value={null}
            placeholder={placeholder}
            autoFocus
            onChange={(champ) => {
              onAdd(champ);
              setAddingSlot(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function RecommendationCard({
  card,
  rank,
  champIcons,
  preview,
  onViewDetails,
}: {
  card: DraftAssistantCard;
  rank: number;
  champIcons: Map<number, ChampionIconEntry>;
  preview: DraftMatchupPreview | undefined;
  onViewDetails: (id: number) => void;
}) {
  const candidate = card.candidate;
  const status = card.slot === "best" ? "BEST OVERALL" : card.slot === "blind" ? "SAFEST BLIND" : "RELIABLE PICK";
  const entry = candidate ? championEntry(champIcons, candidate.champId) : null;
  const offMeta = candidate ? isOffMetaLaneShare(candidate.laneShare) : false;
  const worst = preview?.worst[0];
  const worstName = worst ? championEntry(champIcons, worst.oppId).name : null;
  const support = candidate
    ? [
        candidate.floor !== null ? `Floor ${formatPercent(candidate.floor)}` : null,
        candidate.totalGames !== null ? `${formatGames(candidate.totalGames)} games` : null,
        worst && worstName ? `Worst popular matchup: ${worstName} ${formatPercent(worst.winRate)}` : null,
      ].filter((part): part is string => part !== null)
    : [];

  return (
    <article className="relative flex min-w-0 flex-col rounded-xl border border-line bg-panel p-3 shadow-[0_8px_24px_rgba(0,0,0,0.16)]">
      <span className={`absolute left-3 top-3 flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-bold ${rank === 1 ? "bg-teal text-bg" : "bg-panel2 text-mut border border-line"}`}>
        {rank}
      </span>
      {candidate && entry ? (
        <>
          <div className="flex justify-center pt-1.5">
            <span className="h-14 w-full max-w-[230px] overflow-hidden rounded-lg border border-line-gold bg-black/30">
              <IconWithFallback src={championSplashUrl(entry)} alt={`${entry.name} splash art`} fallbackGlyph={entry.name} className="h-full w-full object-cover object-[center_20%]" size={230} />
            </span>
          </div>
          <div className="mt-2 text-center">
            <h3 className="truncate text-[16px] font-bold text-txt">{entry.name}</h3>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-1">
              <span className="inline-flex rounded-full border border-line-gold bg-teal/10 px-2 py-0.5 text-[9px] font-bold tracking-[0.1em] text-teal">{status}</span>
              {offMeta && <span className="inline-flex rounded-full border border-line-gold px-2 py-1 text-[9px] font-semibold tracking-[0.08em] text-mut">OFF-META</span>}
              {candidate.isPotential && <span className="inline-flex rounded-full border border-line-gold px-2 py-1 text-[9px] font-semibold tracking-[0.08em] text-mut">LOW SAMPLE</span>}
            </div>
          </div>
          <div className="mt-2 text-center">
            <div className="flex items-baseline justify-center gap-1.5">
              <p className="tabular-nums text-[24px] font-extrabold leading-none text-txt">{formatPercent(candidate.winRate)}</p>
              <p className="text-[11px] text-mut">Win Rate</p>
            </div>
            <p className="mt-1 text-[11px] tabular-nums text-mut">{formatGames(candidate.totalGames)} games</p>
          </div>
          <div className="mt-2 min-h-[34px] text-center">
            <p className="text-[12px] font-semibold text-txt">{candidate.floor !== null ? `Floor ${formatPercent(candidate.floor)}` : `${formatPercent(candidate.winRate)} estimated in this draft`}</p>
            <p className="mt-1 text-[10.5px] leading-4 text-mut">{support.length > 0 ? support.join(" · ") : "No supporting matchup figures available."}</p>
          </div>
        </>
      ) : (
        <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-dashed border-line text-2xl text-mut/60">—</span>
          <p className="mt-3 text-[13px] font-semibold text-txt">No honest pick yet</p>
          <p className="mt-1 max-w-[190px] text-[10.5px] leading-4 text-mut">This slot needs a distinct champion with the required evidence.</p>
        </div>
      )}
      <button
        type="button"
        disabled={!candidate}
        onClick={() => candidate && onViewDetails(candidate.champId)}
        aria-label={candidate ? `View details for ${entry?.name ?? "champion"}` : "View details unavailable"}
        className="mt-2.5 w-full rounded-lg border border-line py-2 text-[11px] font-bold text-txt transition-colors hover:border-line-gold hover:text-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:text-mut/50"
      >
        View details →
      </button>
    </article>
  );
}

function MatchupGroup({
  label,
  rows,
  champIcons,
}: {
  label: "Worst" | "Best";
  rows: DraftMatchupPreview["worst"];
  champIcons: Map<number, ChampionIconEntry>;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.14em] text-mut">{label}</p>
      <div className="grid grid-cols-3 gap-2">
        {rows.length > 0 ? (
          rows.map((row) => {
            const entry = championEntry(champIcons, row.oppId);
            return (
              <div key={`${label}-${row.oppId}`} className="min-w-0 text-center">
                <span className="mx-auto block h-7 w-7 overflow-hidden rounded-full bg-black/30">
                  <IconWithFallback src={entry.icon} alt={entry.name} fallbackGlyph={entry.name} className="h-full w-full object-cover" size={32} />
                </span>
                {/* truncate, NOT break-words. Three names share a card here, so
                    each gets ~48px; `break-words` split them mid-word into
                    "Lissan dra", "LeBla nc" and "Kassa dlin" — the last reads as
                    a misspelling of a champion, which is worse than a clipped
                    name. One line with an ellipsis and the full name on hover. */}
                <span className="mt-1 block truncate text-[10px] leading-3 text-txt" title={entry.name}>
                  {entry.name}
                </span>
                <span className={`mt-0.5 block text-[10px] font-semibold tabular-nums ${row.winRate < 0.5 ? "text-bad" : "text-good"}`}>
                  {formatPercent(row.winRate)}
                </span>
              </div>
            );
          })
        ) : (
          <p className="text-[10.5px] text-mut">No popular matchup rows.</p>
        )}
      </div>
    </div>
  );
}

function MatchupPreviewBlock({
  candidate,
  preview,
  champIcons,
}: {
  candidate: DraftAssistantCandidate | null;
  preview: DraftMatchupPreview | undefined;
  champIcons: Map<number, ChampionIconEntry>;
}) {
  if (!candidate) {
    return (
      <article className="rounded-xl border border-dashed border-line bg-panel p-4 text-center">
        <p className="text-[11px] font-semibold text-txt">No honest matchup preview for this slot yet.</p>
        <p className="mt-1 text-[10.5px] text-mut">A distinct recommendation with popular-opponent evidence is required.</p>
      </article>
    );
  }
  const entry = championEntry(champIcons, candidate.champId);
  return (
    <article className="rounded-xl border border-line bg-panel p-2.5">
      <div className="flex items-center gap-2.5">
        <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-full border border-line-gold bg-black/30">
          <IconWithFallback src={entry.icon} alt={entry.name} fallbackGlyph={entry.name} className="h-full w-full object-cover" size={36} />
        </span>
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold text-txt">{entry.name}</h3>
          <p className="text-[10px] text-mut">vs Popular Picks</p>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <MatchupGroup label="Worst" rows={preview?.worst ?? []} champIcons={champIcons} />
        <MatchupGroup label="Best" rows={preview?.best ?? []} champIcons={champIcons} />
      </div>
    </article>
  );
}

interface DetailRow {
  candidate: DraftAssistantCandidate;
  name: string;
  icon: string;
  difficultyBand: ChampionIconEntry["difficultyBand"];
}

function laneAverage(laneStats: DraftLaneStat[]): number | null {
  let games = 0;
  let wins = 0;
  for (const stat of laneStats) {
    if (stat.baselineWr === null || stat.totalGames === null || stat.totalGames <= 0) continue;
    games += stat.totalGames;
    wins += stat.baselineWr * stat.totalGames;
  }
  return games > 0 ? wins / games : null;
}

function DetailedRankings({
  rows,
  laneAverageValue,
  sort,
  onSortChange,
  grid,
  onGridChange,
  selectedChampionId,
  onSelect,
  showAll,
  onShowAll,
  preserveOrder,
  showNoEnemyBlindHint,
  cardedRows,
}: {
  rows: DetailRow[];
  cardedRows: DetailRow[];
  laneAverageValue: number | null;
  sort: DetailSort;
  onSortChange: (sort: DetailSort) => void;
  grid: boolean;
  onGridChange: (grid: boolean) => void;
  selectedChampionId: number | null;
  onSelect: (id: number) => void;
  showAll: boolean;
  onShowAll: () => void;
  preserveOrder: boolean;
  showNoEnemyBlindHint: boolean;
}) {
  const detailRowByChampionId = new Map<number, DetailRow>();
  for (const row of [...rows, ...cardedRows]) {
    if (!detailRowByChampionId.has(row.candidate.champId)) detailRowByChampionId.set(row.candidate.champId, row);
  }
  const rankingRows = resolveVisibleDraftAssistantRanking({
    rows: rows.map((row) => row.candidate),
    carded: cardedRows.map((row) => row.candidate),
    sort,
    limit: showAll ? Number.MAX_SAFE_INTEGER : 10,
    preserveOrder,
  });
  const displayRows = rankingRows
    .map((rankingRow) => {
      const row = detailRowByChampionId.get(rankingRow.candidate.champId);
      return row ? { ...rankingRow, row } : null;
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  function delta(candidate: DraftAssistantCandidate): number | null {
    return laneAverageValue === null ? null : candidate.winRate - laneAverageValue;
  }

  return (
    <section id="draft-detailed-rankings" className="flex min-w-0 flex-col rounded-xl border border-line bg-panel">
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-4">
        <h2 className="text-[11px] font-bold tracking-[0.14em] text-txt">DETAILED RANKINGS</h2>
        <div className="flex items-center gap-1" role="group" aria-label="Ranking display">
          <button
            type="button"
            onClick={() => onGridChange(false)}
            aria-label="List view"
            aria-pressed={!grid}
            className={`flex h-7 w-7 items-center justify-center rounded-md border text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${!grid ? "border-teal text-teal" : "border-line text-mut hover:text-txt"}`}
          >
            ☰
          </button>
          <button
            type="button"
            onClick={() => onGridChange(true)}
            aria-label="Grid view"
            aria-pressed={grid}
            className={`flex h-7 w-7 items-center justify-center rounded-md border text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${grid ? "border-teal text-teal" : "border-line text-mut hover:text-txt"}`}
          >
            ▦
          </button>
        </div>
      </div>
      {showNoEnemyBlindHint && <p className="border-b border-line px-4 py-2 text-[10px] text-mut">No enemies picked yet — showing blind-pick rankings.</p>}
      <div className="border-b border-line px-4 py-3">
        <label className="flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-mut">
          <span>Sort by</span>
          <select value={sort} disabled={preserveOrder} aria-label={preserveOrder ? "Sorting disabled for Comfort Picks" : "Sort detailed rankings"} onChange={(event) => onSortChange(event.target.value as DetailSort)} className="rounded-md border border-line bg-panel2 px-2 py-1.5 text-[11px] normal-case tracking-normal text-txt outline-none focus:border-teal disabled:cursor-not-allowed disabled:opacity-60">
            <option value="winRate">Win Rate</option>
            <option value="pickRate">Pick Rate</option>
            <option value="games">Games</option>
          </select>
        </label>
      </div>

      {grid ? (
        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {displayRows.map((displayRow, position) => {
            const row = displayRow.row;
            const rowDelta = delta(row.candidate);
            const offMeta = isOffMetaLaneShare(row.candidate.laneShare);
            const startsCardedSection = displayRow.isAppended && (position === 0 || !displayRows[position - 1].isAppended);
            return (
              <Fragment key={`${row.candidate.champId}-${displayRow.isAppended ? "card" : "rank"}`}>
                {startsCardedSection && <div className="col-span-full border-t border-line pt-2 text-[9px] font-bold tracking-[0.12em] text-mut">CARDED RECOMMENDATIONS · SHOWN FOR REFERENCE</div>}
                <button
                  type="button"
                  onClick={() => onSelect(row.candidate.champId)}
                  className={`min-w-0 rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${selectedChampionId === row.candidate.champId ? "border-teal bg-teal/8" : "border-line hover:border-line-gold"}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] tabular-nums text-mut">{displayRow.rank}</span>
                    <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-md bg-black/30">
                      <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="h-full w-full object-cover" size={32} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-txt">{row.name}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                    <span className="text-mut">WIN RATE <strong className="block text-[12px] text-good">{formatPercent(row.candidate.winRate)}</strong><small className={rowDelta === null ? "text-mut" : rowDelta >= 0 ? "text-good" : "text-bad"}>{rowDelta === null ? "—" : `${rowDelta >= 0 ? "+" : ""}${formatPercent(rowDelta)}`}</small></span>
                    <span className="text-mut">PICK RATE <strong className="block text-[12px] text-txt">{formatPercent(row.candidate.laneShare)}</strong><small className="text-mut">{formatGames(row.candidate.totalGames)}</small></span>
                  </div>
                  {offMeta && <span className="mt-2 inline-flex rounded border border-line-gold px-1.5 py-0.5 text-[9px] font-semibold text-mut">Off-Meta</span>}
                  {row.candidate.isPotential && <span className="mt-2 ml-1 inline-flex rounded border border-line-gold px-1.5 py-0.5 text-[9px] font-semibold text-mut">Low-Sample</span>}
                  {row.difficultyBand && <span className="mt-2 ml-1 inline-flex rounded border border-line px-1.5 py-0.5 text-[9px] font-semibold text-mut">{row.difficultyBand}</span>}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full w-full border-collapse text-left">
            <caption className="sr-only">Draft champions ranked for the selected view</caption>
            <thead>
              <tr className="border-b border-line text-[9px] font-bold uppercase tracking-[0.1em] text-mut">
                <th scope="col" className="w-8 px-3 py-3">#</th>
                <th scope="col" className="px-2 py-3">CHAMPION</th>
                <th scope="col" className="px-2 py-3 text-right">WIN RATE</th>
                <th scope="col" className="px-3 py-3 text-right">PICK RATE</th>
                <th scope="col" className="px-3 py-3 text-right">DIFFICULTY</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map((displayRow, position) => {
                const row = displayRow.row;
                const rowDelta = delta(row.candidate);
                const offMeta = isOffMetaLaneShare(row.candidate.laneShare);
                const startsCardedSection = displayRow.isAppended && (position === 0 || !displayRows[position - 1].isAppended);
                return (
                  <Fragment key={`${row.candidate.champId}-${displayRow.isAppended ? "card" : "rank"}`}>
                    {startsCardedSection && <tr><td colSpan={5} className="border-t border-line px-3 py-2 text-[9px] font-bold tracking-[0.12em] text-mut">CARDED RECOMMENDATIONS · SHOWN FOR REFERENCE</td></tr>}
                    <tr className={`border-b border-line/60 ${selectedChampionId === row.candidate.champId ? "bg-teal/8" : "hover:bg-white/[0.02]"}`}>
                      <td className="px-3 py-3 text-[10px] tabular-nums text-mut">{displayRow.rank}</td>
                      <td className="px-2 py-3">
                        <button type="button" onClick={() => onSelect(row.candidate.champId)} className="flex min-w-0 items-center gap-2 text-left">
                          <span className="h-8 w-8 flex-shrink-0 overflow-hidden rounded-md bg-black/30">
                            <IconWithFallback src={row.icon} alt={row.name} fallbackGlyph={row.name} className="h-full w-full object-cover" size={32} />
                          </span>
                          <span className="min-w-0">
                            <span className="block max-w-[110px] truncate text-[11px] font-semibold text-txt">{row.name}</span>
                            {offMeta && <span className="mt-0.5 block text-[9px] text-mut">Off-Meta</span>}
                            {row.candidate.isPotential && <span className="mt-0.5 block text-[9px] text-mut">Low-Sample</span>}
                          </span>
                        </button>
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        <span className="block text-[12px] font-semibold text-good">{formatPercent(row.candidate.winRate)}</span>
                        <span className={`block text-[10px] ${rowDelta === null ? "text-mut" : rowDelta >= 0 ? "text-good" : "text-bad"}`}>{rowDelta === null ? "—" : `${rowDelta >= 0 ? "+" : ""}${formatPercent(rowDelta)}`}</span>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <span className="block text-[12px] text-txt">{formatPercent(row.candidate.laneShare)}</span>
                        <span className="block text-[10px] text-mut">{formatGames(row.candidate.totalGames)}</span>
                      </td>
                      <td className="px-3 py-3 text-right text-[10px] text-mut">{row.difficultyBand ?? "—"}</td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 && <p className="px-4 py-8 text-center text-[11px] text-mut">No rankings meet the active filters.</p>}
      <div className="border-t border-line px-4 py-3 text-center">
        <button type="button" onClick={onShowAll} disabled={showAll || rows.length <= 10} className="mb-2 block w-full text-[10.5px] font-semibold text-teal hover:text-teal-hover disabled:cursor-default disabled:text-mut">
          {showAll ? "Showing full table" : "View full table →"}
        </button>
        <span className="text-[10px] text-mut">Figures are estimated from this lane&apos;s matchup data.</span>
      </div>
    </section>
  );
}

export default function DraftPage() {
  const companion = useCompanion();

  // Session adoption (v1.6.0, "two pages simultaneously" ship) — companion.ps1
  // now opens `/draft?session=<token>` directly (Get-DraftDeepLinkUrl,
  // Update-ChampSelectState) alongside the Builds deep-link, same
  // "?championId=&role=&session=" convention app/page.tsx's own mount effect
  // already handles for `/`. This page has no championId/role to resolve
  // (it live-syncs entirely off CompanionProvider's poll, see the live-sync
  // effect below) — SESSION ADOPTION ONLY. Deliberately does NOT touch
  // dirty/lane/enemyIds/entryStateRef or any of the reskin's byte-for-byte-
  // preserved state machine (see this file's header comment) — a fresh tab
  // landing on /draft should sync from live champ select exactly like any
  // other companion-paired page, not be treated as a manual edit.
  const sessionAppliedRef = useRef(false);
  useEffect(() => {
    if (sessionAppliedRef.current) return;
    sessionAppliedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const session = params.get("session");
    if (session) companion.setSession(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [lane, setLane] = useState<LaneId>("mid");
  const [enemyIds, setEnemyIds] = useState<number[]>([]);
  const [laneOpponentId, setLaneOpponentId] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Manual-override dirty latch (plan §6c) — flips true on ANY user edit
  // below; live auto-fill stops overwriting the user's inputs until they
  // explicitly tap "Reset to live".
  const [dirty, setDirty] = useState(false);
  // "My pool" filter (My Stats, 2026-07-21) — a FILTER, never a re-scorer:
  // keeps only candidates I've played at least once in this lane, in the
  // SAME order the server already ranked them (see personalBadge.ts's
  // filterToMyPool doc comment). Independent of `dirty`/live-sync — purely
  // a display toggle over whatever the server already returned.
  const [myPoolOnly, setMyPoolOnly] = useState(false);
  // Allied picks are stored for the Draft Assistant control row only. There
  // is no ally-pair data in coachbuild.draft_matchup, so this state is
  // deliberately excluded from the recommendation request and every score.
  const [allyIds, setAllyIds] = useState<number[]>([]);
  const [assistantView, setAssistantView] = useState<AssistantView>("recommended");
  const [minPickRate, setMinPickRate] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.minPickRate);
  const [includeOffMeta, setIncludeOffMeta] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.includeOffMeta);
  const [minimumGames, setMinimumGames] = useState(DEFAULT_DRAFT_ASSISTANT_FILTERS.minimumGames);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [showRecommendationHelp, setShowRecommendationHelp] = useState(false);
  const [detailSort, setDetailSort] = useState<DetailSort>("winRate");
  const [detailGrid, setDetailGrid] = useState(false);
  const [selectedDetailChampionId, setSelectedDetailChampionId] = useState<number | null>(null);
  const [showFullTable, setShowFullTable] = useState(false);

  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [blindState, setBlindState] = useState<BlindPickFetchState>({ status: "loading" });

  const laneRef = useRef(lane);
  laneRef.current = lane;
  const enemyIdsRef = useRef(enemyIds);
  enemyIdsRef.current = enemyIds;
  const laneOpponentIdRef = useRef(laneOpponentId);
  laneOpponentIdRef.current = laneOpponentId;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  // v0.40.0 — see draftLiveSync.ts's resolveChampSelectEntry doc comment.
  // Tracks the last REAL (non-null) companion phase across ticks so the
  // live-sync effect below can detect a genuine champ-select ENTRY (not the
  // steady state, not a transient null poll blip) and auto-clear the
  // manual-dirty latch on it. A ref, not state -- this is pure bookkeeping
  // that must never itself trigger a re-render.
  const entryStateRef = useRef<ChampSelectEntryState>(INITIAL_CHAMP_SELECT_ENTRY_STATE);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  // ── Live sync (read-only) ─────────────────────────────────────────────
  // Re-evaluates on every companion poll tick (companion.tick — see
  // CompanionProvider's own doc comment for why that's the right dependency,
  // not phase/champSelect's object identity alone) AND whenever `dirty`
  // flips (so tapping "Reset to live" re-applies immediately rather than
  // waiting up to 3s for the next tick). Guards each field individually
  // against its own current value (via the refs above) so a tick that
  // resolves to the SAME values never triggers a pointless re-render or
  // re-fetch.
  useEffect(() => {
    // P0 fix (v0.40.0): a fresh champ-select ENTRY always wins over a
    // stale manual-dirty latch from a PREVIOUS draft, so live pickup
    // re-attaches on every new game rather than staying detached forever
    // after a single "Clear" tap. Only fires on the transition tick (see
    // resolveChampSelectEntry) -- manual edits still win for the rest of
    // THIS champ select. When this fires, bail out and let the re-render
    // triggered by setDirty(false) re-run this effect with fresh `dirty`
    // state, rather than trying to also apply the target in the same pass.
    const entryResult = resolveChampSelectEntry(entryStateRef.current, companion.phase);
    entryStateRef.current = entryResult.next;
    if (entryResult.isEntry && dirty) {
      setDirty(false);
      return;
    }

    const target = resolveDraftLiveTarget({ phase: companion.phase, champSelect: companion.champSelect, dirty });
    if (!target) return;

    if (target.lane !== undefined && target.lane !== laneRef.current) setLane(target.lane);
    if (!arraysEqual(target.enemies, enemyIdsRef.current)) setEnemyIds(target.enemies);

    // AUDIT P2-1 (2026-07-21): companion (live) mode never guesses a
    // direct-lane opponent client-side anymore — theirTeam is NOT lane-
    // tagged on the wire, and index-based inference was proven wrong mid-
    // draft (see draftLiveSync.ts's resolveDraftLiveTarget doc comment).
    // `laneOpponentId` stays under pure manual control (handleToggleLaneOpponent);
    // the server's own statistical inference (meta.laneOppInferred, surfaced
    // below via `inferredLaneOpponentId`) covers live mode instead.

    if (target.hover !== hoverRef.current) setHover(target.hover);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companion.tick, companion.phase, companion.champSelect, dirty]);

  // ── Debounced + race-guarded recommend fetch ───────────────────────────
  const reqIdRef = useRef(0);
  useEffect(() => {
    const requestId = ++reqIdRef.current;
    setState({ status: "loading" });
    const laneNum = LANE_TO_ROLE_ID[lane];
    const timer = setTimeout(() => {
      fetchDraftRecommend({ lane: laneNum, enemies: enemyIds, hover, laneOpp: laneOpponentId }).then((data) => {
        if (reqIdRef.current !== requestId) return; // superseded by a newer input change
        if (!data) {
          setState({ status: "error" });
          return;
        }
        if (data.pending) {
          setState({ status: "pending", meta: data.meta });
          return;
        }
        // v0.37.4: a laneOpp-resolved response can legitimately have an
        // empty `plays` (main) while still having real `potentialPlays` --
        // low-sample leads are still something to show, not "no data".
        if (data.plays.length === 0 && data.potentialPlays.length === 0) {
          setState({ status: "empty", meta: data.meta });
          return;
        }
        setState({ status: "ok", data });
      });
    }, RECOMMEND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [lane, enemyIds, laneOpponentId, hover]);

  // Blind picks depend only on the concrete lane, patch, and tier. Keep this
  // fetch independent from enemy edits so the section remains valid for a
  // first pick even after other champions are entered in the draft. The
  // request id also protects the table when the user changes lanes quickly.
  const blindReqIdRef = useRef(0);
  // Bumping this re-runs the effect below without changing lane — it is what
  // makes the error panel's "Try again" an actual retry. The panel said
  // "try again" with nothing to click before (2026-08-01 audit P2).
  const [blindRetry, setBlindRetry] = useState(0);
  useEffect(() => {
    const requestId = ++blindReqIdRef.current;
    setBlindState({ status: "loading" });
    const controller = new AbortController();
    const laneNum = LANE_TO_ROLE_ID[lane];

    fetch(`/api/draft/blind-pick?lane=${laneNum}`, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`blind pick ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((raw) => {
        if (blindReqIdRef.current !== requestId) return;
        const data = normalizeBlindPickResponse(raw);
        if (!data) {
          setBlindState({ status: "error" });
          return;
        }
        if (data.pending) {
          setBlindState({ status: "pending", data });
          return;
        }
        setBlindState({ status: data.picks.length > 0 ? "ok" : "empty", data });
      })
      .catch(() => {
        if (blindReqIdRef.current === requestId) setBlindState({ status: "error" });
      });

    return () => controller.abort();
  }, [lane, blindRetry]);

  function handleLaneChange(next: LaneId) {
    setDirty(true);
    setLane(next);
  }

  function handleAddEnemy(champ: ChampionRef) {
    setDirty(true);
    setEnemyIds((prev) => (prev.includes(champ.id) || prev.length >= MAX_DRAFT_ENEMIES ? prev : [...prev, champ.id]));
  }

  function handleAddAlly(champ: ChampionRef) {
    setAllyIds((prev) => (prev.includes(champ.id) || prev.length >= MAX_ALLIED_ADDITIONAL ? prev : [...prev, champ.id]));
  }

  function handleRemoveAlly(id: number) {
    setAllyIds((prev) => prev.filter((x) => x !== id));
  }

  function handleAssistantViewChange(view: AssistantView) {
    setAssistantView(view);
    setMyPoolOnly(view === "comfort");
    setShowFullTable(false);
  }

  function handleAssistantTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, current: AssistantView) {
    const views: AssistantView[] = ["recommended", "blind", "counters", "comfort"];
    const currentIndex = views.indexOf(current);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % views.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + views.length) % views.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = views.length - 1;
    if (nextIndex === currentIndex) return;
    event.preventDefault();
    const next = views[nextIndex];
    handleAssistantViewChange(next);
    window.setTimeout(() => document.getElementById(`draft-tab-${next}`)?.focus(), 0);
  }

  function handleViewDetails(champId: number) {
    setAssistantView("recommended");
    setMyPoolOnly(false);
    setSelectedDetailChampionId(champId);
    window.setTimeout(() => document.getElementById("draft-detailed-rankings")?.scrollIntoView({ block: "nearest", behavior: "auto" }), 0);
  }

  function handleRemoveEnemy(id: number) {
    setDirty(true);
    setEnemyIds((prev) => prev.filter((x) => x !== id));
    setLaneOpponentId((prev) => (prev === id ? null : prev));
  }

  function handleToggleLaneOpponent(id: number) {
    setDirty(true);
    setLaneOpponentId((prev) => (prev === id ? null : id));
  }

  function handleHoverChange(champ: ChampionRef) {
    setDirty(true);
    setHover(champ.id);
  }

  function handleClearHover() {
    setDirty(true);
    setHover(null);
  }

  function handleResetToLive() {
    setDirty(false);
  }

  const hoverEntry = hover !== null ? champIcons.get(hover) : undefined;
  const hoverChamp: ChampionRef | null =
    hover !== null ? { id: hover, key: "", name: hoverEntry?.name ?? `Champion #${hover}`, icon: hoverEntry?.icon ?? "" } : null;

  const showResetToLive = shouldShowResetToLive(dirty, companion.phase, companion.champSelect);
  const liveSyncing = companion.phase === "ChampSelect" && !dirty;

  // Round-B stale-data honesty fix: meta.patch is whatever the draft tables
  // actually have ingested (lib/draft/recommend.ts's resolveServingPatch);
  // meta.currentPatch is what the rest of the app considers current
  // (getLatestPatch()). The daily ingest cron is Cloudflare-blocked from
  // reaching u.gg on Vercel's egress IP (see HANDOFF's "Vercel-egress probe
  // of stats2" finding) — not something this page can fix — so the two can
  // diverge for days. Rather than silently keep showing the old patch's
  // numbers with no signal, surface it honestly whenever real data IS being
  // shown for a patch that isn't the newest one.
  const isStalePatchData =
    state.status === "ok" &&
    state.data.meta.currentPatch !== null &&
    state.data.meta.patch !== null &&
    state.data.meta.currentPatch !== state.data.meta.patch;

  // 2026-07-31 audit P2 (#2) — the scheduled draft ingest itself failing is a
  // DIFFERENT fact from the served patch being behind (isStalePatchData
  // above): a run can fail today while yesterday's data still looks fine, or
  // succeed today while still serving an old patch because it hasn't reached
  // it yet. Only warn on an explicit `false` — `null` means unknown, never a
  // manufactured warning.
  const isIngestUnhealthy = state.status === "ok" && state.data.meta.ingestHealthy === false;

  // audit P2-1: the enemy chip highlight reflects EITHER the user's own
  // explicit tag (laneOpponentId) OR — when the user hasn't tagged anyone —
  // the server's own statistical inference (meta.laneOppInferred), never a
  // client-side index guess. This is display-only: the actual score
  // weighting already comes straight from the server regardless of what's
  // highlighted here (play.winVsLaneOpp is computed server-side).
  const serverInferredLaneOpponentId = state.status === "ok" ? state.data.meta.laneOppInferred : null;
  const effectiveLaneOpponentId = laneOpponentId ?? serverInferredLaneOpponentId;

  // My pool filter — applied to a DISPLAY copy only; state.data.plays/
  // potentialPlays (and their order) are never mutated, so toggling this off
  // always restores the exact server-ranked list.
  const basePlays: DraftPlayResult[] = state.status === "ok" ? state.data.plays : [];
  const basePotentialPlays: DraftPlayResult[] = state.status === "ok" ? state.data.potentialPlays : [];
  const displayedPlays = myPoolOnly ? filterComfortCandidates(basePlays) : basePlays;
  const displayedPotentialPlays = myPoolOnly ? filterComfortCandidates(basePotentialPlays) : basePotentialPlays;
  const hasAnyMyPoolData = basePlays.some((p) => p.personalOverall.games >= 1) || basePotentialPlays.some((p) => p.personalOverall.games >= 1);

  const blindMeta = blindState.status === "ok" || blindState.status === "empty" ? blindState.data.meta : null;
  const blindPoolAfterShare = blindMeta
    ? Math.max(0, blindMeta.poolCandidates - blindMeta.excludedByLaneShare)
    : 0;
  const blindExclusionNote = blindMeta
    ? [
        blindMeta.excludedByLaneShare > 0
          ? `${blindMeta.excludedByLaneShare} of ${blindMeta.poolCandidates} pool champions excluded: below ${formatPercent(POOL_MIN_PICKRATE)} lane share`
          : null,
        blindMeta.excludedByMassGate > 0
          ? `${blindMeta.excludedByMassGate} of ${blindPoolAfterShare} remaining pool champions excluded: less than 90% of their opponent mass is backed by 30+ game cells`
          : null,
        blindMeta.excludedUncomputable > 0
          ? `${blindMeta.excludedUncomputable} remaining pool champions excluded: no usable matchup rows`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join("; ")
    : "";

  const laneStats: DraftLaneStat[] = state.status === "ok" ? (state.data.laneStats ?? []) : [];
  const laneStatMap = new Map<number, DraftLaneStat>(laneStats.map((stat) => [stat.champId, stat]));
  const matchupPreviewMap = new Map<number, DraftMatchupPreview>(
    state.status === "ok" ? (state.data.matchupPreviews ?? []).map((preview) => [preview.champId, preview]) : []
  );
  const fullLaneCandidates: DraftAssistantCandidate[] = laneStats
    .filter((stat) => stat.baselineWr !== null)
    .map((stat, index) => ({
      champId: stat.champId,
      winRate: stat.baselineWr ?? 0.5,
      floor: null,
      totalGames: stat.totalGames,
      laneShare: stat.laneShare,
      rank: Number.MAX_SAFE_INTEGER - index,
      isPotential: false,
      personalOverall: { games: 0, wins: 0 },
      source: "recommended" as const,
    }));
  const activeFilters = { minPickRate, includeOffMeta, minimumGames };
  const recommendedFilterRows = displayedPlays.map((play, index) => {
    const stat = laneStatMap.get(play.champId);
    return { play, rank: index + 1, synergyDelta: play.synergyDelta, champId: play.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? null };
  });
  const potentialFilterRows = displayedPotentialPlays.map((play, index) => {
    const stat = laneStatMap.get(play.champId);
    return { play, rank: index + 1, synergyDelta: play.synergyDelta, champId: play.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? null };
  });
  const filteredRecommendedRows = filterDraftAssistantCandidates(recommendedFilterRows, activeFilters);
  const filteredPotentialRows = filterDraftAssistantCandidates(potentialFilterRows, activeFilters);
  const filteredRecommendedPlays = filteredRecommendedRows.map((row) => row.play);
  const filteredPotentialPlays = filteredPotentialRows.map((row) => row.play);

  const blindPicks = blindState.status === "ok" ? blindState.data.picks : [];
  const blindFilterRows = blindPicks.map((pick) => {
    const stat = laneStatMap.get(pick.champId);
    return { pick, champId: pick.champId, laneShare: stat?.laneShare ?? null, totalGames: stat?.totalGames ?? pick.totalGames };
  });
  const filteredBlindRows = filterDraftAssistantCandidates(blindFilterRows, activeFilters);
  const filteredBlindPicks = filteredBlindRows.map((row) => row.pick);
  const filteredBlindCandidates: DraftAssistantCandidate[] = filteredBlindRows.map(({ pick }) => {
    const stat = laneStatMap.get(pick.champId);
    return {
      champId: pick.champId,
      winRate: pick.fieldWr,
      floor: pick.es10,
      totalGames: stat?.totalGames ?? pick.totalGames,
      laneShare: stat?.laneShare ?? null,
      rank: pick.rank,
      isPotential: false,
      personalOverall: { games: 0, wins: 0 },
      source: "blind" as const,
    };
  });

  const filteredCounterRows = filterCounterCandidates([...filteredRecommendedRows, ...filteredPotentialRows]);

  const toRecommendedCandidate = (row: (typeof recommendedFilterRows)[number], isPotential: boolean): DraftAssistantCandidate => {
    const stat = laneStatMap.get(row.play.champId);
    return {
      champId: row.play.champId,
      winRate: row.play.score,
      floor: null,
      totalGames: stat?.totalGames ?? null,
      laneShare: stat?.laneShare ?? null,
      rank: row.rank,
      isPotential,
      personalOverall: row.play.personalOverall,
      source: "recommended",
    };
  };

  const matchupDetailCandidates = [
    ...filteredRecommendedRows.map((row) => toRecommendedCandidate(row, false)),
    ...filteredPotentialRows.map((row) => toRecommendedCandidate(row, true)),
  ];
  const currentViewRows: DraftAssistantCandidate[] =
    assistantView === "blind"
      ? filteredBlindCandidates
      : assistantView === "counters" && enemyIds.length === 0
        ? []
        : assistantView === "counters"
          ? filteredCounterRows.map((row) => toRecommendedCandidate(row, displayedPotentialPlays.includes(row.play)))
          : assistantView === "recommended"
            ? resolveRecommendedDetailCandidates({ recommended: matchupDetailCandidates, blind: filteredBlindCandidates, noEnemies: enemyIds.length === 0 })
            : matchupDetailCandidates;

  const topCards = resolveTopRecommendationCards({
    recommended: filteredRecommendedPlays,
    potential: filteredPotentialPlays,
    blind: filteredBlindPicks,
    laneStats: laneStatMap,
    fullList: fullLaneCandidates,
  });
  const cardedCandidates = assistantView === "recommended"
    ? filterDraftAssistantCandidates(
        topCards.flatMap((card) => (card.candidate ? [card.candidate] : [])),
        activeFilters
      )
    : [];
  const toDetailRow = (candidate: DraftAssistantCandidate): DetailRow => {
    const entry = championEntry(champIcons, candidate.champId);
    return { candidate, name: entry.name, icon: entry.icon, difficultyBand: entry.difficultyBand };
  };
  const detailRows: DetailRow[] = currentViewRows.map(toDetailRow);
  const cardedRows: DetailRow[] = cardedCandidates.map(toDetailRow);
  const detailAverage = laneAverage(laneStats);

  return (
    <div className="min-w-0 overflow-x-clip px-4 py-3 sm:px-6 lg:px-8 lg:py-4">
      <div className="mx-auto min-w-0 max-w-[1560px]">
        <header className="mb-3 flex flex-wrap items-start justify-between gap-4 border-b border-line pb-2.5">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] tabular-nums text-mut">
              <span aria-hidden="true" className="text-teal">ⓘ</span>
              Data: Patch {state.status === "ok" ? state.data.meta.patch || "—" : "—"} · Last refreshed {state.status === "ok" ? formatRelativeTime(state.data.meta.fetchedAt) : "—"}
            </p>
            {isStalePatchData && state.status === "ok" && <p className="mt-1 text-[10px] text-mut">Patch {state.data.meta.currentPatch} data is not ready yet — showing patch {state.data.meta.patch}.</p>}
            {isIngestUnhealthy && state.status === "ok" && <p className="mt-1 text-[10px] text-bad/80" title={state.data.meta.ingestLastError ?? undefined}>Last data refresh reported an error.</p>}
          </div>
          <ApplyRunesButton />
        </header>

        {liveSyncing && <div className="mb-4 flex items-center gap-2 text-[11px] font-semibold text-teal"><span className="h-1.5 w-1.5 rounded-full bg-teal motion-reduce:animate-none animate-pulse" aria-hidden="true" />Live — syncing from champ select</div>}
        {showResetToLive && (
          <div role="status" className="mb-4">
            <button type="button" onClick={handleResetToLive} className="rounded-lg bg-teal px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-bg hover:bg-teal-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">Update ready <span aria-hidden="true">↻</span></button>
          </div>
        )}

        <section className="mb-3">
          <h1 className="text-[22px] font-extrabold tracking-[-0.03em] text-txt sm:text-[26px]">DRAFT ASSISTANT</h1>
          <p className="mt-0.5 text-[12px] text-mut">Get the best pick for your draft.</p>
        </section>

        <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)]">
          <div className="min-w-0 space-y-2">
            <section className="grid min-w-0 grid-cols-1 overflow-visible rounded-xl border border-line bg-panel lg:grid-cols-[minmax(136px,0.85fr)_minmax(176px,1.6fr)_minmax(0,1.7fr)_36px_minmax(0,1.7fr)]">
              <label className="min-w-0 border-b border-line p-4 lg:border-b-0 lg:border-r">
                <span className="mb-2 block text-[9px] font-bold uppercase tracking-[0.14em] text-mut">YOUR ROLE</span>
                <span className="relative block">
                  <select value={lane} onChange={(event) => handleLaneChange(event.target.value as LaneId)} aria-label="Your role" className="w-full appearance-none rounded-lg border border-line bg-panel2 px-3 py-2.5 pr-9 text-[12px] font-semibold text-txt outline-none focus:border-teal">
                    {LANE_ORDER.map((role) => <option key={role} value={role}>{LANE_LABEL[role]} Lane</option>)}
                  </select>
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mut" fill="none">
                    <path d="m4 6 4 4 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
                  </svg>
                </span>
              </label>
              <div className="min-w-0 border-b border-line p-3 lg:border-b-0 lg:border-r">
                <span className="mb-2 block text-[9px] font-bold uppercase tracking-[0.14em] text-mut">YOUR PICK <span className="font-normal normal-case tracking-normal">(optional)</span></span>
                <div className="relative min-w-0 [&>div]:min-w-0 [&>div>input]:min-w-0 [&>div>input]:pr-8">
                  <ChampionPicker value={hoverChamp} onChange={handleHoverChange} placeholder="Select a champion" />
                  <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mut">
                    <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="m12.5 12.5 4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                  </svg>
                  {hover !== null && <button type="button" onClick={handleClearHover} aria-label="Clear your champion" className="absolute right-8 top-1/2 -translate-y-1/2 rounded px-1 text-[16px] leading-none text-mut hover:text-bad">×</button>}
                </div>
              </div>
              <div className="min-w-0 border-b border-line p-3 lg:border-b-0 lg:border-r">
                <TeamSlots label="ALLIED TEAM" primaryId={hover} additionalIds={allyIds} champIcons={champIcons} placeholder="Add an ally" onAdd={handleAddAlly} onRemove={handleRemoveAlly} />
              </div>
              <div className="flex items-center justify-center border-b border-line px-3 py-2 text-[12px] font-bold lowercase text-mut lg:border-b-0 lg:border-r">vs</div>
              <div className="min-w-0 p-3">
                <TeamSlots label="ENEMY TEAM" primaryId={null} additionalIds={enemyIds} champIcons={champIcons} placeholder="Add an enemy" onAdd={handleAddEnemy} onRemove={handleRemoveEnemy} onToggleLaneOpponent={handleToggleLaneOpponent} effectiveLaneOpponentId={effectiveLaneOpponentId} laneOpponentId={laneOpponentId} />
              </div>
            </section>

            <div className="flex items-center gap-2 rounded-lg border border-line bg-panel2/60 px-4 py-2 text-[11px] text-mut"><span aria-hidden="true" className="text-[14px] text-teal">✨</span>Recommendations update as you add enemies and change your role.</div>

            <section>
              <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
                <div><h2 className="text-[12px] font-bold tracking-[0.14em] text-txt">TOP RECOMMENDATIONS</h2><p className="mt-1 text-[11px] text-mut">Our top picks for this draft right now</p></div>
                <button type="button" aria-expanded={showRecommendationHelp} onClick={() => setShowRecommendationHelp((value) => !value)} className="rounded-full border border-line px-3 py-1.5 text-[10px] font-semibold text-mut hover:border-line-gold hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg">ⓘ How recommendations work</button>
              </div>
              {showRecommendationHelp && <p className="mb-3 rounded-lg border border-line bg-panel2/60 px-3 py-2 text-[10.5px] leading-4 text-mut">Recommendations combine estimated win rate, the worst 10% matchup floor, true lane pick rate, and available matchup evidence. Low-sample rows stay visibly tagged.</p>}
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
                {topCards.map((card, index) => <RecommendationCard key={card.slot} card={card} rank={index + 1} champIcons={champIcons} preview={card.candidate ? matchupPreviewMap.get(card.candidate.champId) : undefined} onViewDetails={handleViewDetails} />)}
              </div>
              {state.status === "loading" && <p className="mt-2 text-[10.5px] text-mut">Loading current recommendation data…</p>}
              {state.status === "error" && <EmptyPanel title="Couldn't load recommendations" body="Something went wrong fetching the current draft data." />}
              {state.status === "pending" && <EmptyPanel title="Draft data being prepared" body={"Patch " + (state.meta?.patch || "the current") + " data is still being ingested — check back shortly."} />}
              {state.status === "empty" && <EmptyPanel title="No data yet for this lane" body="Try a different role, or check back after the next data refresh." />}
            </section>

            <section>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <span className="text-[11px] font-semibold text-mut">View by:</span>
                <div className="flex min-w-0 flex-wrap gap-1.5" role="tablist" aria-label="Draft views">
                  {([["recommended", "Recommended"], ["blind", "Blind Picks"], ["counters", "Counters"], ["comfort", "Comfort Picks"]] as const).map(([value, label]) => (
                    <button key={value} id={`draft-tab-${value}`} type="button" role="tab" aria-selected={assistantView === value} aria-controls="draft-view-panel" tabIndex={assistantView === value ? 0 : -1} onClick={() => handleAssistantViewChange(value)} onKeyDown={(event) => handleAssistantTabKeyDown(event, value)} className={assistantView === value ? "rounded-full bg-teal px-3 py-1.5 text-[10.5px] font-bold text-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg" : "rounded-full border border-line bg-panel px-3 py-1.5 text-[10.5px] font-semibold text-mut hover:border-line-gold hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"}>{label}</button>
                  ))}
                </div>
              </div>
              <div id="draft-view-panel" role="tabpanel" aria-labelledby={`draft-tab-${assistantView}`} tabIndex={0}>
                {assistantView === "counters" && enemyIds.length === 0 && <EmptyPanel title="Add an enemy to see counters" body="Counters use favourable shrunk matchup deltas against the entered enemies." />}
                {assistantView === "counters" && enemyIds.length > 0 && filteredCounterRows.length === 0 && <EmptyPanel title="No favourable counters in this ranking" body="No candidate has a positive shrunk matchup delta against the entered enemies." />}
                {assistantView === "comfort" && !hasAnyMyPoolData && <EmptyPanel title="No Comfort Picks yet" body="Link an account and play ranked solo games this season to see your pool." />}
                {assistantView === "comfort" && hasAnyMyPoolData && filteredRecommendedPlays.length === 0 && <EmptyPanel title="No Comfort Picks meet the filters" body="Lower the filters or return to Recommended to see the full ranking." />}
                {assistantView === "blind" && blindState.status === "loading" && <BlindPickSkeleton />}
                {assistantView === "blind" && blindState.status === "error" && <div className="rounded-xl border border-line bg-panel p-6 text-center"><p className="text-[12px] font-semibold text-txt">Couldn&apos;t load blind picks</p><button type="button" onClick={() => setBlindRetry((value) => value + 1)} className="mt-3 rounded-md border border-line px-3 py-1.5 text-[11px] font-semibold text-txt hover:border-line-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">Try again</button></div>}
                {assistantView === "blind" && blindState.status === "empty" && <EmptyPanel title="No qualifying blind picks yet" body="There is not enough matchup evidence for an honest first-pick list." />}
                {blindExclusionNote && assistantView === "blind" && <p className="mb-2 text-[10px] text-mut">{blindExclusionNote}.</p>}
                {assistantView !== "recommended" && (assistantView !== "counters" || enemyIds.length > 0) ? <p className="mb-2 text-[10.5px] text-mut">{assistantView === "blind" ? "Blind Picks emphasize the average win rate across the worst 10% of likely matchup mass." : assistantView === "comfort" ? "Comfort Picks filter the existing ranking to champions you have actually played; they never re-score or reorder it." : "Counters keep only candidates with a positive shrunk matchup delta against the entered enemies."}</p> : null}
              </div>
            </section>

            <section className="rounded-xl border border-line bg-panel p-2.5">
              <div className="grid min-w-0 grid-cols-1 items-center gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
                <label className="min-w-0"><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-mut"><span aria-hidden="true" className="text-[13px] text-teal">◈</span>Min. Pick Rate</span><select value={String(minPickRate)} onChange={(event) => setMinPickRate(Number(event.target.value))} className="w-full rounded-md border border-line bg-panel2 px-2.5 py-2 text-[11px] text-txt outline-none focus:border-teal"><option value="0">0%</option><option value="0.005">0.5%</option><option value="0.01">1.0%</option><option value="0.02">2.0%</option><option value="0.05">5.0%</option></select></label>
                {/* justify-START, not justify-between. `between` pushed the switch
                    to the far edge of its grid cell, where it read as belonging to
                    the "Minimum Games" control beside it rather than to its own
                    label. It must sit next to the thing it toggles. */}
                {/* The knob previously had `absolute top-1` and NO `left`, so it started from
    its static position rather than the track's left edge and the translate
    carried it outside the pill — the "clunky" the user saw. `left-0` anchors
    it; the geometry then works out exactly (36px track, 12px knob, 4px inset
    each end, so the travel is 4px → 20px).
    The whole control is one <button> now, so the label text toggles too — a
    36px hit target beside its own words was needlessly fiddly to hit. */}
<button type="button" role="switch" aria-checked={includeOffMeta} onClick={() => setIncludeOffMeta((value) => !value)} className="flex min-w-0 items-end justify-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"><span><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-mut"><span aria-hidden="true" className="text-[13px] text-teal">✧</span>Include Off-Meta</span><span className="block text-[11px] text-txt">Show niche picks</span></span><span aria-hidden="true" className={`relative mb-0.5 h-5 w-9 flex-shrink-0 rounded-full transition-colors motion-reduce:transition-none ${includeOffMeta ? "bg-teal" : "bg-line"}`}><span className={`absolute left-0 top-1 h-3 w-3 rounded-full bg-txt transition-transform duration-150 motion-reduce:transition-none ${includeOffMeta ? "translate-x-5" : "translate-x-1"}`} /></span></button>
                <label className="min-w-0"><span className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold text-mut"><span aria-hidden="true" className="text-[13px] text-teal">⌁</span>Minimum Games</span><select value={String(minimumGames)} onChange={(event) => setMinimumGames(Number(event.target.value))} className="w-full rounded-md border border-line bg-panel2 px-2.5 py-2 text-[11px] text-txt outline-none focus:border-teal"><option value="0">Any games</option><option value="1000">1,000</option><option value="5000">5,000</option><option value="10000">10,000</option></select></label>
                <button type="button" aria-pressed={filtersExpanded} onClick={() => setFiltersExpanded((value) => !value)} className="flex items-center justify-center gap-1 rounded-md border border-line px-3 py-2 text-[11px] font-semibold text-mut hover:border-line-gold hover:text-txt">⚙ Filters</button>
              </div>
              {filtersExpanded && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-[10px] text-mut"><span>Filters apply to the selected view and never change the server ranking.</span><button type="button" onClick={() => { setMinPickRate(DEFAULT_DRAFT_ASSISTANT_FILTERS.minPickRate); setIncludeOffMeta(DEFAULT_DRAFT_ASSISTANT_FILTERS.includeOffMeta); setMinimumGames(DEFAULT_DRAFT_ASSISTANT_FILTERS.minimumGames); }} className="rounded border border-line px-2 py-1 text-txt hover:border-line-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">Reset filters</button></div>}
            </section>


            <section>
              <div className="grid grid-cols-1 gap-2 border-b border-line pb-2 sm:grid-cols-2 lg:grid-cols-4">
                <p className="text-[10px] leading-4 text-mut"><strong className="text-[10px] tracking-[0.1em] text-txt">WIN RATE</strong><br />Estimated win rate with this pick in this draft.</p>
                <p className="text-[10px] leading-4 text-mut"><strong className="text-[10px] tracking-[0.1em] text-txt">FLOOR</strong><br />Average win rate across the worst 10% of matchups you&apos;re likely to face.</p>
                <p className="text-[10px] leading-4 text-mut"><strong className="text-[10px] tracking-[0.1em] text-txt">PICK RATE</strong><br />How often this champion is played in this role.</p>
                <p className="text-[10px] leading-4 text-mut"><strong className="text-[10px] tracking-[0.1em] text-txt">DIFFICULTY</strong><br />How hard the champion is to master.</p>
              </div>

              <div className="mb-2 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-[12px] font-bold tracking-[0.14em] text-txt">WORST MATCHUPS PREVIEW</h2><p className="mt-1 text-[11px] text-mut">Your top picks vs popular enemy champions</p></div><button type="button" onClick={() => handleAssistantViewChange("counters")} className="text-[10.5px] font-semibold text-teal hover:text-teal-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal">View all matchups →</button></div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {topCards.map((card) => <MatchupPreviewBlock key={card.slot} candidate={card.candidate} preview={card.candidate ? matchupPreviewMap.get(card.candidate.champId) : undefined} champIcons={champIcons} />)}
              </div>
            </section>
          </div>

          <aside className="min-w-0 lg:sticky lg:top-4">
            <DetailedRankings rows={detailRows} cardedRows={cardedRows} laneAverageValue={detailAverage} sort={detailSort} onSortChange={(sort) => { setDetailSort(sort); setShowFullTable(false); }} grid={detailGrid} onGridChange={setDetailGrid} selectedChampionId={selectedDetailChampionId} onSelect={setSelectedDetailChampionId} showAll={showFullTable} onShowAll={() => setShowFullTable(true)} preserveOrder={assistantView === "comfort"} showNoEnemyBlindHint={assistantView === "recommended" && enemyIds.length === 0} />
          </aside>
        </div>

        <footer className="mt-8 border-t border-line pt-4 text-center text-[10.5px] text-mut"><p>Suggestions only — statistical trends, not a recommendation to auto-pick. Never applied to the client automatically.</p><p className="mt-1">Build data © coachless.gg / Riot Games. Not endorsed by Riot Games.</p>{process.env.NEXT_PUBLIC_APP_VERSION && <p className="mt-1">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}</footer>
      </div>
    </div>
  );
}
