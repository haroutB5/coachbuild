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
    /// <summary>The shared empty default, so two note-less payloads stay equal.</summary>
    private static readonly IReadOnlyList<string> NoNotes = Array.Empty<string>();

    /// <summary>
    /// The extractor's own diagnostic lines (<c>meta.notes</c>), carried
    /// through so they reach the log.
    ///
    /// <para>Deliberately NOT positional: it is diagnostics, not identity, and
    /// every existing construction site keeps its arity. Until 2.1.0 these
    /// were parsed nowhere — the Coachless walk merged its settle notes into
    /// the payload JSON and this parser dropped them on the floor, so a
    /// degraded import looked identical to a clean one in the log. Both
    /// extractors now emit stage/slot notes and this is the channel that
    /// delivers them.</para>
    /// </summary>
    public IReadOnlyList<string> Notes { get; init; } = NoNotes;

    /// <summary>
    /// The u.gg extractor's own <c>meta.stage</c> — how far the items read got
    /// before it ran out of page: <c>url-recognized</c> (no embedded build blob
    /// was found at all) → <c>json-found</c> → <c>keys-found</c> →
    /// <c>blocks-built</c>. Empty for extractors that do not report one.
    ///
    /// <para>Parsed since 2.1.1 because it is the ONE signal that separates
    /// "this page has no build" from "this page never embedded one".
    /// u.gg embeds its per-champion build blob only on a DIRECT document load;
    /// a client-side (SPA) route change leaves the previous document's scripts
    /// in place, so an extract-in-place read of a tab the user navigated
    /// within the site sees <c>url-recognized</c> with zero embedded ranks —
    /// exactly the live 2026-09-08 22:37:36 Jhin failure. That is recoverable
    /// by re-loading the same URL in a hidden worker, and
    /// <c>AutoImportCoordinator.ShouldRetryViaWorker</c> is what decides it.
    /// Diagnostics-shaped, so like <see cref="Notes"/> it is NOT positional.</para>
    /// </summary>
    public string Stage { get; init; } = string.Empty;

    /// <summary>The stage the u.gg extractor reports when it found no embedded build blob at all.</summary>
    public const string StageUrlRecognized = "url-recognized";

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

            payload = new SiteImportPayload(source, slug, role, runes!, blocks)
            {
                Notes = ReadNotes(root),
                Stage = ReadStage(root),
            };
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

    /// <summary>
    /// The extractor's own reason, kept.
    ///
    /// <para>Until 2.1.0 this collapsed EVERYTHING that was not "no build"
    /// into the generic <see cref="SiteImportFailures.NotRecognized"/>. That
    /// was harmless while the only extractor errors were two canned strings,
    /// and actively wrong once the Coachless runes extractor started naming
    /// the exact missing part ("primary rune row 2 carried no WPA reading") —
    /// the honest per-part failure the import is supposed to report was being
    /// thrown away one layer above where it was produced.</para>
    ///
    /// <para>The two canned reasons still normalize (callers match on them).
    /// Anything else is passed through, but SANITIZED first: these strings
    /// reach a status line and a log file, and although every one of them is
    /// authored by our own scripts, the script runs on a third-party page and
    /// some of them interpolate page-derived text (a slot title). So control
    /// characters go, whitespace collapses, and the length is capped.</para>
    /// </summary>
    private static string NormalizeExtractorError(string error)
    {
        var normalized = error.Trim().ToLowerInvariant();
        if (normalized.Contains("no build", StringComparison.Ordinal))
            return SiteImportFailures.NoBuild;
        // "not a champion build page", "not a champion runes page", "not a
        // build page" -- every extractor's this-is-the-wrong-page reason.
        if (normalized.Contains("not recognized", StringComparison.Ordinal) ||
            (normalized.StartsWith("not a ", StringComparison.Ordinal) &&
             normalized.EndsWith(" page", StringComparison.Ordinal)))
            return SiteImportFailures.NotRecognized;

        var cleaned = new string(error
            .Trim()
            .Select(character => char.IsControl(character) ? ' ' : character)
            .ToArray());
        cleaned = string.Join(' ', cleaned.Split(
            ' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (cleaned.Length == 0) return SiteImportFailures.NotRecognized;
        return cleaned.Length <= MaxExtractorErrorLength
            ? cleaned
            : cleaned[..MaxExtractorErrorLength].TrimEnd() + "…";
    }

    /// <summary>Cap on a passed-through extractor reason, so a status line stays a line.</summary>
    private const int MaxExtractorErrorLength = 160;

    /// <summary>Cap on how many notes one payload may carry into the log.</summary>
    private const int MaxNotes = 16;

    /// <summary>
    /// Reads <c>meta.notes</c>. Sanitized exactly like an extractor error and
    /// for the same reason: these strings are authored by our own scripts but
    /// interpolate page-derived text (slot titles, rank tokens) and they end
    /// up in a log file.
    /// </summary>
    private static IReadOnlyList<string> ReadNotes(JsonElement root)
    {
        if (!root.TryGetProperty("meta", out var meta) || meta.ValueKind != JsonValueKind.Object)
            return NoNotes;
        if (!meta.TryGetProperty("notes", out var notes) || notes.ValueKind != JsonValueKind.Array)
            return NoNotes;
        var cleaned = new List<string>();
        foreach (var note in notes.EnumerateArray())
        {
            if (cleaned.Count >= MaxNotes) break;
            if (note.ValueKind != JsonValueKind.String) continue;
            var text = note.GetString();
            if (string.IsNullOrWhiteSpace(text)) continue;
            var flat = new string(text.Select(c => char.IsControl(c) ? ' ' : c).ToArray());
            flat = string.Join(' ', flat.Split(
                ' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
            if (flat.Length == 0) continue;
            cleaned.Add(flat.Length <= MaxExtractorErrorLength
                ? flat
                : flat[..MaxExtractorErrorLength].TrimEnd() + "…");
        }
        return cleaned.Count == 0 ? NoNotes : cleaned;
    }

    /// <summary>
    /// Reads <c>meta.stage</c>. Restricted to a short lowercase token so a
    /// page-derived string can never masquerade as one: this value is COMPARED
    /// AGAINST, not merely logged, so it is validated rather than sanitized.
    /// </summary>
    private static string ReadStage(JsonElement root)
    {
        if (!root.TryGetProperty("meta", out var meta) || meta.ValueKind != JsonValueKind.Object)
            return string.Empty;
        if (!meta.TryGetProperty("stage", out var stage) || stage.ValueKind != JsonValueKind.String)
            return string.Empty;
        var text = stage.GetString()?.Trim();
        if (string.IsNullOrEmpty(text) || text.Length > 32) return string.Empty;
        foreach (var c in text)
        {
            if (!char.IsAsciiLetterLower(c) && c != '-') return string.Empty;
        }
        return text;
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

    /// <summary>
    /// Coachless's own shard icon filenames, folded into the same table.
    ///
    /// <para>Coachless does NOT serve ddragon's StatMods filenames — it
    /// serves its own short stat icons (<c>cdn.coachless.gg/stat-icons/ah.png</c>).
    /// Read off the 2026-09-08 <c>coachless-nasus-runes.html</c> fixture and
    /// re-confirmed on all six 2026-09-08 sweep runes captures (jhin/ahri/
    /// leona/leesin/garen/ornn), whose nine shard cards are, in the site's own
    /// DOM order and IDENTICALLY on every one of the six,
    /// [adaptiveforce, as, ah] / [adaptiveforce, ms, healthscaling] /
    /// [health, tenacity, healthscaling] — which is exactly the client's
    /// Offense/Flex/Defense shard grid with <c>as</c>=attack speed,
    /// <c>ah</c>=ability haste, <c>ms</c>=move speed.</para>
    ///
    /// <para>THE TWO HEALTH SHARDS ARE A NAME TRAP, and 2.1.1 walked into it.
    /// Riot's own icon FILENAMES are crossed against the shards' DISPLAY
    /// NAMES, and <see cref="ByName"/> is keyed by filename because that is
    /// what u.gg serves. u.gg's embedded
    /// <c>stat-shards-v2.json</c> (patch 14.2, read out of
    /// <c>ugg-jhin-adc.html</c>) is the ground truth for that column:</para>
    /// <list type="bullet">
    ///   <item><c>StatModsHealthScalingIcon.png</c> → id <b>5011</b>, display
    ///   name "Health", <c>+65 Health</c> — the FLAT health shard.</item>
    ///   <item><c>StatModsHealthPlusIcon.png</c> → id <b>5001</b>, display name
    ///   "Health Scaling", <c>+10-180 Health (based on level)</c>.</item>
    /// </list>
    ///
    /// <para>Coachless names its icons by MEANING, not by Riot's filename: its
    /// <c>healthscaling.png</c> is the scaling shard (5001) and its
    /// <c>health.png</c> is flat health (5011) — the opposite of what the same
    /// two words resolve to through <see cref="ByName"/>. Until 2.1.1 the
    /// merged table therefore handed the Coachless script 5011 for
    /// <c>healthscaling</c> and 5001 for <c>health</c>, which is why
    /// <c>a scraped shard does not belong to its shard row</c> refused the live
    /// Jhin import on 2026-09-08 22:38 (the Flex row's top-WPA card is
    /// <c>healthscaling</c>, and 5011 is not a Flex shard) — and, worse, why a
    /// Defense row won by <c>health</c> passed the row check on the wrong id
    /// and silently wrote Health Scaling where the page said Health. Replaying
    /// the six sweep fixtures: 2 refused (jhin, garen), 3 wrote the wrong
    /// defense shard (ahri, leesin, leona), 1 was unaffected (ornn).</para>
    ///
    /// <para>So BOTH health keys are overridden here. <c>healthscaling</c>
    /// deliberately shadows a <see cref="ByName"/> entry — that is the point of
    /// the override seam, and <see cref="ToCoachlessJson"/> lets the alias
    /// win.</para>
    ///
    /// <para>Kept SEPARATE from <see cref="ByName"/> on purpose: u.gg's
    /// injected map must stay byte-identical (it is correct for u.gg, per the
    /// stat-shards-v2.json read above), so only the Coachless runes script is
    /// handed the merged table.</para>
    /// </summary>
    public static readonly IReadOnlyDictionary<string, int> CoachlessAliases =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["as"] = 5005,
            ["ah"] = 5007,
            ["ms"] = 5010,
            // Coachless's words, not Riot's filenames. See the name trap above.
            ["health"] = 5011,
            ["healthscaling"] = 5001,
        };

    public static string ToJson() =>
        JsonSerializer.Serialize(ByName, JsonOptions.Wire);

    /// <summary>The table plus <see cref="CoachlessAliases"/>, for the Coachless runes script only.</summary>
    public static string ToCoachlessJson()
    {
        var merged = new Dictionary<string, int>(ByName, StringComparer.Ordinal);
        foreach (var (name, id) in CoachlessAliases) merged[name] = id;
        return JsonSerializer.Serialize(merged, JsonOptions.Wire);
    }
}

/// <summary>
/// Rune-tree style ids by the lowercase tree name both the Coachless runes
/// URL (<c>/runes/tree/nasus/precision/resolve</c>) and every site's perk
/// icon path (<c>/perk-images/Styles/Precision/…</c>) spell out. The ids are
/// the same five <see cref="PerkTreeCatalog.Trees"/> keys — this is only the
/// name column, so a page that names a tree in words can be read without a
/// second catalog to drift.
/// </summary>
public static class PerkTreeNames
{
    public static readonly IReadOnlyDictionary<string, int> StyleIdsByName =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["precision"] = 8000,
            ["domination"] = 8100,
            ["sorcery"] = 8200,
            ["inspiration"] = 8300,
            ["resolve"] = 8400,
        };

    public static int Resolve(string? name) =>
        name is not null &&
        StyleIdsByName.TryGetValue(name.Trim().ToLowerInvariant(), out var id)
            ? id
            : 0;

    public static string ToJson() =>
        JsonSerializer.Serialize(StyleIdsByName, JsonOptions.Wire);
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

    /// <summary>
    /// The display label for a role token, or NULL when the page named no
    /// role we recognize.
    ///
    /// <para>Null, not <c>"Unknown"</c>. Practice tool and custom lobbies
    /// assign no position, so champ select hands the import an empty role and
    /// the 2.0.1 template stamped the literal word into the client:
    /// <c>CoachBuild import: Nasus Unknown (u.gg)</c> (field-tested
    /// 2026-09-08). A missing role is an absence to omit, never a value to
    /// print — every caller composes through <see cref="PageTitle"/> or
    /// <see cref="ChampionLabel"/>, which drop the role entirely.</para>
    /// </summary>
    public static string? RoleLabel(string? role) => role?.Trim().ToLowerInvariant() switch
    {
        "top" => "Top",
        "jungle" or "jg" or "jun" => "Jungle",
        "mid" or "middle" or "midlane" => "Mid",
        "adc" or "bottom" or "bot" or "carry" => "ADC",
        "support" or "sup" or "utility" => "Support",
        { Length: > 0 } raw => char.ToUpperInvariant(raw[0]) + raw[1..],
        _ => null,
    };

    /// <summary>
    /// The champion as a status line names it: <c>Nasus (Top)</c> with a
    /// role, bare <c>Nasus</c> without one.
    /// </summary>
    public static string ChampionLabel(string championName, string? role) =>
        RoleLabel(role) is { } label ? $"{championName} ({label})" : championName;

    /// <summary>
    /// The shared page title for both writes, e.g.
    /// <c>CoachBuild import: Jhin ADC (u.gg)</c> — or, when the lobby assigned
    /// no role, <c>CoachBuild import: Nasus (u.gg)</c>. CoachBuild-prefixed so
    /// both apply gates accept it, and exact-title reuse in
    /// <see cref="RuneApplyService"/> means a re-import edits the same page.
    ///
    /// <para>The roleless title is a DIFFERENT title, so a roleless import
    /// edits its own page rather than overwriting a roled one. That is
    /// deliberate: the two really are different builds.</para>
    /// </summary>
    public static string PageTitle(string championName, string? role, SiteImportSource source) =>
        RoleLabel(role) is { } label
            ? $"CoachBuild import: {championName} {label} ({Label(source)})"
            : $"CoachBuild import: {championName} ({Label(source)})";

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
        IReadOnlyList<SiteImportItemBlock> blocks) =>
        new(championId, [BuildItemSetElement(championId, pageTitle, championSlug, role, blocks)]);

    /// <summary>
    /// One set's element for an <see cref="ApplyItemSetsRequest"/>. Split out
    /// so the automatic import can batch both sites' sets into a single
    /// request: the merge drops every <c>CoachBuild*</c> set it reads, so two
    /// sequential single-set writes would NOT coexist (the second would wipe
    /// the first) — one request with both sets is what keeps them coexisting.
    /// </summary>
    public static JsonElement BuildItemSetElement(
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
        return document.RootElement.Clone();
    }
}

/// <summary>Outcome of a user-initiated site import, for the offer-bar status line.</summary>
public abstract record SiteImportResult(bool Ok, string Message);

public sealed record SiteImportSuccess(string Message) : SiteImportResult(true, Message);

public sealed record SiteImportFailure(string Reason, string Message) : SiteImportResult(false, Message);

/// <summary>
/// One site's items-only contribution to an automatic import batch: an
/// already-parsed payload plus the resolved champion it belongs to. The
/// coordinator guarantees every contribution in one batch addresses the
/// same champion (its own context champion); each set still carries its
/// own per-site title, which is what keeps the two sites coexisting in
/// the client after the single merged write.
/// </summary>
public sealed record SiteImportItemsContribution(
    SiteImportPayload Payload,
    string ChampionName,
    int ChampionId);

/// <summary>
/// Runs a validated scrape against the two LCU apply services. Contract:
/// inputs are an already-parsed payload plus the resolved champion; outputs
/// are a status-line message; failure modes never leave a partial write
/// behind a VALIDATION failure (validation runs fully before the first LCU
/// call — a test pins zero LCU calls on bad data). An LCU write that fails
/// after validation reports exactly which half landed.
///
/// <para>A payload with <c>runes: null</c> but a non-empty item build (the
/// Coachless overview shape — that page renders no rune page at all) writes
/// the ITEM SET ONLY, skips the rune service entirely, and succeeds with an
/// "(no rune page on this site)" status. An empty item build stays a typed
/// no-build failure: items-only never invents a build.</para>
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

        var title = SiteImportValidator.PageTitle(championName, payload.Role, payload.Source);
        if (payload.Runes is null)
            return await ApplyItemsOnlyAsync(
                payload, championId, title, items, cancellationToken).ConfigureAwait(false);

        if (SiteImportValidator.ValidateRunes(payload.Runes) is { } runeError)
            return new SiteImportFailure("bad-runes", $"{runeError} -- nothing was imported");
        if (SiteImportValidator.ValidateItems(payload.ItemBlocks) is { } itemError)
            return new SiteImportFailure("bad-items", $"{itemError} -- nothing was imported");

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
        var who = SiteImportValidator.ChampionLabel(championName, payload.Role);
        return new SiteImportSuccess(
            $"Imported runes + {totalItems}-item set for {who} from {SiteImportValidator.Label(payload.Source)}");
    }

    /// <summary>
    /// The runes-only path for the offer-bar "Import runes" button: validate
    /// and write the rune page alone. The item-set service is never touched
    /// (items flow through the automatic import now, never the button), so a
    /// rune write cannot disturb the item sets. A runes-null payload (the
    /// Coachless shape) stays a typed failure here — the button is hidden on
    /// Coachless for exactly that reason.
    /// </summary>
    public static async Task<SiteImportResult> ApplyRunesOnlyAsync(
        SiteImportPayload payload,
        string championName,
        int championId,
        RuneApplyService runes,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(payload);
        ArgumentNullException.ThrowIfNull(runes);
        if (championId <= 0 || string.IsNullOrWhiteSpace(championName))
            return new SiteImportFailure(
                "unknown-champion",
                $"could not match \"{payload.ChampionSlug}\" to a champion -- nothing was imported");

        var title = SiteImportValidator.PageTitle(championName, payload.Role, payload.Source);
        if (SiteImportValidator.ValidateRunes(payload.Runes) is { } runeError)
            return new SiteImportFailure("bad-runes", $"{runeError} -- nothing was imported");

        var runeRequest = SiteImportValidator.BuildRuneRequest(title, payload.Runes);
        if (!ApplyPayloadValidation.TryValidateRunes(runeRequest, out var runeGate))
            return new SiteImportFailure(runeGate.Reason, $"{runeGate.Hint} -- nothing was imported");

        var runeResult = await runes.ApplyAsync(runeRequest, cancellationToken).ConfigureAwait(false);
        if (runeResult is ApplyRunesFailure runeFailure)
            return new SiteImportFailure(
                runeFailure.Reason,
                $"runes not applied ({runeFailure.Hint ?? runeFailure.Reason}) -- nothing was imported");

        var who = SiteImportValidator.ChampionLabel(championName, payload.Role);
        // 2.1.2: a repeat press on an identical, already-selected page is a
        // no-write success (RuneApplyService marks it Unchanged). Say so
        // honestly instead of claiming an import happened -- and, just as
        // importantly, say SOMETHING: no press may end without a status line.
        if (runeResult is ApplyRunesSuccess alreadyCurrent && alreadyCurrent.Unchanged == true)
            return new SiteImportSuccess(
                AlreadyCurrentMessage(championName, payload.Role, payload.Source));
        return new SiteImportSuccess(
            $"Imported runes for {who} from {SiteImportValidator.Label(payload.Source)}");
    }

    /// <summary>
    /// The wording of the already-current success, for tests that pin the
    /// exact status line without driving the LCU.
    /// </summary>
    public static string AlreadyCurrentMessage(string championName, string? role, SiteImportSource source) =>
        $"Runes already current for {SiteImportValidator.ChampionLabel(championName, role)} " +
        $"from {SiteImportValidator.Label(source)}";

    /// <summary>
    /// The automatic import's write: every contribution's item set in ONE
    /// <see cref="ItemSetApplyService"/> call, so the read-modify-write the
    /// merge performs sees both sites at once. Validation runs entirely
    /// before the first LCU call — an invalid contribution fails in place
    /// while the valid ones still land; when NOTHING is valid the LCU is
    /// never touched. The rune service is not taken and cannot be reached:
    /// this path is items-only by construction, not by discipline.
    /// </summary>
    public static async Task<IReadOnlyList<SiteImportResult>> ApplyItemsBatchAsync(
        IReadOnlyList<SiteImportItemsContribution> contributions,
        ItemSetApplyService items,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(contributions);
        ArgumentNullException.ThrowIfNull(items);
        var results = new List<SiteImportResult>();
        if (contributions.Count == 0) return results;

        var valid = new List<(SiteImportItemsContribution Contribution, string Title)>();
        foreach (var contribution in contributions)
        {
            var payload = contribution?.Payload;
            if (payload is null || contribution!.ChampionId <= 0 ||
                string.IsNullOrWhiteSpace(contribution.ChampionName))
            {
                results.Add(new SiteImportFailure(
                    "unknown-champion",
                    $"could not match \"{payload?.ChampionSlug}\" to a champion -- nothing was imported"));
                continue;
            }
            if (SiteImportValidator.ValidateItems(payload.ItemBlocks) is { } itemError)
            {
                results.Add(new SiteImportFailure("bad-items", $"{itemError} -- nothing was imported"));
                continue;
            }
            valid.Add((contribution, SiteImportValidator.PageTitle(
                contribution.ChampionName, payload.Role, payload.Source)));
        }
        if (valid.Count == 0) return results;

        var championId = valid[0].Contribution.ChampionId;
        var elements = valid.Select(entry => SiteImportValidator.BuildItemSetElement(
                entry.Contribution.ChampionId,
                entry.Title,
                entry.Contribution.Payload.ChampionSlug,
                entry.Contribution.Payload.Role,
                entry.Contribution.Payload.ItemBlocks))
            .ToList();
        var request = new ApplyItemSetsRequest(championId, elements);
        if (!ApplyPayloadValidation.TryValidateItemSets(request, out var itemGate))
        {
            foreach (var _ in valid)
                results.Add(new SiteImportFailure(itemGate.Reason, $"{itemGate.Hint} -- nothing was imported"));
            return results;
        }

        var itemResult = await items.ApplyAsync(request, cancellationToken).ConfigureAwait(false);
        if (itemResult is ApplyItemSetsFailure itemFailure)
        {
            foreach (var _ in valid)
                results.Add(new SiteImportFailure(
                    itemFailure.Reason,
                    $"item set rejected ({itemFailure.Hint ?? itemFailure.Reason}) -- nothing was imported"));
            return results;
        }

        foreach (var (contribution, _) in valid)
        {
            var totalItems = contribution.Payload.ItemBlocks.Sum(block => block.ItemIds.Count);
            var who = SiteImportValidator.ChampionLabel(
                contribution.ChampionName, contribution.Payload.Role);
            results.Add(new SiteImportSuccess(
                $"Auto-imported {totalItems}-item set for {who} from {SiteImportValidator.Label(contribution.Payload.Source)}"));
        }
        return results;
    }

    /// <summary>
    /// The runes-null path: validate and write the item set alone. The rune
    /// service is never touched (a test pins zero rune calls), so a page
    /// with no rune build cannot disturb the user's pages. An item write
    /// that fails here imported NOTHING (unlike the both-halves path, where
    /// the runes half may already have landed) and says exactly so.
    /// </summary>
    private static async Task<SiteImportResult> ApplyItemsOnlyAsync(
        SiteImportPayload payload,
        int championId,
        string title,
        ItemSetApplyService items,
        CancellationToken cancellationToken)
    {
        if (SiteImportValidator.ValidateItems(payload.ItemBlocks) is { } itemError)
            return new SiteImportFailure("bad-items", $"{itemError} -- nothing was imported");
        var itemRequest = SiteImportValidator.BuildItemSetRequest(
            championId, title, payload.ChampionSlug, payload.Role, payload.ItemBlocks);
        if (!ApplyPayloadValidation.TryValidateItemSets(itemRequest, out var itemGate))
            return new SiteImportFailure(itemGate.Reason, $"{itemGate.Hint} -- nothing was imported");

        var itemResult = await items.ApplyAsync(itemRequest, cancellationToken).ConfigureAwait(false);
        if (itemResult is ApplyItemSetsFailure itemFailure)
            return new SiteImportFailure(
                itemFailure.Reason,
                $"item set rejected ({itemFailure.Hint ?? itemFailure.Reason}) -- nothing was imported");

        var totalItems = payload.ItemBlocks.Sum(block => block.ItemIds.Count);
        return new SiteImportSuccess(
            $"Imported {totalItems}-item set (no rune page on this site) from {SiteImportValidator.Label(payload.Source)}");
    }
}
