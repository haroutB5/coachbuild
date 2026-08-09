using System.Globalization;
using System.Text.Json;

namespace CoachBuild.Core;

public static class LiveSkillStateConverter
{
    public static LiveSkillState? TryConvert(JsonElement activePlayer, JsonElement? fallbackAbilities = null)
    {
        if (activePlayer.ValueKind != JsonValueKind.Object) return null;
        var level = ReadRank(activePlayer, "level");
        if (level is null or < 1 or > 18) return null;

        JsonElement source;
        if (activePlayer.TryGetProperty("abilities", out var embedded) &&
            embedded.ValueKind == JsonValueKind.Object)
            source = embedded;
        else if (fallbackAbilities is { ValueKind: JsonValueKind.Object } fallback)
            source = fallback;
        else
            return null;

        var q = ReadAbilityRank(source, "Q");
        var w = ReadAbilityRank(source, "W");
        var e = ReadAbilityRank(source, "E");
        var r = ReadAbilityRank(source, "R");
        if (q is null || w is null || e is null || r is null) return null;
        return new LiveSkillState(level.Value, new LiveAbilityRanks(q.Value, w.Value, e.Value, r.Value));
    }

    private static int? ReadAbilityRank(JsonElement source, string key)
    {
        if (!source.TryGetProperty(key, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Object)
            return ReadRank(value, "abilityLevel");
        return ReadRank(value);
    }

    private static int? ReadRank(JsonElement source, string property)
    {
        return source.ValueKind == JsonValueKind.Object && source.TryGetProperty(property, out var value)
            ? ReadRank(value)
            : null;
    }

    private static int? ReadRank(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
            return number is >= 0 and <= 18 ? number : null;
        if (value.ValueKind == JsonValueKind.String &&
            int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number))
            return number is >= 0 and <= 18 ? number : null;
        return null;
    }
}

