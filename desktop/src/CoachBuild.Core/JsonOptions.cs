using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Core;

public static class JsonOptions
{
    /// <summary>
    /// The bridge uses explicit property names for its public records and
    /// camel-case for internal DTOs. Nulls stay on status responses because
    /// companionClient.ts intentionally distinguishes a well-formed null
    /// diagnostic from a malformed response.
    /// </summary>
    public static JsonSerializerOptions Wire { get; } = Create();

    public static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            DictionaryKeyPolicy = JsonNamingPolicy.CamelCase,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            PropertyNameCaseInsensitive = true,
            WriteIndented = false,
            AllowTrailingCommas = false,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            NumberHandling = JsonNumberHandling.Strict
        };
        return options;
    }
}

