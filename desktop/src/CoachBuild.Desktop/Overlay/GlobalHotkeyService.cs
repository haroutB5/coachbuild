using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using CoachBuild.Desktop.Tray;

namespace CoachBuild.Desktop.Overlay;

/// <summary>One hotkey this app wants: the accelerator, and what it means.</summary>
public sealed record HotkeyBinding(int Id, HotkeyModifiers Modifiers, uint VirtualKey, string Accelerator, string Purpose);

[Flags]
public enum HotkeyModifiers : uint
{
    None = 0,
    Alt = 0x0001,
    Control = 0x0002,
    Shift = 0x0004,
    Win = 0x0008,
    /// <summary>Do not repeat while the key is held. Windows 7+.</summary>
    NoRepeat = 0x4000,
}

/// <summary>The outcome of one <c>RegisterHotKey</c> call, as it will be logged.</summary>
public sealed record HotkeyRegistration(string Accelerator, string Purpose, bool Registered, int ErrorCode, string? Reason)
{
    /// <summary>
    /// Exactly the line written to companion.log. A future "the hotkey does
    /// nothing" report is answerable from the file alone — which was not true
    /// of 1.0.11, where no hotkey existed and the log said nothing either way.
    /// </summary>
    public string ToLogLine() => Registered
        ? $"hotkey: registered {Accelerator} ({Purpose})"
        : $"hotkey: registration FAILED for {Accelerator} ({Purpose}) — {Reason} [win32 {ErrorCode}]";

    public static string DescribeError(int code) => code switch
    {
        1409 => "already registered by another application",
        1400 => "invalid window handle",
        87 => "invalid parameter",
        0 => "unknown (RegisterHotKey returned false without setting an error)",
        _ => "see the Windows system error code",
    };
}

/// <summary>
/// The app's system-wide hotkey, hosted on a message-only window this class owns.
///
/// <para><b>Why a window of its own.</b> A global hotkey is delivered as
/// <c>WM_HOTKEY</c> to the window that registered it, and dies with that
/// window. Hanging it off the companion browser window would have made it stop
/// working the moment 1.0.10's teardown closes that window at load-in — i.e.
/// exactly when the user wants to move the overlay. Hanging it off the overlay
/// window is not much better: that window has no HWND at all until it is first
/// shown. This HWND is created at startup, is never shown, never activated,
/// never closed before shutdown, and is a child of <c>HWND_MESSAGE</c> so the
/// shell never sees it.</para>
///
/// <para><b>Exactly one accelerator, on purpose (1.0.13).</b> 1.0.12 bound
/// <c>Ctrl+Shift+S</c> as well, on the theory that <c>RegisterHotKey</c> is
/// exclusive system-wide — whichever process asks first owns the combination
/// and every later caller gets <c>false</c> with
/// <c>ERROR_HOTKEY_ALREADY_REGISTERED</c> (1409) — so a second, unrelated
/// combination is insurance against one being squatted. The user removed it:
/// <c>Ctrl+Shift+S</c> is "Save As" in a great many applications, and a global
/// hotkey is stolen from every one of them for as long as this app runs. The
/// insurance was worth less than the collision. <c>Ctrl+Shift+A</c> is what the
/// Electron overlay bound before the .NET rewrite and is the only bind now; if
/// it cannot be registered the outcome is logged and the tray item is named
/// (<see cref="FallbackAdviceOrNull"/>). Nothing is swallowed.</para>
///
/// <para><b>F12 is refused, deliberately.</b> Microsoft's own
/// <c>RegisterHotKey</c> documentation reserves it for the debugger at all
/// times, so it returns false on every machine — which is how the predecessor
/// Electron overlay lost this feature for a week. The guard is here so the
/// mistake cannot recur silently.</para>
/// </summary>
public sealed class GlobalHotkeyService : IDisposable
{
    public const int WmHotkey = 0x0312;
    private const int HwndMessage = -3;

    /// <summary>Ctrl+Shift+A — what the Electron overlay bound before the .NET rewrite, and the only bind.</summary>
    public const uint VkA = 0x41;

    /// <summary>
    /// The one hotkey id this app registers.
    ///
    /// <para>It is <c>0xC0DE02</c> — the id Ctrl+Shift+A already carried in
    /// 1.0.12 — and <c>0xC0DE01</c>, which was Ctrl+Shift+S, is deliberately
    /// left unused rather than recycled. A <c>WM_HOTKEY</c> naming the retired
    /// id can therefore only ever be a no-op, never a press of the surviving
    /// key wearing the dead one's number.</para>
    /// </summary>
    public const int AdjustHotkeyId = 0xC0DE02;

    /// <summary>
    /// The single accelerator: toggle overlay adjust mode. Not a League default
    /// bind, and not Ctrl+Q/W/E/R (which League itself uses to level abilities).
    /// </summary>
    public static IReadOnlyList<HotkeyBinding> AdjustBindings { get; } =
    [
        new(AdjustHotkeyId, HotkeyModifiers.Control | HotkeyModifiers.Shift | HotkeyModifiers.NoRepeat, VkA, "Ctrl+Shift+A", "adjust overlay position"),
    ];

    private readonly List<HotkeyBinding> _registered = [];
    private readonly Func<HotkeyBinding, int> _register;
    private readonly Action<int> _unregister;
    private HwndSource? _source;
    private bool _disposed;

    /// <param name="register">
    /// Attempts one registration and returns 0 on success or a Win32 error
    /// code on failure. Injectable so a test can drive both outcomes without a
    /// real message pump or a real key press.
    /// </param>
    public GlobalHotkeyService(
        Func<HotkeyBinding, int>? register = null,
        Action<int>? unregister = null)
    {
        _register = register ?? RegisterNative;
        _unregister = unregister ?? UnregisterNative;
    }

    /// <summary>Raised on the UI thread when a registered hotkey fires.</summary>
    public event Action<HotkeyBinding>? Pressed;

    /// <summary>Every outcome, in the order attempted.</summary>
    public IReadOnlyList<HotkeyRegistration> Outcomes { get; private set; } = [];

    public bool AnyRegistered => _registered.Count > 0;

    /// <summary>
    /// The accelerator the user can actually press right now, or null when
    /// nothing could be bound.
    ///
    /// <para>Derived from <see cref="AdjustBindings"/> filtered by what
    /// <c>RegisterHotKey</c> actually accepted, so it is the single source of
    /// truth for any UI that names the key — the tray label (1.0.14) and the
    /// balloon both read it rather than carrying a second copy of the string.
    /// Changing the bind changes the menu automatically; losing the bind
    /// removes the promise automatically, which is the half that matters. A
    /// menu item reading "Adjust overlay position (Ctrl+Shift+A)" on a machine
    /// where another app owns Ctrl+Shift+A would be the app lying about a key
    /// it does not have.</para>
    /// </summary>
    public string? RegisteredAdjustAccelerator => _registered.Count == 0
        ? null
        : string.Join(" / ", _registered.Select(binding => binding.Accelerator));

    public nint Handle => _source?.Handle ?? 0;

    /// <summary>
    /// Creates the message-only window (unless one was injected) and registers
    /// every binding. Never throws: a machine where no accelerator is available
    /// still gets a working app and a log line naming the collision.
    /// </summary>
    public IReadOnlyList<HotkeyRegistration> Start(IEnumerable<HotkeyBinding>? bindings = null, bool createWindow = true)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (createWindow && _source is null)
        {
            try
            {
                _source = new HwndSource(new HwndSourceParameters("CoachBuildHotkeys")
                {
                    Width = 0,
                    Height = 0,
                    PositionX = 0,
                    PositionY = 0,
                    ParentWindow = HwndMessage,
                });
                _source.AddHook(MessageHook);
            }
            catch (Exception error)
            {
                _source = null;
                Outcomes = [new HotkeyRegistration("(all)", "adjust overlay position", false, 0, $"message window could not be created ({error.GetType().Name})")];
                return Outcomes;
            }
        }

        var outcomes = new List<HotkeyRegistration>();
        foreach (var binding in bindings ?? AdjustBindings)
        {
            if (IsReservedByWindows(binding))
            {
                outcomes.Add(new HotkeyRegistration(
                    binding.Accelerator,
                    binding.Purpose,
                    false,
                    0,
                    "F12 is permanently reserved by Windows for the debugger and can never be registered"));
                continue;
            }

            int error;
            try
            {
                error = _register(binding);
            }
            catch (Exception failure)
            {
                error = -1;
                outcomes.Add(new HotkeyRegistration(binding.Accelerator, binding.Purpose, false, error, failure.GetType().Name));
                continue;
            }

            if (error == 0)
            {
                _registered.Add(binding);
                outcomes.Add(new HotkeyRegistration(binding.Accelerator, binding.Purpose, true, 0, null));
            }
            else
            {
                outcomes.Add(new HotkeyRegistration(
                    binding.Accelerator,
                    binding.Purpose,
                    false,
                    error,
                    HotkeyRegistration.DescribeError(error)));
            }
        }

        Outcomes = outcomes;
        return Outcomes;
    }

    /// <summary>
    /// The summary line the tray/user needs when nothing could be bound, or
    /// null when at least one accelerator works.
    ///
    /// <para>It names the accelerators actually attempted rather than a count,
    /// so the line cannot go stale the way a hardcoded "both keys" would have
    /// when Ctrl+Shift+S was dropped in 1.0.13.</para>
    /// </summary>
    public string? FallbackAdviceOrNull()
    {
        if (AnyRegistered) return null;
        return $"hotkey: {AttemptedAdjustAccelerators} could not be registered; use the tray icon → \"{TrayMenuState.AdjustMenuVerb}\" instead";
    }

    /// <summary>
    /// Every accelerator this app asked Windows for, registered or not, named.
    /// The failure UX (log line and tray balloon) is built from this so neither
    /// can go stale the way a hardcoded "both keys" did when Ctrl+Shift+S was
    /// dropped in 1.0.13.
    /// </summary>
    public string AttemptedAdjustAccelerators => Outcomes.Count == 0
        ? "the adjust accelerator"
        : string.Join(" / ", Outcomes.Select(outcome => outcome.Accelerator));

    /// <summary>Drives the message hook directly, for tests without a pump.</summary>
    public bool Dispatch(int message, nint wParam)
    {
        if (message != WmHotkey) return false;
        var id = wParam.ToInt32();
        var binding = _registered.FirstOrDefault(candidate => candidate.Id == id);
        if (binding is null) return false;
        Pressed?.Invoke(binding);
        return true;
    }

    private static bool IsReservedByWindows(HotkeyBinding binding) => binding.VirtualKey == 0x7B; // VK_F12

    private nint MessageHook(nint hwnd, int message, nint wParam, nint lParam, ref bool handled)
    {
        if (Dispatch(message, wParam)) handled = true;
        return 0;
    }

    private int RegisterNative(HotkeyBinding binding)
    {
        var handle = Handle;
        if (handle == 0) return 1400;
        return RegisterHotKey(handle, binding.Id, (uint)binding.Modifiers, binding.VirtualKey)
            ? 0
            : Marshal.GetLastWin32Error();
    }

    private void UnregisterNative(int id)
    {
        var handle = Handle;
        if (handle != 0) UnregisterHotKey(handle, id);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        foreach (var binding in _registered)
        {
            try { _unregister(binding.Id); }
            catch (Win32Exception) { }
        }

        _registered.Clear();
        if (_source is not null)
        {
            _source.RemoveHook(MessageHook);
            _source.Dispose();
            _source = null;
        }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(nint hWnd, int id, uint fsModifiers, uint vk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(nint hWnd, int id);
}
