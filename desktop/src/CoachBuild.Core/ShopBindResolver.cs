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
/// <para><b>Reading the character is only half the job (1.0.19).</b> Through
/// 1.0.18 the field report was still "the app is watching P and my shop is on
/// backtick", and there are two independent ways to get there. Only ONE of them
/// is "the config was not read": <c>P</c> can be produced by nothing but
/// <see cref="FallbackShopVirtualKey"/>, so a player for whom P works is a
/// player whose config was not read, and the discovery in
/// <see cref="LeagueConfigLocator"/> now asks Riot's own install manifests
/// before it starts guessing at paths. The other way is quieter: the character
/// is read correctly and mapped to the wrong KEY, because the map from
/// character to virtual key belongs to the keyboard layout and the shipped
/// table was US-only. On en-GB — this project's own dev box — <c>[`]</c> is VK
/// 0xDF, not the 0xC0 the table gives. Fixing only the discovery would have
/// shipped a resolver that reads <c>evtOpenShop=[`]</c> perfectly and then
/// polls the <c>'</c>/<c>@</c> key for the whole session.</para>
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

    /// <summary>
    /// Production's own composition: this machine's League config directory,
    /// read through this machine's keyboard layout.
    ///
    /// <para>A single named entry point rather than two calls at the App layer,
    /// so the arrangement the player actually runs is the arrangement the tests
    /// can exercise. An optional layout argument that production passes and
    /// every fixture omits is how a keyboard-layout bug survives a green
    /// suite.</para>
    /// </summary>
    public static ResolvedShopBinds ResolveForCurrentMachine(string? explicitOverride = null) =>
        Resolve(
            LeagueConfigLocator.Find(explicitOverride: explicitOverride),
            WindowsKeyboardLayout.ResolvePunctuation);

    /// <param name="punctuationLayout">
    /// Maps a punctuation character to the virtual key that types it on the
    /// player's layout; <c>null</c> means "use the US table". REQUIRED and
    /// positional, following the same argument 1.0.18 made for the chat gate:
    /// an optional trailing argument that production fills in and fixtures
    /// leave empty means the shipped configuration has no coverage while every
    /// test stays green — and the layout is exactly where this went wrong.
    /// </param>
    public static ResolvedShopBinds Resolve(string? configDirectory, Func<char, uint>? punctuationLayout)
    {
        var lines = new List<string>();

        if (string.IsNullOrWhiteSpace(configDirectory))
        {
            lines.Add(
                "shop: no League config directory found; falling back to League's default shop key P. "
                + "If your shop is on another key the numbers will not appear on their own — "
                + "use the tray item to show them.");
            lines.Add(DescribeWatch(
                [new LeagueKeybind(FallbackShopVirtualKey, false, false, false, "P (League default)")],
                "League's default (YOUR CONFIG WAS NOT READ)"));
            return new ResolvedShopBinds(
                [new LeagueKeybind(FallbackShopVirtualKey, false, false, false, "P (League default)")],
                new LeagueKeybind(EscapeVirtualKey, false, false, false, "Esc"),
                new LeagueKeybind(ReturnVirtualKey, false, false, false, "Return"),
                null,
                UsedFallback: true,
                lines);
        }

        var shopSource = LeagueKeybindReader.Read(
            configDirectory, LeagueKeybindReader.OpenShopEvent, punctuationLayout);
        var closeSource = LeagueKeybindReader.Read(
            configDirectory, LeagueKeybindReader.SysMenuEvent, punctuationLayout);

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

        lines.Add(DescribeWatch(
            shop,
            usedFallback
                ? "League's default (YOUR CONFIG WAS NOT READ)"
                : $"your {Path.GetFileName(shopSource.FromFile ?? "config")}"));

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

    /// <summary>
    /// THE line. One sentence in <c>companion.log</c> that answers "which key
    /// is it actually watching, and where did that come from" without reading
    /// anything else.
    ///
    /// <para>The existing lines named the TOKEN League wrote — <c>evtOpenShop =
    /// [`]</c> — and never the virtual key it became. That is the difference
    /// that hid a keyboard-layout bug: on en-GB, <c>[`]</c> is VK 0xDF, and the
    /// shipped US table turned it into 0xC0, a different physical key. A log
    /// that prints the character can print the right character while the app
    /// polls the wrong key, forever. Printing the code closes that gap, and
    /// naming the layout says why two machines can disagree about the same
    /// character.</para>
    /// </summary>
    private static string DescribeWatch(IReadOnlyList<LeagueKeybind> shop, string provenance)
    {
        var keys = string.Join(
            " or ",
            shop.Select(bind => $"{bind.Display} (vk 0x{bind.VirtualKey:X2})"));
        return $"shop: WATCHING {keys} - from {provenance};"
            + $" keyboard layout {WindowsKeyboardLayout.Describe()}";
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
    /// <param name="readFile">
    /// Reads one of Riot's install manifests, or returns null. Injectable so
    /// the ordering below is testable on a machine with no League at all.
    /// </param>
    /// <param name="programDataDirectory">
    /// Overrides <c>%PROGRAMDATA%</c>, for the same reason.
    /// </param>
    public static IReadOnlyList<string> Candidates(
        string? explicitOverride = null,
        Func<string, string?>? readFile = null,
        string? programDataDirectory = null)
    {
        var candidates = new List<string>();
        void Add(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            if (!candidates.Contains(path, StringComparer.OrdinalIgnoreCase)) candidates.Add(path);
        }

        Add(explicitOverride);

        // RIOT'S OWN ANSWER FIRST, ahead of every guess below.
        //
        // The guesses are a hardcoded C:\ path, two Program Files variants and
        // the ROOT of each fixed drive. League installed anywhere else — say
        // D:\Games\Riot Games\League of Legends, an ordinary layout on a
        // machine with a games drive — is invisible to all of them, and the
        // consequence is not "no shop feature": ShopBindResolver falls back to
        // League's default P and the watcher polls a key the player does not
        // use, for the whole session.
        //
        // This codebase already knows better. LcuCredentialDiscovery reads
        // `product_install_full_path` out of Riot's product-settings YAML and
        // the path entries out of RiotClientInstalls.json in order to find the
        // lockfile, and those are the vendor's own record of where League is.
        // The parsers are public and already tested; only this locator was
        // still guessing.
        foreach (var path in ManifestCandidates(readFile, programDataDirectory)) Add(path);

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

    /// <summary>
    /// Every League Config directory Riot's own manifests point at.
    ///
    /// <para>Two manifest shapes, both already parsed elsewhere in this
    /// assembly. The product-settings YAML holds League's install directory
    /// directly; RiotClientInstalls.json holds Riot Client executable paths, so
    /// the League folder is a sibling of the client's. Every plausible reading
    /// is offered as a candidate rather than one being chosen — <see cref="Find"/>
    /// takes the first that exists, and a directory probe is free next to being
    /// wrong for a whole session.</para>
    /// </summary>
    public static IReadOnlyList<string> ManifestCandidates(
        Func<string, string?>? readFile = null,
        string? programDataDirectory = null)
    {
        var read = readFile ?? TryReadAllText;
        var programData = programDataDirectory;
        if (string.IsNullOrWhiteSpace(programData))
        {
            programData = Environment.GetEnvironmentVariable("PROGRAMDATA");
            if (string.IsNullOrWhiteSpace(programData))
                programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        }

        programData ??= string.Empty;
        var installs = new List<string>();

        try
        {
            var productSettings = read(Path.Combine(
                programData,
                "Riot Games",
                "Metadata",
                "league_of_legends.live",
                "league_of_legends.live.product_settings.yaml"));
            if (LcuCredentialParser.ParseProductSettingsYaml(productSettings) is { } installPath)
                installs.Add(installPath);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }

        try
        {
            var riotInstalls = read(Path.Combine(programData, "Riot Games", "RiotClientInstalls.json"));
            installs.AddRange(LcuCredentialParser.ParseRiotClientInstallsJson(riotInstalls));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        catch (ArgumentException) { }

        var candidates = new List<string>();
        foreach (var raw in installs)
        {
            foreach (var candidate in ConfigCandidatesFor(raw))
            {
                if (!candidates.Contains(candidate, StringComparer.OrdinalIgnoreCase)) candidates.Add(candidate);
            }
        }

        return candidates;
    }

    private static IEnumerable<string> ConfigCandidatesFor(string? installPath)
    {
        if (string.IsNullOrWhiteSpace(installPath)) yield break;

        string directory;
        try
        {
            var normalized = installPath.Trim().Trim('"', '\'').Replace('/', Path.DirectorySeparatorChar);
            normalized = normalized.TrimEnd(Path.DirectorySeparatorChar);
            if (normalized.Length == 0) yield break;
            directory = Path.GetFileName(normalized).EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? Path.GetDirectoryName(normalized) ?? normalized
                : normalized;
        }
        catch (ArgumentException)
        {
            // A malformed vendor path is one dead candidate, never an
            // exception out of discovery.
            yield break;
        }

        if (string.IsNullOrWhiteSpace(directory)) yield break;

        // The value is League's own install directory.
        yield return Path.Combine(directory, "Config");
        // ...or a Riot Client directory, whose sibling is League.
        yield return Path.Combine(directory, "League of Legends", "Config");
        var parent = Path.GetDirectoryName(directory);
        if (!string.IsNullOrWhiteSpace(parent))
            yield return Path.Combine(parent, "League of Legends", "Config");
    }

    private static string? TryReadAllText(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path) : null;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    public static string? Find(
        Func<string, bool>? directoryExists = null,
        string? explicitOverride = null,
        Func<string, string?>? readFile = null,
        string? programDataDirectory = null)
    {
        var exists = directoryExists ?? Directory.Exists;
        foreach (var candidate in Candidates(explicitOverride, readFile, programDataDirectory))
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
