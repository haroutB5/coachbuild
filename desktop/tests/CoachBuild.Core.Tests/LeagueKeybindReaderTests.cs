using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The bind parser, against League's REAL <c>input.ini</c> syntax.
///
/// <para>Every literal in this file was copied out of an actual
/// <c>C:\Riot Games\League of Legends\Config\input.ini</c> on the reference
/// machine, not invented and not taken from documentation. That matters: the
/// file uses at least five spellings the parser has to survive
/// (<c>[Ctrl] [TAB]</c> spaced, <c>[Shift][1]</c> unspaced, <c>[Alt][r],</c>
/// with a trailing comma, <c>[&lt;Unbound&gt;]</c>, and the bare word
/// <c>null</c>), and a fixture invented from the documented grammar would have
/// agreed with a parser that handles none of them.</para>
/// </summary>
public sealed class LeagueKeybindReaderTests
{
    private const uint VkGrave = 0xC0;
    private const uint VkP = 0x50;
    private const uint VkTab = 0x09;
    private const uint VkEscape = 0x1B;

    [Fact]
    public void The_reference_machines_own_shop_bind_is_grave_not_P()
    {
        // The whole reason this class exists. If this ever resolves to P the
        // feature ships dead for the person it was built for.
        var result = LeagueKeybindReader.Parse("[`]");

        Assert.Equal(LeagueKeybindProblem.None, result.Problem);
        var bind = Assert.Single(result.Binds);
        Assert.Equal(VkGrave, bind.VirtualKey);
        Assert.NotEqual(VkP, bind.VirtualKey);
        Assert.False(bind.Ctrl);
        Assert.False(bind.Shift);
        Assert.False(bind.Alt);
    }

    [Theory]
    // Punctuation / OEM virtual keys: the class of key a letters-only
    // comparison silently gets wrong.
    [InlineData("[`]", 0xC0)]
    [InlineData("[-]", 0xBD)]
    [InlineData("[=]", 0xBB)]
    [InlineData("[[]", 0xDB)]
    [InlineData("[;]", 0xBA)]
    [InlineData("[']", 0xDE)]
    [InlineData("[.]", 0xBE)]
    [InlineData("[/]", 0xBF)]
    [InlineData("[\\]", 0xDC)]
    // Letters, digits, function keys, named keys - both cases everywhere,
    // because the real file mixes [TAB] and [Tab].
    [InlineData("[p]", 0x50)]
    [InlineData("[P]", 0x50)]
    [InlineData("[z]", 0x5A)]
    [InlineData("[4]", 0x34)]
    [InlineData("[F1]", 0x70)]
    [InlineData("[f12]", 0x7B)]
    [InlineData("[Esc]", 0x1B)]
    [InlineData("[Space]", 0x20)]
    [InlineData("[TAB]", 0x09)]
    [InlineData("[Tab]", 0x09)]
    public void Resolves_the_key_names_League_actually_writes(string raw, int expected)
    {
        var result = LeagueKeybindReader.Parse(raw);
        Assert.Equal(LeagueKeybindProblem.None, result.Problem);
        Assert.Equal((uint)expected, Assert.Single(result.Binds).VirtualKey);
    }

    [Fact]
    public void A_comma_key_is_a_key_not_an_alternative_separator()
    {
        // `[,]` is a real bind. Splitting alternatives on every comma would
        // turn it into two empty halves and resolve nothing.
        var result = LeagueKeybindReader.Parse("[,]");
        Assert.Equal(LeagueKeybindProblem.None, result.Problem);
        Assert.Equal(0xBCu, Assert.Single(result.Binds).VirtualKey);
    }

    [Fact]
    public void A_close_bracket_key_is_read_as_one_token()
    {
        var result = LeagueKeybindReader.Parse("[]]");
        Assert.Equal(LeagueKeybindProblem.None, result.Problem);
        Assert.Equal(0xDDu, Assert.Single(result.Binds).VirtualKey);
    }

    [Fact]
    public void Modifiers_are_carried_spaced_or_unspaced()
    {
        var spaced = LeagueKeybindReader.Parse("[Ctrl] [TAB]");
        var bind = Assert.Single(spaced.Binds);
        Assert.Equal(VkTab, bind.VirtualKey);
        Assert.True(bind.Ctrl);
        Assert.False(bind.Shift);

        var unspaced = LeagueKeybindReader.Parse("[Shift][1]");
        var shifted = Assert.Single(unspaced.Binds);
        Assert.Equal(0x31u, shifted.VirtualKey);
        Assert.True(shifted.Shift);
        Assert.False(shifted.Ctrl);

        var alt = LeagueKeybindReader.Parse("[Alt][r],");
        var altBind = Assert.Single(alt.Binds);
        Assert.Equal(0x52u, altBind.VirtualKey);
        Assert.True(altBind.Alt);
    }

    [Fact]
    public void Both_alternatives_are_kept_when_League_writes_two()
    {
        var result = LeagueKeybindReader.Parse("[p],[Ctrl][o]");
        Assert.Equal(2, result.Binds.Count);
        Assert.Equal(VkP, result.Binds[0].VirtualKey);
        Assert.False(result.Binds[0].Ctrl);
        Assert.Equal(0x4Fu, result.Binds[1].VirtualKey);
        Assert.True(result.Binds[1].Ctrl);
    }

    [Theory]
    [InlineData("[<Unbound>]")]
    [InlineData("null")]
    [InlineData("")]
    [InlineData("   ")]
    public void The_three_spellings_of_no_bind_all_report_Unbound(string raw)
    {
        var result = LeagueKeybindReader.Parse(raw);
        Assert.Equal(LeagueKeybindProblem.Unbound, result.Problem);
        Assert.Empty(result.Binds);
    }

    [Fact]
    public void A_mouse_button_is_reported_as_a_mouse_button_not_as_unknown()
    {
        var result = LeagueKeybindReader.Parse("[Button 3]");
        Assert.Equal(LeagueKeybindProblem.MouseButton, result.Problem);
        Assert.Empty(result.Binds);
        Assert.Contains("mouse button", result.Describe("evtOpenShop"), StringComparison.Ordinal);
    }

    [Fact]
    public void An_unknown_key_names_the_token_and_never_guesses()
    {
        // Fails CLOSED. A parser that fell back to P here would watch the wrong
        // key forever with nothing in the log to say so.
        var result = LeagueKeybindReader.Parse("[Zorp]");
        Assert.Equal(LeagueKeybindProblem.UnknownKey, result.Problem);
        Assert.Empty(result.Binds);
        Assert.Equal("Zorp", result.UnresolvedToken);
        Assert.Contains("Zorp", result.Describe("evtOpenShop"), StringComparison.Ordinal);
    }

    [Fact]
    public void Every_Describe_branch_says_something_different()
    {
        var lines = new[]
        {
            LeagueKeybindReader.Parse("[`]").Describe("evtOpenShop"),
            LeagueKeybindReader.Parse("[<Unbound>]").Describe("evtOpenShop"),
            LeagueKeybindReader.Parse("[Button 3]").Describe("evtOpenShop"),
            LeagueKeybindReader.Parse("[Zorp]").Describe("evtOpenShop"),
        };

        // A watcher pointed at the wrong key looks exactly like a watcher that
        // never started. Four distinct, non-empty lines is the only thing that
        // lets one log paste tell them apart.
        Assert.Equal(4, lines.Distinct(StringComparer.Ordinal).Count());
        Assert.All(lines, line => Assert.False(string.IsNullOrWhiteSpace(line)));
        Assert.All(lines, line => Assert.Contains("evtOpenShop", line, StringComparison.Ordinal));
    }

    [Fact]
    public void Reads_the_event_out_of_a_real_shaped_input_ini()
    {
        var directory = NewTempDirectory();
        try
        {
            // Section headers, comments, blank lines and neighbouring events -
            // the shape of the real file, not a one-line fixture.
            File.WriteAllText(Path.Combine(directory, "input.ini"), string.Join(
                Environment.NewLine,
                "[GameEvents]",
                "; a comment",
                string.Empty,
                "evtSysMenu=[Esc]",
                "evtPlayerAttackMove=[a],[Alt][r]",
                "evtOpenShop=[`]",
                "evtChatHistory=[z]",
                "[HUDEvents]",
                "evtShowSummonerNames=[<Unbound>]"));

            var shop = LeagueKeybindReader.Read(directory, "evtOpenShop");
            Assert.Equal(LeagueKeybindProblem.None, shop.Result.Problem);
            Assert.Equal(VkGrave, Assert.Single(shop.Result.Binds).VirtualKey);
            Assert.EndsWith("input.ini", shop.FromFile!, StringComparison.Ordinal);
            Assert.Null(shop.DisagreesWith);

            var sysMenu = LeagueKeybindReader.Read(directory, "evtSysMenu");
            Assert.Equal(VkEscape, Assert.Single(sysMenu.Result.Binds).VirtualKey);

            // NEGATIVE CONTROL, in the same directory: an event that is not in
            // the file must come back empty. Without it "we read the file" is
            // indistinguishable from "we return the first line of anything".
            var absent = LeagueKeybindReader.Read(directory, "evtNoSuchEvent");
            Assert.Empty(absent.Result.Binds);
            Assert.Null(absent.FromFile);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void PersistedSettings_is_used_when_the_ini_is_absent_and_named_when_they_disagree()
    {
        var directory = NewTempDirectory();
        try
        {
            // The real nesting: files -> sections -> settings -> {name, value}.
            File.WriteAllText(Path.Combine(directory, "PersistedSettings.json"), """
            {
              "files": [
                { "name": "input.ini",
                  "sections": [
                    { "name": "GameEvents",
                      "settings": [
                        { "name": "evtSomethingElse", "value": "[q]" },
                        { "name": "evtOpenShop", "value": "[`]" }
                      ] } ] } ]
            }
            """);

            var jsonOnly = LeagueKeybindReader.Read(directory, "evtOpenShop");
            Assert.Equal(VkGrave, Assert.Single(jsonOnly.Result.Binds).VirtualKey);
            Assert.EndsWith("PersistedSettings.json", jsonOnly.FromFile!, StringComparison.Ordinal);

            // Now add an ini that DISAGREES. input.ini wins, and the
            // disagreement is reported rather than swallowed - the same pair of
            // files is measurably inconsistent about ShopScale on the reference
            // machine, so "they always agree" is known to be false.
            File.WriteAllText(Path.Combine(directory, "input.ini"), "evtOpenShop=[p]");
            var both = LeagueKeybindReader.Read(directory, "evtOpenShop");
            Assert.Equal(VkP, Assert.Single(both.Result.Binds).VirtualKey);
            Assert.EndsWith("input.ini", both.FromFile!, StringComparison.Ordinal);
            Assert.NotNull(both.DisagreesWith);
            Assert.Contains("[`]", both.DisagreesWith!, StringComparison.Ordinal);

            // And when they AGREE there is no noise.
            File.WriteAllText(Path.Combine(directory, "input.ini"), "evtOpenShop=[`]");
            Assert.Null(LeagueKeybindReader.Read(directory, "evtOpenShop").DisagreesWith);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void A_missing_or_unreadable_config_directory_is_empty_not_an_exception()
    {
        Assert.Empty(LeagueKeybindReader.Read(null, "evtOpenShop").Result.Binds);
        Assert.Empty(LeagueKeybindReader.Read("   ", "evtOpenShop").Result.Binds);
        Assert.Empty(LeagueKeybindReader.Read(
            Path.Combine(Path.GetTempPath(), "coachbuild-no-such-dir-" + Guid.NewGuid().ToString("N")),
            "evtOpenShop").Result.Binds);
    }

    [Fact]
    public void Malformed_json_degrades_to_no_bind_rather_than_throwing()
    {
        var directory = NewTempDirectory();
        try
        {
            File.WriteAllText(Path.Combine(directory, "PersistedSettings.json"), "{ not json");
            var result = LeagueKeybindReader.Read(directory, "evtOpenShop");
            Assert.Empty(result.Result.Binds);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void The_config_locator_prefers_an_explicit_override_and_returns_null_with_no_League()
    {
        var candidates = LeagueConfigLocator.Candidates(@"D:\Custom\League\Config");
        Assert.Equal(@"D:\Custom\League\Config", candidates[0]);
        Assert.Contains(@"C:\Riot Games\League of Legends\Config", candidates);
        Assert.Equal(candidates.Count, candidates.Distinct(StringComparer.OrdinalIgnoreCase).Count());

        // Injected existence check, so the ordering is provable on a machine
        // with no League at all - and provable NEGATIVE too.
        Assert.Null(LeagueConfigLocator.Find(_ => false));
        Assert.Equal(candidates[0], LeagueConfigLocator.Find(_ => true, @"D:\Custom\League\Config"));
    }

    private static string NewTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "coachbuild-keybinds-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }
}
