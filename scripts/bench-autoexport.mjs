// ─────────────────────────────────────────────────────────────────────────────
// bench-autoexport.mjs — how long after a champ-select champion change does
// the app actually WRITE runes / item sets to the bridge?
//
// WHY THIS EXISTS. 2026-08-19, on-device: "for like 20s the runes didnt change
// as i switched to udyr then went back to galio quickly. It stayed on udyr
// runes but changed after a while." Their companion.log shows apply-runes at
// 14:30:29 and 14:30:31, then nothing until 14:30:59 — a 28-second hole. No
// unit test can produce that number: it is a property of the real app running
// against a real /status poll, and the mechanism behind it (a localStorage
// record shared across tabs) only exists in a browser.
//
// This is bench-champselect.mjs's sibling and deliberately NOT an extension of
// it: that one measures the Builds page FOLLOWING a champion with auto-export
// OFF (the pessimistic render path); this one measures the WRITE path with
// auto-export ON. Merging them would make each one's numbers depend on the
// other's preconditions.
//
// t0 is "the bridge's /status now reports champion X" — the app-side budget
// only. League's own client and the .NET GameflowPoller's 350ms champ-select
// tick sit upstream of that and are not folded in.
//
// Usage:
//   node scripts/bench-autoexport.mjs --base https://coachbuild.vercel.app --label after
//   node scripts/bench-autoexport.mjs --base http://localhost:3000 --label local
//
// Requires: system Chrome + puppeteer-core (already a devDependency). The base
// may be production — the fake bridge lives on http://127.0.0.1, which Chrome
// treats as a trustworthy origin, exactly as the real desktop app's WebView2
// does when it loads the deployed site and talks to the loopback tray server.
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

const BASE = arg("base", "https://coachbuild.vercel.app");
const LABEL = arg("label", "run");
const BRIDGE_PORT = Number(arg("bridge-port", "48293"));
const HEADLESS = arg("headless", "true") !== "false";
const CHROME =
  arg("chrome", "") || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SESSION = "bench-session-token-0123456789abcdef";
/** How long to wait for an apply after a switch before calling it a miss. The
 *  defect being measured is ~30s, so this must be comfortably longer or a
 *  "before" run would report a timeout instead of the number. */
const APPLY_TIMEOUT_MS = Number(arg("timeout", "45000"));

// Real roster ids. Galio/Udyr are the champions in the user's own report.
const GALIO = { id: 3, key: "Galio", name: "Galio", roleId: 2 };
const UDYR = { id: 77, key: "Udyr", name: "Udyr", roleId: 1 };

// ── Fake companion bridge ───────────────────────────────────────────────────
const bridge = {
  phase: "None",
  champSelect: null,
  applies: [], // { t, kind, championId, name }
  statusRequests: 0,
};

function setChampSelect(champion) {
  bridge.phase = "ChampSelect";
  bridge.champSelect = champion
    ? {
        localPlayerCellId: 3,
        cellChampionId: champion.id,
        pickIntent: null,
        actionChampionId: null,
        roleId: champion.roleId,
        theirTeam: [],
        timerPhase: "BAN_PICK",
      }
    : null;
  return Date.now();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`);
  const headers = {
    "Access-Control-Allow-Origin": req.headers.origin ?? "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  if (url.pathname === "/status") {
    bridge.statusRequests += 1;
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
  if (url.pathname === "/apply-runes") {
    const body = await readBody(req);
    // The rune page name is `CoachBuild <Champion> <Role>` — the only place
    // the champion identity survives into this payload.
    bridge.applies.push({ t: Date.now(), kind: "runes", name: body?.name ?? null, championId: null });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, selected: true, verified: true }));
    return;
  }
  if (url.pathname === "/apply-itemsets") {
    const body = await readBody(req);
    bridge.applies.push({
      t: Date.now(),
      kind: "items",
      championId: body?.championId ?? null,
      name: Array.isArray(body?.sets) ? body.sets.map((s) => s?.title).join(" | ") : null,
      setCount: Array.isArray(body?.sets) ? body.sets.length : null,
      blockTitles: Array.isArray(body?.sets) ? (body.sets[0]?.blocks ?? []).map((b) => b?.type) : null,
    });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not-found" }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits for an apply of `kind` naming `champion` that landed at or after
 *  `since`. Returns the record, or null on timeout. */
async function waitForApply(kind, champion, since, timeout = APPLY_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = bridge.applies.find(
      (a) =>
        a.t >= since &&
        a.kind === kind &&
        (kind === "items" ? a.championId === champion.id : String(a.name ?? "").includes(champion.name))
    );
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

async function main() {
  await new Promise((resolve) => server.listen(BRIDGE_PORT, "127.0.0.1", resolve));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ax-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    userDataDir,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults",
      "--window-size=1600,1000",
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.evaluateOnNewDocument(
    (session, port) => {
      localStorage.setItem("coachbuild:companion:session", session);
      localStorage.setItem("coachbuild:companion:port", String(port));
      // The whole point of this bench, unlike bench-champselect.mjs.
      localStorage.setItem("coachbuild:companion:autoItemSets", "true");
      localStorage.setItem("coachbuild:companion:autoRunes", "true");
      window.__axInstrumented = true;
    },
    SESSION,
    BRIDGE_PORT
  );

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // Enter champ select on Galio BEFORE the page loads, so the first tick sees it.
  setChampSelect(GALIO);
  await page.goto(`${BASE}/draft?session=${SESSION}`, { waitUntil: "domcontentloaded" });

  // Instrument-alive assertions. Without these a run that never installed the
  // seed, or never reached the bridge, reports the same zeros as a broken app.
  const instrumented = await page.evaluate(() => window.__axInstrumented === true);
  const deadline = Date.now() + 20000;
  while (bridge.statusRequests === 0 && Date.now() < deadline) await sleep(50);
  const loadedVersion = await page.evaluate(() => {
    const m = document.querySelector('meta[name="coachbuild-version"]');
    return m ? m.getAttribute("content") : null;
  });

  const results = {
    label: LABEL,
    base: BASE,
    loadedVersion,
    instrumented,
    bridgeReached: bridge.statusRequests > 0,
    switches: [],
  };

  // ── Switch 1: the FIRST export for Galio (baseline, nothing cached) ───────
  const t0 = Date.now();
  const first = await waitForApply("runes", GALIO, t0);
  results.switches.push({ step: "initial Galio", champion: GALIO.name, ms: first ? first.t - t0 : null });

  // ── Switch 2: Galio -> Udyr ───────────────────────────────────────────────
  const t1 = setChampSelect(UDYR);
  const udyr = await waitForApply("runes", UDYR, t1);
  results.switches.push({ step: "Galio -> Udyr", champion: UDYR.name, ms: udyr ? udyr.t - t1 : null });

  // ── Switch 3: back to Galio — THE REPORTED CASE ───────────────────────────
  // Deliberately well inside the 30s window the old cross-tab record used.
  const t2 = setChampSelect(GALIO);
  const backRunes = await waitForApply("runes", GALIO, t2);
  const backItems = await waitForApply("items", GALIO, t2);
  results.switches.push({
    step: "Udyr -> Galio (the report)",
    champion: GALIO.name,
    ms: backRunes ? backRunes.t - t2 : null,
    itemsMs: backItems ? backItems.t - t2 : null,
  });

  // ── Switch 4/5: bounce again, to show it is not a one-off ─────────────────
  const t3 = setChampSelect(UDYR);
  const u2 = await waitForApply("runes", UDYR, t3);
  results.switches.push({ step: "Galio -> Udyr (2)", champion: UDYR.name, ms: u2 ? u2.t - t3 : null });
  const t4 = setChampSelect(GALIO);
  const g2 = await waitForApply("runes", GALIO, t4);
  results.switches.push({ step: "Udyr -> Galio (2)", champion: GALIO.name, ms: g2 ? g2.t - t4 : null });

  // ── Correctness: the LAST write must belong to the LAST champion ──────────
  await sleep(3000);
  const lastRunes = [...bridge.applies].reverse().find((a) => a.kind === "runes");
  const lastItems = [...bridge.applies].reverse().find((a) => a.kind === "items");
  results.finalChampion = GALIO.name;
  results.lastRuneWrite = lastRunes?.name ?? null;
  results.lastItemWrite = lastItems ? { championId: lastItems.championId, title: lastItems.name } : null;
  results.lastWriteIsFinalChampion =
    String(lastRunes?.name ?? "").includes(GALIO.name) && lastItems?.championId === GALIO.id;

  // ── What the shop actually receives, for the record ───────────────────────
  results.itemSetShape = lastItems
    ? { setCount: lastItems.setCount, blockTitles: lastItems.blockTitles }
    : null;

  results.applyCount = bridge.applies.length;
  results.pageErrors = pageErrors;

  console.log(JSON.stringify(results, null, 2));

  await browser.close();
  server.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // A Chrome profile dir Windows still holds a handle on. Harmless.
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
