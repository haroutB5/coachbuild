using CoachBuild.Desktop.Web;
using Microsoft.Web.WebView2.Core;
using Xunit;

namespace CoachBuild.Desktop.Tests;

/// <summary>
/// The offline/unreachable state for a site tab.
///
/// <para>These are unit tests rather than a screenshot on purpose, and the
/// reason is worth recording: staging a real navigation failure against a WARM
/// WebView2 profile does not work. u.gg was blocked at the resolver
/// (<c>--host-resolver-rules=MAP u.gg ~NOTFOUND</c>) and the tab still reported
/// ready, because the profile's HTTP cache served the document and the
/// navigation genuinely SUCCEEDED. A "verified offline" screenshot taken that
/// way would have shown a working page.</para>
/// </summary>
public sealed class SitePageErrorTests
{
    [Theory]
    [InlineData(CompanionTab.UGg, "u.gg")]
    [InlineData(CompanionTab.Coachless, "Coachless")]
    public void A_failed_site_load_names_the_site_not_the_app(CompanionTab tab, string expected)
    {
        var message = WebView2Window.PageErrorMessage(
            tab,
            CoreWebView2WebErrorStatus.HostNameNotResolved);

        // Naming the site is the point: a broken u.gg must not read as
        // CoachBuild itself being down.
        Assert.StartsWith(expected, message, StringComparison.Ordinal);
        Assert.DoesNotContain("CoachBuild", message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_failed_hosted_load_still_names_the_app()
    {
        var message = WebView2Window.PageErrorMessage(
            CompanionTab.Companion,
            CoreWebView2WebErrorStatus.Disconnected);

        Assert.StartsWith("CoachBuild", message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The underlying status is carried through. Without it every failure reads
    /// identically and "check your connection" is the only diagnosis anyone can
    /// ever offer — including for a certificate error, where it is wrong.
    /// </summary>
    [Fact]
    public void The_error_status_is_reported_rather_than_flattened()
    {
        var dns = WebView2Window.PageErrorMessage(
            CompanionTab.UGg, CoreWebView2WebErrorStatus.HostNameNotResolved);
        var cert = WebView2Window.PageErrorMessage(
            CompanionTab.UGg, CoreWebView2WebErrorStatus.CertificateCommonNameIsIncorrect);

        Assert.Contains("HostNameNotResolved", dns, StringComparison.Ordinal);
        Assert.Contains("CertificateCommonNameIsIncorrect", cert, StringComparison.Ordinal);
        Assert.NotEqual(dns, cert);
    }

    /// <summary>
    /// A network failure must never be dressed up as a missing runtime. The
    /// repair wording belongs to the WebView2 fallback view and sends the user
    /// to reinstall software they already have.
    /// </summary>
    [Fact]
    public void A_network_failure_never_offers_the_webview2_repair_wording()
    {
        var message = WebView2Window
            .PageErrorMessage(CompanionTab.Coachless, CoreWebView2WebErrorStatus.Disconnected)
            .ToLowerInvariant();

        Assert.DoesNotContain("webview2", message, StringComparison.Ordinal);
        Assert.DoesNotContain("runtime", message, StringComparison.Ordinal);
        Assert.DoesNotContain("repair", message, StringComparison.Ordinal);
        // Control: it must still tell the user what to do.
        Assert.Contains("try again", message, StringComparison.Ordinal);
    }
}
