using System.Text.Json;
using System.Text.RegularExpressions;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// Two failure modes this repo has already paid for once each, turned into
/// assertions.
///
/// <para><b>Drift.</b> <see cref="ChampionKit"/>'s table is a transcription of
/// ddragon <c>maxrank</c> values, measured by hand at patch 16.14.1. Nothing
/// re-checked it afterwards, so a Riot rework that gives a champion a fourth R
/// rank — or ships a new champion with a free one — would be wrong here and
/// silent everywhere: the overlay would read that champion's points as
/// incoherent for the whole game. These tests re-check it against a checked-in
/// full-roster derivation (<c>fixtures/champion-kit-derived.json</c>) so the
/// suite stays offline; <c>scripts/refresh-champion-kits.mjs</c> is the online
/// half and belongs in maintenance, not here.</para>
///
/// <para><b>The 18-point floor.</b> A champion has exactly one ability point
/// per level, so a kit whose purchasable ranks total less than
/// <see cref="ChampionKit.TotalLevels"/> describes a champion who cannot spend
/// every point they are given. That is not a modelling curiosity — the web's
/// <c>lib/skillOrderModel.ts</c> refuses <c>kit-not-derivable</c> for exactly
/// that condition, so such a champion gets NO published skill order, the
/// desktop logs <c>no-skill-order</c>, and the highlight never draws. That is
/// the Jayce blank-overlay incident, and the cheapest-looking "fix" for the
/// 2026-08-19 Kennen anomaly (<c>[85] = new(5, 5, 5, 3, 1)</c>) reintroduces
/// it exactly, at total 17. It fails here, at commit time, instead of in
/// somebody's game.</para>
///
/// <para><b>Port parity.</b> The desktop table and
/// <c>MEASURED_CHAMPION_KIT_SPECS</c> in <c>lib/championKit.ts</c> are the same
/// data twice, and the C# file's own doc-comment says they must not drift apart
/// — while nothing checked that they had not. The parity test READS the
/// TypeScript rather than restating it, so editing one side and not the other
/// fails rather than diverges. Its twin, reading this file from the web suite,
/// lives in <c>lib/__tests__/championKitDrift.test.ts</c>: whichever of the two
/// ecosystems a change is made in, that ecosystem's own suite catches it.</para>
/// </summary>
public sealed class ChampionKitDriftTests
{
    private const int Kennen = 85;
    private const int Jayce = 126;
    private static readonly int[] StandardShape = [5, 5, 5, 3];

    private sealed record DerivedChampion(
        int Id,
        string Key,
        IReadOnlyList<int> MaxRanks,
        int FreeR,
        int PurchasableTotal);

    private sealed record DerivedRoster(string Patch, IReadOnlyList<DerivedChampion> Champions);

    private static readonly Lazy<DerivedRoster> Roster = new(LoadFixture);

    // ------------------------------------------------------- anti-vacuous gate

    /// <summary>
    /// Every other test in this class is a "for each" over the fixture, and a
    /// "for each" over nothing passes. This is the test that makes the rest of
    /// them mean something: a fixture that failed to parse, got truncated, or
    /// was replaced by an empty roster fails HERE rather than turning eight
    /// green assertions into eight assertions about the empty set.
    /// </summary>
    [Fact]
    public void The_fixture_is_a_full_roster_and_not_an_empty_parse()
    {
        var roster = Roster.Value;

        Assert.False(string.IsNullOrWhiteSpace(roster.Patch));
        Assert.True(
            roster.Champions.Count >= 170,
            $"the derived roster has {roster.Champions.Count} champions; that is not a League roster");
        Assert.Equal(roster.Champions.Count, roster.Champions.Select(c => c.Id).Distinct().Count());

        // Named landmarks: the standard case, and the champion whose free rank
        // is the reason this module exists.
        Assert.Contains(roster.Champions, c => c.Id == Kennen && c.Key == "Kennen");
        var jayce = Assert.Single(roster.Champions, c => c.Id == Jayce);
        Assert.Equal([6, 6, 6, 1], jayce.MaxRanks);
        Assert.Equal(1, jayce.FreeR);

        // Seven off-model champions were measured at 16.14.1. If the roster
        // ever holds fewer, the derivation lost its free-rank semantics.
        Assert.True(NonStandard(roster).Count >= 7);
    }

    // ------------------------------------------------------------ D1: no stale

    /// <summary>
    /// Every id the desktop table claims to have measured still has those caps
    /// and that free-rank count on the derived roster.
    /// </summary>
    [Fact]
    public void No_measured_entry_has_gone_stale_against_the_derived_roster()
    {
        var byId = Roster.Value.Champions.ToDictionary(c => c.Id);
        var stale = new List<string>();

        foreach (var (id, kit) in ChampionKit.MeasuredKits)
        {
            if (!byId.TryGetValue(id, out var derived))
            {
                stale.Add($"id {id} is in the table but not on the {Roster.Value.Patch} roster");
                continue;
            }

            var table = new[] { kit.MaxQ, kit.MaxW, kit.MaxE, kit.MaxR };
            if (!table.SequenceEqual(derived.MaxRanks))
                stale.Add($"{derived.Key} ({id}) caps {Join(table)} but ddragon says {Join(derived.MaxRanks)}");
            if (kit.FreeR != derived.FreeR)
                stale.Add($"{derived.Key} ({id}) freeR {kit.FreeR} but ddragon says {derived.FreeR}");
        }

        Assert.Empty(stale);
    }

    // ---------------------------------------------------------- D2: no missing

    /// <summary>
    /// The test that catches a genuinely NEW off-model champion. A champion
    /// whose caps are not 5/5/5/3 and who is absent from the table is read as
    /// standard, which is the exact shape of the Jayce failure.
    /// </summary>
    [Fact]
    public void Every_off_model_champion_on_the_roster_is_in_the_table()
    {
        var missing = NonStandard(Roster.Value)
            .Where(c => !ChampionKit.MeasuredKits.ContainsKey(c.Id))
            .Select(c => $"{c.Key} ({c.Id}) {Join(c.MaxRanks)}")
            .ToList();

        Assert.Empty(missing);
    }

    // -------------------------------------------------------------- D3: shapes

    /// <summary>
    /// The free-rank semantics on both sides of the port are keyed on R's own
    /// maxrank, and they only cover {1, 3, 4, 6}. A rework outside that set is
    /// a shape neither side can resolve, and the web's <c>kitFromMaxRanks</c>
    /// returns null for it — a refusal, which is correct, but one nobody would
    /// notice until a player reported a blank overlay.
    /// </summary>
    [Fact]
    public void Every_r_maxrank_on_the_roster_is_a_shape_the_semantics_cover()
    {
        var unresolvable = Roster.Value.Champions
            .Where(c => c.MaxRanks[3] is not (1 or 3 or 4 or 6))
            .Select(c => $"{c.Key} ({c.Id}) R maxrank {c.MaxRanks[3]}")
            .ToList();

        Assert.Empty(unresolvable);
    }

    // ------------------------------------------------- D4: the 18-point floor

    /// <summary>
    /// No table entry may describe a champion who cannot spend all 18 points.
    /// See the class remarks: below the floor the web publishes no skill order
    /// at all and the overlay is permanently blank for that champion.
    /// </summary>
    [Fact]
    public void No_measured_kit_falls_below_the_eighteen_point_floor()
    {
        var below = ChampionKit.MeasuredKits
            .Where(pair => pair.Value.PurchasableTotal < ChampionKit.TotalLevels)
            .Select(pair => $"id {pair.Key} totals {pair.Value.PurchasableTotal}")
            .ToList();

        Assert.Empty(below);
        Assert.True(ChampionKit.Standard.PurchasableTotal >= ChampionKit.TotalLevels);
    }

    [Fact]
    public void No_champion_on_the_roster_falls_below_the_eighteen_point_floor()
    {
        var below = Roster.Value.Champions
            .Where(c => c.PurchasableTotal < ChampionKit.TotalLevels)
            .Select(c => $"{c.Key} ({c.Id}) totals {c.PurchasableTotal}")
            .ToList();

        Assert.Empty(below);
    }

    /// <summary>
    /// The tripwire, stated as the thing it is meant to stop.
    ///
    /// <para>Giving Kennen a free R rank to make one game's log read coherent
    /// yields 5 + 5 + 5 + (3 − 1) = 17. ddragon 16.16.1 says he is 5/5/5/3 with
    /// no free rank, and 17 is not a shape League contains — it would strand a
    /// point at level 18. The guard above is what refuses it; this names it so
    /// the next person to reach for that edit finds the reason rather than a
    /// bare red test.</para>
    /// </summary>
    [Fact]
    public void A_free_rank_bolted_onto_a_five_five_five_three_champion_is_below_the_floor()
    {
        var cheapKennenFix = new ChampionKit(5, 5, 5, 3, 1);

        Assert.Equal(17, cheapKennenFix.PurchasableTotal);
        Assert.True(cheapKennenFix.PurchasableTotal < ChampionKit.TotalLevels);

        // And the shipped table does not contain it.
        Assert.False(ChampionKit.MeasuredKits.ContainsKey(Kennen));
        Assert.Same(ChampionKit.Standard, ChampionKit.For(Kennen));
    }

    // ------------------------------------------------------------ X1: parity

    /// <summary>
    /// The desktop table against <c>MEASURED_CHAMPION_KIT_SPECS</c> in
    /// <c>lib/championKit.ts</c>, read out of the TypeScript source rather than
    /// restated here. The free-rank counts are likewise derived from that
    /// file's own <c>ULTIMATE_SEMANTICS</c>, so this compares the two shipped
    /// tables and not two copies of one opinion.
    /// </summary>
    [Fact]
    public void The_desktop_table_and_the_web_table_are_the_same_data()
    {
        var (specs, semantics) = ParseWebChampionKit();

        // The parse itself must be believed before its result is. A regex that
        // matched nothing would make every comparison below pass.
        Assert.Equal([1, 3, 4, 6], semantics.Keys.OrderBy(k => k).ToArray());
        Assert.True(specs.Count >= 8, $"parsed only {specs.Count} entries out of lib/championKit.ts");

        var differences = new List<string>();

        foreach (var (id, kit) in ChampionKit.MeasuredKits)
        {
            if (!specs.TryGetValue(id, out var spec))
            {
                differences.Add($"id {id} is in ChampionKit.cs but not in MEASURED_CHAMPION_KIT_SPECS");
                continue;
            }

            var desktop = new[] { kit.MaxQ, kit.MaxW, kit.MaxE, kit.MaxR };
            if (!desktop.SequenceEqual(spec.MaxRanks))
                differences.Add($"{spec.Key} ({id}) desktop {Join(desktop)} vs web {Join(spec.MaxRanks)}");

            var webFreeR = semantics[spec.MaxRanks[3]];
            if (kit.FreeR != webFreeR)
                differences.Add($"{spec.Key} ({id}) desktop freeR {kit.FreeR} vs web {webFreeR}");
        }

        foreach (var (id, spec) in specs)
        {
            if (!ChampionKit.MeasuredKits.ContainsKey(id))
                differences.Add($"{spec.Key} ({id}) is in MEASURED_CHAMPION_KIT_SPECS but not in ChampionKit.cs");
        }

        Assert.Empty(differences);
    }

    /// <summary>
    /// The fixture's free-rank counts were produced by the same R-keyed rule
    /// the web ships, not by a second opinion living in the derivation script.
    /// Without this, a refresh could silently adopt different semantics and
    /// still satisfy every comparison above.
    /// </summary>
    [Fact]
    public void The_fixtures_free_ranks_follow_the_webs_own_ultimate_semantics()
    {
        var (_, semantics) = ParseWebChampionKit();
        var disagreements = Roster.Value.Champions
            .Where(c => !semantics.TryGetValue(c.MaxRanks[3], out var free) || free != c.FreeR)
            .Select(c => $"{c.Key} ({c.Id}) R{c.MaxRanks[3]} freeR {c.FreeR}")
            .ToList();

        Assert.Empty(disagreements);
    }

    // ------------------------------------------------------------------ plumbing

    private static IReadOnlyList<DerivedChampion> NonStandard(DerivedRoster roster) =>
        roster.Champions.Where(c => !c.MaxRanks.SequenceEqual(StandardShape)).ToList();

    private static string Join(IEnumerable<int> values) => string.Join("/", values);

    private static DerivedRoster LoadFixture()
    {
        var path = RunePayloadValidationTests.FindRepoFile(
            Path.Combine("fixtures", "champion-kit-derived.json"));
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var root = document.RootElement;
        var champions = new List<DerivedChampion>();

        foreach (var entry in root.GetProperty("champions").EnumerateArray())
        {
            var maxRanks = entry.GetProperty("maxRanks").EnumerateArray().Select(v => v.GetInt32()).ToArray();
            champions.Add(new DerivedChampion(
                entry.GetProperty("id").GetInt32(),
                entry.GetProperty("key").GetString() ?? string.Empty,
                maxRanks,
                entry.GetProperty("freeR").GetInt32(),
                entry.GetProperty("purchasableTotal").GetInt32()));
        }

        return new DerivedRoster(root.GetProperty("ddragonPatch").GetString() ?? string.Empty, champions);
    }

    private sealed record WebSpec(string Key, IReadOnlyList<int> MaxRanks);

    private static (IReadOnlyDictionary<int, WebSpec> Specs, IReadOnlyDictionary<int, int> Semantics)
        ParseWebChampionKit()
    {
        var source = File.ReadAllText(
            RunePayloadValidationTests.FindRepoFile(Path.Combine("lib", "championKit.ts")));

        var specs = new Dictionary<int, WebSpec>();
        foreach (Match match in Regex.Matches(
                     Section(source, "MEASURED_CHAMPION_KIT_SPECS", "]);"),
                     """\[\s*(\d+)\s*,\s*\{\s*championKey:\s*"([^"]+)"\s*,\s*maxRanks:\s*\[\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\]"""))
        {
            specs[int.Parse(match.Groups[1].Value)] = new WebSpec(
                match.Groups[2].Value,
                [
                    int.Parse(match.Groups[3].Value),
                    int.Parse(match.Groups[4].Value),
                    int.Parse(match.Groups[5].Value),
                    int.Parse(match.Groups[6].Value),
                ]);
        }

        var semantics = new Dictionary<int, int>();
        foreach (Match match in Regex.Matches(
                     Section(source, "const ULTIMATE_SEMANTICS", "\n};"),
                     @"(\d+):\s*\{\s*levels:[^}]*?free:\s*(\d+)"))
        {
            semantics[int.Parse(match.Groups[1].Value)] = int.Parse(match.Groups[2].Value);
        }

        return (specs, semantics);
    }

    /// <summary>
    /// The named declaration only. Scoping the regexes matters: this file holds
    /// several maps, and a pattern let loose over the whole of it would happily
    /// collect entries from the wrong one.
    /// </summary>
    private static string Section(string source, string declaration, string terminator)
    {
        var start = source.IndexOf(declaration, StringComparison.Ordinal);
        Assert.True(start >= 0, $"{declaration} is gone from lib/championKit.ts");
        var end = source.IndexOf(terminator, start, StringComparison.Ordinal);
        Assert.True(end > start, $"{declaration} has no {terminator} terminator in lib/championKit.ts");
        return source[start..end];
    }
}
