using System.Text.Json;
using System.Text.Json.Nodes;
using CoachBuild.Core;

namespace CoachBuild.Desktop.Web;

/// <summary>
/// One slot section reported by a Coachless <c>inspect</c> step, in DOM
/// order: the page's own header text, whether its top-WPA row (first
/// <c>tr.data-row</c>) already carries the site's <c>active</c> selection,
/// how many option rows the table currently holds, whether that top row
/// carries the site's <c>selectable</c> class (a slot whose top row is not
/// selectable is READ-ONLY — the site grants selections only to a capped
/// depth, e.g. Keystone/Starter/1st/2nd for Jhin ADC — and must be skipped,
/// never clicked), and whether ANY row of the table is currently
/// <c>active</c> (the settle wait watches this for the clicked slot).
/// </summary>
public sealed record CoachlessSlotState(
    string Title,
    bool TopSelected,
    int Rows,
    bool TopSelectable,
    bool HasActive);

/// <summary>
/// One typed step result from the Coachless step script: <c>state</c> (slot
/// list + settle fingerprint), <c>clicked</c> / <c>already-selected</c> (the
/// slot actually clicked), <c>done</c> (final payload), or <c>error</c>.
/// Never throws: an unparseable script result is the unrecognized-page
/// failure, because a failed import must report precisely and write
/// nothing.
/// </summary>
public sealed record CoachlessStepResponse(
    string? Stage,
    string? ClickedSlot,
    bool Settled,
    string? Hash,
    IReadOnlyList<CoachlessSlotState> Slots,
    string? PayloadJson,
    string? Error)
{
    public static CoachlessStepResponse Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return Unrecognized();
        try
        {
            using var document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.String)
            {
                // ExecuteScriptAsync JSON-encodes a returned JS string, so
                // the outer value is typically "..." wrapping the step
                // object — same envelope as the extractor payloads.
                var inner = root.GetString();
                if (string.IsNullOrWhiteSpace(inner)) return Unrecognized();
                using var innerDocument = JsonDocument.Parse(inner);
                return FromObject(innerDocument.RootElement);
            }
            return FromObject(root);
        }
        catch (JsonException)
        {
            return Unrecognized();
        }
    }

    private static CoachlessStepResponse FromObject(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object) return Unrecognized();
        if (ReadString(root, "error") is { } error && !string.IsNullOrWhiteSpace(error))
            return new CoachlessStepResponse(null, null, false, null, [], null, error.Trim());
        var stage = ReadString(root, "stage")?.Trim();
        if (string.IsNullOrEmpty(stage)) return Unrecognized();
        var slots = new List<CoachlessSlotState>();
        if (root.TryGetProperty("slots", out var slotsElement) &&
            slotsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var slot in slotsElement.EnumerateArray())
            {
                if (slot.ValueKind != JsonValueKind.Object) continue;
                var title = ReadString(slot, "title")?.Trim() ?? string.Empty;
                if (string.IsNullOrEmpty(title)) continue;
                var topSelected = slot.TryGetProperty("topSelected", out var selected) &&
                    selected.ValueKind == JsonValueKind.True;
                var rows = slot.TryGetProperty("rows", out var rowsElement) &&
                    rowsElement.TryGetInt32(out var count) ? count : 0;
                var topSelectable = slot.TryGetProperty("topSelectable", out var selectable) &&
                    selectable.ValueKind == JsonValueKind.True;
                var hasActive = slot.TryGetProperty("hasActive", out var active) &&
                    active.ValueKind == JsonValueKind.True;
                slots.Add(new CoachlessSlotState(title, topSelected, rows, topSelectable, hasActive));
            }
        }
        string? payloadJson = null;
        if (root.TryGetProperty("payload", out var payload) &&
            payload.ValueKind == JsonValueKind.Object)
            payloadJson = payload.GetRawText();
        var settled = root.TryGetProperty("settled", out var settledElement) &&
            settledElement.ValueKind == JsonValueKind.True;
        return new CoachlessStepResponse(
            stage,
            ReadString(root, "clickedSlot")?.Trim(),
            settled,
            ReadString(root, "hash")?.Trim(),
            slots,
            payloadJson,
            null);
    }

    private static CoachlessStepResponse Unrecognized() =>
        new(null, null, false, null, [], null, SiteImportFailures.NotRecognized);

    private static string? ReadString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}

/// <summary>
/// The <c>__COACHLESS_STEP_JSON__</c> action objects embedded into
/// <see cref="SiteImportExtractors.CoachlessStepTemplate"/>: one small
/// script per step, each invoked from the single import click handler.
/// </summary>
public static class SiteImportSteps
{
    /// <summary>List the slot sections in DOM order with selection state + settle hash.</summary>
    public static string Inspect() => """{"action":"inspect"}""";

    /// <summary>
    /// Click the top-WPA row of the named slot: a no-op <c>already-selected</c>
    /// when it is already <c>active</c>, a no-op <c>read-only</c> when it lost
    /// the <c>selectable</c> class (the driver skips it with no settle wait).
    /// </summary>
    public static string Click(string slotTitle) =>
        JsonSerializer.Serialize(
            new { action = "click", slot = slotTitle ?? string.Empty },
            JsonOptions.Wire);

    /// <summary>Read the final payload off the selected rows.</summary>
    public static string Read() => """{"action":"read"}""";
}

/// <summary>Where the Coachless selection walk stands.</summary>
public enum SequencerPhase
{
    /// <summary>Opening step: discover the slot sections in DOM order.</summary>
    Discover,
    /// <summary>Click the current slot's top-WPA row (read-only slots are skipped, never entered).</summary>
    Click,
    /// <summary>Poll until the clicked slot shows a selection and the recompute settles.</summary>
    Settle,
    /// <summary>All clickable slots walked: take the final read.</summary>
    Read,
    /// <summary>Terminal: the final payload is in hand.</summary>
    Succeeded,
    /// <summary>Terminal: typed reason, nothing written.</summary>
    Failed,
}

/// <summary>
/// One slot of the walk plan, frozen at discovery: the page's own header
/// text plus whether its top row was <c>selectable</c> when first seen. The
/// snapshot is deliberately NOT refreshed from later settle polls: on the
/// live site selectability only ever narrows as conditioning deepens, so the
/// opening view is the maximal clickable set, and a slot that lost
/// selectability mid-walk is still safe — the click script refuses a
/// non-selectable top row with a <c>read-only</c> stage the driver skips
/// without waiting.
/// </summary>
public sealed record CoachlessSlotPlan(string Title, bool Selectable);

/// <summary>The walk's immutable cursor. Every transition returns a new one.</summary>
public sealed record SequencerState(
    SequencerPhase Phase,
    IReadOnlyList<CoachlessSlotPlan> Slots,
    int Position,
    string? LastHash,
    int StablePolls,
    int SettlePolls,
    int Steps,
    string? PayloadJson,
    string? Failure,
    IReadOnlyList<string> Notes);

/// <summary>What the driver must do next: run a step script, or finish.</summary>
public abstract record SequencerCommand;

/// <summary>Run the inspect step (discovery, or one settle poll).</summary>
public sealed record InspectCommand : SequencerCommand;

/// <summary>Run the click step against the named slot section.</summary>
public sealed record ClickSlotCommand(string Title) : SequencerCommand;

/// <summary>Run the final read step.</summary>
public sealed record ReadFinalCommand : SequencerCommand;

/// <summary>Terminal: hand the payload JSON to the import host.</summary>
public sealed record SucceedCommand(string PayloadJson) : SequencerCommand;

/// <summary>Terminal: report the typed reason; nothing was imported.</summary>
public sealed record FailCommand(string Reason) : SequencerCommand;

/// <summary>
/// The pure driver for the Coachless select-and-recompute walk: no clock,
/// no browser, no I/O. The window feeds it parsed step responses and
/// executes the returned commands (with a <see cref="SettlePollDelayMs"/>
/// pause before each settle poll); every transition is unit-tested with
/// scripted fakes.
///
/// <para>SELECTABLE-GATING (live-verified 2026-09-08): the site grants the
/// <c>selectable</c> class only to a capped depth — clicking a read-only
/// slot's top row never activates anything, so the walk never clicks one.
/// ITEM-SLOTS-ONLY (live-verified 2026-09-08): the walk starts at
/// <c>1st Item</c> and clicks subsequent selectable item slots in DOM
/// order — Keystone, Starter and Spell are never clicked (see
/// <see cref="SiteImportExtractors.IsWalkClickableSlot"/>), so discovery
/// positions past them and <see cref="Advance"/> skips them mid-walk,
/// exactly like read-only slots. Starter's conditioned top row is still
/// read, never clicked. A <c>read-only</c> click answer (the top row lost
/// its class between inspect and click) advances with no settle wait and
/// no note. A clicked slot that never shows <c>active</c> within the settle
/// budget does NOT fail the import: the walk notes it into the payload's
/// <c>meta.notes</c> and moves on, and the final read takes the top row of
/// any slot left unselected. The only absolute backstop is
/// <see cref="MaxSteps"/>.</para>
/// </summary>
public static class SiteImportSequencer
{
    /// <summary>
    /// Absolute bound on executed steps: defends against a page that keeps
    /// adding slot sections. Real walks cost 1 discover + 1 click + ~2
    /// polls per CLICKABLE slot + 1 read (about 8 for the Jhin ADC shape:
    /// 1st + 2nd Item clicked, everything else skipped outright), so this is
    /// headroom, not a budget a healthy page can hit.
    /// </summary>
    public const int MaxSteps = 128;

    /// <summary>
    /// Settle polls per clicked slot before the walk gives up waiting,
    /// notes the slot into the payload meta, and moves on. At
    /// <see cref="SettlePollDelayMs"/> this is a ~5s wait per slot — the
    /// same budget as before, but exhaustion now degrades (top-row
    /// fallback) instead of failing the import.
    /// </summary>
    public const int SettlePollCap = 20;

    /// <summary>
    /// Consecutive agreeing settle fingerprints that count as settled. A
    /// clicked slot advances only once the tables are stable AND its own
    /// table shows a selection.
    /// </summary>
    public const int SettleStablePolls = 2;

    /// <summary>Pause the driver waits before each settle poll.</summary>
    public const int SettlePollDelayMs = 250;

    /// <summary>Typed failure when the walk exceeds <see cref="MaxSteps"/>.</summary>
    public const string NoConvergenceFailure = "import did not converge";

    public static SequencerState Initial() =>
        new(SequencerPhase.Discover, [], 0, null, 0, 0, 0, null, null, []);

    public static SequencerCommand CommandFor(SequencerState state)
    {
        if (state.Phase == SequencerPhase.Failed)
            return new FailCommand(state.Failure ?? NoConvergenceFailure);
        if (state.Phase == SequencerPhase.Succeeded)
            return string.IsNullOrEmpty(state.PayloadJson)
                ? new FailCommand(NoConvergenceFailure)
                : new SucceedCommand(state.PayloadJson);
        if (state.Steps >= MaxSteps)
            return new FailCommand(NoConvergenceFailure);
        return state.Phase switch
        {
            SequencerPhase.Discover => new InspectCommand(),
            SequencerPhase.Settle => new InspectCommand(),
            SequencerPhase.Click => state.Position >= 0 && state.Position < state.Slots.Count
                ? new ClickSlotCommand(state.Slots[state.Position].Title)
                : new FailCommand(NoConvergenceFailure),
            SequencerPhase.Read => new ReadFinalCommand(),
            _ => new FailCommand(NoConvergenceFailure),
        };
    }

    public static SequencerState Transition(SequencerState state, CoachlessStepResponse response)
    {
        ArgumentNullException.ThrowIfNull(state);
        ArgumentNullException.ThrowIfNull(response);
        if (state.Phase is SequencerPhase.Succeeded or SequencerPhase.Failed) return state;
        if (state.Steps >= MaxSteps) return Fail(state, NoConvergenceFailure);
        var advanced = state with { Steps = state.Steps + 1 };
        if (!string.IsNullOrWhiteSpace(response.Error))
            return Fail(advanced, MapStepError(response.Error));
        return state.Phase switch
        {
            SequencerPhase.Discover => TransitionDiscover(advanced, response),
            SequencerPhase.Click => TransitionClick(advanced, response),
            SequencerPhase.Settle => TransitionSettle(advanced, response),
            SequencerPhase.Read => TransitionRead(advanced, response),
            _ => Fail(advanced, Unexpected("start")),
        };
    }

    private static SequencerState TransitionDiscover(SequencerState state, CoachlessStepResponse response)
    {
        if (!string.Equals(response.Stage, "state", StringComparison.Ordinal)) return Fail(state, Unexpected("slot list"));
        var plans = response.Slots
            .Select(slot => new CoachlessSlotPlan(slot.Title, slot.TopSelectable))
            .ToList();
        if (plans.Count == 0) return Fail(state, SiteImportFailures.NoBuild);
        // Position at the first clickable item slot: a slot whose top row
        // was not selectable at discovery is never clicked and never waited
        // on, and neither are Keystone, Starter or Spell under any
        // selectability — the walk starts at 1st Item (see
        // SiteImportExtractors.IsWalkClickableSlot). When nothing is
        // clickable at all, go straight to the conditioned
        // top-row read rather than failing — the read still yields the page's
        // own recommendations.
        var first = FirstClickable(plans, 0);
        return first >= plans.Count
            ? state with { Phase = SequencerPhase.Read, Slots = plans }
            : state with { Phase = SequencerPhase.Click, Slots = plans, Position = first };
    }

    private static SequencerState TransitionClick(SequencerState state, CoachlessStepResponse response)
    {
        if (state.Position < 0 || state.Position >= state.Slots.Count)
            return Fail(state, NoConvergenceFailure);
        if (string.Equals(response.Stage, "already-selected", StringComparison.Ordinal))
            return Advance(state);
        if (string.Equals(response.Stage, "read-only", StringComparison.Ordinal))
            return Advance(state);
        if (!string.Equals(response.Stage, "clicked", StringComparison.Ordinal))
            return Fail(state, Unexpected("click confirmation"));
        if (!string.Equals(response.ClickedSlot, state.Slots[state.Position].Title, StringComparison.Ordinal))
            return Fail(state, "the page changed while importing");
        return state with
        {
            Phase = SequencerPhase.Settle,
            LastHash = null,
            StablePolls = 0,
            SettlePolls = 0,
        };
    }

    private static SequencerState TransitionSettle(SequencerState state, CoachlessStepResponse response)
    {
        if (!string.Equals(response.Stage, "state", StringComparison.Ordinal) ||
            string.IsNullOrEmpty(response.Hash))
            return Fail(state, Unexpected("settle poll"));
        if (state.Position < 0 || state.Position >= state.Slots.Count)
            return Fail(state, NoConvergenceFailure);
        var clickedTitle = state.Slots[state.Position].Title;
        var activated = response.Slots.Any(slot =>
            string.Equals(slot.Title, clickedTitle, StringComparison.Ordinal) && slot.HasActive);
        var stable = string.Equals(response.Hash, state.LastHash, StringComparison.Ordinal)
            ? state.StablePolls + 1
            : 1;
        var polls = state.SettlePolls + 1;
        if (stable >= SettleStablePolls && activated) return Advance(state);
        if (polls >= SettlePollCap)
        {
            // Degrade, never fail: note the slot into the payload meta and
            // move on. The final read falls back to the top row of any slot
            // left unselected, which by now holds the conditioned
            // recommendation. The note names the cause precisely — a table
            // that kept recomputing versus one that settled unselected.
            var note = stable >= SettleStablePolls
                ? $"slot \"{clickedTitle}\" never showed a selection -- the final read used its top row"
                : $"slot \"{clickedTitle}\" never settled -- the final read used its top row";
            return Advance(state with { Notes = [.. state.Notes, note] });
        }
        return state with { LastHash = response.Hash, StablePolls = stable, SettlePolls = polls };
    }

    private static SequencerState TransitionRead(SequencerState state, CoachlessStepResponse response)
    {
        if (!string.Equals(response.Stage, "done", StringComparison.Ordinal))
            return Fail(state, Unexpected("final read"));
        if (string.IsNullOrWhiteSpace(response.PayloadJson))
            return Fail(state, "the final read returned no payload");
        var payload = state.Notes.Count == 0
            ? response.PayloadJson
            : WithNotes(response.PayloadJson, state.Notes);
        if (string.IsNullOrWhiteSpace(payload))
            return Fail(state, "the final read returned no payload");
        return state with { Phase = SequencerPhase.Succeeded, PayloadJson = payload };
    }

    private static SequencerState Advance(SequencerState state)
    {
        var next = FirstClickable(state.Slots, state.Position + 1);
        return next >= state.Slots.Count
            ? state with { Phase = SequencerPhase.Read, LastHash = null, StablePolls = 0, SettlePolls = 0 }
            : state with { Phase = SequencerPhase.Click, Position = next };
    }

    /// <summary>
    /// Index of the next slot the walk may click at or after
    /// <paramref name="start"/>: selectable AND an item slot at/after 1st
    /// Item. Keystone, Starter and Spell never qualify (the walk starts at
    /// 1st Item — live-verified 2026-09-08), and neither does a slot whose
    /// top row lacks <c>selectable</c>.
    /// </summary>
    private static int FirstClickable(IReadOnlyList<CoachlessSlotPlan> plans, int start)
    {
        var index = start;
        while (index < plans.Count &&
            (!plans[index].Selectable || !SiteImportExtractors.IsWalkClickableSlot(plans[index].Title)))
            index++;
        return index;
    }

    /// <summary>
    /// Merges walk notes into the final payload's <c>meta.notes</c> (kept
    /// beside the extractor payload, never inside the item blocks, so the
    /// <see cref="SiteImportPayload"/> parser — which ignores unknown
    /// fields — reads the build exactly as before). Returns null when the
    /// payload is not a JSON object.
    /// </summary>
    private static string? WithNotes(string payloadJson, IReadOnlyList<string> notes)
    {
        JsonNode? node;
        try
        {
            node = JsonNode.Parse(payloadJson);
        }
        catch (JsonException)
        {
            return null;
        }
        if (node is not JsonObject payload) return null;
        var merged = new JsonArray();
        var existing = payload["meta"] as JsonObject;
        if (existing?["notes"] is JsonArray prior)
        {
            foreach (var entry in prior)
            {
                if (entry?.GetValue<string>() is { } text) merged.Add(text);
            }
        }
        foreach (var note in notes) merged.Add(note);
        var meta = new JsonObject();
        if (existing is not null)
        {
            foreach (var property in existing)
            {
                if (!string.Equals(property.Key, "notes", StringComparison.Ordinal) &&
                    property.Value is not null)
                    meta[property.Key] = property.Value.DeepClone();
            }
        }
        meta["notes"] = merged;
        payload["meta"] = meta;
        return payload.ToJsonString(JsonOptions.Wire);
    }

    private static SequencerState Fail(SequencerState state, string reason) =>
        state with { Phase = SequencerPhase.Failed, Failure = reason };

    private static string Unexpected(string expected) =>
        // The window appends "-- nothing was imported" to every failure it
        // reports, so reasons here never carry the suffix themselves.
        $"the page answered with no {expected}";

    private static string MapStepError(string error)
    {
        var normalized = error.Trim().ToLowerInvariant();
        if (normalized.Contains("no build", StringComparison.Ordinal))
            return SiteImportFailures.NoBuild;
        if (normalized.Contains("not a champion builds page", StringComparison.Ordinal))
            return SiteImportFailures.NotRecognized;
        return error.Trim();
    }
}
