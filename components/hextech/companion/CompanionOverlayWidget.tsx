import type { ReactNode } from "react";

export type OverlayAbility = "Q" | "W" | "E" | "R";
export type OverlayState = "next" | "ultimate" | "refusal";
export type OverlayScale = "base" | "compact";

/** The web depiction follows the native overlay palette, not the Nocturne UI accent. */
export const REAL_OVERLAY_COLORS = {
  pink: "#FF2F9E",
  pinkFill: "rgba(255, 47, 158, 0.20)",
  panel: "rgba(8, 13, 28, 0.878)",
  panelBorder: "rgba(82, 92, 130, 0.824)",
  muted: "rgba(220, 220, 235, 0.804)",
  gold: "#FFCD5A",
} as const;

export interface CompanionOverlayWidgetProps {
  championName: string;
  level: number | null;
  state: OverlayState;
  ability?: OverlayAbility | null;
  abilityName?: string | null;
  fromRank?: number | null;
  toRank?: number | null;
  scale?: OverlayScale;
  /** The green dot is reserved for a fresh, genuinely live reading. */
  liveSignal?: boolean;
  refusalLabel?: string;
  className?: string;
}

const ABILITIES: readonly OverlayAbility[] = ["Q", "W", "E", "R"];

function StateTile({
  ability,
  state,
  compact,
}: {
  ability: OverlayAbility | null;
  state: OverlayState;
  compact: boolean;
}) {
  const isRefusal = state === "refusal";
  const radius = compact ? "rounded-[10px]" : "rounded-[9px]";

  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center ${radius} font-semibold leading-none ${
        compact ? "h-16 w-16 text-[28px]" : "h-[46px] w-[46px] text-[20px]"
      } ${
        isRefusal
          ? "border border-txt/[0.14] bg-txt/[0.04] text-txt/[0.50]"
          : "border text-white"
      }`}
      style={
        !isRefusal
          ? {
              backgroundColor: REAL_OVERLAY_COLORS.pinkFill,
              borderColor: REAL_OVERLAY_COLORS.pink,
              color: "#FFFFFF",
            }
          : undefined
      }
    >
      {isRefusal ? "—" : ability ?? "—"}
    </span>
  );
}

function RankTransition({
  state,
  fromRank,
  toRank,
  compact,
}: {
  state: OverlayState;
  fromRank?: number | null;
  toRank?: number | null;
  compact: boolean;
}) {
  if (state === "refusal") {
    return <span style={{ color: REAL_OVERLAY_COLORS.muted }}>No safe recommendation</span>;
  }

  if (fromRank == null || toRank == null) {
    return <span style={{ color: REAL_OVERLAY_COLORS.muted }}>Awaiting rank read</span>;
  }

  return (
    <span className={`tabular-nums ${compact ? "text-[17px]" : "text-[12px]"}`} style={{ color: REAL_OVERLAY_COLORS.muted }}>
      {fromRank} <span className="mx-1" aria-hidden="true" style={{ color: REAL_OVERLAY_COLORS.muted }}>→</span> {toRank}
    </span>
  );
}

function WidgetFooter({
  ability,
  state,
  compact,
}: {
  ability: OverlayAbility | null;
  state: OverlayState;
  compact: boolean;
}) {
  const radius = compact ? "rounded-[8px]" : "rounded-[7px]";
  return (
    <div className={`grid grid-cols-4 ${compact ? "gap-2" : "gap-1.5"}`} aria-hidden="true">
      {ABILITIES.map((entry) => {
        const active = state !== "refusal" && entry === ability;
        return (
          <span
            key={entry}
            className={`flex items-center justify-center ${radius} font-semibold ${
              compact ? "h-9 text-[15px]" : "h-[22px] text-[11px]"
            } ${
              active
                ? "border text-white"
                : "border border-txt/[0.06] bg-txt/[0.05] text-txt/[0.45]"
            }`}
            style={
              active
                ? {
                    backgroundColor: REAL_OVERLAY_COLORS.pinkFill,
                    borderColor: REAL_OVERLAY_COLORS.pink,
                    color: REAL_OVERLAY_COLORS.pink,
                  }
                : undefined
            }
          >
            {entry}
          </span>
        );
      })}
    </div>
  );
}

export default function CompanionOverlayWidget({
  championName,
  level,
  state,
  ability = null,
  abilityName,
  fromRank,
  toRank,
  scale = "base",
  liveSignal = false,
  refusalLabel,
  className = "",
}: CompanionOverlayWidgetProps) {
  const compact = scale === "compact";
  const title =
    state === "refusal" ? refusalLabel ?? "Refuses past level 15" : abilityName ?? "Next ability";
  const label = `CoachBuild overlay for ${championName}: ${title}`;

  return (
    <section
      aria-label={label}
      className={`text-txt ${compact ? "w-full max-w-[420px] rounded-[14px] p-5" : "w-[250px] rounded-[10px] p-3"} ${className}`}
      style={{
        background: REAL_OVERLAY_COLORS.panel,
        border: `1px solid ${REAL_OVERLAY_COLORS.panelBorder}`,
        boxShadow: "0 10px 30px rgba(0,0,0,.55)",
      }}
    >
      <header className={`flex items-center justify-between gap-3 ${compact ? "mb-5" : "mb-3"}`}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`shrink-0 rounded-full ${compact ? "h-2 w-2" : "h-[5px] w-[5px]"} ${
              liveSignal ? "animate-pulse bg-good" : "bg-txt/[0.26]"
            }`}
            aria-hidden="true"
          />
          <span className={`truncate font-medium uppercase tracking-[0.14em] ${compact ? "text-[11px]" : "text-[8.5px]"}`} style={{ color: REAL_OVERLAY_COLORS.muted }}>
            CoachBuild · {championName}
          </span>
        </div>
        <span className={`shrink-0 tabular-nums font-medium ${compact ? "text-[12px]" : "text-[10px]"}`} style={{ color: REAL_OVERLAY_COLORS.muted }}>
          LV <span style={{ color: REAL_OVERLAY_COLORS.gold }}>{level ?? "—"}</span>
        </span>
      </header>

      <div className={`flex items-center ${compact ? "mb-5 gap-4" : "mb-3 gap-3"}`}>
        <StateTile ability={ability} state={state} compact={compact} />
        <div className="min-w-0">
          <p className={`truncate font-semibold text-txt ${compact ? "text-[17px]" : "text-[13px]"}`}>
            {title}
          </p>
          <RankTransition state={state} fromRank={fromRank} toRank={toRank} compact={compact} />
        </div>
      </div>

      <WidgetFooter ability={ability} state={state} compact={compact} />
    </section>
  );
}

export function OverlayWaiting({ message, scale = "compact" }: { message: ReactNode; scale?: OverlayScale }) {
  const compact = scale === "compact";
  return (
    <section
      role="status"
      className={`text-txt ${compact ? "w-full max-w-[420px] rounded-[14px] p-5" : "w-[250px] rounded-[10px] p-3"}`}
      style={{
        background: REAL_OVERLAY_COLORS.panel,
        border: `1px solid ${REAL_OVERLAY_COLORS.panelBorder}`,
        boxShadow: "0 10px 30px rgba(0,0,0,.55)",
      }}
    >
      <div className={`flex items-center gap-2 uppercase tracking-[0.14em] ${compact ? "text-[11px]" : "text-[8.5px]"}`} style={{ color: REAL_OVERLAY_COLORS.muted }}>
        <span className={`shrink-0 rounded-full bg-txt/[0.24] ${compact ? "h-2 w-2" : "h-[5px] w-[5px]"}`} aria-hidden="true" />
        CoachBuild overlay
      </div>
      <p className={`mt-4 font-medium ${compact ? "text-[16px]" : "text-[12px]"}`} style={{ color: REAL_OVERLAY_COLORS.muted }}>{message}</p>
    </section>
  );
}
