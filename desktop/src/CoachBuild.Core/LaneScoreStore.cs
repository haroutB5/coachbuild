using System.Collections.Concurrent;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Local-only persistence for lane scores.
/// <c>%LOCALAPPDATA%\CoachBuild\lane-scores.json</c> and nowhere else — there is
/// no database behind this feature and there is not going to be one (Neon is
/// being decommissioned). The user's judgement of their own games never leaves
/// their machine.
///
/// <para><b>Atomicity.</b> Every write goes to a uniquely-named temp file in the
/// same directory and is then <see cref="File.Move(string, string, bool)"/>d
/// over the real one, which is atomic on NTFS. A crash mid-write therefore
/// leaves either the old complete document or the new complete document, never
/// a truncated one. This is the same shape
/// <c>OverlaySettingsStore.WriteCore</c> uses; that part of it was right.</para>
///
/// <para><b>The part of OverlaySettingsStore that was NOT right</b>, and which
/// the brief calls out: its <c>Save()</c> serialises a hand-written clone of the
/// settings object, so a property the author forgot to copy in
/// <c>CloneSettings</c> is silently reset to its default the next time any
/// unrelated setting is written. Two things here make that impossible rather
/// than merely unlikely:</para>
/// <list type="number">
/// <item><b>There is no clone path.</b> Mutations read the document, change the
/// list they mean to change, and write that same object back. A field nobody
/// mentions is carried because nothing ever rebuilt the object.</item>
/// <item><b><see cref="LaneScoreDocument.Extra"/></b> catches keys this build
/// does not model at all, so a document written by a NEWER version survives a
/// write by an older one. The trap's other direction.</item>
/// </list>
/// <para><c>LaneScoreStoreTests.AFullyPopulatedDocumentSurvivesAWriteReloadCycle</c>
/// writes every field, reloads and compares.</para>
/// </summary>
public sealed class LaneScoreStore
{
    public const string FileName = "lane-scores.json";

    private static readonly JsonSerializerOptions DocumentJson = new(JsonSerializerDefaults.General)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
    };

    // One gate per file, process-wide, so two stores over the same path cannot
    // interleave a read/modify/write. Same reasoning as OverlaySettingsStore's
    // ProcessGates; the app is single-instance so no lock file is needed.
    private static readonly ConcurrentDictionary<string, object> Gates = new(StringComparer.OrdinalIgnoreCase);

    private readonly string _path;
    private readonly string _canonicalPath;

    public LaneScoreStore(string path)
    {
        _path = path ?? throw new ArgumentNullException(nameof(path));
        _canonicalPath = Path.GetFullPath(_path);
    }

    /// <summary>The production location. Kept next to companion.log and desktop-settings.json.</summary>
    public static string DefaultPath(string? localAppData = null) => Path.Combine(
        localAppData ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "CoachBuild",
        FileName);

    /// <summary>The file this store reads and writes. Diagnostics and tests only.</summary>
    public string FilePath => _path;

    /// <summary>
    /// The document as it is on disk. A missing file is an empty document; a
    /// corrupt one is ALSO an empty document rather than an exception, because
    /// this feature never gets to stop the app from starting. The corrupt file
    /// is left alone on disk — see <see cref="Mutate"/>, which refuses to
    /// overwrite what it could not read.
    /// </summary>
    public LaneScoreDocument Read()
    {
        lock (GetGate())
        {
            return ReadCore(out _);
        }
    }

    private LaneScoreDocument ReadCore(out bool readable)
    {
        readable = true;
        try
        {
            if (!File.Exists(_path)) return new LaneScoreDocument();
            var raw = File.ReadAllText(_path);
            var document = JsonSerializer.Deserialize<LaneScoreDocument>(raw, DocumentJson);
            if (document is null)
            {
                readable = false;
                return new LaneScoreDocument();
            }
            // Deserialisation can legally produce nulls for the collections if
            // the file says `"scores": null`. Normalising here means no caller
            // has to null-check a list that the type says is never null.
            document.Pending ??= [];
            document.Scores ??= [];
            document.Skipped ??= [];
            // JSON permits null elements even in non-nullable C# lists. Refuse
            // the document rather than crashing or dropping history on a write.
            if (document.Pending.Any(game => game is null || game.EnemyChampionIds is null) ||
                document.Scores.Any(record => record?.Game is null || record.Game.EnemyChampionIds is null))
            {
                readable = false;
                return new LaneScoreDocument();
            }
            return document;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            readable = false;
            return new LaneScoreDocument();
        }
    }

    /// <summary>
    /// Read/modify/write under the file gate. Returns whatever the mutation
    /// returns.
    ///
    /// <para><b>It refuses to write over a file it could not read.</b> Recording
    /// one new score is never worth silently deleting a history the user spent
    /// months building because a disk hiccup made one read fail. An unreadable
    /// file makes the mutation a no-op and the caller is told.</para>
    /// </summary>
    private T Mutate<T>(Func<LaneScoreDocument, T> mutation, T unreadableResult, Func<T, bool> shouldWrite)
    {
        lock (GetGate())
        {
            var document = ReadCore(out var readable);
            if (!readable && File.Exists(_path)) return unreadableResult;
            var result = mutation(document);
            if (!shouldWrite(result)) return result;
            document.SchemaVersion = LaneScoreDocument.CurrentSchemaVersion;
            Write(document);
            return result;
        }
    }

    private void Write(LaneScoreDocument document)
    {
        var directory = Path.GetDirectoryName(_path);
        if (!string.IsNullOrWhiteSpace(directory)) Directory.CreateDirectory(directory);

        var temporary = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            // NOTE: the document object itself is serialised. No clone, no
            // projection, no rebuilt instance -- see the type remarks.
            File.WriteAllText(temporary, JsonSerializer.Serialize(document, DocumentJson));
            File.Move(temporary, _path, overwrite: true);
        }
        catch
        {
            try { if (File.Exists(temporary)) File.Delete(temporary); } catch { }
            throw;
        }
    }

    private object GetGate() => Gates.GetOrAdd(_canonicalPath, static _ => new object());

    /// <summary>
    /// Records a freshly-ended ranked game as awaiting a score.
    ///
    /// <para>Returns false if this match id is already known in ANY of the three
    /// lists. That single check is the whole dedupe rule the brief asks for: a
    /// game can never be scored twice, and a restart cannot re-prompt for a game
    /// already scored or already skipped.</para>
    /// </summary>
    public bool Capture(LaneScoreGame game)
    {
        ArgumentNullException.ThrowIfNull(game);
        if (string.IsNullOrWhiteSpace(game.MatchId)) return false;
        if (!RankedQueues.IsRanked(game.QueueId)) return false;
        // The demo card must never reach the user's real history. LaneScoreService
        // in demo mode does not call this store at all; this is the second lock,
        // so that a future wiring mistake fails closed instead of fabricating a
        // matchup the user never played.
        if (game.MatchId.StartsWith(LaneScoreService.DemoMatchIdPrefix, StringComparison.Ordinal)) return false;

        return Mutate(document =>
        {
            if (document.Knows(game.MatchId)) return false;
            document.Pending.Add(game);
            return true;
        }, unreadableResult: false, shouldWrite: static added => added);
    }

    /// <summary>
    /// The game the card should offer, or null. Newest first: if two games
    /// somehow ended without the user coming back, the one they remember is the
    /// last one.
    /// </summary>
    public LaneScoreGame? Pending()
    {
        var document = Read();
        return document.Pending.Count == 0 ? null : document.Pending[^1];
    }

    /// <summary>
    /// Applies a submission. All validation lives here rather than in the HTTP
    /// handler so that the rules are testable without a socket, and so a second
    /// caller (the tray, a future hotkey) cannot bypass them.
    /// </summary>
    public LaneScoreSubmission Submit(LaneScoreSubmitRequest? request, DateTimeOffset now)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.MatchId))
            return LaneScoreSubmission.Rejected("bad-request");

        return Mutate<LaneScoreSubmission>(document =>
        {
            var matchId = request.MatchId!;
            if (document.Scores.Any(record => string.Equals(record.Game.MatchId, matchId, StringComparison.Ordinal)))
                return LaneScoreSubmission.Rejected("already-scored");

            var index = document.Pending.FindIndex(game =>
                string.Equals(game.MatchId, matchId, StringComparison.Ordinal));
            if (index < 0)
                return LaneScoreSubmission.Rejected("unknown-match");

            var game = document.Pending[index];

            if (request.Skip)
            {
                document.Pending.RemoveAt(index);
                if (!document.Skipped.Contains(matchId, StringComparer.Ordinal))
                    document.Skipped.Add(matchId);
                return LaneScoreSubmission.Accepted;
            }

            // Integer 1-10, and nothing else. Not clamped: a 0 or a 47 is a bug
            // in the caller, and silently turning it into a 1 or a 10 would put
            // a number the user never chose into their history forever.
            if (request.Score is not { } score || score < 1 || score > 10)
                return LaneScoreSubmission.Rejected("bad-score");

            var roleId = game.RoleId;
            if (!LaneRoles.IsValid(roleId))
            {
                if (!LaneRoles.IsValid(request.RoleId))
                    return LaneScoreSubmission.Rejected("role-required");
                roleId = request.RoleId;
            }

            var opponentId = game.OpponentChampionId;
            if (opponentId is null or <= 0)
            {
                // The capture could not resolve the laner, so the user must say.
                // Refusing here rather than storing a null-opponent score is the
                // point: an unattributed score can never be aggregated, so
                // accepting one would be quietly throwing the game away.
                if (request.OpponentChampionId is not { } chosen || chosen <= 0)
                    return LaneScoreSubmission.Rejected("opponent-required");
                if (!game.EnemyChampionIds.Contains(chosen))
                    return LaneScoreSubmission.Rejected("bad-opponent");
                opponentId = chosen;
            }
            else if (request.OpponentChampionId is { } supplied && supplied > 0 && supplied != opponentId)
            {
                // The card offered a correction for a matchup we thought we knew.
                // Accept it only if it is actually on the enemy team.
                if (!game.EnemyChampionIds.Contains(supplied))
                    return LaneScoreSubmission.Rejected("bad-opponent");
                opponentId = supplied;
            }

            var resolved = game with
            {
                RoleId = roleId,
                OpponentChampionId = opponentId,
                OpponentChampionName = opponentId == game.OpponentChampionId
                    ? game.OpponentChampionName
                    : null,
            };

            document.Pending.RemoveAt(index);
            document.Scores.Add(new LaneScoreRecord
            {
                Game = resolved,
                Score = score,
                Note = NormalizeNote(request.Note),
                ScoredAt = now.ToString("O"),
            });
            return LaneScoreSubmission.Accepted;
        }, unreadableResult: LaneScoreSubmission.Rejected("store-unreadable"), shouldWrite: static result => result.Ok);
    }

    /// <summary>Bounded and trimmed. A note is a memory aid, not a document.</summary>
    public static string? NormalizeNote(string? note)
    {
        var value = note?.Trim();
        if (string.IsNullOrEmpty(value)) return null;
        return value.Length <= 280 ? value : value[..280];
    }
}

/// <summary>The wire body of <c>POST /lane-scores</c>.</summary>
public sealed record LaneScoreSubmitRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("matchId")]
    public string? MatchId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("score")]
    public int? Score { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("roleId")]
    public int? RoleId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("opponentChampionId")]
    public int? OpponentChampionId { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("note")]
    public string? Note { get; init; }

    [System.Text.Json.Serialization.JsonPropertyName("skip")]
    public bool Skip { get; init; }
}

/// <summary>The wire result of <c>POST /lane-scores</c>.</summary>
public sealed record LaneScoreSubmission(
    [property: System.Text.Json.Serialization.JsonPropertyName("ok")] bool Ok,
    [property: System.Text.Json.Serialization.JsonPropertyName("reason")] string? Reason = null)
{
    public static LaneScoreSubmission Accepted { get; } = new(true);

    public static LaneScoreSubmission Rejected(string reason) => new(false, reason);
}
