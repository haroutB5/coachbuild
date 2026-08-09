namespace CoachBuild.Core;

public enum FollowKind
{
    Builds,
    Draft
}

public sealed record FollowAttachmentSnapshot(
    DateTimeOffset? FollowAt,
    DateTimeOffset? OpenedAt,
    DateTimeOffset? DetachedAt);

/// <summary>
/// Tracks the two independent follow-capable web surfaces. A recent poll is
/// deliberately generous for throttled background tabs; explicit detach and
/// browser liveness are the hard-kill safeguards.
/// </summary>
public sealed class FollowAttachmentTracker
{
    private readonly object _gate = new();
    private readonly Dictionary<FollowKind, FollowAttachmentSnapshot> _items = new()
    {
        [FollowKind.Builds] = new(null, null, null),
        [FollowKind.Draft] = new(null, null, null)
    };

    public void RecordFollow(FollowKind kind, DateTimeOffset? at = null)
    {
        lock (_gate)
        {
            var current = _items[kind];
            _items[kind] = current with { FollowAt = at ?? DateTimeOffset.UtcNow };
        }
    }

    public void RecordLegacyFollow(DateTimeOffset? at = null) => RecordFollow(FollowKind.Builds, at);

    public void RecordDetach(FollowKind kind, DateTimeOffset? at = null)
    {
        lock (_gate)
        {
            var detached = at ?? DateTimeOffset.UtcNow;
            var current = _items[kind];
            _items[kind] = current with { FollowAt = null, DetachedAt = detached };
        }
    }

    public void RecordOpened(FollowKind kind, DateTimeOffset? at = null)
    {
        lock (_gate)
        {
            var current = _items[kind];
            _items[kind] = current with { OpenedAt = at ?? DateTimeOffset.UtcNow };
        }
    }

    public FollowAttachmentSnapshot GetSnapshot(FollowKind kind)
    {
        lock (_gate) return _items[kind];
    }

    public bool IsAttached(
        FollowKind kind,
        DateTimeOffset? now = null,
        bool browserAlive = true,
        TimeSpan? attachWindow = null,
        TimeSpan? openGrace = null)
    {
        var currentTime = now ?? DateTimeOffset.UtcNow;
        var maxAge = attachWindow ?? TimeSpan.FromSeconds(CompanionWire.AttachWindowSeconds);
        var grace = openGrace ?? TimeSpan.FromSeconds(CompanionWire.OpenGraceSeconds);
        FollowAttachmentSnapshot current;
        lock (_gate) current = _items[kind];

        // A detach after an open answers the open->attach race immediately.
        if (current.OpenedAt is { } opened && current.DetachedAt is { } detached && detached > opened)
            return false;
        if (current.OpenedAt is { } openedAt && currentTime - openedAt < grace &&
            (current.DetachedAt is null || current.DetachedAt <= openedAt))
            return true;
        if (!browserAlive || current.FollowAt is null) return false;
        if (current.DetachedAt is { } detachedAt && detachedAt >= current.FollowAt.Value)
            return false;
        var age = currentTime - current.FollowAt.Value;
        return age >= TimeSpan.Zero && age < maxAge;
    }

    public bool IsAnyAttached(
        DateTimeOffset? now = null,
        bool browserAlive = true,
        TimeSpan? attachWindow = null,
        TimeSpan? openGrace = null) =>
        IsAttached(FollowKind.Builds, now, browserAlive, attachWindow, openGrace) ||
        IsAttached(FollowKind.Draft, now, browserAlive, attachWindow, openGrace);

    public void ApplyQuery(string? follow, bool detach, DateTimeOffset? at = null)
    {
        var when = at ?? DateTimeOffset.UtcNow;
        if (detach)
        {
            if (string.Equals(follow, "builds", StringComparison.Ordinal) ||
                string.Equals(follow, "1", StringComparison.Ordinal))
                RecordDetach(FollowKind.Builds, when);
            else if (string.Equals(follow, "draft", StringComparison.Ordinal))
                RecordDetach(FollowKind.Draft, when);
            return;
        }
        if (string.Equals(follow, "builds", StringComparison.Ordinal) ||
            string.Equals(follow, "1", StringComparison.Ordinal))
            RecordFollow(FollowKind.Builds, when);
        else if (string.Equals(follow, "draft", StringComparison.Ordinal))
            RecordFollow(FollowKind.Draft, when);
    }
}

