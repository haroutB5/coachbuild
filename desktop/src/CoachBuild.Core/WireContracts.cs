using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Core;

/// <summary>Constants shared by the native bridge and companionClient.ts.</summary>
public static class CompanionWire
{
    public const string AppOrigin = "https://coachbuild.vercel.app";
    public const string Version = "1.13.0";
    public const string SessionFileName = "companion-session.txt";
    public const int AttachWindowSeconds = 150;
    public const int OpenGraceSeconds = 25;
    public const int MaxLogBytes = 200 * 1024;
    public static readonly int[] BridgePorts = [48291, 48292, 48293];
}

public static class CompanionRoutes
{
    public const string Status = "/status";
    public const string Live = "/live";
    public const string Skills = "/skills";
    public const string Me = "/me";
    public const string ApplyRunes = "/apply-runes";
    public const string ApplyItemSets = "/apply-itemsets";
}

public sealed record CompanionLastOpen(
    [property: JsonPropertyName("championId")] int ChampionId,
    [property: JsonPropertyName("roleId")] int? RoleId,
    [property: JsonPropertyName("at")] string At);

public sealed record CompanionChampSelectSnapshot(
    [property: JsonPropertyName("localPlayerCellId")] int LocalPlayerCellId,
    [property: JsonPropertyName("cellChampionId")] int? CellChampionId,
    [property: JsonPropertyName("pickIntent")] int? PickIntent,
    [property: JsonPropertyName("actionChampionId")] int? ActionChampionId,
    [property: JsonPropertyName("roleId")] int? RoleId,
    [property: JsonPropertyName("theirTeam")] IReadOnlyList<int> TheirTeam,
    [property: JsonPropertyName("timerPhase")] string? TimerPhase);

public sealed record CompanionStatus(
    [property: JsonPropertyName("version")] string Version,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("phase")] string Phase,
    [property: JsonPropertyName("clientConnected")] bool ClientConnected,
    [property: JsonPropertyName("lastOpen")] CompanionLastOpen? LastOpen,
    [property: JsonPropertyName("champSelect")] CompanionChampSelectSnapshot? ChampSelect,
    [property: JsonPropertyName("lastPollAt")] string? LastPollAt,
    [property: JsonPropertyName("lastError")] string? LastError);

public sealed record CompanionError([property: JsonPropertyName("error")] string Error);

public sealed record ApplyRunesRequest(
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("primaryStyleId")] int PrimaryStyleId,
    [property: JsonPropertyName("subStyleId")] int SubStyleId,
    [property: JsonPropertyName("selectedPerkIds")] IReadOnlyList<int>? SelectedPerkIds,
    [property: JsonPropertyName("current")] bool Current,
    [property: JsonPropertyName("mode")] string? Mode = null,
    [property: JsonPropertyName("replacePrefix")] string? ReplacePrefix = null);

public sealed record ApplyItemSetsRequest(
    [property: JsonPropertyName("championId")] int ChampionId,
    [property: JsonPropertyName("sets")] IReadOnlyList<JsonElement>? Sets,
    [property: JsonPropertyName("replacePrefix")] string? ReplacePrefix = null,
    /// <summary>
    /// Optional. One already-formatted sentence per consensus block whose
    /// query FAILED, so <c>companion.log</c> can say "no Pro build block
    /// because /api/pros returned 500" instead of leaving a reader to guess
    /// between an outage and a champion nobody has ingested. The web has
    /// emitted this since <c>33785c7</c>; until now the bridge skipped it.
    ///
    /// <para>Raw <see cref="JsonElement"/> rather than <c>string[]</c>: a typed
    /// model throws inside <c>JsonSerializer.Deserialize</c> on the first
    /// malformed member,
    /// which turns the WHOLE request into <c>default</c> and fails an
    /// item-set write over a diagnostic. See
    /// <see cref="ApplyDiagnosticsParser"/>, which validates it separately and
    /// can only ever return fewer lines.</para>
    ///
    /// <para>NOT a version-gated field, and it must never become one: a
    /// diagnostic capable of failing an apply is worse than no diagnostic. An
    /// older web build simply omits it; an older desktop ignores it, because
    /// <c>JsonOptions.Wire</c> leaves <c>UnmappedMemberHandling</c> at its
    /// default of Skip. Both directions are pinned by tests.</para>
    /// </summary>
    [property: JsonPropertyName("diagnostics")] JsonElement? Diagnostics = null);

/// <summary>
/// Success and failure are intentionally separate records. This preserves the
/// exact result union on the wire without adding a JSON discriminator.
/// </summary>
public abstract record ApplyRunesResult
{
    [JsonPropertyName("ok")]
    public abstract bool Ok { get; }
}

public sealed record ApplyRunesSuccess(
    [property: JsonPropertyName("selected")] bool Selected,
    [property: JsonPropertyName("verified")] bool Verified,
    [property: JsonPropertyName("mismatch")] IReadOnlyList<string> Mismatch,
    [property: JsonPropertyName("unchanged")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Unchanged = null) : ApplyRunesResult
{
    [JsonPropertyName("ok")]
    [JsonPropertyOrder(-100)]
    public override bool Ok => true;
}

public sealed record ApplyRunesFailure(
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("hint")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Hint = null) : ApplyRunesResult
{
    [JsonPropertyName("ok")]
    [JsonPropertyOrder(-100)]
    public override bool Ok => false;
}

public abstract record ApplyItemSetsResult
{
    [JsonPropertyName("ok")]
    public abstract bool Ok { get; }
}

public sealed record ApplyItemSetsSuccess([property: JsonPropertyName("count")] int Count) : ApplyItemSetsResult
{
    [JsonPropertyName("ok")]
    [JsonPropertyOrder(-100)]
    public override bool Ok => true;
}

public sealed record ApplyItemSetsFailure(
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("hint")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Hint = null) : ApplyItemSetsResult
{
    [JsonPropertyName("ok")]
    [JsonPropertyOrder(-100)]
    public override bool Ok => false;
}

public sealed record OwnIdentity(
    [property: JsonPropertyName("gameName")] string GameName,
    [property: JsonPropertyName("tagLine")] string TagLine,
    [property: JsonPropertyName("puuid")] string Puuid);

public sealed record LiveSkillState(
    [property: JsonPropertyName("level")] int Level,
    [property: JsonPropertyName("abilities")] LiveAbilityRanks Abilities);

public sealed record LiveAbilityRanks(
    [property: JsonPropertyName("Q")] int Q,
    [property: JsonPropertyName("W")] int W,
    [property: JsonPropertyName("E")] int E,
    [property: JsonPropertyName("R")] int R);

/// <summary>Small immutable credential value used by both polling and writes.</summary>
public sealed record LcuCredentials(
    int Port,
    string Token,
    string Source);

public sealed record LcuResponse(
    bool Ok,
    int StatusCode,
    JsonElement? Content = null,
    string? Body = null)
{
    public bool IsConnectionOrAuthFailure => StatusCode is 0 or 401;
}

public sealed record LcuPage(
    [property: JsonPropertyName("id")] int Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("isDeletable")] bool IsDeletable,
    [property: JsonPropertyName("primaryStyleId")] int PrimaryStyleId,
    [property: JsonPropertyName("subStyleId")] int SubStyleId,
    [property: JsonPropertyName("selectedPerkIds")] IReadOnlyList<int> SelectedPerkIds,
    [property: JsonPropertyName("current")] bool Current);
