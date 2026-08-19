namespace CoachBuild.Core;

/// <summary>
/// The keys the shop watcher will actually poll, plus a full account of how
/// each one was decided.
/// </summary>
/// <param name="UsedFallback">
/// True when the player's own config could not be read and the documented
/// League default was used instead. It drives a loud log line: a watcher on the
/// wrong key behaves exactly like a watcher that is switched off, and the
/// player must be able to tell those apart from the log alone.
/// </param>
public sealed record ResolvedShopBinds(
    IReadOnlyList<LeagueKeybind> Shop,
    LeagueKeybind Close,
    LeagueKeybind Chat,
    string? ConfigDirectory,
    bool UsedFallback,
    IReadOnlyList<string> LogLines)
{
    public bool CanWatch => Shop.Count > 0;
}

/// <summary>
/// Works out which key opens THIS player's shop.
///
/// <para><b>The default is wrong for real people.</b> League ships the shop on
/// <c>P</c>. The player this was built for uses grave/backtick, and their
/// <c>Config\input.ini</c> says so: <c>evtOpenShop=[`]</c>. Hardcoding <c>P</c>
/// would have produced a feature that never once fired for them, with nothing
/// anywhere to explain why. So the bind is read at runtime, and the resolved
/// key is logged on the way past — one line in <c>companion.log</c> answers
/// "is it even watching the right key?" without a debugging session.</para>
///
/// <para><b>Escape and Enter are constants, and that is a claim.</b> Escape is
/// read from <c>evtSysMenu</c> like any other bind, because it is rebindable.
/// The chat key is not: League has no <c>evtOpenChat</c> in <c>input.ini</c> at
/// all — the file carries <c>evtChatHistory</c> and nothing that opens the
/// input — so Return is used as a constant. If that ever turns out to be
/// rebindable, this comment is the thing that is wrong.</para>
/// </summary>
public static class ShopBindResolver
{
    /// <summary>League's own default shop bind, used only when the config cannot be read.</summary>
    public const uint FallbackShopVirtualKey = 0x50; // P

    public const uint EscapeVirtualKey = 0x1B;
    public const uint ReturnVirtualKey = 0x0D;

    public static ResolvedShopBinds Resolve(string? configDirectory)
    {
        var lines = new List<string>();

        if (string.IsNullOrWhiteSpace(configDirectory))
        {
            lines.Add(
                "shop: no League config directory found; falling back to League's default shop key P. "
                + "If your shop is on another key the numbers will not appear on their own — "
                + "use the tray item to show them.");
            return new ResolvedShopBinds(
                [new LeagueKeybind(FallbackShopVirtualKey, false, false, false, "P (League default)")],
                new LeagueKeybind(EscapeVirtualKey, false, false, false, "Esc"),
                new LeagueKeybind(ReturnVirtualKey, false, false, false, "Return"),
                null,
                UsedFallback: true,
                lines);
        }

        var shopSource = LeagueKeybindReader.Read(configDirectory, LeagueKeybindReader.OpenShopEvent);
        var closeSource = LeagueKeybindReader.Read(configDirectory, LeagueKeybindReader.SysMenuEvent);

        lines.Add($"shop: config {configDirectory}");
        lines.Add($"shop: {shopSource.Result.Describe(LeagueKeybindReader.OpenShopEvent)}"
            + (shopSource.FromFile is null ? string.Empty : $" [from {Path.GetFileName(shopSource.FromFile)}]"));
        if (shopSource.DisagreesWith is not null)
        {
            // Two files hold this value and they are not guaranteed to agree —
            // the same pair disagrees about ShopScale on the reference machine.
            // Naming both is the difference between a traceable wrong answer
            // and a mysterious one.
            lines.Add($"shop: NOTE the two config files disagree — {shopSource.DisagreesWith}; input.ini wins");
        }

        var shop = shopSource.Result.Binds;
        var usedFallback = false;
        if (shop.Count == 0)
        {
            usedFallback = true;
            shop = [new LeagueKeybind(FallbackShopVirtualKey, false, false, false, "P (League default)")];
            lines.Add(
                "shop: could not resolve your shop bind, falling back to League's default P. "
                + "If that is not your key the numbers will not appear on their own — "
                + "use the tray item to show them.");
        }

        var close = closeSource.Result.Binds.Count > 0
            ? closeSource.Result.Binds[0]
            : new LeagueKeybind(EscapeVirtualKey, false, false, false, "Esc");

        return new ResolvedShopBinds(
            shop,
            close,
            new LeagueKeybind(ReturnVirtualKey, false, false, false, "Return"),
            configDirectory,
            usedFallback,
            lines);
    }
}

/// <summary>
/// Finds League's <c>Config</c> directory without asking the player for it.
///
/// <para>An ordered candidate list, first existing directory wins, mirroring
/// the layered approach <see cref="LcuCredentialDiscovery"/> already takes to
/// the lockfile. Injectable existence check so the ordering is testable on a
/// machine with no League at all.</para>
/// </summary>
public static class LeagueConfigLocator
{
    public static IReadOnlyList<string> Candidates(string? explicitOverride = null)
    {
        var candidates = new List<string>();
        void Add(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            if (!candidates.Contains(path, StringComparer.OrdinalIgnoreCase)) candidates.Add(path);
        }

        Add(explicitOverride);
        Add(@"C:\Riot Games\League of Legends\Config");
        Add(Join(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)));
        Add(Join(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)));
        Add(Join(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)));

        try
        {
            foreach (var drive in DriveInfo.GetDrives())
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                Add(Path.Combine(drive.RootDirectory.FullName, "Riot Games", "League of Legends", "Config"));
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return candidates;

        static string? Join(string? root) => string.IsNullOrWhiteSpace(root)
            ? null
            : Path.Combine(root, "Riot Games", "League of Legends", "Config");
    }

    public static string? Find(Func<string, bool>? directoryExists = null, string? explicitOverride = null)
    {
        var exists = directoryExists ?? Directory.Exists;
        foreach (var candidate in Candidates(explicitOverride))
        {
            try
            {
                if (exists(candidate)) return candidate;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        return null;
    }
}
