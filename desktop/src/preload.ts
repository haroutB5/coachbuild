// ─────────────────────────────────────────────────────────────────────────────
// preload.ts — deliberately empty.
//
// This file exists so `contextIsolation` has a preload boundary to isolate, and
// so nobody later "just adds one helper" without reading this comment first.
//
// The shell exposes NOTHING to the page. The web app reaches the companion the
// same way it does in a browser: loopback HTTP to the bridge, gated by the
// session token and an exact-Origin check. That is what keeps one codebase —
// the page cannot tell shell from browser, so it needs no branch — and it means
// a fully compromised renderer holds exactly the capability a compromised
// Chrome tab holds today, which the bridge's own title gates already bound to
// CoachBuild-titled writes.
//
// If you are about to add `contextBridge.exposeInMainWorld` here: that is the
// moment the web app grows a desktop-only branch, and the moment a renderer
// exploit gains something a browser tab never had. Do it in the bridge instead,
// as a wire-contract addition that degrades to null on older companions.
// ─────────────────────────────────────────────────────────────────────────────
export {};
