// ─────────────────────────────────────────────────────────────────────────────
// rankBracketStorage.ts — SSR-safe localStorage persistence for the rank
// bracket. Mirrors lib/favorites.ts's own `typeof window === "undefined"`
// guard pattern (that file's header comment explains why: never crash a
// server render or a vitest node-env run that hasn't stubbed `window`).
//
// ── STORED-ID MIGRATION (2026-08-11) ─────────────────────────────────────────
// The app collapsed to a single Diamond+ bracket, so every id a returning user
// can be holding — `all`, `challenger`, `grandmaster`, `master`, `diamond`,
// `emerald`, `platinum` — is now unknown. The migration is deliberately the
// EXISTING validate-or-default path rather than a new mapping table, and the
// new bracket's id is deliberately `diamond-plus` rather than a reused `all`
// (see lib/rankBrackets.ts): every stale value therefore fails the
// `RANK_BRACKETS.some(...)` check and resolves to the only bracket that exists.
// No stale id can produce an error, a blank page, or a query for tiers the app
// no longer offers.
//
// Mapping the old ids to anything else was considered and rejected. `diamond`
// used to mean tier [5], which the confirmed enum says is EMERALD — honouring
// a stored `diamond` would mean querying Emerald-only data under a Diamond+
// label, which is the exact off-by-one this change exists to remove.
//
// The stale key is also PURGED on read (see below) so the dead value does not
// sit in storage indefinitely.
//
// Deliberately its own tiny module (not inlined in BuildTabContent.tsx) so
// the read/write logic — including the "unknown stored id falls back to
// default" validation — is unit-testable from a plain .ts file per this
// repo's test convention (vitest 4's oxc transform can't parse JSX outside
// its default scope, see StatBadge.tsx's header comment).
// ─────────────────────────────────────────────────────────────────────────────
import { RANK_BRACKETS, DEFAULT_RANK_BRACKET } from "@/lib/rankBrackets";

export const RANK_BRACKET_STORAGE_KEY = "coachbuild:rankBracket:v1";

/** Reads the stored rank-bracket id, validated against the current
 *  RANK_BRACKETS list. Returns the default bracket's id when: no `window`
 *  (SSR / node test env), nothing stored yet, storage is inaccessible
 *  (private-mode quota errors), or the stored value no longer names a real
 *  bracket (which, after the single-bracket collapse, is EVERY previously
 *  stored value — see the migration note in this file's header) — never
 *  throws, never returns an unknown id.
 *
 *  A stale value is removed from storage as it is read. That write is a
 *  deliberate side effect in a reader: this function is called on mount by
 *  app/page.tsx and by three companion call sites, and without the purge a
 *  dead id would be re-read and re-discarded on every one of them forever.
 *  It is wrapped in its own try/catch so a storage that can be read but not
 *  written (Safari private mode) still returns a usable id. */
export function readStoredRankBracketId(): string {
  if (typeof window === "undefined") return DEFAULT_RANK_BRACKET.id;
  try {
    const raw = window.localStorage.getItem(RANK_BRACKET_STORAGE_KEY);
    if (!raw) return DEFAULT_RANK_BRACKET.id;
    if (RANK_BRACKETS.some((b) => b.id === raw)) return raw;
    try {
      window.localStorage.removeItem(RANK_BRACKET_STORAGE_KEY);
    } catch {
      /* ignore — returning the default below is the load-bearing part */
    }
    return DEFAULT_RANK_BRACKET.id;
  } catch {
    return DEFAULT_RANK_BRACKET.id;
  }
}

/** Persists the chosen bracket id. No-op (never throws) when `window` is
 *  absent or storage write fails — persistence is a nicety here, never
 *  load-bearing for the selector itself (React state is the source of
 *  truth for the current render; see BuildTabContent.tsx). */
export function writeStoredRankBracketId(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RANK_BRACKET_STORAGE_KEY, id);
  } catch {
    /* ignore quota/private-mode errors */
  }
}
