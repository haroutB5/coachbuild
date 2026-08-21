using System.Net;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Posts one ranked-LP sample to the web app.
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
public sealed class RankSampleClient : IRankSampleSink, IDisposable
{
    /// <summary>The route spec §4 defines. Lane J owns the server half.</summary>
    public const string SamplePath = "/api/mystats/rank-sample";

    /// <summary>Must equal <c>ACCOUNT_SECRET_HEADER</c> in lib/mystats/accountAuth.ts.</summary>
    public const string SecretHeader = "x-coachbuild-account-secret";

    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(5);

    private readonly HttpClient _http;
    private readonly Uri _endpoint;
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
        _ownsHttp = handler is null;
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.Timeout = timeout ?? DefaultTimeout;
    }

    public Uri Endpoint => _endpoint;

    public async Task<RankSamplePostResult> PostAsync(
        RankSampleBody body,
        string secret,
        CancellationToken cancellationToken)
    {
        if (_disposed) return RankSamplePostResult.Failed;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, _endpoint);
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
