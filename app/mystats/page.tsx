"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /mystats — "My Stats" personal match tracker (backend by engy, 2026-07-21 —
// see HANDOFF.md's "My Stats" entries + lib/mystats/**). v0.51 wave B:
// rebuilt around StatTiles/RecentGamesList/ChampionPoolCard (mockup 6.png),
// consuming the EXTENDED /api/mystats/summary (buildAdherencePct,
// winrateOnBuild, winrateOffBuild, priorSplitWinrate, recentGames[]) engo is
// adding concurrently in myStats.ts's normalizer. Every extended field is
// read through MyStatsSummaryExtended (declared locally below, NOT added to
// myStats.ts itself — that file is engo's pure-.ts contract territory this
// wave) and defaults to null/[] when absent, so this page renders correctly
// whether or not that normalizer update has landed yet in the working tree.
//
// HARD USER DIRECTIVES this page must honor:
//  (1) DISPLAY ONLY — this data never feeds any score/ranking anywhere.
//  (2) CURRENT SEASON ONLY — the "Season 2026" label is shown wherever
//      personal stats render.
//
// Both /api/mystats/* routes are `no-store` unconditionally (private
// per-user data) — fetched client-side only, no server-side caching
// surprises possible even by accident.
//
// 2026-07-29 REDESIGN. The page now opens with a HeroBand (main champion's
// splash art behind a scrim, portrait with an accent ring, Riot ID large,
// season/W-L as pill badges) followed by a hairline-separated KpiStrip — the
// SAME two components the Builds page's FeaturedOtpCard uses, which is what
// makes the two surfaces read as one product rather than two apps.
//
// The one rule this layout must never break: the KPI strip and the champion
// pool are SEASON totals (summed over `records[]`), while the recent-games
// panel is a short recent window (`recentGames[]`). CoachBuild has already
// shipped a production bug from those two denominators drifting (v0.73.1), so
// each panel states its own sample in its own heading and no number crosses
// between them.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import MyStatsRefresher from "@/components/hextech/MyStatsRefresher";
import HeroBand, { Pill } from "@/components/hextech/HeroBand";
import PanelHeading from "@/components/hextech/PanelHeading";
import StatTiles from "@/components/hextech/mystats/StatTiles";
import AccountPicker from "@/components/hextech/mystats/AccountPicker";
import RecentGamesList, { type RecentGameRow } from "@/components/hextech/mystats/RecentGamesList";
import ChampionPoolCard from "@/components/hextech/mystats/ChampionPoolCard";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import type { AccountSummary } from "@/components/live/mystatsAccount";
import {
  fetchMyStatsSummary,
  fetchMyStatsMatchups,
  buildMyStatsRows,
  buildMyStatsMatchupRows,
  computeMyStatsOverall,
  computeMainChampion,
  computeHistoryCoverage,
  type MyStatsSummary,
  type MyStatsChampionRow,
  type MyStatsMatchupRow,
} from "@/components/hextech/myStats";

// ── v0.51 wave-B extended wire contract (declared here, not in myStats.ts —
// see header comment above) ─────────────────────────────────────────────────
interface MyStatsSummaryExtended extends MyStatsSummary {
  buildAdherencePct?: number | null;
  winrateOnBuild?: number | null;
  winrateOffBuild?: number | null;
  priorSplitWinrate?: number | null;
  recentGames?: RecentGameRow[];
  /** v0.74 — the row counts BEHIND winrateOnBuild/winrateOffBuild
   *  (lib/mystats/aggregate.ts -> the summary route -> normalizeMyStatsSummary).
   *  Same optional pattern as the five above, for the same TS2430 reason.
   *  These are what let `computeBuildWinrateDelta` return `comparable: true` on
   *  a real load — without them it answers "sample-unknown" forever, which is
   *  the state this field pair was added to end. Pass BOTH to StatTiles. */
  nOnBuild?: number | null;
  nOffBuild?: number | null;
  /** 2026-07-30 — false when a refresh run was cut off by its Riot-call budget
   *  before it finished walking this account's season, i.e. every figure below is
   *  over a PARTIAL history. Null/absent means the response did not say. Read only
   *  through computeHistoryCoverage, never branched on directly here — see
   *  StillSyncingCallout and the `coverage` prop on StatTiles. */
  historyComplete?: boolean | null;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

type SummaryState = { status: "loading" } | { status: "error" } | { status: "ok"; summary: MyStatsSummaryExtended };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "empty" }
  | { status: "ok"; matchups: MyStatsMatchupRow[] };

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="bg-panel border border-line rounded-xl p-8 text-center">
      <div className="text-txt font-semibold mb-1 text-[13.5px]">{title}</div>
      <div className="text-mut text-[12px]">{body}</div>
    </div>
  );
}

/**
 * The stronger form of the "still syncing" signal, for an account whose stored
 * history is at or below one truncated run's yield (MYSTATS_THIN_HISTORY_GAMES).
 *
 * "Still collecting" reads very differently at 20 games than at 900, and the chip
 * on the hero is not enough at 20: a brand-new account's win rate can be a coin
 * flip over a handful of games while looking exactly as authoritative as a
 * 900-game one. This is the same move `FeaturedOtpCard` makes below its own
 * sample floor — say plainly that we are still collecting, and quote only the
 * number we actually hold.
 *
 * It differs from that precedent in one way, deliberately: the OTP card can say
 * "N of the 12 needed" because 12 is a known floor. Here there is NO known
 * denominator — that is the whole reason `historyComplete` is a flag rather than a
 * count — so this says how many games it has and how they grow, and never
 * pretends to a percentage of a total nothing knows.
 *
 * Sits ABOVE the KPI strip in DOM order, so it is read (and heard) before the
 * figures it qualifies. Fixed content, no animation — nothing here to reduce for
 * prefers-reduced-motion.
 */
function StillSyncingCallout({ games }: { games: number }) {
  return (
    <div className="bg-panel border border-line rounded-xl px-4 py-3 sm:px-5 flex items-start gap-3">
      <span
        aria-hidden="true"
        className="mt-[5px] w-1.5 h-1.5 rounded-full bg-teal/80 flex-shrink-0 shadow-[0_0_0_3px_rgba(64,180,170,0.14)]"
      />
      <p className="text-[12px] text-mut leading-relaxed">
        <span className="text-txt font-semibold">Still collecting your games.</span> We hold{" "}
        <span className="text-txt tabular-nums">{games}</span> so far, and each refresh reaches further
        back. Everything below is worked out over those {games} games — read the rates as an early
        sketch, not your season.
      </p>
    </div>
  );
}

/** Renders at the FINAL dimensions of the real KPI strip (3 cells, value +
 *  2-line label + delta row) so swapping in real numbers costs no layout
 *  shift. */
function TilesSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-px bg-line rounded-xl overflow-hidden border border-line animate-pulse">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-panel2/70 px-2.5 sm:px-4 py-3 sm:py-3.5">
          <div className="h-[21px] sm:h-[26px] w-14 bg-panel2 rounded" />
          <div className="mt-1.5 h-2 w-16 max-w-full bg-panel2 rounded" />
          <div className="mt-1.5 h-[17px] w-12 bg-panel2 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * The ddragon champion KEY ("Ahri", "MonkeyKing") pulled back out of the icon
 * URL /api/champions already returned.
 *
 * `getChampionIconMap()` (components/proAssets.ts) keeps only {name, icon} per
 * champion, and `key` is what lib/splash.ts needs. Both icon URL shapes this
 * app produces end in the key: the coachless CDN's
 * ".../img/champion/Ahri.webp" and the ddragon gap-fill's
 * ".../img/champion/Ahri.png" (lib/staticData.ts's ICON_BASES.champ /
 * DDRAGON_CHAMPION_ICON). Widening ChampionIconEntry itself would mean editing
 * proAssets.ts, which is outside this wave's file split — and an unparseable
 * URL simply returns null here, which renders the hero without splash art
 * rather than with the wrong champion's.
 */
function championKeyFromIconUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/champion\/([^/?#]+)\.(?:webp|png|jpg)(?:[?#]|$)/);
  return m ? m[1] : null;
}

export default function MyStatsPage() {
  const [champIcons, setChampIcons] = useState<Map<number, ChampionIconEntry>>(new Map());
  const [state, setState] = useState<SummaryState>({ status: "loading" });
  // Keyed on (championId, role), not championId alone -- a champion played in
  // multiple lanes (e.g. Viktor Mid AND Top) previously shared one bare-id
  // key, so clicking one row expanded every row for that champion at once and
  // their `detailId`s collided. See toggleRow/isRowExpanded below.
  const [expanded, setExpanded] = useState<{ championId: number; role: number } | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  // v0.50.0: bumped by MyStatsRefresher's onRefreshed when the on-demand
  // incremental ingest actually found new games. v0.83: ALSO bumped by an
  // account switch — see handleAccountSwitched.
  const [refetchKey, setRefetchKey] = useState(0);
  // The account list, held OUTSIDE `state` on purpose. An account switch puts
  // the stats back into their loading state (see handleAccountSwitched), and the
  // picker must survive that: unmounting it would drop the menu, the detection
  // prompt and the secret field at the exact moment the user is using them.
  // Re-seeded from every summary response, so the server stays authoritative.
  const [accountScope, setAccountScope] = useState<{
    accounts: AccountSummary[];
    activeId: number | null;
    riotId: string | null;
  } | null>(null);
  // Non-null only while a just-switched account's stats are in flight — lets the
  // loading state name the account it is loading instead of going silently blank.
  const [pendingRiotId, setPendingRiotId] = useState<string | null>(null);

  useEffect(() => {
    getChampionIconMap().then(setChampIcons);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchMyStatsSummary().then((data) => {
      if (cancelled) return; // stale-response guard, same pattern as BuildTabContent/draft page
      setState(data ? { status: "ok", summary: data as MyStatsSummaryExtended } : { status: "error" });
      if (data) {
        setAccountScope({
          accounts: data.accounts ?? [],
          activeId: data.accountId ?? null,
          riotId: data.riotId,
        });
      }
      setPendingRiotId(null);
    });
    return () => {
      cancelled = true;
    };
  }, [refetchKey]);

  /**
   * THE hard requirement of the multi-account ship. `switched: true` means the
   * active account changed, which means every number on this page has just
   * changed MEANING — the figures themselves are still the old account's.
   *
   * So this does two things, and both matter. It re-fetches the summary, and it
   * blanks the stats until that lands. Patching the active label and leaving the
   * old figures up would produce a confident, plausible, wrong number belonging
   * to a different player — the exact failure the backend change exists to
   * prevent (HANDOFF-engy.md §5c: scoped adherence returns null and renders "—",
   * unscoped returns a confident 0.0%). A brief skeleton is the honest state.
   */
  function handleAccountSwitched(riotId: string | null): void {
    setPendingRiotId(riotId);
    setState({ status: "loading" });
    setExpanded(null); // the matchup drill-down belonged to the old account
    setRefetchKey((k) => k + 1);
  }

  useEffect(() => {
    if (expanded === null) {
      setDetail({ status: "idle" });
      return;
    }
    let cancelled = false;
    setDetail({ status: "loading" });
    // Pass the row's own role -- scopes the fetched matchups to exactly the
    // (championId, role) the header summed, instead of every role that
    // champion was ever played in.
    fetchMyStatsMatchups(expanded.championId, expanded.role).then((data) => {
      if (cancelled) return;
      if (!data) {
        setDetail({ status: "error" });
        return;
      }
      const rows = buildMyStatsMatchupRows(data.matchups, (id) => champIcons.get(id));
      setDetail(rows.length === 0 ? { status: "empty" } : { status: "ok", matchups: rows });
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, champIcons]);

  function toggleRow(championId: number, role: number) {
    setExpanded((prev) => (prev && prev.championId === championId && prev.role === role ? null : { championId, role }));
  }

  const rows: MyStatsChampionRow[] =
    state.status === "ok" ? buildMyStatsRows(state.summary.records, (id) => champIcons.get(id)) : [];
  const overall = state.status === "ok" ? computeMyStatsOverall(state.summary.records) : null;
  // Summed across roles — NOT rows[0], which is one (champion, role) record and
  // understated the headline whenever a champion was played in two lanes.
  const mainRow =
    state.status === "ok"
      ? computeMainChampion(state.summary.records, (id) => champIcons.get(id))
      : null;
  const recentGames = state.status === "ok" ? state.summary.recentGames ?? [] : [];
  // IS THIS A SEASON, OR THE PART OF ONE WE HAPPEN TO HOLD? Derived once, here,
  // and read by every surface below that makes a coverage claim — the hero
  // eyebrow/pills, the KPI strip's GAMES cell and the matchup panel's heading.
  // Deriving it per-surface is how two of them would eventually disagree.
  //
  // `overall.games` (not recentGames.length): the count the page actually shows.
  // accountUnresolved is passed through so this can never produce a coverage
  // claim for an account that is not even resolved — computeHistoryCoverage
  // returns state "none" with no pill for that case.
  const coverage = computeHistoryCoverage({
    accountUnresolved: state.status === "ok" ? state.summary.accountUnresolved : true,
    historyComplete: state.status === "ok" ? state.summary.historyComplete : null,
    games: overall?.games ?? 0,
  });
  const seasonLabel = state.status === "ok" ? state.summary.season || "" : "";
  const riotId = state.status === "ok" ? state.summary.riotId : null;
  // Splash art = the account's main champion. Falls back to no art (scrim
  // only, still a finished surface) when there are no records yet or the
  // champion map hasn't resolved.
  const heroSplashKey = mainRow ? championKeyFromIconUrl(champIcons.get(mainRow.championId)?.icon) : null;
  const heroAvatar = mainRow ? champIcons.get(mainRow.championId)?.icon ?? "" : "";

  return (
    <div className="min-h-screen pb-16">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-6 pt-6 space-y-5">
        <HeroBand
          headingLevel={1}
          splashKey={heroSplashKey}
          avatarSrc={mainRow ? heroAvatar : null}
          avatarAlt={mainRow?.name ?? ""}
          avatarGlyph={mainRow?.name}
          eyebrow={seasonLabel ? `My Stats · ${seasonLabel}` : "My Stats"}
          title={riotId ?? "My Stats"}
          reservePills
          pills={
            coverage.pill || (overall && overall.games > 0) ? (
              <>
                {/* FIRST in the row on purpose: the caveat is read before the
                    counts it qualifies, rather than trailing them as a footnote.
                    `neutral` rather than `bad` — nothing is broken, the history is
                    filling, and a red pill beside a W-L record would read as an
                    error the user has to act on. */}
                {coverage.pill && (
                  <Pill tone="neutral" title={coverage.pill.title}>
                    {coverage.pill.text}
                  </Pill>
                )}
                {overall && overall.games > 0 && (
                  <>
                    {/* The titles say "recorded so far" whenever the season claim
                        isn't safe. A tooltip reading "Wins this season" over a
                        truncated history is the same over-claim as the heading,
                        just quieter. */}
                    <Pill tone="good" title={coverage.seasonClaimSafe ? "Wins this season" : "Wins recorded so far"}>
                      {overall.wins}W
                    </Pill>
                    <Pill tone="bad" title={coverage.seasonClaimSafe ? "Losses this season" : "Losses recorded so far"}>
                      {overall.losses}L
                    </Pill>
                    {/* THE MAIN PILL YIELDS ITS SLOT TO THE SYNCING PILL, and that
                        is a CLS fix as much as an editorial one. Measured at 390px:
                        a FOURTH pill wraps this row to two lines and grows the hero
                        ~26px — which is precisely the shift HeroBand's
                        `reservePills` exists to have already closed (see its doc
                        comment: that single growth was this page's entire CLS,
                        0.103 -> 0). Reserving two rows for every account to make
                        room for a caveat most accounts never see is the wrong
                        trade.
                        Editorially it is also the right pill to drop: "most-played
                        THIS SEASON" is itself a season claim, and it is the least
                        reliable one over a truncated walk — the true main can
                        change as older games arrive. Nothing is lost, because the
                        main champion is ALSO this hero's splash art and portrait
                        (see StatTiles' header for why the tile moved here). */}
                    {mainRow && coverage.pill === null && (
                      <Pill
                        tone="accent"
                        title={
                          coverage.seasonClaimSafe
                            ? "Most-played champion this season"
                            : "Most-played champion in the games recorded so far"
                        }
                      >
                        Main · {mainRow.name} {mainRow.games}g
                      </Pill>
                    )}
                  </>
                )}
              </>
            ) : undefined
          }
          right={<MyStatsRefresher onRefreshed={() => setRefetchKey((k) => k + 1)} />}
        />

        {accountScope && (
          <AccountPicker
            accounts={accountScope.accounts}
            activeRiotId={accountScope.riotId}
            activeId={accountScope.activeId}
            onSwitched={handleAccountSwitched}
          />
        )}

        {state.status === "loading" && (
          <>
            {pendingRiotId && (
              <p role="status" aria-live="polite" className="text-[11.5px] text-mut">
                Loading stats for <span className="text-txt font-semibold">{pendingRiotId}</span>…
              </p>
            )}
            <TilesSkeleton />
          </>
        )}

        {state.status === "error" && (
          <EmptyPanel
            title="Couldn't load your stats"
            body="Something went wrong fetching your personal match history. Try again shortly."
          />
        )}

        {state.status === "ok" && state.summary.accountUnresolved && (
          <EmptyPanel
            title="No account is active yet"
            body="Nothing is linked as the active account, so there are no stats to show. Open the League client with the companion running and the panel above will offer to link the account you're signed in as."
          />
        )}

        {/* Zero rows has TWO causes and they are not the same message. If the
            history is known incomplete, "no games this season" is a claim about
            the season made from a walk that never finished — the account may have
            played plenty and we simply have not reached it yet. Only a COMPLETE
            (or complete-as-far-as-we-were-told) history earns the original copy. */}
        {state.status === "ok" && !state.summary.accountUnresolved && rows.length === 0 && (
          <EmptyPanel
            title={coverage.seasonClaimSafe ? "No games yet this season" : "Still collecting your games"}
            body={
              coverage.seasonClaimSafe
                ? `No recorded games for ${state.summary.season || "the current season"} yet — check back after your next few games.`
                : "Nothing has been stored for this account yet. The sync works backwards through your match history a batch at a time, so give it a few refreshes before reading anything into an empty page."
            }
          />
        )}

        {state.status === "ok" && !state.summary.accountUnresolved && rows.length > 0 && overall && (
          <div className="space-y-5">
            {coverage.state === "thin" && <StillSyncingCallout games={coverage.games} />}

            <StatTiles
              games={overall.games}
              seasonLabel={state.summary.season || ""}
              winrate={overall.winrate}
              priorSplitWinrate={state.summary.priorSplitWinrate ?? null}
              buildAdherencePct={state.summary.buildAdherencePct ?? null}
              winrateOnBuild={state.summary.winrateOnBuild ?? null}
              winrateOffBuild={state.summary.winrateOffBuild ?? null}
              nOnBuild={state.summary.nOnBuild ?? null}
              nOffBuild={state.summary.nOffBuild ?? null}
              coverage={coverage}
            />

            {/* `items-start`: without it the two panels are forced to equal
                height, and the champion pool (44 rows on this account) stretched
                the 5-row recent-games card into ~600px of empty panel. */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5 items-start">
              <RecentGamesList games={recentGames} iconOf={(id) => champIcons.get(id)} />
              <ChampionPoolCard rows={rows} />
            </div>

            {/* Secondary section — the pre-wave-B per-champion expandable
                matchup table, lightly restyled. Capability preserved
                verbatim (same fetch/toggle logic), just demoted below the
                new tiles/lists as a secondary drill-down. */}
            <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 pt-4 pb-1">
              {/* "this season" is a coverage claim too — a champion pool built
                  from a truncated walk is the champions we have SEEN, not the ones
                  played. Same wording swap as the KPI strip's GAMES cell. */}
              <PanelHeading meta={`${rows.length} champions, ${coverage.seasonClaimSafe ? "this season" : "recorded so far"}`}>
                Matchup history
              </PanelHeading>
              <p className="sr-only" role="status">
                {/* "so far this season" and not "which is still syncing": this line
                    also renders in the `unknown` state, where we were never told
                    whether a sync is running. Withdrawing the claim is honest;
                    asserting the sync would be a second invented fact. */}
                {rows.length} champions with recorded games{" "}
                {coverage.seasonClaimSafe ? "this season" : "so far this season"}, sorted by games played.
              </p>
              {rows.map((row) => {
                // (championId, role), not championId alone -- see the
                // `expanded` state comment above.
                const isRowExpanded = expanded !== null && expanded.championId === row.championId && expanded.role === row.role;
                const detailId = `mystats-detail-${row.championId}-${row.role}`;
                return (
                  <div key={`${row.championId}-${row.role}`} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleRow(row.championId, row.role)}
                      aria-expanded={isRowExpanded}
                      aria-controls={detailId}
                      className="w-full flex items-center gap-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-lg"
                    >
                      <span className="w-9 h-9 rounded-lg bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                        <IconWithFallback src={row.icon} alt="" fallbackGlyph={row.name} className="w-full h-full object-cover" size={36} />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[13px] text-txt font-semibold truncate">{row.name}</span>
                          <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
                            {row.roleLabel}
                          </span>
                          {row.lowSample && (
                            <span className="text-[9px] tracking-[0.06em] uppercase font-bold px-1.5 py-0.5 rounded bg-panel2 text-mut border border-line flex-shrink-0">
                              Low sample
                            </span>
                          )}
                        </div>
                        <div className="text-[10.5px] text-mut tabular-nums mt-0.5">
                          {row.games}g &middot; {row.wins}W-{row.losses}L
                        </div>
                      </div>

                      <div className="text-right flex-shrink-0">
                        <div
                          className={`text-[13.5px] font-bold tabular-nums ${
                            row.lowSample ? "text-mut" : row.winrate >= 0.5 ? "text-good" : "text-bad"
                          }`}
                        >
                          {pct(row.winrate)}
                        </div>
                      </div>

                      <span
                        className={`text-mut text-[11px] transition-transform duration-150 flex-shrink-0 ${isRowExpanded ? "rotate-180" : ""}`}
                        aria-hidden="true"
                      >
                        &#9662;
                      </span>
                    </button>

                    <div id={detailId} hidden={!isRowExpanded} className="pb-3 pl-12 pr-1">
                      {isRowExpanded && detail.status === "loading" && <p className="text-[11px] text-mut py-2">Loading matchups…</p>}
                      {isRowExpanded && detail.status === "error" && (
                        <p className="text-[11px] text-bad py-2">Couldn&apos;t load matchups — try again.</p>
                      )}
                      {isRowExpanded && detail.status === "empty" && (
                        <p className="text-[11px] text-mut py-2">No lane-opponent data recorded for this champion.</p>
                      )}
                      {isRowExpanded && detail.status === "ok" && (
                        <div className="space-y-1.5 py-1">
                          {detail.matchups.map((m) => (
                            <div key={m.oppChampionId} className="flex items-center gap-2.5">
                              <span className="w-6 h-6 rounded bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                                <IconWithFallback src={m.icon} alt="" fallbackGlyph={m.name} className="w-full h-full object-cover" size={24} />
                              </span>
                              <span className="text-[11.5px] text-txt flex-1 truncate">vs {m.name}</span>
                              <span className="text-[10.5px] text-mut tabular-nums flex-shrink-0">{m.games}g</span>
                              <span
                                className={`text-[11px] font-semibold tabular-nums w-20 text-right flex-shrink-0 ${
                                  m.lowSample ? "text-mut" : m.winrate >= 0.5 ? "text-good" : "text-bad"
                                }`}
                              >
                                {m.wins}-{m.losses} ({pct(m.winrate)})
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Your own match history — shown for context only, never blended into any recommendation or ranking.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
