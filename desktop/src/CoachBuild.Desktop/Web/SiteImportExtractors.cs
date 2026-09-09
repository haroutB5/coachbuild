using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// The per-site extractor scripts for the automatic build import.
///
/// <para>Each script is a self-contained IIFE: no external requests, no
/// navigation, one JSON string out. Both item scripts are read-only DOM reads;
/// the shape each returns is exactly what <see cref="SiteImportPayload"/> parses —
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
/// Coachless items script needs no icon tables: item ids read numerically
/// off <c>/img/item/{id}.</c>.</para>
///
/// <para>DOM ANCHORS, derived from the real rendered fixtures captured
/// 2026-09-08 (<c>_research/site-import/ugg-jhin-adc.html</c>,
/// <c>coachless-jhin-adc.html</c> — read the per-site remarks on
/// <see cref="UGgTemplate"/> and <see cref="CoachlessItemsTemplate"/>). The full
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
    /// winrate/matches, rune set, shard set).</para>
    ///
    /// <para>THE RENDERED RANK IS A HINT, NOT THE KEY (2.1.0). Field log
    /// 2026-09-08, Nasus top, twice on a warmed profile: "u.gg yielded no item
    /// build -- ignored", while the runes half read fine — so the page WAS
    /// hydrated and only the items stage came back empty. The rank filter can
    /// read a rank the embedded blob does not carry, and the pre-2.1.0 script
    /// required an exact <c>world_{rendered rank}_{role}</c> hit and otherwise
    /// skipped the whole stage in silence. It now DISCOVERS which rank tokens
    /// the page actually embeds for this role, tries the rendered one first,
    /// and falls back to an embedded one only when there is exactly ONE —
    /// which is the page's only build for that role, not a guess. Several
    /// embedded ranks with none of them the rendered one still refuses. Either
    /// way the payload carries <c>meta.notes</c> naming the stage it reached
    /// (url-recognized / json-found / keys-found / blocks-built) and the tokens
    /// it saw, on success as well as failure, so the next empty yield arrives
    /// with its own diagnosis instead of needing another live pass.</para>
    ///
    /// <para>A ROLELESS URL IS A REAL CASE, NOT A DEAD END (2.1.0 round 2).
    /// Field log 2026-09-08: <c>u.gg items: the URL carried no role, so no
    /// build key could be formed</c> / <c>stage url-recognized (rank
    /// "emerald_plus", role "none", embedded ranks [], 0 blocks)</c>. Champ
    /// select does not always report a role — practice tool, blind pick,
    /// customs — so <see cref="SiteDeepLink.Build"/> builds
    /// <c>/lol/champions/{slug}/build</c> with no role segment, and u.gg then
    /// AUTO-SELECTS the champion's main role and serves that build. The page
    /// therefore knows the role even when the URL does not, and the script now
    /// asks it, in this order:</para>
    /// <list type="number">
    ///   <item>The page's own RENDERED active role tab —
    ///   <c>a.role-filter.active</c>, whose <c>href</c> is
    ///   <c>/lol/champions/{slug}/build/{role}</c> (verified in
    ///   <c>ugg-nasus-top.html</c>, which renders five
    ///   <c>a.role-filter</c> and marks exactly one <c>active</c>).</item>
    ///   <item>Failing that, the roles the page EMBEDS
    ///   (<c>"world_{rank}_{role}"</c>): exactly ONE is the page's only build
    ///   and is not a guess. Several with no rendered tab IS a guess, and is
    ///   refused — the Nasus fixture embeds all five roles, so this is not a
    ///   hypothetical.</item>
    /// </list>
    /// <para>The discovered role is reported in <c>meta.notes</c> WITH the
    /// source that produced it, and is what the payload carries: a Top build
    /// labelled Top is honest, and labelling it roleless would be the lie. The
    /// RUNES half needs no role at all — it reads the rendered panel — which is
    /// why runes came back fine on the very run where items came back empty.
    /// </para>
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
          var urlRole = (page[2] || '').toLowerCase();
          var role = urlRole;
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
          // STAGE, so an empty yield names where it stopped instead of being
          // an unexplained absence: url-recognized -> json-found -> keys-found
          // -> blocks-built. Reported in meta.notes, always, so the line also
          // proves the instrument is alive on the runs that succeed.
          var itemStage = 'url-recognized';
          var notes = [];
          // The embedded blobs, read BEFORE the role is settled: they are also
          // one of the two places a missing role can be discovered from.
          var texts = [];
          var scripts = document.getElementsByTagName('script');
          for (var q = 0; q < scripts.length; q++) {
            var body = scripts[q].textContent || '';
            if (body.indexOf('"world_') >= 0) texts.push(body);
          }
          // ROLE DISCOVERY. A roleless URL is what champ select produces for
          // practice tool / blind / customs, and u.gg answers it by
          // auto-selecting the champion's main role -- so the PAGE knows the
          // role the URL omitted. Ask it, never guess it.
          var roleSource = urlRole ? 'url' : '';
          if (!role) {
            var roleTabs = document.querySelectorAll('a.role-filter.active');
            for (var rt = 0; rt < roleTabs.length && !role; rt++) {
              var rm = String(roleTabs[rt].getAttribute('href') || '')
                .match(/\/build\/([a-z]+)/i);
              if (rm) { role = rm[1].toLowerCase(); roleSource = 'active-role-tab'; }
            }
          }
          var embeddedRoles = [];
          if (!role) {
            // Ranks carry underscores (emerald_plus), roles never do, so the
            // final segment before the closing quote is the role.
            var roleRe = /"world_[a-z0-9_]*?_([a-z]+)"/gi;
            for (var y = 0; y < texts.length; y++) {
              roleRe.lastIndex = 0;
              var rhit;
              while ((rhit = roleRe.exec(texts[y]))) {
                var rtok = rhit[1].toLowerCase();
                if (embeddedRoles.indexOf(rtok) < 0) embeddedRoles.push(rtok);
              }
            }
            if (embeddedRoles.length === 1) {
              // The page's ONLY build for this champion is not a guess.
              role = embeddedRoles[0];
              roleSource = 'only-embedded-role';
            } else if (embeddedRoles.length > 1) {
              notes.push('u.gg items: the URL carried no role, the page rendered no active role tab, and it embeds ' +
                embeddedRoles.length + ' roles (' + embeddedRoles.join(', ') +
                ') -- refused rather than guessed');
            } else {
              notes.push('u.gg items: the URL carried no role and the page embeds no role keys to discover one from');
            }
          }
          if (!urlRole && role) {
            notes.push('u.gg items: the URL carried no role; used the page\'s own "' +
              role + '" (' + roleSource + ')');
          }
          // The rank tokens the page ACTUALLY embeds for this role. The
          // rendered rank filter is a hint, not the key: the page embeds one
          // build per role and the filter can read a rank the embedded blob
          // does not carry (a profile whose stored filter differs from the
          // server-rendered default), which is what silently produced an
          // items-absent payload before 2.1.0.
          var tokens = [];
          if (role) {
            var keyRe = new RegExp('"world_([a-z0-9_]+?)_' + role + '"', 'gi');
            for (var x = 0; x < texts.length; x++) {
              keyRe.lastIndex = 0;
              var hit;
              while ((hit = keyRe.exec(texts[x]))) {
                var tok = hit[1].toLowerCase();
                if (tokens.indexOf(tok) < 0) tokens.push(tok);
              }
            }
          }
          if (texts.length) itemStage = 'json-found';
          var order = [];
          if (rank && role) order.push(rank);
          if (role && tokens.length === 1 && tokens[0] !== rank) {
            // Exactly one embedded rank for this role is not a guess: it is
            // the only build the page has. More than one and none of them the
            // rendered rank IS a guess, so that case refuses below.
            order.push(tokens[0]);
          }
          var build = null;
          var usedKey = '';
          for (var o = 0; o < order.length && !build; o++) {
            var want = '"world_' + order[o] + '_' + role + '"';
            for (var w = 0; w < texts.length && !build; w++) {
              var text = texts[w];
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
            if (build) usedKey = order[o];
          }
          if (build) {
            itemStage = 'keys-found';
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
            if (blocks.length) itemStage = 'blocks-built';
            else notes.push('u.gg items: the embedded build "world_' + usedKey + '_' + role + '" carried no item ids');
            if (usedKey !== rank) {
              notes.push('u.gg items: the rendered rank filter read "' + (rank || 'nothing') +
                '"; used the page\'s only embedded rank "' + usedKey + '"');
            }
          } else if (role) {
            if (!texts.length) {
              notes.push('u.gg items: no script on the page embeds a build blob');
            } else if (!tokens.length) {
              notes.push('u.gg items: the page embeds no "world_{rank}_' + role + '" key at all');
            } else if (!rank) {
              notes.push('u.gg items: no rank filter rendered and the page embeds ' + tokens.length +
                ' ranks for ' + role + ' (' + tokens.join(', ') + ') -- refused rather than guessed');
            } else if (tokens.indexOf(rank) < 0) {
              notes.push('u.gg items: the rendered rank "' + rank + '" has no embedded build and the page embeds ' +
                tokens.length + ' ranks for ' + role + ' (' + tokens.join(', ') + ') -- refused rather than guessed');
            } else {
              notes.push('u.gg items: "world_' + rank + '_' + role +
                '" is present but no occurrence parsed to a build object');
            }
          }
          notes.push('u.gg items: stage ' + itemStage + ' (rank "' + (rank || 'none') +
            '", role "' + (role || 'none') + '" via ' + (roleSource || 'nothing') +
            ', embedded ranks [' + tokens.join(', ') + '], ' + blocks.length + ' blocks)');
          if (!runes && !blocks.length) return fail('no build on page');
          return JSON.stringify({
            source: 'u.gg', championSlug: slug, role: role, runes: runes, itemBlocks: blocks,
            meta: { stage: itemStage, notes: notes }
          });
        })();
        """;

    /// <summary>
    /// Coachless items extractor, for the champion builds overview
    /// (<c>coachless.gg/builds/{slug}?role={role}</c>).
    ///
    /// <para>The page sorts each slot table by WPA. This performs exactly one
    /// read of the initial page and takes the first <c>tr.data-row</c> from
    /// Starter, 1st, Boots, 2nd, 3rd and 4th+ in that exported order. It
    /// dispatches no clicks and waits for no recomputation. If the top-WPA
    /// row repeats an item already emitted by an earlier slot, the next row
    /// is scanned until a non-duplicate item is found.</para>
    ///
    /// <para>Boots are intentionally exported immediately after the first
    /// item. The page renders the Boots table later, but the client build
    /// should put boots after slot 1.</para>
    ///
    /// <para>AN EMPTY SLOT DEGRADES, IT DOES NOT ABORT (2.1.0). Field log
    /// 2026-09-08, Nasus top, on a run where the consent wall HAD been
    /// dismissed successfully: <c>Coachless extraction failed (slot "Starter"
    /// yielded no items)</c>. Five other slots had read fine and all five were
    /// discarded, because any per-slot absence — missing section, no rows, no
    /// readable item icon — returned <c>{ error }</c> for the whole page. Each
    /// of those three now records a <c>meta.notes</c> line (the icon case also
    /// reports the row's img/item-icon/hidden counts, which is what tells "the
    /// page has nothing here" apart from "the page hid its own icons") and
    /// OMITS that block. Only a page where no slot at all yields items is
    /// still a typed failure, and that one names every slot it tried.</para>
    ///
    /// <para>RUNES ARE NOT ON THIS PAGE. The overview renders
    /// keystone options and zero minor runes or shards, so no complete rune
    /// page can be read here. The final payload carries <c>runes: null</c>
    /// and C# applies the item set on its own, reporting the missing half
    /// in the status line ("no rune page on this site") — an honest
    /// items-only import, not a guess.</para>
    ///
    /// <para>Item ids read numerically off the row's <c>clr-item-icon
    /// img</c> (<c>/img/item/{id}.webp</c>), skipping icons the page hid
    /// itself (<c>onerror="this.style.display='none'"</c>).</para>
    ///
    /// <para>THE READ SETTLES, IT IS NOT ONE SHOT (2.2.2). Field log
    /// 2026-09-09 13:11:17, Viktor mid: <c>Coachless extraction failed (every
    /// item slot on the page was empty (0 tables on the page, 0 with a slot
    /// title, 0 data rows))</c> — zero TABLES, on a page that renders six. The
    /// read fired at NavigationCompleted and Coachless is an Angular SPA that
    /// paints seconds later; the RUNES leg succeeded in the same run because it
    /// kept its settle probe (<c>settled ... over 4 reads in 1200ms</c>). So
    /// the whole-page emptiness now carries <c>retryable: true</c> — the same
    /// marker <see cref="RunesSettleProbe"/> reads — and the caller re-reads
    /// until a titled slot table has rows or the settle window closes. A page
    /// that HAS rendered rows but yields no items is NOT retryable: waiting
    /// cannot change it, and the typed census stands immediately.</para>
    /// </summary>
    public const string CoachlessItemsTemplate = """
        (function () {
          function fail(message) { return JSON.stringify({ error: message }); }
          // Same envelope the runes read has used since 2.1.0: an absence the
          // caller should re-read rather than believe. The LAST read is what
          // gets reported, so a genuinely empty page still fails with this
          // very census -- just after the settle window instead of before it.
          function failWait(message) { return JSON.stringify({ error: message, retryable: true }); }
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
          function hasClass(row, name) {
            var cls = row.classList;
            if (cls && cls.contains && cls.contains(name)) return true;
            return (' ' + String(row.className || '') + ' ').indexOf(' ' + name + ' ') >= 0;
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
          // What the WHOLE PAGE carried, whether or not any slot table was
          // recognized. Discovery's only failure mode is "zero titled slot
          // tables", and until 2.1.1 that reported the bare words "no build on
          // page" -- field log 2026-09-08 22:37:54, a worker fetch, with no
          // way to tell a consent/challenge shell (no tables at all) from a
          // rendered page whose <th class="entry-name title"> shape moved
          // (tables present, none titled) from a page still hydrating (tables
          // and titles present, no rows). Same degrade-with-a-census shape the
          // slot reads and the runes rows already use.
          // How many data rows the page has actually painted across every
          // titled slot table. Zero is the SPA's pre-hydration signature and
          // the one thing waiting can fix; the census reports it either way.
          function renderedRows() {
            var titled = slotTables();
            var rows = 0;
            for (var t = 0; t < titled.length; t++) rows += dataRows(titled[t].table).length;
            return rows;
          }
          function pageCensus() {
            var all = document.getElementsByTagName('table');
            var titled = slotTables();
            var rows = renderedRows();
            var titles = [];
            for (var n = 0; n < titled.length && n < 8; n++) titles.push(titled[n].title);
            return all.length + ' tables on the page, ' + titled.length +
              ' with a slot title' + (titles.length ? ' [' + titles.join(', ') + ']' : '') +
              ', ' + rows + ' data rows';
          }
          var href = String((typeof location !== 'undefined' && location.href) || '');
          var page = href.match(/coachless\.gg\/builds\/([a-z0-9]+)/i);
          if (!page) return fail('not a champion builds page');
          var slug = page[1].toLowerCase();
          var role = '';
          var qm = href.match(/[?&]role=([a-z]+)/i);
          if (qm) role = qm[1].toLowerCase();
          var notes = [];
          // Roleless champ select is resolved from the same kind of source as
          // u.gg: the site's rendered active role, never the first button or
          // an invented default. Coachless marks its active role button and
          // the icon URL names the token (role_adc_teal.png, etc.).
          if (!role) {
            var roleSelectors = document.getElementsByTagName('cl-role-selection');
            for (var rs = 0; rs < roleSelectors.length && !role; rs++) {
              var buttons = roleSelectors[rs].getElementsByTagName('button');
              for (var rb = 0; rb < buttons.length && !role; rb++) {
                if (!hasClass(buttons[rb], 'active')) continue;
                var roleImgs = buttons[rb].getElementsByTagName('img');
                for (var ri = 0; ri < roleImgs.length && !role; ri++) {
                  var roleMatch = String(roleImgs[ri].getAttribute('src') || '')
                    .match(/\/role_(top|jungle|mid|adc|support)(?:_teal)?\./i);
                  if (roleMatch) role = roleMatch[1].toLowerCase();
                }
              }
            }
            if (role)
              notes.push('coachless: the URL carried no role; used the page\'s active role "' + role + '"');
            else
              notes.push('coachless: the URL carried no role and the page rendered no active role');
          }
            var SLOT_ORDER = ['Starter', '1st Item', 'Boots', '2nd Item', '3rd Item', '4th+ Item'];
            var looked = slotTables();
            var blocks = [];
            var usedItemIds = [];
            for (var b = 0; b < SLOT_ORDER.length; b++) {
              var entry = null;
              for (var e = 0; e < looked.length; e++) {
                if (looked[e].title === SLOT_ORDER[b]) { entry = looked[e]; break; }
              }
              // ONE EMPTY SLOT IS NOT A FAILED IMPORT (2.1.0). Field log
              // 2026-09-08, Nasus top, AFTER the consent wall was dismissed
              // successfully: 'Coachless extraction failed (slot "Starter"
              // yielded no items)'. Five other slots had read fine and every
              // one of them was thrown away, because a per-slot absence
              // aborted the whole read. A slot the page cannot fill is now a
              // meta note and an omitted block; only a page that fills NO
              // slot at all is still a typed failure.
              if (!entry) {
                notes.push('coachless: slot "' + SLOT_ORDER[b] + '" is not on the page -- omitted');
                continue;
              }
              var cand = dataRows(entry.table);
              if (!cand.length) {
                notes.push('coachless: slot "' + SLOT_ORDER[b] + '" has no rows -- omitted');
                continue;
              }
              var row = null;
              var ids = [];
              // Rows are already ordered by WPA. Keep that order, but skip a
              // row whose item was emitted by an earlier slot. This is a
              // Coachless-only constraint: one item must not occupy multiple
              // item-set slots merely because the site ranks it highly.
              for (var c = 0; c < cand.length; c++) {
                var candidateIds = itemIds(cand[c]);
                var duplicate = false;
                for (var ci = 0; ci < candidateIds.length; ci++) {
                  if (usedItemIds.indexOf(candidateIds[ci]) >= 0) {
                    duplicate = true;
                    break;
                  }
                }
                if (!candidateIds.length || duplicate) continue;
                row = cand[c];
                ids = candidateIds;
                break;
              }
              if (!row || !ids.length) {
                // Name what the rows DID carry, so the next live pass does
                // not need another capture to tell "no icon at all" apart
                // from "icons the page hid itself" (its own onerror
                // handler), or an all-duplicate slot.
                var hidden = 0;
                var itemish = 0;
                for (var ci2 = 0; ci2 < cand.length; ci2++) {
                  var all = cand[ci2].getElementsByTagName('img');
                  for (var v = 0; v < all.length; v++) {
                    if (all[v].style && all[v].style.display === 'none') hidden++;
                    if (String(all[v].getAttribute('src') || '').indexOf('/img/item/') >= 0) itemish++;
                  }
                }
                notes.push('coachless: slot "' + SLOT_ORDER[b] + '" yielded no items -- omitted (' +
                  cand.length + ' rows, candidates have ' + itemish +
                  ' item-icon, ' + hidden + ' hidden)');
                continue;
              }
              for (var used = 0; used < ids.length; used++) usedItemIds.push(ids[used]);
              blocks.push({ title: SLOT_ORDER[b], itemIds: ids });
            }
            // Deliberately NOT the words "no build": preserve the per-slot
            // detail this branch carries into the log.
          if (!blocks.length) {
            var barren = 'every item slot on the page was empty (' + pageCensus() + ') -- ' +
              notes.join('; ').slice(0, 240);
            // Rows on the page mean the page rendered and simply has nothing
            // we can read: a verdict. No rows mean it has not rendered yet.
            return renderedRows() > 0 ? fail(barren) : failWait(barren);
          }
          return JSON.stringify({
            source: 'coachless', championSlug: slug, role: role, runes: null,
            itemBlocks: blocks, meta: { notes: notes }
          });
        })();
        """;

    /// <summary>
    /// The Coachless RUNES page extractor
    /// (<c>coachless.gg/runes/tree/{slug}/{primary}/{secondary}?role={role}</c>).
    ///
    /// <para>WHY A SECOND PAGE. The builds overview
    /// (<see cref="CoachlessItemsTemplate"/>) renders keystone OPTIONS and zero
    /// minor runes or shards, so it can never yield a full rune page — the
    /// items read has always imported items only and reported "no rune page on this
    /// site". Coachless ranks the rest of the tree on a dedicated Runes page,
    /// and this script reads it. Read-only: no click, no navigation, one JSON
    /// string out.</para>
    ///
    /// <para>THE URL SNAPS. The path carries a tree pair, but the site
    /// redirects any valid pair to the one it recommends: the 2026-09-08
    /// browser capture asked for <c>/runes/tree/nasus/precision/domination</c>
    /// and landed on <c>/runes/tree/nasus/precision/resolve</c>. So the deep
    /// link's pair (<see cref="SiteDeepLink.RunesProbePrimary"/>) is a probe,
    /// and this script derives BOTH tree ids from the rendered perk icons'
    /// own <c>/perk-images/Styles/{Tree}/…</c> segment — never from the URL,
    /// which may name the pair that was asked for rather than the one shown.
    /// </para>
    ///
    /// <para>DOM ANCHORS, read off the rendered fixture
    /// <c>_research/site-import/coachless-nasus-runes.html</c> (captured
    /// 2026-09-08 by the browser harness, 360KB, Angular-rendered). The page
    /// has NO tables — the builds overview's <c>th.entry-name.title</c> probe
    /// returns nothing here — and instead groups
    /// <c>cl-rune-card</c> elements into one container PER SLOT ROW, which is
    /// what makes this readable without chunking by threes:</para>
    /// <list type="bullet">
    ///   <item><c>.primary-runes .keystone-selector</c> — one container, the
    ///   tree's keystones (4 for Precision in the fixture).</item>
    ///   <item><c>.primary-runes .secondary-selector</c> — THREE containers,
    ///   the three primary minor rows, 3 cards each
    ///   ([AbsorbLife, Triumph, PresenceOfMind] /
    ///   [LegendAlacrity, LegendHaste, LegendBloodline] /
    ///   [CoupDeGrace, CutDown, LastStand]).</item>
    ///   <item><c>.secondary-runes .secondary-selector</c> — three more, the
    ///   secondary tree's rows (Resolve, in the fixture).</item>
    ///   <item><c>.modifier-shards .shard-selector</c> — three containers,
    ///   the Offense/Flex/Defense shard rows in that DOM order.</item>
    /// </list>
    ///
    /// <para>Per card: the rune's identity comes off <c>.rune-icon img</c>'s
    /// filename stem through the injected <see cref="PerkIconMap"/> (the same
    /// fold u.gg uses — Coachless serves ddragon's own perk filenames), and a
    /// shard's off <c>cl-rune-shard-icon img</c> through
    /// <see cref="ShardIconMap.ToCoachlessJson"/> (Coachless serves its OWN
    /// short stat icons, <c>as</c>/<c>ah</c>/<c>ms</c>/<c>health</c>, hence
    /// the alias table). The ranking number is <c>.rune-delta</c>'s first
    /// span — the WPA delta, e.g. <c>+0.59</c> — and the sample size is
    /// <c>.rune-matchcount</c>. Cards the site has no data for render
    /// <c>is-empty</c> with a literal <c>-.--</c> delta and are skipped.</para>
    ///
    /// <para>THE PICK: Coachless marks low-sample cards with
    /// <c>is-low-occurrence</c>. Exclude those dark cards first, then take the
    /// top-WPA keystone, the top-WPA rune of each of the three primary rows,
    /// the top-WPA rune in each secondary row and the best TWO secondary rows
    /// (the client takes two secondaries from two different rows), and the
    /// top-WPA shard of each shard row. Ties keep the earlier card, which is
    /// the site's own order. This keeps high-sample/light choices such as
    /// Galio's Celerity instead of a higher-WPA low-sample alternative.</para>
    ///
    /// <para>PARTIAL IS A TYPED FAILURE, NOT A GUESS. A full rune page is all
    /// or nothing at the client, so any missing part — an unreadable tree, a
    /// row whose cards all lack data, fewer than two usable secondary rows —
    /// returns <c>{ error }</c> naming that part, and C# reports it and
    /// writes nothing. <c>itemBlocks</c> is always empty here: this page has
    /// no items, and the builds-page read owns those.</para>
    ///
    /// <para>BUT AN ABSENT NUMBER IS NOT YET AN ANSWER (2.1.0 round 2). Field
    /// log 2026-09-08: <c>no keystone on the runes page carried a WPA
    /// reading</c> live, while <c>coachless-nasus-runes.html</c> — a capture of
    /// that same page — yields the full page. The difference is time: the
    /// Angular view paints its rune cards before the WPA deltas arrive, so a
    /// read at first paint sees cards with no readings. Every WPA-absent and
    /// row-count failure therefore carries <c>retryable: true</c>, and
    /// <see cref="RunesSettleProbe"/> tells C# to poll the page again rather
    /// than report the first paint as the verdict. The message that survives a
    /// timed-out settle carries the row's CENSUS — how many cards rendered, how
    /// many had a readable id, how many had a reading — so "the page has
    /// nothing here" is distinguishable from "the numbers never arrived"
    /// without another live pass.</para>
    /// </summary>
    public const string CoachlessRunesTemplate = """
        (function () {
          function fail(message) { return JSON.stringify({ error: message }); }
          // A failure the page may still grow out of: the Angular view renders
          // its cards before the WPA numbers arrive, so "no reading yet" and
          // "no reading, ever" are the same DOM one paint apart. Marked so C#
          // (FetchCoachlessRunesOnUiAsync) settle-polls instead of reporting a
          // first-paint read as the answer -- field log 2026-09-08, "no
          // keystone on the runes page carried a WPA reading" live while the
          // captured fixture of the SAME page yields a full page.
          function failWait(message) { return JSON.stringify({ error: message, retryable: true }); }
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
          function lookup(map, folded) {
            var id = map[folded];
            return (typeof id === 'number' && id > 0 && Math.floor(id) === id) ? id : 0;
          }
          function perkId(src) { return lookup(PERK_MAP, norm(stemOf(src))); }
          function shardId(src) {
            var folded = norm(stemOf(src));
            if (folded.indexOf('statmods') === 0) folded = folded.slice(8);
            if (folded.slice(-4) === 'icon') folded = folded.slice(0, -4);
            return lookup(SHARD_MAP, folded) || lookup(SHARD_MAP, norm(stemOf(src)));
          }
          var PERK_MAP = __PERK_MAP_JSON__;
          var SHARD_MAP = __SHARD_MAP_JSON__;
          var TREE_MAP = __TREE_MAP_JSON__;

          var href = String((typeof location !== 'undefined' && location.href) || '');
          var page = href.match(/coachless\.gg\/runes\/tree\/([a-z0-9]+)/i);
          if (!page) return fail('not a champion runes page');
          var slug = page[1].toLowerCase();
          var role = '';
          var roleMatch = href.match(/[?&]role=([a-z]+)/i);
          if (roleMatch) role = roleMatch[1].toLowerCase();

          function hasClass(el, name) {
            if (!el) return false;
            var cls = el.classList;
            if (cls && cls.contains && cls.contains(name)) return true;
            return (' ' + String(el.className || '') + ' ').indexOf(' ' + name + ' ') >= 0;
          }
          if (!role) {
            var roleSelectors = document.getElementsByTagName('cl-role-selection');
            for (var rs = 0; rs < roleSelectors.length && !role; rs++) {
              var buttons = roleSelectors[rs].getElementsByTagName('button');
              for (var rb = 0; rb < buttons.length && !role; rb++) {
                if (!hasClass(buttons[rb], 'active')) continue;
                var roleImgs = buttons[rb].getElementsByTagName('img');
                for (var ri = 0; ri < roleImgs.length && !role; ri++) {
                  var activeRole = String(roleImgs[ri].getAttribute('src') || '')
                    .match(/\/role_(top|jungle|mid|adc|support)(?:_teal)?\./i);
                  if (activeRole) role = activeRole[1].toLowerCase();
                }
              }
            }
          }
          function rowsUnder(hostSelector, rowClass) {
            var host = document.querySelector(hostSelector);
            if (!host) return [];
            var found = host.querySelectorAll('.' + rowClass);
            var out = [];
            for (var i = 0; i < found.length; i++) {
              var cards = found[i].getElementsByTagName('cl-rune-card');
              if (cards.length) out.push(cards);
            }
            return out;
          }
          function iconSrc(card, tagName) {
            var hosts = card.getElementsByTagName(tagName);
            for (var h = 0; h < hosts.length; h++) {
              var images = hosts[h].getElementsByTagName('img');
              if (images.length) return String(images[0].getAttribute('src') || '');
            }
            var any = card.getElementsByTagName('img');
            return any.length ? String(any[0].getAttribute('src') || '') : '';
          }
          function deltaOf(card) {
            // The site prints "-.--" for a card it has no sample for, and
            // marks those is-empty. Both are "no reading", never a zero.
            if (hasClass(card, 'is-empty')) return null;
            var holder = card.querySelector('.rune-delta');
            if (!holder) return null;
            var span = holder.getElementsByTagName('span')[0];
            var text = span ? String(span.textContent || '') : '';
            var m = text.replace(/\s+/g, '').match(/^([+-]?\d+(?:\.\d+)?)$/);
            if (!m) return null;
            var value = parseFloat(m[1]);
            return isFinite(value) ? value : null;
          }
          // Top WPA of one row after removing low-occurrence cards. Returns
          // { id, delta } or null when no eligible card carries both a
          // readable id and a reading.
          function bestOf(cards, iconTag, resolveId) {
            var best = null;
            for (var i = 0; i < cards.length; i++) {
              // The light cards are the site's high-sample choices. A dark
              // is-low-occurrence card can have a tempting WPA from a tiny
              // sample, so it must never win this selection.
              if (hasClass(cards[i], 'is-low-occurrence')) continue;
              var delta = deltaOf(cards[i]);
              if (delta === null) continue;
              var id = resolveId(iconSrc(cards[i], iconTag));
              if (!id) continue;
              // Strictly greater keeps the site's own order on a tie.
              if (best === null || delta > best.delta) best = { id: id, delta: delta };
            }
            return best;
          }
          // What a row DID carry, so a timed-out settle names how many cards
          // rendered against how many carried a reading -- the same
          // degrade-with-a-census shape the item slots use.
          function census(cards, iconTag, resolveId) {
            var total = cards ? cards.length : 0, ids = 0, wpa = 0, light = 0;
            for (var i = 0; i < total; i++) {
              var id = resolveId(iconSrc(cards[i], iconTag));
              var delta = deltaOf(cards[i]);
              if (id) ids++;
              if (delta !== null) wpa++;
              if (!hasClass(cards[i], 'is-low-occurrence') && id && delta !== null) light++;
            }
            return total + ' cards rendered, ' + ids + ' with a readable id, ' +
              wpa + ' with a WPA reading, ' + light + ' light eligible';
          }
          function treeOf(cards) {
            for (var i = 0; i < cards.length; i++) {
              var m = iconSrc(cards[i], 'clr-rune-icon')
                .match(/\/perk-images\/Styles\/([A-Za-z]+)\//);
              if (m) {
                var id = lookup(TREE_MAP, norm(m[1]));
                if (id) return id;
              }
            }
            return 0;
          }

          // Every absence below is retryable: on a page still hydrating, the
          // rows appear before the numbers do, so a first-paint read must
          // settle-poll rather than report.
          var keystoneRows = rowsUnder('.primary-runes', 'keystone-selector');
          if (!keystoneRows.length) return failWait('the runes page showed no keystone row');
          var primaryRows = rowsUnder('.primary-runes', 'secondary-selector');
          if (primaryRows.length !== 3)
            return failWait('the runes page showed ' + primaryRows.length + ' primary rune rows, not 3');
          var secondaryRows = rowsUnder('.secondary-runes', 'secondary-selector');
          if (secondaryRows.length !== 3)
            return failWait('the runes page showed ' + secondaryRows.length + ' secondary rune rows, not 3');
          var shardRows = rowsUnder('.modifier-shards', 'shard-selector');
          if (shardRows.length !== 3)
            return failWait('the runes page showed ' + shardRows.length + ' shard rows, not 3');

          var primaryStyleId = treeOf(keystoneRows[0]);
          if (!primaryStyleId) return failWait('the runes page did not name its primary tree');
          var subStyleId = treeOf(secondaryRows[0]);
          if (!subStyleId) return failWait('the runes page did not name its secondary tree');

          var keystone = bestOf(keystoneRows[0], 'clr-rune-icon', perkId);
          if (!keystone)
            return failWait('no keystone on the runes page carried a WPA reading (' +
              census(keystoneRows[0], 'clr-rune-icon', perkId) + ')');

          var perkIds = [keystone.id];
          for (var r = 0; r < 3; r++) {
            var pick = bestOf(primaryRows[r], 'clr-rune-icon', perkId);
            if (!pick)
              return failWait('primary rune row ' + (r + 1) + ' carried no WPA reading (' +
                census(primaryRows[r], 'clr-rune-icon', perkId) + ')');
            perkIds.push(pick.id);
          }

          // The client takes TWO secondaries, from two different rows. Rank
          // the rows by their own winner, keep the best two, and emit them in
          // row order so the page reads the way the client draws it.
          var ranked = [];
          for (var s = 0; s < 3; s++) {
            var top = bestOf(secondaryRows[s], 'clr-rune-icon', perkId);
            if (top) ranked.push({ row: s, id: top.id, delta: top.delta });
          }
          if (ranked.length < 2)
            return failWait('only ' + ranked.length + ' secondary rune rows carried a WPA reading, need 2 (' +
              census(secondaryRows[0], 'clr-rune-icon', perkId) + ' in row 1)');
          ranked.sort(function (a, b) { return b.delta - a.delta || a.row - b.row; });
          var chosen = [ranked[0], ranked[1]];
          chosen.sort(function (a, b) { return a.row - b.row; });
          perkIds.push(chosen[0].id, chosen[1].id);

          var shardIds = [];
          for (var d = 0; d < 3; d++) {
            var shard = bestOf(shardRows[d], 'cl-rune-shard-icon', shardId);
            if (!shard)
              return failWait('shard row ' + (d + 1) + ' carried no WPA reading (' +
                census(shardRows[d], 'cl-rune-shard-icon', shardId) + ')');
            shardIds.push(shard.id);
          }

          return JSON.stringify({
            source: 'coachless',
            championSlug: slug,
            role: role,
            runes: {
              primaryStyleId: primaryStyleId,
              subStyleId: subStyleId,
              perkIds: perkIds,
              shardIds: shardIds
            },
            itemBlocks: []
          });
        })();
        """;

    /// <summary>
    /// The consent-wall step: dismiss a RECOGNIZED TCF consent dialog, once,
    /// at the start of an import.
    ///
    /// <para>WHY IT EXISTS. Field log 2026-09-08 17:48:15 —
    /// <c>auto-import: Coachless extraction failed (no build on page)</c>. A
    /// hidden worker's first-ever load of either site hits the consent modal,
    /// which is what the slot tables sit behind, so the read discovers zero
    /// slots and reports an honest but useless no-build. The user asked for
    /// this import; clicking the dialog they would have clicked is part of
    /// that one sanctioned interaction, and nothing else about the read-only
    /// rule moves.</para>
    ///
    /// <para>ANCHORS, off the same 2026-09-08 fixtures the extractors use, so
    /// this recognizes exactly two CONSENT FRAMEWORKS and nothing else. They
    /// are keyed by framework rather than by site deliberately: a site's choice
    /// of CMP is not the app's to know, and calling a wall by the site it was
    /// first captured on is how a log line ends up claiming "coachless" while
    /// standing on op.gg.</para>
    /// <list type="bullet">
    ///   <item><b>Quantcast Choice</b> — <c>#qc-cmp2-container</c> holding
    ///   <c>button#accept-btn</c> (label "AGREE", beside MORE OPTIONS and
    ///   DISAGREE), see <c>coachless-jhin-adc.html</c>. op.gg runs this SAME
    ///   wall: the modal in <c>_evidence/live-2.1.0/02-mystats-tab.png</c> is
    ///   the Coachless fixture's dialog word for word — "We value your
    ///   privacy", the IABGPP_HDR_GppString sentence, and the same three
    ///   buttons — which is why MyStats needed no new selector, only a call
    ///   site.</item>
    ///   <item><b>Google Funding Choices</b> — <c>.fc-consent-root</c> holding
    ///   <c>button.fc-cta-consent</c> (aria-label "Consent", beside "Do not
    ///   consent" and "Manage options"), see <c>ugg-jhin-adc.html</c>. A
    ///   DIFFERENT wall with different wording, which is the control that keeps
    ///   the two entries from collapsing into one guess.</item>
    /// </list>
    ///
    /// <para>It clicks the ACCEPT control specifically, never a
    /// "reject"/"more options" sibling, and never a button it merely guessed
    /// at by text: an unrecognized wall stays up and the import fails
    /// honestly, which is the same outcome as before this existed. Returns
    /// <c>{ dismissed, reason }</c> — <c>dismissed:false</c> with
    /// <c>reason:"none"</c> is the ordinary case on every load after the
    /// first.</para>
    /// </summary>
    public const string ConsentDismissTemplate = """
        (function () {
          function done(dismissed, reason) {
            return JSON.stringify({ dismissed: !!dismissed, reason: reason });
          }
          function shown(el) {
            if (!el) return false;
            if (typeof el.offsetParent !== 'undefined' && el.offsetParent === null) {
              // offsetParent is null for position:fixed too, which every one
              // of these overlays is -- fall back to the box.
              if (!el.getClientRects || !el.getClientRects().length) return false;
            }
            return true;
          }
          // Keyed by FRAMEWORK, not by site: op.gg and Coachless both run
          // Quantcast Choice, so a reason naming a site would be wrong on one
          // of them. The site is named separately by the caller's log line.
          var WALLS = [
            { framework: 'quantcast-choice', root: '#qc-cmp2-container', accept: '#accept-btn' },
            { framework: 'google-funding-choices', root: '.fc-consent-root', accept: 'button.fc-cta-consent' }
          ];
          // An already-accepted profile often keeps the consent SHELL in the
          // DOM with its buttons torn out. That is not a wall, so it must not
          // stop the scan -- note it and keep looking, or a leftover shell on
          // one site would mask the other's live dialog.
          var seen = 'none';
          for (var i = 0; i < WALLS.length; i++) {
            var root = document.querySelector(WALLS[i].root);
            if (!root || !shown(root)) continue;
            var accept = root.querySelector(WALLS[i].accept);
            if (!accept) { seen = 'wall-without-accept'; continue; }
            if (!shown(accept)) { seen = 'accept-hidden'; continue; }
            if (typeof MouseEvent === 'function') {
              accept.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            } else if (accept.click) {
              accept.click();
            }
            return done(true, WALLS[i].framework);
          }
          return done(false, seen);
        })();
        """;

    private static readonly string BuiltUGgScript = UGgTemplate
        .Replace("__PERK_MAP_JSON__", PerkIconMap.ToJson(), StringComparison.Ordinal)
        .Replace("__SHARD_MAP_JSON__", ShardIconMap.ToJson(), StringComparison.Ordinal);

    private static readonly string BuiltCoachlessRunesScript = CoachlessRunesTemplate
        .Replace("__PERK_MAP_JSON__", PerkIconMap.ToJson(), StringComparison.Ordinal)
        .Replace("__SHARD_MAP_JSON__", ShardIconMap.ToCoachlessJson(), StringComparison.Ordinal)
        .Replace("__TREE_MAP_JSON__", PerkTreeNames.ToJson(), StringComparison.Ordinal);

    /// <summary>The runnable u.gg extractor: template with both icon tables injected.</summary>
    public static string UGgScript => BuiltUGgScript;

    /// <summary>The runnable Coachless runes-page extractor, with all three tables injected.</summary>
    public static string CoachlessRunesScript => BuiltCoachlessRunesScript;

    /// <summary>The runnable consent-dismiss step. No tables to inject.</summary>
    public static string ConsentDismissScript => ConsentDismissTemplate;

    /// <summary>The runnable one-shot Coachless items extractor.</summary>
    public static string CoachlessItemsScript => CoachlessItemsTemplate;

    /// <summary>
    /// The extractor for a site tab, or null for the hosted tab (which is
    /// never scraped). Both site scripts perform one read and no interaction.
    /// </summary>
    public static string? ScriptFor(CompanionTab tab) => tab switch
    {
        CompanionTab.UGg => UGgScript,
        CompanionTab.Coachless => CoachlessItemsScript,
        _ => null,
    };

    /// <summary>
    /// Whether a tab is showing that site's build-page shape.
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

    /// <summary>
    /// <c>coachless.gg/runes/tree/{slug}/{primary}/{secondary}</c> — the
    /// per-slot WPA runes page. The tree pair is accepted as rendered, not as
    /// requested: the site redirects a probe pair to its own recommendation,
    /// so pinning the pair here would refuse the page we actually landed on.
    /// </summary>
    public static bool IsCoachlessRunesUrl(Uri uri)
    {
        if (uri is null) return false;
        if (!uri.Scheme.StartsWith("http", StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(uri.Host, "coachless.gg", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Host, "www.coachless.gg", StringComparison.OrdinalIgnoreCase)) return false;
        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 5
            && string.Equals(segments[0], "runes", StringComparison.OrdinalIgnoreCase)
            && string.Equals(segments[1], "tree", StringComparison.OrdinalIgnoreCase)
            && segments[2].Length > 0
            && PerkTreeNames.Resolve(segments[3]) > 0
            && PerkTreeNames.Resolve(segments[4]) > 0;
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
