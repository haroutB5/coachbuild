/** Pure helper for the SW "Update ready" toast's dismiss-persistence.
 *
 * v0.51.1 (user-reported: toast kept re-appearing even though the user was
 * already on the latest version): the previous implementation stored a
 * single sessionStorage boolean ("has the user dismissed ANY update this tab
 * session" — `coachbuild:swUpdateDismissed`, v0.48.5). Two real bugs
 * followed from that:
 *  (1) sessionStorage is scoped per TAB, not per-origin — opening the site in
 *      a new tab (an ordinary way to revisit a bookmarked/linked page) reset
 *      "dismissed" to false even though the SAME still-pending, never-applied
 *      update had already been dismissed once in another tab. Nothing about
 *      the app looked stale (network-first), so from the user's perspective
 *      they were "already on the latest version" while the toast nagged
 *      again on every fresh tab.
 *  (2) iOS/iPadOS Safari does not reliably persist sessionStorage across a
 *      home-screen PWA relaunch (closing the app via the app switcher and
 *      reopening it starts a new top-level browsing context) — same
 *      symptom, higher frequency, for anyone using the installed app.
 *
 * Fix: persist in localStorage (survives both of the above) AND key the
 * stored value to the specific waiting worker's `scriptURL` (which embeds
 * the app version via the `?v=` registration param — see
 * ServiceWorkerRegister.tsx), not a single sticky boolean. A single sticky
 * "dismissed forever" boolean would have traded the re-appearing bug for the
 * opposite one: dismissing today's update would silently suppress every
 * FUTURE genuinely-newer update too. Keying to the exact scriptURL means a
 * dismissal only ever hides THAT one version's toast; any different
 * (newer) scriptURL always surfaces fresh.
 */
export const SW_UPDATE_DISMISSED_STORAGE_KEY = "coachbuild:swUpdateDismissedVersion";

/** True when `dismissedScriptURL` (the value last written on dismiss) matches
 *  the CURRENTLY waiting worker's `scriptURL` exactly — i.e. the user has
 *  already dismissed THIS SPECIFIC pending update. A null/missing
 *  `waitingScriptURL` (no waiting worker at all) is always "not dismissed" —
 *  callers gate actual toast visibility on `waitingWorker` separately, this
 *  helper only decides the dismiss half of that gate.
 */
export function isUpdateDismissed(dismissedScriptURL: string | null, waitingScriptURL: string | null): boolean {
  if (!waitingScriptURL) return false;
  return dismissedScriptURL === waitingScriptURL;
}
