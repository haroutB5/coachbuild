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
// TACTICAL RESKIN (2026-07-21, draft-redesign-plan.md) — every state/ref/
// effect/handler below this comment block is preserved BYTE-FOR-BYTE from
// the pre-reskin version (plan §9's highest-risk item: the live-sync effect,
// entryStateRef, the dirty latch, and the debounced/race-guarded fetch must
// survive verbatim). Only the `return` JSX changed: composition into
// EnemyTeamPanel / MyChampionPanel / DraftCompRadar / DraftPicksTable /
// DraftBansTable under a new `.draft-tactical` scoped theme (app/globals.css).
// No pushState/history integration exists on this page (see gotchas (n)/(p))
// and none was added — MatchupAnalysisPopover is rendered inline by
// EnemyTeamPanel, never a routed/portalled surface.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
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
import DraftCompRadar from "@/components/hextech/DraftCompRadar";
import DraftPicksTable from "@/components/hextech/DraftPicksTable";
import DraftBansTable from "@/components/hextech/DraftBansTable";

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

function ResultsSkeleton() {
  return (
    <div className="dt-panel p-5 animate-pulse space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-black/30 flex-shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-2.5 w-24 bg-black/30 rounded" />
            <div className="h-2 w-14 bg-black/30 rounded" />
          </div>
          <div className="h-3 w-10 bg-black/30 rounded flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="dt-panel p-8 text-center">
      <div className="text-[color:var(--dt-txt)] font-semibold mb-1 text-[13.5px]">{title}</div>
      <div className="text-[color:var(--dt-mut)] text-[12px]">{body}</div>
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

  return (
    <div className="draft-tactical min-h-screen pb-16">
      <div className="dt-circuit-bg" aria-hidden="true" />
      <div className="dt-content max-w-[900px] mx-auto px-4 sm:px-6">
        <header className="pt-8 pb-5 border-b border-[color:var(--dt-line)] mb-6">
          <div className="text-center mb-4">
            <h1 className="dt-glow-text text-3xl font-extrabold tracking-tight text-balance">
              <span className="dt-accent-text">Draft</span> Recommender
            </h1>
            <p className="text-[color:var(--dt-mut)] text-sm mt-1">Statistically favored picks and bans for the enemies you&apos;re up against.</p>
            {state.status === "ok" && (
              <p className="text-[color:var(--dt-mut)] text-[11px] mt-1 tabular-nums">
                Patch {state.data.meta.patch || "—"} · {tierLabel(state.data.meta.tier)}
                {state.data.meta.fetchedAt && ` · updated ${formatFetchedAt(state.data.meta.fetchedAt)}`}
              </p>
            )}
            {isStalePatchData && (
              <p className="text-[color:var(--dt-mut)] text-[10px] mt-0.5">
                Patch {state.data.meta.currentPatch} data isn&apos;t ready yet — showing the last available patch (
                {state.data.meta.patch}).
              </p>
            )}
          </div>

          {/* Live-sync status strip — restyled per plan §2.5: a quiet "LIVE"
              pulse while passively syncing, a glowing "UPDATE READY" control
              when the user has gone manual mid a live champ select. Same
              underlying booleans (showResetToLive/liveSyncing) as before the
              reskin — only the markup changed. */}
          {liveSyncing && (
            <div className="flex items-center justify-center gap-2 mb-4">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-[color:var(--dt-cyan)]">
                <span className="dt-node-pulse w-1.5 h-1.5 rounded-full" style={{ background: "var(--dt-cyan)" }} aria-hidden="true" />
                LIVE — syncing from champ select
              </span>
            </div>
          )}

          {showResetToLive && (
            <div role="status" className="flex justify-center mb-4">
              <button
                type="button"
                onClick={handleResetToLive}
                className="dt-chamfer-sm inline-flex items-center gap-2 px-4 py-2 text-[12px] font-bold uppercase tracking-[0.06em] text-black active:scale-95 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--dt-cyan)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--dt-bg)]"
                style={{ background: "var(--dt-cyan)", boxShadow: "0 0 16px var(--dt-cyan-glow)" }}
              >
                Update ready <span aria-hidden="true">⟳</span>
              </button>
            </div>
          )}
        </header>

        {/* Top row: Enemy Team + My Champion */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
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
          />
        </div>

        {/* Team composition radar */}
        <div className="mb-6">
          <DraftCompRadar enemyIds={enemyIds} hoverChampId={hover} />
        </div>

        {/* Results */}
        <section className="mb-8">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-mut)] font-semibold px-0.5">Suggested picks</p>
            {state.status === "ok" && hasAnyMyPoolData && (
              <button
                type="button"
                onClick={() => setMyPoolOnly((v) => !v)}
                aria-pressed={myPoolOnly}
                title="Show only champions you've played this season — a filter, never a re-ranking"
                className={`px-2 py-1 rounded-md text-[10.5px] font-semibold border transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--dt-cyan)] ${
                  myPoolOnly
                    ? "text-black border-[color:var(--dt-cyan)]"
                    : "text-[color:var(--dt-mut)] border-[color:var(--dt-line)] hover:border-[color:var(--dt-cyan-dim)] hover:text-[color:var(--dt-txt)]"
                }`}
                style={myPoolOnly ? { background: "var(--dt-cyan)" } : undefined}
              >
                My pool
              </button>
            )}
          </div>
          {state.status === "ok" && (
            <p className="text-[color:var(--dt-mut)] text-[11px] mb-1 px-0.5">{picksExplainer}</p>
          )}
          {state.status === "ok" && (
            <p className="text-[color:var(--dt-mut)] text-[10.5px] mb-2 px-0.5">
              Only champions with a well-sampled pool this patch in this lane are shown — a rare off-role pick won&apos;t
              out-rank a real lane staple.
            </p>
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
            <p className="text-[color:var(--dt-mut)] text-[11px] px-0.5 py-2">
              No well-sampled (1,000+ game) counters yet for this matchup — see potential counters below.
            </p>
          )}

          {state.status === "ok" && state.data.plays.length > 0 && myPoolOnly && displayedPlays.length === 0 && (
            // My pool filter narrowed a non-empty list down to nothing --
            // distinct from "no data yet" above (the server has data, the
            // filter is just narrow right now).
            <p className="text-[color:var(--dt-mut)] text-[11px] px-0.5 py-2">
              None of your played champions are in this list yet. Toggle &quot;My pool&quot; off to see all suggestions.
            </p>
          )}

          {state.status === "ok" && displayedPlays.length > 0 && (
            <DraftPicksTable plays={displayedPlays} champIcons={champIcons} caption="Suggested picks" />
          )}
        </section>

        {/* Potential counters (v0.37.4) — same scoring as the main list
            above, just under the 1,000-game floor on this specific matchup.
            Only rendered when there's something to show; never conflated
            with the main "Suggested picks" empty/loading states. */}
        {state.status === "ok" && displayedPotentialPlays.length > 0 && (
          <section className="mb-8">
            <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-mut)] font-semibold mb-1 px-0.5">Potential counters</p>
            <p className="text-[color:var(--dt-mut)] text-[10.5px] mb-2 px-0.5">
              Promising but under 1,000 games — treat as leads, not conclusions.
            </p>
            <DraftPicksTable plays={displayedPotentialPlays} champIcons={champIcons} caption="Potential counters" />
          </section>
        )}

        {/* Bans */}
        {hover !== null && state.status === "ok" && state.data.bans && (
          <section className="mb-8">
            <p className="text-[10px] tracking-[0.14em] uppercase text-[color:var(--dt-mut)] font-semibold mb-1 px-0.5">Suggested bans</p>
            <p className="text-[color:var(--dt-mut)] text-[10.5px] mb-2 px-0.5">
              Champions most likely to beat your pick in this lane — ranked by how hard they counter you and how often
              they&apos;re played.
            </p>
            {state.data.bans.length === 0 ? (
              // v0.40.0: bans.length === 0 now specifically means no ban
              // candidate cleared BAN_MIN_MATCHUP_GAMES (1000 games vs your
              // pick) -- never a fabricated/low-sample ban, per user
              // directive. Copy reflects that precisely rather than the old
              // generic "nothing stands out."
              <EmptyPanel
                title="No well-sampled counters"
                body="No well-sampled counters to your pick this patch — check back as more games are recorded."
              />
            ) : (
              <DraftBansTable bans={state.data.bans} champIcons={champIcons} />
            )}
          </section>
        )}

        <footer className="mt-10 pt-4 border-t border-[color:var(--dt-line)] text-center text-[11px] text-[color:var(--dt-mut)] space-y-1">
          <p>Suggestions only — statistical trends, not a recommendation to auto-pick. Never applied to the client automatically.</p>
          <p>Build data © coachless.gg / Riot Games. Not endorsed by Riot Games.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-[color:var(--dt-mut)]">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
