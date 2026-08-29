// ---------------------------------------------------------------------------
// bench-compreexport.mjs -- how many WHOLE-DOCUMENT item-set writes does one
// champ select actually produce, once the exported set responds to the enemy
// composition?
//
// WHY A BROWSER AND NOT A UNIT TEST. The unit tests in
// components/__tests__/compReexportStores.test.ts drive the same policy through
// the same stores and are the authority on the RULE. What they cannot produce
// is the number that matters in the field: the real /status poll runs on a
// timer inside a real page, the cross-tab dedup record lives in a real
// localStorage, and `theirTeam` arrives on the real wire contract. The
// 2026-08-19 rune cooldown (28 seconds, reported from a live game) was exactly
// this class of defect: every unit test passed and the browser did something
// else. This is bench-autoexport.mjs's sibling and shares its fake bridge.
//
// It drives ONE champ select the way a draft actually goes: the pick locks
// first, then enemies arrive one at a time, with hovers flickering in between
// (pickIntent, which is what `theirTeam` carries for an unlocked enemy). Then
// it counts `/apply-itemsets` calls and prints the block titles each one wrote,
// so a run shows both the cadence AND that the comp reached the shop.
//
// Usage (MUST be a build carrying the change; production will not have it):
//   node scripts/bench-compreexport.mjs --base http://localhost:3000
//
// Requires system Chrome + puppeteer-core (already a devDependency).
// ---------------------------------------------------------------------------

import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = arg("base", "http://localhost:3000");
const BRIDGE_PORT = Number(arg("bridge-port", "48292"));
// The app's own fail-closed allowlist (companionClient.ts COMPANION_PORTS).
// A port outside it makes getStoredPort() return null, the probe walks the
// three real ports, finds nothing, and the bench reports zero writes that look
// exactly like a broken feature. That happened on the first run of this script
// with 48294. Asserted here so it cannot happen quietly again.
const ALLOWED_PORTS = [48291, 48292, 48293];
if (!ALLOWED_PORTS.includes(BRIDGE_PORT)) {
  console.error(
    `bridge-port ${BRIDGE_PORT} is not in the app's COMPANION_PORTS allowlist ${JSON.stringify(ALLOWED_PORTS)}; ` +
      `the page would never call this bridge and every number below would be a false zero.`
  );
  process.exit(2);
}
const HEADLESS = arg("headless", "true") !== "false";
const CHROME = arg("chrome", "") || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SESSION = "bench-session-token-0123456789abcdef";
const SETTLE_MS = Number(arg("settle", "6000"));

// Thresh support: his own alts.boots carries Mercury's Treads at 1.15 against a
// chosen Ionian at 1.26, so a CC-heavy comp clears the WPA tolerance and the
// signal genuinely fires. Picked because it EXERCISES the path; a champion that
// never fires would make this bench report zeros that look like a pass.
const THRESH = { id: 412, key: "Thresh", name: "Thresh", roleId: 4 };
// Leona, Malphite, Sejuani, Lissandra -> aggregate cc 3.00.
const CC_COMP = [89, 54, 113, 127];
// A hover that does NOT clear the threshold, used to flicker between locks.
const FLICKER = 236; // Lucian

const bridge = { phase: "None", champSelect: null, applies: [], statusRequests: 0 };

function setChampSelect(theirTeam) {
  bridge.phase = "ChampSelect";
  bridge.champSelect = {
    localPlayerCellId: 3,
    cellChampionId: THRESH.id,
    pickIntent: null,
    actionChampionId: null,
    roleId: THRESH.roleId,
    theirTeam,
    timerPhase: "BAN_PICK",
  };
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
  if (url.pathname === "/apply-itemsets") {
    const body = await readBody(req);
    bridge.applies.push({
      t: Date.now(),
      kind: "items",
      championId: body?.championId ?? null,
      setCount: Array.isArray(body?.sets) ? body.sets.length : null,
      blockTitles: Array.isArray(body?.sets) ? (body.sets[0]?.blocks ?? []).map((b) => b?.type) : null,
    });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, count: 1 }));
    return;
  }
  if (url.pathname === "/apply-runes") {
    await readBody(req);
    bridge.applies.push({ t: Date.now(), kind: "runes" });
    res.writeHead(200, headers);
    res.end(JSON.stringify({ ok: true, selected: true, verified: true }));
    return;
  }
  res.writeHead(404, headers);
  res.end(JSON.stringify({ error: "not-found" }));
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await new Promise((resolve) => server.listen(BRIDGE_PORT, "127.0.0.1", resolve));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cx-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: HEADLESS,
    userDataDir,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults",
      "--window-size=1400,900",
    ],
  });

  const page = await browser.newPage();
  await page.evaluateOnNewDocument(
    (session, port) => {
      localStorage.setItem("coachbuild:companion:session", session);
      localStorage.setItem("coachbuild:companion:port", String(port));
      localStorage.setItem("coachbuild:companion:autoItemSets", "true");
      localStorage.setItem("coachbuild:companion:autoRunes", "true");
      window.__cxInstrumented = true;
    },
    SESSION,
    BRIDGE_PORT
  );

  const pageErrors = [];
  const decisions = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[autoExport]")) decisions.push(t);
  });

  // Enter champ select with NO enemies yet, before load, so the first tick sees
  // the pick and exports once with signal "none" - the un-gated first write.
  setChampSelect([]);
  await page.goto(`${BASE}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });

  // Instrument-alive. Without these a run that never seeded the session, or
  // never reached the bridge, reports the same zeros as a working app.
  const instrumented = await page.evaluate(() => window.__cxInstrumented === true);
  const deadline = Date.now() + 25000;
  while (bridge.statusRequests === 0 && Date.now() < deadline) await sleep(50);
  const loadedVersion = await page.evaluate(() => {
    const m = document.querySelector('meta[name="coachbuild-version"]');
    return m ? m.getAttribute("content") : null;
  });

  const t0 = Date.now();
  await sleep(SETTLE_MS); // let the un-gated first export land
  const afterFirst = bridge.applies.filter((a) => a.kind === "items").length;

  // The draft: enemies arrive one at a time, with a non-qualifying hover
  // flickering in between each lock. That flicker is the case the stability
  // window exists for.
  const locked = [];
  for (const id of CC_COMP) {
    setChampSelect([...locked, FLICKER]); // hovering
    await sleep(1200);
    locked.push(id);
    setChampSelect([...locked]); // locked
    await sleep(2500);
  }
  // Let the last change settle past the stability window.
  await sleep(SETTLE_MS);

  const itemWrites = bridge.applies.filter((a) => a.kind === "items");
  const elapsedS = Math.round((Date.now() - t0) / 1000);

  const report = {
    base: BASE,
    loadedVersion,
    instrumented,
    bridgeReached: bridge.statusRequests > 0,
    statusPolls: bridge.statusRequests,
    draftSeconds: elapsedS,
    itemSetWrites: itemWrites.length,
    writesBeforeAnyEnemy: afterFirst,
    writes: itemWrites.map((a, i) => ({
      n: i + 1,
      atSecond: Math.round((a.t - t0) / 1000),
      setCount: a.setCount,
      situationalBlock: (a.blockTitles ?? []).find((t) => String(t).startsWith("Situational")) ?? null,
    })),
    decisions,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  server.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

await main();
