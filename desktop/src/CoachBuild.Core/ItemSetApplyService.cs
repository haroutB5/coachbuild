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
        // Immediately after the count, because the two lines are one thought:
        // here is what you got, and here is what you did NOT get and why.
        RecordDiagnostics(request);
        return new ApplyItemSetsSuccess(sets.Count);
    }

    /// <summary>
    /// Writes the web's outage diagnostics to the log, AFTER the item-set
    /// write has already succeeded.
    ///
    /// <para>Nothing in this method can change the result the caller
    /// receives, and the whole body is inside a catch. A diagnostic capable of
    /// failing an apply is worse than no diagnostic.</para>
    ///
    /// <para>SUCCESS ONLY, deliberately. A failed write already tells the user
    /// loudly that nothing happened, and the case this exists for is the
    /// opposite one — an export that SUCCEEDS and is quietly missing a block
    /// because an upstream query failed. That is the shape the 2026-08-20 Neon
    /// outage had, and it is the shape with no other symptom.</para>
    ///
    /// <para>SILENT WHEN ABSENT. Every healthy export omits the key, so there
    /// is no "no diagnostics" line: a diagnostic that fires on every apply is
    /// noise, and noise is what the one line that matters gets lost in.</para>
    /// </summary>
    private void RecordDiagnostics(ApplyItemSetsRequest request)
    {
        if (_log is null) return;
        try
        {
            var lines = ApplyDiagnosticsParser.Parse(request.Diagnostics, out var rejections);
            // The web's sentence, verbatim, under the existing apply-itemsets
            // prefix so one grep still finds the whole export. It already names
            // the BLOCK the user lost rather than just the endpoint -- that is
            // what connects "my Pro build block is gone" to "/api/pros answered
            // 500" without a reader knowing they are the same event -- so
            // re-wording it here could only weaken it.
            foreach (var line in lines)
                _log.Info($"apply-itemsets: {line}");
            if (rejections.Count > 0)
                _log.Info($"apply-itemsets: diagnostics dropped {rejections.Count} " +
                    $"line{(rejections.Count == 1 ? "" : "s")} — {string.Join("; ", rejections)}");
        }
        catch (Exception error)
        {
            _log.Info($"apply-itemsets: diagnostics ignored ({error.GetType().Name})");
        }
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
