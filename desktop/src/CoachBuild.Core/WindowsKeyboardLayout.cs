using System.Runtime.InteropServices;

namespace CoachBuild.Core;

/// <summary>
/// "Which physical key produces this character on THIS machine's keyboard?"
///
/// <para><b>Why this exists.</b> League's <c>input.ini</c> records a shop bind
/// as a CHARACTER — <c>evtOpenShop=[`]</c> — and Windows' key-state API wants a
/// virtual key. That mapping is a property of the active keyboard layout, not
/// of the character, and <see cref="LeagueVirtualKeys"/> shipped a hardcoded US
/// table for it. Measured on the en-GB layout this project is developed on:</para>
///
/// <code>
/// VkKeyScanEx('`', GetKeyboardLayout(0)) -> 0x00DF   (VK_OEM_8)
/// LeagueVirtualKeys' US table            -> 0xC0     (VK_OEM_3)
/// </code>
///
/// <para>0xC0 on en-GB is the <c>'</c>/<c>@</c> key. So a UK player whose shop
/// is on grave/backtick had their bind read perfectly out of their own config
/// and then had a completely different key polled for the rest of the session,
/// with a log line that named the character and never the key code. That is the
/// exact failure the keybind reader's doctrine names — "watching the wrong key
/// forever with nothing in the log to say so" — arriving through the one table
/// that was allowed to guess.</para>
///
/// <para><b>Fails soft, never wrong-soft.</b> A character that cannot be typed
/// unmodified on the active layout returns 0, and the caller falls back to the
/// US table rather than inventing a modified accelerator. A shop bind is an
/// unmodified key press; a mapping that needs Shift or AltGr to produce the
/// character is not the same key and must not be reported as one.</para>
/// </summary>
public static class WindowsKeyboardLayout
{
    /// <summary>
    /// The virtual key that types <paramref name="character"/> with no
    /// modifiers on the active layout, or 0 when there is none.
    /// </summary>
    public static uint ResolvePunctuation(char character)
    {
        if (!OperatingSystem.IsWindows()) return 0;

        try
        {
            var layout = GetKeyboardLayout(0);
            var scan = VkKeyScanEx(character, layout);
            if (scan == -1) return 0;

            var virtualKey = (uint)(scan & 0xFF);
            var shiftState = (scan >> 8) & 0xFF;
            // Any non-zero shift state means the character needs Shift, Ctrl or
            // Alt on this layout. That is a different accelerator, not this one.
            if (virtualKey == 0 || shiftState != 0) return 0;
            return virtualKey;
        }
        catch (DllNotFoundException) { return 0; }
        catch (EntryPointNotFoundException) { return 0; }
    }

    /// <summary>The active layout's identifier, for the log line that names the resolved key.</summary>
    public static string Describe()
    {
        if (!OperatingSystem.IsWindows()) return "non-windows";
        try
        {
            return $"0x{GetKeyboardLayout(0).ToInt64():X8}";
        }
        catch (DllNotFoundException) { return "unknown"; }
        catch (EntryPointNotFoundException) { return "unknown"; }
    }

    [DllImport("user32.dll")]
    private static extern short VkKeyScanEx(char ch, IntPtr dwhkl);

    [DllImport("user32.dll")]
    private static extern IntPtr GetKeyboardLayout(uint idThread);
}
