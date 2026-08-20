using System.Text;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Turns the optional <c>diagnostics</c> field of an <c>/apply-itemsets</c>
/// body into lines for <c>companion.log</c>.
///
/// <para><b>Why the field exists at all.</b> On 2026-08-20 an exhausted Neon
/// compute quota answered 402, <c>/api/pros</c> and <c>/api/otp</c> caught the
/// driver error and answered 500, and <c>buildItemSets</c> read the resulting
/// <c>null</c> as "this champion has no data, omit the block". Two completely
/// different facts, one value: for nine hours every export shipped without its
/// Pro and OTP blocks and the only signal anywhere in the system was the user
/// eventually noticing two missing blocks in their shop panel. The web now
/// sends the reason across the wire; this reads it. See
/// <c>components/hextech/itemSetsApply.ts</c>'s <c>ConsensusResolution</c>.</para>
///
/// <para><b>This can never fail an apply.</b> Same posture as
/// <see cref="SituationalOverlayParser"/> and for the same reason: the field is
/// commentary on a write that changes the player's League config, so a
/// malformed line must cost the player some log text and never their item set.
/// The field is read as a raw <see cref="JsonElement"/> so a typed
/// <c>string[]</c> cannot throw inside <c>JsonSerializer.Deserialize</c> and
/// turn the WHOLE request into <c>default</c>, and
/// <see cref="ApplyPayloadValidation.TryValidateItemSets"/> is not consulted
/// and not extended.</para>
///
/// <para><b>The sender is not trusted.</b> These lines are free text chosen by
/// whatever POSTed to the bridge, and they land in the one file the user is
/// asked to send us. So every line is bounded, stripped of control characters
/// here, and then redacted by <see cref="ComplianceRules.Redact"/> on the way
/// into <see cref="RedactedLog"/> — which is where the identifier rules live,
/// deliberately, so this class does not invent a second redaction policy.</para>
/// </summary>
public static class ApplyDiagnosticsParser
{
    /// <summary>
    /// The web emits at most one line per consensus source and there are two
    /// (<c>pro</c>, <c>otp</c>). Four is that, doubled, so adding a third block
    /// does not silently truncate — and small enough that a buggy or hostile
    /// payload cannot page the rest of the log out through
    /// <see cref="CompanionWire.MaxLogBytes"/>. Truncation is never silent: it
    /// is reported as a rejection.
    /// </summary>
    public const int MaxLines = 4;

    /// <summary>
    /// Longest line written. The longest sentence
    /// <c>consensusFailureLine</c> can build from its own template is around
    /// 240 characters, but the network branch interpolates a JavaScript
    /// <c>Error.message</c>, which is unbounded.
    /// </summary>
    public const int MaxLineLength = 512;

    /// <summary>
    /// Over-long lines are CUT, not dropped. A rejected line loses the whole
    /// signal, which is the one thing this feature exists to deliver; the head
    /// of the sentence is where the block name and the reason live, and the
    /// marker keeps the result from reading as a complete thought.
    /// </summary>
    public const string TruncationMarker = " ...[cut]";

    public static IReadOnlyList<string> Parse(JsonElement? diagnostics, out IReadOnlyList<string> rejections)
    {
        var rejected = new List<string>();
        rejections = rejected;
        var lines = new List<string>();

        // ABSENT IS NORMAL AND SILENT. Every healthy export omits the key
        // entirely, so an "and there were no diagnostics" line would print on
        // every apply forever and be tuned out inside a day — taking the one
        // line that matters with it.
        if (diagnostics is not { } element) return lines;
        if (element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return lines;
        if (element.ValueKind != JsonValueKind.Array)
        {
            rejected.Add($"diagnostics is {element.ValueKind}, not an array");
            return lines;
        }

        var index = -1;
        foreach (var entry in element.EnumerateArray())
        {
            index++;
            if (lines.Count >= MaxLines)
            {
                rejected.Add($"more than {MaxLines} lines; the rest were dropped");
                break;
            }

            if (entry.ValueKind != JsonValueKind.String)
            {
                rejected.Add($"line {index} is {entry.ValueKind}, not a string");
                continue;
            }

            var text = Sanitize(entry.GetString());
            if (string.IsNullOrEmpty(text))
            {
                rejected.Add($"line {index} is blank");
                continue;
            }

            if (text.Length > MaxLineLength)
            {
                text = string.Concat(text.AsSpan(0, MaxLineLength), TruncationMarker);
                rejected.Add($"line {index} was longer than {MaxLineLength} characters and was cut");
            }

            lines.Add(text);
        }

        return lines;
    }

    /// <summary>
    /// Control characters out, then trim.
    ///
    /// <para><see cref="RedactedLog.Append"/> already flattens CR and LF so one
    /// event cannot become two log entries. This covers the rest of C0/C1 —
    /// NUL, TAB, and above all ESC, which is how a line in a file the user is
    /// about to open in a terminal turns into an ANSI escape sequence. The
    /// replacement is a space rather than nothing so two words cannot be joined
    /// into a third that was never sent.</para>
    /// </summary>
    private static string Sanitize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        var builder = new StringBuilder(value.Length);
        foreach (var character in value)
            builder.Append(char.IsControl(character) ? ' ' : character);
        return builder.ToString().Trim();
    }
}
