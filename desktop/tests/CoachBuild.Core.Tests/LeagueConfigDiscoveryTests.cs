using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Finding League's <c>Config</c> directory without guessing.
///
/// <para><b>Why the guesses are not good enough.</b> The shipped candidate list
/// is a hardcoded <c>C:\Riot Games\...</c>, two Program Files variants, and the
/// ROOT of every fixed drive. A League installed at, say,
/// <c>D:\Games\Riot Games\League of Legends</c> matches none of them — and the
/// consequence is not a missing feature but a WRONG one: ShopBindResolver falls
/// back to League's default <c>P</c> and the watcher polls a key the player does
/// not use for the rest of the session.</para>
///
/// <para>Riot publishes the answer, and this assembly already reads it: the
/// lockfile discovery in <see cref="LcuCredentialDiscovery"/> parses
/// <c>product_install_full_path</c> out of the product-settings YAML and the
/// path entries out of <c>RiotClientInstalls.json</c>. Only this locator was
/// still guessing.</para>
/// </summary>
public sealed class LeagueConfigDiscoveryTests
{
    [Fact]
    public void The_product_settings_manifest_finds_League_on_any_drive()
    {
        var programData = NewProgramData(
            productSettings: "product_install_full_path: \"D:\\\\Games\\\\Riot Games\\\\League of Legends\"\n");
        try
        {
            var candidates = LeagueConfigLocator.ManifestCandidates(TryRead, programData);

            Assert.Contains(
                Path.Combine(@"D:\Games\Riot Games\League of Legends", "Config"),
                candidates,
                StringComparer.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    [Fact]
    public void The_manifest_answer_is_tried_before_every_hardcoded_guess()
    {
        // Ordering is the whole point. C:\Riot Games\League of Legends\Config
        // is the first guess and it can exist as a leftover from an install
        // that has since moved; the vendor's own record of where League is
        // must beat a directory that merely exists.
        var programData = NewProgramData(
            productSettings: "product_install_full_path: D:\\Games\\Riot Games\\League of Legends\n");
        try
        {
            var candidates = LeagueConfigLocator.Candidates(null, TryRead, programData);
            var manifest = candidates.ToList()
                .FindIndex(path => path.Contains(@"D:\Games", StringComparison.OrdinalIgnoreCase));
            var hardcoded = candidates.ToList()
                .FindIndex(path => path.StartsWith(@"C:\Riot Games", StringComparison.OrdinalIgnoreCase));

            Assert.True(manifest >= 0, "the manifest path is not a candidate at all");
            Assert.True(hardcoded >= 0, "the hardcoded path stopped being a candidate");
            Assert.True(manifest < hardcoded, $"manifest at {manifest} must precede hardcoded at {hardcoded}");
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    [Fact]
    public void A_Riot_Client_executable_path_still_locates_League_beside_it()
    {
        // RiotClientInstalls.json holds Riot CLIENT paths, not League's, so the
        // League folder is a sibling. Every plausible reading is offered rather
        // than one being chosen: Find takes the first that exists, and a
        // directory probe is free next to being wrong for a whole session.
        var programData = NewProgramData(
            riotClientInstalls: """
            { "rc_live": "D:\\Games\\Riot Games\\Riot Client\\RiotClientServices.exe" }
            """);
        try
        {
            var candidates = LeagueConfigLocator.ManifestCandidates(TryRead, programData);

            Assert.Contains(
                Path.Combine(@"D:\Games\Riot Games", "League of Legends", "Config"),
                candidates,
                StringComparer.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    [Fact]
    public void Find_prefers_a_manifest_directory_that_exists_over_one_that_does_not()
    {
        var programData = NewProgramData(
            productSettings: "product_install_full_path: D:\\Games\\Riot Games\\League of Legends\n");
        try
        {
            var wanted = Path.Combine(@"D:\Games\Riot Games\League of Legends", "Config");
            var found = LeagueConfigLocator.Find(
                directoryExists: path => string.Equals(path, wanted, StringComparison.OrdinalIgnoreCase),
                explicitOverride: null,
                readFile: TryRead,
                programDataDirectory: programData);

            Assert.Equal(wanted, found, StringComparer.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    [Fact]
    public void Unreadable_or_malformed_manifests_never_break_discovery()
    {
        // The manifests are vendor-owned files this app does not control. A
        // partially written or future-shaped one must cost one candidate, not
        // the whole search — the guesses below it still have to run.
        var programData = NewProgramData(
            productSettings: "this: is: not: what: we: expect\n",
            riotClientInstalls: "{ not json at all");
        try
        {
            Assert.Empty(LeagueConfigLocator.ManifestCandidates(TryRead, programData));
            Assert.Contains(
                @"C:\Riot Games\League of Legends\Config",
                LeagueConfigLocator.Candidates(null, TryRead, programData),
                StringComparer.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    [Fact]
    public void An_explicit_override_still_beats_everything()
    {
        var programData = NewProgramData(
            productSettings: "product_install_full_path: D:\\Games\\Riot Games\\League of Legends\n");
        try
        {
            var candidates = LeagueConfigLocator.Candidates(@"E:\Mine\Config", TryRead, programData);
            Assert.Equal(@"E:\Mine\Config", candidates[0]);
        }
        finally
        {
            Directory.Delete(programData, recursive: true);
        }
    }

    private static string? TryRead(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    private static string NewProgramData(string? productSettings = null, string? riotClientInstalls = null)
    {
        var root = Path.Combine(Path.GetTempPath(), $"coachbuild-progdata-{Guid.NewGuid():N}");
        var riot = Path.Combine(root, "Riot Games");
        Directory.CreateDirectory(riot);
        if (riotClientInstalls is not null)
            File.WriteAllText(Path.Combine(riot, "RiotClientInstalls.json"), riotClientInstalls);
        if (productSettings is not null)
        {
            var metadata = Path.Combine(riot, "Metadata", "league_of_legends.live");
            Directory.CreateDirectory(metadata);
            File.WriteAllText(
                Path.Combine(metadata, "league_of_legends.live.product_settings.yaml"),
                productSettings);
        }

        return root;
    }
}
