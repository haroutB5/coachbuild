using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// One resolved keyboard accelerator from League's own config: the key, plus
/// whichever of Ctrl/Shift/Alt the player attached to it.
/// </summary>
/// <param name="VirtualKey">A Windows virtual-key code, or 0 when unresolved.</param>
/// <param name="Display">The token exactly as League wrote it, for logs.</param>
public readonly record struct LeagueKeybind(uint VirtualKey, bool Ctrl, bool Shift, bool Alt, string Display)
{
    public bool IsResolved => VirtualKey != 0;
}

/// <summary>How a bind failed to resolve, so the log can say which kind.</summary>
public enum LeagueKeybindProblem
{
    None,
    /// <summary>League wrote <c>[&lt;Unbound&gt;]</c>, <c>null</c>, or nothing.</summary>
    Unbound,
    /// <summary>A mouse button. Real, but not something a key watcher follows.</summary>
    MouseButton,
    /// <summary>A key name this table does not carry. Named in the log, never guessed at.</summary>
    UnknownKey,
}

public sealed record LeagueKeybindResult(
    IReadOnlyList<LeagueKeybind> Binds,
    LeagueKeybindProblem Problem,
    string RawValue,
    string? UnresolvedToken = null)
{
    public bool Any => Binds.Count > 0;

    public static LeagueKeybindResult Empty { get; } =
        new(Array.Empty<LeagueKeybind>(), LeagueKeybindProblem.Unbound, string.Empty);

    /// <summary>
    /// One line for <c>companion.log</c>. Every branch says something: a bind
    /// that cannot be followed must never be indistinguishable from a bind
    /// that was never looked for.
    /// </summary>
    public string Describe(string eventName) => Problem switch
    {
        LeagueKeybindProblem.None =>
            $"{eventName} = {string.Join(" or ", Binds.Select(bind => bind.Display))}",
        LeagueKeybindProblem.Unbound =>
            $"{eventName} is unbound in League ({Quote(RawValue)})",
        LeagueKeybindProblem.MouseButton =>
            $"{eventName} is bound to a mouse button ({Quote(RawValue)}); only keyboard binds are followed",
        LeagueKeybindProblem.UnknownKey =>
            $"{eventName} = {Quote(RawValue)} but the key name {Quote(UnresolvedToken ?? "?")} is not in the table; not followed",
        _ => $"{eventName} = {Quote(RawValue)}",
    };

    private static string Quote(string value) => string.IsNullOrEmpty(value) ? "\"\"" : $"\"{value}\"";
}

/// <summary>
/// Reads the player's ACTUAL League keybinds out of League's own config.
///
/// <para><b>Why this exists at all.</b> The in-game shop's default bind is
/// <c>P</c>, and assuming <c>P</c> would have been wrong on the very first
/// machine this was written against: that player's
/// <c>Config\input.ini</c> says <c>evtOpenShop=[`]</c>. A feature keyed on a
/// default nobody is using is a feature that never fires, and — worse — fires
/// on the wrong key for everyone who rebound it.</para>
///
/// <para><b>Two files hold the same value, and they can disagree.</b>
/// <c>Config\input.ini</c> and <c>Config\PersistedSettings.json</c> both carry
/// <c>evtOpenShop</c>. On the reference machine they agree, but the same pair
/// of files DISAGREES about <c>ShopScale</c> (<c>game.cfg</c> says 0.4100,
/// <c>PersistedSettings.json</c> says 0.2000) — so "they always agree" is
/// measurably false for at least one setting. <see cref="Read"/> therefore
/// names which file it took the answer from rather than silently merging them,
/// and reports a disagreement instead of hiding it.</para>
///
/// <para><b>Read-only, always.</b> Nothing in this file opens a League config
/// for writing. The player's League folder is theirs.</para>
/// </summary>
public static class LeagueKeybindReader
{
    public const string OpenShopEvent = "evtOpenShop";
    public const string SysMenuEvent = "evtSysMenu";

    /// <summary>Where the answer came from, so a wrong answer is traceable.</summary>
    public sealed record KeybindSource(
        string EventName,
        LeagueKeybindResult Result,
        string? FromFile,
        string? DisagreesWith = null);

    /// <summary>
    /// Resolves one event from a League config directory. <c>input.ini</c> wins
    /// when both files carry the event; the disagreement, if any, is reported
    /// rather than dropped.
    /// </summary>
    public static KeybindSource Read(string? configDirectory, string eventName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventName);
        if (string.IsNullOrWhiteSpace(configDirectory) || !Directory.Exists(configDirectory))
            return new KeybindSource(eventName, LeagueKeybindResult.Empty, null);

        var iniPath = Path.Combine(configDirectory, "input.ini");
        var jsonPath = Path.Combine(configDirectory, "PersistedSettings.json");
        var fromIni = TryReadIni(iniPath, eventName);
        var fromJson = TryReadPersistedSettings(jsonPath, eventName);

        if (fromIni is null && fromJson is null)
            return new KeybindSource(eventName, LeagueKeybindResult.Empty, null);

        if (fromIni is null) return new KeybindSource(eventName, Parse(fromJson!), jsonPath);
        if (fromJson is null) return new KeybindSource(eventName, Parse(fromIni), iniPath);

        var disagrees = !string.Equals(fromIni.Trim(), fromJson.Trim(), StringComparison.OrdinalIgnoreCase);
        return new KeybindSource(
            eventName,
            Parse(fromIni),
            iniPath,
            disagrees ? $"{jsonPath} says \"{fromJson}\"" : null);
    }

    /// <summary>
    /// The raw value of one key in one section-less lookup over League's
    /// <c>input.ini</c>. The file is INI-shaped but the same event name never
    /// repeats across sections, so the first match is the answer.
    /// </summary>
    public static string? TryReadIni(string path, string eventName)
    {
        try
        {
            if (!File.Exists(path)) return null;
            foreach (var line in File.ReadLines(path))
            {
                var trimmed = line.AsSpan().Trim();
                if (trimmed.IsEmpty || trimmed[0] is '[' or ';' or '#') continue;
                var split = trimmed.IndexOf('=');
                if (split <= 0) continue;
                if (!trimmed[..split].Trim().SequenceEqual(eventName)) continue;
                return trimmed[(split + 1)..].Trim().ToString();
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }

        return null;
    }

    /// <summary>
    /// The same event out of <c>PersistedSettings.json</c>, whose shape is
    /// <c>{ files: [ { sections: [ { settings: [ { name, value } ] } ] } ] }</c>.
    /// Walked with a reader rather than a model because this file is 60 KB of
    /// settings we do not otherwise care about.
    /// </summary>
    public static string? TryReadPersistedSettings(string path, string eventName)
    {
        try
        {
            if (!File.Exists(path)) return null;
            using var document = JsonDocument.Parse(File.ReadAllBytes(path));
            return FindSetting(document.RootElement, eventName, depth: 0);
        }
        catch (JsonException) { return null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    private static string? FindSetting(JsonElement element, string eventName, int depth)
    {
        if (depth > 12) return null;
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                if (element.TryGetProperty("name", out var name)
                    && name.ValueKind == JsonValueKind.String
                    && string.Equals(name.GetString(), eventName, StringComparison.Ordinal)
                    && element.TryGetProperty("value", out var value)
                    && value.ValueKind == JsonValueKind.String)
                {
                    return value.GetString();
                }

                foreach (var property in element.EnumerateObject())
                {
                    if (FindSetting(property.Value, eventName, depth + 1) is { } found) return found;
                }

                return null;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                {
                    if (FindSetting(item, eventName, depth + 1) is { } found) return found;
                }

                return null;
            default:
                return null;
        }
    }

    /// <summary>
    /// Parses one raw League bind value into zero or more accelerators.
    ///
    /// <para>The syntax, taken verbatim from a real <c>input.ini</c> rather
    /// than from documentation: alternatives are comma separated and may carry
    /// a trailing comma (<c>[Alt][r],</c>); each alternative is a run of
    /// bracketed tokens which may or may not be space separated
    /// (<c>[Ctrl] [TAB]</c> and <c>[Shift][1]</c> both occur); modifiers are
    /// <c>Ctrl</c>/<c>Shift</c>/<c>Alt</c> in any case (<c>[TAB]</c> and
    /// <c>[Tab]</c> both occur, so nothing may be case sensitive); "no bind" is
    /// spelled three different ways — <c>[&lt;Unbound&gt;]</c>, the literal
    /// string <c>null</c>, and an empty value — and all three occur in the same
    /// file.</para>
    ///
    /// <para><b>Fails closed.</b> A token this table does not know produces
    /// <see cref="LeagueKeybindProblem.UnknownKey"/> naming the token, never a
    /// guess and never a default. Guessing here means watching the wrong key
    /// forever with nothing in the log to say so.</para>
    /// </summary>
    public static LeagueKeybindResult Parse(string? raw)
    {
        var value = raw?.Trim() ?? string.Empty;
        if (value.Length == 0 || string.Equals(value, "null", StringComparison.OrdinalIgnoreCase))
            return new LeagueKeybindResult(Array.Empty<LeagueKeybind>(), LeagueKeybindProblem.Unbound, value);

        var binds = new List<LeagueKeybind>();
        var problem = LeagueKeybindProblem.None;
        string? unresolved = null;
        var sawAnyAlternative = false;

        foreach (var alternative in SplitAlternatives(value))
        {
            var tokens = Tokenize(alternative);
            if (tokens.Count == 0) continue;
            sawAnyAlternative = true;

            var ctrl = false;
            var shift = false;
            var alt = false;
            string? keyToken = null;
            foreach (var token in tokens)
            {
                if (token.Equals("ctrl", StringComparison.OrdinalIgnoreCase)) { ctrl = true; continue; }
                if (token.Equals("shift", StringComparison.OrdinalIgnoreCase)) { shift = true; continue; }
                if (token.Equals("alt", StringComparison.OrdinalIgnoreCase)) { alt = true; continue; }
                keyToken = token;
            }

            if (keyToken is null) continue;
            if (keyToken.Equals("<Unbound>", StringComparison.OrdinalIgnoreCase))
            {
                if (problem == LeagueKeybindProblem.None && binds.Count == 0)
                    problem = LeagueKeybindProblem.Unbound;
                continue;
            }

            if (keyToken.StartsWith("Button", StringComparison.OrdinalIgnoreCase))
            {
                if (problem == LeagueKeybindProblem.None && binds.Count == 0)
                    problem = LeagueKeybindProblem.MouseButton;
                continue;
            }

            if (!LeagueVirtualKeys.TryResolve(keyToken, out var virtualKey))
            {
                if (problem == LeagueKeybindProblem.None && binds.Count == 0)
                {
                    problem = LeagueKeybindProblem.UnknownKey;
                    unresolved = keyToken;
                }

                continue;
            }

            binds.Add(new LeagueKeybind(virtualKey, ctrl, shift, alt, alternative.Trim()));
        }

        if (binds.Count > 0) return new LeagueKeybindResult(binds, LeagueKeybindProblem.None, value);
        if (problem == LeagueKeybindProblem.None)
            problem = sawAnyAlternative ? LeagueKeybindProblem.UnknownKey : LeagueKeybindProblem.Unbound;
        return new LeagueKeybindResult(Array.Empty<LeagueKeybind>(), problem, value, unresolved);
    }

    private static IEnumerable<string> SplitAlternatives(string value)
    {
        // Commas separate alternatives, but a comma INSIDE brackets is a key
        // name (`[,]` is a real bind). Split at depth 0 only.
        var depth = 0;
        var start = 0;
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (character == '[') depth++;
            else if (character == ']') depth = Math.Max(0, depth - 1);
            else if (character == ',' && depth == 0)
            {
                if (index > start) yield return value[start..index];
                start = index + 1;
            }
        }

        if (start < value.Length) yield return value[start..];
    }

    private static List<string> Tokenize(string alternative)
    {
        var tokens = new List<string>();
        var index = 0;
        while (index < alternative.Length)
        {
            var open = alternative.IndexOf('[', index);
            if (open < 0) break;
            var close = alternative.IndexOf(']', open + 1);
            // `[]]` is the close-bracket key: the first `]` closes nothing.
            if (close == open + 1 && close + 1 < alternative.Length && alternative[close + 1] == ']')
                close++;
            if (close < 0) break;
            var token = alternative[(open + 1)..close].Trim();
            if (token.Length > 0) tokens.Add(token);
            index = close + 1;
        }

        return tokens;
    }
}

/// <summary>
/// League key name → Windows virtual-key code. An explicit allowlist, not a
/// layout query: a table that returns <c>false</c> for a name it does not know
/// produces a log line, while <c>VkKeyScan</c> returning -1 produces a silent
/// zero that reads like "the key is never pressed".
/// </summary>
public static class LeagueVirtualKeys
{
    private static readonly Dictionary<string, uint> Named = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Esc"] = 0x1B,
        ["Escape"] = 0x1B,
        ["Space"] = 0x20,
        ["Spacebar"] = 0x20,
        ["Return"] = 0x0D,
        ["Enter"] = 0x0D,
        ["Tab"] = 0x09,
        ["Backspace"] = 0x08,
        ["Delete"] = 0x2E,
        ["Insert"] = 0x2D,
        ["Home"] = 0x24,
        ["End"] = 0x23,
        ["Page Up"] = 0x21,
        ["Page Down"] = 0x22,
        ["Up Arrow"] = 0x26,
        ["Down Arrow"] = 0x28,
        ["Left Arrow"] = 0x25,
        ["Right Arrow"] = 0x27,
        ["Caps Lock"] = 0x14,
        ["Num Lock"] = 0x90,
        ["Scroll Lock"] = 0x91,
        ["Pause"] = 0x13,
        ["Print Screen"] = 0x2C,
    };

    // US-layout OEM punctuation. League writes the CHARACTER, Windows wants a
    // virtual key, and the mapping is layout dependent — so this table is the
    // US answer and anything outside it fails closed with the token named.
    private static readonly Dictionary<char, uint> Punctuation = new()
    {
        ['`'] = 0xC0,
        ['-'] = 0xBD,
        ['='] = 0xBB,
        ['['] = 0xDB,
        [']'] = 0xDD,
        ['\\'] = 0xDC,
        [';'] = 0xBA,
        ['\''] = 0xDE,
        [','] = 0xBC,
        ['.'] = 0xBE,
        ['/'] = 0xBF,
    };

    public static bool TryResolve(string? token, out uint virtualKey)
    {
        virtualKey = 0;
        if (string.IsNullOrWhiteSpace(token)) return false;
        var name = token.Trim();

        if (Named.TryGetValue(name, out virtualKey)) return true;

        // F1..F24
        if (name.Length is 2 or 3
            && (name[0] == 'F' || name[0] == 'f')
            && int.TryParse(name[1..], out var functionKey)
            && functionKey is >= 1 and <= 24)
        {
            virtualKey = (uint)(0x70 + functionKey - 1);
            return true;
        }

        if (name.Length != 1) return false;
        var character = name[0];
        if (character is >= 'a' and <= 'z') { virtualKey = (uint)(character - 'a' + 0x41); return true; }
        if (character is >= 'A' and <= 'Z') { virtualKey = (uint)(character - 'A' + 0x41); return true; }
        if (character is >= '0' and <= '9') { virtualKey = (uint)(character - '0' + 0x30); return true; }
        if (Punctuation.TryGetValue(character, out virtualKey)) return true;
        virtualKey = 0;
        return false;
    }
}
