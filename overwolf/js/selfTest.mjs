// ─────────────────────────────────────────────────────────────────────────────
// selfTest.mjs — standalone verification for skillOrderData.js.
//
// WHY THIS EXISTS INSTEAD OF A VITEST FILE (verified, not assumed): the repo's
// vitest.config.ts include glob is exactly
//   ["lib/**/__tests__/**/*.test.ts", "components/**/__tests__/**/*.test.ts"]
// which does NOT cover anything under overwolf/. Proven empirically before
// writing this file: `npx vitest run` reported "1806 tests" both before and
// after adding a throwaway overwolf/js/__tests__/_probe.test.ts (then
// removed) -- the file was never collected. This is the exact silent-
// exclusion gotcha CLAUDE.md's "Test conventions" section already documents
// for a prior, different directory. The task brief's constraint list forbids
// editing anything outside overwolf/ except package.json's scripts block, so
// widening the include glob is not this agent's call to make -- flagged in
// HANDOFF-engo.md as a real, live gap instead of silently shipping tests
// that would never run.
//
// Run with: node overwolf/js/selfTest.mjs
// Exits non-zero on any failed assertion (so it's CI/script-friendly even
// though nothing currently invokes it automatically).
// ─────────────────────────────────────────────────────────────────────────────

// Minimal window/localStorage shim -- the module only touches
// window.localStorage, lazily, inside function bodies, so defining this
// before importing is sufficient regardless of import ordering.
const storageBacking = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (storageBacking.has(k) ? storageBacking.get(k) : null),
    setItem: (k, v) => storageBacking.set(k, String(v)),
    removeItem: (k) => storageBacking.delete(k),
  },
};

const realFetch = globalThis.fetch;
let fetchCallLog = [];

function mockFetch(router) {
  fetchCallLog = [];
  globalThis.fetch = async (url) => {
    fetchCallLog.push(url);
    return router(url);
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${label}: expected ${e}, got ${a}`);
  }
}

function assertTrue(cond, label) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${label}: expected truthy`);
  }
}

async function main() {
  const mod = await import("./skillOrderData.js");
  const {
    laneToRoleId,
    readLane,
    laneLabel,
    resolveChampionId,
    fetchSkillOrder,
    clearSkillOrderCache,
    resolveOverlayData,
    CHAMPION_LIST_RETRY_COOLDOWN_MS,
    ERROR_RETRY_COOLDOWN_MS,
    NO_DATA_RETRY_COOLDOWN_MS,
  } = mod;

  // ── Retry-cooldown exports (2026-07-27 audit fix #2) ────────────────────
  // ingame.js imports these by name for its retry timer. A missing/renamed
  // export is NOT a thrown error on an ES module named import -- it silently
  // becomes `undefined`, which would silently disable the retry feature.
  // Pin the exact values so that regression is caught here instead.
  assertEq(CHAMPION_LIST_RETRY_COOLDOWN_MS, 5000, "CHAMPION_LIST_RETRY_COOLDOWN_MS exported with expected value");
  assertEq(ERROR_RETRY_COOLDOWN_MS, 15000, "ERROR_RETRY_COOLDOWN_MS exported with expected value");
  assertEq(NO_DATA_RETRY_COOLDOWN_MS, 60000, "NO_DATA_RETRY_COOLDOWN_MS exported with expected value");

  // ── laneToRoleId (pure) ────────────────────────────────────────────────
  assertEq(laneToRoleId("TOP"), 0, "laneToRoleId TOP");
  assertEq(laneToRoleId("JUNGLE"), 1, "laneToRoleId JUNGLE");
  assertEq(laneToRoleId("MID"), 2, "laneToRoleId MID");
  assertEq(laneToRoleId("BOT"), 3, "laneToRoleId BOT");
  assertEq(laneToRoleId("SUPPORT"), 4, "laneToRoleId SUPPORT");
  assertEq(laneToRoleId("top"), null, "laneToRoleId lowercase rejected");
  assertEq(laneToRoleId("MIDDLE"), null, "laneToRoleId garbage rejected");
  assertEq(laneToRoleId(null), null, "laneToRoleId null-safe");
  assertEq(laneLabel("BOT"), "Bot", "laneLabel BOT");

  // ── readLane (localStorage contract) ──────────────────────────────────
  storageBacking.clear();
  assertEq(readLane(), null, "readLane empty storage");
  storageBacking.set("coachbuild.overwolf.lane", "MID");
  assertEq(readLane(), "MID", "readLane valid value");
  storageBacking.set("coachbuild.overwolf.lane", "not-a-real-lane");
  assertEq(readLane(), null, "readLane rejects invalid stored value");
  storageBacking.set("coachbuild.overwolf.lane", "SUPPORT");

  // ── resolveChampionId: "unavailable" vs "not-found" (audit fix #1) ─────
  // This needs its OWN fresh module instance: championList is a module-level
  // singleton cache, and by the time the happy-path block below runs it will
  // already hold a value from a successful mock -- "unavailable" can't be
  // provoked against an already-warm cache. A cache-busted specifier gives
  // Node's ESM loader a distinct module graph with its own untouched state,
  // sharing only the injected window.localStorage shim (module-external).
  {
    const isolatedMod = await import(`./skillOrderData.js?selfTest-unavailable=${Date.now()}`);
    mockFetch((url) => {
      if (String(url).includes("/api/champions")) return jsonResponse({ error: "boom" }, 500);
      throw new Error(`unexpected fetch in unavailable-block: ${url}`);
    });

    assertEq(
      await isolatedMod.resolveChampionId("Corki"),
      { status: "unavailable" },
      "resolveChampionId: champion-list fetch failure -> 'unavailable', NOT 'not-found' (the P1 the audit caught: a network failure must not be reported as a champion the app doesn't recognize)"
    );

    storageBacking.set("coachbuild.overwolf.lane", "MID");
    const overlayResult = await isolatedMod.resolveOverlayData({ inGame: true, championName: "Corki" });
    assertEq(
      overlayResult.phase,
      "unavailable",
      "resolveOverlayData: champion-list failure surfaces as its own 'unavailable' phase, not 'unresolved-champion'"
    );
  }

  // ── resolveChampionId (id resolution + display name, against a mocked
  //    /api/champions) ────────────────────────────────────────────────────
  const CHAMPION_LIST = [
    { id: 42, key: "Corki", name: "Corki" },
    { id: 99, key: "MonkeyKing", name: "Wukong" },
  ];
  mockFetch((url) => {
    if (String(url).includes("/api/champions")) return jsonResponse(CHAMPION_LIST);
    throw new Error(`unexpected fetch in champion-id block: ${url}`);
  });

  assertEq(await resolveChampionId("Corki"), { status: "ok", id: 42, name: "Corki" }, "resolveChampionId exact key");
  assertEq(
    await resolveChampionId("game_character_displayname_Corki"),
    { status: "ok", id: 42, name: "Corki" },
    "resolveChampionId strips raw prefix"
  );
  assertEq(
    await resolveChampionId("wukong"),
    { status: "ok", id: 99, name: "Wukong" },
    "resolveChampionId fuzzy display-name match (key 'MonkeyKing' diverges from name 'Wukong') -- also proves audit fix #4's proper display name is returned, not the internal key"
  );
  assertEq(await resolveChampionId("Xyzzy"), { status: "not-found" }, "resolveChampionId unknown champion -> not-found, not a guess");
  assertEq(await resolveChampionId(null), { status: "not-found" }, "resolveChampionId null-safe");
  assertEq(await resolveChampionId(""), { status: "not-found" }, "resolveChampionId empty-string-safe");
  assertEq(fetchCallLog.length, 1, "champion list fetched exactly once across 6 resolves (in-memory cache holds)");

  // ── fetchSkillOrder (the 200-with-null contract + error caching) ───────
  clearSkillOrderCache();
  const MODEL_OK = {
    priority: ["Q", "W", "E"],
    levels: { Q: [1], W: [], E: [], R: [] },
    order: Array(15).fill("Q"),
    completed: false,
    sampleSize: 12345,
    winRate: 0.52,
    share: 0.3,
  };
  mockFetch((url) => {
    const u = String(url);
    if (u.includes("champ=1&role=0")) return jsonResponse(null); // documented "no-data" answer
    if (u.includes("champ=2&role=0")) return jsonResponse(MODEL_OK);
    if (u.includes("champ=3&role=0")) return jsonResponse({ error: "boom" }, 500);
    if (u.includes("champ=5&role=0")) return jsonResponse(MODEL_OK);
    throw new Error(`unexpected fetch in skill-order block: ${url}`);
  });

  assertEq((await fetchSkillOrder(1, 0)).status, "no-data", "fetchSkillOrder: 200+null -> no-data, not error");
  const okResult = await fetchSkillOrder(2, 0);
  assertEq(okResult.status, "ok", "fetchSkillOrder: valid model -> ok");
  assertTrue(Array.isArray(okResult.model.order) && okResult.model.order.length === 15, "fetchSkillOrder: model payload passed through");
  assertEq((await fetchSkillOrder(3, 0)).status, "error", "fetchSkillOrder: HTTP 500 -> error");

  const callsAfterFirstRound = fetchCallLog.length;
  await fetchSkillOrder(1, 0);
  await fetchSkillOrder(2, 0);
  assertEq(fetchCallLog.length, callsAfterFirstRound, "fetchSkillOrder: ok/no-data results served from cache, no re-fetch");

  await fetchSkillOrder(3, 0); // error entry, within its 15s cooldown
  assertEq(fetchCallLog.length, callsAfterFirstRound, "fetchSkillOrder: error result NOT re-fetched before its retry cooldown");

  clearSkillOrderCache();
  await fetchSkillOrder(2, 0);
  assertEq(fetchCallLog.length, callsAfterFirstRound + 1, "fetchSkillOrder: clearSkillOrderCache forces a real re-fetch");

  // ── in-flight dedup (audit fix #6) ──────────────────────────────────────
  clearSkillOrderCache();
  const callsBeforeDedup = fetchCallLog.length;
  const [dedupA, dedupB] = await Promise.all([fetchSkillOrder(5, 0), fetchSkillOrder(5, 0)]);
  assertEq(
    fetchCallLog.length,
    callsBeforeDedup + 1,
    "fetchSkillOrder: two concurrent calls for the same (championId, roleId) issue exactly ONE network request"
  );
  assertEq(dedupA.status, "ok", "fetchSkillOrder: dedup -- first caller gets the resolved result");
  assertEq(dedupB.status, "ok", "fetchSkillOrder: dedup -- second caller gets the SAME resolved result, not a second fetch");

  // ── resolveOverlayData (full orchestration + game-scoped cache clear) ──
  clearSkillOrderCache();
  fetchCallLog = [];
  mockFetch((url) => {
    const u = String(url);
    if (u.includes("/api/champions")) return jsonResponse(CHAMPION_LIST);
    if (u.includes("/api/skill-order")) return jsonResponse(MODEL_OK);
    throw new Error(`unexpected fetch in orchestration block: ${url}`);
  });
  storageBacking.set("coachbuild.overwolf.lane", "MID");

  assertEq((await resolveOverlayData({ inGame: false })).phase, "not-in-game", "resolveOverlayData: inGame false");

  storageBacking.delete("coachbuild.overwolf.lane");
  assertEq((await resolveOverlayData({ inGame: true })).phase, "no-lane", "resolveOverlayData: no lane selected");

  storageBacking.set("coachbuild.overwolf.lane", "MID");
  assertEq(
    (await resolveOverlayData({ inGame: true, championName: null })).phase,
    "waiting-for-champion",
    "resolveOverlayData: level known, champion not yet -- ordinary, not an error (matches the live capture: activeplayer and playerlist are separate calls)"
  );

  assertEq(
    (await resolveOverlayData({ inGame: true, championName: "NobodyChampion" })).phase,
    "unresolved-champion",
    "resolveOverlayData: unrecognized champion name (list loaded fine) -> quiet fallback, not a crash"
  );

  const resolved = await resolveOverlayData({
    inGame: true,
    championName: "Corki",
    championLevel: 7,
    abilityRanks: { Q: 3, W: 2, E: 1, R: 1 },
  });
  assertEq(resolved.phase, "resolved", "resolveOverlayData: full happy path");
  assertEq(resolved.championId, 42, "resolveOverlayData: resolved id matches mocked list");
  assertEq(resolved.championDisplayName, "Corki", "resolveOverlayData: championDisplayName attached (audit fix #4)");
  assertEq(resolved.skillOrder.status, "ok", "resolveOverlayData: skill order attached");
  assertEq(resolved.championLevel, 7, "resolveOverlayData: level passed through validated");

  const wukongResolved = await resolveOverlayData({ inGame: true, championName: "wukong", championLevel: 3 });
  assertEq(
    wukongResolved.championDisplayName,
    "Wukong",
    "resolveOverlayData: championDisplayName is the PROPER display name end-to-end, even when the matching identifier was internal/lowercase"
  );

  const callsBeforeReplay = fetchCallLog.length;
  await resolveOverlayData({ inGame: true, championName: "Corki", championLevel: 8 });
  assertEq(fetchCallLog.length, callsBeforeReplay, "resolveOverlayData: same game, same champ+lane -> skill-order cache hit (only ranks/level changed)");

  // New game (inGame false -> true) must clear the per-game cache, per the
  // task brief's "cache per (champion, lane) for the duration of a game."
  await resolveOverlayData({ inGame: false });
  await resolveOverlayData({ inGame: true, championName: "Corki", championLevel: 1 });
  assertTrue(fetchCallLog.length > callsBeforeReplay, "resolveOverlayData: new-game transition clears the skill-order cache (re-fetches)");

  // ── Restore real fetch, then ONE live smoke test against prod ──────────
  globalThis.fetch = realFetch;
  clearSkillOrderCache();
  console.log("\n--- LIVE smoke test against https://coachbuild.vercel.app (real network) ---");
  try {
    const champId = await resolveChampionIdLiveIsolated();
    console.log(`GET /api/champions -> resolved "Ahri" to id ${champId}`);
    assertTrue(typeof champId === "number", "LIVE: /api/champions resolves a known champion name");

    if (typeof champId === "number") {
      const live = await mod.fetchSkillOrder(champId, 2); // Ahri, Mid
      console.log(`GET /api/skill-order?champ=${champId}&role=2 -> status=${live.status}`);
      assertTrue(live.status === "ok" || live.status === "no-data", "LIVE: /api/skill-order returns an honest ok/no-data (not error)");
    }
  } catch (err) {
    failed += 1;
    failures.push(`LIVE smoke test threw: ${err && err.message ? err.message : err}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

// Champion list module cache from the mocked block above would otherwise
// serve the live call from stale mocked data -- force a clean re-fetch by
// re-importing is not possible for a singleton-module cache, so this hits
// /api/champions directly instead, bypassing the poisoned in-module cache.
async function resolveChampionIdLiveIsolated() {
  const res = await fetch("https://coachbuild.vercel.app/api/champions");
  if (!res.ok) throw new Error(`GET /api/champions -> HTTP ${res.status}`);
  const list = await res.json();
  const ahri = Array.isArray(list) ? list.find((c) => c.key === "Ahri" || c.name === "Ahri") : null;
  return ahri ? ahri.id : null;
}

main();
