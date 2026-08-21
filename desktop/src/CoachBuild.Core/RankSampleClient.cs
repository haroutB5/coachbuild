using System.Net;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// The single My Stats transport: one HttpClient, one timeout, one auth header
/// spelling, one failure taxonomy, for every account-secret POST the desktop
/// makes.
///
/// <para><b>It posts two things.</b> One ranked-LP sample
/// (<see cref="PostAsync(RankSampleBody,string,CancellationToken)"/>) and one
/// companion-log upload
/// (<see cref="PostAsync(DiagnosticsBody,string,CancellationToken)"/>). They
/// share <see cref="SendAsync{T}"/> deliberately rather than getting a client
/// each: a second HTTP client is how the timeout, the header name, the 4xx/5xx
/// distinction and the <c>ok:false</c> reading quietly come to disagree, and
/// three of those four are load-bearing.</para>
///
/// <para>Modelled on <see cref="WebAppVersionClient"/> deliberately: same
/// fail-soft posture, same "every failure is a return value, never an
/// exception", same tiny surface. This runs while the user is in champ select
/// or has just left a game, and the one thing it must never do is become the
/// reason something else did not happen.</para>
///
/// <para><b>Auth.</b> Spec §4 gates the endpoint with the existing
/// <c>x-coachbuild-account-secret</c> shared secret and forbids inventing a
/// second scheme. The user copies it once from the browser's Pair desktop
/// control into the native tray's masked dialog; both the C# and PowerShell
/// companions then read the same persisted desktop setting. When it is absent,
/// capture stays INERT rather than posting unauthenticated.</para>
/// </summary>
public sealed class RankSampleClient : IRankSampleSink, IDiagnosticsSink, IDisposable
{
    /// <summary>The route spec §4 defines. Lane J owns the server half.</summary>
    public const string SamplePath = "/api/mystats/rank-sample";

    /// <summary>
    /// The companion-log upload route. Same origin, same secret header, same
    /// <c>{ok}</c> response shape — see app/api/mystats/diagnostics/route.ts,
    /// which gates it with the same <c>checkAccountSecret</c> as rank-sample.
    /// </summary>
    public const string DiagnosticsPath = "/api/mystats/diagnostics";

    /// <summary>Must equal <c>ACCOUNT_SECRET_HEADER</c> in lib/mystats/accountAuth.ts.</summary>
    public const string SecretHeader = "x-coachbuild-account-secret";

    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(5);

    private readonly HttpClient _http;
    private readonly Uri _endpoint;
    private readonly Uri _diagnosticsEndpoint;
    private readonly bool _ownsHttp;
    private bool _disposed;

    public RankSampleClient(
        string appOrigin = CompanionWire.AppOrigin,
        HttpMessageHandler? handler = null,
        TimeSpan? timeout = null)
    {
        if (!Uri.TryCreate(appOrigin, UriKind.Absolute, out var origin))
            throw new ArgumentException("The app origin must be an absolute URI.", nameof(appOrigin));
        _endpoint = new Uri(origin, SamplePath);
        _diagnosticsEndpoint = new Uri(origin, DiagnosticsPath);
        _ownsHttp = handler is null;
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = timeout ?? DefaultTimeout;
    }

    public Uri Endpoint => _endpoint;

    /// <summary>The companion-log upload endpoint. Same origin as <see cref="Endpoint"/>.</summary>
    public Uri DiagnosticsEndpoint => _diagnosticsEndpoint;

    public Task<RankSamplePostResult> PostAsync(
        RankSampleBody body,
        string secret,
        CancellationToken cancellationToken) =>
        SendAsync(_endpoint, body, secret, cancellationToken);

    /// <summary>
    /// One companion-log upload. Identical transport and identical failure
    /// taxonomy to the LP sample above — the ONLY difference is the route and
    /// the body type, which is the whole argument for them sharing a client.
    /// </summary>
    public Task<RankSamplePostResult> PostAsync(
        DiagnosticsBody body,
        string secret,
        CancellationToken cancellationToken) =>
        SendAsync(_diagnosticsEndpoint, body, secret, cancellationToken);

    private async Task<RankSamplePostResult> SendAsync<TBody>(
        Uri endpoint,
        TBody body,
        string secret,
        CancellationToken cancellationToken)
    {
        if (_disposed) return RankSamplePostResult.Failed;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.TryAddWithoutValidation(SecretHeader, secret);
            request.Content = new StringContent(
                JsonSerializer.Serialize(body, JsonOptions.Wire), Encoding.UTF8, "application/json");
            using var response = await _http.SendAsync(request, cancellationToken).ConfigureAwait(false);

            // A 4xx is the server having an OPINION, and that opinion will be
            // the same next time — retrying it is pure noise in someone's log.
            // A 5xx or a transport failure is genuinely unknown, so it is
            // Failed, which callers are free to treat differently later.
            if (response.IsSuccessStatusCode) return ReadOk(await SafeReadAsync(response, cancellationToken).ConfigureAwait(false));
            return (int)response.StatusCode is >= 400 and < 500
                ? RankSamplePostResult.Rejected
                : RankSamplePostResult.Failed;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return RankSamplePostResult.Failed;
        }
        catch
        {
            return RankSamplePostResult.Failed;
        }
    }

    private static async Task<string?> SafeReadAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        try
        {
            return response.Content is null
                ? null
                : await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Spec §4's response is <c>{ok:true}</c> or <c>{ok:false, reason}</c>, and
    /// a 200 carrying <c>ok:false</c> is a refusal however friendly the status
    /// line is. An unreadable/absent body on a 2xx is treated as Posted: the
    /// endpoint is idempotent, so the cost of being wrong in that direction is
    /// a duplicate row the server already dedupes.
    /// </summary>
    internal static RankSamplePostResult ReadOk(string? body)
    {
        if (string.IsNullOrWhiteSpace(body)) return RankSamplePostResult.Posted;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return RankSamplePostResult.Posted;
            if (!document.RootElement.TryGetProperty("ok", out var ok)) return RankSamplePostResult.Posted;
            return ok.ValueKind == JsonValueKind.False
                ? RankSamplePostResult.Rejected
                : RankSamplePostResult.Posted;
        }
        catch (JsonException)
        {
            return RankSamplePostResult.Posted;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_ownsHttp) _http.Dispose();
    }
}
