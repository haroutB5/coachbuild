// Calls the unmodified C# implementation, never an independent reimplementation.
// No desktop startup, network, credentials or user files are used.
using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;

var input = JsonNode.Parse(Console.In.ReadToEnd())!.AsObject();
foreach (var row in input["cases"]!.AsArray())
{
    var item = row!.AsObject();
    using var existing = JsonDocument.Parse(item["existing"]?.ToJsonString() ?? "null");
    var newSets = item["newSets"]!.AsArray()
        .Select(set => JsonSerializer.SerializeToElement(set)).ToArray();
    item["expected"] = ItemSetMergeService.Merge(existing.RootElement, newSets,
        item["replacePrefix"]?.GetValue<string>());
}
Console.Write(input.ToJsonString(JsonOptions.Wire));
