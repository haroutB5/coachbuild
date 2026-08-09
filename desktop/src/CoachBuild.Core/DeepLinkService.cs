namespace CoachBuild.Core;

public sealed class DeepLinkService
{
    public string AppOrigin { get; }

    public DeepLinkService(string appOrigin = CompanionWire.AppOrigin)
    {
        if (!Uri.TryCreate(appOrigin, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("The CoachBuild app origin must be an absolute HTTPS URL", nameof(appOrigin));
        AppOrigin = appOrigin.TrimEnd('/');
    }

    public string GetDraftDeepLinkUrl(string sessionToken) =>
        $"{AppOrigin}/draft?session={Encode(sessionToken)}";

    public string GetBuildsDeepLinkUrl(int championId, int? roleId, string sessionToken)
    {
        var url = $"{AppOrigin}/?championId={championId}";
        if (roleId is not null) url += $"&role={roleId.Value}";
        return $"{url}&session={Encode(sessionToken)}";
    }

    public string GetReopenUrl(string phase, int? championId, int? roleId, string sessionToken)
    {
        if (string.Equals(phase, "ChampSelect", StringComparison.Ordinal))
            return GetDraftDeepLinkUrl(sessionToken);
        return championId is > 0
            ? GetBuildsDeepLinkUrl(championId.Value, roleId, sessionToken)
            : $"{AppOrigin}/live-setup?session={Encode(sessionToken)}";
    }

    private static string Encode(string value) => Uri.EscapeDataString(value ?? string.Empty);
}

