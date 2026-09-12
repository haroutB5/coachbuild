using System.Text.Json;
using System.Text.Json.Nodes;

namespace CoachBuild.Core;

public static class ItemSetMergeService
{
    public static JsonObject Merge(
        JsonObject existing,
        IReadOnlyList<JsonElement> newSets,
        string? replacePrefix = null)
    {
        var result = (JsonObject)existing.DeepClone();
        var kept = new JsonArray();
        if (result["itemSets"] is JsonArray current)
        {
            foreach (var item in current)
            {
                var title = ReadString(item, "title");
                var uid = ReadString(item, "uid");
                // Ours: a CoachBuild uid (2.4.3+, plain titles) or the legacy
                // CoachBuild title. Foreign sets, including title-less
                // entries, survive byte-for-byte.
                if (ApplyPayloadValidation.IsOwnedItemSet(title, uid))
                    continue;
                kept.Add(item?.DeepClone());
            }
        }
        foreach (var set in newSets)
        {
            var node = JsonNode.Parse(set.GetRawText());
            if (node is not null) kept.Add(node);
        }
        result["itemSets"] = kept;
        return result;
    }

    public static JsonObject? Merge(
        JsonElement existing,
        IReadOnlyList<JsonElement> newSets,
        string? replacePrefix = null)
    {
        if (existing.ValueKind != JsonValueKind.Object) return null;
        var node = JsonNode.Parse(existing.GetRawText()) as JsonObject;
        return node is null ? null : Merge(node, newSets, replacePrefix);
    }

    private static string? ReadString(JsonNode? item, string property) =>
        (item as JsonObject)?[property] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : null;

    public static int SerializedUtf8Length(JsonObject value) =>
        JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions.Wire).Length;
}
