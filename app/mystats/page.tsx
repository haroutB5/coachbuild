"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /mystats — "My Stats" personal match tracker (backend by engy, 2026-07-21 —
// see HANDOFF.md's "My Stats" entries + lib/mystats/**). v0.51 wave B:
// rebuilt around MatchPerformancePanel/ChampionPoolCard (mockup 6.png),
// consuming the EXTENDED /api/mystats/summary (buildAdherencePct,
// winrateOnBuild, winrateOffBuild, recentGames[]) engo is adding concurrently
// in myStats.ts's normalizer. Every extended field is
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

import { useCallback, useEffect, useRef, useState } from "react";
import { IconWithFallback } from "@/components/IconWithFallback";
import MyStatsRefresher from "@/components/hextech/MyStatsRefresher";
import { Pill } from "@/components/hextech/HeroBand";
import HextechTabs from "@/components/hextech/HextechTabs";
import PanelHeading from "@/components/hextech/PanelHeading";
import AccountPicker from "@/components/hextech/mystats/AccountPicker";
import BuildAdherenceNote from "@/components/hextech/mystats/BuildAdherenceNote";
import { type RecentGameRow } from "@/components/hextech/mystats/RecentGamesList";
import ChampionPoolCard from "@/components/hextech/mystats/ChampionPoolCard";
import ProfileHero from "@/components/hextech/mystats/ProfileHero";
import MostPlayedStrip from "@/components/hextech/mystats/MostPlayedStrip";
import AccountCardGrid from "@/components/hextech/mystats/AccountCardGrid";
import ChampionPerformancePanel from "@/components/hextech/mystats/ChampionPerformancePanel";
import MatchPerformancePanel from "@/components/hextech/mystats/MatchPerformancePanel";
import { switchAccount } from "@/components/hextech/mystats/accountPickerModel";
import {
  buildProfileTabs,
  buildMostPlayedStrip,
  buildChampionPerformanceRows,
  buildAccountCards,
  buildMatchPerformanceChips,
  computeLastActiveMs,
  formatRelativeTime,
  formatRank,
  formatRegionChip,
  opggRegionSlug,
  isLiveGamePhase,
  type ProfileTabId,
  type RankInput,
} from "@/components/hextech/mystats/profileModel";
import { getChampionIconMap, type ChampionIconEntry } from "@/components/proAssets";
import { useCompanion } from "@/components/live/CompanionProvider";
import { selectAccount, type AccountSummary } from "@/components/live/mystatsAccount";
import {
  fetchMyStatsSummary,
  fetchMyStatsMatchups,
  buildMyStatsRows,
  buildMyStatsMatchupRows,
  computeMyStatsOverall,
  computeMainChampion,
  computeHistoryCoverage,
  getMyStatsScopeLabels,
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
  recentGames?: RecentGameRow[];
  /** v0.74 — the row counts BEHIND winrateOnBuild/winrateOffBuild
   *  (lib/mystats/aggregate.ts -> the summary route -> normalizeMyStatsSummary).
   *  Same optional pattern as the five above, for the same TS2430 reason.
   *  These are what let `computeBuildWinrateDelta` return `comparable: true` on
   *  a real load — without them it answers "sample-unknown" forever, which is
   *  the state this field pair was added to end. Pass BOTH to BuildAdherenceNote. */
  nOnBuild?: number | null;
  nOffBuild?: number | null;
  /** 2026-07-30 — false when a refresh run was cut off by its Riot-call budget
   *  before it finished walking this account's season, i.e. every figure below is
   *  over a PARTIAL history. Null/absent means the response did not say. Read only
   *  through computeHistoryCoverage, never branched on directly here — see
   *  StillSyncingCallout and the hero coverage pill. */
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

/**
 * The Accounts tab's loading state, at the FINAL dimensions of what replaces it.
 *
 * This exists because the pixels said so. Before it, everything below the hero
 * was simply absent until the single summary fetch landed — and since that ONE
 * response carries the account list AND the stats, "absent" meant the card grid,
 * both lower panels and the footer all appeared at once. Measured at 390px on a
 * dev build: CLS 0.736. The KPI strip was the only thing reserving any space.
 *
 * Each block below is sized to the real thing it stands in for:
 *   · cards      58px min-height, the exact `min-h-[58px]` AccountCardGrid uses
 *   · panels     the two lower panels, side by side at `lg` exactly as they land
 * A skeleton that is not the final size does not reduce shift, it relocates it,
 * so these track their real counterparts — if a panel's height changes, change
 * these with it.
 */
function AccountsSkeleton({ cards }: { cards: number }) {
  return (
    <div className="space-y-5 animate-pulse motion-reduce:animate-none" aria-hidden="true">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {Array.from({ length: Math.max(3, cards + 1) }).map((_, i) => (
          <div key={i} className="min-h-[58px] rounded-xl border border-line bg-panel" />
        ))}
      </div>
      {/* No KPI-strip placeholder any more — the strip it stood in for was
          deleted (see the Accounts tab). A skeleton for a block that no longer
          arrives does not prevent shift, it CAUSES one: it would reserve ~74px
          that nothing ever fills, then vanish. */}
      {/* Track AccountsTab's real lower grid EXACTLY — same columns, same gaps.
          A skeleton at the wrong proportions does not reduce shift, it moves it. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] gap-4 lg:gap-5 items-start">
        <div className="h-[420px] rounded-xl border border-line bg-panel" />
        <div className="h-[420px] rounded-xl border border-line bg-panel" />
      </div>
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
  const detailKey = expanded ? `${expanded.championId}:${expanded.role}` : null;
  const [previousDetailKey, setPreviousDetailKey] = useState(detailKey);
  if (detailKey !== previousDetailKey) {
    setPreviousDetailKey(detailKey);
    setDetail(detailKey === null ? { status: "idle" } : { status: "loading" });
  }
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
  // 2026-07-30 profile redesign. Which section the tab strip is showing, whether
  // the account grid is expanded past its cap, and which card has a switch in
  // flight. All three are pure view state — none of them can change what a
  // number MEANS, which is why they live here rather than in `state`.
  const [tab, setTab] = useState<ProfileTabId>("accounts");
  const [accountsExpanded, setAccountsExpanded] = useState(false);
  const [switchingId, setSwitchingId] = useState<number | null>(null);
  // Non-null only after a failed card switch — see switchFromGrid.
  const [gridError, setGridError] = useState<string | null>(null);
  // Is the linking panel (the old "Linked accounts" bar) disclosed? Closed by
  // default — it is the occasional surface now, reached from the small "Manage"
  // affordance beside the Accounts heading. See that button for what moved and
  // what did not.
  const [manageOpen, setManageOpen] = useState(false);
  // "Link another account" scrolls to (and focuses) the real linking surface,
  // which is AccountPicker — that flow owns the companion read, the secret entry
  // and the detection prompt, and is the tested path. The grid's trailing cell
  // is a signpost to it, never a second implementation of it.
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const { phase } = useCompanion();
  const clientInGame = isLiveGamePhase(phase);
  /** The Riot ID the client is signed in as, reported by AccountPicker's single
   *  `/me` read. `undefined` = not answered yet, `null` = we could not tell. */
  const [clientRiotId, setClientRiotId] = useState<string | null | undefined>(undefined);

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
      return;
    }
    let cancelled = false;
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

  /**
   * The card grid's switch. Routed through `switchAccount` — the same pure
   * mutation AccountPicker uses — so the re-fetch-on-switch rule lives in ONE
   * place. `refetchSummary` fires if and only if the server reported
   * `switched: true`, and `handleAccountSwitched` blanks the stats until the new
   * ones land. A second hand-rolled switch here is exactly how that rule would
   * eventually be forgotten on one of the two paths.
   */
  const switchFromGrid = useCallback(
    async (id: number) => {
      const target = accountScope?.accounts.find((a) => a.id === id) ?? null;
      setSwitchingId(id);
      const result = await switchAccount(id, {
        select: (accountId) => selectAccount(accountId),
        refetchSummary: () => handleAccountSwitched(target?.riotId ?? null),
      });
      setSwitchingId(null);
      if (result.status === "ok") {
        // Re-seed the LIST immediately (which account is active) — a different
        // question from what the NUMBERS mean, which only the re-fetch answers.
        setAccountScope({ accounts: result.accounts, activeId: result.activeId, riotId: result.riotId });
        setGridError(null);
        return;
      }
      // A FAILED switch must not be silent. Measured in the browser: with no
      // stored account secret, `selectAccount` answers `no-secret` and the card
      // click did nothing at all — a control that looks actionable, is
      // actionable, and visibly does nothing. AccountPicker still owns the full
      // error vocabulary and the secret FIELD (duplicating either here would give
      // the page two disagreeing error surfaces), so this says the one thing the
      // user can act on and sends them to the control that unblocks them.
      setGridError(
        result.reason === "no-secret" || result.reason === "unauthorized"
          ? "Switching accounts needs your account secret — enter it below."
          : "Couldn't switch accounts. See the panel below."
      );
      focusPicker();
    },
    [accountScope]
  );

  /**
   * Send the user to the linking panel — opening it first, because it is closed
   * by default now.
   *
   * The focus call has to wait a frame: when the panel was collapsed the button
   * being focused does not exist yet on this tick, and focusing nothing silently
   * drops a keyboard user on the document body. `mustShowManage` covers the
   * zero-account case where the toggle itself is not rendered.
   */
  function focusPicker(): void {
    setManageOpen(true);
    requestAnimationFrame(() => {
      pickerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      pickerRef.current?.querySelector("button")?.focus();
    });
  }

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

  // ── 2026-07-30 profile-redesign derivations ────────────────────────────────
  // Every one of these is derived ONCE here and passed down, for the same reason
  // `coverage` is: a value re-derived per component is a value two components
  // eventually disagree about.
  const summary = state.status === "ok" ? state.summary : null;
  // The ACTIVE account's ranked standing. Read from the top-level mirror engy
  // ships (§1a) rather than hunting through `accounts[]` — same values, and one
  // less place to pick the wrong row. `rankUnknown` defaults to TRUE through the
  // normalizer, so a response that predates the rank ship reads as "not synced",
  // never as "Unranked".
  const activeRank: RankInput = {
    tier: summary?.tier ?? null,
    division: summary?.division ?? null,
    lp: summary?.lp ?? null,
    rankWins: summary?.rankWins ?? null,
    rankLosses: summary?.rankLosses ?? null,
    rankUnknown: summary?.rankUnknown ?? true,
    rankCheckedAt: summary?.rankCheckedAt ?? null,
  };
  const heroRank = formatRank(activeRank);
  // A live game belongs to the account the CLIENT is signed in as, which is not
  // necessarily the account being displayed. Requires a positive match, so an
  // unanswered or unknowable identity renders no claim at all.
  const liveIsThisAccount =
    clientInGame && !!clientRiotId && !!accountScope?.riotId && clientRiotId === accountScope.riotId;
  const activeAccount = accountScope?.accounts.find((a) => a.id === accountScope.activeId);
  const regionChip = formatRegionChip(activeAccount?.region ?? "");
  const opggRegion = opggRegionSlug(activeAccount?.region);
  const opggUrl =
    riotId && activeAccount?.gameName && activeAccount.tagLine && opggRegion
      ? `https://op.gg/lol/summoners/${opggRegion}/${encodeURIComponent(activeAccount.gameName)}-${encodeURIComponent(activeAccount.tagLine)}`
      : null;
  const heroTitle =
    opggUrl && riotId ? (
      <a
        href={opggUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${riotId} on OP.GG`}
        title={`Open ${riotId} on OP.GG`}
        className="text-inherit underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg rounded-sm"
      >
        {riotId}
      </a>
    ) : (
      riotId ?? "My Stats"
    );
  const mostPlayed = buildMostPlayedStrip(rows);
  const championPerformance = buildChampionPerformanceRows(rows);
  const accountGrid = buildAccountCards(accountScope?.accounts ?? [], { expanded: accountsExpanded });
  // With NOTHING linked there is no "N linked · Manage" toggle to render (a
  // toggle reading "0 linked" is a control onto an empty room), so the panel
  // cannot be reached by the normal route — and it is the only place the link
  // flow and the secret live. It stays open in that state rather than becoming
  // unreachable, which is the one outcome this refactor was told to avoid.
  const mustShowManage = (accountScope?.accounts.length ?? 0) === 0;
  const matchChips = buildMatchPerformanceChips(recentGames, activeRank);
  // "Last active" is the newest game we have STORED, not the companion's
  // last-seen — see computeLastActiveMs. Computed against a render-time clock;
  // it is a coarse freshness cue (minutes/hours/days), so it does not need to
  // tick and deliberately does not run a timer.
  const lastActive = formatRelativeTime(
    computeLastActiveMs(summary?.records ?? []),
    Date.now()
  );
  const scopeCopy = getMyStatsScopeLabels(coverage.seasonClaimSafe);
  const scopeLabel = scopeCopy.label;
  const scopePhrase = scopeCopy.phrase;
  const storedRecordSource = coverage.seasonClaimSafe
    ? "Recorded games we hold this season"
    : "Recorded games we hold so far";
  const TABS = buildProfileTabs();

  return (
    <div className="min-h-screen pb-16">
      {/* 1280, not 1100. Measured against the reference: its content column is
          the FULL 1290px viewport with ~14px gutters, and every "ours is looser
          than the reference" reading traced back to the same 1010px column
          re-flowing the reference's 1290px composition into less room. Widening
          is the cheapest density gain on the page — the card grid, the two lower
          panels and the 20-bar chart all get their reference proportions back
          without a single font shrinking. */}
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 pt-6 space-y-5">
        <ProfileHero
          headingLevel={1}
          splashKey={heroSplashKey}
          avatarSrc={mainRow ? heroAvatar : null}
          avatarAlt={mainRow?.name ?? ""}
          avatarGlyph={mainRow?.name}
          live={liveIsThisAccount}
          eyebrow={seasonLabel ? `My Stats · ${seasonLabel}` : "My Stats"}
          title={heroTitle}
          lines={
            <>
              {/* Real copy in the reference's CTA slot, not marketing. Line one
                  is the ranked standing in words (which also says plainly when
                  it has not been read); line two is freshness. */}
              <p title={heroRank.record ? `${heroRank.title} This W-L is Riot's ranked solo/duo ledger.` : heroRank.title}>
                {heroRank.state === "ranked" ? (
                  <>
                    Ranked solo/duo: {heroRank.label}
                    {heroRank.lp ? ` · ${heroRank.lp}` : ""}
                    {/* nowrap on the record: at 390px "65W 66L" was breaking
                        mid-pair onto the next line, which reads as two unrelated
                        numbers rather than one W-L record. */}
                    {heroRank.record ? <span className="whitespace-nowrap"> · {heroRank.record}</span> : ""}
                  </>
                ) : heroRank.state === "unranked" ? (
                  `No ranked solo/duo standing ${scopePhrase}.`
                ) : (
                  "Ranked standing not read yet for this account."
                )}
              </p>
              <p>
                {lastActive ? `Last recorded game ${lastActive}.` : "No games recorded yet."}
                {/* "In a game now" is a claim about THIS account, but the
                    gameflow phase only says the CLIENT is in a game. With two
                    accounts linked those diverge, and v0.84.x printed a live
                    K1ayer game under MunsterHunter's name. `liveIsThisAccount`
                    is only true once the client's identity is known AND
                    matches; when it is someone else we say whose, and while it
                    is unknown we say nothing rather than guess. */}
                {liveIsThisAccount && <span className="text-bad font-semibold"> In a game now.</span>}
                {clientInGame && clientRiotId && clientRiotId !== accountScope?.riotId && (
                  <span className="text-mut"> Your client is in a game as {clientRiotId}.</span>
                )}
              </p>
            </>
          }
          actions={<MyStatsRefresher onRefreshed={() => setRefetchKey((k) => k + 1)} />}
          chips={
            <>
              {/* The reference's `#1 EUW` slot. The REGION is real; the ladder
                  POSITION is not something this app fetches for the signed-in
                  user, so the chip carries region only — never a "#1" that
                  actually means "we don't know". */}
              {regionChip && <Pill tone="neutral" title="Riot server region for the active account">{regionChip}</Pill>}
              {/* Rank chip. `heroRank.state` is read, NOT `tier === null` — an
                  account whose rank has never been read says "Rank not synced"
                  and must never wear an Unranked badge (engy §1a). */}
              <Pill tone={heroRank.state === "ranked" ? "accent" : "neutral"} title={heroRank.title}>
                {heroRank.label}
                {heroRank.lp ? ` · ${heroRank.lp}` : ""}
              </Pill>
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
                    {/* These titles name the held-games source (and whether the
                        history is complete) so the stored record cannot be
                        mistaken for Riot's ranked solo/duo ledger above. */}
                    <Pill tone="good" title={`${storedRecordSource}: ${overall.wins} wins.`}>
                      Stored {overall.wins}W
                    </Pill>
                    <Pill tone="bad" title={`${storedRecordSource}: ${overall.losses} losses.`}>
                      Stored {overall.losses}L
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
                        (the MAIN tile moved onto this hero when the KPI strip still existed, and outlived it). */}
                    {mainRow && coverage.pill === null && (
                      <Pill
                        tone="accent"
                        title={`Most-played champion ${scopePhrase}`}
                      >
                        Main · {mainRow.name} {mainRow.games}g
                      </Pill>
                    )}
                  </>
                )}
            </>
          }
        />

        {/* The reference's tab strip, minus the three tabs that lead nowhere —
            see buildProfileTabs. HextechTabs brings the ARIA Tabs keyboard
            contract (roving tabindex, arrows, Home/End) and the gold underline
            with it, so this strip does not re-implement either. */}
        <HextechTabs
          options={TABS}
          value={tab}
          onChange={setTab}
          ariaLabel="My Stats sections"
          // The reference's strip is SENTENCE CASE at ~14px with normal
          // tracking and ~40px between tabs; HextechTabs' own default is
          // uppercase/13px/+0.06em/24px because that is what the Builds page
          // wants. Overriding through the tablist's className rather than
          // adding a variant prop keeps the Builds page's strip untouched —
          // BuildTabContent renders the SAME component twice and neither call
          // site asked for this.
          className="-mt-1 sm:gap-9 [&_[role=tab]]:normal-case [&_[role=tab]]:tracking-[0.005em] [&_[role=tab]]:text-[13.5px] [&_[role=tab]]:font-medium"
        />

        {state.status === "loading" && (
          <>
            {pendingRiotId && (
              <p role="status" aria-live="polite" className="text-[11.5px] text-mut">
                Loading stats for <span className="text-txt font-semibold">{pendingRiotId}</span>…
              </p>
            )}
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
            title={coverage.seasonClaimSafe ? `No games yet ${scopePhrase}` : "Still collecting your games"}
            body={
              coverage.seasonClaimSafe
                ? `No recorded games for ${state.summary.season || "the current season"} yet — check back after your next few games.`
                : "Nothing has been stored for this account yet. The sync works backwards through your match history a batch at a time, so give it a few refreshes before reading anything into an empty page."
            }
          />
        )}

        {/* ── ACCOUNTS TAB ──────────────────────────────────────────────────
            The reference's visible state, in its order: the "Accounts" heading
            with the most-played portrait strip on its baseline, the account card
            grid, then the two-column lower section. The account PICKER stays
            mounted underneath the grid because it owns the linking flow — the
            companion read, the detection prompt and the secret entry — and is
            the tested surface for all three. The grid switches; the picker
            links. Neither duplicates the other's job. */}
        <div
          id="hextech-tabpanel-accounts"
          role="tabpanel"
          aria-labelledby="hextech-tab-accounts"
          hidden={tab !== "accounts"}
          className="space-y-5"
        >
          {/* The reference's "Accounts" is a DISPLAY heading — roughly 40px on
              its 1290px column, i.e. ~32px on ours — with the most-played strip
              hung off its baseline at the right. Ours shipped at 15px, which is
              the single largest reason the shipped page read as a settings
              screen where the reference reads as a profile. Negative tracking
              scales with size (−0.03em here, versus −0.015em at 15px) because
              that is the premium tell and it only starts helping above ~24px.
              `min-h` tracks the tallest of (heading, portrait strip) at each
              width so the row cannot change height when the strip resolves. */}
          {/* `min-h-[44px]` at EVERY width, not the old 36/42/46 ramp: the
              manage toggle beside the heading is a 44px touch target, so the row
              is 44px tall the moment it renders. Keeping the floor below that
              would have let the row grow when the account list arrives — a shift
              in the first band under the hero, which is the worst place for one. */}
          <div className="flex items-end justify-between gap-3 flex-wrap min-h-[44px] sm:min-h-[46px]">
            <div className="flex items-end gap-2.5 min-w-0">
              <h2 className="text-[22px] sm:text-[28px] lg:text-[32px] font-semibold text-txt tracking-[-0.03em] leading-none">
                Accounts
              </h2>
              {/* THE PANEL THAT USED TO BE A BAR (2026-07-30 user directive).
                  "Linked accounts" was a full panel below the grid holding a
                  dropdown that named the account already highlighted in a card
                  directly above it, plus a count, plus a link. The dropdown was
                  the duplicate — the cards have switched accounts through the
                  same tested mutation since v0.85.0 — so what is left behind
                  this toggle is the LINKING flow: the secret, and the full
                  picker for a keyboard user who wants a list rather than a grid.
                  The client-mismatch prompt is NOT behind it; see the picker's
                  `collapsed` prop. */}
              {accountScope && accountScope.accounts.length > 0 && (
                <button
                  type="button"
                  onClick={() => setManageOpen((o) => !o)}
                  aria-expanded={manageOpen}
                  aria-controls="mystats-account-manage"
                  className="min-h-[44px] -my-2 flex items-center gap-1.5 px-2 -mx-2 rounded-lg text-[11.5px] font-medium text-mut hover:text-txt transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
                >
                  <span className="tabular-nums">{accountScope.accounts.length} linked</span>
                  <span aria-hidden="true" className="text-mut/70">
                    &middot;
                  </span>
                  <span className="text-teal/90">{manageOpen ? "Hide" : "Manage"}</span>
                  {/* Same SVG the picker's own trigger uses — the `&#9662;`
                      glyph renders as a 3px dash in this app's display font. */}
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 12 12"
                    className={`w-2.5 h-2.5 flex-shrink-0 transition-transform duration-150 motion-reduce:transition-none ${
                      manageOpen ? "rotate-180" : ""
                    }`}
                  >
                    <path
                      d="M2.5 4.5 6 8l3.5-3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            <MostPlayedStrip champions={mostPlayed} scopeLabel={scopePhrase} />
          </div>

          {/* The skeleton lives INSIDE this panel, standing in for exactly the
              blocks below it, rather than beside them — a placeholder rendered
              next to the thing it replaces reserves the wrong box and relocates
              the shift instead of removing it. */}
          {state.status === "loading" && (
            <AccountsSkeleton cards={accountScope?.accounts.length ?? 2} />
          )}

          {state.status !== "loading" && accountScope && (
            <AccountCardGrid
              model={accountGrid}
              avatarOf={() => (mainRow ? champIcons.get(mainRow.championId)?.icon : undefined)}
              onSelect={switchFromGrid}
              pendingId={switchingId}
              onShowAll={() => setAccountsExpanded(true)}
              onLinkAnother={focusPicker}
              // The grid only renders once loading has finished (the skeleton
              // covers that window), so a switch in flight is the only thing
              // left that should lock the cards.
              disabled={switchingId !== null}
            />
          )}

          {gridError && (
            <p role="status" aria-live="polite" className="text-[11.5px] text-bad">
              {gridError}
            </p>
          )}

          {state.status !== "loading" && accountScope && (
            <div ref={pickerRef} id="mystats-account-manage">
              <AccountPicker
                accounts={accountScope.accounts}
                activeRiotId={accountScope.riotId}
                activeId={accountScope.activeId}
                onSwitched={handleAccountSwitched}
                onIdentityDetected={setClientRiotId}
                // Collapsed = prompt only. NOT unmounted: this component owns
                // the once-per-load `/me` read and reports the client's identity
                // upward, which is what the hero's live-attribution rule
                // (v0.84.3) is decided from. Unmounting it to hide a panel would
                // switch that off and put a live K1ayer game back under
                // MunsterHunter's name.
                collapsed={!manageOpen && !mustShowManage}
                onRequestExpand={() => setManageOpen(true)}
              />
            </div>
          )}

          {state.status === "ok" && !state.summary.accountUnresolved && rows.length > 0 && overall && (
            <div className="space-y-5">
              {coverage.state === "thin" && <StillSyncingCallout games={coverage.games} />}

              {/* THE KPI STRIP THAT WAS HERE IS GONE (2026-07-30 user directive:
                  "this red section is useless just add the percentage WR into
                  the account section above"). It carried three cells and each one
                  was resolved separately rather than deleted as a group:
                    · WIN RATE  -> onto every account CARD, beside the LP. It is
                      also strictly better there: the strip showed the ACTIVE
                      account's rate above a grid of accounts that each have
                      their own.
                    · GAMES     -> already on each card ("141g"), and the
                      season W-L is already a pair of pills on the hero. The only
                      thing lost with the cell is `coverage.gamesNote`, which read
                      "still syncing" — the same fact the hero's coverage pill
                      states at length, and which StillSyncingCallout states again
                      above. Nothing about the five coverage states is now unsaid.
                    · BUILD ADHERENCE -> moved to the Match history tab, beside
                      the per-game on/off-build chips it summarises. See
                      BuildAdherenceNote's header for why it moved rather than
                      being dropped.
                  No split comparison remains on the wire or in the UI. The
                  account-wide card win rate has no separate historical denominator,
                  so every personal figure on this page uses the current-season
                  scope.
                  */}

              {/* The reference's two-column lower section. `items-start` so the
                  taller panel never stretches the shorter one into empty space.
                  One column under `lg` — a 3-column card grid and a 20-bar chart
                  both need a real mobile answer, and stacking is it. */}
              {/* NOT 50/50. Measured off the reference: its champion panel is
                  ~31.5% of the page and the match-performance panel ~63.7%, a
                  1:2 split. That ratio is not cosmetic — the right panel has to
                  carry three KPIs, a chip cluster and twenty bars, and at 50/50
                  the bars compress to the point the chart needs its own
                  horizontal scroll on a 1280px desktop, which is exactly the
                  "ours is less dense" reading. `minmax(0,…)` on BOTH tracks, not
                  bare `1fr`/`1.9fr`: a grid track defaults to `min-width:auto`
                  and the chart inside would refuse to shrink, which is gotcha
                  (v0.84.2)'s 383px sideways scroll all over again. */}
              {/* The 1:2 split is an `xl` rule, NOT an `lg` one, and that is a
                  measured correction rather than caution: at 1024px it gave the
                  champion panel a 250px track, the champion NAME column fell to
                  ~60px, and every row wrapped to two lines — row pitch went 57 ->
                  70, i.e. the "make it denser" change made that panel taller
                  than what it replaced. The reference is a 1290px desktop, so
                  its ratio is honest from 1280 up and nowhere below. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] gap-4 lg:gap-5 items-start">
                <ChampionPerformancePanel rows={championPerformance} scopeLabel={scopeLabel} />
                <MatchPerformancePanel
                  games={recentGames}
                  iconOf={(id) => champIcons.get(id)}
                  chips={matchChips}
                  scopeLabel={scopePhrase}
                  seasonCsPerMin={state.summary.csPerMin ?? null}
                  seasonCsGames={state.summary.csGames ?? 0}
                  // 2026-07-31 audit P2 re-score follow-up: the true denominator
                  // for "only Ng with CS" -- overall.games (ALL current-season
                  // records, not the capped 20-game recentGames window).
                  totalSeasonGames={overall?.games ?? 0}
                  lastActive={lastActive}
                />
              </div>
            </div>
          )}
        </div>

        {/* ── MATCH HISTORY TAB ─────────────────────────────────────────────
            The drill-downs the reference does not show: the per-champion pool
            and matchup table this page already had. */}
        <div
          id="hextech-tabpanel-history"
          role="tabpanel"
          aria-labelledby="hextech-tab-history"
          hidden={tab !== "history"}
          className="space-y-5"
        >
        {/* A REAL, RESOLVED ACCOUNT WITH NOTHING STORED IS NOW A LIVE STATE, not
            a hypothetical: the 2026-07-30 solo-queue-only filter means an account
            whose stored games are all flex/normal answers `accountUnresolved:
            false` with `records: []` and every figure null. Measured before this
            block existed, that made this tab render ZERO children at ZERO height
            — a tab in the strip leading to a blank page, which reads as broken
            rather than as deliberate. It now says which of the two it is: a
            finished answer, or a caveat while the walk is still filling.
            The Accounts tab has always had its own copy for this (above); this
            is the same fact told in this tab's terms. */}
        {state.status === "ok" && !state.summary.accountUnresolved && rows.length === 0 && (
          <EmptyPanel
            title={coverage.seasonClaimSafe ? "No match history yet" : "Still collecting your match history"}
            body={
              coverage.seasonClaimSafe
                ? "Per-game results, matchups and build adherence all appear here once there are recorded games for this account."
                : "The sync works backwards through your match history a batch at a time. Per-game results and build adherence will appear here as it reaches them."
            }
          />
        )}

        {state.status === "ok" && !state.summary.accountUnresolved && rows.length > 0 && overall && (
          <div className="space-y-5">
            {/* Adherence's home in Match History, beside the history it
                contextualizes rather than on the Accounts tab. */}
            <BuildAdherenceNote
              buildAdherencePct={state.summary.buildAdherencePct ?? null}
              winrateOnBuild={state.summary.winrateOnBuild ?? null}
              winrateOffBuild={state.summary.winrateOffBuild ?? null}
              nOnBuild={state.summary.nOnBuild ?? null}
              nOffBuild={state.summary.nOffBuild ?? null}
              scopeLabel={scopeLabel}
            />

            <ChampionPoolCard rows={rows} />

            {/* Secondary section — the pre-wave-B per-champion expandable
                matchup table, lightly restyled. Capability preserved
                verbatim (same fetch/toggle logic), just demoted below the
                new tiles/lists as a secondary drill-down. */}
            <div className="bg-panel border border-line rounded-xl px-4 sm:px-5 pt-4 pb-1">
              {/* "this season" is a coverage claim too — a champion pool built
                  from a truncated walk is the champions we have SEEN, not the ones
                  played. Same wording swap as the KPI strip's GAMES cell. */}
              <PanelHeading meta={`${rows.length} champions, ${scopeLabel}`}>
                Matchup history
              </PanelHeading>
              <p className="sr-only" role="status">
                {/* "so far this season" and not "which is still syncing": this line
                    also renders in the `unknown` state, where we were never told
                    whether a sync is running. Withdrawing the claim is honest;
                    asserting the sync would be a second invented fact. */}
                {rows.length} champions with recorded games{" "}
                {scopePhrase}, sorted by games played.
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
        </div>

        <footer className="mt-10 pt-4 border-t border-line text-center text-[11px] text-mut space-y-1">
          <p>Your own match history — shown for context only, never blended into any recommendation or ranking.</p>
          {process.env.NEXT_PUBLIC_APP_VERSION && <p className="text-mut">v{process.env.NEXT_PUBLIC_APP_VERSION}</p>}
        </footer>
      </div>
    </div>
  );
}
