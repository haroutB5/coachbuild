namespace CoachBuild.Desktop;

/// <summary>How WPF should render this process's own chrome.</summary>
public enum ChromeRenderMode
{
    /// <summary>WPF's normal hardware (Direct3D) path.</summary>
    Hardware,

    /// <summary>WPF's software rasterizer, process-wide.</summary>
    SoftwareOnly,
}

/// <summary>
/// Whether the process renders its WPF chrome in software.
///
/// <para>THE FAULT (2.1.0, twice on the user's 192-DPI box, 2026-09-08).
/// The research window's WPF chrome painted BLANK WHITE while the WebView2
/// content and the Win32 title bar painted correctly:
/// <c>_evidence/live-2.1.0-pass2/01-champselect.png</c> shows the whole 56px
/// chrome row AND the 35px status bar white, and
/// <c>_research/site-import/user-evidence/white-strip-gaming-pc.jpg</c> shows
/// a partial band — the nav buttons and the tab strip painted, with white to
/// the left of them (the COACHBUILD wordmark) and to the right (the tab-state
/// label).</para>
///
/// <para>WHY THAT IS A PRESENT FAULT AND NOT A LAYOUT ONE. Four independent
/// readings agree, and each one rules something out:</para>
/// <list type="number">
///   <item>THE WHITE IS NOT IN THE XAML. No brush in
///   <c>WebView2Window.xaml</c> is white; every Grid row is covered by an
///   element with an explicit dark background, and the root Grid itself is
///   <c>#081321</c>. There is no fixed-height leftover row and no default
///   brush that could produce it. A white pixel there is the window's
///   uninitialized backing surface, not a fill anyone asked for. Pinned by
///   <c>WebView2WindowChromeTests</c> so a future refactor cannot
///   reintroduce a bare row.</item>
///   <item>ONLY WPF-DRAWN PIXELS ARE AFFECTED. The WebView2 draws into its
///   own child HWND and composes on its own path; the title bar is Win32.
///   Both were correct in every capture. The affected set is exactly "what
///   WPF presents", which also rules out a WebView2 z-order overlap — the
///   white sits ABOVE and BELOW the WebView2's rect, never over it.</item>
///   <item>THE SURVIVING REGIONS ARE THE REDRAWN ONES. In the photo, the
///   parts that painted are the parts that had been invalidated since first
///   paint: the offer bar had just gone Collapsed→Visible, the status bar's
///   text had just changed to "Imported runes for Jhin (ADC) from u.gg", and
///   the tab buttons had just been restyled by a tab change. The two regions
///   that never change — the wordmark and the right-aligned tab-state label —
///   are the two that stayed white. The pass-2 capture, taken before any of
///   those updates, is white across the whole band. One rule covers both
///   states: whatever WPF re-rendered is correct, and the initial present was
///   lost.</item>
///   <item>LAYOUT AND HIT-TESTING WERE FINE THROUGHOUT. The white chrome
///   stayed UIA-interactive, and the harness's RenderTargetBitmap captures of
///   the same tree always came out correct. RenderTargetBitmap rasterizes on
///   the UI thread into its own target, bypassing the window's present path
///   entirely — so a visual tree that renders correctly there and blank on
///   screen localizes the fault to the present, not the tree.</item>
/// </list>
///
/// <para>THE REMEDY. Software rendering removes the hardware present path the
/// fault lives in. It is the default here rather than an opt-in because the
/// cost in THIS app is close to nothing and the failure mode is an unreadable
/// window: WPF paints only a 56px chrome row, a thin offer bar and a 35px
/// status bar, while every page pixel belongs to the WebView2, whose own
/// compositor is unaffected by <c>ProcessRenderMode</c>. The overlay is
/// already effectively software — <c>AllowsTransparency="True"</c> makes it a
/// layered window, which WPF does not hardware-compose in any case.</para>
///
/// <para>NOT A REPLACEMENT FOR THE MANIFEST. 2.1.0 round 2 added
/// per-monitor-v2 via <c>app.manifest</c> for this same symptom and it did not
/// cure it, which is consistent with the reading above: the manifest fixed
/// what WPF BELIEVES the scale is (so layout and hit-testing are right, and
/// they were), not whether the first frame reaches the screen. Both stay.</para>
///
/// <para>REVERSIBLE. <c>--gpu-render</c> restores the hardware path, so a
/// machine where software rendering is the worse trade has a way back that
/// does not need a new build.</para>
/// </summary>
public static class ChromeRenderPolicy
{
    /// <summary>
    /// The render mode for this process. Software unless the hardware path was
    /// explicitly asked for.
    /// </summary>
    public static ChromeRenderMode Decide(bool gpuRenderRequested) =>
        gpuRenderRequested ? ChromeRenderMode.Hardware : ChromeRenderMode.SoftwareOnly;

    /// <summary>
    /// The value <c>RenderOptions.ProcessRenderMode</c> takes for a decision.
    /// Kept as the raw int (<c>RenderMode.Default</c> = 0,
    /// <c>RenderMode.SoftwareOnly</c> = 1) so the decision is testable without
    /// a WPF dispatcher.
    /// </summary>
    public static int ToProcessRenderMode(ChromeRenderMode mode) =>
        mode == ChromeRenderMode.SoftwareOnly ? 1 : 0;
}
