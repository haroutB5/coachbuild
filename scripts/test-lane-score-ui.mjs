// Exercises the built Draft page in Chromium with a simulated bridge and CDN.
// No League requests, profile changes, or writes to the user's lane history.
// Run after npm run build: node scripts/test-lane-score-ui.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'desktop/ui/out');
const executablePath = process.env.COACHBUILD_TEST_BROWSER ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
assert.ok(executablePath, 'Set COACHBUILD_TEST_BROWSER to a Chromium executable');
const browser = await puppeteer.launch({ executablePath, headless: true });
const errors = [];
const posts = [];
let saved = false;
let rejectNext = true;
let releaseSave;
const game = id => ({ matchId: id, queueId: 420, myChampionId: 106, myChampionName: null,
  roleId: null, opponentChampionId: null, opponentChampionName: null, enemyChampionIds: [887],
  playedAt: '2026-09-09T12:00:00Z' });
let pending = game('first');
const card = 'section[aria-label="Score your last ranked lane"]';
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 1000 });
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('coachbuild:companion:port', '48291');
    localStorage.setItem('coachbuild:companion:session', 'ui-test');
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    void (async () => {
      const url = new URL(request.url());
      const json = body => request.respond({ status: 200, contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': 'https://coachbuild.local',
          'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' },
        body: JSON.stringify(body) });
      if (url.hostname === '127.0.0.1') {
        if (request.method() === 'OPTIONS') return json({});
        assert.equal(url.searchParams.get('session'), 'ui-test');
        if (url.pathname === '/status') return json({ version: '2.3.2', port: 48291, phase: 'ChampSelect', clientConnected: true,
          champSelect: { localPlayerCellId: 1, cellChampionId: 106, pickIntent: 106, actionChampionId: 106, roleId: 0, theirTeam: [887], timerPhase: 'BAN_PICK' } });
        if (url.pathname === '/lane-scores/pending') return json({ pending });
        if (url.pathname === '/lane-scores/recommendations') return json({ enemyChampionId: 887, roleId: 0,
          totalGames: saved ? 1 : 0, worst: [], best: saved ? [{ championId: 106, championName: null, games: 1, mean: 8, lastPlayedAt: '2026-09-09T12:00:00Z' }] : [] });
        if (url.pathname === '/lane-scores' && request.method() === 'POST') {
          const body = JSON.parse(request.postData());
          posts.push(body);
          if (rejectNext) { rejectNext = false; return json({ ok: false, reason: 'store-unreadable' }); }
          if (!body.skip) {
            await new Promise(resolve => { releaseSave = resolve; });
            saved = true;
          } else pending = null;
          return json({ ok: true });
        }
        return json({});
      }
      if (url.hostname === 'ddragon.leagueoflegends.com') {
        if (url.pathname.endsWith('versions.json')) return json(['16.18.1']);
        if (url.pathname.endsWith('champion.json')) return json({ data: Object.fromEntries(
          [[106, 'Volibear'], [887, 'Gwen']].map(([id, name]) => [name, { key: String(id), id: name, name, info: { difficulty: 3 }, tags: ['Fighter'] }])) });
        return request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#999"/></svg>' });
      }
      if (url.hostname === 'coachbuild.local') {
        const file = path.resolve(output, '.' + decodeURIComponent(url.pathname));
        assert.ok(file.startsWith(output + path.sep));
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] ?? 'application/octet-stream';
        try { return await request.respond({ status: 200, contentType: mime, body: await readFile(file) }); }
        catch { return request.respond({ status: 404, body: '' }); }
      }
      return request.abort();
    })().catch(error => { errors.push(error.message); if (!request.isInterceptResolutionHandled()) void request.abort(); });
  });
  await page.goto('https://coachbuild.local/index.html?session=ui-test', { waitUntil: 'networkidle0' });
  await page.waitForSelector(card);
  assert.ok(await page.$eval(card, el => el.textContent.includes('Volibear')), 'Resolve champion names when match history supplies only ids');
  const saveDisabled = () => page.$eval(card, el => [...el.querySelectorAll('button')].find(b => b.textContent === 'Save score').disabled);
  const clickText = text => page.$eval(card, (el, text) => [...el.querySelectorAll('button')].find(b => b.textContent === text).click(), text);
  assert.equal(await saveDisabled(), true);
  await page.click(`${card} button[aria-label="Gwen"]`);
  await page.click(`${card} button[aria-label="Score 8 out of 10"]`);
  assert.equal(await saveDisabled(), true, 'Unknown role cannot be silently saved');
  await page.select(`${card} select[aria-label="Your role"]`, '0');
  assert.equal(await saveDisabled(), false);
  await clickText('Save score');
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent.includes('unchanged'));
  assert.equal(await page.$eval(`${card} select`, el => el.value), '0');
  await clickText('Save score');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Saving…'));
  pending = game('second');
  // Let the next real five-second poll complete while the POST is delayed.
  await new Promise(resolve => setTimeout(resolve, 5500));
  assert.equal(await page.$eval(`${card} select`, el => el.value), '0', 'Polling must not erase an in-flight submission');
  assert.equal(await page.$eval(`${card} select`, el => el.disabled), true);
  assert.ok(releaseSave);
  releaseSave();
  await page.waitForFunction(() => document.body.textContent.includes('8.0/10 avg'));
  assert.equal(await page.evaluate(() => document.body.textContent.includes('Champion #106')), false);
  await page.waitForFunction(() => document.querySelector('select[aria-label="Your role"]')?.value === '');
  await clickText('Skip this game');
  await page.waitForFunction(selector => !document.querySelector(selector), {}, card);
  assert.deepEqual(posts.map(p => [p.matchId, p.roleId, p.score, p.skip]), [
    ['first', 0, 8, undefined], ['first', 0, 8, undefined], ['second', undefined, undefined, true],
  ]);
  assert.deepEqual(errors, []);
  console.log('PASS: built UI role/opponent validation, failed-save recovery, delayed-save polling, history refresh, and skip; no page errors.');
} finally { await browser.close(); }
