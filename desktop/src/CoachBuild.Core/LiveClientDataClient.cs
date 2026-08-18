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

/// <summary>
/// One observed outcome of a Live Client Data request.
///
/// <para><see cref="Reachable"/> answers only "did 127.0.0.1:2999 answer at
/// all". A 404 from a live game (spectating, or <c>activeplayerabilities</c>
/// on a client that embeds them) is still reachable — conflating the two makes
/// the signal flap once a second and useless.</para>
/// </summary>
public sealed record LiveClientProbe(bool Reachable, string? Detail);

/// <summary>
/// Turns the raw per-request probe stream into at most one log line per
/// transition.
///
/// Why this exists: rows 6 and 7 of the 1.0.7 in-game diagnosis matrix
/// ("2999 never answered" vs "2999 answered but identity never resolved") were
/// completely indistinguishable in the log, because
/// <see cref="LivePollingCoordinator"/> swallowed every failure with a bare
/// catch and <see cref="LiveClientDataClient.GetJsonAsync"/> returned null.
/// Both produced exactly zero output. This is the instrument that separates
/// them.
/// </summary>
public sealed class LiveReachabilityReporter
{
    private readonly int _port;
    private bool? _reachable;
    private string? _detail;

    public LiveReachabilityReporter(int port = 2999) => _port = port;

    /// <summary>The line to log, or null when nothing changed.</summary>
    public string? Observe(LiveClientProbe probe)
    {
        ArgumentNullException.ThrowIfNull(probe);

        if (probe.Reachable)
        {
            if (_reachable == true) return null;
            _reachable = true;
            _detail = null;
            return $"live: {_port} ok";
        }

        if (_reachable == false && string.Equals(_detail, probe.Detail, StringComparison.Ordinal))
            return null;
        _reachable = false;
        _detail = probe.Detail;
        return $"live: {_port} unreachable ({probe.Detail ?? "unknown"})";
    }
}

/// <summary>Unauthenticated Live Client Data transport, isolated from LCU TLS policy.</summary>
public sealed class LiveClientDataClient : IDisposable
{
    private readonly HttpClient _client;
    private readonly string _scheme;
    private readonly int _port;
    private bool _disposed;

    /// <summary>
    /// Optional sink for per-request reachability. Set by the desktop host so
    /// a silent loopback failure leaves a trace; never carries a payload.
    /// </summary>
    public Action<LiveClientProbe>? ProbeObserved { get; set; }

    public int Port => _port;

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

    /// <summary>
    /// The last-resort identity source: a bare JSON string, whose format has
    /// changed across patches (sometimes <c>Name#TAG</c>, sometimes the game
    /// name alone). Only polled when <c>allgamedata.activePlayer</c> produced no
    /// usable identity at all, so it costs nothing on a healthy client.
    /// </summary>
    public Task<JsonElement?> GetActivePlayerNameAsync(CancellationToken cancellationToken = default) =>
        GetJsonAsync("/liveclientdata/activeplayername", cancellationToken);

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
            // The port answered. A non-success status is a resource verdict,
            // not a reachability verdict, and must not be reported as one.
            Probe(reachable: true, detail: null);
            if (!response.IsSuccessStatusCode) return null;
            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var document = await JsonDocument.ParseAsync(
                stream,
                cancellationToken: cancellationToken).ConfigureAwait(false);
            return document.RootElement.Clone();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            Probe(reachable: false, detail: "Timeout");
            return null;
        }
        catch (HttpRequestException error)
        {
            Probe(reachable: false, detail: $"HttpRequestException/{error.HttpRequestError}");
            return null;
        }
        catch (JsonException)
        {
            Probe(reachable: true, detail: null);
            return null;
        }
    }

    private void Probe(bool reachable, string? detail)
    {
        var sink = ProbeObserved;
        if (sink is null) return;
        try { sink(new LiveClientProbe(reachable, detail)); }
        catch { /* Diagnostics must never break the poll they observe. */ }
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
