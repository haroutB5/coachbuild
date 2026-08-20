using System.Text.Json;
using CoachBuild.Core;
using Xunit;

namespace CoachBuild.Core.Tests;

/// <summary>
/// The anomaly line is the ONLY instrumentation this defect has, and an
/// untested log line is how the 2026-08-19 Kennen anomaly survived three rounds
/// of investigation without a cause.
///
/// <para>The field data below is not invented. It is the ten (level, purchased)
/// states machine-extracted from
/// <c>_evidence/gaming-pc-companion-2026-08-19-1017.log</c> and the raw ranks a
/// standard Kennen order produces over them, so a change that stops the line
/// answering the real question fails against the real question.</para>
/// </summary>
public sealed class KitAnomalyLineTests
{
    private const int Kennen = 85;

    private static string Line(
        int level,
        int[] ranks,
        int? championId = Kennen,
        string? name = "Kennen",
        LiveGameMode? mode = null)
    {
        var kit = ChampionKit.For(championId);
        return KitAnomalyLine.Format(
            name, championId, SkillPointArithmetic.Evaluate(level, ranks, kit), ranks, kit, mode);
    }

    // ------------------------------------------------------- what it must say

    /// <summary>
    /// The five field occurrences, replayed. Every one of them printed
    /// "level L, L+1 purchased" and stopped there; the sum is the number that
    /// cannot discriminate, so the raw ranks have to be beside it.
    /// </summary>
    [Theory]
    [InlineData(10, 5, 4, 1, 1)]
    [InlineData(11, 5, 5, 1, 1)]
    [InlineData(12, 5, 5, 2, 1)]
    [InlineData(13, 5, 5, 3, 1)]
    [InlineData(14, 5, 5, 4, 1)]
    public void The_line_carries_the_four_raw_ranks_not_only_their_sum(
        int level, int q, int w, int e, int r)
    {
        var line = Line(level, [q, w, e, r], mode: new LiveGameMode("CLASSIC", 11));

        Assert.Contains($"ranks Q/W/E/R={q}/{w}/{e}/{r}", line, StringComparison.Ordinal);
        Assert.Contains($"level {level}, {level + 1} purchased", line, StringComparison.Ordinal);
        Assert.Contains("Kennen (id 85)", line, StringComparison.Ordinal);
    }

    /// <summary>
    /// Without the caps beside the ranks, "Q = 6 on a five-cap champion" — a
    /// wire or data defect rather than an arithmetic one — reads exactly like a
    /// legal reading.
    /// </summary>
    [Fact]
    public void The_line_carries_the_caps_the_ranks_are_being_measured_against()
    {
        Assert.Contains("against caps 5/5/5/3 freeR 0", Line(10, [5, 4, 1, 1]), StringComparison.Ordinal);
        Assert.Contains(
            "against caps 6/6/6/1 freeR 1",
            Line(3, [2, 2, 0, 1], championId: 126, name: "Jayce"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void The_line_carries_the_game_mode()
    {
        Assert.Contains(
            "mode=CLASSIC map=11",
            Line(10, [5, 4, 1, 1], mode: new LiveGameMode("CLASSIC", 11)),
            StringComparison.Ordinal);
        Assert.Contains(
            "mode=ARAM map=12",
            Line(10, [5, 4, 1, 1], mode: new LiveGameMode("ARAM", 12)),
            StringComparison.Ordinal);
    }

    /// <summary>
    /// A missing mode is stated, not omitted. "The client published no mode"
    /// and "this build does not read the mode" have to look different in a
    /// pasted log, because for two days they were the same thing.
    /// </summary>
    [Fact]
    public void An_unknown_mode_says_so_rather_than_vanishing()
    {
        Assert.Contains("mode=unknown map=unknown", Line(10, [5, 4, 1, 1]), StringComparison.Ordinal);
        Assert.Contains(
            "mode=CLASSIC map=?",
            Line(10, [5, 4, 1, 1], mode: new LiveGameMode("CLASSIC", null)),
            StringComparison.Ordinal);
        Assert.Contains(
            "mode=? map=11",
            Line(10, [5, 4, 1, 1], mode: new LiveGameMode(null, 11)),
            StringComparison.Ordinal);
    }

    // ------------------------------------------------- what it must NOT say

    /// <summary>
    /// The old line asserted the cause: "this champion grants a free rank
    /// ChampionKit does not list". ddragon 16.16.1 disproves that for Kennen —
    /// he is 5/5/5/3 with no free rank, and a free rank on that shape would
    /// leave 17 purchasable ranks against 18 points. A diagnostic that hands
    /// the reader a wrong answer is worse than one that hands them none: the
    /// first two investigations of this defect started from that sentence.
    /// </summary>
    [Fact]
    public void The_line_does_not_assert_a_cause_it_cannot_know()
    {
        var line = Line(10, [5, 4, 1, 1], mode: new LiveGameMode("CLASSIC", 11));

        Assert.DoesNotContain("grants a free rank", line, StringComparison.Ordinal);
        Assert.Contains("Cause is not established", line, StringComparison.Ordinal);
        // And it still says what the overlay is doing about it, which is the
        // part a user reading the log actually needs.
        Assert.Contains("always-on", line, StringComparison.Ordinal);
    }

    // ------------------------------------------------------------- robustness

    [Fact]
    public void An_unknown_champion_and_a_short_rank_array_do_not_throw()
    {
        var kit = ChampionKit.Standard;
        var line = KitAnomalyLine.Format(
            null, null, SkillPointArithmetic.Evaluate(1, [1, 1], kit), [1, 1], kit, null);

        Assert.Contains("for ? (id none)", line, StringComparison.Ordinal);
        Assert.Contains("ranks Q/W/E/R=1/1/?/?", line, StringComparison.Ordinal);
    }

    /// <summary>
    /// The line is deduped one-per-transition by its caller, which compares
    /// whole strings. If two genuinely different readings rendered identically
    /// the second would be swallowed, and the five field occurrences differed
    /// only in their ranks.
    /// </summary>
    [Fact]
    public void Two_different_readings_do_not_render_to_the_same_line()
    {
        var mode = new LiveGameMode("CLASSIC", 11);
        var lines = new[]
        {
            Line(10, [5, 4, 1, 1], mode: mode),
            Line(11, [5, 5, 1, 1], mode: mode),
            Line(12, [5, 5, 2, 1], mode: mode),
            Line(13, [5, 5, 3, 1], mode: mode),
            Line(14, [5, 5, 4, 1], mode: mode),
        };

        Assert.Equal(lines.Length, lines.Distinct(StringComparer.Ordinal).Count());
    }

    // -------------------------------------------------- reading the game mode

    private static JsonElement Json(string text) => JsonDocument.Parse(text).RootElement.Clone();

    [Fact]
    public void The_mode_is_read_off_the_allgamedata_body_the_poller_already_fetches()
    {
        var mode = LiveGameModeReader.TryRead(Json(
            """{"activePlayer":{},"gameData":{"gameMode":"CLASSIC","gameTime":412.5,"mapName":"Map11","mapNumber":11,"mapTerrain":"Default"}}"""));

        Assert.NotNull(mode);
        Assert.Equal("CLASSIC", mode.Mode);
        Assert.Equal(11, mode.MapNumber);
        Assert.Equal("mode=CLASSIC map=11", mode.Describe());
    }

    [Fact]
    public void An_aram_body_reads_as_aram()
    {
        var mode = LiveGameModeReader.TryRead(Json("""{"gameData":{"gameMode":"ARAM","mapNumber":12}}"""));

        Assert.Equal("mode=ARAM map=12", mode?.Describe());
    }

    /// <summary>
    /// Riot has moved this surface before, so a body that publishes half of it
    /// still answers half the question rather than none of it.
    /// </summary>
    [Theory]
    [InlineData("""{"gameData":{"gameMode":"CLASSIC"}}""", "mode=CLASSIC map=?")]
    [InlineData("""{"gameData":{"mapNumber":11}}""", "mode=? map=11")]
    [InlineData("""{"gameData":{"gameMode":"CLASSIC","mapNumber":"11"}}""", "mode=CLASSIC map=11")]
    public void A_partial_body_still_answers_what_it_can(string body, string expected)
    {
        Assert.Equal(expected, LiveGameModeReader.TryRead(Json(body))?.Describe());
    }

    [Theory]
    [InlineData("""{"gameData":{}}""")]
    [InlineData("""{"gameData":{"gameMode":"   "}}""")]
    [InlineData("""{"gameData":null}""")]
    [InlineData("""{"activePlayer":{"level":7}}""")]
    [InlineData("""[]""")]
    [InlineData("""{"gameData":{"gameMode":42,"mapNumber":{"x":1}}}""")]
    public void A_body_with_nothing_to_say_returns_null_rather_than_a_blank_record(string body)
    {
        Assert.Null(LiveGameModeReader.TryRead(Json(body)));
    }

    /// <summary>
    /// This string is printed into a log the user pastes and it arrives over a
    /// wire this process does not control.
    /// </summary>
    [Fact]
    public void A_hostile_mode_string_is_bounded()
    {
        var body = "{\"gameData\":{\"gameMode\":\"" + new string('X', 400) + "\",\"mapNumber\":11}}";
        var mode = LiveGameModeReader.TryRead(Json(body));

        Assert.Equal(32, mode?.Mode?.Length);
    }

    [Theory]
    [InlineData("""{"gameData":{"gameMode":"CLASSIC","mapNumber":-5}}""", "mode=CLASSIC map=?")]
    [InlineData("""{"gameData":{"gameMode":"CLASSIC","mapNumber":99999}}""", "mode=CLASSIC map=?")]
    public void An_impossible_map_number_is_dropped_rather_than_printed(string body, string expected)
    {
        Assert.Equal(expected, LiveGameModeReader.TryRead(Json(body))?.Describe());
    }
}
