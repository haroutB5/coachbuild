using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;

namespace CoachBuild.Desktop;

public static class SelfTestRunner
{
    public static async Task<int> RunAsync()
    {
        var failures = new List<string>();
        string? temporaryDirectory = null;
        try
        {
            temporaryDirectory = Path.Combine(Path.GetTempPath(), $"CoachBuild-SelfTest-{Guid.NewGuid():N}");
            Directory.CreateDirectory(temporaryDirectory);
            TestCommandLineParsing(failures);
            TestCredentialSources(temporaryDirectory, failures);
            TestConverters(failures);
            TestMergeAndBusyGate(temporaryDirectory, failures);
            await TestBridgeAsync(failures).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            failures.Add($"unexpected {ex.GetType().Name}: {ex.Message}");
        }
        finally
        {
            if (temporaryDirectory is not null)
            {
                try { Directory.Delete(temporaryDirectory, recursive: true); } catch { }
            }
        }

        if (failures.Count > 0)
        {
            foreach (var failure in failures) Console.Error.WriteLine($"SelfTest FAIL: {failure}");
            return 1;
        }
        Console.WriteLine("SelfTest PASS");
        return 0;
    }

    private static void TestCommandLineParsing(List<string> failures)
    {
        var options = CommandLineOptions.Parse(["-SelfTest", "--repair-webview2", "--feed=https://example.invalid"]);
        Check(options.SelfTest && options.RepairWebView2 && options.Feed == "https://example.invalid", "command-line parsing", failures);
    }

    private static void TestCredentialSources(string temporaryDirectory, List<string> failures)
    {
        var lockfile = Path.Combine(temporaryDirectory, "lockfile");
        File.WriteAllText(lockfile, "LeagueClient:123:5555:lock-token:https");
        var process = new FixedProcessSource(new LeagueClientProcess("LeagueClientUx", "--app-port=6666 --remoting-auth-token=process-token"));
        var resolver = new LcuCredentialResolver(
            process,
            LcuCredentialParser.ReadLockfile,
            lockfile,
            programDataDirectory: Path.Combine(temporaryDirectory, "UnusedProgramData"),
            fixedDriveLockfilePathsProvider: static () => Array.Empty<string>());
        var fromLockfile = resolver.Resolve();
        Check(fromLockfile?.Port == 5555 && fromLockfile.Source == "lockfile", "lockfile credential source", failures);

        File.WriteAllText(lockfile, "malformed");
        resolver.Invalidate();
        var fromProcess = resolver.Resolve();
        Check(fromProcess?.Port == 6666 && fromProcess.Source == "process-args", "process-argument credential source", failures);
        Check(LcuCredentialParser.ParseProcessArguments(null) is null, "null process arguments", failures);
        resolver.Invalidate();
        _ = resolver.Resolve();
        Check(process.Calls == 2, "credential cache invalidation", failures);

        var programData = Path.Combine(temporaryDirectory, "ProgramData");
        var leagueDirectory = Path.Combine(temporaryDirectory, "Moved", "League of Legends");
        var metadataDirectory = Path.Combine(programData, "Riot Games", "Metadata", "league_of_legends.live");
        Directory.CreateDirectory(metadataDirectory);
        Directory.CreateDirectory(leagueDirectory);
        var leaguePath = leagueDirectory.Replace('\\', '/');
        File.WriteAllText(
            Path.Combine(programData, "Riot Games", "RiotClientInstalls.json"),
            $$"""
            {
              "associated_client": ["{{leaguePath}}/LeagueClient.exe", "{{leaguePath}}/../Riot Client/RiotClientServices.exe"],
              "rc_default": "{{leaguePath}}/../Riot Client/RiotClientServices.exe",
              "rc_live": "{{leaguePath}}/../Riot Client/RiotClientServices.exe"
            }
            """);
        File.WriteAllText(
            Path.Combine(metadataDirectory, "league_of_legends.live.product_settings.yaml"),
            $"product_install_full_path: \"{leaguePath}\"\n");
        File.WriteAllText(Path.Combine(leagueDirectory, "lockfile"), "LeagueClient:123:5556:metadata-token:https");
        var metadataResolver = new LcuCredentialResolver(
            processSource: new FixedProcessSource(),
            programDataDirectory: programData,
            metadataReader: LcuCredentialParser.ReadLockfile,
            fixedDriveLockfilePathsProvider: static () => Array.Empty<string>());
        var fromMetadata = metadataResolver.Resolve();
        Check(fromMetadata?.Port == 5556 && fromMetadata.Source == "lockfile", "Riot install metadata credential source", failures);
        Check(LcuCredentialParser.ParseRiotClientInstallsJson("{\"associated_client\":[}").Count == 0,
            "malformed Riot install manifest", failures);
        Check(LcuCredentialParser.ParseProductSettingsYaml("product_install_full_path: \"D:/Riot Games") is null,
            "malformed product settings", failures);
    }

    private static void TestConverters(List<string> failures)
    {
        using var skills = JsonDocument.Parse("""
        {"level":9,"abilities":{"Q":{"abilityLevel":3},"W":{"abilityLevel":2},"E":{"abilityLevel":2},"R":{"abilityLevel":1},"Passive":{}}}
        """);
        var converted = LiveSkillStateConverter.TryConvert(skills.RootElement);
        Check(converted?.Level == 9 && converted.Abilities.Q == 3 && converted.Abilities.R == 1, "all-or-nothing skill conversion", failures);
        using var partial = JsonDocument.Parse("{\"level\":9,\"abilities\":{\"Q\":{\"abilityLevel\":3}}}");
        Check(LiveSkillStateConverter.TryConvert(partial.RootElement) is null, "partial skill rejection", failures);
        using var identity = JsonDocument.Parse("{\"gameName\":\"Own\",\"tagLine\":\"EUW\",\"puuid\":\"p\",\"displayName\":\"ignored\"}");
        var own = OwnIdentityConverter.TryConvert(identity.RootElement);
        Check(own?.GameName == "Own" && own.Puuid == "p", "own identity conversion", failures);
    }

    private static void TestMergeAndBusyGate(string temporaryDirectory, List<string> failures)
    {
        var existing = JsonNode.Parse("{\"accountId\":1,\"itemSets\":[{\"title\":\"Foreign\"},{\"title\":\"CoachBuild Old\"}]}")!.AsObject();
        using var newSetDocument = JsonDocument.Parse("{\"title\":\"CoachBuild New\"}");
        var merged = ItemSetMergeService.Merge(existing, [newSetDocument.RootElement]);
        Check(merged["accountId"]!.GetValue<int>() == 1 && merged["itemSets"]!.AsArray().Count == 2, "bounded item-set merge", failures);

        var state = new CompanionState();
        var gate = new UpdateBusyGate(state);
        state.SetPhase("ChampSelect");
        Check(gate.IsCompanionBusy, "champ-select update gate", failures);
        state.SetPhase("None");
        using (gate.BeginLcuWrite()) Check(gate.IsCompanionBusy, "active LCU write update gate", failures);
        Check(!gate.IsCompanionBusy, "write gate release", failures);

        var store = new SessionTokenStore(temporaryDirectory);
        var first = store.GetOrCreate();
        var second = new SessionTokenStore(temporaryDirectory).GetOrCreate();
        Check(first == second && File.Exists(store.FilePath), "durable session token", failures);
    }

    private static async Task TestBridgeAsync(List<string> failures)
    {
        var state = new CompanionState();
        await using var server = new CompanionHttpServer("self-test-session", state, ports: [FindFreePort()]);
        await server.StartAsync().ConfigureAwait(false);
        using var client = new HttpClient { BaseAddress = new Uri($"http://127.0.0.1:{server.Port}") };
        using var request = new HttpRequestMessage(HttpMethod.Get, "/status?session=self-test-session");
        request.Headers.TryAddWithoutValidation("Origin", CompanionWire.AppOrigin);
        using var response = await client.SendAsync(request).ConfigureAwait(false);
        var raw = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        using var status = JsonDocument.Parse(raw);
        Check(response.StatusCode == HttpStatusCode.OK && status.RootElement.GetProperty("version").GetString() == CompanionWire.Version,
            "loopback status replay", failures);
        using var badOrigin = new HttpRequestMessage(HttpMethod.Options, "/status");
        badOrigin.Headers.TryAddWithoutValidation("Origin", "https://bad.invalid");
        using var rejected = await client.SendAsync(badOrigin).ConfigureAwait(false);
        Check(rejected.StatusCode == HttpStatusCode.Forbidden, "origin rejection", failures);
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static void Check(bool condition, string name, List<string> failures)
    {
        if (!condition) failures.Add(name);
    }

    private sealed class FixedProcessSource(params LeagueClientProcess[] values) : ILeagueClientProcessSource
    {
        public int Calls { get; private set; }
        public IEnumerable<LeagueClientProcess> GetProcesses()
        {
            Calls++;
            return values;
        }
    }
}
