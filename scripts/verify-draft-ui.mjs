// Run after npm run build. Exercises the exported page in headless Chromium.
// All CDN, bridge and native counter replies are fixtures; no League writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.resolve(process.env.DRAFT_UI_ROOT ?? path.join(root, 'desktop/ui/out'));
const evidenceDir = path.join(root, '_evidence/redesign-2.5.0');
const executablePath = process.env.BROWSER_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(existsSync);
assert.ok(executablePath, 'Set BROWSER_PATH to a Chromium browser executable');
assert.ok(existsSync(path.join(uiRoot, 'index.html')), 'Build the Draft UI first');
const champions = JSON.parse(await fs.readFile(path.join(root,
  'desktop/tests/CoachBuild.Core.Tests/Fixtures/champions.live.json'), 'utf8'));
// Ten ranked counter rows (ids all exist in the fixture roster); the tables
// show every row, with no collapse. The last three rows
// sit below the 20-game small-sample gate, which must surface the warning.
const counterRows = [
  { champion_id: 266, win_rate: 30, gold_adv_15: -1500, matches: 1200, pick_rate: 5 },
  { champion_id: 103, win_rate: 35, gold_adv_15: -1200, matches: 800, pick_rate: 4 },
  { champion_id: 84, win_rate: 40, gold_adv_15: -900, matches: 450, pick_rate: 3 },
  { champion_id: 12, win_rate: 42, gold_adv_15: -700, matches: 300, pick_rate: 2.5 },
  { champion_id: 1, win_rate: 45, gold_adv_15: -500, matches: 150, pick_rate: 2 },
  { champion_id: 22, win_rate: 48, gold_adv_15: -300, matches: 90, pick_rate: 1.8 },
  { champion_id: 53, win_rate: 50, gold_adv_15: -100, matches: 45, pick_rate: 1.5 },
  { champion_id: 63, win_rate: 55, gold_adv_15: 200, matches: 18, pick_rate: 1.2 },
  { champion_id: 51, win_rate: 60, gold_adv_15: 400, matches: 12, pick_rate: 1.0 },
  { champion_id: 164, win_rate: 65, gold_adv_15: 600, matches: 8, pick_rate: 0.9 },
];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const browser = await puppeteer.launch({ executablePath, headless: true });
let failures = 0;

async function openPage(overrides = {}, viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      const url = new URL(request.url());
      if (url.origin === 'https://coachbuild.local' && url.pathname === '/favicon.ico') {
        await request.respond({ status: 404 });
        return;
      }
      if (url.origin === 'https://coachbuild.local') {
        const target = path.resolve(uiRoot, '.' + decodeURIComponent(url.pathname));
        assert.ok(target.startsWith(uiRoot + path.sep), 'Asset stays inside export');
        await request.respond({ status: 200, contentType: mime[path.extname(target)] ?? 'application/octet-stream',
          body: await fs.readFile(target) });
      } else if (url.hostname === 'ddragon.leagueoflegends.com' && url.pathname.endsWith('.png')) {
        await request.respond({ status: 200, contentType: 'image/png',
          body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64') });
      } else {
        throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
      }
    })().catch(async error => {
      errors.push(error.message);
      if (!request.isInterceptResolutionHandled()) await request.abort();
    });
  });
  await page.evaluateOnNewDocument((roster, rows, initial) => {
    const state = window.__draftTest = {
      connected: true, historyFails: false, pending: null, submissions: [], counterRequests: [],
      phase: 'Lobby', champSelect: null, ...initial,
    };
    localStorage.setItem('coachbuild:companion:port', '48291');
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString());
      const json = data => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }));
      if (url.hostname === 'ddragon.leagueoflegends.com') {
        if (url.pathname.endsWith('/versions.json')) return json(['16.18.1']);
        if (url.pathname.endsWith('/champion.json')) return json({ data: Object.fromEntries(roster.map(champ =>
          [champ.key, { id: champ.key, key: String(champ.id), name: champ.name, info: { difficulty: 5 }, tags: [] }])) });
      }
      if (url.hostname === '127.0.0.1') {
        if (!state.connected) throw new TypeError('Fixture: bridge disconnected');
        if (url.pathname === '/status') return json({ version: 'test', clientConnected: true,
          phase: state.phase, champSelect: state.champSelect, lastPollAt: new Date().toISOString() });
        if (url.pathname === '/lane-scores/pending') return json({ pending: state.pending });
        if (url.pathname === '/lane-scores/recommendations') {
          if (state.historyFails) throw new TypeError('Fixture: temporary read failure');
          if (state.historyEmpty) return json({ enemyChampionId: Number(url.searchParams.get('enemy')),
            roleId: Number(url.searchParams.get('role')), totalGames: 0, best: [], worst: [] });
          return json({ enemyChampionId: Number(url.searchParams.get('enemy')),
            roleId: Number(url.searchParams.get('role')), totalGames: 1,
            best: [{ championId: 106, championName: 'Volibear', games: 1, mean: 8, lastPlayedAt: null }], worst: [] });
        }
        if (url.pathname === '/lane-scores') {
          state.submissions.push(JSON.parse(init.body));
          state.pending = null;
          return json({ ok: true });
        }
        throw new Error(`Unexpected bridge call: ${url.pathname}`);
      }
      return originalFetch(input, init);
    };
    const listeners = new Set();
    window.chrome.webview = {
      addEventListener: (_, listener) => listeners.add(listener),
      removeEventListener: (_, listener) => listeners.delete(listener),
      postMessage: request => {
        if (request.type !== 'ugg-counters') return;
        state.counterRequests.push(request);
        setTimeout(() => listeners.forEach(listener => listener({ data: {
          type: 'ugg-counters-result', id: request.id, patch: '16.18',
          sourceUrl: `https://u.gg/lol/champions/${request.slug}/counter`,
          rows,
        } })), 25);
      },
    };
  }, champions, counterRows, overrides);
  await page.goto('https://coachbuild.local/index.html?session=fixture-session');
  await page.waitForFunction(() => document.body.innerText.includes('Companion test'));
  return { page, errors };
}

async function check(name, test, overrides, viewport) {
  let page;
  try {
    const opened = await openPage(overrides, viewport);
    page = opened.page;
    await test(page);
    assert.deepEqual(opened.errors, [], 'No browser errors or unexpected requests');
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await page?.close(); }
}
const live = { phase: 'ChampSelect', champSelect: {
  localPlayerCellId: 0, cellChampionId: 103, pickIntent: 103, actionChampionId: 103,
  roleId: 0, theirTeam: [887, 122], timerPhase: 'BAN_PICK',
} };
const pendingGame = { pending: { matchId: 'fixture-ranked', queueId: 420, myChampionId: 106,
  myChampionName: 'Volibear', roleId: null, opponentChampionId: null, enemyChampionIds: [887, 24] } };
// Aatrox-like live draft for the redesign screenshots: one marked enemy so the
// tables, the gold lane-opponent frame and the small-sample warning all render.
const liveAatrox = { historyEmpty: true, phase: 'ChampSelect', champSelect: {
  localPlayerCellId: 0, cellChampionId: 103, pickIntent: 103, actionChampionId: 103,
  roleId: 0, theirTeam: [266, 122], timerPhase: 'BAN_PICK',
} };

async function markFirstEnemy(page, label) {
  await page.waitForSelector(`[aria-label="${label}"]`);
  await page.click(`[aria-label="${label}"]`);
  await page.waitForFunction(text => document.body.innerText.includes(text), {}, 'Counters vs');
}

try {
  await check('export loads, session is removed, desktop and narrow layouts fit', async page => {
    assert.equal(new URL(page.url()).searchParams.has('session'), false);
    for (const width of [1280, 800, 480]) {
      await page.setViewport({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.equal(await page.$eval('main', node => getComputedStyle(node).paddingTop), '24px');
  });
  await check('Escape then Enter cannot select a hidden champion result', async page => {
    await page.click('[aria-label="Choose your champion"]');
    await page.type('input[role="combobox"]', 'Urgot');
    await page.waitForFunction(() => document.querySelector('[role="option"]')?.textContent.includes('Urgot'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    assert.ok(await page.$('[aria-label="Choose your champion"]'), 'Cancelled picker must not change the champion');
  });
  await check('simultaneous own/enemy pickers have distinct accessible IDs', async page => {
    await page.click('[aria-label="Choose your champion"]');
    await page.click('[aria-label="Add an enemy champion to slot 1"]');
    const ids = await page.$$eval('[id]', nodes => nodes.map(node => node.id));
    assert.equal(new Set(ids).size, ids.length, 'DOM IDs must be unique');
    await page.type('input[aria-label="Add an enemy"]', 'Gwen');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[aria-label="Mark Gwen as your lane opponent"]');
  });
  await check('live picks, lane mark, manual edit and Reset to live', async page => {
    await page.waitForSelector('[aria-label="Change your champion from Ahri"]');
    await page.click('[aria-label="Mark Gwen as your lane opponent"]');
    await page.evaluate(() => { window.__draftTest.champSelect.theirTeam = [887, 122, 24]; });
    await page.waitForSelector('[aria-label="Mark Jax as your lane opponent"]');
    assert.ok(await page.$('[aria-label="Gwen is your lane opponent"]'));
    await page.click('[aria-label="Change your champion from Ahri"]');
    await page.type('input[aria-label="Choose your champion"]', 'Urgot');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[aria-label="Change your champion from Urgot"]');
    await page.locator('button::-p-text(Reset to live)').click();
    await page.waitForSelector('[aria-label="Change your champion from Ahri"]');
  }, live);
  await check('lane history can recover from a temporary read failure', async page => {
    await page.waitForFunction(() => document.body.innerText.includes('Your lane history is unavailable'));
    await page.evaluate(() => { window.__draftTest.historyFails = false; });
    await page.locator('button::-p-text(Retry lane history)').click();
    await page.waitForFunction(() => document.body.innerText.includes('8.0/10 avg'));
  }, { ...live, historyFails: true });
  await check('unknown opponent and role require input; save submits once and clears card', async page => {
    await page.locator('button::-p-text(Previous game)').click();
    const card = '[aria-label="Score your last ranked lane"]';
    await page.waitForSelector(card);
    await page.locator(`${card} button::-p-text(Save score)`).wait();
    assert.equal(await page.$eval(`${card} .d25-savebtn`, node => node.disabled), true);
    await page.click(`${card} [aria-label="Gwen"]`);
    await page.select(`${card} select`, '4');
    await page.click(`${card} [aria-label="Score 8 out of 10"]`);
    await page.type(`${card} textarea`, 'Good trades');
    await page.locator(`${card} button::-p-text(Save score)`).click();
    await page.waitForSelector(card, { hidden: true });
    assert.deepEqual(await page.evaluate(() => window.__draftTest.submissions), [{
      matchId: 'fixture-ranked', score: 8, roleId: 4, opponentChampionId: 887, note: 'Good trades',
    }]);
  }, pendingGame);
  await check('redesign: pill, both table cards show every row, imports chips', async page => {
    await markFirstEnemy(page, 'Mark Aatrox as your lane opponent');
    assert.ok(await page.$('button::-p-text(Previous game)'), 'Previous game pill renders');
    for (const id of ['#d25-table-best', '#d25-table-worst']) {
      assert.equal(await page.$$eval(`${id} .d25-trow`, rows => rows.length), 10, `${id} shows all 10 rows`);
      assert.equal(await page.$(`${id} button`), null, `${id} has no show-all toggle`);
    }
    assert.ok((await page.$eval('#d25-table-best .d25-badge', node => node.textContent)).includes('Top 10'));
    assert.ok((await page.$eval('#d25-table-worst .d25-badge', node => node.textContent)).includes('Bottom 10'));
    assert.ok(await page.$eval('.d25-warn', node => node.textContent.includes('Small samples')));
    const chips = await page.$$eval('#d25-imports .d25-chip', nodes => nodes.map(node => node.textContent));
    assert.deepEqual(chips, ['Uu.gg', 'CCoachless', 'PPro']);
  }, liveAatrox);
  await check('redesign: screenshots + pixel measurements at 1586x894', async page => {
    await markFirstEnemy(page, 'Mark Aatrox as your lane opponent');
    await fs.mkdir(evidenceDir, { recursive: true });
    const boxes = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      return {
        heading: rect('.d25-title'),
        pill: rect('#d25-pill'),
        teamStrip: rect('#d25-teamstrip'),
        youSlot: rect('#d25-you-slot-0 .d25-slot'),
        enemySlot: rect('#d25-enemy-slot-0 .d25-slot'),
        chead: rect('.d25-chead'),
        warn: rect('.d25-warn'),
        bestCard: rect('#d25-table-best'),
        worstCard: rect('#d25-table-worst'),
        footnote: rect('.d25-footnote'),
        imports: rect('#d25-imports'),
      };
    });
    console.log(`MEASURE ${JSON.stringify(boxes)}`);
    await page.screenshot({ path: path.join(evidenceDir, 'web-draft.png') });
    assert.ok(existsSync(path.join(evidenceDir, 'web-draft.png')), 'draft screenshot written');
  }, liveAatrox, { width: 1586, height: 894 });
  await check('redesign: previous-game panel screenshot', async page => {
    await page.locator('button::-p-text(Previous game)').click();
    await page.waitForSelector('[aria-label="Score your last ranked lane"]');
    await fs.mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, 'web-previous-game.png') });
    assert.ok(existsSync(path.join(evidenceDir, 'web-previous-game.png')), 'panel screenshot written');
    // Escape closes the panel without scoring.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[aria-label="Score your last ranked lane"]', { hidden: true });
  }, pendingGame, { width: 1586, height: 894 });
  await check('redesign: narrow screenshots stack without scrolling', async page => {
    await markFirstEnemy(page, 'Mark Aatrox as your lane opponent');
    await fs.mkdir(evidenceDir, { recursive: true });
    await page.setViewport({ width: 1280, height: 806 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, 'web-draft-1280.png') });
    await page.setViewport({ width: 940, height: 566 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidenceDir, 'web-draft-940.png') });
    assert.ok(existsSync(path.join(evidenceDir, 'web-draft-1280.png')), '1280 screenshot written');
    assert.ok(existsSync(path.join(evidenceDir, 'web-draft-940.png')), '940 screenshot written');
  }, liveAatrox);
} finally { await browser.close(); }
process.exitCode = failures ? 1 : 0;
