"use client";

// Shared, stateless stat-formatting helpers used by every pick tile
// (ItemPath, RunePage, SpellRow). No JSX component is exported here on
// purpose — a standalone <StatBadge> tile existed with zero call sites
// (dead code) and was removed; every surface renders these inline instead
// so the caution/"or"-row layouts can stay per-component and compact.

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

/** True when a headline (most-played/most-adopted) pick's WPA is negative —
 *  e.g. Jhin's Fleet Footwork at -0.10 WPA / 295K games. The pick is still
 *  correct (adoption-weighted ranking, unchanged) — this only flags the
 *  display so a quiet "Most played" label can explain the red number as
 *  "popular pick, slightly negative data" rather than reading like a bug. */
export function isNegativeHeadlineWpa(wpa: number): boolean {
  return wpa < 0;
}

// Note: no JSX component is exported from this file (deliberately — see the
// header comment). The low-sample caution glyph is rendered inline in each
// caller (ItemPath.tsx, RunePage.tsx) rather than as a shared <LowSampleFlag>:
// this file's helpers are unit-tested under components/__tests__/, and
// vitest 4's oxc transform can't parse JSX in files outside its default jsx
// scope without extra plugin config — not worth it for one glyph. If a
// second caller needs this exact markup, extract it into its own
// LowSampleFlag.tsx (no logic, so no test-import conflict).
