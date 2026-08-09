"use client";

import { useEffect, useRef, useState } from "react";
import { useCompanion } from "@/components/live/CompanionProvider";
import { getSkills, getStoredPort, SKILL_POLL_MS } from "@/components/live/companionClient";
import { fetchSkillOrder, fetchSkillOrderBestLane, type SkillOrderModel } from "@/components/hextech/skillOrder";
import { LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import { resolveNextSkill, type LiveSkillState } from "@/lib/nextSkill";
import CompanionOverlayWidget, { OverlayWaiting, type OverlayScale } from "./CompanionOverlayWidget";

interface LiveCompanionOverlayProps {
  championId: number | null;
  lane: LaneId | null;
  scale?: OverlayScale;
}

interface ChampionNameRow {
  id: number;
  name: string;
}

/**
 * The live half of the overlay. The decision still belongs entirely to
 * lib/nextSkill.ts; this component only fetches the same skill-order model and
 * /skills snapshot that the former compact panel used, then presents every
 * resolver outcome honestly instead of turning refusals into a blank frame.
 */
export default function LiveCompanionOverlay({ championId, lane, scale = "compact" }: LiveCompanionOverlayProps) {
  const companion = useCompanion();
  const [model, setModel] = useState<SkillOrderModel | null>(null);
  const [live, setLive] = useState<LiveSkillState | null>(null);
  const [championName, setChampionName] = useState("Champion");
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    if (championId == null || championId <= 0) {
      return;
    }

    fetch("/api/champions")
      .then((response) => (response.ok ? (response.json() as Promise<ChampionNameRow[]>) : []))
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        const match = rows.find((row) => row.id === championId);
        if (match?.name) setChampionName(match.name);
      })
      .catch(() => {
        /* The widget can still identify the recommendation by key. */
      });

    return () => {
      cancelled = true;
    };
  }, [championId]);

  useEffect(() => {
    let cancelled = false;
    if (championId == null || championId <= 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- invalid identity drops the previous model.
      setModel(null);
      return;
    }

    setModel(null);
    const request = lane
      ? fetchSkillOrder(championId, LANE_TO_ROLE_ID[lane])
      : fetchSkillOrderBestLane(championId);

    void request.then((result) => {
      if (cancelled) return;
      setModel(result.status === "ok" ? result.model : null);
    });

    return () => {
      cancelled = true;
    };
  }, [championId, lane]);

  const inGame = companion.statusFresh && companion.phase === "InProgress";
  const session = companion.session;

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new game/session must not retain the prior live snapshot.
    setLive(null);
    requestRef.current += 1;
    if (!inGame || !session) return;
    const currentSession = session;

    let cancelled = false;
    const generation = requestRef.current;

    async function tick() {
      const port = getStoredPort();
      if (port == null) return;
      const next = await getSkills(port, currentSession, {});
      if (cancelled || requestRef.current !== generation) return;
      setLive(next);
    }

    void tick();
    const interval = setInterval(() => void tick(), SKILL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [inGame, session]);

  if (championId == null || championId <= 0) {
    return <OverlayWaiting scale={scale} message="Waiting for champ select" />;
  }

  if (!inGame) {
    return <OverlayWaiting scale={scale} message="Waiting for an in-game live read" />;
  }

  if (!live) {
    return <OverlayWaiting scale={scale} message="Reading your next legal point" />;
  }

  if (!model) {
    return <OverlayWaiting scale={scale} message="Loading the recommended skill order" />;
  }

  const result = resolveNextSkill({ model, level: live.level, ranks: live.abilities });
  if (result.kind === "recommend") {
    return (
      <CompanionOverlayWidget
        championName={championName}
        level={live.level}
        state={result.ability === "R" ? "ultimate" : "next"}
        ability={result.ability}
        fromRank={result.fromRank}
        toRank={result.toRank}
        scale={scale}
        liveSignal={inGame && companion.statusFresh && companion.clientConnected && session !== null}
      />
    );
  }

  return (
    <CompanionOverlayWidget
      championName={championName}
      level={live.level}
      state="refusal"
      scale={scale}
      liveSignal={inGame && companion.statusFresh && companion.clientConnected && session !== null}
      refusalLabel={
        live.level > 15 && (result.because === "model-incomplete" || result.because === "order-exhausted")
          ? "Refuses past level 15"
          : "No safe recommendation"
      }
    />
  );
}
