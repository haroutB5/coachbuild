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
                var titleNode = (item as JsonObject)?["title"];
                var title = titleNode is JsonValue titleValue && titleValue.TryGetValue<string>(out var text)
                    ? text
                    : null;
                // Only the literal generic prefix is ours. Foreign sets,
                // including title-less entries, survive byte-for-byte.
                if (!string.IsNullOrEmpty(title) &&
                    title.StartsWith("CoachBuild", StringComparison.Ordinal))
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

    public static int SerializedUtf8Length(JsonObject value) =>
        JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions.Wire).Length;
}
