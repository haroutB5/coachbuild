using CoachBuild.Core;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// A champion roster under the test's control.
///
/// <para>It exists so the in-game tests are hermetic. Before 1.0.11 the same
/// tests were "hermetic" only because the player-list fixture carried a
/// <c>championId</c> field Live Client Data does not send — the pipeline never
/// needed a roster, so the tests never noticed that production could not
/// resolve a champion at all.</para>
/// </summary>
internal sealed class FakeChampionDirectory : IChampionDirectory
{
    private readonly IReadOnlyList<ChampionRef> _roster;
    private int _loads;

    public FakeChampionDirectory(
        IReadOnlyList<ChampionRef>? roster = null,
        bool preloaded = true,
        bool fails = false)
    {
        _roster = roster ?? DefaultRoster;
        Fails = fails;
        if (preloaded && !fails) Cached = _roster;
    }

    public static IReadOnlyList<ChampionRef> DefaultRoster { get; } =
    [
        new(103, "Ahri", "Ahri"),
        new(106, "Volibear", "Volibear"),
        new(62, "MonkeyKing", "Wukong"),
        new(64, "LeeSin", "Lee Sin"),
    ];

    /// <summary>Flip at any point in a test to model the endpoint recovering.</summary>
    public bool Fails { get; set; }

    public IReadOnlyList<ChampionRef>? Cached { get; private set; }

    public string? LastFailure { get; private set; }

    public int Loads => Volatile.Read(ref _loads);

    public Task<IReadOnlyList<ChampionRef>?> LoadAsync(CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _loads);
        if (Fails)
        {
            LastFailure = "HTTP 500";
            return Task.FromResult<IReadOnlyList<ChampionRef>?>(null);
        }
        LastFailure = null;
        Cached = _roster;
        return Task.FromResult<IReadOnlyList<ChampionRef>?>(_roster);
    }
}
