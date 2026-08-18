// ─────────────────────────────────────────────────────────────────────────────
// champSelectFollowSequence.test.ts — the live-follow gate replayed as the
// SEQUENCE app/page.tsx actually runs it, rather than one call at a time.
//
// This file exists because the 2026-08-18 lost-follow bug was invisible to
// per-function tests: every individual call did exactly what its own test said,
// and the defect only appeared in the ORDER they were made (mark, then start an
// async resolution, then have that resolution discarded). The end-to-end proof
// is scripts/bench-champselect.mjs; this is the cheap always-run version of the
// same story.
//
// The model below is deliberately small and explicit: `tick()` is one /status
// poll, `resolve()` is the champion list coming back for an attempt, and
// `discard()` is that attempt losing (superseded, unmounted, or failed).
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach } from "vitest";
import {
  noteCompanionPhase,
  setCurrentChampSelectChampionId,
  getCurrentChampSelectChampionId,
  beginFollowAttempt,
  commitFollowAttempt,
  abandonFollowAttempt,
  resetChampSelectFollowState,
} from "../live/champSelectFollowState";

/** Stands in for the page: which champion is currently rendered. */
let shown: number | null = null;
/** Attempts that have begun and not yet resolved, oldest first. */
let pending: number[] = [];

/** One /status poll tick: the provider mirrors what champ select says, then the
 *  page's follow effect decides whether to start an attempt. */
function tick(champSelectChampionId: number | null): void {
  noteCompanionPhase("ChampSelect");
  setCurrentChampSelectChampionId(champSelectChampionId);
  if (champSelectChampionId === null) return;
  if (beginFollowAttempt(champSelectChampionId)) pending.push(champSelectChampionId);
}

/** The champion list comes back for the oldest outstanding attempt. This is the
 *  exact guard app/page.tsx applies: an attempt only applies while it is still
 *  what champ select says RIGHT NOW. */
function resolve(): void {
  const championId = pending.shift();
  if (championId === undefined) return;
  if (getCurrentChampSelectChampionId() !== championId) {
    abandonFollowAttempt(championId);
    return;
  }
  commitFollowAttempt(championId);
  shown = championId;
}

/** The attempt loses without applying — a re-render, an unmount, a network
 *  failure. Under the old gate this was silent and permanent. */
function discard(): void {
  const championId = pending.shift();
  if (championId !== undefined) abandonFollowAttempt(championId);
}

/** The user manually searches a different champion. Nothing in the follow state
 *  changes: that is the Round-B P2 contract. */
function manualBrowse(championId: number): void {
  shown = championId;
}

beforeEach(() => {
  resetChampSelectFollowState();
  shown = null;
  pending = [];
  noteCompanionPhase("None");
});

const VOLIBEAR = 106;
const AHRI = 103;
const WUKONG = 62;

describe("live-follow sequence", () => {
  it("follows the champ-select champion on the first tick that resolves one", () => {
    tick(VOLIBEAR);
    resolve();
    expect(shown).toBe(VOLIBEAR);
  });

  it("REGRESSION (2026-08-18): a discarded attempt is retried on the next tick, not lost forever", () => {
    tick(VOLIBEAR);
    // The mount commit re-renders (the restored last champion sets the lane) and
    // the in-flight resolution is thrown away. THIS is the reported bug: the old
    // gate had already recorded Volibear as followed, so no later tick retried
    // and the page showed the previous champion for the whole draft.
    discard();
    expect(shown).toBeNull();

    tick(VOLIBEAR); // next poll, same champion, nothing else changed
    resolve();
    expect(shown).toBe(VOLIBEAR);
  });

  it("a steady stream of ticks for the SAME champion starts exactly one attempt", () => {
    tick(VOLIBEAR);
    tick(VOLIBEAR);
    tick(VOLIBEAR);
    expect(pending).toEqual([VOLIBEAR]);
    resolve();
    expect(shown).toBe(VOLIBEAR);
    tick(VOLIBEAR);
    expect(pending).toEqual([]); // settled: no re-fire
  });

  it("rapid switching lands on the LAST champion, and an earlier response cannot overwrite it", () => {
    tick(VOLIBEAR);
    tick(AHRI); // the user moved on before the first list came back
    tick(WUKONG);
    expect(pending).toEqual([VOLIBEAR, AHRI, WUKONG]);

    resolve(); // Volibear's list arrives — stale, must not render
    expect(shown).toBeNull();
    resolve(); // Ahri's — also stale
    expect(shown).toBeNull();
    resolve(); // Wukong's — current
    expect(shown).toBe(WUKONG);

    // And an out-of-order latecomer for a superseded champion still cannot win.
    tick(WUKONG);
    expect(pending).toEqual([]);
    expect(shown).toBe(WUKONG);
  });

  it("out-of-order responses: the LATER champion resolving FIRST still wins", () => {
    tick(VOLIBEAR);
    tick(AHRI);
    // Ahri (the current champion) comes back first.
    pending = [AHRI, VOLIBEAR];
    resolve();
    expect(shown).toBe(AHRI);
    resolve(); // Volibear's slow response lands afterwards
    expect(shown).toBe(AHRI);
  });

  it("a manual browse is respected: the follow does not yank the user back", () => {
    tick(VOLIBEAR);
    resolve();
    manualBrowse(AHRI);
    tick(VOLIBEAR); // champ select has NOT changed
    tick(VOLIBEAR);
    expect(pending).toEqual([]);
    expect(shown).toBe(AHRI);
  });

  it("...and resumes on the next genuine champion change", () => {
    tick(VOLIBEAR);
    resolve();
    manualBrowse(AHRI);
    tick(WUKONG); // the user actually re-picked
    resolve();
    expect(shown).toBe(WUKONG);
  });

  it("a NEW champ select re-follows a champion that was followed in the previous one", () => {
    tick(VOLIBEAR);
    resolve();
    noteCompanionPhase("InProgress");
    noteCompanionPhase("None");
    shown = null;
    tick(VOLIBEAR); // next game, same champion
    resolve();
    expect(shown).toBe(VOLIBEAR);
  });
});
