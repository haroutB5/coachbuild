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

// Synthetic u.gg rows per enemy, from the enemy's point of view (the app flips them). Derived by hand, not by the app.
// The two enemies have different champions, order and values, so one matchup's tables can never pass for the other's.
// Aatrox: Annie wr 30 gd -1500 -> our win rate 70.00%, gold +1500 ... Volibear wr 65 gd 600 -> 35.00%, -600.
//   Jax has pick rate 0.3, below the 0.5 cut, so he must not appear. Annie appears twice, the second row must be dropped.
//   Three rows have under 20 games, so the small-sample warning shows.
// Darius: 12 rows, all over 20 games, so no warning. Gold order and win-rate order differ. Jax is under the cut and Garen is a duplicate again.
const ROWS = {
  aatrox: [
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
  ],
  darius: [
    { champion_id: 86, win_rate: 28, gold_adv_15: -1100, matches: 5200, pick_rate: 6 },
    { champion_id: 98, win_rate: 33, gold_adv_15: -2300, matches: 3100, pick_rate: 5 },
    { champion_id: 54, win_rate: 37, gold_adv_15: -400, matches: 2400, pick_rate: 4 },
    { champion_id: 57, win_rate: 41, gold_adv_15: -1800, matches: 1800, pick_rate: 3.5 },
    { champion_id: 79, win_rate: 44, gold_adv_15: 100, matches: 950, pick_rate: 3 },
    { champion_id: 32, win_rate: 46, gold_adv_15: -1400, matches: 640, pick_rate: 2.5 },
    { champion_id: 36, win_rate: 49, gold_adv_15: -700, matches: 420, pick_rate: 2 },
    { champion_id: 223, win_rate: 52, gold_adv_15: 300, matches: 260, pick_rate: 1.6 },
    { champion_id: 126, win_rate: 57, gold_adv_15: 900, matches: 120, pick_rate: 1.2 },
    { champion_id: 110, win_rate: 61, gold_adv_15: -200, matches: 75, pick_rate: 1.0 },
    { champion_id: 69, win_rate: 64, gold_adv_15: 1500, matches: 40, pick_rate: 0.8 },
    { champion_id: 115, win_rate: 68, gold_adv_15: 2000, matches: 25, pick_rate: 0.6 },
    { champion_id: 24, win_rate: 95, gold_adv_15: 9000, matches: 3000, pick_rate: 0.4 },
    { champion_id: 86, win_rate: 5, gold_adv_15: -9999, matches: 99, pick_rate: 6 },
  ],
}
const EXPECT = {
  aatrox: {
    best: [['Annie', '+1,500', '1,200'], ['Ashe', '+1,200', '800'], ['Akali', '+900', '450'], ['Alistar', '+700', '300'],
      ['Blitzcrank', '+500', '150'], ['Brand', '+300', '90'], ['Caitlyn', '+100', '45'], ['Camille', '-200', '18'],
      ['Syndra', '-400', '12'], ['Volibear', '-600', '8']],
    worst: [['Volibear', '35.00%', '8'], ['Syndra', '40.00%', '12'], ['Camille', '45.00%', '18'], ['Caitlyn', '50.00%', '45'],
      ['Brand', '52.00%', '90'], ['Blitzcrank', '55.00%', '150'], ['Alistar', '58.00%', '300'], ['Akali', '60.00%', '450'],
      ['Ashe', '65.00%', '800'], ['Annie', '70.00%', '1,200']],
    badges: ['Top 10', 'Bottom 10'],
    warn: true,
  },
  darius: {
    best: [['Shen', '+2,300', '3,100'], ['Maokai', '+1,800', '1,800'], ['Amumu', '+1,400', '640'], ['Garen', '+1,100', '5,200'],
      ['Dr. Mundo', '+700', '420'], ['Malphite', '+400', '2,400'], ['Varus', '+200', '75'], ['Gragas', '-100', '950'],
      ['Tahm Kench', '-300', '260'], ['Jayce', '-900', '120'], ['Cassiopeia', '-1,500', '40'], ['Ziggs', '-2,000', '25']],
    worst: [['Ziggs', '32.00%', '25'], ['Cassiopeia', '36.00%', '40'], ['Varus', '39.00%', '75'], ['Jayce', '43.00%', '120'],
      ['Tahm Kench', '48.00%', '260'], ['Dr. Mundo', '51.00%', '420'], ['Amumu', '54.00%', '640'], ['Gragas', '56.00%', '950'],
      ['Maokai', '59.00%', '1,800'], ['Malphite', '63.00%', '2,400']],
    badges: ['Top 12', 'Bottom 10'],
    warn: false,
  },
}
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
      setTimeout(() => { state.counterReplies++; listeners.forEach((l) => l({ data: { type: 'ugg-counters-result', id: request.id, patch: '16.18', sourceUrl: `https://u.gg/lol/champions/${request.slug}/counter`, rows: rows[request.slug] } })) }, 25)
    },
  }
}, roster, ROWS, LIVE)

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
// What the user sees: an element counts only when it renders a real box (not display:none, visibility:hidden, zero size, or screen-reader-only 1 px).
const shown = (selector, minW = 20, minH = 10) => page.$eval(selector, (el, w, h) => {
  const r = el.getBoundingClientRect()
  return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && r.width >= w && r.height >= h
}, minW, minH).catch(() => false)
const onTop = (selector) => page.$eval(selector, (el) => {
  el.scrollIntoView({ block: 'center' })
  const r = el.getBoundingClientRect()
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 60))
  return !!hit && el.contains(hit)
}).catch(() => false)
// Rows are read only when the user can see them. A row inside a table that a parent clips (overflow hidden/clip/auto/scroll)
// keeps a non-zero box and passes checkVisibility, so two checks run per row: its box must lie inside the box of every clipping
// ancestor, and what the browser hit-tests at the row's centre must be that row. Neither check scrolls a clipping ancestor
// (scrollIntoView would scroll an overflow:hidden box and hide the clip). The page itself is scrolled with window.scrollBy.
// Returns { rows, clipped } with clipped = the rows an ancestor cuts off or something covers, and why.
const readRows = (id) => page.$$eval(`#${id} .d25-trow`, (rs) => {
  const rows = [], clipped = []
  const label = (r) => r.querySelector('.d25-cname')?.innerText ?? '(no name)'
  for (const r of rs) {
    if (!r.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || r.getBoundingClientRect().height <= 0) { clipped.push(`${label(r)}: not rendered`); continue }
    let b = r.getBoundingClientRect()
    let why = ''
    for (let a = r.parentElement; a && a !== document.body && a !== document.documentElement && !why; a = a.parentElement) {
      const cs = getComputedStyle(a)
      const yClip = cs.overflowY !== 'visible', xClip = cs.overflowX !== 'visible'
      if (!yClip && !xClip) continue
      // A scroller the user can scroll (auto or scroll) is scrolled to the row, as a user would. hidden and clip cannot be scrolled by a user.
      if (['auto', 'scroll'].includes(cs.overflowY) && a.scrollHeight > a.clientHeight) { const q = a.getBoundingClientRect(); a.scrollTop += (r.getBoundingClientRect().top + b.height / 2) - (q.top + q.height / 2) }
      const b2 = r.getBoundingClientRect()
      const c = a.getBoundingClientRect()
      const box = { top: c.top + a.clientTop, bottom: c.top + a.clientTop + a.clientHeight, left: c.left + a.clientLeft, right: c.left + a.clientLeft + a.clientWidth }
      if ((yClip && (b2.top < box.top - 1 || b2.bottom > box.bottom + 1)) || (xClip && (b2.left < box.left - 1 || b2.right > box.right + 1))) {
        why = `cut off by ${a.tagName.toLowerCase()}.${String(a.className).split(' ')[0]} (row ${Math.round(b2.top)} to ${Math.round(b2.bottom)} px, visible ${Math.round(box.top)} to ${Math.round(box.bottom)} px)`
      }
    }
    if (!why) {
      b = r.getBoundingClientRect()
      window.scrollBy(0, b.top + b.height / 2 - innerHeight / 2)
      const n = r.getBoundingClientRect()
      const hit = document.elementFromPoint(n.left + n.width / 2, n.top + n.height / 2)
      if (!hit || !r.contains(hit)) why = `covered or off screen at its centre (hit ${hit ? hit.tagName.toLowerCase() + '.' + String(hit.className).split(' ')[0] : 'nothing'})`
    }
    if (why) clipped.push(`${label(r)}: ${why}`)
    else rows.push([r.querySelector('.d25-cname')?.innerText, r.querySelector('.d25-val-gold,.d25-val-wr')?.innerText, r.querySelector('.d25-games')?.innerText])
  }
  return { rows, clipped }
})
const tableRows = async (id, label, who) => {
  const { rows, clipped } = await readRows(id)
  if (clipped.length) await fail(`${clipped.length} row(s) of the "${label}" table for ${who} are not visible to the user: ${clipped.slice(0, 4).join('; ')}`)
  return rows
}
const readTables = async (who, expected) => {
  for (const [id, label] of [['d25-table-best', 'Highest lane gold advantage'], ['d25-table-worst', 'Lowest match win rates']]) {
    await must(() => shown(`#${id}`, 100, 40), `the "${label}" table is not visible to the user for ${who} (hidden, collapsed or zero size)`)
    await must(() => onTop(`#${id}`), `the "${label}" table for ${who} is covered by another element`)
  }
  const best = await tableRows('d25-table-best', 'Highest lane gold advantage', who), worst = await tableRows('d25-table-worst', 'Lowest match win rates', who)
  say(`best (${who}) ${JSON.stringify(best)}`)
  say(`worst (${who}) ${JSON.stringify(worst)}`)
  await must(async () => same(best, expected.best), `Highest lane gold advantage rows for ${who} differ from the hand-derived expectation`)
  await must(async () => same(worst, expected.worst), `Lowest match win rates rows for ${who} differ from the hand-derived expectation`)
  const badges = await page.$$eval('.d25-badge', (n) => n.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.innerText))
  await must(async () => same(badges, expected.badges), `badges for ${who} are ${JSON.stringify(badges)}`)
  const warn = await shown('.d25-warn')
  await must(async () => warn === expected.warn, expected.warn ? `no visible small-sample warning for ${who} although rows have under 20 games` : `a small-sample warning shows for ${who} although every row has 20 games or more`)
  if (expected.warn) await must(async () => (await page.$eval('.d25-warn', (n) => n.innerText)).includes('Small samples'), 'the small-sample warning has the wrong text')
  await page.$eval('.d25-counters', (n) => n.scrollIntoView({ block: 'start' }))
}
// The crosshair on the portrait: after a mark, the gold crosshair badge (.d25-oppbadge) must render inside the marked enemy's
// slot and nowhere else, and the toggle states must agree (marked pressed, the other not). Read from the rendered page.
const readSlots = (marked, other) => page.evaluate((marked, other) => {
  const slotOf = (sel) => document.querySelector(sel)?.closest('.d25-slotwrap') ?? null
  const markedSlot = slotOf(`[aria-label="${marked} is your lane opponent"]`)
  const otherSlot = slotOf(`[aria-label="Mark ${other} as your lane opponent"]`)
  const badges = [...document.querySelectorAll('.d25-oppbadge')].filter((b) => b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && b.getBoundingClientRect().width >= 12)
  const inside = (slot, b) => { if (!slot) return false; const s = slot.getBoundingClientRect(), r = b.getBoundingClientRect()
    return slot.contains(b) && r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 }
  return {
    found: !!markedSlot && !!otherSlot,
    total: badges.length,
    inMarked: markedSlot ? badges.filter((b) => inside(markedSlot, b)).length : 0,
    inOther: otherSlot ? badges.filter((b) => otherSlot.contains(b)).length : 0,
    markedPressed: markedSlot?.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') ?? null,
    otherPressed: otherSlot?.querySelector('button[aria-pressed]')?.getAttribute('aria-pressed') ?? null,
    markedRing: markedSlot?.querySelector('.d25-slot')?.classList.contains('d25-slot-laneopp') ?? false,
    otherRing: otherSlot?.querySelector('.d25-slot')?.classList.contains('d25-slot-laneopp') ?? false,
  }
}, marked, other)
const checkCrosshair = async (marked, other) => {
  const c = await readSlots(marked, other)
  say(`crosshair after marking ${marked}: ${JSON.stringify(c)}`)
  await must(async () => c.found, `could not find the ${marked} and ${other} enemy slots`)
  await must(async () => c.inMarked === 1, `the lane-opponent crosshair is not visible on the ${marked} slot (${c.inMarked} badges inside it)`)
  await must(async () => c.inOther === 0 && c.total === 1, `the lane-opponent crosshair also shows elsewhere: ${c.inOther} on ${other}, ${c.total} on the page`)
  await must(async () => c.markedPressed === 'true' && c.otherPressed === 'false', `the lane-opponent toggles disagree: ${marked} aria-pressed=${c.markedPressed}, ${other} aria-pressed=${c.otherPressed}`)
  await must(async () => c.markedRing && !c.otherRing, `the lane-opponent highlight is on the wrong slot (${marked}: ${c.markedRing}, ${other}: ${c.otherRing})`)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

try {
  stepStart('open the Draft page under https://coachbuild.local with a live champ select')
  await page.goto('https://coachbuild.local/index.html?session=fixture-session')
  await page.waitForSelector('[aria-label="Change your champion from Ahri"]', { visible: true }).catch(() => fail('the Draft page did not render the live pick (Ahri)'))
  say(`url after load: ${page.url()}`)
  await must(async () => !new URL(page.url()).searchParams.has('session'), 'the session token is still in the URL')
  // Unmarked, the app shows counters for the first visible enemy and no lane-opponent pill. All of it is read from what renders.
  await page.waitForFunction(() => document.querySelector('.d25-chead-title')?.innerText === 'Counters vs Aatrox')
    .catch(() => fail('precondition: the visible counters heading should name the first enemy (Aatrox) before any mark'))
  await must(() => shown('.d25-chead-title'), 'the "Counters vs Aatrox" heading is not visible')
  await must(async () => !(await page.$('.d25-pill-laneopp')), 'precondition: the Lane opponent pill shows before any mark')
  await must(() => shown('[aria-label="Mark Aatrox as your lane opponent"]'), 'the button to mark Aatrox is not visible')
  await must(async () => (await readSlots('Aatrox', 'Darius')).total === 0, 'precondition: a lane-opponent crosshair shows before any mark')
  await shot('01-draft-live.png')

  stepStart('mark Aatrox as the lane opponent')
  await page.click('[aria-label="Mark Aatrox as your lane opponent"]')
  await page.waitForSelector('[aria-label="Aatrox is your lane opponent"]').catch(() => fail('Aatrox is not shown as the lane opponent after the click'))
  await page.waitForFunction(() => document.querySelector('.d25-pill-laneopp')?.innerText === 'Lane opponent')
    .catch(() => fail('the Lane opponent pill never appeared next to the heading'))
  await must(() => shown('.d25-pill-laneopp'), 'the Lane opponent pill is not visible')
  await checkCrosshair('Aatrox', 'Darius')
  await page.waitForSelector('#d25-table-best .d25-trow').catch(() => fail('the counter tables never rendered'))
  await page.waitForFunction(() => document.querySelector('.d25-meta')?.innerText.includes('Patch 16.18')).catch(() => fail('the visible subtitle never showed Patch 16.18'))
  const t = await page.evaluate(() => window.__draftTest)
  say(`counter requests: ${JSON.stringify(t.counterRequests)}`)
  await must(async () => t.counterRequests.length >= 1 && t.counterRequests[0].slug === 'aatrox' && t.counterRequests[0].enemy === 266, 'the native u.gg reader was not first asked for aatrox/266')
  await must(async () => ['top', 'jungle', 'mid', 'adc', 'support'].includes(t.counterRequests[0].lane), `lane sent to u.gg is "${t.counterRequests[0].lane}"`)

  stepStart('read both counter tables')
  await readTables('Aatrox', EXPECT.aatrox)
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
  await must(() => shown('.d25-pill-laneopp'), 'the Lane opponent pill is not visible after marking Darius')
  await checkCrosshair('Darius', 'Aatrox')
  await readTables('Darius', EXPECT.darius)
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
