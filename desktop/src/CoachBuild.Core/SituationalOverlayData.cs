using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// One situational swap and the win-rate delta the Builds page printed next to
/// it.
/// </summary>
/// <param name="Text">
/// The delta AS THE WEB FORMATTED IT (<c>+4.27</c>, <c>-0.06</c>), rendered
/// verbatim and never re-derived here. The page formats with its own
/// <c>wpaText</c>; a second formatter on this side is how the shop and the page
/// end up disagreeing at a rounding boundary while both look right in
/// isolation. <see cref="Wpa"/> is carried only so the sign can pick a colour.
/// </param>
public readonly record struct SituationalDelta(int ItemId, double Wpa, string Text);

/// <summary>
/// The situational row for ONE champion, as last written to the shop.
///
/// <para>Champion-scoped on purpose. The item set is written during champ
/// select and the numbers are drawn during the game, so the data has to survive
/// a phase change — and anything that survives a phase change can outlive the
/// champion it belongs to. Rendering is gated on the id MATCHING, never on the
/// data merely being present.</para>
/// </summary>
/// <param name="SetLabel">
/// The shop set these numbers were computed for AND the position of the
/// Situational block inside it, already rendered for a human by
/// <see cref="SituationalBlockInfo.Describe"/> —
/// <c>"CoachBuild Syndra Mid" — Situational is block 3 of 3 (6 items)</c>.
/// Empty when this set carries no deltas for the champion being asked about.
///
/// <para>Carried because the badges are mapped POSITIONALLY and are therefore
/// only true of that one set, drawn at one saved calibration that is only true
/// of that set's SHAPE. The app cannot see which set the player has selected in
/// the shop — see <see cref="SituationalSetLocator"/> — so saying which one it
/// meant, and where in it the row sits, is the whole of what it CAN do: in the
/// log, and in adjust mode before the player lines anything up.</para>
/// </param>
public sealed record SituationalOverlaySet(
    int ChampionId,
    IReadOnlyList<SituationalDelta> Deltas,
    DateTimeOffset At,
    string SetLabel)
{
    public bool Any => Deltas.Count > 0;

    /// <summary>The deltas for <paramref name="championId"/>, or null for any other champion.</summary>
    public IReadOnlyList<SituationalDelta>? For(int championId) =>
        championId > 0 && championId == ChampionId && Deltas.Count > 0 ? Deltas : null;
}

/// <summary>
/// Turns the optional <c>situational</c> field of a <c>/apply-itemsets</c> body
/// into something drawable.
///
/// <para><b>This can never fail an apply.</b> The field is decoration on a
/// write that changes the player's League config; a malformed number must cost
/// the player some numbers on screen, never their item set. Every rejection
/// path returns fewer deltas and a reason string for the log, and
/// <see cref="ApplyPayloadValidation.TryValidateItemSets"/> is not consulted
/// and not extended. The field is read as a raw <see cref="JsonElement"/> for
/// the same reason: a typed model would throw on <c>"wpa": null</c> inside
/// <c>JsonSerializer.Deserialize</c>, which turns the entire request into
/// <c>default</c> and fails the write.</para>
/// </summary>
public static class SituationalOverlayParser
{
    /// <summary>
    /// The web caps its situational shortlist at 6 (<c>SITUATIONAL_DISPLAY_LIMIT</c>).
    /// This is the independent bound on the drawing side: badges are positioned
    /// from a calibrated pitch, so an unbounded list walks off the monitor.
    /// </summary>
    public const int MaxDeltas = 6;

    /// <summary>
    /// Longest delta string that will be drawn. <c>wpaText</c> produces at most
    /// <c>+99.99</c>; the bound exists so a buggy or hostile payload cannot
    /// paint a paragraph over the game.
    /// </summary>
    public const int MaxTextLength = 8;

    /// <summary>Item ids at or above this are the ARAM/Arena twins of a Summoner's Rift item.</summary>
    public const int MaxItemId = 10000;

    /// <param name="block">
    /// The <c>Situational</c> block these numbers annotate, from the same
    /// payload. REQUIRED and positional, following round 3's argument for
    /// <c>chatGateEnabled</c> and the layout hook verbatim: an optional
    /// trailing argument that production fills in and fixtures leave empty is
    /// how the shipped configuration ends up with no coverage while every suite
    /// stays green. Pass <see cref="SituationalBlockInfo.Unknown"/> to mean
    /// "not checked" — and mean it.
    /// </param>
    public static SituationalOverlaySet Parse(
        int championId,
        JsonElement? situational,
        DateTimeOffset at,
        SituationalBlockInfo block,
        out IReadOnlyList<string> rejections)
    {
        var rejected = new List<string>();
        rejections = rejected;
        block ??= SituationalBlockInfo.Unknown;
        // An EMPTY label on an empty set, always. The label's whole job is to
        // say which set the numbers ON SCREEN belong to; a set with no numbers
        // on screen has nothing to claim, and a label left on one is a name the
        // adjust-mode legend would print beside a row it is not describing.
        var empty = new SituationalOverlaySet(
            championId, Array.Empty<SituationalDelta>(), at, string.Empty);

        if (championId <= 0)
        {
            rejected.Add($"championId {championId} is not a champion");
            return empty;
        }

        if (situational is not { } element) return empty;
        if (element.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return empty;
        if (element.ValueKind != JsonValueKind.Array)
        {
            rejected.Add($"situational is {element.ValueKind}, not an array");
            return empty;
        }

        var deltas = new List<SituationalDelta>();
        var index = -1;
        foreach (var entry in element.EnumerateArray())
        {
            index++;
            if (deltas.Count >= MaxDeltas)
            {
                rejected.Add($"more than {MaxDeltas} entries; the rest were dropped");
                break;
            }

            if (!TryReadDelta(entry, out var delta, out var why))
            {
                rejected.Add($"entry {index}: {why}");
                continue;
            }

            deltas.Add(delta);
        }

        if (!SituationalSetLocator.Agrees(block, deltas, out var disagreement))
        {
            // NOT a degraded row: numbers whose ids do not match the icons they
            // will be drawn over are a confident claim about the wrong items,
            // and on screen that is indistinguishable from a correct one. The
            // apply itself is already done and is untouched.
            rejected.Add($"the numbers do not describe the Situational block that was written ({disagreement}); none will be drawn");
            return empty;
        }

        // KNOWN only. `Describe()` renders an unknown block as prose ("an item
        // set this payload did not identify"), which is the right thing for the
        // log and the wrong thing for the adjust-mode legend: that legend
        // follows the label with "select that set in the shop's dropdown", and
        // there is no such set to select. An empty label makes the legend say
        // nothing rather than send the player looking for a name.
        return new SituationalOverlaySet(
            championId, deltas, at, block.Known ? block.Describe() : string.Empty);
    }

    private static bool TryReadDelta(JsonElement entry, out SituationalDelta delta, out string why)
    {
        delta = default;
        if (entry.ValueKind != JsonValueKind.Object) { why = $"is {entry.ValueKind}, not an object"; return false; }

        if (!entry.TryGetProperty("id", out var idElement)
            || idElement.ValueKind != JsonValueKind.Number
            || !idElement.TryGetInt32(out var id))
        {
            why = "has no numeric id";
            return false;
        }

        if (id <= 0 || id >= MaxItemId)
        {
            // Same bound the web's own export harness asserts. An id at or above
            // it is an ARAM or Arena twin of a Summoner's Rift item and cannot
            // be what the shop is showing.
            why = $"item id {id} is outside 1..{MaxItemId - 1}";
            return false;
        }

        var wpa = 0d;
        if (entry.TryGetProperty("wpa", out var wpaElement))
        {
            if (wpaElement.ValueKind != JsonValueKind.Number || !wpaElement.TryGetDouble(out wpa) || !double.IsFinite(wpa))
            {
                why = "wpa is not a finite number";
                return false;
            }
        }

        if (!entry.TryGetProperty("text", out var textElement) || textElement.ValueKind != JsonValueKind.String)
        {
            why = "has no text";
            return false;
        }

        var text = textElement.GetString()?.Trim();
        if (string.IsNullOrEmpty(text))
        {
            // An absent delta renders NOTHING. It never renders "+0.00" — a
            // placeholder is a claim about data nobody measured.
            why = "text is blank";
            return false;
        }

        if (text.Length > MaxTextLength)
        {
            why = $"text \"{text}\" is longer than {MaxTextLength} characters";
            return false;
        }

        delta = new SituationalDelta(id, wpa, text);
        why = string.Empty;
        return true;
    }
}
