/**
 * The draft surfaces use the same lane-average comparison. A missing lane
 * average is missing evidence, not a zero delta.
 */
export function deltaVsLaneAverage(winRate: number | null, laneAverage: number | null): number | null {
  if (winRate === null || laneAverage === null) return null;
  if (!Number.isFinite(winRate) || !Number.isFinite(laneAverage)) return null;
  return winRate - laneAverage;
}

export function formatDeltaPoints(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}
