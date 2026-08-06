"use client";

// ─────────────────────────────────────────────────────────────────────────────
// SkillOrderNextPanel.tsx — "level this next", on /compact only.
//
// The one surface in this app that speaks DURING a game. It reads the player's
// own champion level and own ability ranks from the companion (which reads
// them from Riot's in-game Live Client Data API), lines them up against the
// recommended order from /api/skill-order, and names the ability to put the
// next point into.
//
// ── ABSENT, NOT EMPTY ──────────────────────────────────────────────────────
// This component renders `null` — literally nothing, no card, no placeholder,
// no "waiting for a game" text — in every state except "there is a live
// reading AND a recommendation we stand behind". /compact is a chrome-free
// glance surface pinned to a second monitor; a permanent placeholder there is
// worse than useless, it is a thing the eye learns to skip, which is exactly
// the habit that would make the real recommendation invisible when it appears.
//
// Every one of these renders nothing, and none of them is an error:
//   * no companion / companion older than 1.8.0 (no /skills route)
//   * no game running (the normal state of the world)
//   * no unspent point (the normal state DURING a game — you level, you spend)
//   * no recommended order for this champion+role
//   * a recommendation lib/nextSkill.ts refused to make (past level 15 on an
//     incomplete order, a non-standard kit, an illegal ultimate rank, a player
//     who deviated and capped the ability the order names)
//
// ── Where the judgement lives ──────────────────────────────────────────────
// Not here. Every decision is in lib/nextSkill.ts's resolveNextSkill, which is
// pure and exhaustively tested. This file fetches, polls, and renders — if you
// find yourself adding a rule to it, it belongs in the resolver where it can
// be tested.
//
// ── What is NOT verified ───────────────────────────────────────────────────
// The live half of this has never been executed. There was no League client on
// the machine this was written on, so no /skills response carrying real data
// has ever reached this component. The "renders nothing" path IS verified (in
// a browser, against a real page load). The "renders a recommendation" path is
// verified only against hand-built inputs in lib/__tests__/nextSkill.test.ts.
// See HANDOFF-engy.md for the manual checks that close that gap.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { getSkills, getStoredPort, SKILL_POLL_MS } from "@/components/live/companionClient";
import { resolveNextSkill, type LiveSkillState } from "@/lib/nextSkill";
import { fetchSkillOrder, fetchSkillOrderBestLane, type SkillOrderModel } from "./skillOrder";
import { LANE_TO_ROLE_ID, type LaneId } from "./heroContracts";

interface SkillOrderNextPanelProps {
  championId: number;
  lane: LaneId | null;
}

export default function SkillOrderNextPanel({ championId, lane }: SkillOrderNextPanelProps) {
  const companion = useCompanion();
  const [model, setModel] = useState<SkillOrderModel | null>(null);
  const [live, setLive] = useState<LiveSkillState | null>(null);
  const modelRequestKey = `${championId}:${lane ?? ""}`;
  const [previousModelRequestKey, setPreviousModelRequestKey] = useState(modelRequestKey);
  if (modelRequestKey !== previousModelRequestKey) {
    setPreviousModelRequestKey(modelRequestKey);
    setModel(null);
  }

  // The recommended order for whatever champion+lane /compact is currently
  // showing. Same request the Builds page's SkillOrderCard makes, and the
  // route is CDN-cached, so this costs effectively nothing.
  //
  // NOTE the standing assumption, stated plainly because it is the weakest
  // link in this feature: the champion is the one /compact was opened for
  // (champ-select deep link or live follow), NOT one read back out of the
  // game. The Live Client Data API's /activeplayer does not carry a champion
  // name, and resolving it would mean pulling the whole allgamedata blob and
  // matching on summoner name. If /compact is showing the wrong champion then
  // its runes and items are already wrong too — that is a pre-existing
  // property of the page, not something this panel introduces — but it does
  // mean a stale deep link produces a confidently wrong skill recommendation.
  // See HANDOFF-engy.md.
  useEffect(() => {
    let cancelled = false;
    if (!championId || championId <= 0) return;
    // When the lane IS known, ask for it directly. When it is not, probe every
    // lane and keep the largest sample — this used to send `role=5` with the
    // comment "let the API pick", but the API never picked: `opggPosition(5)`
    // returns null, so role=5 answers `null` for every champion and this panel
    // rendered silently empty for the entire unknown-lane case. Verified against
    // production before the fix.
    const request = lane
      ? fetchSkillOrder(championId, LANE_TO_ROLE_ID[lane])
      : fetchSkillOrderBestLane(championId);
    void request.then((res) => {
      if (cancelled) return;
      setModel(res.status === "ok" ? res.model : null);
    });
    return () => {
      cancelled = true;
    };
  }, [championId, lane]);

  // Poll /skills ONLY while the companion reports a game in progress. Gating on
  // phase rather than polling unconditionally is the difference between zero
  // requests and 3,600 an hour for a companion that is idle all day — and the
  // phase is already being polled app-wide by CompanionProvider, so the gate
  // is free. When the phase leaves InProgress the reading is dropped, so the
  // panel disappears with the game rather than freezing on the last level.
  const inGame = companion.phase === "InProgress";
  const session = companion.session;
  const liveRequestKey = inGame && session ? session : null;
  const [previousLiveRequestKey, setPreviousLiveRequestKey] = useState(liveRequestKey);
  if (liveRequestKey !== previousLiveRequestKey) {
    setPreviousLiveRequestKey(liveRequestKey);
    setLive(null);
  }
  const requestRef = useRef(0);

  useEffect(() => {
    if (!inGame || !session) {
      return;
    }
    let cancelled = false;
    const generation = ++requestRef.current;

    async function tick() {
      const port = getStoredPort();
      if (port == null) return;
      const next = await getSkills(port, session as string, {});
      // Guard against a slow response from a previous generation landing after
      // the game ended and re-populating a panel that should be gone.
      if (cancelled || requestRef.current !== generation) return;
      setLive(next);
    }

    void tick();
    const id = setInterval(() => void tick(), SKILL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [inGame, session]);

  if (!live) return null;

  const result = resolveNextSkill({ model, level: live.level, ranks: live.abilities });
  if (result.kind !== "recommend") return null;

  const isUlt = result.ability === "R";

  return (
    <section
      className="rounded-lg border border-line bg-panel px-3 py-2.5 flex items-center gap-3"
      aria-label={`Level ${result.ability} next, rank ${result.fromRank} to ${result.toRank}`}
    >
      <span
        aria-hidden="true"
        className={`flex items-center justify-center w-10 h-10 shrink-0 rounded-md font-bold text-lg leading-none ${
          isUlt ? "bg-teal text-bg" : "bg-teal-dim/20 border border-teal-dim/60 text-teal-hover"
        }`}
      >
        {result.ability}
      </span>
      <div className="min-w-0">
        <p className="text-[10px] tracking-[0.14em] uppercase text-mut font-semibold leading-none mb-1.5">
          Level next
        </p>
        <p className="text-sm font-semibold tabular-nums leading-none">
          <span className="text-mut">{result.fromRank}</span>
          <span className="text-mut/50 mx-1.5" aria-hidden="true">
            &rarr;
          </span>
          <span className="text-txt">{result.toRank}</span>
          {/* Only surfaced when it is actually true — a banked point is the one
              case where the recommendation is for a level BELOW the player's
              own, and saying nothing would make the panel look stuck. */}
          {result.unspent > 1 && (
            <span className="text-[10.5px] font-medium text-teal-dim ml-2">{result.unspent} points banked</span>
          )}
        </p>
      </div>
    </section>
  );
}
