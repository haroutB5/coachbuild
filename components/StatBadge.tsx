"use client";

import type { Pick } from "@/lib/types";

interface StatBadgeProps {
  wpa: number;
  occurrence: number;
  winrate?: number | null;
  lowSample?: boolean;
  size?: "sm" | "md";
}

export function wpaClass(wpa: number): string {
  if (wpa > 0.02) return "text-good";
  if (wpa < -0.02) return "text-bad";
  return "text-[#9aa7b6]";
}

export function wpaText(wpa: number): string {
  return (wpa > 0 ? "+" : "") + wpa.toFixed(2);
}

export function fmtSample(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

export default function StatBadge({ wpa, occurrence, winrate, lowSample, size = "md" }: StatBadgeProps) {
  const textSize = size === "sm" ? "text-[10px]" : "text-[12.5px]";
  const sampleSize = size === "sm" ? "text-[9px]" : "text-[10px]";

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span
        className={`font-extrabold ${textSize} ${wpaClass(wpa)}`}
        title={`WPA: ${wpaText(wpa)} — Win Probability Added. Positive = adds win %.`}
      >
        {wpaText(wpa)}
      </span>
      {winrate != null && (
        <span className={`${sampleSize} text-mut`}>{winrate.toFixed(1)}% wr</span>
      )}
      <span className={`${sampleSize} text-mut flex items-center gap-0.5`}>
        {fmtSample(occurrence)}
        {lowSample && (
          <span title="Low sample — treat with caution" className="text-gold">⚠</span>
        )}
      </span>
    </div>
  );
}
