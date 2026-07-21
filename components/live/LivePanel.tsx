"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LivePanel.tsx — shown on the home page's BUILD tab only while the
// companion reports gameflow phase InProgress (app/page.tsx gates mounting
// this). Owns its OWN 1s poll of companionClient.getLive() (plan §2d) and its
// own /api/build fetch for `items` (ItemsBlock) — deliberately decoupled from
// BuildTabContent.tsx's own fetch/state rather than prop-drilled through it
// (BuildTabContent.tsx is out of this dispatch's file scope; see
// HANDOFF-fronty.md for the full reasoning). The extra /api/build request is
// cheap: that route is CDN-cached 6h (s-maxage=21600).
//
// Compliance (plan §3): only ever renders champion icons + normalized
// positions from livePanelModel.ts — never a name, never a cooldown/timer.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import type { BuildResponse, ChampionRef, ItemsBlock } from "@/lib/types";
import type { LaneId } from "@/components/hextech/heroContracts";
import { LANE_TO_ROLE_ID } from "@/components/hextech/heroContracts";
import { versionFromPatch } from "@/components/proAssets";
import { IconWithFallback } from "@/components/IconWithFallback";
import ItemDetailPopover from "@/components/ItemDetailPopover";
import { useBodyScrollLock } from "@/components/useBodyScrollLock";
import SituationalCard from "@/components/hextech/SituationalCard";
import { flattenSituational } from "@/components/hextech/situational";
import { getStoredSession, getStoredPort, getLive, isLiveError, LIVE_POLL_MS } from "./companionClient";
import { buildLivePanelModel, indexChampionsByKey, sameLivePanelModel, type LivePanelModel } from "./livePanelModel";
import { selectCompAwareHighlights } from "./compHighlight";

interface LivePanelProps {
  champ: ChampionRef;
  lane: LaneId;
}

export default function LivePanel({ champ, lane }: LivePanelProps) {
  const [model, setModel] = useState<LivePanelModel | null>(null);
  const [champByKey, setChampByKey] = useState<Map<string, ChampionRef> | null>(null);
  const [items, setItems] = useState<ItemsBlock | null>(null);
  const [patch, setPatch] = useState<string | null>(null);

  const [activeItemId, setActiveItemId] = useState<number | null>(null);
  const [lastItemId, setLastItemId] = useState<number | null>(null);
  useBodyScrollLock(activeItemId !== null);

  // Own decoupled /api/build fetch for the situational-item data this panel
  // needs — see header comment. Re-fetches on champ/lane change same as
  // BuildTabContent's own effect, own stale-response guard (gotcha (q)).
  useEffect(() => {
    let cancelled = false;
    const roleId = LANE_TO_ROLE_ID[lane];
    fetch(`/api/build?champ=${champ.id}&role=${roleId}`)
      .then((r) => (r.ok ? (r.json() as Promise<BuildResponse[]>) : null))
      .then((data) => {
        if (cancelled) return;
        if (Array.isArray(data) && data[0]) {
          setItems(data[0].items);
          setPatch(data[0].patch);
        }
      })
      .catch(() => {
        /* items are decorative here — panel still shows the enemy comp */
      });
    return () => {
      cancelled = true;
    };
  }, [champ.id, lane]);

  // Champion key->ChampionRef index for resolving enemy icons (Live Client
  // Data identifies champions by KEY, not coachless's numeric id — see
  // livePanelModel.ts's header comment). One fetch, independent of the
  // page's own champion state.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/champions")
      .then((r) => (r.ok ? (r.json() as Promise<ChampionRef[]>) : []))
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setChampByKey(indexChampionsByKey(list));
      })
      .catch(() => {
        /* icons degrade to fallback glyphs via IconWithFallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The actual live-client-data poll (plan §2d spec'd 1s; Round-B P2 slowed
  // it to LIVE_POLL_MS=3000 — the enemy roster this panel derives is fixed
  // for the whole game, so 1s bought nothing but subtree churn). Also
  // shallow-compares the derived model against the previous tick's (via the
  // functional setState form below) and skips the setState entirely when
  // the enemy set is unchanged — belt-and-braces with the slower interval,
  // see sameLivePanelModel's own doc comment in livePanelModel.ts.
  useEffect(() => {
    const session = getStoredSession();
    const port = getStoredPort();
    if (!session || !port) return;
    let cancelled = false;

    async function tick() {
      const live = await getLive(port!, session!);
      if (cancelled) return;
      if (!live || isLiveError(live)) {
        setModel((prev) => (prev === null ? prev : null));
        return;
      }
      const next = buildLivePanelModel(live, champ.key);
      setModel((prev) => (sameLivePanelModel(prev, next) ? prev : next));
    }

    tick();
    const id = setInterval(tick, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // champ.key intentionally NOT in deps beyond the initial mount — a
    // champion swap mid-live-game can't happen (you can't change champion
    // after the game starts), so re-keying this poll isn't needed; the
    // champ/lane-keyed items fetch above already handles the one case that
    // DOES change (viewing a different lane/champion while a game is live
    // elsewhere).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openItem(id: number) {
    setLastItemId(id);
    setActiveItemId(id);
  }
  function closeItem() {
    setActiveItemId(null);
  }
  useEffect(() => {
    if (activeItemId === null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeItem();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [activeItemId]);

  if (!model || model.enemies.length === 0) return null;

  const enemyChampionIds = model.enemies
    .map((e) => champByKey?.get(e.championKey)?.id)
    .filter((id): id is number => typeof id === "number");
  const highlightIds = items ? selectCompAwareHighlights(flattenSituational(items), enemyChampionIds) : [];
  const ver = versionFromPatch(patch ?? undefined);

  return (
    <div className="bg-panel border border-line-gold rounded-xl p-5 mt-5">
      <div className="flex items-center gap-2 mb-3.5">
        <span
          className="w-1.5 h-1.5 rounded-full bg-teal animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-[10.5px] tracking-[0.14em] uppercase text-mut font-semibold">Live game detected</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap mb-4" role="group" aria-label="Enemy team">
        {model.enemies.map((e, i) => {
          const ref = champByKey?.get(e.championKey);
          const name = ref?.name ?? e.championKey;
          return (
            <span key={`${e.championKey}-${i}`} className="flex flex-col items-center gap-1 w-11" title={name}>
              <span className="w-8 h-8 rounded-full bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0">
                <IconWithFallback
                  src={ref?.icon ?? ""}
                  alt={name}
                  fallbackGlyph={name}
                  className="w-full h-full object-cover"
                  size={32}
                />
              </span>
              {e.position && <span className="text-[8.5px] uppercase text-mut">{e.position}</span>}
            </span>
          );
        })}
      </div>

      {items && <SituationalCard items={items} onItemClick={openItem} highlightIds={highlightIds} />}

      {lastItemId !== null && (
        <ItemDetailPopover itemId={lastItemId} ver={ver} open={activeItemId !== null} onClose={closeItem} />
      )}
    </div>
  );
}
