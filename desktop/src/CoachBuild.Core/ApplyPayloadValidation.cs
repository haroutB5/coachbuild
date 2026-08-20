using System.Text.Json;

namespace CoachBuild.Core;

public static class ApplyPayloadValidation
{
    public static bool IsCoachBuildTitle(string? title) =>
        !string.IsNullOrEmpty(title) && title.StartsWith("CoachBuild", StringComparison.Ordinal);

    public static bool IsValidReplacePrefix(string? replacePrefix) =>
        string.IsNullOrEmpty(replacePrefix) || IsCoachBuildTitle(replacePrefix);

    public static bool TryValidateRunes(ApplyRunesRequest? request, out ApplyRunesFailure failure)
    {
        var reason = RuneRejection(request);
        if (reason is null)
        {
            failure = null!;
            return true;
        }
        failure = new ApplyRunesFailure(reason, RunePayloadHint(reason));
        return false;
    }

    /// <summary>
    /// The rune-write gate. Returns <c>null</c> for an acceptable payload,
    /// else the SPECIFIC cause: <c>bad-body</c> | <c>bad-title</c> |
    /// <c>bad-runes</c>.
    ///
    /// <para>Vocabulary parity with <c>public/companion.ps1</c>'s
    /// <c>Get-RunePayloadRejection</c> is deliberate and load-bearing: the two
    /// bridges answer the same endpoint for the same web client, so a reason
    /// string that exists on only one of them is a reason string nobody can
    /// interpret. The PowerShell bridge split its single opaque
    /// <c>invalid-page</c> into these three (with per-cause hints) after it
    /// fired 83x in 3 days with no way to tell a parse failure from a wrong
    /// title from a malformed perk array; the C# bridge kept the opaque
    /// string, and paid the same cost again.</para>
    ///
    /// <para>WHAT IS DELIBERATELY NOT CHECKED: <c>current</c>.
    /// <see cref="RuneApplyService"/> hardcodes <c>current = true</c> in the
    /// page body it POSTs and selects the page unconditionally in
    /// <c>CompleteAsync</c>, so the field on the request is read by nothing.
    /// Rejecting a payload over it -- as this gate used to -- could only ever
    /// refuse a client that omitted an inert field, which is exactly the kind
    /// of trap the PowerShell gate never had.</para>
    /// </summary>
    public static string? RuneRejection(ApplyRunesRequest? request)
    {
        if (request is null) return "bad-body";
        // Ordinal, so a soft hyphen (U+00AD) or other zero-width lookalike
        // cannot fold into "CoachBuild" and smuggle a foreign title past the
        // write gate. Same reasoning for the stale-removal prefix, which is
        // just as capable of touching pages that are not ours; absent
        // (an older web build) always passes.
        if (!IsCoachBuildTitle(request.Name)) return "bad-title";
        if (!IsValidReplacePrefix(request.ReplacePrefix)) return "bad-title";
        if (request.SelectedPerkIds is null || request.SelectedPerkIds.Count != 9) return "bad-runes";
        if (request.SelectedPerkIds.Any(x => x <= 0)) return "bad-runes";
        if (request.PrimaryStyleId <= 0 || request.SubStyleId <= 0) return "bad-runes";
        return null;
    }

    /// <summary>
    /// Cause-specific hint, character-identical to <c>companion.ps1</c>'s
    /// <c>Get-RunePayloadHint</c> (pinned by a test that reads that file).
    /// The web client surfaces <c>hint</c> verbatim and only branches on
    /// <c>slots-full</c>/<c>user-modified</c>, so this stays wire-safe.
    /// </summary>
    public static string RunePayloadHint(string reason) => reason switch
    {
        "bad-body" => "the rune request could not be read -- reload the page and try again",
        "bad-title" => "that is not a CoachBuild rune page -- CoachBuild only ever writes its own pages",
        "bad-runes" => "the rune selection was incomplete or malformed (need 9 rune ids) -- reopen the build and try again",
        _ => "the rune request was rejected",
    };

    public static bool TryValidateItemSets(
        ApplyItemSetsRequest? request,
        out ApplyItemSetsFailure failure)
    {
        if (request is null || request.ChampionId <= 0 ||
            request.Sets is null || request.Sets.Count is < 1 or > 3 ||
            !IsValidReplacePrefix(request.ReplacePrefix) ||
            request.Sets.Any(set => !TryReadTitle(set, out var title) || !IsCoachBuildTitle(title)))
        {
            failure = new ApplyItemSetsFailure(
                "invalid-sets",
                "each set title (and replacePrefix, if given) must start with \"CoachBuild\" (1-3 sets)");
            return false;
        }
        failure = null!;
        return true;
    }

    public static bool TryReadTitle(JsonElement set, out string? title)
    {
        title = null;
        if (set.ValueKind != JsonValueKind.Object || !set.TryGetProperty("title", out var value) ||
            value.ValueKind != JsonValueKind.String)
            return false;
        title = value.GetString();
        return !string.IsNullOrWhiteSpace(title);
    }
}
