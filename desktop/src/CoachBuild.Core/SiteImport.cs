using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>Which third-party build page a scraped import payload came from.</summary>
public enum SiteImportSource
{
    UGg,
    Coachless,
}

/// <summary>
/// A rune page scraped from a site build page: the keystone, the 3 primary
/// minors and the 2 secondaries (<see cref="PerkIds"/>, document order), then
/// the 3 stat shards in client Offense/Flex/Defense order
/// (<see cref="ShardIds"/>).
/// </summary>
public sealed record SiteImportRunes(
    int PrimaryStyleId,
    int SubStyleId,
    IReadOnlyList<int> PerkIds,
    IReadOnlyList<int> ShardIds);

/// <summary>One item block scraped from a site build page.</summary>
public sealed record SiteImportItemBlock(string Title, IReadOnlyList<int> ItemIds);

/// <summary>
/// The typed result of the user-initiated site scrape: exactly the JSON the
/// per-site extractor returns from its single <c>ExecuteScriptAsync</c>.
/// </summary>
public sealed record SiteImportPayload(
    SiteImportSource Source,
    string ChampionSlug,
    string Role,
    SiteImportRunes Runes,
    IReadOnlyList<SiteImportItemBlock> ItemBlocks)
{
    /// <summary>
    /// Parses the extractor's JSON. The raw value is what
    /// <c>ExecuteScriptAsync</c> resolves to: our extractors
    /// <c>JSON.stringify</c> their result, so the raw value is usually a
    /// JSON-encoded STRING wrapping the object; a bare object is accepted
    /// too. Never throws: every defect is a typed failure string, because a
    /// failed scrape must report precisely and write nothing.
    /// </summary>
    public static bool TryParse(
        string? raw,
        out SiteImportPayload? payload,
        out string failure)
    {
        payload = null;
        failure = SiteImportFailures.NotRecognized;
        if (string.IsNullOrWhiteSpace(raw)) return false;

        JsonDocument? document = null;
        try
        {
            document = JsonDocument.Parse(raw);
            var root = document.RootElement;
            // ExecuteScriptAsync JSON-encodes a returned JS string, so the
            // outer value is typically "..." wrapping the extractor object.
            if (root.ValueKind == JsonValueKind.String)
            {
                var inner = root.GetString();
                document.Dispose();
                document = null;
                if (string.IsNullOrWhiteSpace(inner)) return false;
                document = JsonDocument.Parse(inner);
                root = document.RootElement;
            }
            if (root.ValueKind != JsonValueKind.Object) return false;

            if (ReadString(root, "error") is { } error && !string.IsNullOrWhiteSpace(error))
            {
                failure = NormalizeExtractorError(error);
                return false;
            }

            if (!TryReadSource(ReadString(root, "source"), out var source)) return false;
            var slug = ReadString(root, "championSlug")?.Trim() ?? string.Empty;
            var role = ReadString(root, "role")?.Trim() ?? string.Empty;
            if (string.IsNullOrEmpty(slug)) return false;

            SiteImportRunes? runes = null;
            if (root.TryGetProperty("runes", out var runesElement) &&
                runesElement.ValueKind == JsonValueKind.Object)
            {
                var perks = ReadInts(runesElement, "perkIds");
                var shards = ReadInts(runesElement, "shardIds");
                if (perks is not null && shards is not null)
                    runes = new SiteImportRunes(
                        ReadInt(runesElement, "primaryStyleId"),
                        ReadInt(runesElement, "subStyleId"),
                        perks,
                        shards);
            }

            var blocks = new List<SiteImportItemBlock>();
            if (root.TryGetProperty("itemBlocks", out var blocksElement) &&
                blocksElement.ValueKind == JsonValueKind.Array)
            {
                foreach (var block in blocksElement.EnumerateArray())
                {
                    if (block.ValueKind != JsonValueKind.Object) continue;
                    var title = ReadString(block, "title")?.Trim() ?? string.Empty;
                    var ids = ReadInts(block, "itemIds");
                    if (string.IsNullOrEmpty(title) || ids is null) continue;
                    blocks.Add(new SiteImportItemBlock(title, ids));
                }
            }

            if (runes is null && blocks.Count == 0)
            {
                failure = SiteImportFailures.NoBuild;
                return false;
            }

            payload = new SiteImportPayload(source, slug, role, runes!, blocks);
            failure = string.Empty;
            return true;
        }
        catch (JsonException)
        {
            payload = null;
            failure = SiteImportFailures.NotRecognized;
            return false;
        }
        finally
        {
            document?.Dispose();
        }
    }

    private static string NormalizeExtractorError(string error)
    {
        var normalized = error.Trim().ToLowerInvariant();
        return normalized.Contains("no build", StringComparison.Ordinal)
            ? SiteImportFailures.NoBuild
            : SiteImportFailures.NotRecognized;
    }

    private static bool TryReadSource(string? value, out SiteImportSource source)
    {
        source = SiteImportSource.UGg;
        if (string.IsNullOrWhiteSpace(value)) return false;
        var normalized = value.Trim().ToLowerInvariant();
        if (normalized is "ugg" or "u.gg")
        {
            source = SiteImportSource.UGg;
            return true;
        }
        if (normalized is "coachless" or "coachless.gg")
        {
            source = SiteImportSource.Coachless;
            return true;
        }
        return false;
    }

    private static string? ReadString(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int ReadInt(JsonElement element, string property) =>
        element.TryGetProperty(property, out var value) && value.TryGetInt32(out var result) ? result : 0;

    private static IReadOnlyList<int>? ReadInts(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var array) || array.ValueKind != JsonValueKind.Array)
            return null;
        var result = new List<int>();
        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Number && item.TryGetInt32(out var id)) result.Add(id);
            else if (item.ValueKind == JsonValueKind.String &&
                int.TryParse(item.GetString(), out var parsed)) result.Add(parsed);
            else return null;
        }
        return result;
    }
}

/// <summary>Typed scrape failures. Never a silent empty import.</summary>
public static class SiteImportFailures
{
    public const string NotRecognized = "site page not recognized";
    public const string NoBuild = "no build on page";
}

/// <summary>
/// The rune tree SLOT STRUCTURE (which perk id lives in which keystone/minor
/// row of which tree), ported verbatim from the web's
/// <c>components/hextech/perkSlots.ts</c> so the import validates scraped ids
/// against the same map the apply path trusts — this is the "0.127.0
/// validator" the import reuses before writing.
///
/// <para>SOURCE for the slot rows: CommunityDragon perkstyles.json via the
/// web snapshot. SOURCE for the two corrections below it: ddragon
/// <c>runesReforged.json</c> 16.17.1, read live on 2026-09-08 — the web
/// snapshot has drifted in exactly two places since, and the import must
/// follow the client, not the snapshot: (1) Sorcery carries a FOURTH
/// keystone, 8992 Deathfire Touch, which the web map does not know, so a
/// page running it would be wrongly rejected; (2) Domination's second minor
/// row was renamed (Sixth Sense / Grisly Mementos / Deep Ward — same ids
/// 8137/8140/8141, so validation by id is unaffected, noted only so the next
/// reader does not "fix" the names back).</para>
/// </summary>
public static class PerkTreeCatalog
{
    public sealed record TreeSlots(
        IReadOnlyList<int> Keystones,
        IReadOnlyList<int> MinorRow0,
        IReadOnlyList<int> MinorRow1,
        IReadOnlyList<int> MinorRow2);

    public static readonly IReadOnlyDictionary<int, TreeSlots> Trees =
        new Dictionary<int, TreeSlots>
        {
            [8000] = new([8005, 8008, 8021, 8010], [9101, 9111, 8009], [9104, 9105, 9103], [8014, 8017, 8299]),
            [8100] = new([8112, 8128, 9923], [8126, 8139, 8143], [8137, 8140, 8141], [8135, 8105, 8106]),
            [8200] = new([8214, 8229, 8230, 8992], [8224, 8226, 8275], [8210, 8234, 8233], [8237, 8232, 8236]),
            [8300] = new([8351, 8360, 8369], [8306, 8304, 8321], [8313, 8352, 8345], [8347, 8410, 8316]),
            [8400] = new([8437, 8439, 8465], [8446, 8463, 8401], [8429, 8444, 8473], [8451, 8453, 8242]),
        };

    /// <summary>
    /// The current stat-mod slots in client Offense/Flex/Defense order.
    /// Ported from the web's <c>SHARD_ROWS</c> as corrected by 0.127.0.
    /// </summary>
    public static readonly IReadOnlyList<IReadOnlyList<int>> ShardRows =
    [
        [5008, 5005, 5007],
        [5008, 5010, 5001],
        [5011, 5013, 5001],
    ];

    public static bool IsKeystoneOf(int treeId, int runeId) =>
        Trees.TryGetValue(treeId, out var tree) && tree.Keystones.Contains(runeId);

    public static int? MinorRow(int treeId, int runeId)
    {
        if (!Trees.TryGetValue(treeId, out var tree)) return null;
        if (tree.MinorRow0.Contains(runeId)) return 0;
        if (tree.MinorRow1.Contains(runeId)) return 1;
        if (tree.MinorRow2.Contains(runeId)) return 2;
        return null;
    }

    /// <summary>
    /// The whole-page check the web's <c>buildRuneApplyBody</c> performs
    /// (0.127.0): same-tree primary/secondary, keystone belonging to the
    /// primary tree, minors in row order, two secondaries from two different
    /// rows, shard ids valid for their shard row. Returns null when the page
    /// may be written, else the precise reason it may not.
    /// </summary>
    public static string? ValidatePage(
        int primaryStyleId,
        int subStyleId,
        IReadOnlyList<int>? perkIds,
        IReadOnlyList<int>? shardIds)
    {
        if (perkIds is null || perkIds.Count != 6 || shardIds is null || shardIds.Count != 3)
            return "the scraped rune page is incomplete (need 6 runes + 3 shards)";
        if (perkIds.Any(id => id <= 0) || shardIds.Any(id => id <= 0))
            return "the scraped rune page carries an empty rune slot";
        if (!Trees.ContainsKey(primaryStyleId) || !Trees.ContainsKey(subStyleId))
            return "the scraped rune page names an unknown rune tree";
        if (primaryStyleId == subStyleId)
            return "the scraped rune page uses one tree for primary and secondary";
        if (!IsKeystoneOf(primaryStyleId, perkIds[0]))
            return "the scraped keystone does not belong to the primary tree";
        for (var index = 0; index < 3; index++)
        {
            if (MinorRow(primaryStyleId, perkIds[1 + index]) != index)
                return "the scraped primary runes are not one per row";
        }
        var secondaryRows = new[] { MinorRow(subStyleId, perkIds[4]), MinorRow(subStyleId, perkIds[5]) };
        if (secondaryRows[0] is null || secondaryRows[1] is null)
            return "a scraped secondary rune does not belong to the secondary tree";
        if (secondaryRows[0] == secondaryRows[1])
            return "the scraped secondary runes share one row";
        for (var index = 0; index < 3; index++)
        {
            if (!ShardRows[index].Contains(shardIds[index]))
                return "a scraped shard does not belong to its shard row";
        }
        return null;
    }
}

/// <summary>
/// ddragon-derived perk identity table (runesReforged.json 16.17.1, read
/// 2026-09-08): normalized icon filename, rune key and display name, each
/// pointing at the numeric perk id. The extractor JS needs this because perk
/// ids surface on site pages inside CDN image URLs
/// (<c>perk-images/Styles/.../Electrocute.png</c>) whose filenames do NOT
/// reliably equal the rune key (<c>GreenTerror_TasteOfBlood.png</c>,
/// <c>VeteranAftershock.png</c>, <c>MirrorShell.png</c>, <c>6361.png</c>,
/// <c>AlchemistCabinet.png</c>, <c>CashBack2.png</c>).
///
/// <para>Normalization (shared with the JS side, which receives this table as
/// JSON): lowercase, keep ASCII letters and digits only. Every entry below
/// was verified pairwise-unique under that fold at authoring time, and a test
/// pins the count plus the treacherous aliases
/// (<c>triumph</c>, <c>6361</c>, <c>tripletonic</c>/<c>perfecttiming</c>,
/// <c>axiomarcanist</c>/<c>nullifyingorb</c>,
/// <c>stormraiderssurge</c>/<c>phaserush</c>).</para>
/// </summary>
public static class PerkIconMap
{
    public static readonly IReadOnlyDictionary<string, int> ByName =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["electrocute"] = 8112, ["darkharvest"] = 8128, ["hailofblades"] = 9923,
            ["cheapshot"] = 8126, ["tasteofblood"] = 8139, ["greenterrortasteofblood"] = 8139,
            ["suddenimpact"] = 8143, ["sixthsense"] = 8137, ["grislymementos"] = 8140,
            ["deepward"] = 8141, ["treasurehunter"] = 8135, ["relentlesshunter"] = 8105,
            ["ultimatehunter"] = 8106,
            ["presstheattack"] = 8005, ["lethaltempo"] = 8008, ["lethaltempotemp"] = 8008,
            ["fleetfootwork"] = 8021, ["conqueror"] = 8010,
            ["absorblife"] = 9101, ["triumph"] = 9111, ["presenceofmind"] = 8009,
            ["legendalacrity"] = 9104, ["legendhaste"] = 9105, ["legendbloodline"] = 9103,
            ["coupdegrace"] = 8014, ["cutdown"] = 8017, ["laststand"] = 8299,
            ["summonaery"] = 8214, ["arcanecomet"] = 8229, ["phaserush"] = 8230,
            ["stormraiderssurge"] = 8230, ["stormraiderssurgeruneicon2"] = 8230,
            ["deathfiretouch"] = 8992, ["deathfiretouchkeystone"] = 8992,
            ["nullifyingorb"] = 8224, ["axiomarcanist"] = 8224,
            ["manaflowband"] = 8226, ["nimbuscloak"] = 8275, ["6361"] = 8275,
            ["transcendence"] = 8210, ["celerity"] = 8234, ["absolutefocus"] = 8233,
            ["scorch"] = 8237, ["waterwalking"] = 8232, ["gatheringstorm"] = 8236,
            ["glacialaugment"] = 8351, ["unsealedspellbook"] = 8360, ["firststrike"] = 8369,
            ["hextechflashtraption"] = 8306, ["hexflash"] = 8306,
            ["magicalfootwear"] = 8304, ["cashback"] = 8321, ["cashback2"] = 8321,
            ["perfecttiming"] = 8313, ["tripletonic"] = 8313, ["alchemistcabinet"] = 8313,
            ["timewarptonic"] = 8352, ["biscuitdelivery"] = 8345,
            ["cosmicinsight"] = 8347, ["approachvelocity"] = 8410,
            ["jackofalltrades"] = 8316, ["jackofalltrades2"] = 8316,
            ["graspoftheundying"] = 8437, ["aftershock"] = 8439, ["veteranaftershock"] = 8439,
            ["guardian"] = 8465, ["demolish"] = 8446, ["fontoflife"] = 8463,
            ["shieldbash"] = 8401, ["mirrorshell"] = 8401,
            ["conditioning"] = 8429, ["secondwind"] = 8444, ["boneplating"] = 8473,
            ["overgrowth"] = 8451, ["revitalize"] = 8453, ["unflinching"] = 8242,
        };

    /// <summary>Normalizes a filename, key or display name the way the table keys are folded.</summary>
    public static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return new string(value.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
    }

    public static bool TryResolve(string? value, out int perkId)
    {
        perkId = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        // Image URLs arrive whole
        // (https://.../perk-images/Styles/Domination/Electrocute/Electrocute.png),
        // so reduce to the bare filename stem before folding: the table keys
        // are stems, keys and display names only.
        var stem = value.Trim();
        var slash = Math.Max(stem.LastIndexOf('/'), stem.LastIndexOf('\\'));
        if (slash >= 0) stem = stem[(slash + 1)..];
        var dot = stem.LastIndexOf('.');
        if (dot > 0) stem = stem[..dot];
        return ByName.TryGetValue(Normalize(stem), out perkId)
            || ByName.TryGetValue(Normalize(value), out perkId);
    }

    public static string ToJson() =>
        JsonSerializer.Serialize(ByName, JsonOptions.Wire);
}

/// <summary>
/// ddragon-derived stat-shard identity table. The extractor JS needs this
/// because shard ids surface on site pages inside CDN image URLs
/// (<c>perk-images/StatMods/StatModsAdaptiveForceIcon.webp</c>) whose
/// filenames are display names, not ids.
///
/// <para>PROVENANCE, entry by entry, from the 2026-09-08 fixtures (not from
/// memory): the u.gg Jhin ADC page renders its three shard rows in
/// Offense/Flex/Defense order with
/// [AdaptiveForce, AttackSpeed, CDRScaling],
/// [AdaptiveForce, MovementSpeed, HealthPlus] and
/// {HealthScaling(active), HealthPlus, Tenacity}, while its embedded
/// <c>world_emerald_plus_adc</c> build object — triple-matched to the
/// displayed build by header winrate/matches, rune set and shard set —
/// reports <c>active_shards: [5008,5008,5011]</c>. Positional reads give
/// 5008/5005/5007 and 5008/5010/5001; the active-shard read gives
/// HealthScaling = 5011 (u.gg's own alt text agrees: "The Health Shard",
/// the client's name for flat health), leaving Tenacity = 5013 by
/// elimination. Armor (5002) and MagicRes (5003) never appear in the
/// fixtures — the current client no longer offers them — and are carried
/// only as ddragon-canonical aliases so an older page shape resolves
/// instead of erroring; the shard-row check still rejects them.</para>
/// </summary>
public static class ShardIconMap
{
    public static readonly IReadOnlyDictionary<string, int> ByName =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["adaptiveforce"] = 5008,
            ["attackspeed"] = 5005,
            ["cdrscaling"] = 5007,
            ["healthscaling"] = 5011,
            ["healthplus"] = 5001,
            ["movementspeed"] = 5010,
            ["tenacity"] = 5013,
            ["armor"] = 5002,
            ["magicres"] = 5003,
        };

    /// <summary>Normalizes a filename, key or display name the way the table keys are folded.</summary>
    public static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return new string(value.ToLowerInvariant().Where(char.IsLetterOrDigit).ToArray());
    }

    public static bool TryResolve(string? value, out int shardId)
    {
        shardId = 0;
        if (string.IsNullOrWhiteSpace(value)) return false;
        // Image URLs arrive whole
        // (.../perk-images/StatMods/StatModsAdaptiveForceIcon.webp),
        // so reduce to the bare filename stem before folding: the table keys
        // carry neither the shared StatMods prefix nor the Icon suffix every
        // ddragon statmod filename wears.
        var stem = value.Trim();
        var slash = Math.Max(stem.LastIndexOf('/'), stem.LastIndexOf('\\'));
        if (slash >= 0) stem = stem[(slash + 1)..];
        var dot = stem.LastIndexOf('.');
        if (dot > 0) stem = stem[..dot];
        var folded = Normalize(stem);
        const string prefix = "statmods";
        const string suffix = "icon";
        if (folded.StartsWith(prefix, StringComparison.Ordinal))
            folded = folded[prefix.Length..];
        if (folded.EndsWith(suffix, StringComparison.Ordinal))
            folded = folded[..^suffix.Length];
        return ByName.TryGetValue(folded, out shardId)
            || ByName.TryGetValue(Normalize(value), out shardId);
    }

    public static string ToJson() =>
        JsonSerializer.Serialize(ByName, JsonOptions.Wire);
}

/// <summary>
/// Pre-write validation for a scraped payload, plus the LCU request builders.
/// Validation runs ENTIRELY before the first LCU call: wrong or partial data
/// reports precisely and writes nothing — no partial rune page.
/// </summary>
public static class SiteImportValidator
{
    public const int MaxBlocks = 8;
    public const int MaxItemsPerBlock = 10;
    public const int MaxTotalItems = 40;

    public static string Label(SiteImportSource source) => source switch
    {
        SiteImportSource.UGg => "u.gg",
        SiteImportSource.Coachless => "Coachless",
        _ => "the site",
    };

    public static string RoleLabel(string? role) => role?.Trim().ToLowerInvariant() switch
    {
        "top" => "Top",
        "jungle" or "jg" or "jun" => "Jungle",
        "mid" or "middle" or "midlane" => "Mid",
        "adc" or "bottom" or "bot" or "carry" => "ADC",
        "support" or "sup" or "utility" => "Support",
        { Length: > 0 } raw => char.ToUpperInvariant(raw[0]) + raw[1..],
        _ => "Unknown",
    };

    /// <summary>
    /// The shared page title for both writes, e.g.
    /// <c>CoachBuild import: Jhin ADC (u.gg)</c>. CoachBuild-prefixed so both
    /// apply gates accept it, and exact-title reuse in
    /// <see cref="RuneApplyService"/> means a re-import edits the same page.
    /// </summary>
    public static string PageTitle(string championName, string? role, SiteImportSource source) =>
        $"CoachBuild import: {championName} {RoleLabel(role)} ({Label(source)})";

    public static string? ValidateRunes(SiteImportRunes? runes)
    {
        if (runes is null) return "the page yielded no rune build to import";
        return PerkTreeCatalog.ValidatePage(
            runes.PrimaryStyleId, runes.SubStyleId, runes.PerkIds, runes.ShardIds);
    }

    /// <summary>
    /// Structural item validation. There is deliberately NO id catalog here:
    /// the desktop ships none (the web resolves items through its own
    /// catalog), so this pins shape — non-empty blocks, positive ids,
    /// sane totals that keep the whole-object item-set PUT far from the
    /// LCU's 413 limit — and leaves unknown-id rejection to the client's
    /// own write response, which the applier surfaces verbatim.
    /// </summary>
    public static string? ValidateItems(IReadOnlyList<SiteImportItemBlock>? blocks)
    {
        if (blocks is null || blocks.Count == 0) return "the page yielded no item build to import";
        if (blocks.Count > MaxBlocks) return "the scraped item build has more sections than the client accepts";
        var total = 0;
        foreach (var block in blocks)
        {
            if (string.IsNullOrWhiteSpace(block.Title)) return "a scraped item section arrived without a title";
            if (block.ItemIds.Count == 0) return $"the scraped \"{block.Title}\" section has no items";
            if (block.ItemIds.Count > MaxItemsPerBlock)
                return $"the scraped \"{block.Title}\" section has more items than fit a build line";
            if (block.ItemIds.Any(id => id <= 0)) return $"the scraped \"{block.Title}\" section carries an empty item slot";
            total += block.ItemIds.Count;
        }
        if (total > MaxTotalItems) return "the scraped item build is larger than the client accepts";
        return null;
    }

    public static ApplyRunesRequest BuildRuneRequest(
        string pageTitle,
        SiteImportRunes runes)
    {
        var selected = runes.PerkIds.Concat(runes.ShardIds).ToArray();
        // Manual mode: the import is a real user click, which is the consent
        // the full-slot replacement path requires. replacePrefix stays null
        // on purpose — the import must never prune the user's other
        // CoachBuild pages as a side effect; exact-title reuse still applies.
        return new ApplyRunesRequest(pageTitle, runes.PrimaryStyleId, runes.SubStyleId, selected, true, "manual");
    }

    public static ApplyItemSetsRequest BuildItemSetRequest(
        int championId,
        string pageTitle,
        string championSlug,
        string? role,
        IReadOnlyList<SiteImportItemBlock> blocks)
    {
        var slug = ChampionNameKey.Normalize(championSlug);
        var roleToken = (role ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(roleToken)) roleToken = "all";
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(
            new
            {
                uid = $"coachbuild-import-{slug}-{roleToken}",
                title = pageTitle,
                type = "custom",
                map = "any",
                mode = "any",
                associatedMaps = Array.Empty<object>(),
                associatedChampions = new[] { championId },
                preferredItemSlots = Array.Empty<object>(),
                sortrank = 0,
                blocks = blocks.Select(block => new
                {
                    type = block.Title,
                    // Item ids are STRINGS in item sets (unlike LCU rune perk
                    // ids, which are ints) — same contract itemSetBody.ts notes.
                    items = block.ItemIds.Select(id => new { id = id.ToString(), count = 1 }).ToArray(),
                }).ToArray(),
            },
            JsonOptions.Wire));
        return new ApplyItemSetsRequest(championId, [document.RootElement.Clone()]);
    }
}

/// <summary>Outcome of a user-initiated site import, for the offer-bar status line.</summary>
public abstract record SiteImportResult(bool Ok, string Message);

public sealed record SiteImportSuccess(string Message) : SiteImportResult(true, Message);

public sealed record SiteImportFailure(string Reason, string Message) : SiteImportResult(false, Message);

/// <summary>
/// Runs a validated scrape against the two LCU apply services. Contract:
/// inputs are an already-parsed payload plus the resolved champion; outputs
/// are a status-line message; failure modes never leave a partial write
/// behind a VALIDATION failure (validation runs fully before the first LCU
/// call — a test pins zero LCU calls on bad data). An LCU write that fails
/// after validation reports exactly which half landed.
/// </summary>
public static class SiteImportApplier
{
    public static async Task<SiteImportResult> ApplyAsync(
        SiteImportPayload payload,
        string championName,
        int championId,
        RuneApplyService runes,
        ItemSetApplyService items,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(runes);
        ArgumentNullException.ThrowIfNull(items);
        if (championId <= 0 || string.IsNullOrWhiteSpace(championName))
            return new SiteImportFailure(
                "unknown-champion",
                $"could not match \"{payload.ChampionSlug}\" to a champion -- nothing was imported");

        if (SiteImportValidator.ValidateRunes(payload.Runes) is { } runeError)
            return new SiteImportFailure("bad-runes", $"{runeError} -- nothing was imported");
        if (SiteImportValidator.ValidateItems(payload.ItemBlocks) is { } itemError)
            return new SiteImportFailure("bad-items", $"{itemError} -- nothing was imported");

        var title = SiteImportValidator.PageTitle(championName, payload.Role, payload.Source);
        var runeRequest = SiteImportValidator.BuildRuneRequest(title, payload.Runes);
        if (!ApplyPayloadValidation.TryValidateRunes(runeRequest, out var runeGate))
            return new SiteImportFailure(runeGate.Reason, $"{runeGate.Hint} -- nothing was imported");
        var itemRequest = SiteImportValidator.BuildItemSetRequest(
            championId, title, payload.ChampionSlug, payload.Role, payload.ItemBlocks);
        if (!ApplyPayloadValidation.TryValidateItemSets(itemRequest, out var itemGate))
            return new SiteImportFailure(itemGate.Reason, $"{itemGate.Hint} -- nothing was imported");

        var runeResult = await runes.ApplyAsync(runeRequest, cancellationToken).ConfigureAwait(false);
        if (runeResult is ApplyRunesFailure runeFailure)
            return new SiteImportFailure(
                runeFailure.Reason,
                $"runes not applied ({runeFailure.Hint ?? runeFailure.Reason}) -- nothing was imported");

        var itemResult = await items.ApplyAsync(itemRequest, cancellationToken).ConfigureAwait(false);
        if (itemResult is ApplyItemSetsFailure itemFailure)
            return new SiteImportFailure(
                itemFailure.Reason,
                $"runes applied to \"{title}\", but the item set was rejected ({itemFailure.Hint ?? itemFailure.Reason})");

        var totalItems = payload.ItemBlocks.Sum(block => block.ItemIds.Count);
        var roleLabel = SiteImportValidator.RoleLabel(payload.Role);
        return new SiteImportSuccess(
            $"Imported runes + {totalItems}-item set for {championName} ({roleLabel}) from {SiteImportValidator.Label(payload.Source)}");
    }
}
