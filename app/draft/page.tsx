"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /draft — "Draft" recommender (plan §6a/§6c). Standalone shell page, same
// convention as /movers and /live-setup (not the two-Sidebar main layout —
// this is an auxiliary surface, reachable from Sidebar's "Draft" link).
//
// Compliance (plan §7 — enforced structurally, not just by copy choice):
// this file NEVER imports applyRunes/applyItemSets/any companion POST, and
// only ever reads championId/name/icon — never a summoner/riotId field.
// Copy is framed as suggestions ("statistically favored"), never "pick this."
//
// Live mode: consumes CompanionProvider READ-ONLY via useCompanion() (plan
// §6c) — auto-fills lane/enemies/hover from champ select through
// draftLiveSync.ts's pure resolveDraftLiveTarget, but a manual edit always
// wins until "Reset to live" (the dirty latch — see the live-sync effect
// below). No companion at all is simply the quiet default; nothing here
// nags the user to connect one (manual-first UX, plan §6a).
//
// GOLD RESKIN (v0.51.0, CoachBuild redesign wave — mockup 3): every state/
// ref/effect/handler below this comment block is preserved BYTE-FOR-BYTE from
// the pre-reskin version (the highest-risk item: the live-sync effect,
// entryStateRef, the dirty latch, and the debounced/race-guarded fetch must
// survive verbatim). Only the `return` JSX changed: the retired cyan
// `.draft-tactical`/`.dt-*` HUD theme (app/globals.css) is gone — this page
// now uses the app-wide navy/gold tokens, same as Builds — and DraftCompRadar
// is replaced by DraftCompBars (6 horizontal bars, mockup 3's "ENEMY COMP
// PROFILE" card) and DraftBansTable's row rendering is absorbed into
// MyChampionPanel (mockup 3 shows ban suggestions inline in that card, not a
// separate page section). No pushState/history integration exists on this
// page (see gotchas (n)/(p)) and none was added — MatchupAnalysisPopover is
// rendered inline by EnemyTeamPanel, never a routed/portalled surface.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { LANE_TO_ROLE_ID, LANE_LABEL, type LaneId } from "@/components/hextech/heroContracts";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
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
import { filterToMyPool } from "@/components/live/personalBadge";
import EnemyTeamPanel from "@/components/hextech/EnemyTeamPanel";
import MyChampionPanel from "@/components/hextech/MyChampionPanel";
import DraftCompBars from "@/components/hextech/DraftCompBars";
import DraftPicksTable from "@/components/hextech/DraftPicksTable";
import BlindPickTable from "@/components/hextech/BlindPickTable";
import type { BlindPickResult } from "@/lib/draft/blindPick";

const RECOMMEND_DEBOUNCE_MS = 300;

const TIER_LABEL: Record<number, string> = { 10: "Emerald+" };
function tierLabel(tier: number): string {
  return TIER_LABEL[tier] ?? (tier ? `Tier ${tier}` : "—");
}

function formatFetchedAt(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

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
    excludedByMassGate: number;
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
    ![meta.poolCandidates, meta.qualifiedCandidates, meta.excludedByMassGate, meta.returnedCandidates, meta.topN].every(
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
      excludedByMassGate: meta.excludedByMassGate,
      returnedCandidates: meta.returnedCandidates,
      topN: meta.topN,
    },
    pending: body.pending === true,
  };
}

function ResultsSkeleton() {
  return (
    <div className="bg-panel border border-line rounded-xl p-5 animate-pulse space-y-3">
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

  // Plain-language explainer (user request 2026-07-21) — what "Suggested
  // picks" actually MEANS, adapting to whether enemies / a lane opponent are
  // in play. Kept to one muted line.
  const laneOppName =
    effectiveLaneOpponentId !== null ? champIcons.get(effectiveLaneOpponentId)?.name ?? null : null;
  const picksExplainer =
    enemyIds.length === 0
      ? "Each champion's own win rate in this lane on the current patch."
      : laneOppName
        ? `Win rate in this lane, adjusted by matchup records against the enemy team — weighted heaviest against your lane opponent (${laneOppName}).`
        : "Win rate in this lane, adjusted by each champion's matchup records against the enemies you've added.";

  // The sample-size note has to adapt for the same reason picksExplainer does
  // (P1 fix, 2026-07-26). The 5,000-game pool floor is unconditional — it gates
  // on `totalGames` via filterPoolByTotalGames in either mode, so that sentence
  // stays true throughout. What changes is the GAMES COLUMN: once a lane
  // opponent resolves, draftPicksModel switches it to
  // `winVsLaneOppGames ?? minGames`, i.e. games against THAT opponent rather
  // than total lane games. The old static copy pointed at the column as the
  // trust signal while the column had quietly changed population underneath it
  // — live repro was "#1 Swain, GAMES 1568" sitting directly under a sentence
  // promising 5,000+, when Swain's real mid sample is ~22,639. The number was
  // never wrong; the label described a different population than the one shown.
  const picksSampleNote =
    laneOppName !== null
      ? `Champions still need 5,000+ games in this lane this patch to appear, which filters out one-trick noise. Within that, ranking is by win rate — so a genuinely strong niche pick can sit above a popular staple. The games column now counts games against ${laneOppName} specifically, not total lane games, so expect much smaller numbers than that floor.`
      : "Champions need 5,000+ games in this lane this patch to appear, which filters out one-trick noise. Within that, ranking is by win rate — so a genuinely strong niche pick can sit above a popular staple. Check the games column before you trust a name you don't recognise here.";

  // My pool filter — applied to a DISPLAY copy only; state.data.plays/
  // potentialPlays (and their order) are never mutated, so toggling this off
  // always restores the exact server-ranked list.
  const basePlays: DraftPlayResult[] = state.status === "ok" ? state.data.plays : [];
  const basePotentialPlays: DraftPlayResult[] = state.status === "ok" ? state.data.potentialPlays : [];
  const displayedPlays = myPoolOnly ? filterToMyPool(basePlays) : basePlays;
  const displayedPotentialPlays = myPoolOnly ? filterToMyPool(basePotentialPlays) : basePotentialPlays;
  const hasAnyMyPoolData = basePlays.some((p) => p.personalOverall.games >= 1) || basePotentialPlays.some((p) => p.personalOverall.games >= 1);

  // enemyAnalysis (plan §2.3/§4) — engo's Stage 0 field on
  // DraftRecommendResponse, always [] (never undefined) once normalized.
  const enemyAnalysisRaw = state.status === "ok" ? state.data.enemyAnalysis : undefined;

  const bans = state.status === "ok" ? state.data.bans ?? [] : [];

  return (
    <div className="px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-[1440px] mx-auto">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 mb-6">
          <div>
            {/* Sans, matching PageHeader on every other route — the display face is for
                champion names, not page titles. */}
            <h1 className="text-[22px] sm:text-2xl font-extrabold tracking-[-0.02em] text-txt">Draft</h1>
            <p className="text-mut text-[12.5px] mt-0.5">Statistically favored picks &amp; bans vs the enemy comp.</p>
          </div>
          {state.status === "ok" && (
            <div className="text-right text-[11px] text-mut tabular-nums pt-1">
              Patch {state.data.meta.patch || "—"} · {tierLabel(state.data.meta.tier)}
              {state.data.meta.fetchedAt && ` · Upd ${formatFetchedAt(state.data.meta.fetchedAt)}`}
              {isStalePatchData && (
                <p className="text-[10px] mt-0.5 normal-case">
                  Patch {state.data.meta.currentPatch} data isn&apos;t ready yet — showing patch {state.data.meta.patch}.
                </p>
              )}
              {/* 2026-07-31 audit P2 (#2) — makes a real, previously-silent
                  ingest failure visible instead of only a rotating local log
                  file. Independent of the stale-patch notice above (see
                  isIngestUnhealthy's doc comment). */}
              {isIngestUnhealthy && (
                <p className="text-[10px] mt-0.5 normal-case text-bad/80" title={state.data.meta.ingestLastError ?? undefined}>
                  Last data refresh hit an error — this may be showing older data than usual.
                </p>
              )}
            </div>
          )}
        </header>

        {/* Live-sync status strip — a quiet "LIVE" pulse while passively
            syncing, a gold "UPDATE READY" control when the user has gone
            manual mid a live champ select. Same underlying booleans
            (showResetToLive/liveSyncing) as before the reskin — only the
            markup/tokens changed. */}
        {liveSyncing && (
          <div className="flex items-center gap-2 mb-4">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-teal">
              <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse" aria-hidden="true" />
              Live — syncing from champ select
            </span>
          </div>
        )}

        {showResetToLive && (
          <div role="status" className="mb-4">
            <button
              type="button"
              onClick={handleResetToLive}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[12px] font-bold uppercase tracking-[0.06em] text-bg bg-teal hover:bg-teal-hover active:scale-95 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
            >
              Update ready <span aria-hidden="true">⟳</span>
            </button>
          </div>
        )}

        {/* v0.51.0 (mockup 3): two-column layout — LEFT: Enemy Team then My
            Champion (bans rendered inline inside it); RIGHT: Enemy Comp
            Profile then Suggested Picks. Mobile (`grid-cols-1`) stacks in DOM
            order: enemy team → my champion → comp bars → picks. */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-5">
            <EnemyTeamPanel
              enemyIds={enemyIds}
              champIcons={champIcons}
              effectiveLaneOpponentId={effectiveLaneOpponentId}
              laneOpponentId={laneOpponentId}
              serverInferredLaneOpponentId={serverInferredLaneOpponentId}
              onAddEnemy={handleAddEnemy}
              onRemoveEnemy={handleRemoveEnemy}
              onToggleLaneOpponent={handleToggleLaneOpponent}
              enemyAnalysis={enemyAnalysisRaw}
              hoverSelected={hover !== null}
            />
            <MyChampionPanel
              lane={lane}
              onLaneChange={handleLaneChange}
              hoverChamp={hoverChamp}
              onHoverChange={handleHoverChange}
              onClearHover={handleClearHover}
              autoDetected={liveSyncing}
              bans={bans}
              champIcons={champIcons}
            />
          </div>

          <div className="space-y-5">
            <DraftCompBars enemyIds={enemyIds} />

            <section>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold px-0.5">
                  Suggested Picks — {LANE_LABEL[lane]}
                </p>
                {state.status === "ok" && hasAnyMyPoolData && (
                  <button
                    type="button"
                    onClick={() => setMyPoolOnly((v) => !v)}
                    aria-pressed={myPoolOnly}
                    title="Show only champions you've played this season — a filter, never a re-ranking"
                    className={`px-2 py-1 rounded-md text-[10.5px] font-semibold border transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal ${
                      myPoolOnly ? "text-bg bg-teal border-teal" : "text-mut border-line hover:border-line-gold hover:text-txt"
                    }`}
                  >
                    My pool
                  </button>
                )}
              </div>
              {state.status === "ok" && <p className="text-mut text-[11px] mb-1 px-0.5">{picksExplainer}</p>}
              {state.status === "ok" && (
                <p className="text-mut text-[10.5px] mb-2 px-0.5">{picksSampleNote}</p>
              )}

              {state.status === "loading" && <ResultsSkeleton />}

              {state.status === "pending" && (
                <EmptyPanel
                  title="Draft data being prepared"
                  body={`Patch ${state.meta?.patch || "the current"} data is still being ingested — check back shortly.`}
                />
              )}

              {state.status === "error" && (
                <EmptyPanel title="Couldn't load — try again" body="Something went wrong fetching draft recommendations." />
              )}

              {state.status === "empty" && (
                <EmptyPanel title="No data yet for this lane" body="Try a different lane, or add fewer/different enemies." />
              )}

              {state.status === "ok" && state.data.plays.length === 0 && state.data.potentialPlays.length > 0 && (
                // v0.37.4: a laneOpp is resolved but nothing cleared the
                // 1,000-game main-list floor yet -- real data exists (below,
                // in Potential counters), so this is NOT the "empty" state.
                <p className="text-mut text-[11px] px-0.5 py-2">
                  No well-sampled (1,000+ game) counters yet for this matchup — see potential counters below.
                </p>
              )}

              {state.status === "ok" && state.data.plays.length > 0 && myPoolOnly && displayedPlays.length === 0 && (
                // My pool filter narrowed a non-empty list down to nothing --
                // distinct from "no data yet" above (the server has data, the
                // filter is just narrow right now).
                <p className="text-mut text-[11px] px-0.5 py-2">
                  None of your played champions are in this list yet. Toggle &quot;My pool&quot; off to see all suggestions.
                </p>
              )}

              {state.status === "ok" && displayedPlays.length > 0 && (
                <DraftPicksTable plays={displayedPlays} champIcons={champIcons} caption="Suggested picks" />
              )}
            </section>

            {/* Potential counters (v0.37.4) — same scoring as the main list
                above, just under the 1,000-game floor on this specific
                matchup. Only rendered when there's something to show; never
                conflated with the main "Suggested picks" empty/loading
                states. */}
            {state.status === "ok" && displayedPotentialPlays.length > 0 && (
              <section>
                <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-1 px-0.5">Potential counters</p>
                <p className="text-mut text-[10.5px] mb-2 px-0.5">
                  Promising but under 1,000 games — treat as leads, not conclusions.
                </p>
                <DraftPicksTable plays={displayedPotentialPlays} champIcons={champIcons} caption="Potential counters" />
              </section>
            )}

            <section>
              <div className="flex items-center justify-between gap-2 mb-1">
                <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold px-0.5">Blind Pick</p>
                {blindState.status !== "loading" && blindState.status !== "error" && (
                  <div className="text-[10px] text-mut tabular-nums">
                    Patch {blindState.data.meta.patch ?? "—"}
                    {blindState.data.meta.fetchedAt && ` · Upd ${formatFetchedAt(blindState.data.meta.fetchedAt)}`}
                  </div>
                )}
              </div>
              {/* REWRITTEN after the 2026-08-01 audit measured what this list
                  can actually distinguish. The old copy promised an order that
                  "can differ from Suggested Picks"; in fact Spearman against
                  plain win rate is 0.974 and 8 of the top 10 names are shared
                  with the table directly above. A reader who was told to expect
                  a different order and sees the same first three champions reads
                  that as broken, not as insight.
                  What the feature genuinely adds is the FLOOR column — Singed
                  50.2% vs Heimerdinger 47.2% is a real three-point gap that win
                  rate alone cannot show. So the copy leads with FLOOR, states
                  the ordering is close on purpose, and says where it stops being
                  meaningful (rank 10 and rank 11 differ by 0.00027). */}
              <p className="text-mut text-[11px] mb-1 px-0.5">
                Champions you can first-pick before seeing your lane opponent. Ranked by win rate with a penalty for a bad
                worst case, so the order stays close to Suggested Picks — the column that adds something is{" "}
                <span className="text-txt font-semibold">Floor</span>, your win rate in the 10% of matchups that go worst.
                Two champions with the same win rate can differ by three points there. Below the top few the scores are
                near-identical, so read the floor, not the rank.
              </p>

              {blindState.status === "loading" && <BlindPickSkeleton />}

              {blindState.status === "pending" && (
                <EmptyPanel
                  title="Blind-pick data being prepared"
                  body={`Patch ${blindState.data.meta.patch ?? "the current"} has no complete matchup matrix for this lane yet — check back shortly.`}
                />
              )}

              {blindState.status === "error" && (
                <div className="bg-panel border border-line rounded-xl p-8 text-center">
                  <p className="text-txt text-[12.5px] font-semibold">Couldn&apos;t load blind picks</p>
                  <p className="text-mut text-[11px] mt-1">Something went wrong fetching first-pick safety rankings.</p>
                  <button
                    type="button"
                    onClick={() => setBlindRetry((n) => n + 1)}
                    className="mt-3 px-3 py-1.5 rounded-md border border-line text-[11px] font-semibold text-txt transition-colors motion-reduce:transition-none hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal"
                  >
                    Try again
                  </button>
                </div>
              )}

              {blindState.status === "empty" && (
                <EmptyPanel
                  title="No qualifying blind picks yet"
                  body={
                    blindState.data.meta.excludedByMassGate > 0
                      ? "The available champions do not yet have enough well-sampled opponent mass for an honest published list."
                      : "There is not enough matchup data for this lane to publish a first-pick list."
                  }
                />
              )}

              {(blindState.status === "ok" || blindState.status === "empty") && blindState.data.meta.excludedByMassGate > 0 && (
                <p className="text-mut text-[10.5px] mt-2 px-0.5">
                  {blindState.data.meta.excludedByMassGate} of {blindState.data.meta.poolCandidates} pool champions excluded: less than 90% of their opponent mass is backed by 30+ game cells.
                </p>
              )}

              {blindState.status === "ok" && <BlindPickTable picks={blindState.data.picks} champIcons={champIcons} />}
            </section>
          </div>
        </div>

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Suggestions only — statistical trends, not a recommendation to auto-pick. Never applied to the client automatically.</p>
          <p>Build data © coachless.gg / Riot Games. Not endorsed by Riot Games.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
