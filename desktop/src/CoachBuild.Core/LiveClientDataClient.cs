using System.Net.Http;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace CoachBuild.Core;

public sealed record LiveClientDataOptions(
    int Port = 2999,
    string Scheme = "https",
    TimeSpan? Timeout = null);

/// <summary>
/// An open Live Client Data response. The bridge uses this for the /live
/// passthrough so the upstream bytes are copied directly to the browser rather
/// than materialized as a JsonElement and serialized a second time.
/// </summary>
public sealed class LiveClientDataStream : IDisposable
{
    private readonly HttpResponseMessage _response;
    private bool _disposed;

    internal LiveClientDataStream(HttpResponseMessage response, Stream content)
    {
        _response = response;
        Content = content;
    }

    public Stream Content { get; }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Content.Dispose();
        _response.Dispose();
    }
}

/// <summary>Unauthenticated Live Client Data transport, isolated from LCU TLS policy.</summary>
public sealed class LiveClientDataClient : IDisposable
{
    private readonly HttpClient _client;
    private readonly string _scheme;
    private readonly int _port;
    private bool _disposed;

    public LiveClientDataClient(LiveClientDataOptions? options = null, HttpMessageHandler? handler = null)
    {
        var selected = options ?? new LiveClientDataOptions();
        if (selected.Port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(options));
        if (!string.Equals(selected.Scheme, "http", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(selected.Scheme, "https", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Live Client Data scheme must be http or https", nameof(options));
        _port = selected.Port;
        _scheme = selected.Scheme;
        _client = new HttpClient(handler ?? CreateLoopbackHandler(), disposeHandler: true)
        {
            Timeout = selected.Timeout ?? TimeSpan.FromSeconds(3)
        };
    }

    public Task<JsonElement?> GetAllGameDataAsync(CancellationToken cancellationToken = default) =>
        GetJsonAsync("/liveclientdata/allgamedata", cancellationToken);

    public async Task<LiveClientDataStream?> OpenAllGameDataStreamAsync(
        CancellationToken cancellationToken = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LiveClientDataClient));
        HttpResponseMessage? response = null;
        try
        {
            response = await _client.GetAsync(
                new Uri($"{_scheme}://127.0.0.1:{_port}/liveclientdata/allgamedata", UriKind.Absolute),
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                response.Dispose();
                return null;
            }

            var content = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            return new LiveClientDataStream(response, content);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            response?.Dispose();
            return null;
        }
        catch (HttpRequestException)
        {
            response?.Dispose();
            return null;
        }
        catch
        {
            response?.Dispose();
            return null;
        }
    }

    public Task<JsonElement?> GetPlayerListAsync(CancellationToken cancellationToken = default) =>
        GetJsonAsync("/liveclientdata/playerlist", cancellationToken);

    public async Task<LiveSkillState?> GetSkillsAsync(CancellationToken cancellationToken = default)
    {
        var active = await GetJsonAsync("/liveclientdata/activeplayer", cancellationToken).ConfigureAwait(false);
        if (active is null) return null;
        JsonElement? abilities = null;
        if (!active.Value.TryGetProperty("abilities", out var embeddedAbilities) ||
            embeddedAbilities.ValueKind != JsonValueKind.Object)
            abilities = await GetJsonAsync("/liveclientdata/activeplayerabilities", cancellationToken).ConfigureAwait(false);
        return LiveSkillStateConverter.TryConvert(active.Value, abilities);
    }

    public async Task<JsonElement?> GetJsonAsync(string path, CancellationToken cancellationToken = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(LiveClientDataClient));
        try
        {
            using var response = await _client.GetAsync(
                new Uri($"{_scheme}://127.0.0.1:{_port}{path}", UriKind.Absolute),
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(
                stream,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            return document.RootElement.Clone();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _client.Dispose();
    }

    public static HttpMessageHandler CreateLoopbackHandler() =>
        new HttpClientHandler
        {
            ServerCertificateCustomValidationCallback = ValidateLoopbackCertificate
        };

    internal static bool ValidateLoopbackCertificate(
        HttpRequestMessage request,
        X509Certificate2? certificate,
        X509Chain? chain,
        System.Net.Security.SslPolicyErrors errors) =>
        request.RequestUri is { } uri &&
        string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal);
}
