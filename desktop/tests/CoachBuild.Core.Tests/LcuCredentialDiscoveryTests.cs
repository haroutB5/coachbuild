using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class LcuCredentialDiscoveryTests
{
    private const string RiotClientInstallsFixture = """
    {
      "associated_client": [
        "D:/Riot Games/League of Legends/LeagueClient.exe",
        "D:/Riot Games/Riot Client/RiotClientServices.exe"
      ],
      "rc_default": "D:/Riot Games/Riot Client/RiotClientServices.exe",
      "rc_live": "D:/Riot Games/Riot Client/RiotClientServices.exe",
      "KeystoneLocationLiveWin": "D:/Riot Games/League of Legends"
    }
    """;

    private const string ProductSettingsFixture = """
    # Riot product metadata is YAML, not JSON.
    product_install_full_path: "D:/Riot Games/League of Legends"
    product_install_root: "D:/Riot Games"
    """;

    [Fact]
    public void Riot_install_manifest_and_product_settings_parsers_accept_real_shaped_fixtures()
    {
        var paths = LcuCredentialParser.ParseRiotClientInstallsJson(RiotClientInstallsFixture);

        Assert.Contains("D:/Riot Games/League of Legends/LeagueClient.exe", paths);
        Assert.Contains("D:/Riot Games/Riot Client/RiotClientServices.exe", paths);
        Assert.Equal("D:/Riot Games/League of Legends", LcuCredentialParser.ParseProductSettingsYaml(ProductSettingsFixture));
    }

    [Fact]
    public void Malformed_install_metadata_is_fail_soft()
    {
        Assert.Empty(LcuCredentialParser.ParseRiotClientInstallsJson("{\"associated_client\":[}"));
        Assert.Empty(LcuCredentialParser.ParseRiotClientInstallsJson(null));
        Assert.Null(LcuCredentialParser.ParseProductSettingsYaml("product_install_full_path: \"D:/Riot Games"));
        Assert.Null(LcuCredentialParser.ParseProductSettingsYaml("product_install_root: D:/Riot Games"));
    }

    [Fact]
    public void Lockfile_reader_can_read_while_lcu_holds_file_open_for_writing()
    {
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "lockfile");
            const string contents = "LeagueClient:1:54443:shared-token:https";
            File.WriteAllText(path, contents);

            using (var lcuHold = new FileStream(
                       path,
                       FileMode.Open,
                       FileAccess.ReadWrite,
                       FileShare.ReadWrite | FileShare.Delete))
            {
                Assert.Equal(contents, LcuCredentialParser.ReadLockfile(path));
            }
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public async Task Lockfile_reader_retries_once_when_initial_content_is_empty()
    {
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "lockfile");
            const string contents = "LeagueClient:1:54444:retry-token:https";
            using (var lcuHold = new FileStream(
                       path,
                       FileMode.Create,
                       FileAccess.ReadWrite,
                       FileShare.ReadWrite | FileShare.Delete))
            {
                lcuHold.Flush();

                var writerStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                var writer = Task.Run(
                    async () =>
                    {
                        writerStarted.SetResult(true);
                        await Task.Delay(40);
                        var bytes = System.Text.Encoding.UTF8.GetBytes(contents);
                        lcuHold.Position = 0;
                        lcuHold.Write(bytes);
                        lcuHold.SetLength(bytes.Length);
                        lcuHold.Flush();
                    });
                await writerStarted.Task;

                Assert.Equal(contents, LcuCredentialParser.ReadLockfile(path));
                await writer;
            }
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Lockfile_reason_reports_unreadable_exception_for_exclusive_file()
    {
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "lockfile");
            File.WriteAllText(path, "LeagueClient:1:54445:exclusive-token:https");
            using (var exclusiveHold = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                var diagnostics = new List<string>();
                var resolver = new LcuCredentialResolver(
                    processSource: new FixedProcessSource(),
                    lockfilePath: path,
                    programDataDirectory: Path.Combine(root, "ProgramData"),
                    fixedDriveLockfilePathsProvider: static () => Array.Empty<string>(),
                    diagnosticSink: diagnostics.Add);

                Assert.Null(resolver.Resolve());
                using var line = JsonDocument.Parse(diagnostics.Single());
                var reason = line.RootElement.GetProperty("layers")[1].GetProperty("reason").GetString();
                Assert.Contains("unreadable:IOException", reason, StringComparison.Ordinal);
            }
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Lockfile_reason_reports_missing_for_absent_file()
    {
        var root = MakeTempDirectory();
        try
        {
            var path = Path.Combine(root, "missing-lockfile");
            var diagnostics = new List<string>();
            var resolver = new LcuCredentialResolver(
                processSource: new FixedProcessSource(),
                lockfilePath: path,
                programDataDirectory: Path.Combine(root, "ProgramData"),
                fixedDriveLockfilePathsProvider: static () => Array.Empty<string>(),
                diagnosticSink: diagnostics.Add);

            Assert.Null(resolver.Resolve());
            using var line = JsonDocument.Parse(diagnostics.Single());
            var reason = line.RootElement.GetProperty("layers")[1].GetProperty("reason").GetString();
            Assert.Contains("=missing", reason, StringComparison.Ordinal);
            Assert.DoesNotContain("missing-or-unreadable", reason, StringComparison.Ordinal);
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Riot_metadata_layer_finds_lockfile_on_a_non_default_path()
    {
        var root = MakeTempDirectory();
        try
        {
            var programData = Path.Combine(root, "ProgramData");
            var leagueDirectory = Path.Combine(root, "Games", "League of Legends");
            Directory.CreateDirectory(Path.Combine(programData, "Riot Games", "Metadata", "league_of_legends.live"));
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
                Path.Combine(programData, "Riot Games", "Metadata", "league_of_legends.live", "league_of_legends.live.product_settings.yaml"),
                $"product_install_full_path: \"{leaguePath}\"\nproduct_install_root: \"{Path.GetDirectoryName(leaguePath)?.Replace('\\', '/')}\"\n");
            File.WriteAllText(Path.Combine(leagueDirectory, "lockfile"), "LeagueClient:1:54444:registry-token:https");

            var resolver = new LcuCredentialResolver(
                processSource: new FixedProcessSource(),
                lockfileReader: LcuCredentialParser.ReadLockfile,
                programDataDirectory: programData,
                metadataReader: LcuCredentialParser.ReadLockfile,
                fixedDriveLockfilePathsProvider: static () => Array.Empty<string>());

            var credentials = resolver.Resolve();

            Assert.Equal(54444, credentials?.Port);
            Assert.Equal("lockfile", credentials?.Source);
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Malformed_manifest_falls_through_to_valid_product_settings()
    {
        var root = MakeTempDirectory();
        try
        {
            var programData = Path.Combine(root, "ProgramData");
            var leagueDirectory = Path.Combine(root, "Moved", "League of Legends");
            var metadataDirectory = Path.Combine(programData, "Riot Games", "Metadata", "league_of_legends.live");
            Directory.CreateDirectory(metadataDirectory);
            Directory.CreateDirectory(leagueDirectory);
            File.WriteAllText(Path.Combine(programData, "Riot Games", "RiotClientInstalls.json"), "{malformed");
            File.WriteAllText(
                Path.Combine(metadataDirectory, "league_of_legends.live.product_settings.yaml"),
                $"product_install_full_path: \"{leagueDirectory.Replace('\\', '/')}\"\n");
            File.WriteAllText(Path.Combine(leagueDirectory, "lockfile"), "LeagueClient:1:54445:yaml-token:https");

            var resolver = new LcuCredentialResolver(
                processSource: new FixedProcessSource(),
                programDataDirectory: programData,
                metadataReader: LcuCredentialParser.ReadLockfile,
                fixedDriveLockfilePathsProvider: static () => Array.Empty<string>());

            Assert.Equal("yaml-token", resolver.Resolve()?.Token);
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Process_name_variants_are_supported()
    {
        var resolver = new LcuCredentialResolver(
            new FixedProcessSource(new LeagueClientProcess(
                "LeagueClientUxRender.exe", "--app-port=54446 --remoting-auth-token=render-token")),
            lockfileReader: static _ => null,
            lockfilePath: Path.Combine(Path.GetTempPath(), "missing-hardcoded-lockfile"),
            metadataReader: static _ => null,
            fixedDriveLockfilePathsProvider: static () => Array.Empty<string>());

        var credentials = resolver.Resolve();

        Assert.Equal(54446, credentials?.Port);
        Assert.Equal("process-args", credentials?.Source);
    }

    [Fact]
    public void Empty_wmi_command_line_falls_through_to_cached_fixed_drive_candidates()
    {
        var root = MakeTempDirectory();
        try
        {
            var fixedDriveLockfile = Path.Combine(root, "D", "Riot Games", "League of Legends", "lockfile");
            Directory.CreateDirectory(Path.GetDirectoryName(fixedDriveLockfile)!);
            File.WriteAllText(fixedDriveLockfile, "LeagueClient:1:54447:fixed-drive-token:https");
            var fixedDriveEnumerations = 0;

            var resolver = new LcuCredentialResolver(
                new FixedProcessSource(new LeagueClientProcess("LeagueClientUx.exe", null)),
                lockfileReader: LcuCredentialParser.ReadLockfile,
                lockfilePath: Path.Combine(root, "not-the-fixed-drive-lockfile"),
                metadataReader: static _ => null,
                fixedDriveLockfilePathsProvider: () =>
                {
                    fixedDriveEnumerations++;
                    return [fixedDriveLockfile];
                });

            Assert.Equal("fixed-drive-token", resolver.Resolve()?.Token);
            resolver.Invalidate();
            Assert.Equal("fixed-drive-token", resolver.Resolve()?.Token);
            Assert.Equal(1, fixedDriveEnumerations);
        }
        finally
        {
            DeleteTempDirectory(root);
        }
    }

    [Fact]
    public void Failed_full_resolve_emits_one_structured_line_per_failure_edge()
    {
        var diagnostics = new List<string>();
        var resolver = new LcuCredentialResolver(
            new FixedProcessSource(new LeagueClientProcess("LeagueClientUxRender.exe", null)),
            lockfileReader: static _ => null,
            lockfilePath: Path.Combine(Path.GetTempPath(), "missing-hardcoded-lockfile"),
            metadataReader: static _ => null,
            fixedDriveLockfilePathsProvider: static () => Array.Empty<string>(),
            diagnosticSink: diagnostics.Add);

        Assert.Null(resolver.Resolve());
        resolver.Invalidate();
        Assert.Null(resolver.Resolve());
        Assert.Single(diagnostics);

        using var line = JsonDocument.Parse(diagnostics[0]);
        var layers = line.RootElement.GetProperty("layers");
        Assert.Equal(4, layers.GetArrayLength());
        Assert.Equal(
            ["riot-install-registry", "hardcoded-lockfiles", "wmi-process-commandline", "fixed-drive-lockfiles"],
            layers.EnumerateArray().Select(layer => layer.GetProperty("layer").GetString() ?? string.Empty).ToArray());
        Assert.Contains("command-line-empty", layers[2].GetProperty("reason").GetString(), StringComparison.Ordinal);
    }

    private static string MakeTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"CoachBuild-LcuDiscovery-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteTempDirectory(string path)
    {
        try { Directory.Delete(path, recursive: true); } catch { }
    }

    private sealed class FixedProcessSource(params LeagueClientProcess[] values) : ILeagueClientProcessSource
    {
        public IEnumerable<LeagueClientProcess> GetProcesses() => values;
    }
}
