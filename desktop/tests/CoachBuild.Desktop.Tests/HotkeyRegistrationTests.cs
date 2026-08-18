using System.Runtime.ExceptionServices;
using CoachBuild.Desktop.Overlay;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The user's second report on 1.0.11: <i>"ctrl shift s to move it isnt
/// working."</i>
///
/// <para><b>Root cause: it was never registered.</b> Not a failed
/// <c>RegisterHotKey</c>, not a torn-down window, not focus. The .NET/WPF app
/// has never contained a single <c>RegisterHotKey</c> call — the feature lived
/// in the Electron overlay this app replaced (<c>overlay-host/main.js</c>,
/// <c>HOTKEY_TOGGLE_ADJUST = 'Control+Shift+A'</c>) and was dropped in the
/// rewrite. The only way into adjust mode since has been the tray menu, which
/// in a borderless game means alt-tabbing out of the thing you are aligning
/// against. The user's memory of the accelerator is one key off, which is why
/// both are bound now.</para>
///
/// <para>The registration OUTCOME is as much of the fix as the registration.
/// Because nothing was ever attempted, nothing was ever logged either way, so
/// "the hotkey does nothing" was unanswerable from the log — the same shape of
/// silence that hid the dead skill order until 1.0.11.</para>
/// </summary>
public sealed class HotkeyRegistrationTests
{
    private const int ErrorHotkeyAlreadyRegistered = 1409;

    [Fact]
    public void Ctrl_shift_s_is_the_accelerator_the_user_asked_for()
    {
        var primary = GlobalHotkeyService.AdjustBindings[0];

        Assert.Equal("Ctrl+Shift+S", primary.Accelerator);
        Assert.Equal(GlobalHotkeyService.VkS, primary.VirtualKey);
        Assert.True(primary.Modifiers.HasFlag(HotkeyModifiers.Control));
        Assert.True(primary.Modifiers.HasFlag(HotkeyModifiers.Shift));
        Assert.False(primary.Modifiers.HasFlag(HotkeyModifiers.Alt));
        Assert.False(primary.Modifiers.HasFlag(HotkeyModifiers.Win));
    }

    /// <summary>
    /// The Electron bind is kept as a second, independent registration.
    /// <c>RegisterHotKey</c> is exclusive system-wide, so one squatting
    /// process is enough to lose an accelerator entirely; two unrelated
    /// combinations both having to be taken is a far less likely accident.
    /// </summary>
    [Fact]
    public void The_legacy_electron_accelerator_is_bound_as_well()
    {
        Assert.Equal(2, GlobalHotkeyService.AdjustBindings.Count);
        Assert.Contains(GlobalHotkeyService.AdjustBindings, binding => binding.Accelerator == "Ctrl+Shift+A");
        Assert.Equal(
            GlobalHotkeyService.AdjustBindings.Select(binding => binding.Id).Distinct().Count(),
            GlobalHotkeyService.AdjustBindings.Count);
    }

    [Fact]
    public void A_successful_registration_says_so_in_one_greppable_line()
    {
        using var service = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        Assert.All(outcomes, outcome => Assert.True(outcome.Registered));
        Assert.Equal(
            "hotkey: registered Ctrl+Shift+S (adjust overlay position)",
            outcomes[0].ToLogLine());
        Assert.True(service.AnyRegistered);
        Assert.Null(service.FallbackAdviceOrNull());
    }

    /// <summary>
    /// The failure this is most likely to hit in the wild: another overlay,
    /// screenshot tool or macro app already owns the combination. The log must
    /// name the reason, not just report a boolean.
    /// </summary>
    [Fact]
    public void A_collision_is_logged_with_the_reason_not_swallowed()
    {
        using var service = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        Assert.All(outcomes, outcome => Assert.False(outcome.Registered));
        Assert.Contains("registration FAILED", outcomes[0].ToLogLine(), StringComparison.Ordinal);
        Assert.Contains("already registered by another application", outcomes[0].ToLogLine(), StringComparison.Ordinal);
        Assert.Contains("1409", outcomes[0].ToLogLine(), StringComparison.Ordinal);
    }

    /// <summary>
    /// One accelerator lost must not cost the other. Ctrl+Shift+S being taken
    /// still leaves Ctrl+Shift+A working, and the app must not advertise a
    /// fallback it does not need.
    /// </summary>
    [Fact]
    public void One_taken_accelerator_does_not_take_the_other_down_with_it()
    {
        using var service = new GlobalHotkeyService(
            register: binding => binding.VirtualKey == GlobalHotkeyService.VkS ? ErrorHotkeyAlreadyRegistered : 0,
            unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        Assert.False(outcomes[0].Registered);
        Assert.True(outcomes[1].Registered);
        Assert.True(service.AnyRegistered);
        Assert.Null(service.FallbackAdviceOrNull());
    }

    /// <summary>
    /// When nothing can be bound the user must be pointed at the tray, which is
    /// the only other way in. Silence here is what a user experiences as "the
    /// app is broken".
    /// </summary>
    [Fact]
    public void When_nothing_can_be_bound_the_tray_fallback_is_named()
    {
        using var service = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        service.Start(createWindow: false);

        var advice = service.FallbackAdviceOrNull();

        Assert.NotNull(advice);
        Assert.Contains("tray", advice!, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Adjust overlay position", advice, StringComparison.Ordinal);
    }

    /// <summary>
    /// F12 is reserved by Windows for the debugger at all times, so
    /// <c>RegisterHotKey</c> returns false on every machine unconditionally.
    /// The predecessor Electron overlay lost this feature for a week to exactly
    /// that; the guard refuses to attempt it and says why.
    /// </summary>
    [Fact]
    public void F12_is_refused_before_windows_gets_a_chance_to_refuse_it()
    {
        var attempts = 0;
        using var service = new GlobalHotkeyService(
            register: _ => { attempts++; return 0; },
            unregister: _ => { });

        var outcomes = service.Start(
            [new HotkeyBinding(1, HotkeyModifiers.Control, 0x7B, "Ctrl+F12", "adjust overlay position")],
            createWindow: false);

        Assert.Equal(0, attempts);
        Assert.False(outcomes[0].Registered);
        Assert.Contains("reserved by Windows for the debugger", outcomes[0].Reason!, StringComparison.Ordinal);
    }

    [Fact]
    public void A_press_raises_the_binding_that_produced_it()
    {
        using var service = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        service.Start(createWindow: false);
        HotkeyBinding? fired = null;
        service.Pressed += binding => fired = binding;

        var handled = service.Dispatch(GlobalHotkeyService.WmHotkey, GlobalHotkeyService.AdjustHotkeyIdPrimary);

        Assert.True(handled);
        Assert.Equal("Ctrl+Shift+S", fired?.Accelerator);
    }

    [Fact]
    public void An_unregistered_id_and_an_unrelated_message_are_both_ignored()
    {
        using var service = new GlobalHotkeyService(
            register: binding => binding.VirtualKey == GlobalHotkeyService.VkS ? 0 : ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        service.Start(createWindow: false);
        var fired = 0;
        service.Pressed += _ => fired++;

        Assert.False(service.Dispatch(GlobalHotkeyService.WmHotkey, GlobalHotkeyService.AdjustHotkeyIdLegacy));
        Assert.False(service.Dispatch(0x0100 /* WM_KEYDOWN */, GlobalHotkeyService.AdjustHotkeyIdPrimary));
        Assert.Equal(0, fired);
    }

    [Fact]
    public void Every_registered_accelerator_is_released_on_shutdown()
    {
        var released = new List<int>();
        var service = new GlobalHotkeyService(register: _ => 0, unregister: released.Add);
        service.Start(createWindow: false);

        service.Dispose();

        Assert.Equal(
            GlobalHotkeyService.AdjustBindings.Select(binding => binding.Id).OrderBy(id => id),
            released.OrderBy(id => id));
    }

    // ------------------------------------------------------- the real window

    /// <summary>
    /// The one thing an injected registrar cannot prove: that a real HWND is
    /// created and a real <c>RegisterHotKey</c> succeeds against it on this
    /// machine.
    ///
    /// <para>The window is <c>HWND_MESSAGE</c>-parented on purpose. A hotkey
    /// dies with the window that registered it, and CoachBuild destroys its
    /// browser window at game start (1.0.10) while its overlay window has no
    /// handle at all until first shown — either would be a hotkey that stops
    /// working precisely when the user needs it.</para>
    /// </summary>
    [Fact]
    public void The_real_message_window_registers_a_real_accelerator()
    {
        RunOnSta(() =>
        {
            using var service = new GlobalHotkeyService();
            var outcomes = service.Start();

            Assert.NotEqual(0, service.Handle);
            // A machine where another app owns BOTH is possible, so this
            // asserts that each attempt produced a real verdict rather than
            // asserting success it cannot guarantee.
            Assert.Equal(GlobalHotkeyService.AdjustBindings.Count, outcomes.Count);
            Assert.All(outcomes, outcome =>
                Assert.True(outcome.Registered || outcome.ErrorCode != 0, outcome.ToLogLine()));
        });
    }

    /// <summary>
    /// A second process asking for the same accelerator gets 1409. This drives
    /// the real Win32 path to its documented failure rather than trusting the
    /// injected fake to model it — the fake is only honest if this is true.
    /// </summary>
    [Fact]
    public void A_second_registration_of_the_same_accelerator_really_does_collide()
    {
        RunOnSta(() =>
        {
            using var first = new GlobalHotkeyService();
            var firstOutcomes = first.Start();
            if (!firstOutcomes[0].Registered) return; // already owned on this box; nothing to prove

            using var second = new GlobalHotkeyService();
            var secondOutcomes = second.Start();

            Assert.False(secondOutcomes[0].Registered);
            Assert.Equal(ErrorHotkeyAlreadyRegistered, secondOutcomes[0].ErrorCode);
            Assert.Contains("already registered", secondOutcomes[0].ToLogLine(), StringComparison.Ordinal);
        });
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
