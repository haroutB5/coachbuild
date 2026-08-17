namespace CoachBuild.Desktop.Updates;

/// <summary>
/// Version comparison for update decisions. Deliberately independent of
/// NuGet.Versioning: the values compared here arrive as strings through
/// reflection (Velopack's SemanticVersion.ToString(), the entry assembly's
/// informational version, a nuspec &lt;version&gt;), and each carries its own
/// decorations. Build metadata is dropped, a prerelease suffix sorts below the
/// same numeric release, and anything unparsable answers "not newer" so a
/// malformed feed entry can never trigger an apply/restart loop.
/// </summary>
public static class UpdateVersion
{
    /// <summary>
    /// Parses "1.0.9", "1.0.9.0", "1.0.9-beta.1", "1.0.9+abc123" into a
    /// four-part numeric version plus a prerelease label.
    /// </summary>
    public static bool TryParse(string? text, out Version version, out string prerelease)
    {
        version = new Version(0, 0, 0, 0);
        prerelease = string.Empty;
        if (string.IsNullOrWhiteSpace(text)) return false;

        var value = text.Trim();
        var metadata = value.IndexOf('+');
        if (metadata >= 0) value = value[..metadata];

        var dash = value.IndexOf('-');
        if (dash >= 0)
        {
            prerelease = value[(dash + 1)..];
            value = value[..dash];
        }

        if (value.Length == 0) return false;

        var parts = value.Split('.');
        if (parts.Length is 0 or > 4) return false;

        var numbers = new int[4];
        for (var i = 0; i < parts.Length; i++)
        {
            if (!int.TryParse(parts[i], System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) || number < 0)
            {
                return false;
            }
            numbers[i] = number;
        }

        version = new Version(numbers[0], numbers[1], numbers[2], numbers[3]);
        return true;
    }

    /// <summary>
    /// Negative when <paramref name="left"/> is older, 0 when equal, positive
    /// when newer. Unparsable operands are reported through
    /// <paramref name="comparable"/> rather than guessed at.
    /// </summary>
    public static int Compare(string? left, string? right, out bool comparable)
    {
        comparable = TryParse(left, out var leftVersion, out var leftPre)
            && TryParse(right, out var rightVersion, out var rightPre);
        if (!comparable) return 0;

        TryParse(left, out leftVersion, out leftPre);
        TryParse(right, out rightVersion, out rightPre);

        var numeric = leftVersion.CompareTo(rightVersion);
        if (numeric != 0) return numeric;

        // Same numbers: a prerelease is older than the plain release.
        var leftIsPre = leftPre.Length > 0;
        var rightIsPre = rightPre.Length > 0;
        if (leftIsPre && !rightIsPre) return -1;
        if (!leftIsPre && rightIsPre) return 1;
        return string.CompareOrdinal(leftPre, rightPre);
    }

    /// <summary>
    /// True only when <paramref name="candidate"/> is provably newer than
    /// <paramref name="current"/>. Fails closed: an unknown current version, an
    /// unparsable candidate, or an equal/older candidate all answer false.
    /// </summary>
    public static bool IsNewer(string? candidate, string? current)
    {
        var order = Compare(candidate, current, out var comparable);
        return comparable && order > 0;
    }
}
