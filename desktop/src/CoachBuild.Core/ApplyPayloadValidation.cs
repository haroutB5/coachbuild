using System.Text.Json;

namespace CoachBuild.Core;

public static class ApplyPayloadValidation
{
    public static bool IsCoachBuildTitle(string? title) =>
        !string.IsNullOrEmpty(title) && title.StartsWith("CoachBuild", StringComparison.Ordinal);

    public static bool IsValidReplacePrefix(string? replacePrefix) =>
        string.IsNullOrEmpty(replacePrefix) || IsCoachBuildTitle(replacePrefix);

    public static bool TryValidateRunes(ApplyRunesRequest? request, out ApplyRunesFailure failure)
    {
        if (request is null ||
            !IsCoachBuildTitle(request.Name) ||
            request.PrimaryStyleId <= 0 ||
            request.SubStyleId <= 0 ||
            request.SelectedPerkIds is null ||
            request.SelectedPerkIds.Count != 9 ||
            request.SelectedPerkIds.Any(x => x <= 0) ||
            !request.Current ||
            !IsValidReplacePrefix(request.ReplacePrefix))
        {
            failure = new ApplyRunesFailure("invalid-page");
            return false;
        }
        failure = null!;
        return true;
    }

    public static bool TryValidateItemSets(
        ApplyItemSetsRequest? request,
        out ApplyItemSetsFailure failure)
    {
        if (request is null || request.ChampionId <= 0 ||
            request.Sets is null || request.Sets.Count is < 1 or > 3 ||
            !IsValidReplacePrefix(request.ReplacePrefix) ||
            request.Sets.Any(set => !TryReadTitle(set, out var title) || !IsCoachBuildTitle(title)))
        {
            failure = new ApplyItemSetsFailure(
                "invalid-sets",
                "each set title (and replacePrefix, if given) must start with \"CoachBuild\" (1-3 sets)");
            return false;
        }
        failure = null!;
        return true;
    }

    public static bool TryReadTitle(JsonElement set, out string? title)
    {
        title = null;
        if (set.ValueKind != JsonValueKind.Object || !set.TryGetProperty("title", out var value) ||
            value.ValueKind != JsonValueKind.String)
            return false;
        title = value.GetString();
        return !string.IsNullOrWhiteSpace(title);
    }
}
