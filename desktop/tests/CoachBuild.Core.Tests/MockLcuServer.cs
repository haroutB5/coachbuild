using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;

namespace CoachBuild.Core.Tests;

public sealed record MockLcuCall(HttpMethod Method, string Path, JsonElement? Body);

/// <summary>Deterministic ILcuApi fixture used by write-service tests.</summary>
public sealed class MockLcuApi : ILcuApi
{
    private readonly object _gate = new();
    private readonly Dictionary<string, Queue<LcuResponse>> _responses = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Func<object?, LcuResponse>> _handlers = new(StringComparer.Ordinal);

    public List<MockLcuCall> Calls { get; } = [];

    public void Enqueue(HttpMethod method, string path, LcuResponse response)
    {
        lock (_gate)
        {
            var key = Key(method, path);
            if (!_responses.TryGetValue(key, out var queue)) _responses[key] = queue = new Queue<LcuResponse>();
            queue.Enqueue(response);
        }
    }

    public void Handle(HttpMethod method, string path, Func<object?, LcuResponse> handler) =>
        _handlers[Key(method, path)] = handler;

    public Task<LcuResponse> SendAsync(HttpMethod method, string path, object? body = null, CancellationToken cancellationToken = default)
    {
        JsonElement? bodyElement = null;
        if (body is not null)
        {
            var json = JsonSerializer.Serialize(body, JsonOptions.Wire);
            using var document = JsonDocument.Parse(json);
            bodyElement = document.RootElement.Clone();
        }
        lock (_gate)
        {
            Calls.Add(new MockLcuCall(method, path, bodyElement));
            var key = Key(method, path);
            if (_handlers.TryGetValue(key, out var handler)) return Task.FromResult(handler(body));
            if (_responses.TryGetValue(key, out var queue) && queue.Count > 0) return Task.FromResult(queue.Dequeue());
            return Task.FromResult(new LcuResponse(false, 404));
        }
    }

    public int Count(HttpMethod method, string path) =>
        Calls.Count(x => x.Method == method && string.Equals(x.Path, path, StringComparison.Ordinal));

    public static JsonElement Json(string raw)
    {
        using var document = JsonDocument.Parse(raw);
        return document.RootElement.Clone();
    }

    private static string Key(HttpMethod method, string path) => $"{method.Method} {path}";
}

/// <summary>
/// Small real loopback HTTP fixture for LcuHttpClient and bridge replay tests.
/// It uses HTTP in tests; production clients remain HTTPS with loopback-only
/// certificate bypasses.
/// </summary>
public sealed class MockLcuServer : IAsyncDisposable
{
    private readonly HttpListener _listener = new();
    private readonly CancellationTokenSource _stop = new();
    private Task? _worker;
    private int _port;

    public string Phase { get; set; } = "None";
    public JsonElement ChampSelectSession { get; set; } = MockLcuApi.Json("{}");
    public JsonElement CurrentSummoner { get; set; } = MockLcuApi.Json("{\"summonerId\":1,\"gameName\":\"test\",\"tagLine\":\"EUW\",\"puuid\":\"p\"}");
    public JsonObject ItemSets { get; set; } = new() { ["accountId"] = 1, ["timestamp"] = 1, ["itemSets"] = new JsonArray() };
    public List<JsonObject> RunePages { get; } = [];
    public List<string> Calls { get; } = [];

    public int Port => _port;
    public string Scheme => "http";

    public Task StartAsync()
    {
        if (_worker is not null) return Task.CompletedTask;
        using (var probe = new TcpListener(IPAddress.Loopback, 0))
        {
            probe.Start();
            _port = ((IPEndPoint)probe.LocalEndpoint).Port;
        }
        _listener.Prefixes.Add($"http://127.0.0.1:{_port}/");
        _listener.Start();
        _worker = Task.Run(RunAsync);
        return Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        try { _listener.Stop(); } catch { }
        if (_worker is not null)
        {
            try { await _worker.ConfigureAwait(false); } catch { }
        }
        _listener.Close();
        _stop.Dispose();
    }

    private async Task RunAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            HttpListenerContext context;
            try { context = await _listener.GetContextAsync().WaitAsync(_stop.Token).ConfigureAwait(false); }
            catch { break; }
            try { await HandleAsync(context).ConfigureAwait(false); }
            catch { try { context.Response.Close(); } catch { } }
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var path = request.Url?.AbsolutePath ?? string.Empty;
        Calls.Add($"{request.HttpMethod} {path}");
        JsonNode? payload = null;
        var status = 200;
        switch (path)
        {
            case "/lol-gameflow/v1/gameflow-phase":
                payload = JsonValue.Create(Phase);
                break;
            case "/lol-champ-select/v1/session":
                payload = JsonNode.Parse(ChampSelectSession.GetRawText());
                break;
            case "/lol-summoner/v1/current-summoner":
                payload = JsonNode.Parse(CurrentSummoner.GetRawText());
                break;
            case "/lol-perks/v1/pages":
                if (request.HttpMethod == "GET") payload = new JsonArray(RunePages.Select(x => x.DeepClone()).ToArray());
                else if (request.HttpMethod == "POST")
                {
                    var body = await ReadNodeAsync(request).ConfigureAwait(false) as JsonObject;
                    var newPageId = RunePages.Count == 0 ? 1 : RunePages.Max(x => x["id"]?.GetValue<int>() ?? 0) + 1;
                    body ??= new JsonObject();
                    body["id"] = newPageId;
                    body["isDeletable"] = true;
                    RunePages.Add(body);
                    payload = body.DeepClone();
                }
                break;
            case "/lol-perks/v1/inventory":
                payload = new JsonObject { ["ownedPageCount"] = 5 };
                break;
            case "/lol-perks/v1/currentpage":
                payload = RunePages.FirstOrDefault(x => x["current"]?.GetValue<bool>() == true)?.DeepClone() ?? new JsonObject();
                break;
            case var value when value.StartsWith("/lol-perks/v1/pages/", StringComparison.Ordinal):
                var idText = value["/lol-perks/v1/pages/".Length..];
                if (request.HttpMethod == "DELETE" && int.TryParse(idText, out var id))
                {
                    RunePages.RemoveAll(x => x["id"]?.GetValue<int>() == id);
                    payload = new JsonObject();
                }
                else if (request.HttpMethod == "PUT" && int.TryParse(idText, out id))
                {
                    var body = await ReadNodeAsync(request).ConfigureAwait(false) as JsonObject;
                    var page = RunePages.FirstOrDefault(x => x["id"]?.GetValue<int>() == id);
                    if (page is null) status = 404;
                    else if (body is not null)
                    {
                        foreach (var pair in body) page[pair.Key] = pair.Value?.DeepClone();
                        payload = page.DeepClone();
                    }
                }
                break;
            case var value when value.StartsWith("/lol-item-sets/v1/item-sets/", StringComparison.Ordinal):
                if (request.HttpMethod == "GET") payload = ItemSets.DeepClone();
                else if (request.HttpMethod == "PUT")
                {
                    ItemSets = await ReadNodeAsync(request).ConfigureAwait(false) as JsonObject ?? ItemSets;
                    payload = new JsonObject();
                }
                break;
            default:
                status = 404;
                payload = new JsonObject { ["error"] = "not-found" };
                break;
        }
        payload ??= new JsonObject();
        var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString(JsonOptions.Wire));
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/json";
        context.Response.ContentLength64 = bytes.Length;
        await context.Response.OutputStream.WriteAsync(bytes).ConfigureAwait(false);
        context.Response.Close();
    }

    private static async Task<JsonNode?> ReadNodeAsync(HttpListenerRequest request)
    {
        using var reader = new StreamReader(request.InputStream, Encoding.UTF8);
        var raw = await reader.ReadToEndAsync().ConfigureAwait(false);
        return string.IsNullOrWhiteSpace(raw) ? null : JsonNode.Parse(raw);
    }
}
