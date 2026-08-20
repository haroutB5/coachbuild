using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Which shop set the situational numbers belong to, read out of the very
/// payload that wrote it.
///
/// <para><b>Why this exists.</b> The badges are positioned from a saved
/// calibration and mapped to items POSITIONALLY — badge <c>i</c> sits on
/// whatever the shop draws in slot <c>i</c> of the row. That is exact for the
/// set CoachBuild writes, because <c>situationalWire</c> and
/// <c>situationalBlocks</c> are built from the same picks in the same order.
/// It is meaningless for any other set, and the League shop lets the player
/// pick any set they like from a dropdown.</para>
///
/// <para>On 2026-08-20 the player's shop was showing Riot's own <c>AP</c>
/// recommended set — <c>Starting Items / Core Build Order / Core Final Build /
/// Situational items that are also good / Boots Options</c>, seven items in
/// that last row — while the overlay drew three numbers describing three
/// completely different items. Nothing in the app, the log or the screen said
/// so. This type is what makes the next occurrence readable in one line.</para>
///
/// <para><b>It cannot detect the mistake, and does not pretend to.</b> There is
/// no LCU read that returns "which set is selected in the in-game shop": item
/// sets are written to the client before the game starts and the dropdown is
/// in-game UI state, and screen capture, OCR and memory reads are excluded by
/// the 1.0.16 policy. What this gives is the other half — a log line naming the
/// set the numbers were computed for, and an adjust-mode legend that tells the
/// player which set to select BEFORE they line anything up.</para>
/// </summary>
public sealed record SituationalBlockInfo(
    string SetTitle,
    int BlockOrdinal,
    int BlockCount,
    IReadOnlyList<int> ItemIds)
{
    public static SituationalBlockInfo Unknown { get; } =
        new(string.Empty, 0, 0, Array.Empty<int>());

    /// <summary>True when a <c>Situational</c> block was actually found.</summary>
    public bool Known => BlockOrdinal > 0;

    /// <summary>
    /// ONE rendering of this record, for the log line AND for the adjust-mode
    /// legend. Two formatters would be two answers to "which set is this",
    /// asked by the two people who most need the same answer — the player
    /// lining the row up, and whoever reads their log afterwards.
    ///
    /// <para><b>The block's POSITION is in here, not just the name</b>, and
    /// that is the round-4 addition. The shop stacks blocks vertically, so the
    /// Situational row's Y on screen is a function of how many blocks precede
    /// it: <c>block 3 of 3</c> and <c>block 4 of 5</c> put the same row a whole
    /// block-pitch apart, under one saved calibration. Two field reports that
    /// both say "the numbers are off" are indistinguishable without this, and
    /// with it they are one subtraction apart.</para>
    ///
    /// <para>Never a placeholder NAME when unknown: a wrong name is worse than
    /// no name for someone hunting a misaligned row.</para>
    /// </summary>
    public string Describe() => Known
        ? $"\"{SetTitle}\" — Situational is block {BlockOrdinal} of {BlockCount}"
            + $" ({ItemIds.Count} item{(ItemIds.Count == 1 ? "" : "s")})"
        : "an item set this payload did not identify";
}

public static class SituationalSetLocator
{
    /// <summary>
    /// The block label <c>itemSetBody.ts</c> writes (its
    /// <c>SITUATIONAL_BLOCK_TYPE</c>). Compared case-insensitively but
    /// otherwise exactly: Riot's own recommended sets use the much longer
    /// "Situational items that are also good", and treating that as a match
    /// would be asserting agreement with a row this app did not choose.
    /// </summary>
    public const string BlockType = "Situational";

    /// <summary>
    /// Finds the <c>Situational</c> block in the sets being written.
    ///
    /// <para>Every failure returns <see cref="SituationalBlockInfo.Unknown"/>.
    /// This runs beside a write that changes the player's League config and
    /// must never be able to affect it — same rule as
    /// <see cref="SituationalOverlayParser"/>.</para>
    /// </summary>
    public static SituationalBlockInfo Find(IReadOnlyList<JsonElement>? sets)
    {
        if (sets is null) return SituationalBlockInfo.Unknown;
        foreach (var set in sets)
        {
            if (set.ValueKind != JsonValueKind.Object) continue;
            if (!set.TryGetProperty("blocks", out var blocks) || blocks.ValueKind != JsonValueKind.Array) continue;

            var title = set.TryGetProperty("title", out var titleElement)
                && titleElement.ValueKind == JsonValueKind.String
                ? titleElement.GetString() ?? string.Empty
                : string.Empty;

            var ordinal = 0;
            var found = 0;
            IReadOnlyList<int> ids = Array.Empty<int>();
            foreach (var block in blocks.EnumerateArray())
            {
                ordinal++;
                if (block.ValueKind != JsonValueKind.Object) continue;
                if (!block.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) continue;
                if (!string.Equals(type.GetString(), BlockType, StringComparison.OrdinalIgnoreCase)) continue;
                found = ordinal;
                ids = ReadItemIds(block);
                break;
            }

            if (found == 0) continue;
            return new SituationalBlockInfo(title, found, CountBlocks(blocks), ids);
        }

        return SituationalBlockInfo.Unknown;
    }

    /// <summary>
    /// Whether the deltas describe the block, item for item, in order.
    ///
    /// <para>The web builds both from one list, so this holds by construction
    /// today — and that is exactly why it is worth pinning. A row of numbers
    /// whose ids do not match the row of icons it is drawn over is not a
    /// degraded feature, it is a confident lie about which item is worth
    /// buying, and the two are indistinguishable on screen.</para>
    ///
    /// <para><b>An UNKNOWN block agrees.</b> Returning false there would let a
    /// change in the set's wire shape silently delete the feature — the failure
    /// mode this whole handoff has been chasing since round 1. Unknown means
    /// "not checked", and the caller says so in the log rather than acting on
    /// it.</para>
    /// </summary>
    public static bool Agrees(
        SituationalBlockInfo block,
        IReadOnlyList<SituationalDelta> deltas,
        out string disagreement)
    {
        disagreement = string.Empty;
        if (!block.Known) return true;

        if (block.ItemIds.Count != deltas.Count)
        {
            disagreement =
                $"the Situational block has {block.ItemIds.Count} item(s) but {deltas.Count} number(s) arrived";
            return false;
        }

        for (var index = 0; index < deltas.Count; index++)
        {
            // 0 is "this slot's id could not be read" (see ReadItemIds). The
            // POSITION still counts — dropping it would invent a count mismatch
            // out of a parse problem — but its identity is unchecked, and an
            // unchecked position must not be reported as a contradiction.
            if (block.ItemIds[index] == 0) continue;
            if (block.ItemIds[index] == deltas[index].ItemId) continue;
            disagreement =
                $"position {index + 1} is item {block.ItemIds[index]} in the shop block "
                + $"but number \"{deltas[index].Text}\" is for item {deltas[index].ItemId}";
            return false;
        }

        return true;
    }

    private static int CountBlocks(JsonElement blocks)
    {
        var count = 0;
        foreach (var _ in blocks.EnumerateArray()) count++;
        return count;
    }

    /// <summary>
    /// Item ids inside a block. They are STRINGS on the LCU item-set wire (rune
    /// perk ids are numbers — a different id space; see
    /// <c>itemSetBody.ts</c>'s header), so a number here is accepted too rather
    /// than assumed away.
    /// </summary>
    private static IReadOnlyList<int> ReadItemIds(JsonElement block)
    {
        if (!block.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array)
            return Array.Empty<int>();

        var ids = new List<int>();
        foreach (var item in items.EnumerateArray())
        {
            // EVERY entry costs a position, readable or not. These two used to
            // `continue`, which SHORTENED the list — the precise thing the
            // `default:` branch below exists to prevent, undone two lines
            // above it. A row of six items with one unreadable entry then
            // reported five, `Agrees` saw "5 items but 6 numbers arrived", and
            // the whole row of numbers was suppressed as a contradiction that
            // never existed. Caught by
            // `An_unreadable_id_holds_its_POSITION_instead_of_shortening_the_row`.
            if (item.ValueKind != JsonValueKind.Object) { ids.Add(0); continue; }
            if (!item.TryGetProperty("id", out var id)) { ids.Add(0); continue; }
            switch (id.ValueKind)
            {
                case JsonValueKind.String when int.TryParse(
                    id.GetString(),
                    System.Globalization.NumberStyles.Integer,
                    System.Globalization.CultureInfo.InvariantCulture,
                    out var parsed):
                    ids.Add(parsed);
                    break;
                case JsonValueKind.Number when id.TryGetInt32(out var numeric):
                    ids.Add(numeric);
                    break;
                default:
                    // An unreadable id must not SHORTEN the list — that would
                    // turn a parse problem into a phantom count mismatch and
                    // suppress the numbers for the wrong reason. 0 marks the
                    // position as present but unchecked; Agrees skips it.
                    ids.Add(0);
                    break;
            }
        }

        return ids;
    }
}
