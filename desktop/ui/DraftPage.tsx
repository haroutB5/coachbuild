"use client";

import { useEffect, useRef, useState } from "react";
import type { ChampionRef } from "@/lib/types";
import { loadDdragon } from "@/lib/ddragonClient";
import DraftControls from "@/components/hextech/draft/DraftControls";
import CounterPicksStrip from "@/components/hextech/draft/CounterPicksStrip";
import { LANE_ORDER, LANE_LABEL, type LaneId } from "@/components/hextech/heroContracts";
import { refreshStatus, getStoredSession, setStoredSession, type CompanionStatus } from "@/components/live/companionClient";
import { resolveDraftLiveTarget, resolveChampSelectEntry, INITIAL_CHAMP_SELECT_ENTRY_STATE } from "@/components/live/draftLiveSync";
import { loadLocalCounters } from "./localCounters";
import { localBridgeFetch } from "./localBridge";

const laneOptions = LANE_ORDER.map(value => ({ value, label: LANE_LABEL[value] }));

export default function DraftPage() {
  const [champions, setChampions] = useState<ChampionRef[]>([]);
  const [championError, setChampionError] = useState(false);
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [lane, setLane] = useState<LaneId>("mid");
  const [hover, setHover] = useState<number | null>(null);
  const [enemyIds, setEnemyIds] = useState<number[]>([]);
  const [allyIds, setAllyIds] = useState<number[]>([]);
  const [laneOpponentId, setLaneOpponentId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pool, setPool] = useState<number[] | null>(null);
  const entry = useRef(INITIAL_CHAMP_SELECT_ENTRY_STATE);

  useEffect(() => {
    let stopped = false;
    loadDdragon().then(data => { if (!stopped) setChampions(data.champions); }).catch(() => { if (!stopped) setChampionError(true); });
    const url = new URL(window.location.href);
    const session = url.searchParams.get("session");
    if (session) {
      setStoredSession(session);
      url.searchParams.delete("session");
      window.history.replaceState(null, "", url);
    }
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const token = getStoredSession();
      const result = token ? await refreshStatus(token, {}, "draft") : null;
      if (stopped) return;
      setStatus(result?.kind === "connected" ? result.status : null);
      timer = setTimeout(poll, result?.kind === "connected" && result.status.phase === "ChampSelect" ? 1000 : 3000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    const transition = resolveChampSelectEntry(entry.current, status?.phase ?? null);
    entry.current = transition.next;
    // This effect applies an external LCU snapshot as one consistent UI update.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (transition.isEntry) { setDirty(false); setLaneOpponentId(null); setAllyIds([]); }
    const target = resolveDraftLiveTarget({ phase: status?.phase ?? null, champSelect: status?.champSelect ?? null, dirty: transition.isEntry ? false : dirty });
    if (!target) return;
    if (target.lane) setLane(target.lane);
    setEnemyIds(target.enemies);
    setHover(target.hover);
    setLaneOpponentId(current => current !== null && target.enemies.includes(current) ? current : null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [status, dirty]);

  useEffect(() => {
    if (!status?.clientConnected) return;
    const controller = new AbortController();
    localBridgeFetch("/draft/pool", controller.signal).then(async response => {
      if (!response.ok) throw new Error("Pool unavailable");
      const value: unknown = await response.json();
      if (!controller.signal.aborted && Array.isArray(value)) setPool(value.filter((id): id is number => Number.isInteger(id) && id > 0));
    }).catch(() => { if (!controller.signal.aborted) setPool(null); });
    return () => controller.abort();
  }, [status?.clientConnected]);

  function handleLaneChange(value: LaneId) { setDirty(true); setLane(value); }
  function handleHoverChange(champ: ChampionRef) { setDirty(true); setHover(champ.id); }
  function handleClearHover() { setDirty(true); setHover(null); }
  function handleAddEnemy(champ: ChampionRef) { setDirty(true); setEnemyIds(ids => ids.includes(champ.id) ? ids : [...ids, champ.id].slice(0, 5)); }
  function handleRemoveEnemy(id: number) { setDirty(true); setEnemyIds(ids => ids.filter(x => x !== id)); if (laneOpponentId === id) setLaneOpponentId(null); }
  function handleToggleLaneOpponent(id: number) { setLaneOpponentId(current => current === id ? null : id); }
  const icons = new Map(champions.map(champ => [champ.id, champ]));
  const counterEnemy = laneOpponentId ?? enemyIds[0] ?? null;

  return <main className="mx-auto max-w-[1200px] space-y-5 p-6">
    <header className="flex items-center justify-between gap-4">
      <div><h1 className="text-2xl font-semibold">Draft assistant</h1><p className="text-sm text-mut">Your picks, lane opponent and live champ select</p></div>
      <a href="#live-setup" className="text-accent-300">Connection status</a>
    </header>
    {championError && <p role="alert">Champion data is unavailable from DDragon. Check your connection and reload.</p>}
    <DraftControls lane={lane} laneOptions={laneOptions} onLaneChange={handleLaneChange}
      hover={hover} allyIds={allyIds} champIcons={icons} onPick={handleHoverChange} onClearPick={handleClearHover}
      onAddAlly={champ => setAllyIds(ids => ids.includes(champ.id) ? ids : [...ids, champ.id].slice(0, 4))}
      onRemoveAlly={id => setAllyIds(ids => ids.filter(x => x !== id))}
      enemyIds={enemyIds} effectiveLaneOpponentId={laneOpponentId} laneOpponentId={laneOpponentId}
      serverInferredLaneOpponentId={null} onAddEnemy={handleAddEnemy} onRemoveEnemy={handleRemoveEnemy}
      onToggleLaneOpponent={handleToggleLaneOpponent} enemyAnalysis={null} hoverSelected={hover !== null} />
    {dirty && <button className="rounded bg-accent px-4 py-2 text-bg" onClick={() => setDirty(false)}>Reset to live</button>}
    <p className="text-sm text-mut">Mark an enemy as your lane opponent to prioritise their counters. Without a mark, counters use the first visible enemy.</p>
    <CounterPicksStrip enemyId={counterEnemy} enemyName={counterEnemy ? icons.get(counterEnemy)?.name ?? null : null}
      lane={lane} champIcons={icons} mystatsPoolChampIds={[]} lcuPoolChampIds={status?.clientConnected ? pool : null} loadCounters={loadLocalCounters} />
    <section className="rounded-lg bg-panel p-4"><h2 className="font-semibold">On lock-in</h2>
      <p className="mt-2 text-sm text-mut">Items import from u.gg and Coachless through the desktop tabs. Use the runes button on u.gg to apply runes.</p>
    </section>
    <section id="live-setup" className="rounded-lg bg-panel p-4" aria-live="polite">
      <h2 className="font-semibold">Live setup</h2>
      <p className="mt-2 text-sm">{status ? `Companion ${status.version} · ${status.clientConnected ? status.phase : "Open the League client"}` : "Companion disconnected. Reopen Draft from the desktop tray to reconnect."}</p>
      {status?.lastError && <p className="text-bad">{status.lastError}</p>}
    </section>
  </main>;
}
