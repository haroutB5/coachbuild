// UNUSED as of this ship (kept on disk rather than deleted — the repo's
// safety gate blocks file deletion without explicit user approval, and this
// is harmless dead code, not wrong code).
//
// Original intent: the spec screenshot shows WPA as a percentage
// ("+1.8%"). Reverted after live-testing against real /api/build data:
// Pick.wpa is NOT a bounded probability fraction the way this assumed —
// lib/sampleBuild.ts's own fixtures show values from 0.0 to 1.68+ (e.g.
// Gathering Storm wpa: 1.62), and a live Viktor-mid pull showed item WPAs
// up to 3.3. Multiplying by 100 and appending "%" produces absurd numbers
// like "+331.3%" for real data. components/hextech/* now uses the SAME
// raw wpaText() format (components/StatBadge.tsx) every other WPA display
// in the app already uses (e.g. "+0.02", no % sign) — matches the
// established, already-vetted convention instead of inventing a new one
// that breaks on real values. See HANDOFF-fronty.md for the full note.
export function wpaPercentText(wpa: number): string {
  return (wpa > 0 ? "+" : "") + (wpa * 100).toFixed(1) + "%";
}
