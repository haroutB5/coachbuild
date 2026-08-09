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
}

public sealed record OverlayState(
    bool InGame,
    string? ChampionName,
    int? ChampionId,
    int Level,
    IReadOnlyDictionary<OverlayAbility, int> AbilityRanks,
    OverlaySkillOrder SkillOrder,
    string? Lane,
    bool IsLaneAuto,
    bool ShowDisclaimer = true)
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

    public bool HasRenderableData => InGame && !string.IsNullOrWhiteSpace(ChampionName);

    public int Rank(OverlayAbility ability) => AbilityRanks.TryGetValue(ability, out var rank) ? Math.Max(0, rank) : 0;

    public OverlayAbility? NextAbility()
    {
        var spent = Enum.GetValues<OverlayAbility>().Sum(Rank);
        if (spent < 0 || spent >= SkillOrder.Order.Count) return null;
        var ability = SkillOrder.Order[spent];
        return Rank(ability) >= 5 ? null : ability;
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
