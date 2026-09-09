using CoachBuild.Desktop.Web;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The runes page's first paint is not its answer.
///
/// <para>Field log 2026-09-08: <c>Coachless yielded no rune build (no keystone
/// on the runes page carried a WPA reading)</c> — from the same page whose
/// captured fixture yields a complete rune page. The page is Angular and paints
/// its rune cards before the WPA deltas arrive, so the read that ran the
/// instant NavigationCompleted fired saw cards with no numbers. The extractor
/// marks exactly those absences <c>retryable</c>; this is the C# half that
/// recognizes the mark. It must FAIL CLOSED — an unrecognized or unmarked
/// failure has to reach the log on its first occurrence rather than being
/// swallowed by an eight-second wait.</para>
/// </summary>
public sealed class RunesSettleProbeTests
{
    [Fact]
    public void A_marked_failure_is_retryable_bare_and_double_encoded()
    {
        const string bare =
            """{"error":"no keystone on the runes page carried a WPA reading (4 cards rendered, 4 with a readable id, 0 with a WPA reading)","retryable":true}""";
        Assert.True(RunesSettleProbe.IsRetryable(bare));

        // ExecuteScriptAsync hands back the JS string JSON-ENCODED, which is
        // the shape production actually meets. A probe that only handled the
        // bare object would never fire once.
        var wrapped = System.Text.Json.JsonSerializer.Serialize(bare);
        Assert.True(RunesSettleProbe.IsRetryable(wrapped));
    }

    /// <summary>
    /// 2.2.2: the ITEMS read uses this same probe. Field log 2026-09-09
    /// 13:11:17, Viktor mid — the exact reason string, off a page that renders
    /// six slot tables, five seconds before the runes leg of the SAME run
    /// settled over 4 reads and succeeded.
    /// </summary>
    [Fact]
    public void The_items_reads_pre_hydration_census_is_retryable_too()
    {
        const string notYet =
            """{"error":"every item slot on the page was empty (0 tables on the page, 0 with a slot title, 0 data rows) -- coachless: slot Starter is not on the page -- omitted","retryable":true}""";
        Assert.True(RunesSettleProbe.IsRetryable(notYet));
        Assert.True(RunesSettleProbe.IsRetryable(System.Text.Json.JsonSerializer.Serialize(notYet)));

        // ...and the same census WITHOUT the mark — a page that rendered its
        // rows and simply has nothing readable — is answered, not waited on.
        const string rendered =
            """{"error":"every item slot on the page was empty (8 tables on the page, 8 with a slot title, 58 data rows)"}""";
        Assert.False(RunesSettleProbe.IsRetryable(rendered));
    }

    [Fact]
    public void A_successful_payload_is_not_retryable()
    {
        const string payload =
            """{"source":"coachless","championSlug":"nasus","role":"top","runes":{"primaryStyleId":8000,"subStyleId":8400,"perkIds":[8021,8009,9105,8017,8473,8451],"shardIds":[5007,5010,5013]},"itemBlocks":[]}""";
        Assert.False(RunesSettleProbe.IsRetryable(payload));
        Assert.False(RunesSettleProbe.IsRetryable(System.Text.Json.JsonSerializer.Serialize(payload)));
    }

    [Fact]
    public void An_unmarked_failure_is_reported_rather_than_waited_on()
    {
        // "not a champion runes page" can never become one by waiting.
        Assert.False(RunesSettleProbe.IsRetryable("""{"error":"not a champion runes page"}"""));
        // The mark alone, with no error, is not a failure to retry either.
        Assert.False(RunesSettleProbe.IsRetryable("""{"retryable":true}"""));
        // ...nor a non-true marker.
        Assert.False(RunesSettleProbe.IsRetryable("""{"error":"x","retryable":"true"}"""));
        Assert.False(RunesSettleProbe.IsRetryable("""{"error":"x","retryable":false}"""));
    }

    [Fact]
    public void Anything_unreadable_fails_closed()
    {
        Assert.False(RunesSettleProbe.IsRetryable(null));
        Assert.False(RunesSettleProbe.IsRetryable(""));
        Assert.False(RunesSettleProbe.IsRetryable("   "));
        Assert.False(RunesSettleProbe.IsRetryable("not json at all"));
        Assert.False(RunesSettleProbe.IsRetryable("\"\""));
        Assert.False(RunesSettleProbe.IsRetryable("[]"));
        Assert.False(RunesSettleProbe.IsRetryable("null"));
    }

    /// <summary>
    /// The budget is bounded and finite: a page that never settles must give
    /// its last typed failure to the log, not spin.
    /// </summary>
    [Fact]
    public void The_settle_budget_is_bounded()
    {
        Assert.True(RunesSettleProbe.SettleDelayMs > 0);
        Assert.True(RunesSettleProbe.SettleTimeoutMs >= RunesSettleProbe.SettleDelayMs);
        // ~8s of 400ms reads: enough for a hydrating Angular view, short
        // enough that a champ-select import is not held up by a dead page.
        Assert.Equal(8000, RunesSettleProbe.SettleTimeoutMs);
        Assert.Equal(20, RunesSettleProbe.SettleTimeoutMs / RunesSettleProbe.SettleDelayMs);
    }

    /// <summary>
    /// The shipped extractor must actually emit the mark this probe reads, and
    /// must not emit it for the one failure that can never resolve. Without
    /// this, the two halves could drift apart and the poll would silently
    /// become a single read again.
    /// </summary>
    [Fact]
    public void The_shipped_runes_script_marks_the_growable_absences_and_only_those()
    {
        var script = SiteImportExtractors.CoachlessRunesScript;

        // Control: both failure helpers exist.
        Assert.Contains("function fail(message)", script, StringComparison.Ordinal);
        Assert.Contains("function failWait(message)", script, StringComparison.Ordinal);
        Assert.Contains("retryable: true", script, StringComparison.Ordinal);

        // The WPA-absent failures wait...
        Assert.Contains(
            "failWait('no keystone on the runes page carried a WPA reading",
            script,
            StringComparison.Ordinal);
        Assert.Contains("failWait('shard row '", script, StringComparison.Ordinal);
        Assert.Contains("failWait('primary rune row '", script, StringComparison.Ordinal);
        // ...and carry the census that a timed-out settle reports.
        Assert.Contains("cards rendered", script, StringComparison.Ordinal);
        Assert.Contains("with a WPA reading", script, StringComparison.Ordinal);

        // ...but a URL that is not a runes page does not.
        Assert.Contains("fail('not a champion runes page')", script, StringComparison.Ordinal);
    }
}
