namespace CoachBuild.Core;

public sealed class RuneOwnershipLedger
{
    private readonly object _gate = new();
    private readonly Dictionary<string, string> _writes = new(StringComparer.Ordinal);

    public void Clear()
    {
        lock (_gate) _writes.Clear();
    }

    public void Record(string title, string fingerprint)
    {
        lock (_gate) _writes[title] = fingerprint;
    }

    public bool TryGet(string title, out string? fingerprint)
    {
        lock (_gate)
        {
            if (_writes.TryGetValue(title, out var value))
            {
                fingerprint = value;
                return true;
            }
            fingerprint = null;
            return false;
        }
    }

    public string? Get(string title)
    {
        lock (_gate) return _writes.TryGetValue(title, out var value) ? value : null;
    }
}

