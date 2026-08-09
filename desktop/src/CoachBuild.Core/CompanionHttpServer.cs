using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

public sealed class CompanionHttpServer : IAsyncDisposable
{
    private readonly string _sessionToken;
    private readonly CompanionState _state;
    private readonly LcuCredentialResolver? _credentials;
    private readonly ILcuApi _lcu;
    private readonly LiveClientDataClient _live;
    private readonly RuneApplyService _runes;
    private readonly ItemSetApplyService _itemSets;
    private readonly RedactedLog _log;
    private readonly int[] _ports;
    private readonly bool _ownsLcu;
    private readonly bool _ownsLive;
    private readonly ConcurrentBag<Task> _handlers = new();
    private HttpListener? _listener;
    private CancellationTokenSource? _stop;
    private Task? _listenTask;
    private bool _disposed;

    public CompanionHttpServer(
        string sessionToken,
        CompanionState? state = null,
        ILcuApi? lcu = null,
        LiveClientDataClient? live = null,
        RuneApplyService? runes = null,
        ItemSetApplyService? itemSets = null,
        LcuCredentialResolver? credentials = null,
        RedactedLog? log = null,
        IEnumerable<int>? ports = null)
    {
        if (string.IsNullOrWhiteSpace(sessionToken)) throw new ArgumentException("A session token is required", nameof(sessionToken));
        _sessionToken = sessionToken;
        _state = state ?? new CompanionState();
        _credentials = credentials;
        if (lcu is null)
        {
            _credentials ??= new LcuCredentialResolver();
            _lcu = new LcuHttpClient(_credentials);
            _ownsLcu = true;
        }
        else
        {
            _lcu = lcu;
        }
        if (live is null)
        {
            _live = new LiveClientDataClient();
            _ownsLive = true;
        }
        else
        {
            _live = live;
        }
        _log = log ?? new RedactedLog();
        _runes = runes ?? new RuneApplyService(_lcu, state: _state, log: _log);
        _itemSets = itemSets ?? new ItemSetApplyService(_lcu, _state, _log);
        _ports = (ports ?? CompanionWire.BridgePorts).Distinct().ToArray();
        if (_ports.Length == 0) throw new ArgumentException("At least one bridge port is required", nameof(ports));
    }

    public string SessionToken => _sessionToken;
    public int Port { get; private set; }
    public CompanionState State => _state;
    public bool IsRunning => _listener?.IsListening == true;

    public Task StartAsync(CancellationToken cancellationToken = default)
    {
        if (_disposed) throw new ObjectDisposedException(nameof(CompanionHttpServer));
        if (IsRunning) return Task.CompletedTask;
        foreach (var candidate in _ports)
        {
            if (candidate is < 1 or > 65535) continue;
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{candidate}/");
            try
            {
                listener.Start();
                _listener = listener;
                Port = candidate;
                break;
            }
            catch
            {
                listener.Close();
            }
        }
        if (_listener is null)
            throw new InvalidOperationException("No free bridge port available (48291-48293 all in use)");

        _stop = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _listenTask = ListenAsync(_stop.Token);
        return Task.CompletedTask;
    }

    public async Task StopAsync()
    {
        _stop?.Cancel();
        try { _listener?.Stop(); } catch { }
        if (_listenTask is not null)
        {
            try { await _listenTask.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        var handlers = _handlers.ToArray();
        if (handlers.Length > 0)
        {
            try { await Task.WhenAll(handlers).ConfigureAwait(false); }
            catch { }
        }
        _listener?.Close();
        _listener = null;
        _listenTask = null;
        _stop?.Dispose();
        _stop = null;
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        await StopAsync().ConfigureAwait(false);
        if (_ownsLcu && _lcu is IDisposable lcu) lcu.Dispose();
        if (_ownsLive) _live.Dispose();
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _listener is { IsListening: true } listener)
        {
            HttpListenerContext? context = null;
            try
            {
                context = await listener.GetContextAsync().WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (HttpListenerException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) { break; }
            catch (InvalidOperationException) { break; }
            if (context is null) continue;
            var handler = Task.Run(() => HandleAsync(context, cancellationToken), CancellationToken.None);
            _handlers.Add(handler);
        }
    }

    private async Task HandleAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        var request = context.Request;
        var response = context.Response;
        try
        {
            var origin = request.Headers["Origin"];
            if (!ComplianceRules.IsAllowedOrigin(origin))
            {
                await HttpResponseWriter.WriteJsonAsync(response, 403, new CompanionError("bad-origin"), cancellationToken)
                    .ConfigureAwait(false);
                return;
            }
            if (string.Equals(request.HttpMethod, "OPTIONS", StringComparison.Ordinal))
            {
                await HttpResponseWriter.WriteNoContentAsync(response, cancellationToken).ConfigureAwait(false);
                return;
            }

            var suppliedSession = request.QueryString["session"];
            if (!ComplianceRules.IsValidSession(suppliedSession, _sessionToken))
            {
                await HttpResponseWriter.WriteJsonAsync(response, 403, new CompanionError("bad-session"), cancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            var path = request.Url?.AbsolutePath ?? string.Empty;
            if (string.Equals(path, CompanionRoutes.Status, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "GET", StringComparison.Ordinal))
            {
                _state.FollowAttachments.ApplyQuery(
                    request.QueryString["follow"],
                    string.Equals(request.QueryString["detach"], "1", StringComparison.Ordinal));
                await HttpResponseWriter.WriteJsonAsync(response, 200, _state.ToStatus(Port), cancellationToken)
                    .ConfigureAwait(false);
                return;
            }

            if (string.Equals(path, CompanionRoutes.Live, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "GET", StringComparison.Ordinal))
            {
                var live = await _live.GetAllGameDataAsync(cancellationToken).ConfigureAwait(false);
                if (live is { } liveValue)
                    await HttpResponseWriter.WriteJsonElementAsync(response, 200, liveValue, cancellationToken).ConfigureAwait(false);
                else
                    await HttpResponseWriter.WriteJsonAsync(response, 200, new CompanionError("no-live"), cancellationToken).ConfigureAwait(false);
                return;
            }

            if (string.Equals(path, CompanionRoutes.Skills, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "GET", StringComparison.Ordinal))
            {
                var skills = await _live.GetSkillsAsync(cancellationToken).ConfigureAwait(false);
                if (skills is not null)
                    await HttpResponseWriter.WriteJsonAsync(response, 200, skills, cancellationToken).ConfigureAwait(false);
                else
                    await HttpResponseWriter.WriteJsonAsync(response, 200, new CompanionError("no-live"), cancellationToken).ConfigureAwait(false);
                return;
            }

            if (string.Equals(path, CompanionRoutes.Me, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "GET", StringComparison.Ordinal))
            {
                var identity = await GetOwnIdentityAsync(cancellationToken).ConfigureAwait(false);
                if (identity is not null)
                    await HttpResponseWriter.WriteJsonAsync(response, 200, identity, cancellationToken).ConfigureAwait(false);
                else
                    await HttpResponseWriter.WriteJsonAsync(response, 200, new CompanionError("no-client"), cancellationToken).ConfigureAwait(false);
                return;
            }

            if (string.Equals(path, CompanionRoutes.ApplyRunes, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "POST", StringComparison.Ordinal))
            {
                if (!EnsureCredentials())
                {
                    await HttpResponseWriter.WriteJsonAsync(response, 200,
                        new ApplyRunesFailure("no-client", "League client not detected -- open the client and try again"), cancellationToken)
                        .ConfigureAwait(false);
                    return;
                }
                var body = await ReadJsonAsync<ApplyRunesRequest>(request, cancellationToken).ConfigureAwait(false);
                var result = await _runes.ApplyAsync(body, cancellationToken).ConfigureAwait(false);
                await HttpResponseWriter.WriteJsonAsync(response, 200, result, cancellationToken).ConfigureAwait(false);
                _log.Info($"apply-runes: ok={result.Ok} reason={(result is ApplyRunesFailure failure ? failure.Reason : "none")}");
                return;
            }

            if (string.Equals(path, CompanionRoutes.ApplyItemSets, StringComparison.Ordinal) &&
                string.Equals(request.HttpMethod, "POST", StringComparison.Ordinal))
            {
                if (!EnsureCredentials())
                {
                    await HttpResponseWriter.WriteJsonAsync(response, 200,
                        new ApplyItemSetsFailure("no-client", "League client not detected -- open the client and try again"), cancellationToken)
                        .ConfigureAwait(false);
                    return;
                }
                var body = await ReadJsonAsync<ApplyItemSetsRequest>(request, cancellationToken).ConfigureAwait(false);
                var result = await _itemSets.ApplyAsync(body, cancellationToken).ConfigureAwait(false);
                await HttpResponseWriter.WriteJsonAsync(response, 200, result, cancellationToken).ConfigureAwait(false);
                _log.Info($"apply-itemsets: ok={result.Ok}");
                return;
            }

            await HttpResponseWriter.WriteJsonAsync(response, 404, new CompanionError("not-found"), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            try { response.Close(); } catch { }
        }
        catch (Exception ex)
        {
            _log.Error("bridge", $"bridge error: {ex.GetType().Name}: {ex.Message}");
            _state.SetLastError($"bridge error: {ex.GetType().Name}");
            try
            {
                await HttpResponseWriter.WriteJsonAsync(response, 500, new CompanionError("internal"), CancellationToken.None)
                    .ConfigureAwait(false);
            }
            catch { try { response.Close(); } catch { } }
        }
    }

    private bool EnsureCredentials()
    {
        if (_state.ClientConnected) return true;
        var found = _credentials?.GetCachedOrResolve();
        _state.SetCredentials(found);
        return found is not null;
    }

    private async Task<OwnIdentity?> GetOwnIdentityAsync(CancellationToken cancellationToken)
    {
        if (!EnsureCredentials()) return null;
        var response = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-summoner/v1/current-summoner",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return response.Ok && response.Content is { } content
            ? OwnIdentityConverter.TryConvert(content)
            : null;
    }

    private static async Task<T?> ReadJsonAsync<T>(HttpListenerRequest request, CancellationToken cancellationToken)
    {
        if (request.ContentLength64 > 1024 * 1024) return default;
        using var reader = new StreamReader(request.InputStream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
        var raw = await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(raw)) return default;
        try { return JsonSerializer.Deserialize<T>(raw, JsonOptions.Wire); }
        catch (JsonException) { return default; }
    }
}
