using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// The Desktop side of the user-initiated build import. The window owns the
/// browsers (and is the only place that may run a script against a site
/// tab); this is everything AFTER the script returns: parse the extractor
/// JSON, resolve the champion against the roster, and run the validated
/// payload through the two LCU apply services.
///
/// <para>Contract: input is the raw <c>ExecuteScriptAsync</c> result string
/// (or null when the script returned nothing); output is the status-line
/// message. Failure modes never write: an unparseable scrape, an
/// unresolvable champion, a disconnected client, or invalid runes/items all
/// return a <see cref="SiteImportFailure"/> before the first LCU call —
/// except an LCU write that fails after validation, which reports exactly
/// which half landed (see <see cref="SiteImportApplier"/>).</para>
/// </summary>
public interface ISiteImportHost
{
    /// <summary>Fresh read of the LCU connection, for the click-time re-check.</summary>
    bool IsLcuConnected { get; }

    Task<SiteImportResult> ImportBuildAsync(string? extractorJson, CancellationToken cancellationToken = default);
}

/// <summary>
/// Default <see cref="ISiteImportHost"/>: everything the import needs, and
/// nothing the window should touch directly. Champion resolution folds the
/// scraped slug through the SHARED <see cref="ChampionNameKey"/> (the same
/// fold the deep links use, so <c>monkeyking</c> meets Wukong) and reads the
/// display name off the matched roster entry — never off the page, which
/// carries no trustworthy name.
/// </summary>
public sealed class SiteImportHost : ISiteImportHost
{
    private readonly RuneApplyService _runes;
    private readonly ItemSetApplyService _itemSets;
    private readonly IChampionDirectory _champions;
    private readonly CompanionState? _state;

    public SiteImportHost(
        RuneApplyService runes,
        ItemSetApplyService itemSets,
        IChampionDirectory champions,
        CompanionState? state = null)
    {
        _runes = runes ?? throw new ArgumentNullException(nameof(runes));
        _itemSets = itemSets ?? throw new ArgumentNullException(nameof(itemSets));
        _champions = champions ?? throw new ArgumentNullException(nameof(champions));
        _state = state;
    }

    public bool IsLcuConnected => _state?.ClientConnected ?? false;

    public async Task<SiteImportResult> ImportBuildAsync(
        string? extractorJson,
        CancellationToken cancellationToken = default)
    {
        if (!SiteImportPayload.TryParse(extractorJson, out var payload, out var failure) || payload is null)
            return new SiteImportFailure("bad-scrape", $"{failure} -- nothing was imported");

        var roster = _champions.Cached ?? await _champions.LoadAsync(cancellationToken).ConfigureAwait(false);
        var (championId, _) = ChampionIdLookup.Resolve(roster, payload.ChampionSlug, null);
        var champion = championId is > 0
            ? roster?.FirstOrDefault(entry => entry.Id == championId)
            : null;
        if (championId is not > 0 || champion is null)
            return new SiteImportFailure(
                "unknown-champion",
                $"could not match \"{payload.ChampionSlug}\" to a champion -- nothing was imported");

        // Fresh, not the button-state snapshot: the client may have closed
        // between enablement and click. The message names the fix.
        if (!IsLcuConnected)
            return new SiteImportFailure(
                "no-client",
                "League client not detected -- open the client and try again");

        return await SiteImportApplier.ApplyAsync(
            payload, champion.Name, championId.Value, _runes, _itemSets, cancellationToken).ConfigureAwait(false);
    }
}
