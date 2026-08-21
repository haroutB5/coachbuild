using System.Text.Json;
using System.Text.Json.Serialization;

namespace CoachBuild.Core;

/// <summary>
/// The three moments a ranked-LP sample is taken, per the approved spec
/// (docs/superpowers/specs/2026-08-20-session-record-lp-design.md, §5).
///
/// <para>The trigger does NOT travel on the wire. §3 fixes the <c>source</c>
/// column's vocabulary at <c>'companion' | 'cron' | 'page'</c>, so all three of
/// these post <c>companion</c> and the moment survives only in
/// <c>companion.log</c>. That is a deliberate reading of the spec rather than an
/// oversight — see HANDOFF-lp-capture.md.</para>
/// </summary>
public enum RankCaptureTrigger
{
    /// <summary>The companion process just started.</summary>
    AppStart,

    /// <summary>A transition INTO champ select. The "before this game" bracket edge.</summary>
    ChampSelect,

    /// <summary>A transition OUT of an in-game phase. The "after this game" bracket edge.</summary>
    GameEnd,
}

/// <summary>One ranked-solo reading: where the account sits on the ladder right now.</summary>
/// <param name="Tier">Uppercase League tier — IRON..CHALLENGER. Never blank, never NONE.</param>
/// <param name="Division">Uppercase Roman division, or null for an apex tier / an absent value.</param>
/// <param name="LeaguePoints">LP within the division; unbounded above in apex tiers.</param>
/// <param name="CumulativeLp">Riot's own absolute ladder integer, when the LCU supplied one.</param>
public sealed record RankSample(
    string Tier,
    string? Division,
    int LeaguePoints,
    int? CumulativeLp = null);

/// <summary>
/// PURE readers for the LCU's ranked-stats document.
///
/// <para><b>Where this came from — and what is still unproven.</b> Not memory
/// and not a blog post. The evidence is the installed client's own request
/// traces, <c>C:\Riot Games\League of Legends\Logs\LeagueClient Logs\*-tracing.json</c>,
/// written by eight real sessions between 2026-07-27 and 2026-08-09.</para>
///
/// <para><b>VERIFIED — the route.</b> <see cref="CurrentRankedStatsPath"/> appears
/// 56 times across those eight sessions as a <c>br1</c> record with
/// <c>"me":2</c>, the same method code carried by
/// <c>/lol-summoner/v1/current-summoner</c>, which the companion already GETs
/// successfully. It is a real route this exact install serves, not a guess.</para>
///
/// <para><b>VERIFIED — the field vocabulary.</b> One session captured a whole
/// ranked-stats body verbatim: record <c>{"t":"re1",...,"ri":14}</c> in
/// <c>2026-07-27T14-00-20_3788_LeagueClient-tracing.json</c>, whose matching
/// <c>er1</c> request is
/// <c>https://euw-red.lol.sgp.pvp.net/leagues-ledge/v2/signedRankedStats</c>.
/// It is <c>{"queues":[{"queueType":"RANKED_SOLO_5x5","tier":"PLATINUM",
/// "rank":"IV","leaguePoints":91,"provisionalGamesRemaining":0,...}]}</c>. Every
/// field name read below is taken from that document. Unranked queues in it
/// carry <c>tier: null</c> and <c>rank: null</c> with <c>leaguePoints: 0</c> —
/// which is exactly why <see cref="ReadEntry"/> demands a tier BEFORE it will
/// look at LP.</para>
///
/// <para><b>UNVERIFIED — the LCU's own serialisation.</b> That capture is the
/// platform response the LCU consumes, one hop UPSTREAM of the LCU route. The
/// client is free to re-serialise it under its own model on the way out, and its
/// model is the <c>queueMap</c> object form. Nothing on this box has ever
/// recorded the LCU's reply body, so both shapes are read: the observed
/// <c>queues</c> array and the modelled <c>queueMap</c> object. Every reader
/// fails to null rather than assuming. See HANDOFF-lp-capture.md for the single
/// command that closes this last gap once the user has the client open.</para>
/// </summary>
public static class RankedStats
{
    /// <summary>
    /// The logged-in account's own ranked stats. Confirmed present in the
    /// installed client's route table; see the type remarks.
    /// </summary>
    public const string CurrentRankedStatsPath = "/lol-ranked/v1/current-ranked-stats";

    /// <summary>
    /// Ranked solo/duo. HARD RULE 4 (<c>lib/mystats/queues.ts</c>) counts queue
    /// 420 and nothing else, and spec §1 decision 2 keeps LP scoped the same
    /// way, so flex is read past rather than merged.
    /// </summary>
    public const string SoloQueueKey = "RANKED_SOLO_5x5";

    /// <summary>Tiers with no division and unbounded LP (spec §2).</summary>
    private static readonly string[] ApexTiers = ["MASTER", "GRANDMASTER", "CHALLENGER"];

    /// <summary>
    /// The ranked-solo reading in <paramref name="body"/>, or null if there
    /// isn't one.
    ///
    /// <para>ALL OR NOTHING, the same discipline as <c>ConvertTo-LiveSkillState</c>
    /// and <see cref="OwnIdentityConverter"/>: a partial reading here would be a
    /// WRONG number rather than a weaker one, because the consumer subtracts two
    /// of these to get an LP delta. A missing tier defaulted to IRON would print
    /// a four-figure loss.</para>
    ///
    /// <para>Null is returned for: a non-object body, no solo-queue entry, an
    /// unranked/placement account, a blank tier, or a missing/negative LP.</para>
    /// </summary>
    public static RankSample? ReadSoloQueue(JsonElement? body)
    {
        if (body is not { } root || root.ValueKind != JsonValueKind.Object) return null;
        var entry = FindSoloQueueEntry(root);
        return entry is null ? null : ReadEntry(entry.Value);
    }

    /// <summary>
    /// Finds the solo-queue entry under either shape the client models.
    ///
    /// <para><c>queues</c> is the array form, and it is the one actually
    /// OBSERVED on this box (see the type remarks). <c>queueMap</c> is the
    /// object form the LCU's own model uses, and the LCU's reply is the hop that
    /// is still unverified. Reading both costs one branch and removes an entire
    /// class of "shipped against the wrong one" — which is exactly the risk an
    /// unverified body shape carries. <c>queueMap</c> is tried first only
    /// because a key lookup is cheaper than a scan; neither order is
    /// meaningful.</para>
    /// </summary>
    private static JsonElement? FindSoloQueueEntry(JsonElement root)
    {
        if (root.TryGetProperty("queueMap", out var map) && map.ValueKind == JsonValueKind.Object)
        {
            if (map.TryGetProperty(SoloQueueKey, out var direct) && direct.ValueKind == JsonValueKind.Object)
                return direct;
            foreach (var property in map.EnumerateObject())
            {
                if (property.Value.ValueKind == JsonValueKind.Object &&
                    string.Equals(property.Name, SoloQueueKey, StringComparison.OrdinalIgnoreCase))
                    return property.Value;
            }
        }

        if (root.TryGetProperty("queues", out var queues) && queues.ValueKind == JsonValueKind.Array)
        {
            foreach (var candidate in queues.EnumerateArray())
            {
                if (candidate.ValueKind != JsonValueKind.Object) continue;
                var queueType = ComplianceRules.NonBlankString(candidate, "queueType");
                if (string.Equals(queueType, SoloQueueKey, StringComparison.OrdinalIgnoreCase))
                    return candidate;
            }
        }

        return null;
    }

    private static RankSample? ReadEntry(JsonElement entry)
    {
        // Placements have no ladder position, so there is no LP to difference.
        // Skipping produces `unavailable` (spec §6), which is the honest render;
        // recording a provisional 0 would produce a confident wrong number.
        //
        // TWO field names, and the first one is the one that actually fires. The
        // captured body (see the type remarks) has no `isProvisional` at all —
        // it says `provisionalGamesRemaining`, and a draft that checked only
        // `isProvisional` would have been dead code against a real client while
        // reading as though it were covered. `isProvisional` is kept because the
        // LCU's own model does carry it and the LCU's reply is the shape still
        // unverified here.
        if (IsInPlacements(entry)) return null;

        var tier = NormalizeTier(ComplianceRules.NonBlankString(entry, "tier"));
        if (tier is null) return null;

        var lp = ReadLeaguePoints(entry);
        if (lp is null) return null;

        return new RankSample(
            tier,
            NormalizeDivision(tier, ReadDivision(entry)),
            lp.Value,
            ReadCumulativeLp(entry));
    }

    /// <summary>
    /// True while the account is still playing placement games for this queue.
    ///
    /// <para><c>provisionalGamesRemaining</c> is the observed field and is
    /// authoritative; <c>isProvisional</c> is the LCU model's boolean and is
    /// checked second. A remaining count that is present but not a number is
    /// treated as NOT in placements: refusing to sample on an unreadable field
    /// would silently delete bracket edges for every session.</para>
    /// </summary>
    private static bool IsInPlacements(JsonElement entry)
    {
        if (entry.TryGetProperty("provisionalGamesRemaining", out var remaining) &&
            remaining.ValueKind == JsonValueKind.Number &&
            remaining.TryGetInt32(out var count) &&
            count > 0)
            return true;

        return entry.TryGetProperty("isProvisional", out var provisional) &&
               provisional.ValueKind == JsonValueKind.True;
    }

    /// <summary>
    /// <c>leaguePoints</c> is the name in the captured body. <c>lp</c> is
    /// accepted as a second name only so a schema rename degrades into a working
    /// read rather than a silent stop.
    /// </summary>
    private static int? ReadLeaguePoints(JsonElement entry)
    {
        foreach (var name in new[] { "leaguePoints", "lp" })
        {
            if (!entry.TryGetProperty(name, out var value)) continue;
            if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var number) && number >= 0)
                return number;
        }
        return null;
    }

    /// <summary>
    /// Riot's absolute ladder position. This field is optional: older or
    /// alternate LCU shapes without it still produce a sample, and the server
    /// derives the same integer from tier/division/LP as its tested fallback.
    /// A malformed value is treated exactly like an absent one so an optional
    /// optimization can never cost the bracket edge itself.
    /// </summary>
    private static int? ReadCumulativeLp(JsonElement entry)
    {
        if (!entry.TryGetProperty("cumulativeLp", out var value)) return null;
        return value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out var number)
            && number >= 0
                ? number
                : null;
    }

    /// <summary>
    /// <c>rank</c> is the name in the captured body; <c>division</c> is the LCU
    /// model's name for the same field and is tried first only because it is the
    /// unambiguous one. <c>rank</c> is checked second because on some LCU
    /// resources it means the whole standing rather than the division.
    /// </summary>
    private static string? ReadDivision(JsonElement entry) =>
        ComplianceRules.NonBlankString(entry, "division") ??
        ComplianceRules.NonBlankString(entry, "rank");

    /// <summary>Uppercases and rejects the two ways the client spells "no rank".</summary>
    internal static string? NormalizeTier(string? tier)
    {
        var value = tier?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(value)) return null;
        return value is "NONE" or "UNRANKED" ? null : value;
    }

    /// <summary>
    /// Null for an apex tier, unconditionally.
    ///
    /// <para>Master, Grandmaster and Challenger have no divisions (spec §2), and
    /// the client is not consistent about whether it says <c>"NA"</c>, <c>"I"</c>
    /// or nothing at all in that slot. A literal <c>"I"</c> forwarded on a
    /// Master account would tell the ladder module the account is one division
    /// off the apex floor and quietly change the arithmetic; null cannot.</para>
    /// </summary>
    internal static string? NormalizeDivision(string tier, string? division)
    {
        if (IsApex(tier)) return null;
        var value = division?.Trim().ToUpperInvariant();
        if (string.IsNullOrEmpty(value)) return null;
        return value == "NA" ? null : value;
    }

    internal static bool IsApex(string tier) =>
        ApexTiers.Contains(tier.Trim().ToUpperInvariant(), StringComparer.Ordinal);
}

/// <summary>
/// The body posted to <c>POST /api/mystats/rank-sample</c> (spec §4).
///
/// <para><b>This is NOT §4's literal request shape, and the difference is
/// load-bearing.</b> §4 asks for a <c>puuid</c>. The companion cannot supply one
/// that means anything: the League client's puuid is a 36-char local UUID, not
/// the Riot puuid <c>coachbuild.my_matches</c> is keyed on — the invariant is
/// stated in CLAUDE.md ("My Stats", invariant 1) and encoded in
/// <c>lib/mystats/accountRequest.ts</c>, whose <c>detect</c> mode deliberately
/// carries NO puuid for exactly this reason and re-resolves identity from
/// gameName + tagLine server-side. Filling §4's <c>puuid</c> from the LCU would
/// write a time series that joins to nothing, and would do it silently. So this
/// carries the identity in the form the server has already proven it can
/// resolve. See HANDOFF-lp-capture.md.</para>
/// </summary>
public sealed record RankSampleBody(
    [property: JsonPropertyName("gameName")] string GameName,
    [property: JsonPropertyName("tagLine")] string TagLine,
    [property: JsonPropertyName("tier")] string Tier,
    [property: JsonPropertyName("division")] string? Division,
    [property: JsonPropertyName("lp")] int Lp,
    [property: JsonPropertyName("cumulativeLp")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    int? CumulativeLp,
    [property: JsonPropertyName("observedAt")] string ObservedAt,
    [property: JsonPropertyName("source")] string Source)
{
    /// <summary>
    /// Spec §3's <c>source</c> vocabulary is <c>'companion' | 'cron' | 'page'</c>.
    /// Every desktop-side sample is <c>companion</c> regardless of trigger.
    /// </summary>
    public const string CompanionSource = "companion";

    public static RankSampleBody Create(OwnIdentity identity, RankSample sample, DateTimeOffset observedAt) =>
        new(
            identity.GameName,
            identity.TagLine,
            sample.Tier,
            sample.Division,
            sample.LeaguePoints,
            sample.CumulativeLp,
            observedAt.ToUniversalTime().ToString("O"),
            CompanionSource);
}

/// <summary>What a POST attempt did. Never an exception — see <see cref="RankCaptureService"/>.</summary>
public enum RankSamplePostResult
{
    /// <summary>The row was accepted (or was already there — the endpoint is idempotent).</summary>
    Posted,

    /// <summary>The endpoint answered, and said no (bad secret, unconfigured server, bad body).</summary>
    Rejected,

    /// <summary>Offline, timed out, 5xx, unparseable — unknown whether anything landed.</summary>
    Failed,
}

/// <summary>The POST half, abstracted so a test needs no socket.</summary>
public interface IRankSampleSink
{
    Task<RankSamplePostResult> PostAsync(RankSampleBody body, string secret, CancellationToken cancellationToken);
}
