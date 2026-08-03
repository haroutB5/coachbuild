import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CHAMPION_SEARCH_EVENT, emitChampionSearch, subscribeChampionSearch } from "../hextech/championSearchBus";
import type { ChampionRef } from "@/lib/types";

function ref(over: Partial<ChampionRef> & { id: number }): ChampionRef {
  return { key: `C${over.id}`, name: `Champ${over.id}`, icon: "x", ...over };
}

describe("championSearchBus (SSR safety, no window)", () => {
  it("emitChampionSearch is a no-op and never throws when window is undefined", () => {
    expect(typeof window).toBe("undefined");
    expect(() => emitChampionSearch(ref({ id: 1 }))).not.toThrow();
  });

  it("subscribeChampionSearch returns a callable no-op unsubscribe when window is undefined", () => {
    const unsub = subscribeChampionSearch(() => {});
    expect(typeof unsub).toBe("function");
    expect(() => unsub()).not.toThrow();
  });
});

describe("championSearchBus (with a fake window, exercises the real pub/sub path)", () => {
  // vitest.config.ts pins environment:"node" (no jsdom) -- this repo's
  // convention for window-event modules (favoritesSync.ts) is to guard on
  // `typeof window === "undefined"` and go untested past that guard. Since
  // Node itself ships a real EventTarget/CustomEvent globally (v18+), a
  // minimal fake `window` here lets this module's actual dispatch/subscribe
  // wiring get real coverage instead of stopping at the SSR guard.
  let fakeWindow: EventTarget;

  beforeEach(() => {
    fakeWindow = new EventTarget();
    (globalThis as unknown as { window: EventTarget }).window = fakeWindow;
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: EventTarget }).window;
  });

  it("emitChampionSearch dispatches CHAMPION_SEARCH_EVENT with the ChampionRef as detail", () => {
    const received: ChampionRef[] = [];
    fakeWindow.addEventListener(CHAMPION_SEARCH_EVENT, (e) => {
      received.push((e as CustomEvent<ChampionRef>).detail);
    });
    const champ = ref({ id: 42, name: "Ahri" });
    emitChampionSearch(champ);
    expect(received).toEqual([champ]);
    // The external listener above is intentionally not a bus subscriber, so
    // drain the handoff slot before the next test simulates a fresh mount.
    const drain = subscribeChampionSearch(() => {});
    drain();
  });

  it("subscribeChampionSearch's callback fires with the emitted ref", () => {
    const received: ChampionRef[] = [];
    const unsub = subscribeChampionSearch((r) => received.push(r));
    const champ = ref({ id: 7, name: "Zed" });
    emitChampionSearch(champ);
    expect(received).toEqual([champ]);
    unsub();
  });

  it("drains a champion emitted before the Builds page listener mounted", () => {
    const received: ChampionRef[] = [];
    const champ = ref({ id: 19, name: "Ahri" });
    emitChampionSearch(champ);
    const unsub = subscribeChampionSearch((r) => received.push(r));
    expect(received).toEqual([champ]);
    unsub();
  });

  it("unsubscribe stops further callbacks from firing", () => {
    const received: ChampionRef[] = [];
    const unsub = subscribeChampionSearch((r) => received.push(r));
    unsub();
    emitChampionSearch(ref({ id: 9 }));
    expect(received).toEqual([]);
    // The no-subscriber emit is intentionally buffered for a future Builds
    // mount; consume it here so this isolated test does not seed the next one.
    const drain = subscribeChampionSearch(() => {});
    drain();
  });

  it("supports multiple independent subscribers", () => {
    const a: ChampionRef[] = [];
    const b: ChampionRef[] = [];
    const unsubA = subscribeChampionSearch((r) => a.push(r));
    const unsubB = subscribeChampionSearch((r) => b.push(r));
    const champ = ref({ id: 3 });
    emitChampionSearch(champ);
    expect(a).toEqual([champ]);
    expect(b).toEqual([champ]);
    unsubA();
    unsubB();
  });
});
