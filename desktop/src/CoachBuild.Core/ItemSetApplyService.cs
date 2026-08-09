using System.Text.Json;
using System.Text.Json.Nodes;

namespace CoachBuild.Core;

public sealed class ItemSetApplyService
{
    private readonly ILcuApi _lcu;
    private readonly CompanionState? _state;
    private readonly RedactedLog? _log;

    public ItemSetApplyService(ILcuApi lcu, CompanionState? state = null, RedactedLog? log = null)
    {
        _lcu = lcu;
        _state = state;
        _log = log;
    }

    public async Task<ApplyItemSetsResult> ApplyAsync(
        ApplyItemSetsRequest? request,
        CancellationToken cancellationToken = default)
    {
        if (!ApplyPayloadValidation.TryValidateItemSets(request, out var invalid)) return invalid;
        if (_state is not null && !_state.ClientConnected)
            return new ApplyItemSetsFailure("no-client", "League client not detected -- open the client and try again");

        using var write = _state?.BeginLcuWrite();
        var summoner = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-summoner/v1/current-summoner",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!summoner.Ok || !TryReadSummonerId(summoner.Content, out var summonerId))
            return new ApplyItemSetsFailure("read-failed", "could not read the current summoner -- nothing was changed");

        var path = $"/lol-item-sets/v1/item-sets/{summonerId}/sets";
        var existing = await _lcu.SendAsync(HttpMethod.Get, path, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
        if (!existing.Ok || existing.Content is not { } existingContent || existingContent.ValueKind != JsonValueKind.Object)
            return new ApplyItemSetsFailure("read-failed", "couldn't read your existing item sets -- nothing was changed");

        var sets = request!.Sets!;
        var merged = ItemSetMergeService.Merge(existingContent, sets, request.ReplacePrefix);
        if (merged is null)
            return new ApplyItemSetsFailure("read-failed", "couldn't read your existing item sets -- nothing was changed");
        var put = await _lcu.SendAsync(HttpMethod.Put, path, merged, cancellationToken).ConfigureAwait(false);
        if (!put.Ok)
            return new ApplyItemSetsFailure("write-failed", LcuFailureHint(put.StatusCode));
        _log?.Info($"apply-itemsets: count={sets.Count}");
        return new ApplyItemSetsSuccess(sets.Count);
    }

    private static bool TryReadSummonerId(JsonElement? value, out long id)
    {
        id = 0;
        if (value is not { } element || element.ValueKind != JsonValueKind.Object ||
            !element.TryGetProperty("summonerId", out var property)) return false;
        return property.ValueKind == JsonValueKind.Number && property.TryGetInt64(out id) && id > 0;
    }

    private static string LcuFailureHint(int statusCode) => statusCode is 0 or 401
        ? "companion lost the client connection -- it re-detects automatically, try again in a few seconds"
        : $"League client rejected the item-set write (HTTP {statusCode}) -- make sure you're logged in and not mid-game";
}
