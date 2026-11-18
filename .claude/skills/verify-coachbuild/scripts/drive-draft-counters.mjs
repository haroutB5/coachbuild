// Drives feature 1 of the map: Draft tab, live champion select, mark an enemy as the lane opponent,
// read the u.gg counter tables, mark the other enemy and see the matchup change.
// Usage: node drive-draft-counters.mjs --ui <desktop/ui/out> --root <repo> --out <evidence dir> --profile <browser dir> [--state <state.env>]
// The page runs under https://coachbuild.local, the origin the desktop app gives it, served from the
// exported folder by request interception. The only fixtures are the three things outside the page:
// the League client bridge (127.0.0.1), ddragon, and the native u.gg reader (window.chrome.webview).
// Exit 0 = every step held. Exit 1 = a step failed (the failing step is the last STEP line and FAIL line).
import puppeteer from 'puppeteer-core'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve, sep, extname } from 'node:path'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const ui = arg('--ui'), root = arg('--root'), out = arg('--out'), profile = arg('--profile'), stateFile = arg('--state')
if (!ui || !root || !out || !profile) { console.error('usage: --ui DIR --root DIR --out DIR --profile DIR [--state FILE]'); process.exit(2) }
mkdirSync(out, { recursive: true })
const uiRoot = resolve(ui)
const chrome = process.env.CHROME_PATH
  ?? ['/usr/bin/brave', '/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(existsSync)
if (!chrome) { console.error('no browser found, set CHROME_PATH'); process.exit(2) }
const roster = JSON.parse(readFileSync(join(root, 'desktop/tests/CoachBuild.Core.Tests/Fixtures/champions.live.json'), 'utf8'))

// Synthetic u.gg rows, from the enemy's point of view (the app flips them). Derived by hand, not by the app:
//   Annie wr 30 gd -1500  -> our win rate 70.00%, gold +1500 ... Volibear wr 65 gd 600 -> 35.00%, -600.
//   Jax has pick rate 0.3, below the 0.5 cut, so he must not appear. Annie appears twice, the second row must be dropped.
const rows = [
  { champion_id: 1, win_rate: 30, gold_adv_15: -1500, matches: 1200, pick_rate: 5 },
  { champion_id: 22, win_rate: 35, gold_adv_15: -1200, matches: 800, pick_rate: 4 },
  { champion_id: 84, win_rate: 40, gold_adv_15: -900, matches: 450, pick_rate: 3 },
  { champion_id: 12, win_rate: 42, gold_adv_15: -700, matches: 300, pick_rate: 2.5 },
  { champion_id: 53, win_rate: 45, gold_adv_15: -500, matches: 150, pick_rate: 2 },
  { champion_id: 63, win_rate: 48, gold_adv_15: -300, matches: 90, pick_rate: 1.8 },
  { champion_id: 51, win_rate: 50, gold_adv_15: -100, matches: 45, pick_rate: 1.5 },
  { champion_id: 164, win_rate: 55, gold_adv_15: 200, matches: 18, pick_rate: 1.2 },
  { champion_id: 134, win_rate: 60, gold_adv_15: 400, matches: 12, pick_rate: 1.0 },
  { champion_id: 106, win_rate: 65, gold_adv_15: 600, matches: 8, pick_rate: 0.9 },
  { champion_id: 24, win_rate: 99, gold_adv_15: 5000, matches: 5000, pick_rate: 0.3 },
  { champion_id: 1, win_rate: 90, gold_adv_15: 9000, matches: 77, pick_rate: 5 },
]
const EXPECT_BEST = [['Annie', '+1500', '1,200'], ['Ashe', '+1200', '800'], ['Akali', '+900', '450'], ['Alistar', '+700', '300'],
  ['Blitzcrank', '+500', '150'], ['Brand', '+300', '90'], ['Caitlyn', '+100', '45'], ['Camille', '-200', '18'],
  ['Syndra', '-400', '12'], ['Volibear', '-600', '8']].map(([n, v, g]) => [n, v.replace(/(\d)(\d{3})$/, '$1,$2'), g])
const EXPECT_WORST = [['Volibear', '35.00%', '8'], ['Syndra', '40.00%', '12'], ['Camille', '45.00%', '18'], ['Caitlyn', '50.00%', '45'],
  ['Brand', '52.00%', '90'], ['Blitzcrank', '55.00%', '150'], ['Alistar', '58.00%', '300'], ['Akali', '60.00%', '450'],
  ['Ashe', '65.00%', '800'], ['Annie', '70.00%', '1,200']]
const LIVE = { historyEmpty: true, phase: 'ChampSelect', champSelect: {
  localPlayerCellId: 0, cellChampionId: 103, pickIntent: 103, actionChampionId: 103, roleId: 0, theirTeam: [266, 122], timerPhase: 'BAN_PICK' } }

const log = []
const say = (line) => { log.push(line); console.log(line) }
const blocked = [], pageErrors = [], network = []
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain' }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')

const browser = await puppeteer.launch({
  executablePath: chrome, headless: true,
  args: ['--no-sandbox', `--user-data-dir=${profile}`, '--host-resolver-rules=MAP * ~NOTFOUND'],
})
if (stateFile) appendFileSync(stateFile, `BROWSER_PID=${browser.process()?.pid ?? ''}\n`)
const context = await browser.createBrowserContext()
const page = await context.newPage()
await page.setViewport({ width: 1280, height: 900 })
page.setDefaultTimeout(10000)
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
await page.setRequestInterception(true)
page.on('request', (request) => {
  void (async () => {
    const url = new URL(request.url())
    if (url.origin === 'https://coachbuild.local') {
      network.push(`app ${url.pathname}`)
      if (url.pathname === '/favicon.ico') return request.respond({ status: 404 })
      const target = resolve(uiRoot, '.' + decodeURIComponent(url.pathname))
      if (!target.startsWith(uiRoot + sep) || !existsSync(target)) return request.respond({ status: 404 })
      return request.respond({ status: 200, contentType: mime[extname(target)] ?? 'application/octet-stream', body: readFileSync(target) })
    }
    if (url.hostname === 'ddragon.leagueoflegends.com' && url.pathname.endsWith('.png')) return request.respond({ status: 200, contentType: 'image/png', body: PNG })
    blocked.push(`${url.origin}${url.pathname}`)
    await request.abort()
  })().catch(() => request.abort().catch(() => {}))
})
// Everything outside the page: bridge, ddragon json, native u.gg reader. Installed before any app script runs.
await page.evaluateOnNewDocument((roster, rows, initial) => {
  const state = window.__draftTest = { connected: true, pending: null, submissions: [], counterRequests: [], counterReplies: 0, bridgeCalls: [], ...initial }
  localStorage.setItem('coachbuild:companion:port', '48291')
  const originalFetch = window.fetch
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString())
    const json = (data) => Promise.resolve(new Response(JSON.stringify(data), { status: 200 }))
    if (url.hostname === 'ddragon.leagueoflegends.com') {
      if (url.pathname.endsWith('/versions.json')) return json(['16.18.1'])
      if (url.pathname.endsWith('/champion.json')) return json({ data: Object.fromEntries(roster.map((c) => [c.key, { id: c.key, key: String(c.id), name: c.name, info: { difficulty: 5 }, tags: [] }])) })
    }
    if (url.hostname === '127.0.0.1') {
      state.bridgeCalls.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname === '/status') return json({ version: 'test', clientConnected: true, phase: state.phase, champSelect: state.champSelect, lastPollAt: new Date().toISOString() })
      if (url.pathname === '/lane-scores/pending') return json({ pending: state.pending })
      if (url.pathname === '/lane-scores/recommendations') return json({ enemyChampionId: Number(url.searchParams.get('enemy')), roleId: Number(url.searchParams.get('role')), totalGames: 0, best: [], worst: [] })
      if (url.pathname === '/lane-scores') { state.submissions.push(JSON.parse(init.body)); return json({ ok: true }) }
      throw new Error(`Unexpected bridge call: ${url.pathname}`)
    }
    return originalFetch(input, init)
  }
  const listeners = new Set()
  window.chrome.webview = {
    addEventListener: (_, l) => listeners.add(l), removeEventListener: (_, l) => listeners.delete(l),
    postMessage: (request) => {
      if (request.type !== 'ugg-counters') return
      state.counterRequests.push({ slug: request.slug, lane: request.lane, enemy: request.enemy })
      setTimeout(() => { state.counterReplies++; listeners.forEach((l) => l({ data: { type: 'ugg-counters-result', id: request.id, patch: '16.18', sourceUrl: `https://u.gg/lol/champions/${request.slug}/counter`, rows } })) }, 25)
    },
  }
}, roster, rows, LIVE)

let step = 'start'
const shot = (name) => page.screenshot({ path: join(out, name) })
const text = () => page.evaluate(() => document.body.innerText)
const finish = async (code) => {
  const t = await page.evaluate(() => window.__draftTest).catch(() => null)
  writeFileSync(join(out, 'drive.log'), log.join('\n') + '\n')
  writeFileSync(join(out, 'drive.json'), JSON.stringify({ code, counterRequests: t?.counterRequests, bridgeCalls: t?.bridgeCalls, submissions: t?.submissions, blockedExternal: blocked, pageErrors, appRequests: network.length, viewport: '1280x900' }, null, 2))
  await browser.close().catch(() => {})
  process.exit(code)
}
const fail = async (why) => {
  say(`FAIL step="${step}" ${why}`)
  await shot('failure.png').catch(() => {})
  say(`page text: ${(await text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)}`)
  await finish(1)
}
const stepStart = (name) => { step = name; say(`STEP ${name}`) }
const must = async (cond, why) => { if (!(await cond())) await fail(why) }
const waitText = async (t, why) => { try { await page.waitForFunction((x) => document.body.innerText.includes(x), {}, t) } catch { await fail(why ?? `text "${t}" never appeared`) } }
const tableRows = (id) => page.$$eval(`#${id} .d25-trow`, (rs) => rs.map((r) => [r.querySelector('.d25-cname')?.textContent, r.querySelector('.d25-val-gold,.d25-val-wr')?.textContent, r.querySelector('.d25-games')?.textContent]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

try {
  stepStart('open the Draft page under https://coachbuild.local with a live champ select')
  await page.goto('https://coachbuild.local/index.html?session=fixture-session')
  await waitText('Companion test', 'the Draft page did not render')
  await page.waitForSelector('[aria-label="Change your champion from Ahri"]').catch(() => fail('the live pick (Ahri) never showed'))
  say(`url after load: ${page.url()}`)
  await must(async () => !new URL(page.url()).searchParams.has('session'), 'the session token is still in the URL')
  // Unmarked, the app shows counters for the first visible enemy and tells the user so.
  await waitText('Counters vs Aatrox', 'precondition: counters for the first visible enemy (Aatrox) should show before any mark')
  await must(async () => (await text()).includes('Without a mark, counters use the first visible enemy.'), 'the unmarked hint is missing')
  await must(async () => !(await text()).includes('Lane opponent'), 'precondition: no lane opponent should be marked yet')
  await shot('01-draft-live.png')

  stepStart('mark Aatrox as the lane opponent')
  await page.click('[aria-label="Mark Aatrox as your lane opponent"]')
  await page.waitForSelector('[aria-label="Aatrox is your lane opponent"]').catch(() => fail('Aatrox is not shown as the lane opponent after the click'))
  await waitText('Lane opponent')
  await page.waitForSelector('#d25-table-best .d25-trow').catch(() => fail('the counter tables never rendered'))
  await waitText('Patch 16.18')
  const t = await page.evaluate(() => window.__draftTest)
  say(`counter requests: ${JSON.stringify(t.counterRequests)}`)
  await must(async () => t.counterRequests.length >= 1 && t.counterRequests[0].slug === 'aatrox' && t.counterRequests[0].enemy === 266, 'the native u.gg reader was not first asked for aatrox/266')
  await must(async () => ['top', 'jungle', 'mid', 'adc', 'support'].includes(t.counterRequests[0].lane), `lane sent to u.gg is "${t.counterRequests[0].lane}"`)

  stepStart('read both counter tables')
  const best = await tableRows('d25-table-best'), worst = await tableRows('d25-table-worst')
  say(`best  ${JSON.stringify(best)}`)
  say(`worst ${JSON.stringify(worst)}`)
  await must(async () => same(best, EXPECT_BEST), 'Highest lane gold advantage rows differ from the hand-derived expectation')
  await must(async () => same(worst, EXPECT_WORST), 'Lowest match win rates rows differ from the hand-derived expectation')
  const badges = await page.$$eval('.d25-badge', (n) => n.map((x) => x.textContent))
  await must(async () => same(badges, ['Top 10', 'Bottom 10']), `badges are ${JSON.stringify(badges)}`)
  await must(async () => (await page.$eval('.d25-warn', (n) => n.textContent).catch(() => '')).includes('Small samples'), 'no small-sample warning although three rows have under 20 games')
  await shot('02-counters-aatrox.png')

  stepStart('mark Darius, the matchup changes and u.gg is asked again')
  await page.click('[aria-label="Mark Darius as your lane opponent"]')
  await waitText('Counters vs Darius')
  // The heading and subtitle switch to Darius at once, over the previous matchup's rows, and the page drops the tables for a
  // moment ("Loading u.gg matchups") before it renders the reply. Request count alone races that: wait for the second reply
  // to have been delivered (it is sent 25 ms after the request, well after the loading render) and for the tables to be back.
  await page.waitForFunction(() => window.__draftTest.counterReplies === 2 && !document.querySelector('.d25-loading')
    && document.querySelector('#d25-table-best .d25-tsub')?.textContent.includes('Vs Darius') && document.querySelector('#d25-table-best .d25-trow'))
    .catch(() => fail('the tables never came back for the Vs Darius matchup'))
  const t2 = await page.evaluate(() => window.__draftTest)
  say(`counter requests: ${JSON.stringify(t2.counterRequests)}`)
  await must(async () => same(t2.counterRequests.map((r) => r.slug), ['aatrox', 'darius']), 'u.gg was not asked for darius after the second mark')
  await must(async () => !!(await page.$('[aria-label="Darius is your lane opponent"]')), 'Darius is not shown as the lane opponent')
  const bestD = await tableRows('d25-table-best')
  say(`best (Darius) ${JSON.stringify(bestD)}`)
  await must(async () => same(bestD, EXPECT_BEST), 'tables for Darius differ from the expectation')
  await shot('03-counters-darius.png')

  stepStart('side effects: nothing written to the League client, no stray network, no page errors')
  await must(async () => t2.submissions.length === 0, `the page POSTed a lane score (${JSON.stringify(t2.submissions)})`)
  await must(async () => !t2.bridgeCalls.some((c) => c.startsWith('POST') || c.startsWith('PUT') || c.startsWith('DELETE')), `bridge writes: ${t2.bridgeCalls}`)
  say(`bridge calls: ${[...new Set(t2.bridgeCalls)].join(', ')}`)
  await must(async () => blocked.length === 0, `requests to unexpected hosts: ${blocked.join(', ')}`)
  await must(async () => pageErrors.length === 0, `page errors: ${pageErrors.join(' | ')}`)
  say('PASS all steps held')
  await finish(0)
} catch (e) {
  await fail(`unexpected error: ${String(e).slice(0, 300)}`)
}
