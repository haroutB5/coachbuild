// ─────────────────────────────────────────────────────────────────────────────
// playerName.ts — one shared helper for cleaning player display names.
//
// Player names must render as IN-GAME names only ("Saint"), never
// "Name (Real Name)" ("Saint (Kang Sung-in)"). engy is cleaning this at the
// API layer going forward (TeamCompPlayer.name and the top-level
// ProGamePlayer.name both arrive pre-stripped) — this is a defensive belt so
// a STALE cached /api/pros response (served from before that fix ships, or
// re-served from an edge/CDN cache — see gotcha (b) in CLAUDE.md) still
// renders clean on the client. Every render site that shows a player name
// (sheet header, Teams-box rows, cards, tap-target aria-labels) should read
// it through this function rather than the raw field.
//
// Only strips a SINGLE trailing "(...)" group. A name with parens anywhere
// else, or more than one trailing group, is left alone — over-eager
// stripping risks mangling a legitimately parenthesized name we've never
// seen, and the single-trailing-group shape is the only one this incident
// class actually produces.
// ─────────────────────────────────────────────────────────────────────────────

const TRAILING_PARENTHETICAL_RE = /\s*\([^()]*\)\s*$/;

export function cleanPlayerName(name: string): string;
export function cleanPlayerName(name: string | null | undefined): string | null;
export function cleanPlayerName(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return trimmed; // "" in, "" out — never invents null for a non-null input

  const stripped = trimmed.replace(TRAILING_PARENTHETICAL_RE, "").trim();
  // Never return an empty string for a non-empty input (e.g. a name that is
  // ENTIRELY a parenthetical, like "(unknown)") — fall back to the trimmed
  // original rather than showing a blank name.
  return stripped.length > 0 ? stripped : trimmed;
}
