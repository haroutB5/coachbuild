namespace CoachBuild.Core;

/// <summary>
/// Thread-safe native companion state. The HTTP listener, polling workers and
/// tray/UI all read the same snapshot without sharing mutable request objects.
/// </summary>
public sealed class CompanionState
{
    private readonly object _gate = new();
    private string _phase = "None";
    private LcuCredentials? _credentials;
    private CompanionLastOpen? _lastOpen;
    private CompanionChampSelectSnapshot? _champSelect;
    private string? _lastPollAt;
    private string? _lastError;
    private int _activeLcuWriteTransactions;
    private string? _lastLoggedPhase;

    public FollowAttachmentTracker FollowAttachments { get; } = new();

    /// <summary>
    /// The bridge registers its write service here so the gameflow poller can
    /// clear the per-game rune ownership ledger on ChampSelect entry even when
    /// the WPF host elects to use the parameter-light constructor overloads.
    /// </summary>
    public RuneApplyService? RuneApplyService { get; private set; }
    public ISkillOrderProvider? SkillOrderProvider { get; private set; }

    internal void RegisterRuneApplyService(RuneApplyService service)
    {
        ArgumentNullException.ThrowIfNull(service);
        lock (_gate) RuneApplyService = service;
    }

    internal void RegisterSkillOrderProvider(ISkillOrderProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        lock (_gate) SkillOrderProvider = provider;
    }

    public string Phase { get { lock (_gate) return _phase; } }

    public bool ClientConnected
    {
        get { lock (_gate) return _credentials is not null; }
    }

    public int ActiveLcuWriteTransactions
    {
        get { lock (_gate) return _activeLcuWriteTransactions; }
    }

    public bool IsCompanionBusy
    {
        get
        {
            lock (_gate)
                return ComplianceRules.IsCompanionBusy(_phase, _activeLcuWriteTransactions);
        }
    }

    public LcuCredentials? GetCredentials()
    {
        lock (_gate) return _credentials;
    }

    public bool SetCredentials(LcuCredentials? credentials)
    {
        lock (_gate)
        {
            var changed = !Equals(_credentials, credentials);
            _credentials = credentials;
            return changed;
        }
    }

    public bool SetPhase(string phase)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(phase);
        var enteredInProgress = false;
        var changed = false;
        lock (_gate)
        {
            changed = !string.Equals(_phase, phase, StringComparison.Ordinal);
            enteredInProgress = changed &&
                string.Equals(phase, "InProgress", StringComparison.Ordinal) &&
                !string.Equals(_phase, "InProgress", StringComparison.Ordinal);
            if (changed) _lastLoggedPhase = _phase;
            _phase = phase;
            if (!string.Equals(phase, "ChampSelect", StringComparison.Ordinal))
                _champSelect = null;
        }
        if (enteredInProgress && SkillOrderProvider is IPerGameSkillOrderCache cache)
            cache.ClearSkillOrderCache();
        return changed;
    }

    public string? ConsumePreviousPhaseForLog()
    {
        lock (_gate)
        {
            var value = _lastLoggedPhase;
            _lastLoggedPhase = null;
            return value;
        }
    }

    public void RecordPoll(DateTimeOffset? at = null)
    {
        lock (_gate) _lastPollAt = (at ?? DateTimeOffset.UtcNow).ToString("O");
    }

    public void SetLastError(string? message)
    {
        lock (_gate) _lastError = string.IsNullOrWhiteSpace(message) ? null : ComplianceRules.Redact(message);
    }

    public void SetChampSelect(CompanionChampSelectSnapshot? snapshot)
    {
        lock (_gate) _champSelect = snapshot;
    }

    public void SetLastOpen(int championId, int? roleId, DateTimeOffset? at = null)
    {
        lock (_gate)
        {
            _lastOpen = new CompanionLastOpen(
                championId,
                roleId,
                (at ?? DateTimeOffset.UtcNow).ToString("O"));
        }
    }

    public IDisposable BeginLcuWrite()
    {
        lock (_gate) _activeLcuWriteTransactions++;
        return new WriteLease(this);
    }

    public CompanionStatus ToStatus(int bridgePort)
    {
        lock (_gate)
        {
            return new CompanionStatus(
                CompanionWire.Version,
                bridgePort,
                _phase,
                _credentials is not null,
                _lastOpen,
                string.Equals(_phase, "ChampSelect", StringComparison.Ordinal) ? _champSelect : null,
                _lastPollAt,
                _lastError);
        }
    }

    private void EndLcuWrite()
    {
        lock (_gate)
        {
            if (_activeLcuWriteTransactions > 0) _activeLcuWriteTransactions--;
        }
    }

    private sealed class WriteLease(CompanionState owner) : IDisposable
    {
        private CompanionState? _owner = owner;

        public void Dispose()
        {
            Interlocked.Exchange(ref _owner, null)?.EndLcuWrite();
        }
    }
}
