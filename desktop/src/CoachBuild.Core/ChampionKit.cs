namespace CoachBuild.Core;

/// <summary>
/// How many ranks each ability slot can hold, and how many of them the game
/// GRANTS rather than sells.
///
/// <para>This exists because "points spent = Q+W+E+R" is false for four
/// champions, and the consequence is not cosmetic: it makes
/// <c>unspent = level - spent</c> permanently negative, so an overlay gated on
/// an unspent point would never draw for them in any game. Karma, Elise and
/// Nidalee get R rank 1 free at level 1; Jayce's Transform is a single free
/// rank he never pays for. A Karma at level 1 who has spent her one point
/// reads as Q1+R1 = 2 ranks against level 1.</para>
///
/// <para>The numbers are not invented here. They are the measured ddragon
/// <c>maxrank</c> values already carried by the web app in
/// <c>lib/championKit.ts</c> (<c>MEASURED_CHAMPION_KIT_SPECS</c>), ported so the
/// desktop overlay and the web app cannot drift apart. The free-rank semantics
/// are keyed on R's own maxrank there, exactly as they are keyed here:</para>
///
/// <list type="table">
/// <item><term>R maxrank 1</term><description>single free transform/stance (Jayce)</description></item>
/// <item><term>R maxrank 3</term><description>a true ultimate, nothing free (166 champions)</description></item>
/// <item><term>R maxrank 4</term><description>level-1 form swap, rank 1 free (Elise, Karma, Nidalee)</description></item>
/// <item><term>R maxrank 6</term><description>a fourth basic, nothing free (Udyr)</description></item>
/// </list>
///
/// <para><b>Deliberately not a hard gate.</b> An unknown future champion with
/// free ranks would make the arithmetic incoherent, and refusing to draw would
/// reproduce the exact silent blank this table exists to prevent. See
/// <see cref="SkillPointArithmetic"/>: incoherent readings fall back to the
/// pre-1.0.12 always-on behaviour and say so in the log, rather than hiding.</para>
/// </summary>
public sealed record ChampionKit(int MaxQ, int MaxW, int MaxE, int MaxR, int FreeR)
{
    /// <summary>
    /// Ability points in a game — one per level, and therefore also the number
    /// of purchasable ranks a champion who wastes nothing must have. Mirrors
    /// <c>TOTAL_LEVELS</c> in <c>lib/championKit.ts</c>.
    /// </summary>
    public const int TotalLevels = 18;

    /// <summary>5/5/5/3, nothing free. Correct for 166 of the 173 champions on the current roster.</summary>
    public static ChampionKit Standard { get; } = new(5, 5, 5, 3, 0);

    private static readonly IReadOnlyDictionary<int, ChampionKit> Measured =
        new Dictionary<int, ChampionKit>
        {
            [523] = new(6, 6, 6, 3, 0), // Aphelios — R is bought on the ordinary cadence
            [60] = new(5, 5, 5, 4, 1),  // Elise
            [126] = new(6, 6, 6, 1, 1), // Jayce — Transform is granted at level 1
            [43] = new(5, 5, 5, 4, 1),  // Karma
            [76] = new(5, 5, 5, 4, 1),  // Nidalee
            [77] = new(6, 6, 6, 6, 0),  // Udyr — R is a fourth basic, no level gate
            [350] = new(6, 5, 5, 3, 0), // Yuumi
            [234] = new(5, 5, 5, 3, 0), // Viego — measured, and standard
        };

    /// <summary>
    /// The champion's kit, or <see cref="Standard"/> when the id is unknown.
    /// Falling back rather than refusing is deliberate: 166 champions are
    /// standard, and the four that are not are all in the table above.
    /// </summary>
    public static ChampionKit For(int? championId) =>
        championId is { } id && Measured.TryGetValue(id, out var kit) ? kit : Standard;

    /// <summary>
    /// Every id this table measures, exposed for the drift guard in
    /// <c>ChampionKitDriftTests</c> and for nothing else. The table is a
    /// transcription of a CDN the tests can re-derive; without a way to read it
    /// back, "is it still right?" is unanswerable in an offline suite.
    /// </summary>
    public static IReadOnlyDictionary<int, ChampionKit> MeasuredKits => Measured;

    /// <summary>True when this champion has a rank the game grants for free.</summary>
    public bool HasFreeRanks => FreeR > 0;

    /// <summary>
    /// Ranks that actually cost a skill point. Twin of <c>purchasableTotal</c>
    /// in <c>lib/championKit.ts</c>.
    ///
    /// <para>A kit below <see cref="TotalLevels"/> here is not a curiosity, it
    /// is unshippable: the web's <c>skillOrderModel.ts</c> refuses
    /// <c>kit-not-derivable</c> for any such champion, so the desktop then logs
    /// <c>no-skill-order</c> and the highlight never draws — the Jayce blank
    /// overlay this whole file exists to prevent. Guarded in
    /// <c>ChampionKitDriftTests</c>.</para>
    /// </summary>
    public int PurchasableTotal => MaxQ + MaxW + MaxE + (MaxR - FreeR);

    /// <summary>Q=0, W=1, E=2, R=3 — the order <c>LiveAbilityRanks</c> uses.</summary>
    public int MaxRankAt(int slot) => slot switch
    {
        0 => MaxQ,
        1 => MaxW,
        2 => MaxE,
        3 => MaxR,
        _ => 0,
    };

    /// <summary>Only the R slot is ever granted free; see the type remarks.</summary>
    public int FreeRanksAt(int slot) => slot == 3 ? FreeR : 0;
}

/// <summary>
/// The reading of "how many skill points are sitting unspent right now",
/// and whether that reading can be trusted.
/// </summary>
/// <param name="Level">Champion level as reported by Live Client Data.</param>
/// <param name="Purchased">Ranks the player actually paid a point for.</param>
/// <param name="Unspent">Points banked and not yet spent.</param>
/// <param name="Coherent">
/// False when the player appears to have spent more points than the game could
/// have given them. Not an error to swallow: the caller must degrade to always
/// showing rather than never showing.
/// </param>
public readonly record struct SkillPointState(int Level, int Purchased, int Unspent, bool Coherent)
{
    public bool HasUnspentPoint => Coherent && Unspent > 0;
}

/// <summary>League's one-point-per-level rule, minus the ranks it hands out free.</summary>
public static class SkillPointArithmetic
{
    /// <param name="level">1..18.</param>
    /// <param name="ranks">Q, W, E, R in that order.</param>
    public static SkillPointState Evaluate(int level, IReadOnlyList<int> ranks, ChampionKit? kit = null)
    {
        ArgumentNullException.ThrowIfNull(ranks);
        var resolved = kit ?? ChampionKit.Standard;
        var purchased = 0;
        for (var slot = 0; slot < ranks.Count && slot < 4; slot++)
            purchased += Math.Max(0, ranks[slot] - resolved.FreeRanksAt(slot));

        var unspent = level - purchased;
        // A negative reading means this champion grants a rank we do not know
        // about (or the two endpoints were sampled either side of a level-up).
        // Report it rather than clamping it away — the caller degrades.
        return new SkillPointState(level, purchased, Math.Max(0, unspent), unspent >= 0);
    }
}
