using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>The four destinations the companion window can show.</summary>
public enum CompanionTab
{
    /// <summary>The shipped local Draft page. The only tab with a session token.</summary>
    Companion,
    UGg,
    Coachless,
    OpGg,
}

/// <summary>
/// A third-party site the window renders for the user to READ.
///
/// <para><b>Read-mostly, with sanctioned import automation.</b> Nothing in this
/// app scrapes these sites on a timer or navigates them speculatively — and
/// <c>SiteTabComplianceTests</c> still pins that a script reaches a site tab
/// only as a visible auto-import extract, worker fetch, consent dismissal or
/// Coachless rune-page read. Automated navigation is confined to the known
/// build/runes URL shapes the app's own deep-link builders produce
/// (<see cref="SiteDeepLink"/>), triggered by champ-select context or the
/// user's own browsing — never the visible tab, never a focus steal. That
/// is the reason <see cref="SiteTabView"/> has no
/// <c>ExecuteScriptAsync</c> call while the companion host does (it reads
/// its OWN page's version meta tag). A test pins that asymmetry, because
/// "we only render it" is a claim about code that has to stay true after
/// someone adds a feature.</para>
/// </summary>
public sealed record SiteDefinition(
    CompanionTab Tab,
    string Key,
    string Label,
    Uri Home)
{
    /// <summary>The deep link for a champion+role, or null when this site cannot address one.</summary>
    public Uri? BuildUrl(string? championKey, int? roleId) =>
        SiteDeepLink.Build(Tab, championKey, roleId);

    /// <summary>The host used for the site's first party pages.</summary>
    public string Host => Home.Host;
}

public static class CompanionTabs
{
    public const string CompanionLabel = "Draft";

    public static readonly SiteDefinition UGg = new(
        CompanionTab.UGg,
        "ugg",
        "u.gg",
        new Uri("https://u.gg/", UriKind.Absolute));

    public static readonly SiteDefinition Coachless = new(
        CompanionTab.Coachless,
        "coachless",
        "Coachless",
        new Uri("https://coachless.gg/", UriKind.Absolute));

    public static readonly SiteDefinition OpGg = new(
        CompanionTab.OpGg,
        "opgg",
        "MyStats",
        new Uri("https://op.gg/", UriKind.Absolute));

    public static IReadOnlyList<SiteDefinition> Sites { get; } = [UGg, Coachless, OpGg];

    /// <summary>Sites that accept champion+role links and participate in build import.</summary>
    public static IReadOnlyList<SiteDefinition> BuildSites { get; } = [UGg, Coachless];

    /// <summary>The tab order the strip renders, left to right. Companion is always first.</summary>
    public static IReadOnlyList<CompanionTab> Order { get; } =
        [CompanionTab.Companion, CompanionTab.UGg, CompanionTab.Coachless, CompanionTab.OpGg];

    public static SiteDefinition? SiteFor(CompanionTab tab) => tab switch
    {
        CompanionTab.UGg => UGg,
        CompanionTab.Coachless => Coachless,
        CompanionTab.OpGg => OpGg,
        _ => null,
    };

    public static string LabelFor(CompanionTab tab) => SiteFor(tab)?.Label ?? CompanionLabel;

    /// <summary>The persisted key for a tab. Stable across releases — it is written to settings.</summary>
    public static string KeyFor(CompanionTab tab) => SiteFor(tab)?.Key ?? "companion";

    /// <summary>
    /// Parses a persisted key. An unknown value resolves to
    /// <see cref="CompanionTab.Companion"/> rather than throwing: a settings
    /// file written by a newer build must never stop this one from opening a
    /// window.
    /// </summary>
    public static CompanionTab ParseKey(string? key) => key?.Trim().ToLowerInvariant() switch
    {
        "ugg" => CompanionTab.UGg,
        "coachless" => CompanionTab.Coachless,
        "opgg" => CompanionTab.OpGg,
        _ => CompanionTab.Companion,
    };

    /// <summary>
    /// Returns the WebView2 profile directory for a tab.
    ///
    /// <para>The existing companion profile is intentionally kept at the old
    /// root path so a native upgrade does not sign the user out. Third-party
    /// tabs live in their own children and can therefore never share cookies,
    /// local storage, cache or service workers with the hosted app or each
    /// other.</para>
    /// </summary>
    public static string ProfileFolder(string root, CompanionTab tab)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(root);
        var fullRoot = Path.GetFullPath(root);
        var site = SiteFor(tab);
        return site is null ? fullRoot : Path.Combine(fullRoot, site.Key);
    }
}

/// <summary>Builds the account-specific op.gg profile URL from LCU-owned identity.</summary>
public static class OpGgProfileLink
{
    /// <summary>
    /// Riot platform id to op.gg route token. ONE table, so
    /// <see cref="RegionForPlatform"/> and <see cref="KnownRegions"/> can never
    /// disagree: the allowlist the region-locale path validates against is
    /// literally this table's value column, not a second hand-written copy of
    /// it that would rot the first time a platform is added.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> RegionsByPlatform =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["BR1"] = "br",
            ["EUN1"] = "eune",
            ["EUW1"] = "euw",
            ["JP1"] = "jp",
            ["KR"] = "kr",
            ["LA1"] = "lan",
            ["LA2"] = "las",
            ["ME1"] = "me",
            ["NA1"] = "na",
            ["OC1"] = "oce",
            ["PBE1"] = "pbe",
            ["PH2"] = "ph",
            ["RU"] = "ru",
            ["SG2"] = "sg",
            ["TH2"] = "th",
            ["TR1"] = "tr",
            ["TW2"] = "tw",
            ["VN2"] = "vn",
        };

    /// <summary>
    /// Maps Riot's platform id to op.gg's route token. Unknown platforms are
    /// refused rather than guessed, because a valid Riot ID can exist on more
    /// than one platform and the wrong route silently opens the wrong player.
    /// </summary>
    public static string? RegionForPlatform(string? platformId)
    {
        var key = platformId?.Trim();
        return string.IsNullOrEmpty(key) ? null
            : RegionsByPlatform.TryGetValue(key, out var region) ? region
            : null;
    }

    /// <summary>Every op.gg route token this app will ever navigate to.</summary>
    public static IReadOnlyCollection<string> KnownRegions { get; } =
        RegionsByPlatform.Values.Distinct(StringComparer.Ordinal).ToArray();

    /// <summary>
    /// Validates the client's own <c>webRegion</c> against the SAME token set
    /// the platform-id map produces.
    ///
    /// <para>The Riot client publishes this on <c>/riotclient/region-locale</c>
    /// as <c>{"region":"EUW","webRegion":"euw",…}</c>, and <c>webRegion</c> IS
    /// op.gg's route token — no mapping needed. It is still validated rather
    /// than pasted into a URL: an unrecognized token would build a route to a
    /// page that either 404s or, worse, resolves to a different player, and the
    /// resolver's whole contract is that no result beats a wrong one.</para>
    /// </summary>
    public static string? RegionForWebRegion(string? webRegion)
    {
        var token = webRegion?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(token)) return null;
        foreach (var known in KnownRegions)
        {
            if (string.Equals(known, token, StringComparison.Ordinal)) return known;
        }
        return null;
    }

    public static Uri? Build(string? gameName, string? tagLine, string? platformId) =>
        BuildForRegion(gameName, tagLine, RegionForPlatform(platformId));

    /// <summary>Builds the profile URL from an ALREADY-VALIDATED route token.</summary>
    public static Uri? BuildForRegion(string? gameName, string? tagLine, string? region)
    {
        var name = gameName?.Trim();
        var tag = tagLine?.Trim();
        if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(tag) || string.IsNullOrEmpty(region))
            return null;

        return new Uri(
            $"https://op.gg/summoners/{region}/{Uri.EscapeDataString(name)}-{Uri.EscapeDataString(tag)}",
            UriKind.Absolute);
    }

    internal static string? ReadPlatformId(System.Text.Json.JsonElement value)
    {
        if (value.ValueKind == System.Text.Json.JsonValueKind.String)
            return NonBlank(value.GetString());
        if (value.ValueKind != System.Text.Json.JsonValueKind.Object)
            return null;
        if (value.TryGetProperty("platformId", out var direct)
            && direct.ValueKind == System.Text.Json.JsonValueKind.String)
            return NonBlank(direct.GetString());
        if (value.TryGetProperty("LoginDataPacket", out var login)
            && login.ValueKind == System.Text.Json.JsonValueKind.Object
            && login.TryGetProperty("platformId", out var nested)
            && nested.ValueKind == System.Text.Json.JsonValueKind.String)
            return NonBlank(nested.GetString());
        return null;
    }

    /// <summary>
    /// Reads <c>webRegion</c> off <c>/riotclient/region-locale</c>'s body
    /// (<c>{"locale":"en_GB","region":"EUW","webLanguage":"en","webRegion":"euw"}</c>,
    /// captured from client 26.17 on 2026-09-08).
    ///
    /// <para>Only <c>webRegion</c> is read. The sibling <c>region</c> field
    /// carries "EUW" — a THIRD spelling that is neither the platform id
    /// ("EUW1") nor always the route token, so folding it in would be a guess
    /// dressed as a fallback.</para>
    /// </summary>
    internal static string? ReadWebRegion(System.Text.Json.JsonElement value)
    {
        if (value.ValueKind == System.Text.Json.JsonValueKind.String)
            return NonBlank(value.GetString());
        if (value.ValueKind != System.Text.Json.JsonValueKind.Object)
            return null;
        if (value.TryGetProperty("webRegion", out var web)
            && web.ValueKind == System.Text.Json.JsonValueKind.String)
            return NonBlank(web.GetString());
        return null;
    }

    private static string? NonBlank(string? value)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed;
    }
}

/// <summary>
/// Resolves the local user's op.gg profile from the same LCU client the
/// loopback bridge owns. No result means the caller should open op.gg home.
/// </summary>
public sealed class OpGgProfileResolver
{
    internal const string CurrentSummonerPath = "/lol-summoner/v1/current-summoner";

    /// <summary>
    /// The PRIMARY region source since 2.1.0. Live on client 26.17
    /// (2026-09-08) it answers
    /// <c>{"locale":"en_GB","region":"EUW","webLanguage":"en","webRegion":"euw"}</c>,
    /// and <c>webRegion</c> is op.gg's route token verbatim.
    /// </summary>
    internal const string RegionLocalePath = "/riotclient/region-locale";

    /// <summary>
    /// The pre-2.1.0 region source, kept as a SECONDARY fallback.
    ///
    /// <para>It returned 404 RPC_ERROR on client 26.17 — the failure behind the
    /// field log line "opgg: identity unavailable (client returned no riot id
    /// or platform) -- opening home" — so it can no longer be the only source.
    /// It is not deleted, because on the clients where it does answer it is the
    /// more precise one (a platform id, not a web token), and a second working
    /// path costs one request that is only made when the first one fails.</para>
    /// </summary>
    internal const string PlatformIdPath = "/lol-platform-config/v1/namespaces/LoginDataPacket/platformId";

    private readonly ILcuApi _lcu;

    public OpGgProfileResolver(ILcuApi lcu)
    {
        _lcu = lcu ?? throw new ArgumentNullException(nameof(lcu));
    }

    public async Task<Uri?> ResolveAsync(CancellationToken cancellationToken = default)
    {
        var summoner = await _lcu.SendAsync(
            HttpMethod.Get,
            CurrentSummonerPath,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!summoner.Ok || summoner.Content is not { } summonerJson)
            return null;

        var identity = OwnIdentityConverter.TryConvert(summonerJson);
        if (identity is null)
            return null;

        var region = await ResolveRegionAsync(cancellationToken).ConfigureAwait(false);
        return OpGgProfileLink.BuildForRegion(identity.GameName, identity.TagLine, region);
    }

    /// <summary>
    /// The route token, from region-locale first and the platform-id namespace
    /// second. Null when NEITHER answers with a token this app recognizes —
    /// which still opens op.gg home rather than a guessed player.
    /// </summary>
    private async Task<string?> ResolveRegionAsync(CancellationToken cancellationToken)
    {
        var locale = await _lcu.SendAsync(
            HttpMethod.Get,
            RegionLocalePath,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (locale.Ok && locale.Content is { } localeJson &&
            OpGgProfileLink.RegionForWebRegion(OpGgProfileLink.ReadWebRegion(localeJson)) is { } fromLocale)
            return fromLocale;

        var platform = await _lcu.SendAsync(
            HttpMethod.Get,
            PlatformIdPath,
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!platform.Ok || platform.Content is not { } platformJson)
            return null;

        return OpGgProfileLink.RegionForPlatform(OpGgProfileLink.ReadPlatformId(platformJson));
    }
}

/// <summary>
/// The small part of companion UI state that belongs to the browser window.
/// It deliberately contains no cookies or URLs: those stay in WebView2's
/// profile directories. The settings lane can map this value into the native
/// settings document through <see cref="ICompanionTabsPreferencesStore"/>.
/// </summary>
public sealed record CompanionTabsPreferences
{
    public const double DefaultZoomFactor = 1.0;
    public const double MinZoomFactor = 0.5;
    public const double MaxZoomFactor = 2.0;
    public const double ZoomStep = 0.1;

    public CompanionTabsPreferences(
        CompanionTab lastTab = CompanionTab.Companion,
        IReadOnlyDictionary<CompanionTab, double>? zoomFactors = null)
    {
        LastTab = IsKnownTab(lastTab) ? lastTab : CompanionTab.Companion;
        ZoomFactors = NormalizeZooms(zoomFactors);
    }

    public CompanionTab LastTab { get; }

    public IReadOnlyDictionary<CompanionTab, double> ZoomFactors { get; }

    public static CompanionTabsPreferences Default { get; } = new();

    public double ZoomFor(CompanionTab tab) =>
        ZoomFactors.TryGetValue(tab, out var value) ? value : DefaultZoomFactor;

    public CompanionTabsPreferences WithLastTab(CompanionTab tab) =>
        new(IsKnownTab(tab) ? tab : CompanionTab.Companion, ZoomFactors);

    public CompanionTabsPreferences WithZoom(CompanionTab tab, double zoomFactor)
    {
        if (!IsKnownTab(tab)) return this;
        var zooms = new Dictionary<CompanionTab, double>(ZoomFactors)
        {
            [tab] = NormalizeZoom(zoomFactor),
        };
        return new(LastTab, zooms);
    }

    public static bool IsKnownTab(CompanionTab tab) =>
        tab is CompanionTab.Companion or CompanionTab.UGg or CompanionTab.Coachless or CompanionTab.OpGg;

    public static double NormalizeZoom(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value)) return DefaultZoomFactor;
        return Math.Clamp(value, MinZoomFactor, MaxZoomFactor);
    }

    private static IReadOnlyDictionary<CompanionTab, double> NormalizeZooms(
        IReadOnlyDictionary<CompanionTab, double>? zoomFactors)
    {
        var result = new Dictionary<CompanionTab, double>();
        if (zoomFactors is null) return result;
        foreach (var pair in zoomFactors)
        {
            if (IsKnownTab(pair.Key)) result[pair.Key] = NormalizeZoom(pair.Value);
        }
        return result;
    }
}

/// <summary>
/// Persistence seam for the browser chrome. The WPF window never assumes a
/// particular settings file shape; callers can adapt the existing native
/// settings store and keep tab state alongside calibration and other desktop
/// preferences.
/// </summary>
public interface ICompanionTabsPreferencesStore
{
    CompanionTabsPreferences Read();

    void Save(CompanionTabsPreferences preferences);
}

/// <summary>
/// Champion deep links for the site tabs. PURE — no network, no DOM, no client.
///
/// <para>Both URL shapes were confirmed by loading them in a real browser on
/// 2026-09-07 rather than assumed:</para>
/// <list type="bullet">
///   <item><c>https://u.gg/lol/champions/{slug}/build/{role}</c> — the shape
///   u.gg's own role tabs link to. A query form (<c>?role=</c>) also resolves,
///   but the path form is the one the site itself considers canonical.</item>
///   <item><c>https://coachless.gg/builds/{slug}?role={role}</c> — the shape
///   coachless.gg's own champion links use.</item>
/// </list>
///
/// <para><b>The slug is the ddragon key folded by
/// <see cref="ChampionNameKey.Normalize"/></b>, which is the same fold the
/// champion resolver already uses. That gives <c>monkeyking</c> for Wukong and
/// <c>drmundo</c>/<c>belveth</c>/<c>kaisa</c> for the apostrophe-and-space
/// champions. Verified: u.gg serves <c>/lol/champions/monkeyking/build/jungle</c>
/// directly, and coachless.gg 302s <c>/builds/monkeyking</c> to
/// <c>/builds/wukong</c> — both accept the key, so no per-site champion name
/// table has to exist and drift.</para>
/// </summary>
public static class SiteDeepLink
{
    /// <summary>
    /// The role token both sites use, from the app's own role id
    /// (<c>ComplianceRules.RoleIdFromPosition</c>: 0 top, 1 jungle, 2 middle,
    /// 3 bottom, 4 utility). Anything else is null and the link drops the role
    /// rather than guessing one.
    /// </summary>
    public static string? RoleToken(int? roleId) => roleId switch
    {
        0 => "top",
        1 => "jungle",
        2 => "mid",
        3 => "adc",
        4 => "support",
        _ => null,
    };

    /// <summary>The human label for a role id, for the champ-select chip. Null when unknown.</summary>
    public static string? RoleLabel(int? roleId) => roleId switch
    {
        0 => "Top",
        1 => "Jungle",
        2 => "Mid",
        3 => "ADC",
        4 => "Support",
        _ => null,
    };

    public static string? Slug(string? championKey)
    {
        var slug = ChampionNameKey.Normalize(championKey);
        return string.IsNullOrEmpty(slug) ? null : slug;
    }

    /// <summary>
    /// The tree pair the runes deep link is BUILT with. Coachless's runes URL
    /// carries a primary/secondary pair in the path
    /// (<c>/runes/tree/{slug}/{primary}/{secondary}</c>), but the site snaps
    /// any valid pair to the one it recommends for that champion+role: the
    /// 2026-09-08 browser capture navigated
    /// <c>/runes/tree/nasus/precision/domination?role=top</c> and the site
    /// REDIRECTED to <c>/runes/tree/nasus/precision/resolve?role=top</c>.
    ///
    /// <para>So this pair is a probe, never a claim: the extractor reads the
    /// trees it actually LANDED on out of the rendered perk icons, and never
    /// out of this constant. Two different trees on purpose — a same-tree pair
    /// is not a valid rune page.</para>
    /// </summary>
    public const string RunesProbePrimary = "precision";

    /// <inheritdoc cref="RunesProbePrimary"/>
    public const string RunesProbeSecondary = "domination";

    /// <summary>
    /// The Coachless per-slot WPA runes page for a champion+role, or null when
    /// the champion cannot be addressed. Coachless only — u.gg's rune panel
    /// lives on the build page the existing extractor already reads.
    /// </summary>
    public static Uri? CoachlessRunesUrl(string? championKey, int? roleId)
    {
        if (Slug(championKey) is not { } slug) return null;
        var role = RoleToken(roleId);
        var path = $"https://coachless.gg/runes/tree/{slug}/{RunesProbePrimary}/{RunesProbeSecondary}";
        return new Uri(role is null ? path : $"{path}?role={role}", UriKind.Absolute);
    }

    /// <summary>
    /// The inverse of <see cref="RoleToken"/>. Null for an unknown token, so a
    /// role we cannot name is dropped rather than guessed — the same rule the
    /// deep links follow.
    /// </summary>
    public static int? RoleIdFromToken(string? token) => token?.Trim().ToLowerInvariant() switch
    {
        "top" => 0,
        "jungle" => 1,
        "mid" => 2,
        "adc" => 3,
        "support" => 4,
        _ => null,
    };

    public static Uri? Build(CompanionTab tab, string? championKey, int? roleId)
    {
        if (Slug(championKey) is not { } slug) return null;
        var role = RoleToken(roleId);
        return tab switch
        {
            CompanionTab.UGg => new Uri(
                role is null
                    ? $"https://u.gg/lol/champions/{slug}/build"
                    : $"https://u.gg/lol/champions/{slug}/build/{role}",
                UriKind.Absolute),
            CompanionTab.Coachless => new Uri(
                role is null
                    ? $"https://coachless.gg/builds/{slug}"
                    : $"https://coachless.gg/builds/{slug}?role={role}",
                UriKind.Absolute),
            _ => null,
        };
    }
}

/// <summary>
/// What champ select currently says, projected for automatic site imports.
///
/// <para><see cref="Locked"/> distinguishes a locked-in champion from a hover
/// (<c>championPickIntent</c>). Both offer the same link; only the wording
/// differs, because offering a page for a champion the user is still only
/// hovering is useful and pretending it is settled is not.</para>
/// </summary>
public sealed record ChampSelectContext(
    int ChampionId,
    string ChampionKey,
    string ChampionName,
    int? RoleId,
    bool Locked)
{
    /// <summary>
    /// The chip's label for a site. Deliberately a full sentence-shaped offer
    /// ("Open X on u.gg"), never a bare icon: this button navigates a page the
    /// user may be reading, so what it will do has to be legible before it is
    /// clicked.
    /// </summary>
    public string ChipLabel(SiteDefinition site)
    {
        ArgumentNullException.ThrowIfNull(site);
        var role = SiteDeepLink.RoleLabel(RoleId);
        var who = role is null ? ChampionName : $"{ChampionName} {role}";
        return Locked
            ? $"Open {who} on {site.Label}"
            : $"Open {who} on {site.Label} (hovered)";
    }

    public Uri? UrlFor(SiteDefinition site)
    {
        ArgumentNullException.ThrowIfNull(site);
        return site.BuildUrl(ChampionKey, RoleId);
    }
}

/// <summary>
/// The navigation policy for the SITE tabs. Deliberately not
/// <see cref="HostedPagePolicy"/>: that one is a same-origin lock for the app's
/// own pages, and applying it here would break every outbound link on a stats
/// site and make the tab feel broken.
///
/// <para>What it still refuses, and why:</para>
/// <list type="bullet">
///   <item><b>Anything that is not http(s).</b> A page must not be able to hand
///   Windows a <c>steam:</c>/<c>riot:</c>/<c>ms-settings:</c> URI and have this
///   app launch it. WebView2 does not follow those itself, but
///   <c>NewWindowRequested</c> hands us the URI and a naive handler would.</item>
///   <item><b>Plain http.</b> All sites are https; a downgrade is either a
///   typo or a hostile redirect.</item>
/// </list>
///
/// <para>It does NOT restrict the host. A stats site that cannot reach its own
/// patch notes or a wiki entry is a worse product than a tab that can, and the
/// window has no address bar, so every navigation still starts from a link on
/// one of the sites the user asked for.</para>
/// </summary>
public static class SiteNavigationPolicy
{
    /// <summary>
    /// Returns true only for a public HTTPS target. Site tabs can follow the
    /// HTTPS redirects and CDN pages their sites need, but they cannot be used
    /// to reach the local machine or launch an OS URI handler.
    /// </summary>
    public static bool IsAllowed(Uri? target) =>
        target is not null
        && target.IsAbsoluteUri
        && string.Equals(target.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
        && !IsLocalTarget(target);

    public static bool IsAllowed(string? target) =>
        Uri.TryCreate(target, UriKind.Absolute, out var uri) && IsAllowed(uri);

    /// <summary>Site-tab overload that makes the absence of a hosted session explicit.</summary>
    public static bool IsAllowed(SiteDefinition? site, Uri? target) =>
        site is not null && IsAllowed(target);

    /// <summary>
    /// True when <paramref name="current"/> is already the page
    /// <paramref name="offer"/> would navigate to, so the chip can stand down
    /// instead of offering a link to where the user already is.
    ///
    /// <para>Path-and-host only: both sites rewrite their own query strings
    /// (coachless normalises <c>?role=</c>, u.gg appends analytics params), and
    /// a comparison that included those would leave the chip permanently lit.</para>
    /// </summary>
    public static bool IsAlreadyThere(string? current, Uri? offer)
    {
        if (offer is null) return false;
        if (!Uri.TryCreate(current, UriKind.Absolute, out var now)) return false;
        if (!string.Equals(now.Host, offer.Host, StringComparison.OrdinalIgnoreCase)) return false;
        if (!string.Equals(
            now.AbsolutePath.TrimEnd('/'),
            offer.AbsolutePath.TrimEnd('/'),
            StringComparison.OrdinalIgnoreCase)) return false;

        // A role is part of the offer. Ignore analytics and other query
        // parameters, while keeping `?role=top` distinct from `?role=jungle`.
        // u.gg encodes its role in the final path segment; Coachless uses the
        // query form.
        var offeredRole = RoleFromUri(offer);
        var currentRole = RoleFromUri(now);
        return string.Equals(offeredRole, currentRole, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The role token a site URL carries — u.gg in the final path segment,
    /// Coachless in <c>?role=</c> — or null. Shared by exact-target checks so
    /// role-bearing and roleless destinations cannot collapse together.
    /// </summary>
    public static string? RoleFromUri(Uri uri)
    {
        var query = ParseRoleQuery(uri.Query);
        if (query is not null) return query;

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (segments.Length == 0) return null;
        var last = segments[^1];
        return last.ToLowerInvariant() switch
        {
            "top" or "jungle" or "mid" or "adc" or "support" => last,
            _ => null,
        };
    }

    private static string? ParseRoleQuery(string query)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;
        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            if (separator < 0) continue;
            var key = Uri.UnescapeDataString(pair[..separator]);
            if (!string.Equals(key, "role", StringComparison.OrdinalIgnoreCase)) continue;
            var value = Uri.UnescapeDataString(pair[(separator + 1)..]).Trim().ToLowerInvariant();
            return value is "top" or "jungle" or "mid" or "adc" or "support" ? value : null;
        }
        return null;
    }

    private static bool IsLocalTarget(Uri target)
    {
        var host = target.DnsSafeHost.TrimEnd('.');
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".localhost", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)
            || host.Equals("0", StringComparison.OrdinalIgnoreCase)) return true;

        if (System.Net.IPAddress.TryParse(host, out var address))
        {
            if (System.Net.IPAddress.IsLoopback(address)) return true;
            var bytes = address.GetAddressBytes();
            if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            {
                // RFC 1918 private, link-local and the carrier-grade NAT range.
                return bytes[0] == 10
                    || bytes[0] == 127
                    || (bytes[0] == 169 && bytes[1] == 254)
                    || (bytes[0] == 172 && bytes[1] is >= 16 and <= 31)
                    || (bytes[0] == 192 && bytes[1] == 168)
                    || (bytes[0] == 100 && bytes[1] is >= 64 and <= 127);
            }

            // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
            return (bytes[0] & 0xFE) == 0xFC
                || (bytes[0] == 0xFE && (bytes[1] & 0xC0) == 0x80);
        }

        return false;
    }
}
