// Verifies the REAL extractor JS from SiteImportExtractors.cs against the REAL
// captured fixtures. Not part of the build: no DOM on this box, so this file
// implements just enough DOM (tokenizer + flat selectors) for what the
// extractors use, then runs the actual const-string scripts verbatim.
// Usage: node _research/site-import/verify-extractors.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const csPath = join(dir, '..', '..', 'desktop', 'src', 'CoachBuild.Desktop', 'Web', 'SiteImportExtractors.cs');
const cs = readFileSync(csPath, 'utf8');

function rawBlock(name) {
  const m = cs.match(new RegExp('public const string ' + name + ' = """([\\s\\S]*?)"""'));
  if (!m) throw new Error('template not found: ' + name);
  return m[1];
}

// Build the injected icon maps from the REAL C# tables (same fold as C#:
// lowercase, ASCII letters+digits only), so this also pins C#<->JS agreement.
function csMap(className) {
  const start = cs.indexOf('class ' + className);
  if (className === 'SiteImportExtractors') throw new Error('unreachable');
  return null;
}
function coreMap(coreSource, className) {
  const file = readFileSync(join(dir, '..', '..', 'desktop', 'src', 'CoachBuild.Core', 'SiteImport.cs'), 'utf8');
  const cls = file.slice(file.indexOf('class ' + className));
  const body = cls.slice(0, cls.indexOf('public static string Normalize'));
  const map = {};
  for (const m of body.matchAll(/\["([^"]+)"\]\s*=\s*(\d+)/g)) map[m[1]] = Number(m[2]);
  return map;
}
// ShardIconMap strips the shared StatMods prefix/suffix the way C# does.
const perkMap = coreMap(null, 'PerkIconMap');
const shardRaw = coreMap(null, 'ShardIconMap');

// Coachless serves its own short stat icons, so its runes script gets the
// shared shard table PLUS the alias column (ShardIconMap.CoachlessAliases).
function coreAliasMap() {
  const file = readFileSync(join(dir, '..', '..', 'desktop', 'src', 'CoachBuild.Core', 'SiteImport.cs'), 'utf8');
  const at = file.indexOf('CoachlessAliases =');
  const body = file.slice(at, file.indexOf('};', at));
  const map = {};
  for (const m of body.matchAll(/\["([^"]+)"\]\s*=\s*(\d+)/g)) map[m[1]] = Number(m[2]);
  return map;
}
function coreTreeNames() {
  const file = readFileSync(join(dir, '..', '..', 'desktop', 'src', 'CoachBuild.Core', 'SiteImport.cs'), 'utf8');
  const at = file.indexOf('StyleIdsByName =');
  const body = file.slice(at, file.indexOf('};', at));
  const map = {};
  for (const m of body.matchAll(/\["([^"]+)"\]\s*=\s*(\d+)/g)) map[m[1]] = Number(m[2]);
  return map;
}
const shardAliases = coreAliasMap();
const treeNames = coreTreeNames();

function buildScript(templateName) {
  return rawBlock(templateName)
    .replace('__PERK_MAP_JSON__', JSON.stringify(perkMap))
    .replace('__SHARD_MAP_JSON__', JSON.stringify(shardRaw))
    .replace('__TREE_MAP_JSON__', JSON.stringify(treeNames));
}

function buildRunesScript() {
  return rawBlock('CoachlessRunesTemplate')
    .replace('__PERK_MAP_JSON__', JSON.stringify(perkMap))
    .replace('__SHARD_MAP_JSON__', JSON.stringify({ ...shardRaw, ...shardAliases }))
    .replace('__TREE_MAP_JSON__', JSON.stringify(treeNames));
}

// ---- minimal DOM -----------------------------------------------------------
const VOID = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'wbr', 'col', 'area', 'base', 'embed', 'track', 'param']);
function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]*))?/g;
  let m;
  while ((m = re.exec(s))) {
    let v = m[2] ?? '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    attrs[m[1].toLowerCase()] = v;
  }
  return attrs;
}
function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  const stack = [root];
  let i = 0;
  const cur = () => stack[stack.length - 1];
  function addText(t) {
    if (!t) return;
    const node = { tag: '#text', text: t, children: [], parent: cur() };
    cur().children.push(node);
  }
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { addText(html.slice(i)); break; }
    addText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    const inner = html.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!inner || inner[0] === '!' || inner[0] === '?') continue;
    if (inner[0] === '/') {
      const name = inner.slice(1).split(/\s/)[0].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClose = inner.endsWith('/');
    const space = inner.search(/\s/);
    const name = (space < 0 ? inner : inner.slice(0, space)).replace(/\/$/, '').toLowerCase();
    const attrs = parseAttrs(space < 0 ? '' : inner.slice(space));
    // script/style: raw text until the matching close tag
    if (name === 'script' || name === 'style') {
      const close = html.indexOf('</' + name, i);
      const body = close < 0 ? html.slice(i) : html.slice(i, close);
      const node = { tag: name, attrs, children: [], parent: cur(), rawText: body };
      cur().children.push(node);
      if (close >= 0) {
        const cgt = html.indexOf('>', close);
        i = cgt < 0 ? html.length : cgt + 1;
      } else i = html.length;
      continue;
    }
    const node = { tag: name, attrs, children: [], parent: cur() };
    cur().children.push(node);
    if (!selfClose && !VOID.has(name)) stack.push(node);
  }
  return root;
}
function classes(node) {
  return String(node.attrs.class || '').split(/\s+/).filter(Boolean);
}
// Flat selectors only: an optional tag, then any mix of .class and #id.
// (No combinators — every selector the shipped extractors use is flat, and
// the scripts scope by calling querySelector* on a host element instead.)
function matches(node, selector) {
  if (!node || node.tag[0] === '#') return false;
  const tokens = String(selector).trim().match(/^[a-zA-Z][\w-]*|[.#][\w-]+/g);
  if (!tokens || !tokens.length) return false;
  const have = classes(node);
  for (const token of tokens) {
    if (token[0] === '.') {
      if (!have.includes(token.slice(1))) return false;
    } else if (token[0] === '#') {
      if (String(node.attrs.id || '') !== token.slice(1)) return false;
    } else if (node.tag !== token.toLowerCase()) return false;
  }
  return true;
}
function walk(node, out) {
  out.push(node);
  for (const c of node.children) walk(c, out);
  return out;
}
function textOf(node) {
  if (node.tag === '#text') return node.text;
  if (node.rawText !== undefined) return node.rawText;
  return node.children.map(textOf).join('');
}
function styleOf(node) {
  const st = {};
  for (const part of String(node.attrs.style || '').split(';')) {
    const ci = part.indexOf(':');
    if (ci > 0) st[part.slice(0, ci).trim().toLowerCase()] = part.slice(ci + 1).trim().toLowerCase();
  }
  return st;
}
function markActive(node) {
  const have = classes(node);
  if (!have.includes('active')) {
    have.push('active');
    node.attrs.class = have.join(' ');
  }
}
function wrap(node) {
  return {
    _n: node,
    get className() { return String(node.attrs.class || ''); },
    get classList() {
      const have = classes(node);
      return { contains: (c) => have.includes(c) };
    },
    get style() { return { get display() { return styleOf(node).display; }, ...(styleOf(node)) }; },
    get textContent() { return textOf(node); },
    getAttribute: (k) => {
      const v = node.attrs[String(k).toLowerCase()];
      return v === undefined ? null : v;
    },
    getElementsByTagName: (t) => {
      const want = String(t).toLowerCase();
      return walk(node, []).filter((n) => n.tag === want).map(wrap);
    },
    querySelectorAll: (sel) => walk(node, []).filter((n) => matches(n, sel)).map(wrap),
    querySelector: (sel) => {
      const hit = walk(node, []).find((n) => n !== node && matches(n, sel));
      return hit ? wrap(hit) : null;
    },
    // The harness stands in for the site's own selection behaviour: a
    // dispatched click marks the row active, the way the live page's
    // conditioned recompute would (minus the recompute itself, which no
    // static fixture can exercise).
    dispatchEvent: () => { markActive(node); return true; },
    click: () => { markActive(node); },
  };
}
function makeDocument(html) {
  const root = parseHtml(html);
  return {
    querySelectorAll: (sel) => walk(root, []).filter((n) => matches(n, sel)).map(wrap),
    querySelector: (sel) => {
      const hit = walk(root, []).find((n) => matches(n, sel));
      return hit ? wrap(hit) : null;
    },
    getElementsByTagName: (t) => {
      const want = String(t).toLowerCase();
      return walk(root, []).filter((n) => n.tag === want).map(wrap);
    },
  };
}
function runOnDocument(script, document, url) {
  const location = { href: url };
  // NB: wrap without a newline after return (ASI would void it).
  const body = 'return (' + script.trim().replace(/;[\s;]*$/, '') + ');';
  const fn = new Function('document', 'location', body);
  return JSON.parse(fn(document, location));
}
function runExtractor(script, html, url) {
  return runOnDocument(script, makeDocument(html), url);
}

// ---- expectations ----------------------------------------------------------
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('ok   ' + name);
  else { failures++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); }
}

const uggHtml = readFileSync(join(dir, 'ugg-jhin-adc.html'), 'utf8');
const clHtml = readFileSync(join(dir, 'coachless-jhin-adc.html'), 'utf8');
const uggJs = buildScript('UGgTemplate');
function buildCoachlessStep(action) {
  return rawBlock('CoachlessStepTemplate').replace('__COACHLESS_STEP_JSON__', JSON.stringify(action));
}
const clInspectJs = buildCoachlessStep({ action: 'inspect' });

check('ugg template has injected perk map', uggJs.includes('"electrocute":8112'));
check('ugg template has injected shard map', uggJs.includes('"adaptiveforce":5008'));
check('coachless step has no leftover token', !clInspectJs.includes('__COACHLESS_STEP_JSON__'));

const ugg = runExtractor(uggJs, uggHtml, 'https://u.gg/lol/champions/jhin/build/adc');
console.log('ugg payload: ' + JSON.stringify(ugg).slice(0, 600));
check('ugg source', ugg.source === 'u.gg', ugg.source);
check('ugg slug/role', ugg.championSlug === 'jhin' && ugg.role === 'adc', ugg.championSlug + '/' + ugg.role);
check('ugg styles', ugg.runes && ugg.runes.primaryStyleId === 8000 && ugg.runes.subStyleId === 8300,
  ugg.runes && ugg.runes.primaryStyleId + '/' + ugg.runes.subStyleId);
check('ugg perks', ugg.runes && JSON.stringify(ugg.runes.perkIds) === JSON.stringify([8021, 8009, 9103, 8017, 8321, 8316]),
  ugg.runes && JSON.stringify(ugg.runes.perkIds));
check('ugg shards', ugg.runes && JSON.stringify(ugg.runes.shardIds) === JSON.stringify([5008, 5008, 5011]),
  ugg.runes && JSON.stringify(ugg.runes.shardIds));
const titles = (ugg.itemBlocks || []).map((b) => b.title + '=' + b.itemIds.join(',')).join(' | ');
console.log('ugg blocks: ' + titles);
check('ugg starting', titles.includes('Starting Items=1120,2003'), titles);
check('ugg core', titles.includes('Core Items=6697,3009,3046'), titles);

const clUrl = 'https://coachless.gg/builds/jhin?role=adc';
// The walk runs against ONE live document: clicks mark rows active the way
// the site would (the harness cannot recompute downstream tables, so the
// selected rows stay the fixture's unconditioned tops — the recompute
// itself is live-verified in a browser, not here).
const clDoc = makeDocument(clHtml);
const inspected = runOnDocument(clInspectJs, clDoc, clUrl);
console.log('coachless slots: ' + JSON.stringify(inspected.slots.map((s) => s.title)));
check('coachless inspect stage', inspected.stage === 'state', inspected.stage);
check('coachless slot order follows the DOM',
  JSON.stringify(inspected.slots.map((s) => s.title)) === JSON.stringify(
    ['Keystone', 'Starter', '1st Item', '2nd Item', 'Spell', 'Boots', '3rd Item', '4th+ Item']),
  JSON.stringify(inspected.slots.map((s) => s.title)));
check('coachless fixture starts with nothing selected',
  inspected.slots.every((s) => s.topSelected === false),
  JSON.stringify(inspected.slots));
check('coachless inspect carries a settle hash', typeof inspected.hash === 'string' && inspected.hash.length > 0, inspected.hash);

const readJs = buildCoachlessStep({ action: 'read' });
const clEarly = runOnDocument(readJs, clDoc, clUrl);
// A read before any selection does NOT fail: since 2.0.0 the read falls back
// to each slot's (by then conditioned) top row and marks it selected:false,
// which is what lets a page that grants no selections at all still yield the
// site's own recommendations. (This check used to expect a 'no selected row'
// error, which that change removed.)
check('coachless read before any selection falls back to top rows',
  clEarly.stage === 'done' &&
  (clEarly.payload.itemBlocks || []).length === 6 &&
  (clEarly.payload.itemBlocks || []).every((b) => b.selected === false),
  JSON.stringify(clEarly).slice(0, 300));

// The site grants `selectable` only to a capped depth -- for Jhin ADC that is
// Keystone/Starter/1st/2nd, and Spell/Boots/3rd/4th+ are READ-ONLY. So the
// expectation is per slot, not uniform: a selectable slot clicks and then
// re-clicks idempotently; a read-only one reports `read-only` and is never
// clicked at all. (This loop used to expect every slot to click, which
// predates the selectable gating and had been failing for four slots.)
for (const slot of inspected.slots) {
  const title = slot.title;
  const first = runOnDocument(buildCoachlessStep({ action: 'click', slot: title }), clDoc, clUrl);
  if (!slot.topSelectable) {
    check('coachless read-only slot ' + title + ' is never clicked',
      first.stage === 'read-only' && first.clickedSlot === title, JSON.stringify(first));
    continue;
  }
  check('coachless click ' + title, first.stage === 'clicked' && first.clickedSlot === title, JSON.stringify(first));
  const again = runOnDocument(buildCoachlessStep({ action: 'click', slot: title }), clDoc, clUrl);
  check('coachless re-click ' + title + ' is idempotent',
    again.stage === 'already-selected' && again.clickedSlot === title, JSON.stringify(again));
}
check('the fixture really does have both kinds of slot',
  inspected.slots.some((s) => s.topSelectable) && inspected.slots.some((s) => !s.topSelectable),
  JSON.stringify(inspected.slots.map((s) => s.title + ':' + s.topSelectable)));
const clMissing = runOnDocument(buildCoachlessStep({ action: 'click', slot: 'Nope' }), clDoc, clUrl);
check('coachless click of a missing slot is typed',
  typeof clMissing.error === 'string' && clMissing.error.includes('"Nope"'), JSON.stringify(clMissing));

const cl = runOnDocument(readJs, clDoc, clUrl);
console.log('coachless payload: ' + JSON.stringify(cl.payload).slice(0, 600));
check('coachless read stage', cl.stage === 'done', cl.stage);
const payload = cl.payload || {};
check('coachless source', payload.source === 'coachless', payload.source);
check('coachless slug/role', payload.championSlug === 'jhin' && payload.role === 'adc', payload.championSlug + '/' + payload.role);
check('coachless runes absent (page has no rune page)', payload.runes === null || payload.runes === undefined, JSON.stringify(payload.runes));
check('coachless has slot blocks', (payload.itemBlocks || []).length === 6, (payload.itemBlocks || []).length);
// Static fixture: no recompute happens here, so the selected rows are the
// unconditioned tops — Stormrazor first, Phantom Dancer second. The live
// walk must show the conditioned values instead (Stormrazor +3.79 first,
// Phantom Dancer +2.69 second per the user's screenshots).
const blockOf = (title) => (payload.itemBlocks || []).find((b) => b.title === title);
check('coachless starter selected', JSON.stringify(blockOf('Starter').itemIds) === JSON.stringify([1120]), JSON.stringify(blockOf('Starter')));
check('coachless 1st selected', JSON.stringify(blockOf('1st Item').itemIds) === JSON.stringify([3095]), JSON.stringify(blockOf('1st Item')));
check('coachless 2nd selected', JSON.stringify(blockOf('2nd Item').itemIds) === JSON.stringify([3046]), JSON.stringify(blockOf('2nd Item')));

// typed failures, never silent
const uggWrong = runExtractor(uggJs, uggHtml, 'https://u.gg/lol/champions/jhin');
check('ugg non-build url is a typed failure', typeof uggWrong.error === 'string', JSON.stringify(uggWrong));
const clWrong = runOnDocument(readJs, clDoc, 'https://coachless.gg/');
check('coachless homepage is a typed failure', typeof clWrong.error === 'string', JSON.stringify(clWrong));
const clEmpty = runOnDocument(clInspectJs, makeDocument('<html><body><table></table></body></html>'), 'https://coachless.gg/builds/jhin?role=adc');
check('coachless recognized page without slots reports empty',
  clEmpty.stage === 'state' && clEmpty.slots.length === 0, JSON.stringify(clEmpty));

// ---- 2.1.0 field fixes: the Nasus TOP pages --------------------------------
// Captured live 2026-09-08 from the two pages that produced the field failures
// "u.gg yielded no item build -- ignored" and 'Coachless extraction failed
// (slot "Starter" yielded no items)'. Both pages read FINE statically, which is
// itself the finding: neither failure is a page-shape defect, so the fixes are
// (a) stop requiring the rendered rank to be the embedded key and (b) stop
// letting one empty slot discard five good ones -- plus the per-stage notes
// that will name the cause on the next live pass instead of needing another.
const uggNasusHtml = readFileSync(join(dir, 'ugg-nasus-top.html'), 'utf8');
const uggNasusUrl = 'https://u.gg/lol/champions/nasus/build/top';
const uggNasus = runExtractor(uggJs, uggNasusHtml, uggNasusUrl);
console.log('ugg nasus blocks: ' + (uggNasus.itemBlocks || []).map((b) => b.title + '=' + b.itemIds.join(',')).join(' | '));
check('ugg nasus slug/role', uggNasus.championSlug === 'nasus' && uggNasus.role === 'top',
  uggNasus.championSlug + '/' + uggNasus.role);
check('ugg nasus yields an item build', (uggNasus.itemBlocks || []).length > 0,
  JSON.stringify(uggNasus).slice(0, 200));
const nasusTitles = (uggNasus.itemBlocks || []).map((b) => b.title + '=' + b.itemIds.join(',')).join(' | ');
check('ugg nasus starting', nasusTitles.includes('Starting Items=1054,2003'), nasusTitles);
check('ugg nasus core', nasusTitles.includes('Core Items=3158,3078,3110'), nasusTitles);
// The stage note must be present on SUCCESS too -- a diagnostic that only
// appears when things break is a diagnostic nobody has ever seen work.
const nasusNotes = (uggNasus.meta && uggNasus.meta.notes) || [];
console.log('ugg nasus notes: ' + JSON.stringify(nasusNotes));
check('ugg carries a stage note on success',
  uggNasus.meta && uggNasus.meta.stage === 'blocks-built' &&
  nasusNotes.some((n) => n.includes('stage blocks-built') && n.includes('emerald_plus')),
  JSON.stringify(uggNasus.meta));

// THE ACTUAL FIX. Rewrite the rendered rank badge to a rank the page does NOT
// embed -- the shape a warmed profile with a different stored filter produces.
// Before the fix this yielded ZERO item blocks in silence; now the single
// embedded rank for the role is used, and the note says so.
const uggWrongRank = uggNasusHtml.replace(/\/mini\/emerald_plus\.svg/g, '/mini/platinum_plus.svg');
check('the mutant really did move the rendered rank',
  uggWrongRank !== uggNasusHtml && !uggWrongRank.includes('/mini/emerald_plus.svg'));
const uggFallback = runExtractor(uggJs, uggWrongRank, uggNasusUrl);
const fbNotes = (uggFallback.meta && uggFallback.meta.notes) || [];
console.log('ugg wrong-rank notes: ' + JSON.stringify(fbNotes));
check('a rendered rank the page does not embed still yields the item build',
  (uggFallback.itemBlocks || []).length === (uggNasus.itemBlocks || []).length &&
  JSON.stringify(uggFallback.itemBlocks) === JSON.stringify(uggNasus.itemBlocks),
  JSON.stringify((uggFallback.itemBlocks || []).length));
check('and it says which rank it fell back to',
  fbNotes.some((n) => n.includes('platinum_plus') && n.includes('emerald_plus')), JSON.stringify(fbNotes));

// Two embedded ranks and none of them the rendered one is a GUESS, and must be
// refused -- the fallback is only sound because the page embeds exactly one.
const uggTwoRanks = uggWrongRank.replace(/"world_emerald_plus_top"/g,
  '"world_gold_plus_top":{"rec_core_items":{"ids":[1,2,3]}},"world_emerald_plus_top"');
const uggAmbiguous = runExtractor(uggJs, uggTwoRanks, uggNasusUrl);
const ambNotes = (uggAmbiguous.meta && uggAmbiguous.meta.notes) || [];
check('two embedded ranks and no rendered match refuses rather than guessing',
  (uggAmbiguous.itemBlocks || []).length === 0 &&
  ambNotes.some((n) => n.includes('refused rather than guessed')), JSON.stringify(ambNotes));

// ---- 2.1.0 round 2, ITEM 1: a ROLELESS u.gg url -----------------------------
// Champ select does not always report a role (practice tool, blind, customs),
// so SiteDeepLink.Build emits /lol/champions/{slug}/build with no role segment
// and u.gg auto-selects the champion's main role. The extractor reads the URL
// off the page, so "roleless" is simulated the way production produces it: the
// SAME fixture, read under the roleless URL.
const uggNasusRolelessUrl = 'https://u.gg/lol/champions/nasus/build';
// Controls: the fixture really is the shape these checks need -- exactly one
// rendered active role tab, and FIVE embedded roles, so the
// single-embedded-role fallback cannot be what rescues the first case.
check('control: the fixture renders exactly one active role tab',
  (uggNasusHtml.match(/class="role-filter active"/g) || []).length === 1,
  (uggNasusHtml.match(/class="role-filter active"/g) || []).length);
const embeddedRoleTokens = [...new Set(
  [...uggNasusHtml.matchAll(/"world_[a-z0-9_]*?_([a-z]+)"/g)].map((m) => m[1]))];
check('control: the fixture embeds five roles, so one-embedded-role cannot apply',
  embeddedRoleTokens.length === 5, JSON.stringify(embeddedRoleTokens));

const uggRoleless = runExtractor(uggJs, uggNasusHtml, uggNasusRolelessUrl);
const rolelessNotes = (uggRoleless.meta && uggRoleless.meta.notes) || [];
console.log('ugg roleless notes: ' + JSON.stringify(rolelessNotes));
check('a roleless u.gg url still yields the item build',
  (uggRoleless.itemBlocks || []).length > 0 &&
  JSON.stringify(uggRoleless.itemBlocks) === JSON.stringify(uggNasus.itemBlocks),
  JSON.stringify((uggRoleless.itemBlocks || []).length));
check('and the payload carries the DISCOVERED role, not an empty one',
  uggRoleless.role === 'top', uggRoleless.role);
check('and it says the role came from the rendered active tab',
  rolelessNotes.some((n) => n.includes('the URL carried no role') && n.includes('active-role-tab')),
  JSON.stringify(rolelessNotes));
check('and the runes half is unaffected by the missing role',
  JSON.stringify(uggRoleless.runes) === JSON.stringify(uggNasus.runes),
  JSON.stringify(uggRoleless.runes));
// The pre-fix line named a dead end; there is no longer a dead end to name.
check('the pre-fix "no build key could be formed" line is gone',
  !rolelessNotes.some((n) => n.includes('no build key could be formed')),
  JSON.stringify(rolelessNotes));

// Fallback 2: no rendered role tab, exactly ONE embedded role -> use it.
const uggNoTabOneRole = uggNasusHtml
  .replace(/class="role-filter active"/g, 'class="role-filter"')
  .replace(/"world_emerald_plus_(jungle|mid|adc|support)"/g, '"worldgone_emerald_plus_$1"');
check('the mutant really did remove the active tab and four of the five roles',
  !uggNoTabOneRole.includes('role-filter active') &&
  [...new Set([...uggNoTabOneRole.matchAll(/"world_[a-z0-9_]*?_([a-z]+)"/g)].map((m) => m[1]))].length === 1);
const uggOneRole = runExtractor(uggJs, uggNoTabOneRole, uggNasusRolelessUrl);
const oneRoleNotes = (uggOneRole.meta && uggOneRole.meta.notes) || [];
check('no active tab but exactly one embedded role uses that role',
  uggOneRole.role === 'top' && (uggOneRole.itemBlocks || []).length > 0 &&
  oneRoleNotes.some((n) => n.includes('only-embedded-role')),
  JSON.stringify(oneRoleNotes));

// The refusal: no rendered tab and SEVERAL embedded roles is a guess.
const uggNoTab = uggNasusHtml.replace(/class="role-filter active"/g, 'class="role-filter"');
const uggAmbiguousRole = runExtractor(uggJs, uggNoTab, uggNasusRolelessUrl);
const ambRoleNotes = (uggAmbiguousRole.meta && uggAmbiguousRole.meta.notes) || [];
check('no active tab and several embedded roles refuses rather than guessing',
  (uggAmbiguousRole.itemBlocks || []).length === 0 &&
  ambRoleNotes.some((n) => n.includes('embeds 5 roles') && n.includes('refused rather than guessed')),
  JSON.stringify(ambRoleNotes));
// ...and the refusal is still per-half: the runes survive it.
check('and the roleless refusal still returns the runes half',
  uggAmbiguousRole.runes && uggAmbiguousRole.runes.perkIds.length === 6,
  JSON.stringify(uggAmbiguousRole.runes));

// A role-BEARING url must be untouched by all of this: the URL still wins.
check('a role-bearing url still reports its role as coming from the url',
  nasusNotes.some((n) => n.includes('via url')), JSON.stringify(nasusNotes));
check('and a role-bearing url adds no discovery note',
  !nasusNotes.some((n) => n.includes('the URL carried no role')), JSON.stringify(nasusNotes));

// Coachless Nasus top: reads clean statically, including Starter.
const clNasusHtml = readFileSync(join(dir, 'coachless-nasus-top.html'), 'utf8');
const clNasusUrl = 'https://coachless.gg/builds/nasus?role=top';
const clNasusDoc = makeDocument(clNasusHtml);
const clNasusRead = runOnDocument(readJs, clNasusDoc, clNasusUrl);
console.log('coachless nasus: ' + JSON.stringify(clNasusRead.payload).slice(0, 400));
check('coachless nasus reads every slot including Starter',
  clNasusRead.stage === 'done' && (clNasusRead.payload.itemBlocks || []).length === 6 &&
  (clNasusRead.payload.itemBlocks || []).some((b) => b.title === 'Starter' && b.itemIds.length > 0),
  JSON.stringify(clNasusRead).slice(0, 300));

// THE ACTUAL FIX. Strip the Starter table's item icons -- the live shape that
// produced 'slot "Starter" yielded no items'. Before the fix this discarded ALL
// SIX slots; now Starter is omitted with a note and the other five still write.
function stripStarterIcons(html) {
  const at = html.indexOf('Starter');
  if (at < 0) throw new Error('fixture has no Starter section');
  const start = html.lastIndexOf('<table', at);
  const end = html.indexOf('</table>', at);
  if (start < 0 || end < 0) throw new Error('could not bound the Starter table');
  const before = html.slice(0, start);
  const table = html.slice(start, end).replace(/\/img\/item\//g, '/img/gone/');
  return before + table + html.slice(end);
}
const clNoStarter = stripStarterIcons(clNasusHtml);
check('the mutant really did strip Starter item icons',
  (clNoStarter.match(/\/img\/gone\//g) || []).length > 0);
const clDegraded = runOnDocument(readJs, makeDocument(clNoStarter), clNasusUrl);
const degradedTitles = ((clDegraded.payload || {}).itemBlocks || []).map((b) => b.title);
const degradedNotes = (((clDegraded.payload || {}).meta || {}).notes) || [];
console.log('coachless degraded: ' + JSON.stringify(degradedTitles) + ' notes ' + JSON.stringify(degradedNotes));
check('an empty Starter omits its block instead of failing the import',
  clDegraded.stage === 'done' && degradedTitles.length === 5 && !degradedTitles.includes('Starter'),
  JSON.stringify(clDegraded).slice(0, 300));
check('and the other five slots still carry their items',
  ((clDegraded.payload || {}).itemBlocks || []).every((b) => b.itemIds.length > 0),
  JSON.stringify((clDegraded.payload || {}).itemBlocks));
check('and the omission is named in meta.notes with the row census',
  degradedNotes.some((n) => n.includes('"Starter"') && n.includes('yielded no items') && n.includes('rows')),
  JSON.stringify(degradedNotes));

// The floor: a page where NO slot yields items is still a typed failure, and
// the reason must survive MapStepError (which collapses anything saying "no
// build" to the generic reason and would throw the per-slot detail away).
const clAllEmpty = clNasusHtml.replace(/\/img\/item\//g, '/img/gone/');
const clDead = runOnDocument(readJs, makeDocument(clAllEmpty), clNasusUrl);
check('a page where no slot yields items is still a typed failure',
  typeof clDead.error === 'string' && clDead.error.includes('every item slot'), JSON.stringify(clDead).slice(0, 300));
check('and that reason does not say "no build" (which would collapse the detail)',
  typeof clDead.error === 'string' && !clDead.error.toLowerCase().includes('no build'), clDead.error);

// ---- 2.1.0: the Coachless RUNES page ---------------------------------------
// Runs the shipped CoachlessRunesTemplate verbatim against the real rendered
// runes page captured 2026-09-08 (Nasus top). Unlike the builds overview this
// page is READ-ONLY, so nothing here depends on simulated clicks: what the
// fixture shows is what the extractor must read.
const runesHtml = readFileSync(join(dir, 'coachless-nasus-runes.html'), 'utf8');
const runesJs = buildRunesScript();
const runesUrl = 'https://coachless.gg/runes/tree/nasus/precision/resolve?role=top';

check('runes template has no leftover tokens',
  !runesJs.includes('__PERK_MAP_JSON__') && !runesJs.includes('__SHARD_MAP_JSON__') && !runesJs.includes('__TREE_MAP_JSON__'));
check('runes template carries the coachless shard aliases', runesJs.includes('"ah":5007'));

const runes = runExtractor(runesJs, runesHtml, runesUrl);
console.log('runes payload: ' + JSON.stringify(runes).slice(0, 600));
check('runes source', runes.source === 'coachless', runes.source);
check('runes slug/role', runes.championSlug === 'nasus' && runes.role === 'top',
  runes.championSlug + '/' + runes.role);
check('runes carries no items (that is the walk\'s job)',
  Array.isArray(runes.itemBlocks) && runes.itemBlocks.length === 0, JSON.stringify(runes.itemBlocks));

// The trees come from the rendered perk icons, NOT from the URL: this URL
// says precision/resolve and so does the page, but the deep link we navigate
// with says precision/domination and the site redirects. Precision=8000,
// Resolve=8400.
check('runes trees read off the icons',
  runes.runes && runes.runes.primaryStyleId === 8000 && runes.runes.subStyleId === 8400,
  runes.runes && runes.runes.primaryStyleId + '/' + runes.runes.subStyleId);

// Top WPA per slot row, from the fixture's own numbers:
//   keystone     FleetFootwork  +0.59  (vs PressTheAttack -1.74, LethalTempo -4.22, Conqueror -1.36)
//   primary  1   PresenceOfMind +0.78  (vs AbsorbLife -2.46, Triumph -0.01)
//   primary  2   LegendHaste    +0.05  (vs LegendAlacrity -4.60, LegendBloodline -0.63)
//   primary  3   CutDown        +0.59  (vs CoupDeGrace -1.41, LastStand +0.02)
//   secondary    BonePlating    +0.46  and Overgrowth +0.43 -- the best TWO
//                ROWS; Demolish (-0.26) is row 1's winner and loses the row race
//   shards       ah +0.27, ms +0.82, tenacity +1.32
check('runes perk ids are the top-WPA pick per row',
  runes.runes && JSON.stringify(runes.runes.perkIds) === JSON.stringify([8021, 8009, 9105, 8017, 8473, 8451]),
  runes.runes && JSON.stringify(runes.runes.perkIds));
check('runes shard ids are the top-WPA pick per row',
  runes.runes && JSON.stringify(runes.runes.shardIds) === JSON.stringify([5007, 5010, 5013]),
  runes.runes && JSON.stringify(runes.runes.shardIds));

// The cards the site has no sample for (FontOfLife / MirrorShell render
// is-empty with a "-.--" delta) must be SKIPPED, not read as zero. If they
// were read as 0 they would beat Demolish's -0.26 and secondary row 1 would
// have won a place.
check('empty cards are skipped rather than read as zero',
  runes.runes && !runes.runes.perkIds.includes(8463) && !runes.runes.perkIds.includes(8465),
  runes.runes && JSON.stringify(runes.runes.perkIds));

// Typed failures, per missing part, never a guessed page.
const runesWrongUrl = runExtractor(runesJs, runesHtml, 'https://coachless.gg/builds/nasus?role=top');
check('runes non-runes url is a typed failure',
  typeof runesWrongUrl.error === 'string' && runesWrongUrl.error.includes('not a champion runes page'),
  JSON.stringify(runesWrongUrl));
const runesEmpty = runExtractor(runesJs, '<html><body><div class="primary-runes"></div></body></html>', runesUrl);
check('runes page with no keystone row is a typed failure naming the part',
  typeof runesEmpty.error === 'string' && runesEmpty.error.includes('keystone'), JSON.stringify(runesEmpty));
// A page missing a whole slot group must NOT yield a partial rune page.
const runesPartial = runesHtml.replace(/modifier-shards/g, 'modifier-shards-gone');
const runesNoShards = runExtractor(runesJs, runesPartial, runesUrl);
check('runes page with no shard rows writes nothing and says which part',
  typeof runesNoShards.error === 'string' && runesNoShards.error.includes('shard rows'),
  JSON.stringify(runesNoShards));

// ---- 2.1.0 round 2, ITEM 2: the runes page's FIRST PAINT --------------------
// Live 2026-09-08: "no keystone on the runes page carried a WPA reading" while
// this very fixture yields a full page. The page is Angular and paints its
// cards before the deltas land, so a first-paint read is not a verdict. Those
// absences now carry retryable:true (C#'s RunesSettleProbe polls on it) and a
// per-row census, so a settle that really does time out says what it saw.
//
// Control first: the good read must NOT be marked retryable, or the marker
// would mean nothing.
check('control: a successful runes read carries no retry marker',
  runes.retryable === undefined && runes.error === undefined, JSON.stringify(runes).slice(0, 120));

// The mutant: strip the deltas from the keystone row only. Every card still
// renders and every icon still resolves -- exactly the live shape.
function stripKeystoneDeltas(html) {
  // lastIndexOf, not indexOf: the class name also appears in the page's own
  // embedded stylesheet, hundreds of KB before the rendered row.
  const at = html.lastIndexOf('keystone-selector');
  if (at < 0) throw new Error('fixture has no keystone-selector');
  const end = html.indexOf('secondary-selector', at);
  if (end < 0) throw new Error('could not bound the keystone row');
  return html.slice(0, at) +
    html.slice(at, end).replace(/rune-delta/g, 'rune-delta-pending') +
    html.slice(end);
}
const runesNoDeltas = stripKeystoneDeltas(runesHtml);
check('the mutant really did strip the keystone row deltas',
  runesNoDeltas !== runesHtml && runesNoDeltas.includes('rune-delta-pending'));
const runesEarly = runExtractor(runesJs, runesNoDeltas, runesUrl);
console.log('runes first-paint: ' + JSON.stringify(runesEarly));
check('a keystone row with no readings is a RETRYABLE failure, not a verdict',
  typeof runesEarly.error === 'string' && runesEarly.retryable === true,
  JSON.stringify(runesEarly));
check('and it names the census: cards rendered vs cards with a reading',
  typeof runesEarly.error === 'string' &&
  runesEarly.error.includes('cards rendered') &&
  runesEarly.error.includes('with a readable id') &&
  runesEarly.error.includes('0 with a WPA reading'),
  runesEarly.error);
// The structural absences are retryable too -- a half-mounted view is the
// same "not yet" as a half-numbered one.
check('a runes page with no keystone row is retryable',
  runesEmpty.retryable === true, JSON.stringify(runesEmpty));
check('a runes page with no shard rows is retryable', runesNoShards.retryable === true,
  JSON.stringify(runesNoShards));
// But a URL that is not a runes page can never become one by waiting.
check('a non-runes url is NOT retryable', runesWrongUrl.retryable === undefined,
  JSON.stringify(runesWrongUrl));

// ---- 2.1.0: the consent wall -----------------------------------------------
// Both fixtures were captured with their real consent dialogs in the DOM, so
// the dismissal can be exercised against the markup it will actually meet.
const consentJs = rawBlock('ConsentDismissTemplate');
// The reason names the FRAMEWORK, not the site: op.gg runs the same Quantcast
// wall Coachless does (_evidence/live-2.1.0/02-mystats-tab.png is this very
// dialog), so a reason saying "coachless" would be wrong on the MyStats tab.
const clConsent = runExtractor(consentJs, clHtml, clUrl);
check('coachless consent wall is recognized and accepted',
  clConsent.dismissed === true && clConsent.reason === 'quantcast-choice', JSON.stringify(clConsent));
const uggConsent = runExtractor(consentJs, uggHtml, 'https://u.gg/lol/champions/jhin/build/adc');
check('u.gg consent wall is recognized and accepted',
  uggConsent.dismissed === true && uggConsent.reason === 'google-funding-choices', JSON.stringify(uggConsent));
// Evidence, not assumption, that the two entries are two DIFFERENT walls: the
// Quantcast fixture carries the exact strings the op.gg screenshot shows, and
// the Funding Choices one does not.
check('the coachless/op.gg wall is Quantcast, by its own strings',
  clHtml.includes('id="accept-btn"') && clHtml.includes('MORE OPTIONS') &&
  clHtml.includes('IABGPP_HDR_GppString'), 'coachless fixture');
check('and the u.gg wall is a different framework with different wording',
  uggHtml.includes('fc-cta-consent') && !uggHtml.includes('MORE OPTIONS') &&
  !uggHtml.includes('IABGPP_HDR_GppString'), 'ugg fixture');
// The runes fixture was captured AFTER consent was accepted: the Quantcast
// SHELL is still in the DOM but its buttons are gone. Nothing is clicked, and
// nothing is logged -- which is the point.
const acceptedAlready = runExtractor(consentJs, runesHtml, runesUrl);
check('an already-accepted profile clicks nothing',
  acceptedAlready.dismissed === false, JSON.stringify(acceptedAlready));
// ...and a leftover shell must not mask another site's live dialog.
const shellPlusWall = runExtractor(consentJs,
  '<html><body><div id="qc-cmp2-container"></div>' +
  '<div class="fc-consent-root"><button class="fc-button fc-cta-consent">Consent</button></div>' +
  '</body></html>', 'https://u.gg/');
check('a leftover shell does not mask a live wall on the other site',
  shellPlusWall.dismissed === true && shellPlusWall.reason === 'google-funding-choices',
  JSON.stringify(shellPlusWall));
// The plain no-wall case.
const noConsent = runExtractor(consentJs,
  '<html><body><p>nothing to accept</p></body></html>', runesUrl);
check('a page with no wall dismisses nothing, quietly',
  noConsent.dismissed === false && noConsent.reason === 'none', JSON.stringify(noConsent));
// An unrecognized wall stays up rather than getting a guessed click.
const strangeWall = runExtractor(consentJs,
  '<html><body><div class="cookie-banner"><button>Accept all</button></div></body></html>',
  'https://coachless.gg/');
check('an unrecognized wall is left alone',
  strangeWall.dismissed === false && strangeWall.reason === 'none', JSON.stringify(strangeWall));

if (failures) { console.log(failures + ' FAILURES'); process.exit(1); }
console.log('all extractor checks passed');
