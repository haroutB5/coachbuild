using System.Text.Json;

namespace CoachBuild.Core;

public sealed record AutoRunePageWrite(string Name, ApplyRunesResult Result, int? PageId = null);

public sealed record AutoRunePagesResult(
    IReadOnlyList<AutoRunePageWrite> Pages,
    bool OnlyOneEditableSlot);

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

    /// <summary>
    /// The legacy title prefix retained as owned for reuse and migration.
    /// New automatic pages use the two source prefixes below; item sets still
    /// use this CoachBuild prefix.
    /// </summary>
    public const string OwnedPagePrefix = "CoachBuild";
    public const string UGgOwnedPagePrefix = "u.gg ";
    public const string CoachlessOwnedPagePrefix = "Coachless ";

    /// <summary>The pre-2.2.0 shared title, still ours for prune and reuse.</summary>
    public const string LegacyImportPrefix = "CoachBuild import: ";

    /// <summary>
    /// The role words a title may carry BARE, which is only the legacy
    /// <c>CoachBuild import: Viktor Mid (u.gg)</c> shape. Exactly the labels
    /// <c>SiteImportValidator.RoleLabel</c> emits for a champ-select role, so a
    /// champion whose NAME ends in one of these words cannot exist here.
    /// </summary>
    private static readonly string[] RoleWords = ["Top", "Jungle", "Mid", "ADC", "Support"];

    /// <summary>
    /// How many app-owned rune pages may survive a write,
    /// counting the one just written. The one place this number lives.
    ///
    /// <para>WHY IT EXISTS. Field evidence 2026-09-08: the item-set write
    /// prunes — <see cref="ItemSetMergeService.Merge"/> drops every existing
    /// <c>CoachBuild</c>-titled set and re-adds only the current ones — but the
    /// rune write had no bound at all, because
    /// <c>SiteImportValidator.BuildRuneRequest</c> deliberately passes a null
    /// <c>replacePrefix</c> and that is the only thing that ever deleted a
    /// stale page. So the client kept a page per champion+role+source forever:
    /// <c>CoachBuild Mordekaiser Top</c> was still sitting there after its item
    /// set had been pruned. Two, not one: the page just written plus the
    /// previous champion's, so re-picking the last champion is still instant
    /// and a dodge does not cost the page you came from.</para>
    /// </summary>
    public const int MaxOwnedPages = 2;

    /// <summary>
    /// True only for rune pages the app owns: the two 2.2.0 source prefixes
    /// and the legacy CoachBuild prefix retained for migration/reuse.
    /// </summary>
    public static bool IsOwnedPageName(string? name) =>
        !string.IsNullOrEmpty(name) &&
        (name.StartsWith(UGgOwnedPagePrefix, StringComparison.Ordinal) ||
         name.StartsWith(CoachlessOwnedPagePrefix, StringComparison.Ordinal) ||
         name.StartsWith(OwnedPagePrefix, StringComparison.Ordinal));

    /// <summary>
    /// Which CHAMPION an owned rune page is for, or null when the title is not
    /// one of ours. This is a grouping key, not a display name: the only
    /// property it has to have is that <c>u.gg Viktor (Mid)</c> and
    /// <c>Coachless Viktor (Mid)</c> answer the SAME thing and a different
    /// champion answers something else.
    ///
    /// <para>WHY IT EXISTS. Field log 2026-09-09 13:11:22, Viktor hovered:
    /// <c>runes: wrote Coachless Viktor</c> followed immediately by
    /// <c>apply-runes: pruned 1 superseded CoachBuild rune page(s), keeping
    /// 1</c> — and the user was left with one page. The two sites import
    /// independently (2.2.1 imports on stable hover, so a run can carry only
    /// one of them), and the second write's prune saw the first write's fresh
    /// page as just another owned page and deleted it. The PAIR for the
    /// champion in hand is the product; its two halves must never be able to
    /// delete each other, whichever one is written second.</para>
    ///
    /// <para>Strip the site prefix, then a trailing parenthetical (a role on a
    /// 2.2.0 title, a source on a legacy one), then a bare trailing role word
    /// (legacy only). What is left is the champion.</para>
    /// </summary>
    public static string? ChampionOfOwnedPage(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var rest = name.Trim();
        if (rest.StartsWith(UGgOwnedPagePrefix, StringComparison.Ordinal))
            rest = rest[UGgOwnedPagePrefix.Length..];
        else if (rest.StartsWith(CoachlessOwnedPagePrefix, StringComparison.Ordinal))
            rest = rest[CoachlessOwnedPagePrefix.Length..];
        else if (rest.StartsWith(LegacyImportPrefix, StringComparison.Ordinal))
            rest = rest[LegacyImportPrefix.Length..];
        else if (rest.StartsWith(OwnedPagePrefix, StringComparison.Ordinal))
            rest = rest[OwnedPagePrefix.Length..];
        else
            return null;
        rest = rest.Trim();
        var open = rest.LastIndexOf('(');
        if (open > 0 && rest.EndsWith(')')) rest = rest[..open].TrimEnd();
        var space = rest.LastIndexOf(' ');
        if (space > 0 &&
            RoleWords.Contains(rest[(space + 1)..], StringComparer.OrdinalIgnoreCase))
            rest = rest[..space].TrimEnd();
        return rest.Length == 0 ? null : rest;
    }

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
            else if (actualFingerprint == desiredFingerprint)
            {
                // A MANUAL repeat press on an identical page (2.1.2): reuse
                // the page and make sure it is the current one, or report it
                // already is. A press must never be silent and never leave
                // the selection where the user left it: when the page is
                // identical but NOT selected, the edit PUT is skipped (the
                // content is already right) and CompleteAsync still selects,
                // prunes and verifies. Only identical AND already selected is
                // a no-write success, marked Unchanged so the caller can say
                // so honestly instead of claiming an import happened.
                if (await IsCurrentPageAsync(target.Id, cancellationToken).ConfigureAwait(false))
                {
                    _ledger.Record(body.Name!, desiredFingerprint);
                    return new ApplyRunesSuccess(true, true, [], true);
                }
                _ledger.Record(body.Name!, desiredFingerprint);
                return await CompleteAsync(target.Id, body, cancellationToken).ConfigureAwait(false);
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
            "all rune pages are yours -- delete one of your rune pages and retry");
    }

    /// <summary>
    /// Writes the automatic u.gg and Coachless pages as one capacity-aware
    /// operation. Requests are priority ordered (u.gg first). Exact names are
    /// reused first, then any owned page, then a free editable slot. A foreign
    /// page is never edited or deleted. Neither page becomes current unless an
    /// owned page was current before the operation; in that case the first
    /// successfully written page (u.gg) becomes current.
    /// </summary>
    public async Task<AutoRunePagesResult> ApplyOwnedPagesAsync(
        IReadOnlyList<ApplyRunesRequest>? requests,
        CancellationToken cancellationToken = default)
    {
        if (requests is null || requests.Count == 0)
            return new AutoRunePagesResult([], false);

        var desired = requests.Take(MaxOwnedPages).ToArray();
        var invalid = desired
            .Select(request => ApplyPayloadValidation.TryValidateRunes(request, out var failure) ? null : failure)
            .ToArray();
        if (invalid.Any(failure => failure is not null))
        {
            return new AutoRunePagesResult(
                desired.Select((request, index) => new AutoRunePageWrite(
                    request.Name ?? string.Empty,
                    invalid[index] ?? new ApplyRunesFailure("bad-batch", "another automatic rune page was invalid")))
                    .ToArray(),
                false);
        }

        using var write = _state?.BeginLcuWrite();
        var pagesResponse = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/pages",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (!pagesResponse.Ok)
        {
            return FailedBatch(desired, "read-failed", "could not read existing rune pages -- nothing was changed");
        }

        var editable = ReadPages(pagesResponse.Content);
        var currentResponse = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/currentpage",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        var currentWasOwned = CurrentWasOwned(currentResponse, editable);

        var owned = editable
            .Where(page => page.IsDeletable && IsOwnedPageName(page.Name))
            .OrderBy(page => page.Id)
            .ToList();
        var inventory = await _lcu.SendAsync(
            HttpMethod.Get,
            "/lol-perks/v1/inventory",
            cancellationToken: cancellationToken).ConfigureAwait(false);
        var freeSlots = ReadEditableCapacity(inventory) is { } capacity
            ? Math.Max(0, capacity - editable.Count)
            : 0;
        var writableCount = Math.Min(desired.Length, owned.Count + freeSlots);
        var onlyOne = desired.Length > 1 && writableCount == 1;

        var targets = new LcuPage?[writableCount];
        var assigned = new HashSet<int>();
        // Reserve exact names before consuming general owned pages.
        for (var index = 0; index < writableCount; index++)
        {
            var exact = owned.FirstOrDefault(page =>
                !assigned.Contains(page.Id) &&
                string.Equals(page.Name, desired[index].Name, StringComparison.Ordinal));
            if (exact is null) continue;
            targets[index] = exact;
            assigned.Add(exact.Id);
        }
        // The champions this batch is for. A page already holding one of them
        // is the OTHER HALF OF THE PAIR, and reusing it destroys the pair just
        // as surely as pruning it does (2.2.2): a Coachless-only hover run whose
        // only owned page was `u.gg Viktor` used to overwrite it and leave the
        // user with one page. So the sibling is the reuse candidate of LAST
        // resort — after same-site pages, after every other champion's page,
        // and only when there is no free slot to create into instead.
        var batchChampions = desired
            .Select(request => ChampionOfOwnedPage(request.Name))
            .Where(champion => champion is not null)
            .ToHashSet(StringComparer.OrdinalIgnoreCase)!;
        bool IsSibling(LcuPage page) =>
            ChampionOfOwnedPage(page.Name) is { } champion && batchChampions.Contains(champion);
        var creatable = freeSlots;
        for (var index = 0; index < writableCount; index++)
        {
            if (targets[index] is not null) continue;
            var family = PageFamily(desired[index].Name);
            var reusable = owned.FirstOrDefault(page =>
                    !assigned.Contains(page.Id) &&
                    string.Equals(PageFamily(page.Name), family, StringComparison.Ordinal))
                ?? owned.FirstOrDefault(page => !assigned.Contains(page.Id) && !IsSibling(page))
                ?? (creatable > 0 ? null : owned.FirstOrDefault(page => !assigned.Contains(page.Id)));
            if (reusable is null)
            {
                // Left for the create below, which consumes a free slot.
                if (creatable > 0) creatable--;
                continue;
            }
            targets[index] = reusable;
            assigned.Add(reusable.Id);
        }

        var results = new List<AutoRunePageWrite>(desired.Length);
        var successfulIds = new List<int>();
        for (var index = 0; index < desired.Length; index++)
        {
            var request = desired[index];
            if (index >= writableCount)
            {
                results.Add(new AutoRunePageWrite(
                    request.Name!,
                    new ApplyRunesFailure("slots-full", "no editable CoachBuild rune-page slot was available")));
                continue;
            }

            var target = targets[index];
            var fingerprint = Fingerprint(
                request.PrimaryStyleId,
                request.SubStyleId,
                request.SelectedPerkIds!);
            if (target is not null)
            {
                var unchanged = string.Equals(target.Name, request.Name, StringComparison.Ordinal) &&
                    Fingerprint(target.PrimaryStyleId, target.SubStyleId, target.SelectedPerkIds) == fingerprint;
                if (!unchanged)
                {
                    var edited = await _lcu.SendAsync(
                        HttpMethod.Put,
                        $"/lol-perks/v1/pages/{target.Id}",
                        CreatePageBody(target.Id, request, current: false),
                        cancellationToken).ConfigureAwait(false);
                    if (!edited.Ok)
                    {
                        results.Add(new AutoRunePageWrite(
                            request.Name!,
                            new ApplyRunesFailure("edit-failed", LcuFailureHint(edited.StatusCode, "rune page edit"))));
                        continue;
                    }
                }
                _ledger.Record(request.Name!, fingerprint);
                successfulIds.Add(target.Id);
                results.Add(new AutoRunePageWrite(
                    request.Name!,
                    new ApplyRunesSuccess(false, true, [], unchanged),
                    target.Id));
                continue;
            }

            var created = await _lcu.SendAsync(
                HttpMethod.Post,
                "/lol-perks/v1/pages",
                CreatePageBody(null, request, current: false),
                cancellationToken).ConfigureAwait(false);
            if (!created.Ok || !TryReadId(created.Content, out var createdId))
            {
                results.Add(new AutoRunePageWrite(
                    request.Name!,
                    new ApplyRunesFailure("create-failed", LcuFailureHint(created.StatusCode, "new rune page"))));
                continue;
            }
            _ledger.Record(request.Name!, fingerprint);
            successfulIds.Add(createdId);
            results.Add(new AutoRunePageWrite(
                request.Name!,
                new ApplyRunesSuccess(false, true, []),
                createdId));
        }

        var firstPage = results.FirstOrDefault();
        if (currentWasOwned && firstPage?.PageId is int uggId &&
            firstPage.Name.StartsWith(UGgOwnedPagePrefix, StringComparison.Ordinal))
        {
            var selected = await _lcu.SendAsync(
                HttpMethod.Put,
                "/lol-perks/v1/currentpage",
                uggId,
                cancellationToken).ConfigureAwait(false);
            if (selected.Ok && results[0].Result is ApplyRunesSuccess first)
                results[0] = results[0] with { Result = first with { Selected = true } };
        }

        await PruneOwnedPagesExceptAsync(
            successfulIds,
            desired.Select(request => request.Name!).ToArray(),
            cancellationToken).ConfigureAwait(false);
        return new AutoRunePagesResult(results, onlyOne);
    }

    /// <summary>
    /// Which of the client's rune pages a write should delete, so that at most
    /// <see cref="MaxOwnedPages"/> CoachBuild pages survive.
    ///
    /// <para>Pure, so the rule is testable without a client. The rules, each of
    /// which is a refusal:</para>
    /// <list type="bullet">
    ///   <item>A page whose title does not match <see cref="IsOwnedPageName"/>
    ///   is the USER'S and is never returned,
    ///   whatever the cap says. Title-less pages are the user's too.</item>
    ///   <item>An undeletable page is never returned (the client owns those).</item>
    ///   <item><paramref name="keepId"/> — the page just written — is never
    ///   returned, even if it is somehow not the newest.</item>
    ///   <item>The current champion's SIBLING page — the other site's page for
    ///   the same champion — takes the survivor slot ahead of any other
    ///   champion's page, however new that other page is. The pair is the
    ///   product; the two halves are never each other's competition.</item>
    ///   <item>Of the rest, the newest fill whatever survivor slots remain.
    ///   "Newest" is page id: the LCU issues them ascending and there is no
    ///   timestamp on the resource, so the id IS the age order.</item>
    /// </list>
    /// </summary>
    public static IReadOnlyList<int> PagesToPrune(IEnumerable<LcuPage>? pages, int keepId) =>
        PruneCore(pages, [keepId], null, siblingsOnly: false);

    /// <summary>
    /// The prune after an automatic batch write (<see
    /// cref="ApplyOwnedPagesAsync"/>): every owned page that is neither one of
    /// the pages just written nor a surviving SIBLING of the champion in hand.
    ///
    /// <para>Unlike <see cref="PagesToPrune"/> this deliberately does NOT let
    /// another champion's page take a spare slot — the batch is the authority
    /// on what the current champion needs, and a page it did not write for this
    /// champion is superseded. The only thing 2.2.2 adds is that the current
    /// champion's other-site page counts as ours to KEEP, up to
    /// <see cref="MaxOwnedPages"/> in total.</para>
    ///
    /// <para><paramref name="writtenNames"/> is every name the batch ASKED for,
    /// not only the ones that succeeded: a u.gg write that failed this run must
    /// not cost the user the u.gg page a previous run left behind.</para>
    /// </summary>
    public static IReadOnlyList<int> PagesToPruneAfterBatch(
        IEnumerable<LcuPage>? pages,
        IReadOnlyCollection<int> keepIds,
        IEnumerable<string>? writtenNames = null) =>
        keepIds.Count == 0 ? [] : PruneCore(pages, keepIds, writtenNames, siblingsOnly: true);

    private static IReadOnlyList<int> PruneCore(
        IEnumerable<LcuPage>? pages,
        IReadOnlyCollection<int> keepIds,
        IEnumerable<string>? writtenNames,
        bool siblingsOnly)
    {
        if (pages is null) return [];
        var kept = keepIds.ToHashSet();
        var ours = pages
            .Where(page =>
                page is not null &&
                page.IsDeletable &&
                page.Name is not null &&
                IsOwnedPageName(page.Name))
            .ToArray();

        // The champion in hand, named by the write itself and by the pages it
        // produced. Both, because a write can fail after its page exists and a
        // page can exist that the read did not return.
        var champions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in writtenNames ?? [])
            if (ChampionOfOwnedPage(name) is { } asked) champions.Add(asked);
        foreach (var page in ours)
            if (kept.Contains(page.Id) && ChampionOfOwnedPage(page.Name) is { } written)
                champions.Add(written);

        var others = ours
            .Where(page => !kept.Contains(page.Id))
            .OrderByDescending(page => page.Id)
            .ToArray();
        var siblingIds = others
            .Where(page => ChampionOfOwnedPage(page.Name) is { } champion && champions.Contains(champion))
            .Select(page => page.Id)
            .ToHashSet();
        var siblings = others.Where(page => siblingIds.Contains(page.Id));
        var strangers = others.Where(page => !siblingIds.Contains(page.Id));
        // The pages just written already occupy their slots of the cap.
        var budget = Math.Max(0, MaxOwnedPages - kept.Count);
        var survivors = (siblingsOnly ? siblings : siblings.Concat(strangers))
            .Take(budget)
            .Select(page => page.Id)
            .ToHashSet();
        return others.Where(page => !survivors.Contains(page.Id)).Select(page => page.Id).ToArray();
    }

    public void ClearForChampSelect() => _ledger.Clear();

    /// <summary>
    /// Whether the client's currently selected rune page is <paramref
    /// name="pageId"/>. Best effort by construction: an unreadable current
    /// page answers false and the caller re-applies rather than guesses.
    /// Never throws.
    /// </summary>
    private async Task<bool> IsCurrentPageAsync(int pageId, CancellationToken cancellationToken)
    {
        try
        {
            var current = await _lcu.SendAsync(
                HttpMethod.Get,
                "/lol-perks/v1/currentpage",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            return current.Ok && TryReadId(current.Content, out var currentId) && currentId == pageId;
        }
        catch
        {
            return false;
        }
    }

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
        // AFTER the selection, deliberately: the page we just wrote is now the
        // current one, so every page this prunes is deselected and deletable.
        await PruneOwnedPagesAsync(pageId, cancellationToken).ConfigureAwait(false);
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

    /// <summary>
    /// Deletes CoachBuild rune pages beyond <see cref="MaxOwnedPages"/>, newest
    /// first kept. Best effort by construction: this runs after a page has
    /// already been written and selected, so a failed cleanup must never turn a
    /// successful import into a failure — every hop swallows, and the next
    /// write re-attempts whatever survived.
    /// </summary>
    private async Task PruneOwnedPagesAsync(int keepId, CancellationToken cancellationToken)
    {
        try
        {
            var pagesResponse = await _lcu.SendAsync(
                HttpMethod.Get,
                "/lol-perks/v1/pages",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!pagesResponse.Ok) return;
            var doomed = PagesToPrune(ReadPages(pagesResponse.Content), keepId);
            if (doomed.Count == 0) return;
            var removed = 0;
            foreach (var id in doomed)
            {
                try
                {
                    var response = await _lcu.SendAsync(
                        HttpMethod.Delete,
                        $"/lol-perks/v1/pages/{id}",
                        cancellationToken: cancellationToken).ConfigureAwait(false);
                    if (response.Ok) removed++;
                }
                catch
                {
                    // A page the client refuses to delete stays; the next
                    // write tries again once selection has moved off it.
                }
            }
            if (removed > 0)
                _log?.Info($"apply-runes: pruned {removed} older CoachBuild rune page(s), keeping {MaxOwnedPages}");
        }
        catch
        {
            // The write already succeeded. Cleanup is not allowed to undo that.
        }
    }

    /// <summary>
    /// The automatic batch's cleanup. Deletes every owned page the batch did
    /// not write EXCEPT the current champion's other-site page, which
    /// <see cref="PagesToPruneAfterBatch"/> spares — the 2.2.2 fix for the
    /// sibling-eats-sibling field bug. Fail-soft like every prune: both writes
    /// already landed and cleanup may not undo them.
    /// </summary>
    private async Task PruneOwnedPagesExceptAsync(
        IReadOnlyCollection<int> keepIds,
        IReadOnlyCollection<string> writtenNames,
        CancellationToken cancellationToken)
    {
        if (keepIds.Count == 0) return;
        try
        {
            var pagesResponse = await _lcu.SendAsync(
                HttpMethod.Get,
                "/lol-perks/v1/pages",
                cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!pagesResponse.Ok) return;
            var all = ReadPages(pagesResponse.Content);
            var doomed = PagesToPruneAfterBatch(all, keepIds, writtenNames);
            var surviving = all.Count(page => page.IsDeletable && IsOwnedPageName(page.Name)) - doomed.Count;
            var removed = 0;
            foreach (var id in doomed)
            {
                try
                {
                    var response = await _lcu.SendAsync(
                        HttpMethod.Delete,
                        $"/lol-perks/v1/pages/{id}",
                        cancellationToken: cancellationToken).ConfigureAwait(false);
                    if (response.Ok) removed++;
                }
                catch
                {
                }
            }
            if (removed > 0)
                _log?.Info($"apply-runes: pruned {removed} superseded CoachBuild rune page(s), keeping {surviving}");
        }
        catch
        {
            // Both requested writes already completed. Cleanup is fail-soft.
        }
    }

    private static AutoRunePagesResult FailedBatch(
        IReadOnlyList<ApplyRunesRequest> requests,
        string reason,
        string hint) =>
        new(requests.Select(request => new AutoRunePageWrite(
            request.Name ?? string.Empty,
            new ApplyRunesFailure(reason, hint))).ToArray(), false);

    private static bool CurrentWasOwned(LcuResponse response, IReadOnlyList<LcuPage> pages)
    {
        if (!response.Ok || response.Content is not { } current) return false;
        if (current.ValueKind == JsonValueKind.Object && IsOwnedPageName(ReadString(current, "name")))
            return true;
        return TryReadId(current, out var currentId) &&
            pages.Any(page => page.Id == currentId && IsOwnedPageName(page.Name));
    }

    private static int? ReadEditableCapacity(LcuResponse response)
    {
        if (!response.Ok || response.Content is not { } inventory ||
            inventory.ValueKind != JsonValueKind.Object ||
            !inventory.TryGetProperty("ownedPageCount", out var count) ||
            !count.TryGetInt32(out var capacity) || capacity <= 0)
            return null;
        return capacity;
    }

    private static string PageFamily(string? name)
    {
        if (name?.StartsWith(UGgOwnedPagePrefix, StringComparison.Ordinal) == true) return UGgOwnedPagePrefix;
        if (name?.StartsWith(CoachlessOwnedPagePrefix, StringComparison.Ordinal) == true) return CoachlessOwnedPagePrefix;
        return OwnedPagePrefix;
    }

    private static object CreatePageBody(int? id, ApplyRunesRequest request, bool current = true)
    {
        if (id is null)
            return new
            {
                name = request.Name,
                primaryStyleId = request.PrimaryStyleId,
                subStyleId = request.SubStyleId,
                selectedPerkIds = request.SelectedPerkIds,
                current
            };
        return new
        {
            id = id.Value,
            name = request.Name,
            primaryStyleId = request.PrimaryStyleId,
            subStyleId = request.SubStyleId,
            selectedPerkIds = request.SelectedPerkIds,
            current
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
