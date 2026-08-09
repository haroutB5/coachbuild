using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

public interface ILcuApi
{
    Task<LcuResponse> SendAsync(HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default);
}

public sealed record LcuHttpClientOptions(
    string Scheme = "https",
    TimeSpan? Timeout = null);

/// <summary>
/// LCU client with a handler dedicated to 127.0.0.1. No process-wide
/// certificate callback is installed, so ordinary HTTPS validation elsewhere
/// in the desktop app remains intact.
/// </summary>
public sealed class LcuHttpClient : ILcuApi, IDisposable
{
    private readonly LcuCredentialResolver _credentials;
    private readonly HttpClient _client;
    private readonly string _scheme;
    private bool _disposed;

    public LcuHttpClient(
        LcuCredentialResolver credentials,
        LcuHttpClientOptions? options = null,
        HttpMessageHandler? handler = null)
    {
        _credentials = credentials;
        var selected = options ?? new LcuHttpClientOptions();
        _scheme = selected.Scheme;
        if (!string.Equals(_scheme, "http", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(_scheme, "https", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("LCU scheme must be http or https", nameof(options));

        _client = new HttpClient(handler ?? CreateLoopbackHandler(), disposeHandler: true)
        {
            Timeout = selected.Timeout ?? TimeSpan.FromSeconds(5)
        };
    }

    public async Task<LcuResponse> SendAsync(
        HttpMethod method,
        string path,
        object? body = null,
        CancellationToken cancellationToken = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LcuHttpClient));
        if (string.IsNullOrWhiteSpace(path) || !path.StartsWith("/", StringComparison.Ordinal))
            throw new ArgumentException("LCU paths must be absolute paths", nameof(path));

        var credentials = _credentials.GetCachedOrResolve();
        if (credentials is null)
            return new LcuResponse(false, 0);

        using var request = new HttpRequestMessage(method, new Uri(
            $"{_scheme}://127.0.0.1:{credentials.Port}{path}", UriKind.Absolute));
        var authBytes = Encoding.UTF8.GetBytes($"riot:{credentials.Token}");
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic", Convert.ToBase64String(authBytes));
        if (body is not null)
        {
            var json = JsonSerializer.Serialize(body, JsonOptions.Wire);
            request.Content = new StringContent(json, Encoding.UTF8, "application/json");
        }

        try
        {
            using var response = await _client.SendAsync(request, HttpCompletionOption.ResponseContentRead, cancellationToken)
                .ConfigureAwait(false);
            var raw = response.Content is null
                ? null
                : await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var content = ParseContent(raw);
            var result = new LcuResponse(response.IsSuccessStatusCode, (int)response.StatusCode, content, raw);
            if (result.IsConnectionOrAuthFailure) _credentials.Invalidate();
            return result;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _credentials.Invalidate();
            return new LcuResponse(false, 0);
        }
        catch (HttpRequestException)
        {
            _credentials.Invalidate();
            return new LcuResponse(false, 0);
        }
    }

    public Task<LcuResponse> GetAsync(string path, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Get, path, null, cancellationToken);

    public Task<LcuResponse> PutAsync(string path, object body, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Put, path, body, cancellationToken);

    public Task<LcuResponse> PostAsync(string path, object body, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Post, path, body, cancellationToken);

    public Task<LcuResponse> DeleteAsync(string path, CancellationToken cancellationToken = default) =>
        SendAsync(HttpMethod.Delete, path, null, cancellationToken);

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _client.Dispose();
    }

    public static HttpMessageHandler CreateLoopbackHandler()
    {
        var handler = new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = ValidateLoopbackCertificate
        };
        return handler;
    }

    internal static bool ValidateLoopbackCertificate(
        HttpRequestMessage request,
        X509Certificate2? certificate,
        X509Chain? chain,
        System.Net.Security.SslPolicyErrors errors)
    {
        // HTTP requests do not invoke the callback; HTTPS must be exactly the
        // LCU loopback address. Hostname aliases are intentionally rejected.
        return request.RequestUri is { } uri &&
               string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal);
    }

    private static JsonElement? ParseContent(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        try
        {
            using var document = JsonDocument.Parse(raw);
            return document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
