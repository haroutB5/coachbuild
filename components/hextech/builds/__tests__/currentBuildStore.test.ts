/**
 * Tests for components/hextech/builds/currentBuildStore.ts — how ChampionHero's
 * action buttons learn what BuildTabContent fetched.
 *
 * The staleness rule is the one worth pinning: the hero renders ABOVE the
 * component that owns the fetch, so during a champion or lane change the store
 * briefly still holds the previous request's build. If a button could act on
 * that, the fix would have replaced "does nothing" with "does the wrong thing".
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { BuildResponse, ChampionRef } from "@/lib/types";
import {
  buildRequestKey,
  getCurrentBuildSnapshot,
  getServerCurrentBuildSnapshot,
  publishCurrentBuild,
  resetCurrentBuild,
  snapshotForKey,
  subscribeCurrentBuild,
} from "../currentBuildStore";

const VIKTOR: ChampionRef = { id: 112, key: "Viktor", name: "Viktor", icon: "viktor.png" };
const AHRI: ChampionRef = { id: 103, key: "Ahri", name: "Ahri", icon: "ahri.png" };
const BUILD = { champion: VIKTOR, roleLabel: "MIDDLE" } as unknown as BuildResponse;

beforeEach(() => {
  resetCurrentBuild();
});

describe("buildRequestKey", () => {
  it("separates champion, champion key, lane and rank bracket", () => {
    expect(buildRequestKey(VIKTOR, "mid", "diamond-plus")).toBe("112:Viktor:mid:diamond-plus");
    expect(buildRequestKey(VIKTOR, "support", "diamond-plus")).not.toBe(buildRequestKey(VIKTOR, "mid", "diamond-plus"));
    expect(buildRequestKey(AHRI, "mid", "diamond-plus")).not.toBe(buildRequestKey(VIKTOR, "mid", "diamond-plus"));
  });
});

describe("publish / subscribe", () => {
  it("notifies subscribers and exposes the latest snapshot", () => {
    let calls = 0;
    const unsubscribe = subscribeCurrentBuild(() => {
      calls += 1;
    });
    const key = buildRequestKey(VIKTOR, "mid", "diamond-plus");
    publishCurrentBuild({ key, status: "ready", champ: VIKTOR, lane: "mid", build: BUILD });
    expect(calls).toBe(1);
    expect(getCurrentBuildSnapshot()).toMatchObject({ key, status: "ready" });
    unsubscribe();
    publishCurrentBuild({ key, status: "unavailable" });
    expect(calls).toBe(1);
  });

  it("returns an identity-stable snapshot when nothing has been published", () => {
    // useSyncExternalStore loops forever if getSnapshot/getServerSnapshot mints
    // a fresh object each call.
    expect(getCurrentBuildSnapshot()).toBe(getCurrentBuildSnapshot());
    expect(getServerCurrentBuildSnapshot()).toBe(getServerCurrentBuildSnapshot());
    expect(getServerCurrentBuildSnapshot().status).toBe("loading");
  });

  it("resetCurrentBuild clears a published build", () => {
    publishCurrentBuild({
      key: buildRequestKey(VIKTOR, "mid", "diamond-plus"),
      status: "ready",
      champ: VIKTOR,
      lane: "mid",
      build: BUILD,
    });
    resetCurrentBuild();
    expect(getCurrentBuildSnapshot().status).toBe("loading");
  });
});

describe("snapshotForKey", () => {
  const viktorMid = buildRequestKey(VIKTOR, "mid", "diamond-plus");
  const viktorSupport = buildRequestKey(VIKTOR, "support", "diamond-plus");

  it("passes a matching snapshot through unchanged", () => {
    const snap = { key: viktorMid, status: "ready", champ: VIKTOR, lane: "mid", build: BUILD } as const;
    expect(snapshotForKey(snap, viktorMid)).toBe(snap);
  });

  it("reads a different lane's build as not-yet-resolved, never as ready", () => {
    const snap = { key: viktorMid, status: "ready", champ: VIKTOR, lane: "mid", build: BUILD } as const;
    expect(snapshotForKey(snap, viktorSupport)).toEqual({ key: viktorSupport, status: "loading" });
  });

  it("reads a different champion's build as not-yet-resolved", () => {
    const snap = { key: viktorMid, status: "ready", champ: VIKTOR, lane: "mid", build: BUILD } as const;
    expect(snapshotForKey(snap, buildRequestKey(AHRI, "mid", "diamond-plus")).status).toBe("loading");
  });

  it("does not leak a stale 'unavailable' onto a lane that is still loading", () => {
    const snap = { key: viktorSupport, status: "unavailable" } as const;
    expect(snapshotForKey(snap, viktorMid).status).toBe("loading");
  });
});
