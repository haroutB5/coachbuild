using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The rune gate, characterised against the REAL /apply-runes body as bytes,
/// not against a hand-built <see cref="ApplyRunesRequest"/>.
///
/// <para>Every other rune test in this repo constructs the request object
/// directly (RuneOwnershipTests.Request), which supplies every field the gate
/// demands and therefore cannot see a payload defect. The literal below is the
/// shipped bundle's own output: minified <c>buildRuneApplyBody</c> (prod chunk
/// 2sc_3i7ophl32.js) spread into <c>JSON.stringify({...body, mode})</c> by
/// <c>applyRunes</c>, with the perk ids from a live
/// <c>GET /api/build?champ=103&amp;role=2</c> captured 2026-08-20.</para>
/// </summary>
public sealed class RunePayloadValidationTests
{
    private const string ProductionBody =
        "{\"name\":\"CoachBuild Ahri Mid\"," +
        "\"primaryStyleId\":8100," +
        "\"subStyleId\":8200," +
        "\"selectedPerkIds\":[8112,8139,8137,8106,8237,8233,5008,5008,5011]," +
        "\"current\":true," +
        "\"replacePrefix\":\"CoachBuild Ahri \"," +
        "\"mode\":\"auto\"}";

    [Fact]
    public void The_shipped_web_payload_survives_the_wire_and_passes_the_gate()
    {
        var request = JsonSerializer.Deserialize<ApplyRunesRequest>(ProductionBody, JsonOptions.Wire);

        Assert.NotNull(request);
        Assert.Equal("CoachBuild Ahri Mid", request!.Name);
        Assert.Equal(8100, request.PrimaryStyleId);
        Assert.Equal(8200, request.SubStyleId);
        Assert.Equal(9, request.SelectedPerkIds?.Count);
        Assert.Equal("auto", request.Mode);
        Assert.Equal("CoachBuild Ahri ", request.ReplacePrefix);

        Assert.Null(ApplyPayloadValidation.RuneRejection(request));
        Assert.True(
            ApplyPayloadValidation.TryValidateRunes(request, out var failure),
            $"the shipped payload was rejected: {failure?.Reason} / {failure?.Hint}");
    }

    /// <summary>
    /// The one field the old gate demanded that nothing downstream reads.
    /// <c>RuneApplyService.CreatePageBody</c> hardcodes <c>current = true</c>
    /// and <c>CompleteAsync</c> selects the page unconditionally, so a client
    /// that omits it (companion.ps1 never required it either) must not be
    /// refused. Both shapes below were rejected as "invalid-page" before.
    /// </summary>
    [Theory]
    [InlineData("\"current\":false,")]
    [InlineData("")]
    public void An_absent_or_false_current_flag_is_not_grounds_for_rejection(string currentField)
    {
        var body =
            "{\"name\":\"CoachBuild Ahri Mid\",\"primaryStyleId\":8100,\"subStyleId\":8200," +
            "\"selectedPerkIds\":[8112,8139,8137,8106,8237,8233,5008,5008,5011]," +
            currentField +
            "\"replacePrefix\":\"CoachBuild Ahri \",\"mode\":\"auto\"}";

        var request = JsonSerializer.Deserialize<ApplyRunesRequest>(body, JsonOptions.Wire);

        Assert.False(request!.Current);
        Assert.Null(ApplyPayloadValidation.RuneRejection(request));
    }

    [Fact]
    public void An_unreadable_body_is_bad_body()
    {
        Assert.Equal("bad-body", ApplyPayloadValidation.RuneRejection(null));
        Assert.False(ApplyPayloadValidation.TryValidateRunes(null, out var failure));
        Assert.Equal("bad-body", failure.Reason);
        Assert.Equal(ApplyPayloadValidation.RunePayloadHint("bad-body"), failure.Hint);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("Ranked Page 1")]
    // U+00AD soft hyphen: folds into "CoachBuild" under a culture-aware
    // comparison, must not under the ordinal one this gate uses.
    [InlineData("Coach­Build Ahri Mid")]
    public void A_title_that_is_not_ours_is_bad_title(string? name)
    {
        Assert.Equal("bad-title", ApplyPayloadValidation.RuneRejection(Request(name: name)));
    }

    [Theory]
    [InlineData("Ranked Page 1")]
    [InlineData("Coach­Build ")]
    public void A_present_but_foreign_replace_prefix_is_bad_title(string replacePrefix)
    {
        Assert.Equal("bad-title", ApplyPayloadValidation.RuneRejection(Request(replacePrefix: replacePrefix)));
        // Absent stays legal -- an older web build simply omits it.
        Assert.Null(ApplyPayloadValidation.RuneRejection(Request(replacePrefix: null)));
    }

    [Fact]
    public void A_malformed_rune_selection_is_bad_runes()
    {
        // Built here rather than through Request(), whose `perks ?? default`
        // would quietly substitute a valid selection for the null case.
        Assert.Equal("bad-runes", ApplyPayloadValidation.RuneRejection(
            new ApplyRunesRequest("CoachBuild Ahri Mid", 8100, 8200, null, true, "auto", "CoachBuild Ahri ")));
        Assert.Equal("bad-runes", ApplyPayloadValidation.RuneRejection(Request(perks: [1, 2, 3])));
        Assert.Equal("bad-runes", ApplyPayloadValidation.RuneRejection(Request(perks: [1, 2, 3, 4, 5, 6, 7, 8, 0])));
        Assert.Equal("bad-runes", ApplyPayloadValidation.RuneRejection(Request(primary: 0)));
        Assert.Equal("bad-runes", ApplyPayloadValidation.RuneRejection(Request(sub: -1)));
    }

    /// <summary>
    /// The two bridges answer the same endpoint for the same web client, so
    /// their reason strings and hint text must be one vocabulary, not two.
    /// Read out of companion.ps1 rather than restated, so a future edit to
    /// either side fails here instead of drifting silently.
    /// </summary>
    [Fact]
    public void The_reason_and_hint_vocabulary_matches_companion_ps1()
    {
        var script = File.ReadAllText(FindRepoFile(Path.Combine("public", "companion.ps1")));

        foreach (var reason in new[] { "bad-body", "bad-title", "bad-runes" })
        {
            Assert.Contains($"return '{reason}'", script, StringComparison.Ordinal);
            Assert.Contains(
                $"'{ApplyPayloadValidation.RunePayloadHint(reason)}'",
                script,
                StringComparison.Ordinal);
        }

        Assert.Contains(
            $"'{ApplyPayloadValidation.RunePayloadHint("something-else")}'",
            script,
            StringComparison.Ordinal);
    }

    private static ApplyRunesRequest Request(
        string? name = "CoachBuild Ahri Mid",
        int primary = 8100,
        int sub = 8200,
        IReadOnlyList<int>? perks = null,
        string? replacePrefix = "CoachBuild Ahri ") =>
        new(name, primary, sub, perks ?? [8112, 8139, 8137, 8106, 8237, 8233, 5008, 5008, 5011],
            true, "auto", replacePrefix);

    internal static string FindRepoFile(string relativePath)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory);
             directory is not null;
             directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException($"could not find {relativePath} above {AppContext.BaseDirectory}");
    }
}
