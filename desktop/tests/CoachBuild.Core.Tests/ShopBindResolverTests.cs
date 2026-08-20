using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

public sealed class ShopBindResolverTests
{
    /// <summary>
    /// "Use the built-in US punctuation table", stated rather than defaulted.
    ///
    /// <para>The layout argument is required precisely so this choice is
    /// visible at every call site. Every assertion in this file that expects
    /// 0xC0 for a backtick is an assertion about the US table, NOT about what
    /// happens on the machine running the test — this project's own dev box is
    /// en-GB, where that same character is 0xDF. The en-GB behaviour is pinned
    /// separately in KeyboardLayoutBindTests.</para>
    /// </summary>
    private static readonly Func<char, uint>? UsTableOnly = null;

    private const uint VkGrave = 0xC0;
    private const uint VkP = 0x50;
    private const uint VkEscape = 0x1B;
    private const uint VkReturn = 0x0D;

    [Fact]
    public void Resolves_the_players_own_bind_and_never_silently_uses_the_default()
    {
        var directory = NewConfig("evtSysMenu=[Esc]\nevtOpenShop=[`]\n");
        try
        {
            var binds = ShopBindResolver.Resolve(directory, UsTableOnly);

            Assert.True(binds.CanWatch);
            Assert.False(binds.UsedFallback);
            Assert.Equal(VkGrave, Assert.Single(binds.Shop).VirtualKey);
            Assert.Equal(VkEscape, binds.Close.VirtualKey);
            Assert.Equal(VkReturn, binds.Chat.VirtualKey);

            // The log is the feature's only witness in the field: one paste of
            // companion.log has to answer "is it even watching the right key?".
            var log = string.Join("\n", binds.LogLines);
            Assert.Contains("evtOpenShop", log, StringComparison.Ordinal);
            Assert.Contains("[`]", log, StringComparison.Ordinal);
            Assert.Contains("input.ini", log, StringComparison.Ordinal);
            Assert.DoesNotContain("falling back", log, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("default", log, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Falling_back_to_P_is_loud_and_says_what_to_do_instead()
    {
        foreach (var raw in new[] { "evtOpenShop=[<Unbound>]", "evtOpenShop=[Zorp]", "evtOpenShop=[Button 3]" })
        {
            var directory = NewConfig(raw + "\n");
            try
            {
                var binds = ShopBindResolver.Resolve(directory, UsTableOnly);

                Assert.True(binds.UsedFallback);
                Assert.Equal(VkP, Assert.Single(binds.Shop).VirtualKey);

                var log = string.Join("\n", binds.LogLines);
                Assert.Contains("falling back", log, StringComparison.OrdinalIgnoreCase);
                Assert.Contains("default P", log, StringComparison.Ordinal);
                // The way back must be named. A feature driven only by an
                // inference has to say what to do when the inference fails.
                Assert.Contains("tray", log, StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }

    [Fact]
    public void No_config_directory_at_all_still_produces_a_watchable_bind_and_an_explanation()
    {
        var binds = ShopBindResolver.Resolve(null, UsTableOnly);

        Assert.True(binds.CanWatch);
        Assert.True(binds.UsedFallback);
        Assert.Equal(VkP, Assert.Single(binds.Shop).VirtualKey);
        Assert.Null(binds.ConfigDirectory);
        Assert.NotEmpty(binds.LogLines);
        var log = string.Join("\n", binds.LogLines);
        Assert.Contains("tray", log, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("default shop key P", log, StringComparison.Ordinal);
    }

    [Fact]
    public void A_rebound_close_key_is_followed_and_a_missing_one_falls_back_to_Escape()
    {
        var rebound = NewConfig("evtSysMenu=[F10]\nevtOpenShop=[`]\n");
        try
        {
            Assert.Equal(0x79u, ShopBindResolver.Resolve(rebound, UsTableOnly).Close.VirtualKey);
        }
        finally
        {
            Directory.Delete(rebound, recursive: true);
        }

        var missing = NewConfig("evtOpenShop=[`]\n");
        try
        {
            Assert.Equal(VkEscape, ShopBindResolver.Resolve(missing, UsTableOnly).Close.VirtualKey);
        }
        finally
        {
            Directory.Delete(missing, recursive: true);
        }
    }

    [Fact]
    public void A_config_disagreement_is_reported_rather_than_quietly_resolved()
    {
        var directory = NewConfig("evtOpenShop=[p]\n");
        try
        {
            File.WriteAllText(Path.Combine(directory, "PersistedSettings.json"), """
            { "files": [ { "sections": [ { "settings": [
                { "name": "evtOpenShop", "value": "[`]" } ] } ] } ] }
            """);

            var binds = ShopBindResolver.Resolve(directory, UsTableOnly);
            Assert.Equal(VkP, Assert.Single(binds.Shop).VirtualKey);

            var log = string.Join("\n", binds.LogLines);
            Assert.Contains("disagree", log, StringComparison.OrdinalIgnoreCase);
            Assert.Contains("[`]", log, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Two_alternatives_are_both_watched()
    {
        var directory = NewConfig("evtOpenShop=[p],[`]\n");
        try
        {
            var binds = ShopBindResolver.Resolve(directory, UsTableOnly);
            Assert.Equal(2, binds.Shop.Count);
            Assert.Contains(binds.Shop, bind => bind.VirtualKey == VkP);
            Assert.Contains(binds.Shop, bind => bind.VirtualKey == VkGrave);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Resolving_never_writes_to_the_config_directory()
    {
        // The player's League folder is theirs. This asserts the whole
        // directory is byte-identical afterwards, not merely that no exception
        // was thrown.
        var directory = NewConfig("evtSysMenu=[Esc]\nevtOpenShop=[`]\n");
        try
        {
            File.WriteAllText(Path.Combine(directory, "PersistedSettings.json"), """
            { "files": [ { "sections": [ { "settings": [
                { "name": "evtOpenShop", "value": "[`]" } ] } ] } ] }
            """);

            var before = Snapshot(directory);
            ShopBindResolver.Resolve(directory, UsTableOnly);
            var after = Snapshot(directory);

            Assert.Equal(before, after);
            Assert.Equal(2, before.Count);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static Dictionary<string, string> Snapshot(string directory) =>
        Directory.GetFiles(directory).ToDictionary(
            Path.GetFileName,
            path => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(path))),
            StringComparer.Ordinal);

    private static string NewConfig(string ini)
    {
        var path = Path.Combine(Path.GetTempPath(), "coachbuild-shopbind-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        File.WriteAllText(Path.Combine(path, "input.ini"), ini);
        return path;
    }
}
