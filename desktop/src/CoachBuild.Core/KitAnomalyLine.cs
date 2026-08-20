using System.Globalization;

namespace CoachBuild.Core;

/// <summary>
/// The one line that gets emitted when a champion's ability ranks do not add up
/// against its level — and the only field instrumentation this defect has.
///
/// <para><b>Why this is not just a string in the overlay.</b> Through 1.0.19 the
/// line printed the champion, the level and the SUM of the ranks, plus a
/// sentence asserting that the champion "grants a free rank ChampionKit does not
/// list". A Kennen game on 2026-08-19 produced five of these, and the
/// investigation that followed could not close, because:</para>
///
/// <list type="number">
/// <item>The asserted cause is wrong. ddragon 16.16.1 has Kennen at 5/5/5/3
/// with no free rank, and a free rank on that shape is not something League
/// contains — it would leave 17 purchasable ranks against 18 points. The line
/// was telling every reader the answer, and the answer was disproven.</item>
/// <item>The SUM cannot discriminate. "11 purchased at level 10" is produced
/// identically by a rank granted outside the level schedule, by a level field
/// that under-reports, and by the champion having been mis-identified — three
/// different bugs with three different fixes.</item>
/// <item>Nothing recorded the game mode, so "this mode granted a point" could
/// not be tested at all.</item>
/// </list>
///
/// <para>So the line now states what was observed and nothing about why. Raw
/// ranks, the caps they are being measured against, and the mode. What a future
/// occurrence separates:</para>
///
/// <list type="table">
/// <item><term>a slot above its own cap</term><description>wire or data defect,
/// not arithmetic</description></item>
/// <item><term>R ranked earlier than its schedule allows</term><description>a
/// rank granted outside the normal rules</description></item>
/// <item><term>every slot legal, sum = level + 1, mode is not
/// CLASSIC</term><description>the mode granted the point</description></item>
/// <item><term>every slot legal, sum = level + 1, mode is
/// CLASSIC</term><description>look at the <c>live: identity matched by …</c>
/// lines: the champion in use is the leading suspect</description></item>
/// </list>
///
/// <para>Kept out of the overlay window so it can be tested without a WPF
/// message pump, and so the shape of the line is pinned by a test rather than
/// by whoever last edited a render method.</para>
/// </summary>
public static class KitAnomalyLine
{
    /// <param name="championName">As resolved for this game; may be null.</param>
    /// <param name="championId">The id the kit was looked up by. Printed
    /// because a wrong id here IS one of the live hypotheses.</param>
    /// <param name="points">The arithmetic's own verdict.</param>
    /// <param name="ranks">Q, W, E, R, raw, exactly as Live Client Data
    /// reported them.</param>
    /// <param name="kit">What those ranks were measured against.</param>
    /// <param name="mode">The game mode, when the host knows it. Null prints as
    /// <c>mode=unknown</c> rather than being omitted, so a log with no mode is
    /// visibly a log with no mode.</param>
    public static string Format(
        string? championName,
        int? championId,
        SkillPointState points,
        IReadOnlyList<int> ranks,
        ChampionKit kit,
        LiveGameMode? mode)
    {
        ArgumentNullException.ThrowIfNull(ranks);
        ArgumentNullException.ThrowIfNull(kit);

        return $"overlay: point arithmetic incoherent for {championName ?? "?"}"
            + $" (id {Number(championId)}):"
            + $" level {Number(points.Level)}, {Number(points.Purchased)} purchased,"
            + $" ranks Q/W/E/R={Slots(ranks)}"
            + $" against caps {kit.MaxQ}/{kit.MaxW}/{kit.MaxE}/{kit.MaxR} freeR {kit.FreeR},"
            + $" {mode?.Describe() ?? "mode=unknown map=unknown"}."
            + " More ranks than levels can pay for. Cause is not established:"
            + " compare the raw ranks against the caps and the ultimate schedule,"
            + " and cross-check the champion against the live: identity lines."
            + " The highlight stays always-on meanwhile rather than never showing.";
    }

    private static string Slots(IReadOnlyList<int> ranks)
    {
        var slots = new string[4];
        for (var slot = 0; slot < 4; slot++)
            slots[slot] = slot < ranks.Count ? Number(ranks[slot]) : "?";
        return string.Join("/", slots);
    }

    private static string Number(int? value) =>
        value?.ToString(CultureInfo.InvariantCulture) ?? "none";

    private static string Number(int value) => value.ToString(CultureInfo.InvariantCulture);
}
