using System.Text;
using System.Text.Json.Serialization;

namespace CoachBuild.Core;

/// <summary>
/// What one "Send diagnostics to My Stats" click did, in terms the user can be
/// told about.
///
/// <para>Six values rather than a bool, because "nothing happened" is the
/// failure mode this whole feature exists to avoid. The user is on a separate
/// gaming PC with no way to copy a file off it; if the button can be pressed and
/// produce no visible result, they are back to photographing the screen and they
/// have no way to know which of these six they hit.</para>
/// </summary>
public enum DiagnosticsUploadOutcome
{
    /// <summary>The server took it.</summary>
    Sent,

    /// <summary>No account secret. The tray's pairing item has not been used.</summary>
    NotPaired,

    /// <summary>There is no companion.log, or it is empty.</summary>
    NoLog,

    /// <summary>The League client could not name the Riot ID the upload files under.</summary>
    NoIdentity,

    /// <summary>The endpoint answered and said no. Same next time; retrying is noise.</summary>
    Rejected,

    /// <summary>Offline, timed out, 5xx, unreadable. Unknown whether anything landed.</summary>
    Failed,
}

/// <summary>
/// The body posted to <c>POST /api/mystats/diagnostics</c>.
///
/// <para>Identity is <c>gameName</c> + <c>tagLine</c> and deliberately NOT a
/// puuid, for exactly the reason <see cref="RankSampleBody"/> states: the League
/// client's puuid is a 36-char local UUID, not the Riot key
/// <c>coachbuild.my_matches</c> is joined on. The route resolves identity
/// server-side through the same <c>linkAccount</c> path the rank-sample endpoint
/// uses, and its <c>parseDiagnosticsIdentity</c> has no puuid branch at all.</para>
/// </summary>
public sealed record DiagnosticsBody(
    [property: JsonPropertyName("gameName")] string GameName,
    [property: JsonPropertyName("tagLine")] string TagLine,
    [property: JsonPropertyName("body")] string Body,
    [property: JsonPropertyName("source")] string Source)
{
    /// <summary>
    /// Must equal <c>DIAGNOSTICS_SOURCE</c> in lib/mystats/diagnostics.ts, which
    /// is a CLOSED vocabulary of exactly this one value: the route rejects
    /// anything else with a 400 before it reaches the database, and migration
    /// 0028 says the same thing in its column comment.
    /// </summary>
    public const string CompanionSource = "companion";

    /// <summary>
    /// Must equal <c>DIAGNOSTICS_BODY_MAX_BYTES</c> in lib/mystats/diagnostics.ts.
    ///
    /// <para>The server measures UTF-8 BYTES, so this side does too. It is a
    /// larger number than <see cref="LogTail.MaxTailBytes"/> on purpose:
    /// redaction can LENGTHEN text (<c>session=a</c> is nine bytes,
    /// <c>session=[redacted]</c> is eighteen), so a 200KB tail is not guaranteed
    /// to still be 200KB once the policy has run over it. Trimming against the
    /// server's own number after redaction is what stops a pathological log
    /// turning this button into an unexplained "rejected".</para>
    /// </summary>
    public const int MaxWireBytes = 256 * 1024;

    public static DiagnosticsBody Create(OwnIdentity identity, string body) =>
        new(identity.GameName, identity.TagLine, body, CompanionSource);
}

/// <summary>
/// The POST half, abstracted so a test needs no socket. Implemented by
/// <see cref="RankSampleClient"/>, which is the single My Stats transport.
/// </summary>
public interface IDiagnosticsSink
{
    Task<RankSamplePostResult> PostAsync(DiagnosticsBody body, string secret, CancellationToken cancellationToken);
}

/// <summary>
/// Reader for the END of a text file. The only impure part is opening the
/// stream, and that has its own seam.
///
/// <para><b>Why a tail and not a filter.</b> The obviously cheaper design is to
/// grep companion.log for the lines that look interesting and send only those.
/// That is a filter written today against the bugs known today, and the entire
/// reason this feature exists is the bug that is NOT known yet. A filter would
/// silently omit exactly the evidence the next investigation needs, and would do
/// it invisibly, because a line that was filtered out looks identical to a line
/// that never happened. The tail is dumb on purpose.</para>
///
/// <para><b>Why the cap is barely a cap.</b> <see cref="RedactedLog"/> already
/// trims itself to <see cref="CompanionWire.MaxLogBytes"/>, so on any healthy
/// install the tail IS the whole file. The number is stated anyway so a log that
/// grew by some path this class does not know about still produces a bounded
/// upload.</para>
/// </summary>
public static class LogTail
{
    /// <summary>
    /// Tied to the log's own ceiling rather than to a second literal, so the two
    /// cannot drift into disagreeing about how much history exists.
    /// </summary>
    public const int MaxTailBytes = CompanionWire.MaxLogBytes;

    private const char ByteOrderMark = '﻿';

    /// <summary>
    /// The last <paramref name="maxBytes"/> bytes of <paramref name="path"/>, or
    /// null for a blank path, an absent file, an empty file, or any IO failure.
    ///
    /// <para><b>Opened shared for read, write AND delete.</b> The process doing
    /// the reading is the process appending to this file; an exclusive open would
    /// make the diagnostics button able to break logging, which is precisely
    /// backwards.</para>
    /// </summary>
    public static string? Read(string? path, int maxBytes = MaxTailBytes)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            if (!File.Exists(path)) return null;
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            return ReadFrom(stream, maxBytes);
        }
        catch
        {
            // A log that cannot be read is an upload that does not happen, never
            // an exception a tray click can see.
            return null;
        }
    }

    /// <summary>
    /// The tail of an already-open stream. Separated from <see cref="Read"/> so
    /// the boundary rules below are testable without touching a disk.
    ///
    /// <para><b>A truncated tail never begins mid-line.</b> The first partial
    /// line is dropped, which also disposes of the other half of the problem: a
    /// byte offset chosen by arithmetic can land inside a multi-byte UTF-8
    /// sequence, and the resulting replacement character would otherwise be the
    /// first thing in the file the user uploads.</para>
    /// </summary>
    public static string? ReadFrom(Stream? stream, int maxBytes = MaxTailBytes)
    {
        if (stream is null || !stream.CanRead || !stream.CanSeek) return null;
        // No floor. The caller names the cap and there are exactly two in
        // production (MaxTailBytes and DiagnosticsBody.MaxWireBytes); a floor
        // here would silently overrule both and there is no number that would
        // be right to overrule them WITH.
        var cap = Math.Max(1, maxBytes);
        var length = stream.Length;
        if (length <= 0) return null;

        var truncated = length > cap;
        var start = truncated ? length - cap : 0;
        stream.Seek(start, SeekOrigin.Begin);

        var buffer = new byte[(int)(length - start)];
        var read = 0;
        while (read < buffer.Length)
        {
            var got = stream.Read(buffer, read, buffer.Length - read);
            if (got <= 0) break;
            read += got;
        }
        if (read <= 0) return null;

        var text = new UTF8Encoding(false).GetString(buffer, 0, read);
        text = truncated ? DropPartialFirstLine(text) : StripBom(text);
        return text.Length == 0 ? null : text;
    }

    /// <summary>
    /// The tail of <paramref name="text"/> that fits in
    /// <paramref name="maxBytes"/> UTF-8 bytes, on a line boundary.
    ///
    /// <para>Runs the same code path as <see cref="ReadFrom"/> deliberately: one
    /// definition of "the last N bytes, starting at a line" means the read cap
    /// and the wire cap cannot come to disagree about where a boundary is.</para>
    /// </summary>
    public static string LimitBytes(string? text, int maxBytes)
    {
        if (string.IsNullOrEmpty(text)) return string.Empty;
        var bytes = Encoding.UTF8.GetBytes(text);
        if (bytes.Length <= maxBytes) return text;
        using var stream = new MemoryStream(bytes, writable: false);
        return ReadFrom(stream, maxBytes) ?? string.Empty;
    }

    /// <summary>
    /// Everything after the first newline. A tail with NO newline at all is one
    /// enormous line and is returned whole: dropping it would answer a
    /// pathological log with an empty upload, which reads to the user as the
    /// feature being broken.
    /// </summary>
    private static string DropPartialFirstLine(string text)
    {
        var newline = text.IndexOf('\n');
        return newline < 0 || newline + 1 >= text.Length ? text : text[(newline + 1)..];
    }

    private static string StripBom(string text) =>
        text.Length > 0 && text[0] == ByteOrderMark ? text[1..] : text;
}

/// <summary>
/// The sentence shown for each outcome, in one place.
///
/// <para>PURE, and in Core rather than in the WPF layer, so the wording is
/// testable and so the two presentation routes (a balloon for success, a modal
/// for everything else) cannot drift into describing the same outcome
/// differently.</para>
/// </summary>
public static class DiagnosticsMessages
{
    public const string Title = "CoachBuild diagnostics";

    /// <summary>
    /// Duplicated from <c>TrayMenuState.PairMyStatsVerb</c>, which lives in the
    /// WPF assembly that Core cannot reference. A Desktop-side test asserts the
    /// two are the same string, so <see cref="Text"/> cannot start naming a menu
    /// item that does not exist.
    /// </summary>
    public const string PairingVerb = "Pair desktop with My Stats…";

    /// <summary>True only for <see cref="DiagnosticsUploadOutcome.Sent"/>.</summary>
    public static bool IsSuccess(DiagnosticsUploadOutcome outcome) =>
        outcome == DiagnosticsUploadOutcome.Sent;

    /// <summary>
    /// What the user is told. Every non-success sentence names the next action,
    /// because the person reading it cannot get a file off that machine to ask
    /// anyone what it meant.
    /// </summary>
    public static string Text(DiagnosticsUploadOutcome outcome) => outcome switch
    {
        DiagnosticsUploadOutcome.Sent =>
            "Your companion log was sent to My Stats.",
        DiagnosticsUploadOutcome.NotPaired =>
            "This desktop is not paired with My Stats yet, so there is nowhere to send the log. Use \""
            + PairingVerb + "\" first.",
        DiagnosticsUploadOutcome.NoLog =>
            "There is no companion log to send yet. Open the League client or a champ select first, then try again.",
        DiagnosticsUploadOutcome.NoIdentity =>
            "CoachBuild could not read your Riot ID from the League client, and the upload is filed under it. "
            + "Start the League client and try again.",
        DiagnosticsUploadOutcome.Rejected =>
            "My Stats refused the upload. Re-pair the desktop with a fresh secret and try again.",
        _ =>
            "The upload did not go through. Check your connection and try again.",
    };

    /// <summary>The greppable companion.log word for each outcome.</summary>
    public static string LogWord(DiagnosticsUploadOutcome outcome) => outcome switch
    {
        DiagnosticsUploadOutcome.Sent => "sent",
        DiagnosticsUploadOutcome.NotPaired => "skipped -- no account secret configured",
        DiagnosticsUploadOutcome.NoLog => "skipped -- no log content to send",
        DiagnosticsUploadOutcome.NoIdentity => "skipped -- client identity unavailable",
        DiagnosticsUploadOutcome.Rejected => "rejected",
        _ => "failed",
    };
}
