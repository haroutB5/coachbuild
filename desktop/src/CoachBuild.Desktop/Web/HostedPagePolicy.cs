using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Web;

public enum HostedPageKind
{
    Home,
    Draft,
    Builds,
}

/// <summary>
/// Same-origin policy for the remote web app. The WebView2 window never opens
/// a default-browser tab: links outside the deployed CoachBuild origin are
/// rejected in the owned window and reported through the fallback/status UI.
/// </summary>
public sealed class HostedPagePolicy
{
    private readonly Uri _origin;

    public HostedPagePolicy(string appOrigin)
    {
        if (!Uri.TryCreate(appOrigin, UriKind.Absolute, out var origin)
            || origin.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(origin.AbsolutePath.Trim('/')))
        {
            throw new ArgumentException("The hosted app origin must be an https origin without a path.", nameof(appOrigin));
        }

        _origin = new Uri(origin.GetLeftPart(UriPartial.Authority) + "/", UriKind.Absolute);
    }

    public Uri Origin => _origin;

    public bool IsAllowed(Uri? target)
    {
        if (target is null || target.Scheme != Uri.UriSchemeHttps) return false;
        if (!string.Equals(target.Host, _origin.Host, StringComparison.OrdinalIgnoreCase)
            || target.Port != _origin.Port)
        {
            return false;
        }

        return true;
    }

    public bool IsAllowed(string? target)
    {
        return Uri.TryCreate(target, UriKind.Absolute, out var uri) && IsAllowed(uri);
    }

    public Uri BuildUrl(
        HostedPageKind page,
        string sessionToken,
        int? championId = null,
        int? roleId = null)
    {
        if (!SessionTokenStore.IsValid(sessionToken))
        {
            throw new ArgumentException("A persistent session token is required.", nameof(sessionToken));
        }

        var path = page switch
        {
            HostedPageKind.Draft => "/draft",
            HostedPageKind.Builds => "/",
            _ => "/live-setup",
        };
        var builder = new UriBuilder(new Uri(_origin, path));
        var query = new List<string>();
        // Match the existing DeepLinkService ordering and semantics: Draft
        // follows through /status and needs only the pairing session, while a
        // Builds URL carries the champion/role before the session token.
        if (page != HostedPageKind.Draft)
        {
            if (championId is > 0) query.Add("championId=" + championId.Value);
            if (roleId is >= 0) query.Add("role=" + roleId.Value);
        }
        query.Add("session=" + Uri.EscapeDataString(sessionToken));
        builder.Query = string.Join('&', query);
        return builder.Uri;
    }

    public Uri BuildUrl(ReopenTarget target, string sessionToken)
    {
        ArgumentNullException.ThrowIfNull(target);
        var page = target.Destination switch
        {
            ReopenDestination.Draft => HostedPageKind.Draft,
            ReopenDestination.Builds => HostedPageKind.Builds,
            _ => HostedPageKind.Home,
        };
        return BuildUrl(page, sessionToken, target.ChampionId, target.RoleId);
    }
}
