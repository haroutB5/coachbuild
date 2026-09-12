"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, CaretRight, Clock } from "@phosphor-icons/react";
import type { ChampionRef } from "@/lib/types";
import { loadDdragon } from "@/lib/ddragonClient";
import DraftControls from "@/components/hextech/draft/DraftControls";
import CounterPicksStrip from "@/components/hextech/draft/CounterPicksStrip";
import LaneScoreCard from "@/components/hextech/draft/LaneScoreCard";
import LaneHistoryPanel from "@/components/hextech/draft/LaneHistoryPanel";
import { LANE_ORDER, LANE_LABEL, LANE_TO_ROLE_ID, type LaneId } from "@/components/hextech/heroContracts";
import { fetchPendingLaneScore, fetchLaneRecommendations, submitLaneScore, skipLaneScore } from "@/components/live/laneScoresClient";
import { refreshStatus, getStoredSession, setStoredSession, type CompanionStatus } from "@/components/live/companionClient";
import { resolveDraftLiveTarget, resolveChampSelectEntry, INITIAL_CHAMP_SELECT_ENTRY_STATE } from "@/components/live/draftLiveSync";
import { loadLocalCounters } from "./localCounters";

const laneOptions = LANE_ORDER.map(value => ({ value, label: LANE_LABEL[value] }));

const DRAFT_CSS = `
.d25-root { background: #0A1420; color: #E8EEF5; font-family: "Segoe UI", system-ui, sans-serif; min-height: 100vh; }
.d25-root button { font-family: inherit; }
.d25-root button:focus-visible, .d25-root select:focus-visible, .d25-root textarea:focus-visible,
.d25-root input:focus-visible { outline: 2px solid #F2BE4F; outline-offset: 2px; }
.d25-sronly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.d25-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-top: -6px; }
.d25-headtext { margin-left: 7px; }
.d25-title { margin: 0; font-size: 36px; line-height: 36px; font-weight: 700; color: #F2F6FA; }
.d25-subtitle { margin: 0; font-size: 19px; line-height: 22px; color: #C6D2DF; }
.d25-pill { position: relative; display: inline-flex; align-items: center; gap: 8px; height: 40px; margin-top: 4px;
  padding: 0 19px 0 22px; border-radius: 20px; border: 1px solid #2B3D53; background: #0E1A28; color: #E8EEF5;
  font-size: 16px; cursor: pointer; white-space: nowrap; box-sizing: border-box; }
.d25-pill:hover { border-color: #F2BE4F; }
.d25-pilldot { position: absolute; top: -4px; right: 10px; width: 8px; height: 8px; border-radius: 50%; background: #F2BE4F; }
.d25-teamcard { display: flex; align-items: stretch; margin-top: 11px; min-height: 139px;
  background: #0E1A28; border: 1px solid #1D2C3F; border-radius: 10px; padding: 15px 16px 6px; box-sizing: border-box; }
.d25-rolecol { width: 180px; flex-shrink: 0; padding-top: 31px; }
.d25-rolelabel { display: block; font-size: 16px; line-height: 18px; color: #C6D2DF; margin-bottom: 9px; }
.d25-roletrigger { min-height: 44px; font-size: 18px !important; font-weight: 600; background: #0E1A28 !important;
  border: 1px solid #2B3D53 !important; border-radius: 6px !important; }
.d25-div { width: 1px; align-self: stretch; background: #1D2C3F; margin-left: 37px; flex-shrink: 0; }
.d25-div2 { margin-left: 94px; }
.d25-teamblock { margin-left: 32px; min-width: 0; }
.d25-teamblock-enemy { margin-left: 56px; }
.d25-teamlabel-you { margin: 0; font-size: 15px; line-height: 18px; font-weight: 700; letter-spacing: 0.06em; color: #3ED6B5; }
.d25-teamlabel-enemy { margin: 0; font-size: 15px; line-height: 18px; font-weight: 700; letter-spacing: 0.06em; color: #F26B5B; }
.d25-slots { display: flex; gap: 10px; margin-top: 9px; }
.d25-slots-enemy { gap: 16px; }
.d25-slotwrap { display: flex; flex-direction: column; align-items: center; width: 68px; flex-shrink: 0; }
.d25-slot { position: relative; width: 68px; height: 68px; border-radius: 6px; border: 1px solid #2E3F54;
  background: #101E2E; box-sizing: border-box; }
.d25-slot-you-empty { border-color: #D8E2EE; }
.d25-slot-laneopp { border: 2px solid #F2BE4F; }
.d25-slotimg { width: 100%; height: 100%; border-radius: 5px; object-fit: cover; display: block; }
.d25-slot-laneopp .d25-slotimg { border-radius: 4px; }
.d25-slotempty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  background: transparent; border: 0; border-radius: 6px; cursor: pointer; position: relative; }
.d25-slotempty:hover { background: rgba(242,190,79,0.08); }
.d25-slotoverlay { position: absolute; inset: 0; border-radius: 5px; background: transparent; border: 0; cursor: pointer; }
.d25-slotoverlay:hover { background: rgba(242,190,79,0.12); }
.d25-youbadge { position: absolute; top: 2px; left: 2px; padding: 2px 6px; border-radius: 4px;
  background: #F2BE4F; color: #1A1405; font-size: 13px; font-weight: 700; line-height: 14px; }
.d25-oppbadge { position: absolute; top: 5px; left: 5px; width: 24px; height: 24px; border-radius: 50%;
  border: 2px solid #F2BE4F; background: rgba(10,20,32,0.85); display: flex; align-items: center; justify-content: center; }
.d25-slotname { margin-top: 6px; font-size: 15px; line-height: 17px; color: #E8EEF5; text-align: center;
  max-width: 76px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d25-remove { position: absolute; top: -8px; right: -8px; z-index: 2; width: 18px; height: 18px; border-radius: 50%;
  background: #0E1A28; border: 1px solid #2B3D53; color: #9AABBF; font-size: 12px; line-height: 1; cursor: pointer; padding: 0;
  opacity: 0; }
.d25-slotwrap:hover .d25-remove, .d25-slotwrap:focus-within .d25-remove { opacity: 1; }
.d25-remove:hover { color: #F2555A; border-color: #F2555A; }
.d25-pickerwrap { margin-top: 8px; min-width: 240px; }
.d25-teambtns { margin-left: auto; padding-left: 24px; display: flex; flex-direction: column; gap: 11px; justify-content: flex-start; flex-shrink: 0; }
.d25-btn-gold { width: 147px; height: 40px; border-radius: 6px; border: 0; background: #F2BE4F; color: #1A1405;
  font-size: 16px; font-weight: 600; cursor: pointer; }
.d25-btn-gold:hover { background: #F7CB6B; }
.d25-btn-outline { min-width: 147px; min-height: 40px; border-radius: 6px; border: 1px solid #2B3D53;
  background: #0E1A28; color: #E8EEF5; font-size: 16px; cursor: pointer; padding: 8px 12px; }
.d25-btn-outline:hover { border-color: #F2BE4F; }
.d25-counters { margin-top: 6px; }
.d25-chead { display: flex; align-items: center; gap: 19px; }
.d25-chead-portrait { width: 66px; height: 66px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.d25-chead-mid { min-width: 0; }
.d25-chead-row { display: flex; align-items: center; gap: 14px; }
.d25-chead-title { margin: 0; font-size: 30px; line-height: 34px; font-weight: 700; color: #E8EEF5; white-space: nowrap; }
.d25-pill-laneopp { font-size: 14px; color: #C9D5E2; border: 1px solid #2B3D53; border-radius: 14px; padding: 4px 12px; white-space: nowrap; }
.d25-meta { margin: 4px 0 0; font-size: 17px; color: #AFC0D2; }
.d25-hint { margin: 20px 0 0 auto; font-size: 15px; color: #AFC0D2; white-space: nowrap; align-self: flex-start; }
.d25-cempty-hint { font-size: 17px; color: #AFC0D2; margin: 8px 0 12px; }
.d25-warn { display: flex; align-items: center; gap: 10px; margin: 12px 0 0; font-size: 15px; line-height: 20px; color: #F2BE4F; }
.d25-loading { font-size: 15px; color: #AFC0D2; }
.d25-tables { display: flex; gap: 17px; margin-top: 12px; }
.d25-tcard { position: relative; flex: 1 1 0; min-width: 0; background: #0E1A28; border: 1px solid #1D2C3F;
  border-radius: 10px; padding: 15px 17px 9px; box-sizing: border-box; }
.d25-ttitle { margin: 0 90px 0 10px; font-size: 22px; line-height: 25px; font-weight: 700; color: #E8EEF5; }
.d25-tsub { margin: 3px 90px 0 10px; font-size: 17px; line-height: 21px; color: #AFC0D2; }
.d25-badge { position: absolute; top: 12px; right: 17px; font-size: 15px; color: #C9D5E2;
  border: 1px solid #2B3D53; border-radius: 6px; padding: 4px 12px; white-space: nowrap; }
.d25-thead { display: grid; grid-template-columns: 42px minmax(0,1fr) 110px 70px; align-items: center;
  background: #132236; border-radius: 4px; height: 24px; margin-top: 14px; padding: 0 12px 0 0;
  font-size: 15px; color: #C6D2DF; box-sizing: border-box; }
.d25-h-idx { text-align: center; }
.d25-h-champ { padding-left: 0; }
.d25-h-val, .d25-h-games { text-align: right; }
.d25-tbody { list-style: none; margin: 2px 0 0; padding: 0; }
.d25-trow { display: grid; grid-template-columns: 42px minmax(0,1fr) 110px 70px; align-items: center;
  height: 39px; padding-right: 12px; border-bottom: 1px solid #1A2A3D; box-sizing: border-box; }
.d25-trow:last-child { border-bottom: 0; }
/* Centred in a 42px column so 10-15 clear the portrait (all rows show). */
.d25-idx { font-size: 17px; color: #E8EEF5; text-align: center; }
.d25-champ { display: flex; align-items: center; gap: 16px; min-width: 0; }
.d25-cicon { width: 32px; height: 32px; border-radius: 4px; object-fit: cover; flex-shrink: 0; }
.d25-cname { font-size: 17px; color: #E8EEF5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d25-clast { display: block; font-size: 11px; color: #9AABBF; }
.d25-val-gold { font-size: 17px; font-weight: 700; color: #4ADE80; text-align: right; font-variant-numeric: tabular-nums; }
.d25-val-wr { font-size: 17px; font-weight: 700; color: #F2555A; text-align: right; font-variant-numeric: tabular-nums; }
.d25-val-good { font-size: 15px; font-weight: 700; color: #4ADE80; text-align: right; font-variant-numeric: tabular-nums; }
.d25-val-bad { font-size: 15px; font-weight: 700; color: #F2555A; text-align: right; font-variant-numeric: tabular-nums; }
.d25-games { font-size: 17px; color: #E8EEF5; text-align: right; font-variant-numeric: tabular-nums; }
.d25-trow-history .d25-games { font-size: 15px; }
.d25-single { font-size: 12px; font-weight: 600; color: #C9D5E2; border: 1px solid #2B3D53; border-radius: 6px;
  padding: 2px 8px; text-align: right; justify-self: end; white-space: nowrap; }
.d25-tempty { font-size: 15px; color: #AFC0D2; margin: 12px 0 4px 10px; }
.d25-footnote { margin: 11px 0 0; font-size: 14px; line-height: 16px; color: #AFC0D2; }
.d25-history { margin-top: 16px; }
.d25-history-title { margin: 0; font-size: 22px; font-weight: 700; }
.d25-history-sub { margin: 4px 0 0; font-size: 15px; color: #AFC0D2; }
.d25-history .d25-tables { margin-top: 12px; }
.d25-history-error { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.d25-imports { display: flex; align-items: center; margin-top: 11px; min-height: 72px;
  background: #0E1A28; border: 1px solid #1D2C3F; border-radius: 10px; padding: 8px 20px; box-sizing: border-box; flex-wrap: wrap; row-gap: 8px; }
.d25-imports-icon { flex-shrink: 0; }
.d25-imports-text { margin-left: 22px; min-width: 0; }
.d25-imports-title { font-size: 18px; font-weight: 700; }
.d25-imports-sub { font-size: 13px; color: #AFC0D2; }
.d25-imports-sub2 { margin: 0; font-size: 13px; color: #AFC0D2; }
.d25-imports-right { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; row-gap: 8px; }
.d25-chip { display: inline-flex; align-items: center; gap: 10px; height: 42px; padding: 0 16px;
  border: 1px solid #2B3D53; border-radius: 6px; background: #0E1A28; color: #E8EEF5; font-size: 16px; margin-left: 17px; white-space: nowrap; }
.d25-logotile { width: 24px; height: 24px; border-radius: 4px; background: #1B2A3C; color: #FFFFFF;
  font-weight: 700; font-size: 15px; display: inline-flex; align-items: center; justify-content: center; }
.d25-imports-div { width: 1px; align-self: stretch; min-height: 42px; background: #1D2C3F; margin-left: 28px; }
.d25-status { display: flex; align-items: center; gap: 10px; margin-left: 22px; font-size: 16px; color: #C6D2DF; white-space: nowrap; }
.d25-statusdot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
.d25-panelroot { position: fixed; inset: 0; z-index: 60; }
.d25-backdrop { position: absolute; inset: 0; background: rgba(4,10,18,0.55); }
.d25-panel { position: absolute; top: 100px; right: 22px; width: 595px; max-width: calc(100vw - 32px);
  max-height: calc(100vh - 121px); overflow-y: auto; background: #0E1A28; border: 1px solid #1D2C3F;
  border-radius: 10px; padding: 16px 19px 14px; box-sizing: border-box; color: #E8EEF5; }
.d25-panel-head { display: flex; align-items: center; gap: 14px; }
.d25-panel-title { margin: 0; font-size: 23px; font-weight: 700; }
.d25-qpill { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 14px;
  border: 1px solid #2B3D53; border-radius: 6px; background: #0E1A28; font-size: 15px; color: #E8EEF5; }
.d25-panel-close { margin-left: 4px; width: 32px; height: 32px; border-radius: 6px; border: 1px solid #2B3D53;
  background: transparent; color: #9AABBF; font-size: 18px; cursor: pointer; line-height: 1; padding: 0; }
.d25-panel-close:hover { color: #E8EEF5; border-color: #F2BE4F; }
.d25-panel-empty { font-size: 16px; color: #AFC0D2; margin: 24px 0; }
.d25-panel-h { margin: 12px 0 0; font-size: 19px; font-weight: 700; }
.d25-matchup { display: flex; align-items: center; margin-top: 14px; }
.d25-matchside { display: flex; align-items: center; gap: 17px; width: 216px; flex: none; }
.d25-matchtext { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.d25-matchimg { width: 76px; height: 76px; border-radius: 4px; border: 1px solid #2B3D53; object-fit: cover; }
.d25-matchimg-empty { display: flex; align-items: center; justify-content: center; font-size: 32px; color: #6F8196; background: #101E2E; }
.d25-matchname { font-size: 18px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d25-matchsub { font-size: 15px; color: #AFC0D2; white-space: nowrap; }
.d25-vs { width: 24px; margin: 0 60px 0 26px; text-align: center; font-size: 20px; font-weight: 700; color: #9AABBF; flex: none; }
.d25-hr { border: 0; border-top: 1px solid #1D2C3F; margin: 12px 0 0; }
.d25-panel-note { font-size: 14px; color: #AFC0D2; margin: 8px 0 0; }
.d25-tiles { display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap; }
.d25-tilewrap { display: flex; flex-direction: column; align-items: center; width: 100px; }
.d25-tile { position: relative; width: 100px; height: 90px; border-radius: 6px; border: 1px solid #2B3D53;
  background: #101E2E; padding: 0; cursor: pointer; overflow: visible; }
.d25-tile:disabled { cursor: default; }
.d25-tile-sel { border: 2px solid #F2BE4F; }
.d25-tileimg { width: 100%; height: 100%; border-radius: 5px; object-fit: cover; display: block; }
.d25-check { position: absolute; top: -12px; right: -12px; width: 24px; height: 24px; border-radius: 50%;
  background: #F2BE4F; display: flex; align-items: center; justify-content: center; }
.d25-tilename { margin-top: 6px; font-size: 15px; text-align: center; max-width: 100px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d25-prevrole { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
.d25-prevrole-label { font-size: 17px; font-weight: 600; }
.d25-prevrole-select { width: 176px; height: 34px; border-radius: 6px; border: 1px solid #2B3D53;
  appearance: none; -webkit-appearance: none; color: #E8EEF5; font-size: 16px; font-weight: 600;
  padding: 0 32px 0 12px; font-family: inherit; cursor: pointer; background: #0E1A28; }
.d25-prevrole-select option { background: #0E1A28; color: #E8EEF5; }
.d25-selectwrap { position: relative; display: inline-flex; }
.d25-selectcaret { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; color: #C6D2DF; }
.d25-prevrole-value { font-size: 15px; color: #E8EEF5; }
.d25-scores { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.d25-scorebtn { width: 48px; height: 46px; border-radius: 4px; border: 1px solid #2B3D53; background: #0E1A28;
  color: #E8EEF5; font-size: 18px; font-weight: 600; cursor: pointer; padding: 0; }
.d25-scorebtn-sel { background: #F2BE4F; border-color: #F2BE4F; color: #1A1405; }
.d25-scalelabels { display: flex; justify-content: space-between; margin-top: 10px; font-size: 15px; color: #AFC0D2; }
.d25-notelabel { display: block; margin-top: 12px; font-size: 17px; }
.d25-note { display: block; width: 100%; margin-top: 8px; border-radius: 4px; border: 1px solid #2B3D53;
  background: #0E1A28; color: #E8EEF5; font-size: 16px; padding: 10px 12px; resize: vertical; box-sizing: border-box; font-family: inherit;
  height: 53px; min-height: 53px; }
.d25-note::placeholder { color: #8193A7; }
.d25-counter { display: block; text-align: right; font-size: 15px; color: #9AABBF; margin-top: 4px; }
.d25-panel-error { font-size: 14px; color: #F2555A; margin: 8px 0 0; }
.d25-panel-actions { display: flex; align-items: center; margin-top: 12px;
  position: sticky; bottom: -14px; z-index: 1; background: #0E1A28; padding: 10px 0 14px; }
.d25-savebtn { width: 344px; max-width: 60%; height: 46px; border-radius: 6px; border: 0; background: #F2BE4F;
  color: #1A1405; font-size: 17px; font-weight: 700; cursor: pointer; }
.d25-savebtn:disabled { opacity: 0.45; cursor: not-allowed; }
.d25-skipbtn { margin: 0 auto; background: transparent; border: 0; color: #E8EEF5; font-size: 17px;
  font-weight: 600; cursor: pointer; padding: 8px 12px; }
.d25-skipbtn:hover { color: #F2BE4F; }
.d25-stored { margin: 15px 0 0; font-size: 14px; color: #AFC0D2; }
.d25-livesetup { margin-top: 16px; background: #0E1A28; border: 1px solid #1D2C3F; border-radius: 10px; padding: 16px; }
.d25-livesetup h2 { margin: 0; font-size: 18px; font-weight: 700; }
.d25-livesetup p { font-size: 14px; color: #C6D2DF; }
/* 2.5.1: below the mockup width the Manual draft / Reset to live column no
   longer fits beside both teams (it overlapped the 5th enemy slot at the
   default 1280 px window), so only it moves to a row under the teams. */
@media (max-width: 1539px) {
  .d25-teamcard { flex-wrap: wrap; row-gap: 12px; }
  /* Tighter team spacing keeps both teams on one row down to the 1199px
     stack: the default 1280 window gives the page only 1268px (2.5.2 edge
     + resize inset), and the mockup spacing needs 1275. */
  .d25-div2 { margin-left: 48px; }
  .d25-teamblock-enemy { margin-left: 40px; }
  .d25-slots-enemy { gap: 10px; }
  .d25-teambtns { margin-left: 0; padding-left: 0; flex: 1 1 100%; flex-direction: row; justify-content: flex-end; }
}
@media (max-width: 1199px) {
  .d25-tables { flex-direction: column; }
  .d25-teamcard { flex-wrap: wrap; row-gap: 16px; }
  .d25-teamcard .d25-div { display: none; }
  .d25-teamblock { margin-left: 0; margin-right: 0; }
  .d25-teamblock-you { margin-right: 32px; }
  .d25-rolecol { width: 180px; padding-top: 0; }
  .d25-teambtns { margin-left: 0; padding-left: 0; flex: 1 1 100%; flex-direction: row; }
  .d25-hint { display: none; }
  .d25-chead { flex-wrap: wrap; }
}
`;

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
  const [historyRevision, setHistoryRevision] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [hasPendingScore, setHasPendingScore] = useState(false);
  const [hash, setHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
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
    function onHashChange() { setHash(window.location.hash); }
    window.addEventListener("hashchange", onHashChange);
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const token = getStoredSession();
      const result = token ? await refreshStatus(token, {}, "draft") : null;
      if (stopped) return;
      setStatus(result?.kind === "connected" ? result.status : null);
      timer = setTimeout(poll, result?.kind === "connected" && result.status.phase === "ChampSelect" ? 1000 : 3000);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); window.removeEventListener("hashchange", onHashChange); };
  }, []);

  useEffect(() => {
    const transition = resolveChampSelectEntry(entry.current, status?.phase ?? null);
    entry.current = transition.next;
    // This effect applies an external LCU snapshot as one consistent UI update.
    if (transition.isEntry) { setDirty(false); setLaneOpponentId(null); setAllyIds([]); }
    const target = resolveDraftLiveTarget({ phase: status?.phase ?? null, champSelect: status?.champSelect ?? null, dirty: transition.isEntry ? false : dirty });
    if (!target) return;
    if (target.lane) setLane(target.lane);
    setEnemyIds(target.enemies);
    setHover(target.hover);
    setLaneOpponentId(current => current !== null && target.enemies.includes(current) ? current : null);
  }, [status, dirty]);


  function handleLaneChange(value: LaneId) { setDirty(true); setLane(value); }
  function handleHoverChange(champ: ChampionRef) { setDirty(true); setHover(champ.id); }
  function handleClearHover() { setDirty(true); setHover(null); }
  function handleAddEnemy(champ: ChampionRef) { setDirty(true); setEnemyIds(ids => ids.includes(champ.id) ? ids : [...ids, champ.id].slice(0, 5)); }
  function handleRemoveEnemy(id: number) { setDirty(true); setEnemyIds(ids => ids.filter(x => x !== id)); if (laneOpponentId === id) setLaneOpponentId(null); }
  function handleToggleLaneOpponent(id: number) { setLaneOpponentId(current => current === id ? null : id); }
  const icons = useMemo(() => new Map(champions.map(champ => [champ.id, champ])), [champions]);
  const counterEnemy = laneOpponentId ?? enemyIds[0] ?? null;

  const champSelect = status?.champSelect ?? null;
  const hoveredId = hover ?? champSelect?.cellChampionId ?? champSelect?.pickIntent ?? champSelect?.actionChampionId ?? null;
  const hoveredName = hoveredId === null ? null : (icons.get(hoveredId)?.name ?? null);
  const importStatus = hoveredName ?? (hoveredId !== null ? `Champion #${hoveredId}` : null);

  return <main className="d25-root mx-auto" style={{ padding: "24px 26px 32px 28px" }}>
    <style>{DRAFT_CSS}</style>
    <span className="d25-sronly">Companion test</span>
    <header className="d25-header">
      <div className="d25-headtext">
        <h1 className="d25-title">Draft assistant</h1>
        <p className="d25-subtitle">Find your lane matchup. Choose your next pick.</p>
      </div>
      <button type="button" id="d25-pill" className="d25-pill" onClick={() => setReviewOpen(true)}>
        <Clock size={22} aria-hidden="true" />
        <span>Previous game · Review</span>
        <CaretRight size={16} aria-hidden="true" />
        {hasPendingScore && <span className="d25-pilldot" aria-hidden="true" />}
      </button>
    </header>
    {championError && <p role="alert">Champion data is unavailable from DDragon. Check your connection and reload.</p>}
    <LaneScoreCard champIcons={icons} loadPending={fetchPendingLaneScore}
      submitScore={submitLaneScore} skipScore={skipLaneScore}
      onResolved={() => setHistoryRevision(value => value + 1)}
      open={reviewOpen} onClose={() => setReviewOpen(false)} onPendingChange={setHasPendingScore} />
    <DraftControls lane={lane} laneOptions={laneOptions} onLaneChange={handleLaneChange}
      hover={hover} allyIds={allyIds} champIcons={icons} onPick={handleHoverChange} onClearPick={handleClearHover}
      onAddAlly={champ => setAllyIds(ids => ids.includes(champ.id) ? ids : [...ids, champ.id].slice(0, 4))}
      onRemoveAlly={id => setAllyIds(ids => ids.filter(x => x !== id))}
      enemyIds={enemyIds} effectiveLaneOpponentId={laneOpponentId} laneOpponentId={laneOpponentId}
      serverInferredLaneOpponentId={null} onAddEnemy={handleAddEnemy} onRemoveEnemy={handleRemoveEnemy}
      onToggleLaneOpponent={handleToggleLaneOpponent} enemyAnalysis={null} hoverSelected={hover !== null}
      onManualDraft={() => setDirty(true)} onResetLive={() => setDirty(false)} />
    <p className="d25-sronly">Mark an enemy as your lane opponent to prioritise their counters. Without a mark, counters use the first visible enemy.</p>
    <CounterPicksStrip enemyId={counterEnemy} enemyName={counterEnemy ? icons.get(counterEnemy)?.name ?? null : null}
      lane={lane} champIcons={icons} loadCounters={loadLocalCounters} laneOpponentId={laneOpponentId} />
    <p className="d25-footnote">Lane advantage and match win rate measure different outcomes. A champion can appear in both lists.</p>
    <LaneHistoryPanel enemyId={counterEnemy} enemyName={counterEnemy ? icons.get(counterEnemy)?.name ?? null : null}
      roleId={LANE_TO_ROLE_ID[lane]} champIcons={icons} loadRecommendations={fetchLaneRecommendations}
      refreshKey={historyRevision} />
    <section aria-label="Automatic imports" id="d25-imports" className="d25-imports">
      <BookOpen size={30} color="#9DB4CF" aria-hidden="true" className="d25-imports-icon" />
      <div className="d25-imports-text">
        <span className="d25-imports-title">Automatic imports</span>
        <span className="d25-imports-sub"> Hover a champion to import rune pages and item builds.</span>
        <p className="d25-imports-sub2">Choose your rune page during champion select.</p>
      </div>
      <div className="d25-imports-right">
        <span className="d25-chip"><span className="d25-logotile" aria-hidden="true">U</span>u.gg</span>
        <span className="d25-chip"><span className="d25-logotile" aria-hidden="true">C</span>Coachless</span>
        <span className="d25-chip"><span className="d25-logotile" aria-hidden="true">P</span>Pro</span>
        <span className="d25-imports-div" aria-hidden="true" />
        <span className="d25-status">
          <span
            className="d25-statusdot"
            style={{ background: importStatus ? "#3ED6B5" : "#6F8196" }}
            aria-hidden="true"
          />
          {importStatus ? `Hover detected: ${importStatus}` : "Waiting for champion"}
        </span>
      </div>
    </section>
    {hash === "#live-setup" && (
      <section id="live-setup" className="d25-livesetup" aria-live="polite">
        <h2>Live setup</h2>
        <p>{status ? `Companion ${status.version} · ${status.clientConnected ? status.phase : "Open the League client"}` : "Companion disconnected. Reopen Draft from the desktop tray to reconnect."}</p>
        {status?.lastError && <p>{status.lastError}</p>}
      </section>
    )}
  </main>;
}
