// ─────────────────────────────────────────────────────────────────────────────
// lib/patchNotes/notes.ts — curated per-champion patch-note one-liners for the
// Patch Movers page's "note" column (mockup 7). NO endpoint exists anywhere in
// this app's stack (coachless, Riot, ddragon) that returns "what changed for
// champion X this patch" as structured data — this is genuinely hand-curated,
// same posture as lib/draft/compRatings.ts's curated comp-archetype table.
//
// HAND-CURATION WORKFLOW (read before adding an entry):
//   1. Find the OFFICIAL or a well-corroborated patch-notes source for the
//      patch label being added (riot's own leagueoflegends.com/patch-notes
//      page when available; a well-established third-party aggregator like
//      lelanation.fr/patch-notes or a named esports outlet otherwise).
//   2. Write a SHORT, DIRECTIONAL one-liner ("Buffed this patch" / "Nerfed
//      this patch") — NOT a fabricated specific numeric change unless the
//      source's exact wording is being quoted. Directionality (buff vs nerf)
//      is the only claim being made per entry below; do not embed a made-up
//      ability/number.
//   3. A champion with NO entry renders "—" (lib/patchNotes/lookup.ts) — this
//      is the correct, honest default for "not verified," never a guess.
//   4. NEVER backfill a patch's entries from memory/training data alone —
//      every entry below was checked against a live source at write time
//      (see the citation on this file's patch block).
//
// PATCH "16.13" (shipped 2026-06-24, used at MSI 2026) — SOURCE (verified via
// web search, 2026-07-24): escorenews.com's "League of Legends patch notes
// 26.13 (16.13) full preview: buffs to Olaf, Leblanc, Draven, nerfs to Senna,
// K'Sante, Brand" (escorenews.com/en/lol/news/78871-...). That preview names
// exactly these 6 champions' DIRECTION of change (not exact numbers) — every
// other champion touched by 16.13 (the source says "18 champions changed in
// total") is deliberately left ABSENT rather than guessed at. Champion ids
// below are LoL's stable, well-known numeric keys (verified against
// lib/staticData.ts's champion list convention: numeric id = Riot's `key`).
// ─────────────────────────────────────────────────────────────────────────────

export const PATCH_NOTES: Record<string, Record<number, string>> = {
  "16.13": {
    7: "Buffed this patch", // LeBlanc
    2: "Buffed this patch", // Olaf
    119: "Buffed this patch", // Draven
    235: "Nerfed this patch", // Senna
    897: "Nerfed this patch", // K'Sante
    63: "Nerfed this patch", // Brand
  },
};
