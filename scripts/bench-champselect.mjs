// ─────────────────────────────────────────────────────────────────────────────
// bench-champselect.mjs — end-to-end champ-select follow latency bench.
//
// WHY THIS EXISTS. "The Builds page didn't follow my champ-select pick" and
// "make it snappier" are both claims about a pipeline that spans three
// processes (League's LCU -> the .NET bridge -> the web app in WebView2). No
// unit test can measure it and no code read can prove it, so this drives the
// REAL web app in a REAL Chrome against a FAKE companion bridge that speaks
// the exact /status wire contract (components/live/companionClient.ts), and
// timestamps the DOM.
//
// What it does NOT simulate: League itself and the .NET GameflowPoller. Its
// t0 is "the bridge's /status now reports champion X", i.e. the app-side
// budget only. The bridge adds its own poll interval on top (1500ms, see
// desktop/src/CoachBuild.Core/GameflowPoller.cs) — that number is reported
// separately in the handoff rather than folded in here, because this harness
// cannot observe it.
//
// Usage:
//   node scripts/bench-champselect.mjs --base http://localhost:3000 --label before
//
// Requires: a built app already serving on --base (npm run build && npm start),
// system Chrome, puppeteer-core (already a devDependency).
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const BASE = arg("base", "http://localhost:3000");
const LABEL = arg("label", "run");
const BRIDGE_PORT = Number(arg("bridge-port", "48291"));
const HEADLESS = arg("headless", "true") !== "false";
const CHROME =
  arg("chrome", "") ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SESSION = "bench-session-token-0123456789abcdef";
// The lane the stored "last champion you looked at" is restored on. This is a
// KNOB, not a detail: app/page.tsx seeds activeLane to "mid", so restoring a
// champion on any OTHER lane changes activeLane during the mount commit — the
// exact discriminator for the lost-follow defect. Run the bench with both
// --last-lane top and --last-lane mid to see the mechanism switch on and off.
const LAST_LANE = arg("last-lane", "top");

// Champions used by the bench. Ids are the live roster's own ids (the same
// ones /api/champions returns) — Wukong is the champion the user's own report
// was stuck on, Volibear is the one champ select had actually picked.
const WUKONG = { id: 62, key: "MonkeyKing", name: "Wukong" };
const VOLIBEAR = { id: 106, key: "Volibear", name: "Volibear" };
const AHRI = { id: 103, key: "Ahri", name: "Ahri" };
const JHIN = { id: 202, key: "Jhin", name: "Jhin" };

// ── Fake companion bridge ───────────────────────────────────────────────────
// Mirrors CompanionState.ToStatus (desktop/src/CoachBuild.Core) byte-for-byte
// in shape. Origin is echoed back so a localhost-served app can read it; the
// real bridge pins the deployed origin instead, which changes nothing about
// the timing being measured.
const bridge = {
  phase: "None",
  champSelect: null,
  statusRequests: 0,
  statusTimes: [],
};

function setChampSelect(champion, roleId) {
  bridge.phase = "ChampSelect";
  bridge.champSelect = champion
    ? {
        localPlayerCellId: 3,
        cellChampionId: champion.id,
        pickIntent: null,
        actionChampionId: null,
        roleId,
        theirTeam: [],
        timerPhase: "BAN_PICK",
      }
    : null;
  return Date.now();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  const headers = {
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (url.pathname === "/status") {
    bridge.statusRequests += 1;
    bridge.statusTimes.push(Date.now());
    res.writeHead(200, headers);
    res.end(
      JSON.stringify({
        version: "1.14.1",
        port: BRIDGE_PORT,
        phase: bridge.phase,
        clientConnected: true,
        lastOpen: null,
        champSelect: bridge.phase === "ChampSelect" ? bridge.champSelect : null,
        lastPollAt: new Date().toISOString(),
        lastError: null,
      })
    );
    return;
  }
  // apply-runes / apply-itemsets: answer honestly-failing so auto-export (if
  // enabled) cannot silently succeed and skew the run.
  res.writeHead(200, headers);
  res.end(JSON.stringify({ ok: false, reason: "bench-bridge" }));
});

// ── Page-side instrumentation ───────────────────────────────────────────────
// Installed before any app script runs. Records, per champion NAME, the first
// wall-clock ms at which the hero <h1> showed it and at which a build tabpanel
// (BuildTabContent's non-loading render) was on screen under that name.
// Installed as a real function (NOT eval'd from a string) — the app ships a
// CSP without `unsafe-eval`, so a string-eval instrument silently never
// installs and every measurement below would read as a timeout that had
// nothing to do with the app. See MEMORY: instrument-alive assertions.
function instrument() {
  window.__bench = { hero: {}, data: {}, marks: [] };
  const heroName = () => {
    const h1 = document.querySelector("h1");
    return h1 ? (h1.textContent || "").trim() : null;
  };
  const dataReady = () => !!document.querySelector('[role="tabpanel"]');
  const sample = () => {
    const name = heroName();
    if (!name) return;
    const now = Date.now();
    if (window.__bench.hero[name] === undefined) {
      window.__bench.hero[name] = now;
      window.__bench.marks.push({ t: now, hero: name });
    }
    if (dataReady() && window.__bench.data[name] === undefined) {
      window.__bench.data[name] = now;
      window.__bench.marks.push({ t: now, data: name });
    }
  };
  // `document` (not document.documentElement): this script runs before the
  // document element exists, and observing a null node throws, which is
  // exactly how an instrument dies silently and every reading below reads as
  // a timeout that has nothing to do with the app.
  new MutationObserver(sample).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  setInterval(sample, 25);
  window.__benchReset = () => {
    window.__bench = { hero: {}, data: {}, marks: [] };
  };
  window.__benchInstrumented = true;
}

async function waitFor(page, fn, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await page.evaluate(fn);
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const WAIT_HERO = (name) => "window.__bench.hero[" + JSON.stringify(name) + "] ?? null";
const WAIT_DATA = (name) => "window.__bench.data[" + JSON.stringify(name) + "] ?? null";

function ms(v) {
  return v === null || v === undefined ? "TIMEOUT" : `${v}ms`;
}

async function main() {
  await new Promise((resolve) => server.listen(BRIDGE_PORT, "127.0.0.1", resolve));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-bench-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    userDataDir,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults",
      "--allow-running-insecure-content",
      "--window-size=1600,1000",
    ],
  });

  const results = { label: LABEL, base: BASE, scenarios: {} };
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(
    (session, port, wukong, lastLane) => {
      localStorage.setItem("coachbuild:companion:session", session);
      localStorage.setItem("coachbuild:companion:port", String(port));
      // The user's own reported precondition: a previously-viewed champion is
      // restored on mount, on a lane that is NOT the page's initial "mid".
      localStorage.setItem(
        "coachbuild:lastChampion:v1",
        JSON.stringify({
          champ: {
            id: wukong.id,
            key: wukong.key,
            name: wukong.name,
            icon: `https://cdn.coachless.gg/static-files/16.12.1/16.12.1/img/champion/${wukong.key}.webp`,
          },
          lane: lastLane,
        })
      );
      // Auto-export OFF: the pessimistic case. AutoExporter's own /api/build
      // fetch would otherwise warm the network for free and flatter the run.
      localStorage.setItem("coachbuild:companion:autoItemSets", "false");
      localStorage.setItem("coachbuild:companion:autoRunes", "false");
    },
    SESSION,
    BRIDGE_PORT,
    WUKONG,
    LAST_LANE
  );
  await page.evaluateOnNewDocument(instrument);

  const consoleErrors = [];
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  // ── Scenario A: champ select is live on /draft, user navigates to Builds ──
  setChampSelect(VOLIBEAR, 0);
  await page.goto(`${BASE}/draft?session=${SESSION}`, { waitUntil: "domcontentloaded" });
  const instrumented = await waitFor(page, "window.__benchInstrumented === true", 15000);
  const polled = await waitFor(page, "!!window.localStorage.getItem('coachbuild:companion:port')", 15000);
  // Give the app-wide poll time to establish phase + champSelect before the nav.
  await new Promise((r) => setTimeout(r, 6000));
  const bridgeSawPolls = bridge.statusRequests;

  await page.evaluate("window.__benchReset()");
  const tA0 = Date.now();
  const navigated = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/" && (a.textContent || "").includes("Builds")
    );
    if (!link) return false;
    link.click();
    return true;
  });
  const heroA = await waitFor(
    page,
    `window.__bench.hero[${JSON.stringify(VOLIBEAR.name)}] ?? null`,
    20000
  );
  const dataA = await waitFor(
    page,
    `window.__bench.data[${JSON.stringify(VOLIBEAR.name)}] ?? null`,
    20000
  );
  const shownAfterA = await page.evaluate(
    "(document.querySelector('h1')||{}).textContent || null"
  );
  results.scenarios.A_navigate_to_builds = {
    description:
      "champ select live (Volibear TOP), stored lastChampion Wukong on lane below, user clicks Builds in the rail",
    storedLastChampionLane: LAST_LANE,
    instrumented: instrumented === true,
    portStored: polled === true,
    bridgeStatusPollsBeforeNav: bridgeSawPolls,
    navigatedViaRailLink: navigated === true,
    heroLatencyMs: heroA === null ? null : heroA - tA0,
    dataLatencyMs: dataA === null ? null : dataA - tA0,
    heroTextAfter: shownAfterA,
  };

  // ── Scenario B: champion switched while the Builds page is already open ───
  // Make sure the page is on Builds and settled first.
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate("window.__benchReset()");
  const tB0 = setChampSelect(AHRI, 2);
  const heroB = await waitFor(page, `window.__bench.hero[${JSON.stringify(AHRI.name)}] ?? null`, 20000);
  const dataB = await waitFor(page, `window.__bench.data[${JSON.stringify(AHRI.name)}] ?? null`, 20000);
  results.scenarios.B_switch_while_on_builds = {
    description: "already on Builds; champ select switches to Ahri MID",
    heroLatencyMs: heroB === null ? null : heroB - tB0,
    dataLatencyMs: dataB === null ? null : dataB - tB0,
  };

  // ── Scenario C: rapid switching — the last champion must win ─────────
  // The reset happens AFTER the first change so the sampler cannot record the
  // champion still on screen from the previous scenario as if it were a fresh
  // render (that produced a nonsensical negative latency on the first run).
  await new Promise((r) => setTimeout(r, 4000));
  setChampSelect(VOLIBEAR, 0);
  await page.evaluate("window.__benchReset()");
  await new Promise((r) => setTimeout(r, 400));
  setChampSelect(JHIN, 3);
  await new Promise((r) => setTimeout(r, 400));
  const tCLast = setChampSelect(WUKONG, 0);
  const heroC = await waitFor(page, WAIT_HERO(WUKONG.name), 20000);
  // Settle well past two poll intervals, then assert nothing overwrote it.
  await new Promise((r) => setTimeout(r, 9000));
  const finalC = await page.evaluate("(document.querySelector('h1')||{}).textContent || null");
  const seenC = await page.evaluate("Object.keys(window.__bench.hero)");
  results.scenarios.C_rapid_switch = {
    description: "Volibear -> Jhin -> Wukong, 400ms apart; final render must be Wukong",
    heroLatencyFromLastChangeMs: heroC === null ? null : heroC - tCLast,
    championsRenderedDuringBurst: seenC,
    finalHeroText: finalC,
    lastChampionWins: finalC === WUKONG.name,
  };

  // ── Scenario D: repeat champion (cache path) ─────────────────────────────
  await page.evaluate("window.__benchReset()");
  const tD0 = setChampSelect(AHRI, 2);
  const heroD = await waitFor(page, `window.__bench.hero[${JSON.stringify(AHRI.name)}] ?? null`, 20000);
  const dataD = await waitFor(page, `window.__bench.data[${JSON.stringify(AHRI.name)}] ?? null`, 20000);
  results.scenarios.D_repeat_champion = {
    description: "back to Ahri MID — a champion whose build was already fetched this run",
    heroLatencyMs: heroD === null ? null : heroD - tD0,
    dataLatencyMs: dataD === null ? null : dataD - tD0,
  };

  // ── Scenario E: N champion switches, so the headline number is a
  // DISTRIBUTION and not one lucky sample. The app polls the bridge on a fixed
  // cadence, so where a change lands inside that window swings a single reading
  // by the width of the whole interval — which is precisely the term this work
  // set out to shrink, and precisely the term one sample cannot measure.
  const rotation = [VOLIBEAR, AHRI, JHIN, WUKONG];
  const roleFor = new Map([
    [VOLIBEAR.id, 0],
    [AHRI.id, 2],
    [JHIN.id, 3],
    [WUKONG.id, 0],
  ]);
  const trials = [];
  for (let i = 0; i < 8; i += 1) {
    const champion = rotation[i % rotation.length];
    // Settle between trials so each one starts from a quiet page, and offset the
    // wait so the changes do not all land at the same point in the poll cycle.
    await new Promise((r) => setTimeout(r, 2500 + (i % 4) * 250));
    await page.evaluate("window.__benchReset()");
    const t0 = setChampSelect(champion, roleFor.get(champion.id));
    const hero = await waitFor(page, WAIT_HERO(champion.name), 15000);
    const data = await waitFor(page, WAIT_DATA(champion.name), 15000);
    trials.push({
      champion: champion.name,
      heroMs: hero === null ? null : hero - t0,
      dataMs: data === null ? null : data - t0,
    });
  }
  const finite = (key) => trials.map((t) => t[key]).filter((v) => v !== null).sort((a, b) => a - b);
  const summarize = (key) => {
    const v = finite(key);
    if (v.length === 0) return { n: 0, min: null, median: null, max: null, timeouts: trials.length };
    return {
      n: v.length,
      min: v[0],
      median: v[Math.floor(v.length / 2)],
      max: v[v.length - 1],
      timeouts: trials.length - v.length,
    };
  };
  results.scenarios.E_switch_trials = {
    description: "8 champion switches while the Builds page is open",
    trials,
    hero: summarize("heroMs"),
    data: summarize("dataMs"),
  };

  results.pageErrors = consoleErrors;
  results.bridgeStatusRequestsTotal = bridge.statusRequests;

  await page.screenshot({ path: `scripts/.bench-${LABEL}.png` });
  await browser.close();
  server.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* temp profile cleanup is best-effort */
  }

  console.log(JSON.stringify(results, null, 2));
  console.log("");
  console.log(`── ${LABEL} ─────────────────────────────`);
  for (const [name, sc] of Object.entries(results.scenarios)) {
    if (sc.hero) {
      console.log(
        `${name}: hero min/med/max ${ms(sc.hero.min)}/${ms(sc.hero.median)}/${ms(sc.hero.max)} ` +
          `(${sc.hero.timeouts} timeouts) | data min/med/max ${ms(sc.data.min)}/${ms(sc.data.median)}/${ms(sc.data.max)} ` +
          `(${sc.data.timeouts} timeouts)`
      );
      continue;
    }
    console.log(
      `${name}: hero ${ms(sc.heroLatencyMs ?? sc.heroLatencyFromLastChangeMs)} / data ${ms(sc.dataLatencyMs)}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
