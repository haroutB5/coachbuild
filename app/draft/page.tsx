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
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import ChampionPicker from "@/components/ChampionPicker";
import TabNav from "@/components/TabNav";
import LaneFilterPills from "@/components/hextech/LaneFilterPills";
import DraftResultRow from "@/components/hextech/DraftResultRow";
import { LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { useCompanion } from "@/components/live/CompanionProvider";
import { resolveDraftLiveTarget, shouldShowResetToLive, MAX_DRAFT_ENEMIES } from "@/components/live/draftLiveSync";
import {
  fetchDraftRecommend,
  type DraftRecommendResponse,
  type DraftRecommendMeta,
  type DraftPlayResult,
} from "@/components/live/draftRecommend";
import { filterToMyPool } from "@/components/live/personalBadge";

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

export default function DraftPage() {
  const companion = useCompanion();

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

  // My pool filter — applied to a DISPLAY copy only; state.data.plays/
  // potentialPlays (and their order) are never mutated, so toggling this off
  // always restores the exact server-ranked list.
  const basePlays: DraftPlayResult[] = state.status === "ok" ? state.data.plays : [];
  const basePotentialPlays: DraftPlayResult[] = state.status === "ok" ? state.data.potentialPlays : [];
  const displayedPlays = myPoolOnly ? filterToMyPool(basePlays) : basePlays;
  const displayedPotentialPlays = myPoolOnly ? filterToMyPool(basePotentialPlays) : basePotentialPlays;
  const hasAnyMyPoolData = basePlays.some((p) => p.personalOverall.games >= 1) || basePotentialPlays.some((p) => p.personalOverall.games >= 1);

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[720px] mx-auto px-4 sm:px-6">
        <header className="pt-8 pb-5 border-b border-line mb-6">
          <TabNav />

          <div className="text-center mb-4">
            <h1 className="text-3xl font-extrabold tracking-tight text-balance">
              <span className="text-teal">Draft</span> Recommender
            </h1>
            <p className="text-mut text-sm mt-1">Statistically favored picks and bans for the enemies you&apos;re up against.</p>
            {state.status === "ok" && (
              <p className="text-mut/70 text-[11px] mt-1 tabular-nums">
                Patch {state.data.meta.patch || "—"} · {tierLabel(state.data.meta.tier)}
                {state.data.meta.fetchedAt && ` · updated ${formatFetchedAt(state.data.meta.fetchedAt)}`}
              </p>
            )}
            {isStalePatchData && (
              <p className="text-mut/60 text-[10px] mt-0.5">
                Patch {state.data.meta.currentPatch} data isn&apos;t ready yet — showing the last available patch (
                {state.data.meta.patch}).
              </p>
            )}
          </div>

          {/* Live-sync status strip — quiet, never a nag when there's no
              companion at all (manual is the default experience). */}
          {(liveSyncing || showResetToLive) && (
            <div className="flex items-center justify-center gap-2 mb-4">
              {liveSyncing && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-teal-dim">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse" aria-hidden="true" />
                  Syncing from champ select
                </span>
              )}
              {showResetToLive && (
                <button
                  type="button"
                  onClick={handleResetToLive}
                  className="text-[11px] font-semibold text-teal hover:text-teal-hover underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded"
                >
                  Reset to live
                </button>
              )}
            </div>
          )}

          <div className="flex justify-center">
            <LaneFilterPills value={lane} onChange={handleLaneChange} />
          </div>
        </header>

        {/* Enemies */}
        <section className="mb-6">
          <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-0.5">
            Enemies ({enemyIds.length}/{MAX_DRAFT_ENEMIES})
          </p>
          {enemyIds.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2.5">
              {enemyIds.map((id) => {
                const entry = champIcons.get(id);
                // audit P2-1: highlight reflects the user's own explicit tag
                // when set, else the server's statistical inference — never
                // a client-side index guess (see effectiveLaneOpponentId above).
                const isLaneOpp = effectiveLaneOpponentId === id;
                const isServerInferredOnly = laneOpponentId === null && serverInferredLaneOpponentId === id;
                return (
                  <div
                    key={id}
                    className={`flex items-center gap-1.5 pl-1.5 pr-1 py-1 rounded-lg border text-[12px] ${
                      isLaneOpp ? "bg-teal/12 border-line-gold" : "bg-panel2 border-line"
                    }`}
                  >
                    <span className="w-5 h-5 rounded overflow-hidden bg-black/30 flex-shrink-0">
                      {entry?.icon && (
                        <img src={entry.icon} alt="" width={20} height={20} loading="lazy" decoding="async" className="w-full h-full object-cover" />
                      )}
                    </span>
                    <span className="text-txt font-medium">{entry?.name ?? `#${id}`}</span>
                    <button
                      type="button"
                      onClick={() => handleToggleLaneOpponent(id)}
                      aria-pressed={isLaneOpp}
                      title={isServerInferredOnly ? "Server-inferred lane opponent — tap to set explicitly" : "Flag as lane opponent"}
                      className={`ml-0.5 px-1.5 py-0.5 rounded text-[9.5px] font-bold uppercase tracking-[0.04em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal ${
                        isLaneOpp ? "bg-teal text-bg" : "bg-transparent text-mut hover:text-txt"
                      }`}
                    >
                      Lane opp{isServerInferredOnly ? " (inferred)" : ""}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveEnemy(id)}
                      aria-label={`Remove ${entry?.name ?? "champion"}`}
                      className="ml-0.5 w-5 h-5 flex items-center justify-center rounded text-mut hover:text-bad hover:bg-bad/10 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {enemyIds.length < MAX_DRAFT_ENEMIES && (
            <ChampionPicker value={null} onChange={handleAddEnemy} />
          )}
        </section>

        {/* Hover-your-champ (unlocks Bans) */}
        <section className="mb-6">
          <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-2 px-0.5">
            Your champion <span className="normal-case text-mut/70">(for ban suggestions)</span>
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <ChampionPicker value={hoverChamp} onChange={handleHoverChange} />
            </div>
            {hover !== null && (
              <button
                type="button"
                onClick={handleClearHover}
                className="text-[11px] text-mut hover:text-txt underline decoration-dotted underline-offset-2 flex-shrink-0"
              >
                Clear
              </button>
            )}
          </div>
        </section>

        {/* Results */}
        <section className="mb-8">
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold px-0.5">Suggested picks</p>
            {state.status === "ok" && hasAnyMyPoolData && (
              <button
                type="button"
                onClick={() => setMyPoolOnly((v) => !v)}
                aria-pressed={myPoolOnly}
                title="Show only champions you've played this season — a filter, never a re-ranking"
                className={`px-2 py-1 rounded-md text-[10.5px] font-semibold border transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
                  myPoolOnly ? "bg-teal text-bg border-teal" : "bg-panel2 text-mut border-line hover:border-teal-dim hover:text-txt"
                }`}
              >
                My pool
              </button>
            )}
          </div>
          {state.status === "ok" && (
            <p className="text-mut/70 text-[10.5px] mb-2 px-0.5">
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
            <EmptyPanel
              title="No data yet for this lane"
              body="Try a different lane, or add fewer/different enemies."
            />
          )}

          {state.status === "ok" && state.data.plays.length === 0 && state.data.potentialPlays.length > 0 && (
            // v0.37.4: a laneOpp is resolved but nothing cleared the
            // 1,000-game main-list floor yet -- real data exists (below,
            // in Potential counters), so this is NOT the "empty" state.
            <p className="text-mut/70 text-[11px] px-0.5 py-2">
              No well-sampled (1,000+ game) counters yet for this matchup — see potential counters below.
            </p>
          )}

          {state.status === "ok" && state.data.plays.length > 0 && myPoolOnly && displayedPlays.length === 0 && (
            // My pool filter narrowed a non-empty list down to nothing --
            // distinct from "no data yet" above (the server has data, the
            // filter is just narrow right now).
            <p className="text-mut/70 text-[11px] px-0.5 py-2">
              None of your played champions are in this list yet. Toggle &quot;My pool&quot; off to see all suggestions.
            </p>
          )}

          {state.status === "ok" && displayedPlays.length > 0 && (
            <div className="bg-panel border border-line rounded-xl px-5">
              {displayedPlays.map((play, i) => {
                const entry = champIcons.get(play.champId);
                return (
                  <DraftResultRow
                    key={play.champId}
                    rank={i + 1}
                    championName={entry?.name ?? `Champion #${play.champId}`}
                    championIcon={entry?.icon ?? ""}
                    scoreFraction={play.score}
                    winVsLaneOppFraction={play.winVsLaneOpp}
                    confidence={play.confidence}
                    minGames={play.winVsLaneOppGames ?? play.minGames}
                    personal={play.personal}
                    personalOverall={play.personalOverall}
                  />
                );
              })}
            </div>
          )}
        </section>

        {/* Potential counters (v0.37.4) — same scoring as the main list
            above, just under the 1,000-game floor on this specific matchup.
            Only rendered when there's something to show; never conflated
            with the main "Suggested picks" empty/loading states. */}
        {state.status === "ok" && displayedPotentialPlays.length > 0 && (
          <section className="mb-8">
            <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-1 px-0.5">Potential counters</p>
            <p className="text-mut/70 text-[10.5px] mb-2 px-0.5">
              Promising but under 1,000 games — treat as leads, not conclusions.
            </p>
            <div className="bg-panel border border-line rounded-xl px-5">
              {displayedPotentialPlays.map((play, i) => {
                const entry = champIcons.get(play.champId);
                return (
                  <DraftResultRow
                    key={play.champId}
                    rank={i + 1}
                    championName={entry?.name ?? `Champion #${play.champId}`}
                    championIcon={entry?.icon ?? ""}
                    scoreFraction={play.score}
                    winVsLaneOppFraction={play.winVsLaneOpp}
                    confidence={play.confidence}
                    minGames={play.winVsLaneOppGames ?? play.minGames}
                    personal={play.personal}
                    personalOverall={play.personalOverall}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Bans */}
        {hover !== null && state.status === "ok" && state.data.bans && (
          <section className="mb-8">
            <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold mb-1 px-0.5">Suggested bans</p>
            <p className="text-mut/70 text-[10.5px] mb-2 px-0.5">Bans that counter your pick in your lane.</p>
            {state.data.bans.length === 0 ? (
              <EmptyPanel title="No strong bans identified" body="Nothing stands out as a high-priority ban for this matchup yet." />
            ) : (
              <div className="bg-panel border border-line rounded-xl px-5">
                {state.data.bans.map((ban, i) => {
                  const entry = champIcons.get(ban.champId);
                  return (
                    <DraftResultRow
                      key={ban.champId}
                      rank={i + 1}
                      championName={entry?.name ?? `Champion #${ban.champId}`}
                      championIcon={entry?.icon ?? ""}
                      scoreFraction={ban.score}
                      winVsLaneOppFraction={null}
                      confidence={ban.confidence}
                      minGames={ban.minGames}
                      variant="ban"
                    />
                  );
                })}
              </div>
            )}
          </section>
        )}

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Suggestions only — statistical trends, not a recommendation to auto-pick. Never applied to the client automatically.</p>
          <p>Build data © coachless.gg / Riot Games. Not endorsed by Riot Games.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
