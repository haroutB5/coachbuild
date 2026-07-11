"use strict";
"use client";
import { useEffect, useState } from "react";
import { getChampionIconMap, itemIconUrl } from "./proAssets";
import { IconWithFallback } from "./IconWithFallback";
import { WinLossPill } from "./ProGameCard";
function useChampionIconMap() {
  const [map, setMap] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getChampionIconMap().then((m) => {
      if (!cancelled) setMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return map;
}
export function CardCompStrip({ allyChampionIds, enemyChampionIds, selfChampionId }) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;
  return /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-2 px-4 py-2 border-t border-line/60 overflow-hidden" }, /* @__PURE__ */ React.createElement(
    MiniCompRow,
    {
      championIds: allyChampionIds,
      selfChampionId,
      iconMap,
      ariaLabel: "Ally team"
    }
  ), /* @__PURE__ */ React.createElement(
    "span",
    {
      className: "text-[9px] font-bold text-mut uppercase tracking-[0.5px] flex-shrink-0",
      "aria-hidden": "true"
    },
    "vs"
  ), /* @__PURE__ */ React.createElement(
    MiniCompRow,
    {
      championIds: enemyChampionIds,
      selfChampionId: null,
      iconMap,
      ariaLabel: "Enemy team"
    }
  ));
}
function MiniCompRow({
  championIds,
  selfChampionId,
  iconMap,
  ariaLabel
}) {
  return /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-1 min-w-0", role: "group", "aria-label": ariaLabel }, championIds.map((champId, i) => {
    const entry = iconMap?.get(champId);
    const name = entry?.name ?? `Champion #${champId}`;
    const isSelf = champId === selfChampionId;
    return /* @__PURE__ */ React.createElement(
      "span",
      {
        key: `${champId}-${i}`,
        className: `w-5 h-5 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${isSelf ? "ring-2 ring-teal" : "border border-line opacity-55"}`,
        title: name
      },
      /* @__PURE__ */ React.createElement(IconWithFallback, { src: entry?.icon ?? "", alt: name, className: "w-full h-full object-cover" })
    );
  }));
}
const ROSTER_ROLE_LABELS = ["Top", "Jungle", "Mid", "Bot", "Support"];
const ROLE_ABBR = ["Top", "Jg", "Mid", "Bot", "Sup"];
export function roleAbbrForPlayer(role, index, rosterLength) {
  if (typeof role === "number" && role >= 0 && role < ROLE_ABBR.length) return ROLE_ABBR[role];
  if (rosterLength === ROLE_ABBR.length) return ROLE_ABBR[index];
  return void 0;
}
export function teamBoxTitle(side, realName, trackedPlayerTeam) {
  if (realName) return realName;
  if (side === "ally") return trackedPlayerTeam ? `Ally team \u2014 ${trackedPlayerTeam}` : "Ally team";
  return "Enemy team";
}
export function isSelfInAlly(allyChampionIds, selfChampionId) {
  return allyChampionIds.includes(selfChampionId);
}
export function SheetTeamsSection({
  allyChampionIds,
  enemyChampionIds,
  allyPlayers,
  enemyPlayers,
  selfChampionId,
  win,
  trackedPlayerTeam,
  allyTeamName,
  enemyTeamName,
  ver,
  itemNames,
  onItemClick
}) {
  const iconMap = useChampionIconMap();
  if (!allyChampionIds || !enemyChampionIds) return null;
  const showResult = isSelfInAlly(allyChampionIds, selfChampionId);
  return /* @__PURE__ */ React.createElement("section", { className: "mb-6" }, /* @__PURE__ */ React.createElement("p", { className: "text-[10.5px] tracking-[1px] uppercase text-teal font-bold mb-2.5" }, "Teams"), /* @__PURE__ */ React.createElement("div", { className: "space-y-2.5" }, /* @__PURE__ */ React.createElement(
    TeamBox,
    {
      title: teamBoxTitle("ally", allyTeamName, trackedPlayerTeam),
      resultChip: showResult ? win : void 0,
      championIds: allyChampionIds,
      players: allyPlayers,
      selfChampionId,
      iconMap,
      ver,
      itemNames,
      onItemClick
    }
  ), /* @__PURE__ */ React.createElement(
    TeamBox,
    {
      title: teamBoxTitle("enemy", enemyTeamName),
      resultChip: showResult ? !win : void 0,
      championIds: enemyChampionIds,
      players: enemyPlayers,
      selfChampionId: null,
      iconMap,
      ver,
      itemNames,
      onItemClick
    }
  )));
}
const STANDARD_ROSTER_LENGTH = 5;
function TeamBox({
  title,
  resultChip,
  championIds,
  players,
  selfChampionId,
  iconMap,
  ver,
  itemNames,
  onItemClick
}) {
  return /* @__PURE__ */ React.createElement("div", { className: "rounded-xl border border-line bg-black/15 p-3" }, /* @__PURE__ */ React.createElement("div", { className: "flex items-center justify-between gap-2 mb-2.5" }, /* @__PURE__ */ React.createElement("p", { className: "text-[9.5px] uppercase tracking-[0.5px] text-mut truncate min-w-0" }, title), resultChip !== void 0 && /* @__PURE__ */ React.createElement(WinLossPill, { win: resultChip })), players && players.length === STANDARD_ROSTER_LENGTH ? /* @__PURE__ */ React.createElement("div", { className: "space-y-1.5", role: "group", "aria-label": title }, players.map((p, i) => /* @__PURE__ */ React.createElement(
    PlayerRow,
    {
      key: `${p.championId}-${i}`,
      player: p,
      index: i,
      rosterLength: players.length,
      isSelf: p.championId === selfChampionId,
      iconMap,
      ver,
      itemNames,
      onItemClick
    }
  ))) : /* @__PURE__ */ React.createElement(
    LegacyRosterBody,
    {
      championIds,
      selfChampionId,
      iconMap,
      ariaLabel: title
    }
  ));
}
function LegacyRosterBody({
  championIds,
  selfChampionId,
  iconMap,
  ariaLabel
}) {
  return /* @__PURE__ */ React.createElement("div", { className: "flex items-start gap-2 flex-wrap", role: "group", "aria-label": ariaLabel }, championIds.map((champId, i) => {
    const entry = iconMap?.get(champId);
    const name = entry?.name ?? `Champion #${champId}`;
    const isSelf = champId === selfChampionId;
    const role = championIds.length === ROSTER_ROLE_LABELS.length ? ROSTER_ROLE_LABELS[i] : void 0;
    const title = role ? `${role} \u2014 ${name}` : name;
    return /* @__PURE__ */ React.createElement(
      "div",
      {
        key: `${champId}-${i}`,
        className: "flex flex-col items-center gap-1 w-12 flex-shrink-0",
        title
      },
      /* @__PURE__ */ React.createElement(
        "div",
        {
          className: `w-9 h-9 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${isSelf ? "border-2 border-teal shadow-[0_0_10px_rgba(130,219,247,0.3)]" : "border border-line opacity-70"}`
        },
        /* @__PURE__ */ React.createElement(
          IconWithFallback,
          {
            src: entry?.icon ?? "",
            alt: name,
            fallbackGlyph: name,
            className: "w-full h-full object-cover"
          }
        )
      ),
      /* @__PURE__ */ React.createElement("span", { className: "text-[9px] text-mut text-center leading-tight truncate w-full" }, name)
    );
  }));
}
function PlayerRow({
  player,
  index,
  rosterLength,
  isSelf,
  iconMap,
  ver,
  itemNames,
  onItemClick
}) {
  const entry = iconMap?.get(player.championId);
  const champName = entry?.name ?? `Champion #${player.championId}`;
  const roleAbbr = roleAbbrForPlayer(player.role, index, rosterLength);
  return /* @__PURE__ */ React.createElement(
    "div",
    {
      className: `flex items-center gap-1.5 flex-wrap rounded-lg px-1.5 py-1 ${isSelf ? "ring-1 ring-teal bg-teal/5" : ""}`
    },
    /* @__PURE__ */ React.createElement(
      "span",
      {
        className: `w-7 h-7 rounded-full bg-black/30 overflow-hidden flex items-center justify-center flex-shrink-0 ${isSelf ? "border-2 border-teal" : "border border-line opacity-80"}`,
        title: champName
      },
      /* @__PURE__ */ React.createElement(
        IconWithFallback,
        {
          src: entry?.icon ?? "",
          alt: champName,
          fallbackGlyph: champName,
          className: "w-full h-full object-cover"
        }
      )
    ),
    roleAbbr && /* @__PURE__ */ React.createElement(
      "span",
      {
        className: "text-[8.5px] font-bold uppercase text-mut w-6 flex-shrink-0 text-center",
        "aria-hidden": "true"
      },
      roleAbbr
    ),
    player.name && /* @__PURE__ */ React.createElement("span", { className: "text-[11px] text-txt truncate min-w-[36px] flex-1", title: player.name }, player.name),
    /* @__PURE__ */ React.createElement("div", { className: "flex items-center gap-1 flex-wrap justify-end flex-shrink-0 ml-auto" }, player.items.map((id, i) => {
      const label = itemNames?.get(id) ?? `Item #${id}`;
      return /* @__PURE__ */ React.createElement(
        "button",
        {
          key: `${id}-${i}`,
          type: "button",
          onClick: () => onItemClick(id),
          "aria-label": `View details for ${label}`,
          title: label,
          className: "w-[23px] h-[23px] rounded-[5px] bg-black/30 border border-line overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 hover:border-teal-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel"
        },
        /* @__PURE__ */ React.createElement(IconWithFallback, { src: itemIconUrl(id, ver), alt: label, className: "w-full h-full object-contain" })
      );
    }), player.trinket != null && /* @__PURE__ */ React.createElement(
      "button",
      {
        type: "button",
        onClick: () => onItemClick(player.trinket),
        "aria-label": `View details for trinket ${itemNames?.get(player.trinket) ?? `#${player.trinket}`}`,
        title: itemNames?.get(player.trinket) ?? "Trinket",
        className: "w-[23px] h-[23px] rounded-full bg-black/30 border border-teal-dim overflow-hidden flex items-center justify-center flex-shrink-0 transition-transform active:scale-95 hover:border-teal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-1 focus-visible:ring-offset-panel"
      },
      /* @__PURE__ */ React.createElement(
        IconWithFallback,
        {
          src: itemIconUrl(player.trinket, ver),
          alt: itemNames?.get(player.trinket) ?? "Trinket",
          fallbackGlyph: "Trinket",
          className: "w-full h-full object-contain"
        }
      )
    ))
  );
}
