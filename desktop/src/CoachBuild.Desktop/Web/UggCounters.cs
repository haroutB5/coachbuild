using System.Text.Json;
using System.Text.RegularExpressions;

namespace CoachBuild.Desktop.Web;

/// <summary>Only the app's local Draft page may request this fixed u.gg page.</summary>
public static class UggCounters
{
    public static Uri? BuildUrl(string? slug, string? lane)
    {
        if (slug is null || !Regex.IsMatch(slug, "^[a-z0-9]{1,40}$") ||
            lane is not ("top" or "jungle" or "mid" or "adc" or "support")) return null;
        return new Uri($"https://u.gg/lol/champions/{slug}/counter?role={lane}&rank=emerald_plus&region=world");
    }

    // Read the site's own parsed SSR cache, not arbitrary script execution.
    // This bucket is the exact input to u.gg's CountersContainer. Its WR and
    // gold values are page-perspective; the frontend applies the site's flip.
    public static string Script(int enemy, string lane) => """
        (() => {
          const script = document.getElementById('reactn-preloaded-state');
          if (!script) return null;
          const text = script.textContent || '';
          const marker = 'window.__SSR_DATA__ = ';
          const start = text.indexOf(marker);
          const end = text.indexOf('window.__APOLLO_STATE__', start);
          if (start < 0 || end < 0) return null;
          try {
            const state = JSON.parse(text.slice(start + marker.length, end).trim().replace(/;$/, ''));
            const entries = Object.entries(state).filter(([url]) =>
              url.startsWith('https://stats2.u.gg/lol/') &&
              url.includes('/matchups/') && url.includes('/ranked_solo_5x5/__ENEMY__/'));
            if (entries.length !== 1) return null;
            const [url, entry] = entries[0];
            const bucket = entry.data?.['world_emerald_plus_' + __LANE__];
            if (!bucket || !Array.isArray(bucket.counters)) return null;
            const patch = document.title.match(/Patch\s+(\d+\.\d+)/i);
            if (!patch) return null;
            return { patch: patch[1],
              rows: bucket.counters.map(r => ({ champion_id: r.champion_id,
                win_rate: r.win_rate, gold_adv_15: r.gold_adv_15,
                matches: r.matches, pick_rate: r.pick_rate })) };
          } catch { return null; }
        })()
        """.Replace("__ENEMY__", enemy.ToString(System.Globalization.CultureInfo.InvariantCulture))
        .Replace("__LANE__", JsonSerializer.Serialize(lane));
}
