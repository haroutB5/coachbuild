using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// The per-site extractor scripts for the user-initiated build import.
///
/// <para>Each script is a self-contained IIFE: no external requests, no
/// navigation, one JSON string out. The u.gg script is a read-only DOM read;
/// the Coachless walk additionally dispatches a click per slot section —
/// that click IS the import (it reproduces exactly what a user clicking the
/// page's own top-WPA row does, driving the site's own conditioned
/// recompute), it runs only inside the import click handler, and the shape
/// each step returns is exactly what <see cref="SiteImportPayload"/> parses —
/// <c>{ source, championSlug, role, runes, itemBlocks }</c> or
/// <c>{ error }</c>. A failed read is a TYPED failure, never a silent empty
/// payload: the extractor reports what it could not find and C# turns that
/// into the status-line message, writing nothing.</para>
///
/// <para>Id resolution is data-driven, not hardcoded: the C# side injects the
/// ddragon-derived <see cref="PerkIconMap"/> and <see cref="ShardIconMap"/>
/// tables as JSON (<see cref="UGgScript"/>); the u.gg script folds icon
/// filenames the same way the maps do. The one
/// exception is u.gg's rune-TREE ids, which the page renders numerically
/// already (<c>/runes/8000.png</c>), so there is no name to map. The
/// Coachless step script needs no icon tables: item ids read numerically
/// off <c>/img/item/{id}.</c>, and the keystone it clicks for conditioning
/// is never resolved to an id.</para>
///
/// <para>DOM ANCHORS, derived from the real rendered fixtures captured
/// 2026-09-08 (<c>_research/site-import/ugg-jhin-adc.html</c>,
/// <c>coachless-jhin-adc.html</c> — read the per-site remarks on
/// <see cref="UGgTemplate"/> and <see cref="CoachlessStepTemplate"/>). The full
/// anchor-by-anchor account, with fragility notes, lives in the phase report;
/// the short version: numeric ids out of CDN image URLs first
/// (<c>perk-images/</c>, <c>/runes/{id}.png</c>, <c>/img/item/{id}.</c>),
/// selection state out of the sites' own active classes second, tag names
/// third, and nothing else at all.</para>
/// </summary>
public static class SiteImportExtractors
{
    /// <summary>
    /// u.gg extractor. Runes come from the RENDERED rune panel; items come
    /// from the page's own embedded build state.
    ///
    /// <para>RUNES — first VISIBLE <c>.rune-trees-container</c> (the page
    /// renders the panel twice, desktop + mobile breakpoints): the primary
    /// section is <c>.rune-tree.primary-tree</c>, the secondary is the other
    /// <c>.rune-tree</c> that is not <c>.stat-shards-container</c>. Tree ids
    /// read numerically off the section headers' <c>/runes/{id}.png</c>
    /// image; the keystone is <c>.perk.keystone.perk-active</c>; primary
    /// minors are the other <c>.perk.perk-active</c> in document order (row
    /// order); secondary minors likewise (exactly two); shards are the three
    /// <c>.stat-shard-row</c> rows' <c>.shard.shard-active</c> icons in
    /// Offense/Flex/Defense order. Perk filenames resolve through the
    /// injected <see cref="PerkIconMap"/>, shard filenames through
    /// <see cref="ShardIconMap"/> (same fold, StatMods prefix/suffix
    /// stripped). Champion slug and role come from the URL
    /// (<c>/lol/champions/{slug}/build/{role}</c>).</para>
    ///
    /// <para>ITEMS — u.gg renders item icons as CSS SPRITES
    /// (<c>img/sprite/item{N}.webp</c> + background-position), which carry no
    /// item id anywhere in the DOM, so there is no rendered anchor to read.
    /// The page DOES embed its own build data as JSON in a script tag (one
    /// object per <c>world_{rank}_{role}</c>, e.g.
    /// <c>world_emerald_plus_adc</c>, carrying <c>rec_starting_items.ids</c>,
    /// <c>rec_core_items.ids</c>, <c>item_options_1..4[].id</c>,
    /// <c>t3_boots_options</c> and <c>consumable_options</c>). The extractor
    /// reads that embedded state — still a read-only DOM read of the page
    /// the user is viewing, no request — keyed by the rank token from the
    /// rendered rank filter's <c>.rank-img</c>
    /// (<c>ranks/…/mini/{rank}.svg</c>) and the role from the URL. The blob
    /// was triple-matched to the displayed build in the fixture (section
    /// winrate/matches, rune set, shard set), but if the key is absent the
    /// extractor yields items-absent rather than guessing another rank.</para>
    ///
    /// <para>PARTIAL RESULTS ARE HONEST: the script returns whatever half it
    /// found (runes-only or items-only); only when NEITHER half is present
    /// does it return <c>{ error }</c>. C#'s pre-write validation then
    /// produces the precise per-half message ("the page yielded no rune
    /// build…", "…no item build…") and writes nothing.</para>
    /// </summary>
    public const string UGgTemplate = """
        (function () {
          function fail(message) { return JSON.stringify({ error: message }); }
          function norm(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
          function stemOf(src) {
            var s = String(src || '');
            var slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
            if (slash >= 0) s = s.slice(slash + 1);
            var cut = s.search(/[?#]/);
            if (cut >= 0) s = s.slice(0, cut);
            var dot = s.lastIndexOf('.');
            if (dot > 0) s = s.slice(0, dot);
            return s;
          }
          function perkId(src, map) {
            var id = map[norm(stemOf(src))];
            return (typeof id === 'number' && id > 0 && Math.floor(id) === id) ? id : 0;
          }
          function shardId(src, map) {
            var folded = norm(stemOf(src));
            if (folded.indexOf('statmods') === 0) folded = folded.slice(8);
            if (folded.slice(-4) === 'icon') folded = folded.slice(0, -4);
            var id = map[folded];
            return (typeof id === 'number' && id > 0 && Math.floor(id) === id) ? id : 0;
          }
          function extractBalanced(text, open) {
            var depth = 0, inStr = false, esc = false, quote = '';
            for (var i = open; i < text.length; i++) {
              var c = text[i];
              if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === quote) inStr = false;
              } else if (c === '"' || c === "'") { inStr = true; quote = c; }
              else if (c === '{') depth++;
              else if (c === '}') { depth--; if (!depth) return text.slice(open, i + 1); }
            }
            return '';
          }
          var PERK_MAP = __PERK_MAP_JSON__;
          var SHARD_MAP = __SHARD_MAP_JSON__;
          var href = String((typeof location !== 'undefined' && location.href) || '');
          var page = href.match(/u\.gg\/lol\/champions\/([a-z0-9]+)\/build(?:\/([a-z]+))?/i);
          if (!page) return fail('not a champion build page');
          var slug = page[1].toLowerCase();
          var role = (page[2] || '').toLowerCase();
          function isShown(el) {
            if (!el) return false;
            if (typeof el.offsetParent === 'undefined') return true;
            return el.offsetParent !== null;
          }
          function treeStyleId(section) {
            if (!section) return 0;
            var imgs = section.getElementsByTagName('img');
            for (var i = 0; i < imgs.length; i++) {
              var m = String(imgs[i].getAttribute('src') || '').match(/\/runes\/(\d+)\.png/i);
              if (m) return parseInt(m[1], 10);
            }
            return 0;
          }
          function activePerkIds(scope, keystones) {
            var out = [];
            var nodes = scope.querySelectorAll('.perk.perk-active');
            for (var i = 0; i < nodes.length; i++) {
              var cls = nodes[i].classList;
              var isKey = !!(cls && cls.contains('keystone'));
              if (isKey !== !!keystones) continue;
              var img = nodes[i].getElementsByTagName('img')[0];
              var id = img ? perkId(img.getAttribute('src'), PERK_MAP) : 0;
              if (!id) return null;
              out.push(id);
            }
            return out;
          }
          var runes = null;
          var panels = document.querySelectorAll('.rune-trees-container');
          var panel = null;
          for (var p = 0; p < panels.length; p++) {
            if (isShown(panels[p])) { panel = panels[p]; break; }
          }
          if (!panel && panels.length) panel = panels[0];
          if (panel) {
            var trees = panel.querySelectorAll('.rune-tree');
            var primary = null, secondary = null;
            for (var t = 0; t < trees.length; t++) {
              var tc = trees[t].classList;
              if (tc && tc.contains('primary-tree')) primary = trees[t];
              else if (tc && !tc.contains('stat-shards-container') && !secondary) secondary = trees[t];
            }
            var key = primary ? activePerkIds(primary, true) : null;
            var prim = primary ? activePerkIds(primary, false) : null;
            var secd = secondary ? activePerkIds(secondary, false) : null;
            var shardRows = panel.querySelectorAll('.stat-shard-row');
            var shards = [];
            var shardsOk = shardRows.length === 3;
            for (var s = 0; shardsOk && s < 3; s++) {
              var actives = shardRows[s].querySelectorAll('.shard.shard-active');
              if (actives.length !== 1) { shardsOk = false; break; }
              var simg = actives[0].getElementsByTagName('img')[0];
              var sid = simg ? shardId(simg.getAttribute('src'), SHARD_MAP) : 0;
              if (!sid) { shardsOk = false; break; }
              shards.push(sid);
            }
            if (key && key.length === 1 && prim && prim.length === 3 &&
                secd && secd.length === 2 && shardsOk) {
              runes = {
                primaryStyleId: treeStyleId(primary),
                subStyleId: treeStyleId(secondary),
                perkIds: [key[0], prim[0], prim[1], prim[2], secd[0], secd[1]],
                shardIds: shards
              };
            }
          }
          var blocks = [];
          function pushBlock(title, ids) {
            var clean = [];
            for (var i = 0; i < (ids || []).length; i++) {
              var n = ids[i];
              if (typeof n === 'number' && n > 0 && Math.floor(n) === n) clean.push(n);
            }
            if (clean.length) blocks.push({ title: title, itemIds: clean });
          }
          function pushOptions(title, options) {
            if (!options || !options.length) return;
            var oids = [];
            for (var i = 0; i < options.length; i++) {
              if (options[i] && typeof options[i].id === 'number') oids.push(options[i].id);
            }
            pushBlock(title, oids);
          }
          var rank = '';
          var rankBadges = document.querySelectorAll('.rank-img');
          for (var b = 0; b < rankBadges.length && !rank; b++) {
            var bm = String(rankBadges[b].getAttribute('src') || '').match(/\/mini\/([a-z0-9_]+)\.svg/i);
            if (bm) rank = bm[1].toLowerCase();
          }
          if (!rank) {
            var allImgs = document.getElementsByTagName('img');
            for (var g = 0; g < allImgs.length && !rank; g++) {
              var gm = String(allImgs[g].getAttribute('src') || '').match(/ranks\/[^/]*\/mini\/([a-z0-9_]+)\.svg/i);
              if (gm) rank = gm[1].toLowerCase();
            }
          }
          if (rank && role) {
            var want = '"world_' + rank + '_' + role + '"';
            var scripts = document.getElementsByTagName('script');
            var build = null;
            for (var q = 0; q < scripts.length && !build; q++) {
              var text = scripts[q].textContent || '';
              var at = text.indexOf(want);
              while (at >= 0 && !build) {
                var brace = text.indexOf('{', at + want.length);
                var raw = brace >= 0 ? extractBalanced(text, brace) : '';
                if (raw) {
                  try {
                    var candidate = JSON.parse(raw);
                    if (candidate && candidate.rec_core_items) build = candidate;
                  } catch (ignored) { /* next occurrence */ }
                }
                at = brace >= 0 ? text.indexOf(want, brace + 1) : -1;
              }
            }
            if (build) {
              if (build.rec_starting_items && build.rec_starting_items.ids)
                pushBlock('Starting Items', build.rec_starting_items.ids);
              if (build.rec_core_items && build.rec_core_items.ids)
                pushBlock('Core Items', build.rec_core_items.ids);
              pushOptions('Fourth Item', build.item_options_1);
              pushOptions('Fifth Item', build.item_options_2);
              pushOptions('Sixth Item', build.item_options_3);
              pushOptions('Seventh Item', build.item_options_4);
              pushOptions('Boots', build.t3_boots_options);
              pushOptions('Consumables', build.consumable_options);
            }
          }
          if (!runes && !blocks.length) return fail('no build on page');
          return JSON.stringify({ source: 'u.gg', championSlug: slug, role: role, runes: runes, itemBlocks: blocks });
        })();
        """;

    /// <summary>
    /// Coachless step script, for the champion builds overview
    /// (<c>coachless.gg/builds/{slug}?role={role}</c>).
    ///
    /// <para>That page is per-SLOT stat tables, and the tables are
    /// INTERACTIVE: selecting a row (the site marks it <c>active</c> on the
    /// <c>tr.data-row</c> — see the embedded stylesheet rule
    /// <c>.data-row.active</c> in the <c>coachless-jhin-adc.html</c> fixture)
    /// recomputes every downstream slot's WPA conditioned on the picks so
    /// far. Reading the unconditioned first rows (what the 1.2.0 extractor
    /// did) yields a build no user ever sees — e.g. Phantom Dancer top in
    /// 2nd, 3rd AND 4th+ at once. So this script never produces a build on
    /// its own: it performs ONE step of the user-initiated selection walk,
    /// driven by C# (<see cref="SiteImportSequencer"/>), which invokes it
    /// repeatedly from the single import click handler.</para>
    ///
    /// <para>The step to perform arrives via the
    /// <c>__COACHLESS_STEP_JSON__</c> token, replaced by C# with
    /// <c>{"action":"inspect"}</c>, <c>{"action":"click","slot":title}</c>
    /// or <c>{"action":"read"}</c> (see <c>SiteImportSteps</c>):</para>
    ///
    /// <para><c>inspect</c> lists the slot sections in DOM order (each
    /// <c>table</c> headed by a <c>th.entry-name.title</c>) with whether its
    /// top-WPA row (first <c>tr.data-row</c> — the site sorts by WPA) is
    /// already <c>active</c>, whether that top row is <c>selectable</c> (a
    /// slot whose top row lacks the class is READ-ONLY: the site grants
    /// selections only to a capped depth and C# never clicks such a slot),
    /// whether ANY row of the table is <c>active</c> (the settle wait
    /// watches this for the clicked slot), plus a fingerprint hash of the
    /// slot tables' contents that C# polls until stable. <c>click</c>
    /// dispatches a bubbling click on the named slot's top row unless it is
    /// already <c>active</c> (idempotent re-click guard, reported as
    /// <c>already-selected</c>) or no longer <c>selectable</c> (reported as
    /// <c>read-only</c>, no click dispatched). <c>read</c> returns the final
    /// payload — the SELECTED (<c>tr.data-row.active</c>) row of each item
    /// slot (Starter, 1st, 2nd, 3rd, 4th+, Boots) where one exists, else the
    /// TOP row of the by-now conditioned table (read-only slots collapse to
    /// conditioned recommendations that are never granted <c>selectable</c>,
    /// and the top row IS the recommendation) — one single-item block per
    /// slot titled with the page's own header text, each carrying
    /// <c>selected</c> provenance — or a typed error naming the slot with
    /// no rows at all.</para>
    ///
    /// <para>RUNES ARE NOT ON THIS PAGE. Keystone and Spell slots are
    /// clicked for conditioning but never imported: the overview renders
    /// keystone options and zero minor runes or shards, so no complete rune
    /// page can be read here. The final payload carries <c>runes: null</c>
    /// and C# applies the item set on its own, reporting the missing half
    /// in the status line ("no rune page on this site") — an honest
    /// items-only import, not a guess.</para>
    ///
    /// <para>Item ids read numerically off the row's <c>clr-item-icon
    /// img</c> (<c>/img/item/{id}.webp</c>), skipping icons the page hid
    /// itself (<c>onerror="this.style.display='none'"</c>).</para>
    /// </summary>
    public const string CoachlessStepTemplate = """
        (function () {
          function fail(message) { return JSON.stringify({ error: message }); }
          var STEP = __COACHLESS_STEP_JSON__;
          var action = STEP && STEP.action;
          function slotTables() {
            var out = [];
            var tables = document.getElementsByTagName('table');
            for (var t = 0; t < tables.length; t++) {
              var title = '';
              var ths = tables[t].getElementsByTagName('th');
              for (var h = 0; h < ths.length; h++) {
                var hc = String(ths[h].className || '');
                if (hc.indexOf('entry-name') >= 0 && hc.indexOf('title') >= 0) {
                  title = (ths[h].textContent || '').trim();
                  break;
                }
              }
              if (title) out.push({ title: title, table: tables[t] });
            }
            return out;
          }
          function dataRows(table) {
            var rows = [];
            var all = table.getElementsByTagName('tr');
            for (var i = 0; i < all.length; i++) {
              if (String(all[i].className || '').indexOf('data-row') >= 0) rows.push(all[i]);
            }
            return rows;
          }
          function isActive(row) {
            return hasClass(row, 'active');
          }
          function isSelectable(row) {
            return hasClass(row, 'selectable');
          }
          function hasClass(row, name) {
            var cls = row.classList;
            if (cls && cls.contains && cls.contains(name)) return true;
            return (' ' + String(row.className || '') + ' ').indexOf(' ' + name + ' ') >= 0;
          }
          function hasActiveRow(rows) {
            for (var a = 0; a < rows.length; a++) {
              if (isActive(rows[a])) return true;
            }
            return false;
          }
          function itemIds(row) {
            var picked = [];
            var imgs = row.getElementsByTagName('img');
            for (var m = 0; m < imgs.length; m++) {
              if (imgs[m].style && imgs[m].style.display === 'none') continue;
              var im = String(imgs[m].getAttribute('src') || '').match(/\/img\/item\/(\d+)\./i);
              if (im) picked.push(parseInt(im[1], 10));
            }
            return picked;
          }
          function fingerprint(slots) {
            var parts = [];
            for (var s = 0; s < slots.length; s++) {
              parts.push(slots[s].title);
              var rows = dataRows(slots[s].table);
              parts.push(String(rows.length));
              for (var r = 0; r < rows.length; r++) {
                parts.push(String(rows[r].className || ''));
                parts.push((rows[r].textContent || '').replace(/\s+/g, ' ').trim());
                parts.push(itemIds(rows[r]).join(','));
              }
            }
            var text = parts.join('|');
            var hash = 5381;
            for (var i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
            return ('0000000' + hash.toString(16)).slice(-8);
          }
          if (action === 'inspect') {
            var found = slotTables();
            var states = [];
            for (var s = 0; s < found.length; s++) {
              var listed = dataRows(found[s].table);
              states.push({
                title: found[s].title,
                topSelected: listed.length > 0 && isActive(listed[0]),
                topSelectable: listed.length > 0 && isSelectable(listed[0]),
                hasActive: hasActiveRow(listed),
                rows: listed.length
              });
            }
            return JSON.stringify({ stage: 'state', settled: true, hash: fingerprint(found), slots: states });
          }
          if (action === 'click') {
            var want = STEP && STEP.slot;
            var tables = slotTables();
            var target = null;
            for (var k = 0; k < tables.length; k++) {
              if (tables[k].title === want) { target = tables[k]; break; }
            }
            if (!target) return fail('slot "' + String(want) + '" not found');
            var rows = dataRows(target.table);
            if (!rows.length) return fail('slot "' + String(want) + '" has no rows');
            if (isActive(rows[0]))
              return JSON.stringify({ stage: 'already-selected', clickedSlot: want, settled: true });
            if (!isSelectable(rows[0]))
              return JSON.stringify({ stage: 'read-only', clickedSlot: want, settled: true });
            if (typeof MouseEvent === 'function') {
              rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } else if (rows[0].click) {
              rows[0].click();
            }
            return JSON.stringify({ stage: 'clicked', clickedSlot: want, settled: false });
          }
          if (action === 'read') {
            var href = String((typeof location !== 'undefined' && location.href) || '');
            var page = href.match(/coachless\.gg\/builds\/([a-z0-9]+)/i);
            if (!page) return fail('not a champion builds page');
            var slug = page[1].toLowerCase();
            var role = '';
            var qm = href.match(/[?&]role=([a-z]+)/i);
            if (qm) role = qm[1].toLowerCase();
            var SLOT_ORDER = ['Starter', '1st Item', '2nd Item', '3rd Item', '4th+ Item', 'Boots'];
            var looked = slotTables();
            var blocks = [];
            for (var b = 0; b < SLOT_ORDER.length; b++) {
              var entry = null;
              for (var e = 0; e < looked.length; e++) {
                if (looked[e].title === SLOT_ORDER[b]) { entry = looked[e]; break; }
              }
              if (!entry) return fail('slot "' + SLOT_ORDER[b] + '" not found');
              var sel = null;
              var cand = dataRows(entry.table);
              if (!cand.length) return fail('slot "' + SLOT_ORDER[b] + '" has no rows');
              for (var q = 0; q < cand.length; q++) {
                if (isActive(cand[q])) { sel = cand[q]; break; }
              }
              var row = sel || cand[0];
              var ids = itemIds(row);
              if (!ids.length) return fail('slot "' + SLOT_ORDER[b] + '" yielded no items');
              blocks.push({ title: SLOT_ORDER[b], itemIds: ids, selected: !!sel });
            }
            return JSON.stringify({
              stage: 'done', settled: true,
              payload: { source: 'coachless', championSlug: slug, role: role, runes: null, itemBlocks: blocks }
            });
          }
          return fail('unknown import step');
        })();
        """;

    private static readonly string BuiltUGgScript = UGgTemplate
        .Replace("__PERK_MAP_JSON__", PerkIconMap.ToJson(), StringComparison.Ordinal)
        .Replace("__SHARD_MAP_JSON__", ShardIconMap.ToJson(), StringComparison.Ordinal);

    private static readonly string BuiltCoachlessInspectScript =
        CoachlessStepTemplate.Replace(
            "__COACHLESS_STEP_JSON__",
            """{"action":"inspect"}""",
            StringComparison.Ordinal);

    /// <summary>The runnable u.gg extractor: template with both icon tables injected.</summary>
    public static string UGgScript => BuiltUGgScript;

    /// <summary>
    /// A runnable Coachless step script for one sequencer step: the
    /// <paramref name="stepJson"/> is the <c>__COACHLESS_STEP_JSON__</c>
    /// action object (see <c>SiteImportSteps</c>), embedded verbatim.
    /// </summary>
    public static string CoachlessStepScript(string stepJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(stepJson);
        return CoachlessStepTemplate.Replace(
            "__COACHLESS_STEP_JSON__", stepJson, StringComparison.Ordinal);
    }

    /// <summary>The Coachless walk's first step: list the slot sections in DOM order.</summary>
    public static string CoachlessInspectScript => BuiltCoachlessInspectScript;

    /// <summary>
    /// The extractor for a site tab, or null for the hosted tab (which is
    /// never scraped). For Coachless this is the walk's opening inspect
    /// step; the sequencer drives the clicks and the final read from the
    /// same import click handler.
    /// </summary>
    public static string? ScriptFor(CompanionTab tab) => tab switch
    {
        CompanionTab.UGg => UGgScript,
        CompanionTab.Coachless => CoachlessInspectScript,
        _ => null,
    };

    /// <summary>
    /// Whether the import button enables for this tab+URL: the active site
    /// tab must be showing that site's BUILD-page shape. The LCU half of the
    /// enablement lives with the caller (it owns the connection state); this
    /// is the URL half, shared so the button and the extractor cannot
    /// disagree about what "a build page" means.
    /// </summary>
    public static bool CanImportFromUrl(CompanionTab tab, string? url)
    {
        if (url is null || !Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        return tab switch
        {
            CompanionTab.UGg => IsUGgBuildUrl(uri),
            CompanionTab.Coachless => IsCoachlessBuildsUrl(uri),
            _ => false,
        };
    }

    /// <summary><c>u.gg/lol/champions/{slug}/build[/{role}]</c>, any role or none.</summary>
    public static bool IsUGgBuildUrl(Uri uri)
    {
        if (uri is null) return false;
        if (!uri.Scheme.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(uri.Host, "u.gg", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Host, "www.u.gg", StringComparison.OrdinalIgnoreCase)) return false;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length >= 4
            && string.Equals(segments[0], "lol", StringComparison.OrdinalIgnoreCase)
            && string.Equals(segments[1], "champions", StringComparison.OrdinalIgnoreCase)
            && segments[2].Length > 0
            && string.Equals(segments[3], "build", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary><c>coachless.gg/builds/{slug}</c> exactly (not <c>/builds/creator</c>).</summary>
    public static bool IsCoachlessBuildsUrl(Uri uri)
    {
        if (uri is null) return false;
        if (!uri.Scheme.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(uri.Host, "coachless.gg", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Host, "www.coachless.gg", StringComparison.OrdinalIgnoreCase)) return false;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 2
            && string.Equals(segments[0], "builds", StringComparison.OrdinalIgnoreCase)
            && segments[1].Length > 0
            && !string.Equals(segments[1], "creator", StringComparison.OrdinalIgnoreCase);
    }
}
