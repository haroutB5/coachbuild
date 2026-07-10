// ── favorites.ts — localStorage-backed "favorite pro players" data layer ────
//
// Lets a user star a pro player (from /api/players results) and reuse them
// without searching again. Client-only: every export SSR-guards on
// `typeof window === "undefined"` (returns empty/no-op) so it never crashes
// a server render or a vitest node-env run that hasn't stubbed `window`.
//
// Contract is fixed — a concurrent UI build (fronty) codes against these
// exact names/signatures. Do not rename without updating that consumer.

export interface FavoritePlayer {
  id: string; // pros.id UUID, from /api/players results
  name: string; // display name e.g. "Faker"
  team: string | null;
}

export const MAX_FAVORITES = 12;

const STORAGE_KEY = "coachbuild:favPlayers:v1";

/** Per-entry shape validation — used to filter malformed entries out of a
 *  parsed (but otherwise valid-array) stored value. */
function isFavoritePlayerShape(
  v: unknown
): v is { id: string; name: string; team?: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.name === "string";
}

/** Coerces a validated raw entry into a well-formed FavoritePlayer — missing
 *  or non-string `team` becomes null. */
function coerce(v: { id: string; name: string; team?: unknown }): FavoritePlayer {
  return {
    id: v.id,
    name: v.name,
    team: typeof v.team === "string" ? v.team : null,
  };
}

/**
 * Reads + validates the stored favorites list (newest-first, as written).
 * Hardened: corrupted JSON, a non-array stored value, or individual
 * malformed entries are silently dropped/filtered — this never throws, so a
 * corrupted localStorage value can't crash the app.
 */
export function getFavorites(): FavoritePlayer[] {
  if (typeof window === "undefined") return [];

  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(isFavoritePlayerShape).map(coerce);
}

/** Best-effort persist — swallows quota/write errors (e.g. Safari private
 *  mode) so a failed write never throws; the caller already has the computed
 *  list in hand regardless of whether the persist succeeded. */
function writeFavorites(list: FavoritePlayer[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Safari private-mode quota, storage disabled, etc — no-op.
  }
}

export function isFavorite(id: string): boolean {
  if (typeof window === "undefined") return false;
  return getFavorites().some((p) => p.id === id);
}

/**
 * Adds `p` to the FRONT of the list if absent (newest-starred shows first),
 * removes it if already present (no reorder of the remaining entries).
 * Dedupes by `id`. Silently no-ops the add once at MAX_FAVORITES (still
 * returns the current, unchanged list). SSR-safe: no-op, returns [].
 */
export function toggleFavorite(p: FavoritePlayer): FavoritePlayer[] {
  if (typeof window === "undefined") return [];

  const current = getFavorites();
  const exists = current.some((f) => f.id === p.id);

  if (exists) {
    const next = current.filter((f) => f.id !== p.id);
    writeFavorites(next);
    return next;
  }

  if (current.length >= MAX_FAVORITES) {
    return current;
  }

  const next: FavoritePlayer[] = [
    { id: p.id, name: p.name, team: p.team ?? null },
    ...current,
  ];
  writeFavorites(next);
  return next;
}
