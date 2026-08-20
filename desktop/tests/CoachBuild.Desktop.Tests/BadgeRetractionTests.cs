using System.Runtime.ExceptionServices;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// Putting the badges AWAY. The first field screenshot of this feature showed
/// four correctly drawn, correctly coloured pills sitting over open terrain
/// with the shop shut, and the player's words were "it should go when i press
/// button again". Everything here is about that sentence being true.
/// </summary>
public sealed class BadgeRetractionTests
{
    [Fact]
    public void Pressing_the_shop_key_to_close_also_clears_the_manual_override()
    {
        // THE TRAP. "Show item numbers now" draws the badges regardless of the
        // latch, and round 1 told this player to use it as the workaround for
        // the chat gate. With it ticked, closing the latch changed nothing on
        // screen: the pills stayed up until the match ended, and the only
        // control that could clear them was a tray tick they cannot reach from
        // inside a fullscreen game. That is the same "no recovery you can find
        // in-game" defect the chat gate had, in its own escape hatch.
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            var cleared = 0;
            window.ManualBadgeOverrideCleared += () => cleared++;
            try
            {
                window.ShowInactive();
                window.SetForceBadges(true);
                window.SetShopOpen(true);
                Assert.Equal(0, cleared);

                window.SetShopOpen(false);

                Assert.Equal(1, cleared);

                // ...and it is not raised again by a second close, because
                // there is no longer an override to clear. A tray tick that
                // un-ticks itself twice is a tray tick nobody trusts.
                window.SetShopOpen(true);
                window.SetShopOpen(false);
                Assert.Equal(1, cleared);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    [Fact]
    public void Opening_the_shop_never_clears_the_manual_override()
    {
        // NEGATIVE CONTROL. Only "put them away" clears it. If an opening press
        // cleared it too, the override would survive exactly one press and the
        // tray item would look broken instead of sticky.
        RunOnSta(() =>
        {
            var settingsPath = Path.Combine(Path.GetTempPath(), $"coachbuild-test-{Guid.NewGuid():N}.json");
            var window = new OverlayWindow(
                new OverlaySettingsStore(settingsPath),
                NullGameWindowLocator.Instance);
            var cleared = 0;
            window.ManualBadgeOverrideCleared += () => cleared++;
            try
            {
                window.ShowInactive();
                window.SetForceBadges(true);

                window.SetShopOpen(true);

                Assert.Equal(0, cleared);
            }
            finally
            {
                Cleanup(window, settingsPath);
            }
        });
    }

    /// <summary>
    /// Tearing the window down must never be able to FAIL the test. These run
    /// on their own STA thread beside other WPF tests, and a Close() or a
    /// temp-file delete that loses a race says nothing at all about the
    /// behaviour under test - it just turns a green suite red at random.
    /// </summary>
    private static void Cleanup(OverlayWindow window, string settingsPath)
    {
        try { window.Close(); } catch { /* teardown is not the assertion */ }
        try { if (File.Exists(settingsPath)) File.Delete(settingsPath); } catch { }
    }

    private static void RunOnSta(Action action)
    {
        Exception? failure = null;
        var thread = new Thread(() =>
        {
            try { action(); }
            catch (Exception exception) { failure = exception; }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        if (failure is not null) ExceptionDispatchInfo.Capture(failure).Throw();
    }
}
