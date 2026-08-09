using System.Text.Json;

namespace CoachBuild.Core;

public sealed class RuneApplyService
{
    private readonly ILcuApi _lcu;
    private readonly RuneOwnershipLedger _ledger;
    private readonly CompanionState? _state;
    private readonly RedactedLog? _log;

    public RuneApplyService(
        ILcuApi lcu,
        RuneOwnershipLedger? ledger = null,
        CompanionState? state = null,
        RedactedLog? log = null)
    {
        _lcu = lcu;
        _ledger = ledger ?? new RuneOwnershipLedger();
        _state = state;
        _log = log;
    }

    public RuneOwnershipLedger Ledger => _ledger;

    public async Task<ApplyRunesResult> ApplyAsync(
        ApplyRunesRequest? request,
        CancellationToken cancellationToken = default)
    {
        if (!ApplyPayloadValidation.TryValidateRunes(request, out var invalid)) return invalid;
        var body = request!;
        var mode = string.Equals(body.Mode, "auto", StringComparison.Ordinal) ? "auto" : "manual";
        using var write = _state?.BeginLcuWrite();

        var pagesResponse = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/pages",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!pagesResponse.Ok)
            return new ApplyRunesFailure("read-failed", "could not read existing rune pages -- nothing was changed");
        var editablePages = ReadPages(pagesResponse.Content);

        if (!string.IsNullOrEmpty(body.ReplacePrefix) && body.ReplacePrefix.StartsWith("CoachBuild", StringComparison.Ordinal))
        {
            var stale = editablePages.Where(page =>
                    page.IsDeletable &&
                    page.Name is not null &&
                    page.Name.StartsWith("CoachBuild", StringComparison.Ordinal) &&
                    !page.Name.StartsWith(body.ReplacePrefix!, StringComparison.Ordinal))
                .ToArray();
            var deleted = false;
            foreach (var page in stale)
            {
                try
                {
                    var response = await _lcu.SendAsync(
                        HttpMethod.Delete,
                        $"/lol-perks/v1/pages/{page.Id}",
                        cancellationToken: cancellationToken).ConfigureAwait(false);
                    deleted |= response.Ok;
                }
                catch
                {
                    // A selected stale page can be undeletable. Skip it and
                    // allow the next cycle to self-heal after selection moves.
                }
            }
            if (deleted)
            {
                var reread = await _lcu.SendAsync(
                    HttpMethod.Get,
                    "/lol-perks/v1/pages",
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                if (reread.Ok) editablePages = ReadPages(reread.Content);
            }
        }

        var target = editablePages
            .Where(page => string.Equals(page.Name, body.Name, StringComparison.Ordinal))
            .OrderBy(page => page.Id)
            .FirstOrDefault();
        var desiredFingerprint = Fingerprint(body.PrimaryStyleId, body.SubStyleId, body.SelectedPerkIds!);

        if (target is not null)
        {
            var actualFingerprint = Fingerprint(target.PrimaryStyleId, target.SubStyleId, target.SelectedPerkIds);
            if (mode == "auto")
            {
                if (actualFingerprint == desiredFingerprint)
                {
                    _ledger.Record(body.Name!, desiredFingerprint);
                    return new ApplyRunesSuccess(false, true, [], true);
                }
                var lastWritten = _ledger.Get(body.Name!);
                if (lastWritten is not null && lastWritten != actualFingerprint)
                    return new ApplyRunesFailure(
                        "user-modified",
                        "you changed this rune page in the client -- CoachBuild left your version alone");
            }

            var edit = await _lcu.SendAsync(
                HttpMethod.Put,
                $"/lol-perks/v1/pages/{target.Id}",
                CreatePageBody(target.Id, body),
                cancellationToken).ConfigureAwait(false);
            if (!edit.Ok)
                return new ApplyRunesFailure("edit-failed", LcuFailureHint(edit.StatusCode, "rune page edit"));
            _ledger.Record(body.Name!, desiredFingerprint);
            return await CompleteAsync(target.Id, body, cancellationToken).ConfigureAwait(false);
        }

        bool? hasFreeSlot = null;
        var inventory = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/inventory",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (inventory.Ok && inventory.Content is { } inventoryContent &&
            inventoryContent.ValueKind == JsonValueKind.Object &&
            inventoryContent.TryGetProperty("ownedPageCount", out var capacity) &&
            capacity.TryGetInt32(out var ownedPageCount) && ownedPageCount > 0)
            hasFreeSlot = editablePages.Count < ownedPageCount;

        if (hasFreeSlot != false)
        {
            var created = await _lcu.SendAsync(
                HttpMethod.Post,
                "/lol-perks/v1/pages",
                CreatePageBody(null, body),
                cancellationToken).ConfigureAwait(false);
            if (created.Ok && TryReadId(created.Content, out var createdId))
            {
                _ledger.Record(body.Name!, desiredFingerprint);
                return await CompleteAsync(createdId, body, cancellationToken).ConfigureAwait(false);
            }
        }

        if (mode == "manual")
        {
            var current = await _lcu.SendAsync(
                HttpMethod.Get,
                "/lol-perks/v1/currentpage",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (current.Ok && TryReadId(current.Content, out var currentId))
            {
                var deleted = await _lcu.SendAsync(
                    HttpMethod.Delete,
                    $"/lol-perks/v1/pages/{currentId}",
                    cancellationToken: cancellationToken).ConfigureAwait(false);
                if (!deleted.Ok)
                    return new ApplyRunesFailure("delete-failed", "delete a rune page manually and retry");
            }
            var created = await _lcu.SendAsync(
                HttpMethod.Post,
                "/lol-perks/v1/pages",
                CreatePageBody(null, body),
                cancellationToken).ConfigureAwait(false);
            if (!created.Ok || !TryReadId(created.Content, out var createdId))
                return new ApplyRunesFailure("create-failed", LcuFailureHint(created.StatusCode, "new rune page"));
            _ledger.Record(body.Name!, desiredFingerprint);
            return await CompleteAsync(createdId, body, cancellationToken).ConfigureAwait(false);
        }

        _log?.Info("apply-runes: rejected slots-full");
        return new ApplyRunesFailure(
            "slots-full",
            "all rune pages are yours -- click Apply runes to replace the current one");
    }

    public void ClearForChampSelect() => _ledger.Clear();

    public static string Fingerprint(int primaryStyleId, int subStyleId, IEnumerable<int> selectedPerkIds) =>
        $"{primaryStyleId}|{subStyleId}|{string.Join(',', selectedPerkIds)}";

    private async Task<ApplyRunesSuccess> CompleteAsync(
        int pageId,
        ApplyRunesRequest body,
        CancellationToken cancellationToken)
    {
        var selectedResponse = await _lcu.SendAsync(
            HttpMethod.Put,
            "/lol-perks/v1/currentpage",
            pageId,
            cancellationToken).ConfigureAwait(false);
        var currentResponse = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/currentpage",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        var mismatch = new List<string>();
        var verified = false;
        if (currentResponse.Ok && currentResponse.Content is { } current &&
            current.ValueKind == JsonValueKind.Object && TryReadId(current, out var currentId) && currentId == pageId)
        {
            if (!string.Equals(ReadString(current, "name"), body.Name, StringComparison.Ordinal)) mismatch.Add("name");
            var perks = ReadIntArray(current, "selectedPerkIds");
            if (!perks.SequenceEqual(body.SelectedPerkIds!)) mismatch.Add("selectedPerkIds");
            verified = mismatch.Count == 0;
        }
        return new ApplyRunesSuccess(selectedResponse.Ok, verified, mismatch);
    }

    private static object CreatePageBody(int? id, ApplyRunesRequest request)
    {
        if (id is null)
            return new
            {
                name = request.Name,
                primaryStyleId = request.PrimaryStyleId,
                subStyleId = request.SubStyleId,
                selectedPerkIds = request.SelectedPerkIds,
                current = true
            };
        return new
        {
            id = id.Value,
            name = request.Name,
            primaryStyleId = request.PrimaryStyleId,
            subStyleId = request.SubStyleId,
            selectedPerkIds = request.SelectedPerkIds,
            current = true
        };
    }

    private static IReadOnlyList<LcuPage> ReadPages(JsonElement? content)
    {
        if (content is not { } value || value.ValueKind != JsonValueKind.Array) return [];
        var result = new List<LcuPage>();
        foreach (var page in value.EnumerateArray())
        {
            if (page.ValueKind != JsonValueKind.Object || !TryReadId(page, out var id)) continue;
            var isDeletable = page.TryGetProperty("isDeletable", out var deletable) && deletable.ValueKind == JsonValueKind.True;
            if (!isDeletable) continue;
            result.Add(new LcuPage(
                id,
                ReadString(page, "name"),
                true,
                ReadInt(page, "primaryStyleId"),
                ReadInt(page, "subStyleId"),
                ReadIntArray(page, "selectedPerkIds"),
                page.TryGetProperty("current", out var current) && current.ValueKind == JsonValueKind.True));
        }
        return result;
    }

    private static bool TryReadId(JsonElement? value, out int id)
    {
        id = 0;
        return value is { } element && TryReadId(element, out id);
    }

    private static bool TryReadId(JsonElement value, out int id)
    {
        id = 0;
        if (value.ValueKind == JsonValueKind.Object && value.TryGetProperty("id", out var property)) value = property;
        return value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out id) && id > 0;
    }

    private static int ReadInt(JsonElement value, string property) =>
        value.TryGetProperty(property, out var item) && item.TryGetInt32(out var result) ? result : 0;

    private static string? ReadString(JsonElement value, string property) =>
        value.TryGetProperty(property, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;

    private static IReadOnlyList<int> ReadIntArray(JsonElement value, string property)
    {
        if (!value.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array) return [];
        return array.EnumerateArray().Where(x => x.TryGetInt32(out _)).Select(x => x.GetInt32()).ToArray();
    }

    private static string LcuFailureHint(int statusCode, string action) => statusCode is 0 or 401
        ? "companion lost the client connection -- it re-detects automatically, try again in a few seconds"
        : $"League client rejected the {action} (HTTP {statusCode}) -- make sure you're logged in and not mid-game";
}
