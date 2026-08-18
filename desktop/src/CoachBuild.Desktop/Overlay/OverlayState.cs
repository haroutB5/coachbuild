using CoachBuild.Core;

namespace CoachBuild.Desktop.Overlay;

public enum OverlayAbility
{
    Q,
    W,
    E,
    R,
}

/// <summary>
/// The only live-game input the native overlay consumes. It is deliberately a
/// skill snapshot, not a bridge client: it is supplied by the in-process LCU
/// poller and never causes a loopback /skills request.
/// </summary>
public sealed record LiveClientDataSkillSnapshot(
    int Level,
    IReadOnlyDictionary<OverlayAbility, int> AbilityRanks);

public interface ILiveClientSkillSnapshotSource
{
    LiveClientDataSkillSnapshot? CurrentSkillSnapshot { get; }
}

public sealed record OverlaySkillOrder(
    IReadOnlyList<OverlayAbility> Order,
    int ObservedLevels,
    bool Completed,
    string? CompletionBasis = null)
{
    public static OverlaySkillOrder Empty { get; } = new(Array.Empty<OverlayAbility>(), 0, false);

    public static OverlaySkillOrder FromTokens(
        System.Collections.IEnumerable? values,
        int observedLevels,
        bool completed,
        string? completionBasis = null)
    {
        var order = new List<OverlayAbility>();
        if (values is not null)
        {
            foreach (var value in values)
            {
                if (Enum.TryParse<OverlayAbility>(value?.ToString(), ignoreCase: true, out var ability))
                    order.Add(ability);
            }
        }

        return new OverlaySkillOrder(order, observedLevels, completed, completionBasis);
    }
}

public sealed record OverlayState(
    bool InGame,
    string? ChampionName,
    int? ChampionId,
    int Level,
    IReadOnlyDictionary<OverlayAbility, int> AbilityRanks,
    OverlaySkillOrder SkillOrder,
    string? Lane,
    bool IsLaneAuto)
{
    public static OverlayState Empty { get; } = new(
        InGame: false,
        ChampionName: null,
        ChampionId: null,
        Level: 0,
        AbilityRanks: EmptyRanks(),
        SkillOrder: OverlaySkillOrder.Empty,
        Lane: null,
        IsLaneAuto: true);

    public bool HasRenderableData =>
        InGame
        && !string.IsNullOrWhiteSpace(ChampionName)
        && SkillOrder.Order.Count > 0;

    public int Rank(OverlayAbility ability) => AbilityRanks.TryGetValue(ability, out var rank) ? Math.Max(0, rank) : 0;

    /// <summary>This champion's rank caps and free ranks; see <see cref="ChampionKit"/>.</summary>
    public ChampionKit Kit => ChampionKit.For(ChampionId);

    /// <summary>
    /// Points spent and points still banked, right now. The whole 1.0.12
    /// highlight gate rests on this, so it is derived from Live Client Data's
    /// own <c>level</c> and <c>abilityLevel</c> values and nothing else.
    /// </summary>
    public SkillPointState Points => SkillPointArithmetic.Evaluate(
        Level,
        [Rank(OverlayAbility.Q), Rank(OverlayAbility.W), Rank(OverlayAbility.E), Rank(OverlayAbility.R)],
        Kit);

    /// <summary>
    /// Whether the overlay is entitled to an opinion at all.
    ///
    /// <para>True while a point is banked — and ALSO true when the point
    /// arithmetic is incoherent, which degrades to the pre-1.0.12
    /// always-visible behaviour instead of hiding. An unknown champion whose
    /// kit grants a free rank must not silently lose the feature; that is the
    /// failure this whole file exists to avoid repeating.</para>
    /// </summary>
    public bool HasPointToSpend => !Points.Coherent || Points.Unspent > 0;

    /// <summary>
    /// The ability to put the next point into, or null when there is no point
    /// to spend or nothing left in the order that can still take a rank.
    ///
    /// <para>Indexed by points PURCHASED, not by level and not by raw rank sum:
    /// a level-cheat jump banks several points at once, and four champions hold
    /// a rank they never paid for.</para>
    ///
    /// <para>When the order names an ability the player has already capped
    /// (they deviated from the recommendation), this advances to the next entry
    /// that can still take a rank rather than pointing at nothing.</para>
    /// </summary>
    public OverlayAbility? NextAbility()
    {
        var points = Points;
        if (!HasPointToSpend) return null;
        var kit = Kit;
        for (var index = Math.Max(0, points.Purchased); index < SkillOrder.Order.Count; index++)
        {
            var ability = SkillOrder.Order[index];
            if (Rank(ability) < kit.MaxRankAt((int)ability)) return ability;
        }

        return null;
    }

    public OverlayState Normalize()
    {
        var ranks = EmptyRanks().ToDictionary(pair => pair.Key, pair =>
            AbilityRanks.TryGetValue(pair.Key, out var rank) ? Math.Clamp(rank, 0, 6) : 0);
        var order = SkillOrder.Order
            .Where(ability => Enum.IsDefined(ability))
            .Take(18)
            .ToArray();
        return this with
        {
            Level = Math.Clamp(Level, 0, 18),
            AbilityRanks = ranks,
            SkillOrder = SkillOrder with
            {
                Order = order,
                ObservedLevels = Math.Clamp(SkillOrder.ObservedLevels, 0, order.Length),
            },
            Lane = NormalizeLane(Lane),
        };
    }

    private static IReadOnlyDictionary<OverlayAbility, int> EmptyRanks() => new Dictionary<OverlayAbility, int>
    {
        [OverlayAbility.Q] = 0,
        [OverlayAbility.W] = 0,
        [OverlayAbility.E] = 0,
        [OverlayAbility.R] = 0,
    };

    private static string? NormalizeLane(string? lane)
    {
        if (string.IsNullOrWhiteSpace(lane)) return null;
        var value = lane.Trim().ToUpperInvariant();
        return value is "TOP" or "JUNGLE" or "MID" or "BOT" or "SUPPORT" ? value : null;
    }
}

public static class OverlayStateAdapter
{
    public static OverlayState FromLiveSnapshot(
        LiveClientDataSkillSnapshot snapshot,
        string championName,
        int? championId,
        OverlaySkillOrder skillOrder,
        string? lane,
        bool laneIsAuto)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        ArgumentException.ThrowIfNullOrWhiteSpace(championName);
        ArgumentNullException.ThrowIfNull(skillOrder);
        return new OverlayState(
            InGame: true,
            ChampionName: championName,
            ChampionId: championId,
            Level: snapshot.Level,
            AbilityRanks: snapshot.AbilityRanks,
            SkillOrder: skillOrder,
            Lane: lane,
            IsLaneAuto: laneIsAuto).Normalize();
    }
}
