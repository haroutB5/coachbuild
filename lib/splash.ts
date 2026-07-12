// ─────────────────────────────────────────────────────────────────────────────
// splash.ts — ddragon splash-art URL builder for the champion hero banner.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pure + synchronous by design (no network, no await) — matches the app's
// existing icon architecture (Gotcha (m) in CLAUDE.md: `IconWithFallback` is
// the single `<img>` sink; URLs are built optimistically and any 403/404 is
// handled at RENDER time by the `<img>` fallback, not pre-flighted here — a
// HEAD request per splash render would also undercut the app's measured
// lazy-loading perf work, v0.19.0).
//
// Verified live 2026-07-12:
//   - https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Viktor_0.jpg  -> 200
//   - .../LeeSin_0.jpg  -> 200
//   - .../Jinx_0.jpg    -> 200
//   - .../Locke_0.jpg   -> 200 (brand-new champ, id 805, shipped 16.13.1 — splash
//     art is NOT versioned/patch-folder-gated like ICON_BASES.champ() in
//     staticData.ts is, and ships same-day with a new champion, AHEAD of
//     coachless's champion.json bundle lag — see staticData.ts's champion
//     gap-fill gotcha for the general shape of that lag)
//   - .../Wukong_0.jpg  -> 403 (ddragon's real key for that champion is
//     "MonkeyKing", not "Wukong" — a wrong/unknown key comes back 403, NOT 404)
//   - a made-up key also came back 403
// So the render-layer fallback MUST trigger on any non-200 response, not
// assume 404 specifically — pass this URL through IconWithFallback (or an
// equivalent onError handler) rather than a bare <img>.
//
// `championKey` should be the ddragon "key" form already carried on
// ChampionRef (lib/types.ts: `key: string; // Riot string key, e.g. "Viktor"`)
// — the SAME field coachless's champion.json and the ddragon gap-fill (see
// staticData.ts's `findChampionGaps`) both populate, so a key sourced from
// `getAllChampions()`/`getChampionById()` is already in the right form. This
// fixes the Wukong-style name/key mismatch at the SOURCE (the champion map),
// not here — `getSplashUrl` does no name normalization of its own.

const DDRAGON_SPLASH_BASE =
  "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/";

/**
 * Builds the splash-art URL for a champion, or null for an empty/blank key.
 * Does not verify the URL resolves — see module header for the fallback
 * strategy the caller (UI layer) should use instead.
 */
export function getSplashUrl(championKey: string): string | null {
  if (!championKey || !championKey.trim()) return null;
  return `${DDRAGON_SPLASH_BASE}${championKey}_0.jpg`;
}
