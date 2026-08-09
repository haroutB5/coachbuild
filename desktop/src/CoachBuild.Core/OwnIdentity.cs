using System.Text.Json;

namespace CoachBuild.Core;

public static class OwnIdentityConverter
{
    /// <summary>
    /// current-summoner is the local user's own identity. This converter only
    /// admits the three fields the web app consumes and never reads a name from
    /// the allgamedata/player list payloads.
    /// </summary>
    public static OwnIdentity? TryConvert(JsonElement summoner)
    {
        if (summoner.ValueKind != JsonValueKind.Object) return null;
        var gameName = ReadNonBlankString(summoner, "gameName");
        var tagLine = ReadNonBlankString(summoner, "tagLine");
        var puuid = ReadNonBlankString(summoner, "puuid");
        return gameName is null || tagLine is null || puuid is null
            ? null
            : new OwnIdentity(gameName, tagLine, puuid);
    }

    private static string? ReadNonBlankString(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var field) || field.ValueKind != JsonValueKind.String)
            return null;
        var text = field.GetString()?.Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }
}

