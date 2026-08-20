using System.Globalization;
using System.Text.Json;

namespace CoachBuild.Core;

/// <summary>
/// Which game this is: the queue's mode token and the map it is on.
///
/// <para>Live Client Data has published this on every <c>allgamedata</c> body
/// all along, and through 1.0.19 nothing in this codebase read it — a grep for
/// <c>gameMode</c> across <c>desktop</c>, <c>lib</c> and <c>app</c> returned
/// nothing. That gap has a cost, and it was paid on 2026-08-19: a game came
/// back with one more ability rank than the player's level could account for,
/// and one of the two surviving explanations was "this mode granted a point"
/// — unanswerable, because the log could not say which mode it was.</para>
///
/// <para>It is read from a body the poller already fetches every 3 s
/// (<see cref="LivePollingCoordinator.AllGameDataPollMs"/>), so this costs no
/// request, no syscall and no new permission. It also holds the 1.0.16 policy
/// line: no screen reading, no OCR, no game memory.</para>
/// </summary>
public sealed record LiveGameMode(string? Mode, int? MapNumber)
{
    /// <summary>
    /// The log rendering, in the shape the anomaly line and the once-per-game
    /// <c>live:</c> line both use. Unknown parts print as <c>?</c> rather than
    /// being dropped, because "the client did not publish it" and "nobody
    /// looked" have to be distinguishable in a pasted log.
    /// </summary>
    public string Describe() =>
        $"mode={Mode ?? "?"} map={MapNumber?.ToString(CultureInfo.InvariantCulture) ?? "?"}";
}

public static class LiveGameModeReader
{
    /// <summary>
    /// Reads <c>gameData.gameMode</c> and <c>gameData.mapNumber</c> off an
    /// <c>allgamedata</c> body.
    ///
    /// <para>Returns null only when there is nothing to say at all. A body that
    /// carries a mode but no map number still returns — a partial answer beats
    /// none, and Riot has moved this surface before (see
    /// <see cref="LiveLocalIdentity"/>). <c>mapNumber</c> is accepted as a
    /// number or as a string for the same reason.</para>
    /// </summary>
    public static LiveGameMode? TryRead(JsonElement allGameData)
    {
        if (allGameData.ValueKind != JsonValueKind.Object) return null;
        if (!allGameData.TryGetProperty("gameData", out var gameData) ||
            gameData.ValueKind != JsonValueKind.Object)
            return null;

        var mode = ReadMode(gameData);
        var map = ReadMapNumber(gameData);
        return mode is null && map is null ? null : new LiveGameMode(mode, map);
    }

    private static string? ReadMode(JsonElement gameData)
    {
        if (!gameData.TryGetProperty("gameMode", out var value) ||
            value.ValueKind != JsonValueKind.String)
            return null;
        var mode = value.GetString();
        if (string.IsNullOrWhiteSpace(mode)) return null;
        // Bounded, because this string is printed into a log the user pastes
        // and it arrives over a wire this process does not control.
        mode = mode.Trim();
        return mode.Length > 32 ? mode[..32] : mode;
    }

    private static int? ReadMapNumber(JsonElement gameData)
    {
        if (!gameData.TryGetProperty("mapNumber", out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number))
            return number is >= 0 and <= 999 ? number : null;
        if (value.ValueKind == JsonValueKind.String &&
            int.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number))
            return number is >= 0 and <= 999 ? number : null;
        return null;
    }
}
