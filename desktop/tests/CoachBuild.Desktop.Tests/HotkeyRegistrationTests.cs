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
/// had never contained a single <c>RegisterHotKey</c> call — the feature lived
/// in the Electron overlay this app replaced (<c>overlay-host/main.js</c>,
/// <c>HOTKEY_TOGGLE_ADJUST = 'Control+Shift+A'</c>) and was dropped in the
/// rewrite. The only way into adjust mode since had been the tray menu, which
/// in a borderless game means alt-tabbing out of the thing you are aligning
/// against.</para>
///
/// <para><b>1.0.13: Ctrl+Shift+A only.</b> 1.0.12 bound the accelerator the user
/// remembered (<c>Ctrl+Shift+S</c>) alongside the historical one, as insurance
/// against another process squatting on either. The user then asked for the
/// Electron behaviour back and only that: a global <c>Ctrl+Shift+S</c> is taken
/// away from every application that uses it as "Save As" for as long as
/// CoachBuild runs, which costs more than the insurance is worth. These tests
/// pin the surviving bind AND the absence of the retired one — an accelerator
/// that is merely unused but still registered is still stolen from everyone
/// else, so "S is gone" has to be asserted, not assumed.</para>
///
/// <para>The registration OUTCOME is as much of the fix as the registration.
/// Because nothing was ever attempted before 1.0.12, nothing was ever logged
/// either way, so "the hotkey does nothing" was unanswerable from the log — the
/// same shape of silence that hid the dead skill order until 1.0.11.</para>
/// </summary>
public sealed class HotkeyRegistrationTests
{
    private const int ErrorHotkeyAlreadyRegistered = 1409;

    /// <summary>1.0.12's Ctrl+Shift+S id. Retired, never recycled.</summary>
    private const int RetiredCtrlShiftSId = 0xC0DE01;

    private const uint VkS = 0x53;

    /// <summary>Some other application asking Windows for its "Save As" key.</summary>
    private static readonly HotkeyBinding SaveAsProbe = new(
        0x5AFE01,
        HotkeyModifiers.Control | HotkeyModifiers.Shift | HotkeyModifiers.NoRepeat,
        VkS,
        "Ctrl+Shift+S",
        "another application's Save As");

    [Fact]
    public void Ctrl_shift_a_is_the_accelerator_and_it_is_the_only_one()
    {
        Assert.Single(GlobalHotkeyService.AdjustBindings);
        var only = GlobalHotkeyService.AdjustBindings[0];

        Assert.Equal("Ctrl+Shift+A", only.Accelerator);
        Assert.Equal(GlobalHotkeyService.VkA, only.VirtualKey);
        Assert.Equal(GlobalHotkeyService.AdjustHotkeyId, only.Id);
        Assert.True(only.Modifiers.HasFlag(HotkeyModifiers.Control));
        Assert.True(only.Modifiers.HasFlag(HotkeyModifiers.Shift));
        Assert.False(only.Modifiers.HasFlag(HotkeyModifiers.Alt));
        Assert.False(only.Modifiers.HasFlag(HotkeyModifiers.Win));
    }

    /// <summary>
    /// The 1.0.13 change, asserted as an absence at every level it could
    /// survive at: the binding table, the virtual key actually handed to
    /// <c>RegisterHotKey</c>, the id, and the log.
    ///
    /// <para>This is the test that fails against 1.0.12 — where
    /// <c>AdjustBindings</c> has two entries, the registrar is called twice,
    /// <c>0x53</c> is one of the keys, and the first log line names
    /// Ctrl+Shift+S.</para>
    /// </summary>
    [Fact]
    public void Ctrl_shift_s_is_not_registered_any_more()
    {
        var attempted = new List<HotkeyBinding>();
        using var service = new GlobalHotkeyService(
            register: binding => { attempted.Add(binding); return 0; },
            unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        // Nothing asks Windows for S, so nothing takes it off "Save As".
        Assert.Single(attempted);
        Assert.DoesNotContain(attempted, binding => binding.VirtualKey == VkS);
        Assert.DoesNotContain(attempted, binding => binding.Id == RetiredCtrlShiftSId);
        Assert.DoesNotContain(
            GlobalHotkeyService.AdjustBindings,
            binding => binding.Accelerator.Contains("Ctrl+Shift+S", StringComparison.Ordinal));

        // And the log cannot mention it either, in success or in failure.
        Assert.Single(outcomes);
        Assert.DoesNotContain(
            outcomes,
            outcome => outcome.ToLogLine().Contains("Ctrl+Shift+S", StringComparison.Ordinal));
    }

    /// <summary>
    /// The retired id must not be recycled onto the surviving key. If it were,
    /// a <c>WM_HOTKEY</c> carrying 1.0.12's Ctrl+Shift+S id would toggle adjust
    /// mode, which is the "nothing left that could still fire" hole wearing a
    /// different number.
    /// </summary>
    [Fact]
    public void The_retired_ctrl_shift_s_id_fires_nothing()
    {
        using var service = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });
        service.Start(createWindow: false);
        var fired = 0;
        service.Pressed += _ => fired++;

        Assert.NotEqual(RetiredCtrlShiftSId, GlobalHotkeyService.AdjustHotkeyId);
        Assert.False(service.Dispatch(GlobalHotkeyService.WmHotkey, RetiredCtrlShiftSId));
        Assert.Equal(0, fired);
    }

    /// <summary>
    /// Every registered accelerator is released on shutdown — and with one
    /// bind, exactly one release, so a retired id cannot linger as an
    /// unmatched <c>UnregisterHotKey</c> either.
    /// </summary>
    [Fact]
    public void Every_registered_accelerator_is_released_on_shutdown()
    {
        var released = new List<int>();
        var service = new GlobalHotkeyService(register: _ => 0, unregister: released.Add);
        service.Start(createWindow: false);

        service.Dispose();

        Assert.Equal(GlobalHotkeyService.AdjustHotkeyId, Assert.Single(released));
    }

    [Fact]
    public void A_successful_registration_says_so_in_one_greppable_line()
    {
        using var service = new GlobalHotkeyService(register: _ => 0, unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        // One binding, one line. A second line here would be the log claiming
        // a bind the app no longer has.
        var line = Assert.Single(outcomes).ToLogLine();
        Assert.Equal("hotkey: registered Ctrl+Shift+A (adjust overlay position)", line);
        Assert.True(service.AnyRegistered);
        Assert.Null(service.FallbackAdviceOrNull());
    }

    /// <summary>
    /// The failure this is most likely to hit in the wild: another overlay,
    /// screenshot tool or macro app already owns the combination. The log must
    /// name the accelerator and the reason, not just report a boolean.
    /// </summary>
    [Fact]
    public void A_collision_is_logged_with_the_reason_not_swallowed()
    {
        using var service = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });

        var outcomes = service.Start(createWindow: false);

        var line = Assert.Single(outcomes).ToLogLine();
        Assert.False(outcomes[0].Registered);
        Assert.Contains("registration FAILED for Ctrl+Shift+A", line, StringComparison.Ordinal);
        Assert.Contains("already registered by another application", line, StringComparison.Ordinal);
        Assert.Contains("1409", line, StringComparison.Ordinal);
    }

    /// <summary>
    /// With a single bind there is no second key to fall back to, so losing it
    /// must reach the user rather than leaving adjust mode apparently dead. The
    /// advice names the accelerator it actually attempted — a hardcoded "both
    /// keys" would have gone stale the moment Ctrl+Shift+S was dropped.
    /// </summary>
    [Fact]
    public void When_the_only_accelerator_is_taken_the_tray_fallback_is_named()
    {
        using var service = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        service.Start(createWindow: false);

        var advice = service.FallbackAdviceOrNull();

        Assert.False(service.AnyRegistered);
        Assert.NotNull(advice);
        Assert.Contains("Ctrl+Shift+A", advice!, StringComparison.Ordinal);
        Assert.DoesNotContain("Ctrl+Shift+S", advice, StringComparison.Ordinal);
        Assert.Contains("tray", advice, StringComparison.OrdinalIgnoreCase);
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

        var handled = service.Dispatch(GlobalHotkeyService.WmHotkey, GlobalHotkeyService.AdjustHotkeyId);

        Assert.True(handled);
        Assert.Equal("Ctrl+Shift+A", fired?.Accelerator);
    }

    [Fact]
    public void An_unregistered_id_and_an_unrelated_message_are_both_ignored()
    {
        using var service = new GlobalHotkeyService(
            register: binding => binding.VirtualKey == GlobalHotkeyService.VkA ? 0 : ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        service.Start(createWindow: false);
        var fired = 0;
        service.Pressed += _ => fired++;

        Assert.False(service.Dispatch(GlobalHotkeyService.WmHotkey, 0xDEAD));
        Assert.False(service.Dispatch(0x0100 /* WM_KEYDOWN */, GlobalHotkeyService.AdjustHotkeyId));
        Assert.Equal(0, fired);
    }

    /// <summary>
    /// A registration that fails is not in the dispatch table. Without this,
    /// dropping to one bind would be a silent downgrade: a machine where
    /// Ctrl+Shift+A is squatted would still route a stray WM_HOTKEY into
    /// adjust mode.
    /// </summary>
    [Fact]
    public void A_failed_registration_does_not_dispatch()
    {
        using var service = new GlobalHotkeyService(
            register: _ => ErrorHotkeyAlreadyRegistered,
            unregister: _ => { });
        service.Start(createWindow: false);
        var fired = 0;
        service.Pressed += _ => fired++;

        Assert.False(service.Dispatch(GlobalHotkeyService.WmHotkey, GlobalHotkeyService.AdjustHotkeyId));
        Assert.Equal(0, fired);
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
            // A machine where another app owns Ctrl+Shift+A is possible, so
            // this asserts that the attempt produced a real verdict rather than
            // asserting a success it cannot guarantee.
            Assert.Single(outcomes);
            Assert.All(outcomes, outcome =>
                Assert.True(outcome.Registered || outcome.ErrorCode != 0, outcome.ToLogLine()));
        });
    }

    /// <summary>
    /// Real Win32, on the surviving key: registering Ctrl+Shift+A a second time
    /// gets 1409. This drives the real path to its documented failure rather
    /// than trusting the injected fake to model it — the fake is only honest if
    /// this is true.
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

    /// <summary>
    /// Real Win32, stated as the point of the change: after this app has bound
    /// its accelerator, <c>Ctrl+Shift+S</c> is still free for whoever wants it.
    /// Against 1.0.12 this fails — CoachBuild owns it and the probe gets 1409.
    /// </summary>
    [Fact]
    public void Ctrl_shift_s_is_left_free_for_other_applications()
    {
        RunOnSta(() =>
        {
            // Positive control first: if something else on this box already
            // owns Ctrl+Shift+S there is nothing this test can prove, and a
            // failure here would be about the machine, not the code.
            using (var control = new GlobalHotkeyService())
            {
                if (!control.Start([SaveAsProbe])[0].Registered) return;
            }

            using var service = new GlobalHotkeyService();
            service.Start();

            // A second service standing in for "some other app on the user's
            // PC", asking Windows for Ctrl+Shift+S while CoachBuild is running.
            using var otherApp = new GlobalHotkeyService();
            var probe = otherApp.Start([SaveAsProbe]);

            Assert.True(
                probe[0].Registered,
                $"Ctrl+Shift+S was free a moment ago and is not now: {probe[0].ToLogLine()}");
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
