using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Asks the deployed site which version it is serving right now.
///
/// <para><b>Why this exists.</b> The WebView2 window this app hosts is
/// long-lived. <see cref="WindowDecisionService.OnChampSelectEntry"/> returns
/// <see cref="WindowDecisionKind.None"/> whenever a follow attachment is live,
/// and a page that is polling <c>/status</c> is permanently attached
/// (<c>CompanionWire.AttachWindowSeconds</c> is 150 and the page polls every
/// second). So the app never re-navigates a window that is already open, and
/// the JS bundle that window loaded stays loaded until the window is closed.
/// </para>
///
/// <para>On 2026-08-19 that cost a user an entire web release. They entered
/// champ select at 14:30:24 UTC, roughly 18 minutes after web 0.112.0 went
/// live, and their window was still executing 0.111.0 — visible only because a
/// screenshot happened to include the header. Their log said
/// <c>apply-itemsets: count=1</c> where the new code would have said 2, and
/// nothing on either side reported the mismatch. Restarting the app fixed it,
/// which is exactly what a frozen in-process page predicts.</para>
///
/// <para>Deliberately fail-soft and deliberately tiny: a version check that
/// throws, or that blocks champ select, would be worse than the staleness it
/// is diagnosing. Every failure returns null and the caller carries on.</para>
/// </summary>
public sealed class WebAppVersionClient
{
    /// <summary>The route added in web 0.113.0. Served <c>no-store</c>.</summary>
    public const string VersionPath = "/api/app-version";

    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(5);

    private readonly HttpClient _http;
    private readonly Uri _endpoint;

    public WebAppVersionClient(string appOrigin, HttpMessageHandler? handler = null, TimeSpan? timeout = null)
    {
        if (!Uri.TryCreate(appOrigin, UriKind.Absolute, out var origin))
            throw new ArgumentException("The app origin must be an absolute URI.", nameof(appOrigin));
        _endpoint = new Uri(origin, VersionPath);
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = timeout ?? DefaultTimeout;
    }

    public Uri Endpoint => _endpoint;

    /// <summary>
    /// The version string the origin reports, or null if it could not be
    /// obtained for ANY reason (offline, timeout, non-200, malformed body, a
    /// deployment older than 0.113.0 that has no such route).
    ///
    /// <para>Null is not "up to date" and callers must not treat it as such —
    /// see <c>App.CheckWebFreshnessAsync</c>, which logs the failure and
    /// changes nothing.</para>
    /// </summary>
    public async Task<string?> GetVersionAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, _endpoint);
            // Belt and braces over the route's own no-store: this answer is
            // only useful if it comes from the deployment serving right now.
            request.Headers.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue
            {
                NoCache = true,
                NoStore = true,
            };
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            return ReadVersion(body);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Parses <c>{"version":"0.113.0"}</c>. Null on anything else.</summary>
    public static string? ReadVersion(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return null;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!document.RootElement.TryGetProperty("version", out var value)) return null;
            if (value.ValueKind != JsonValueKind.String) return null;
            var version = value.GetString();
            return string.IsNullOrWhiteSpace(version) ? null : version;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// The decision, as a pure function of the two version strings, so it can
    /// be tested without a browser or a network.
    ///
    /// <para><paramref name="loaded"/> null means the loaded document carries
    /// no <c>coachbuild-version</c> meta tag, i.e. it is a build older than
    /// web 0.113.0 — which is the case this whole mechanism was built for and
    /// therefore MUST reload, not be treated as unknown-and-ignored.</para>
    ///
    /// <para><paramref name="live"/> null means the check itself failed. That
    /// one is genuinely unknown and never triggers a reload: an offline user
    /// mid-champ-select must not have their window replaced.</para>
    /// </summary>
    public static WebFreshness Compare(string? loaded, string? live)
    {
        if (string.IsNullOrWhiteSpace(live)) return WebFreshness.Unknown;
        if (string.IsNullOrWhiteSpace(loaded)) return WebFreshness.StaleUntagged;
        return string.Equals(loaded.Trim(), live.Trim(), StringComparison.Ordinal)
            ? WebFreshness.Current
            : WebFreshness.Stale;
    }
}

public enum WebFreshness
{
    /// <summary>The live version could not be determined. Change nothing.</summary>
    Unknown,

    /// <summary>The window is running exactly what the site serves.</summary>
    Current,

    /// <summary>The window is running a different version. Reload.</summary>
    Stale,

    /// <summary>
    /// The window carries no version tag at all, so it predates web 0.113.0.
    /// Reload — this is the oldest possible page, not an unknown one.
    /// </summary>
    StaleUntagged,
}
