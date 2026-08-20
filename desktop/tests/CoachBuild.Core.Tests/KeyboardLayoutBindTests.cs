using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The shop bind is a CHARACTER in League's config and a VIRTUAL KEY in
/// Windows' key-state API, and the map between them belongs to the player's
/// keyboard layout.
///
/// <para><b>The measurement these tests exist for.</b> On the en-GB layout this
/// project is developed on:</para>
///
/// <code>
/// VkKeyScanEx('`', GetKeyboardLayout(0))  ->  0x00DF   (VK_OEM_8)
/// LeagueVirtualKeys' hardcoded US table    ->  0xC0     (VK_OEM_3)
/// </code>
///
/// <para>0xC0 on en-GB is the <c>'</c>/<c>@</c> key. So the player whose
/// <c>Config\input.ini</c> reads <c>evtOpenShop=[`]</c> — the player this whole
/// feature was built for — could have that bind read perfectly and still never
/// have a single press seen, because the watcher was polling a key on the other
/// side of the keyboard. The reader's own doctrine calls that out by name:
/// "Guessing here means watching the wrong key forever with nothing in the log
/// to say so." The punctuation table was the one place it guessed.</para>
/// </summary>
public sealed class KeyboardLayoutBindTests
{
    private const uint VkOem3 = 0xC0; // US: `~   en-GB: '@
    private const uint VkOem8 = 0xDF; // en-GB: `¬

    /// <summary>A stand-in for an en-GB layout, so this is provable on any machine.</summary>
    private static uint UkLayout(char character) => character switch
    {
        '`' => VkOem8,
        '\'' => VkOem3,
        '#' => 0xDE,
        _ => 0,
    };

    [Fact]
    public void The_backtick_shop_bind_follows_the_players_layout()
    {
        // The bug, stated as a difference. Same config value, same parser, two
        // layouts, two different physical keys — and only one of them is the
        // key the player presses.
        Assert.Equal(VkOem3, Assert.Single(LeagueKeybindReader.Parse("[`]").Binds).VirtualKey);
        Assert.Equal(VkOem8, Assert.Single(LeagueKeybindReader.Parse("[`]", UkLayout).Binds).VirtualKey);
    }

    [Fact]
    public void The_whole_OEM_class_follows_the_layout_not_just_the_backtick()
    {
        // Backtick is the reported case, not the whole defect. Every
        // punctuation bind in League's config goes through the same US table,
        // so fixing one character and leaving the class would be fixing the
        // symptom.
        Assert.Equal(0xDEu, Assert.Single(LeagueKeybindReader.Parse("[']").Binds).VirtualKey);
        Assert.Equal(VkOem3, Assert.Single(LeagueKeybindReader.Parse("[']", UkLayout).Binds).VirtualKey);
    }

    [Fact]
    public void A_layout_that_cannot_type_the_character_falls_back_to_the_table()
    {
        // Fails SOFT, and only in the direction that keeps the old behaviour.
        // A layout hook returning 0 is "I do not know", not "there is no key",
        // and answering it with silence would turn a wrong bind into no bind.
        static uint Blank(char _) => 0;
        Assert.Equal(VkOem3, Assert.Single(LeagueKeybindReader.Parse("[`]", Blank).Binds).VirtualKey);
    }

    [Fact]
    public void Letters_and_digits_are_deliberately_left_alone()
    {
        // Scope, asserted. The layout question for A-Z (AZERTY's A/Q swap) is
        // real but is not answerable without a machine that has one, and a
        // hook that quietly re-mapped letters would trade a measured bug for an
        // unmeasured one. If this ever changes it should change on evidence.
        Assert.Equal(0x50u, Assert.Single(LeagueKeybindReader.Parse("[p]", UkLayout).Binds).VirtualKey);
        Assert.Equal(0x31u, Assert.Single(LeagueKeybindReader.Parse("[1]", UkLayout).Binds).VirtualKey);
        Assert.Equal(0x1Bu, Assert.Single(LeagueKeybindReader.Parse("[Esc]", UkLayout).Binds).VirtualKey);
    }

    [Fact]
    public void A_resolved_bind_says_which_KEY_it_is_watching_and_not_only_which_character()
    {
        // What made this invisible for three rounds: the startup line named the
        // token League wrote and never the code it became, so a log could print
        // the right character while the app polled the wrong key.
        var directory = NewConfig("evtSysMenu=[Esc]\nevtOpenShop=[`]\n");
        try
        {
            var uk = ShopBindResolver.Resolve(directory, UkLayout);
            Assert.Equal(VkOem8, Assert.Single(uk.Shop).VirtualKey);

            var watching = Assert.Single(uk.LogLines, line => line.Contains("WATCHING", StringComparison.Ordinal));
            Assert.Contains("0xDF", watching, StringComparison.Ordinal);
            Assert.Contains("input.ini", watching, StringComparison.Ordinal);
            Assert.Contains("keyboard layout", watching, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void The_fallback_says_out_loud_that_it_never_read_the_players_config()
    {
        // The line that would have ended round 3 before it started. "P" is only
        // ever produced by FallbackShopVirtualKey, so a player pressing P and
        // seeing it work is a player whose config was not read — and the log
        // has to say so in the same breath as the key.
        var fallback = ShopBindResolver.Resolve(null, UkLayout);

        Assert.True(fallback.UsedFallback);
        var watching = Assert.Single(fallback.LogLines, line => line.Contains("WATCHING", StringComparison.Ordinal));
        Assert.Contains("0x50", watching, StringComparison.Ordinal);
        Assert.Contains("YOUR CONFIG WAS NOT READ", watching, StringComparison.Ordinal);
    }

    [Fact]
    public void The_layout_probe_is_alive_on_this_machine()
    {
        // An instrument check, not a behaviour check. Every test above uses a
        // fake layout, so all of them would pass just as well if the real
        // P/Invoke never returned anything — which is exactly how the shipped
        // code would keep using the US table forever. This asserts the real
        // one answers for a character every Latin layout can type unmodified.
        if (!OperatingSystem.IsWindows()) return;

        Assert.NotEqual(0u, WindowsKeyboardLayout.ResolvePunctuation('.'));
        Assert.NotEqual(0u, WindowsKeyboardLayout.ResolvePunctuation('`'));
        Assert.NotEqual("unknown", WindowsKeyboardLayout.Describe());
    }

    [Fact]
    public void Production_resolves_through_the_real_layout_and_says_so()
    {
        // The composition the player actually runs, exercised. An optional
        // layout argument that production passes and every fixture omits is
        // how a keyboard-layout bug survives a green suite, which is why
        // ResolveForCurrentMachine exists as a named entry point rather than
        // as two lines inside App.
        if (!OperatingSystem.IsWindows()) return;

        var binds = ShopBindResolver.ResolveForCurrentMachine();

        Assert.NotEmpty(binds.Shop);
        var watching = Assert.Single(binds.LogLines, line => line.Contains("WATCHING", StringComparison.Ordinal));
        Assert.Contains("vk 0x", watching, StringComparison.Ordinal);
        Assert.Contains("keyboard layout 0x", watching, StringComparison.Ordinal);
    }

    private static string NewConfig(string inputIni)
    {
        var directory = Path.Combine(Path.GetTempPath(), $"coachbuild-layout-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        File.WriteAllText(Path.Combine(directory, "input.ini"), inputIni);
        return directory;
    }
}
