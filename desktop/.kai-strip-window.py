import io

p = 'src/CoachBuild.Desktop/Overlay/OverlayWindow.xaml.cs'
s = io.open(p, encoding='utf-8').read()
original_len = len(s)


def cut(open_marker, close_marker):
    """Delete the span [open_marker, close_marker) exactly once."""
    global s
    start = s.index(open_marker)
    end = s.index(close_marker, start)
    s = s[:start] + s[end:]


def sub(old, new, count=1):
    global s
    assert s.count(old) == count, (s.count(old), old[:70])
    s = s.replace(old, new)


# ── fields ───────────────────────────────────────────────────────────────────
sub("""    private CalibrationGeometry? _workingCalibration;
    // One working copy PER target, so Tab can switch between the ability bar
    // and the item row without throwing away edits the player has not saved
    // yet. Enter commits every target that was touched; Esc discards all of
    // them. Anything less makes Tab a trap.
    private readonly Dictionary<CalibrationTarget, CalibrationGeometry> _workingByTarget = [];

    // WHICH targets the player actually MOVED this visit. "Enter commits every
    // target that was touched" was true of the working copies and false of the
    // saves: `_workingByTarget` is seeded from LoadCalibrationOrDefault the
    // instant a target is opened or Tabbed to, so merely LOOKING at the item
    // row and pressing Enter used to persist `ItemRowScaledDefault` as though
    // it were a measurement.
    //
    // That is not a cosmetic distinction. The item row deliberately draws
    // NOTHING until it has been positioned (TryLoadCalibration returns null
    // rather than a default) precisely so an invented constant never paints
    // numbers over the wrong part of the game — and the 2026-08-20 field log
    // shows exactly that guarantee defeated: `badges: 6 shown at 544x904
    // size 59 pitch 69` on a 2560x1440 display is ItemRowScaledDefault to the
    // pixel, roughly 210 px BELOW the shop's Situational row.
    private readonly HashSet<CalibrationTarget> _touchedTargets = [];
    private CalibrationTarget _adjustTarget = CalibrationTarget.SkillOrder;
    private IReadOnlyList<CoachBuild.Core.SituationalDelta> _situational = [];
""",
"""    private CalibrationGeometry? _workingCalibration;

    // Whether the player actually MOVED the box this visit, as opposed to
    // merely opening adjust mode and pressing Enter.
    //
    // Not a cosmetic distinction, and it is kept from 1.0.19 deliberately: an
    // untouched default is a guess, not a calibration, and writing one as
    // though it were a measurement is what put the (now removed) item numbers
    // 210 px below their row in the field. The same rule is cheap here and
    // means "saved" in the log always describes a decision the player made.
    private bool _adjustMoved;
""")

cut("""    /// <summary>
    /// The shop set the current numbers were computed for and where the
    /// Situational block sits inside it, or empty when there are no numbers.""",
    """    private HwndSource? _hwndSource;""")

# ── public surface: AdjustTarget / preview rects / badge flags ───────────────
cut("""    /// <summary>Which calibration the arrow keys are currently moving.</summary>
    public CalibrationTarget AdjustTarget => _adjustTarget;

    /// <summary>
    /// The rects the item-row PREVIEW pills were last painted at, in order.""",
    """    /// <summary>
    /// The geometry adjust mode last drew at, in DIPs — the value""")

sub("""    /// <para>Exposed so the WYSIWYG pair can be asserted against a REAL live
    /// render rather than against a second copy of the same arithmetic: a test
    /// that re-derived this geometry could agree with a preview that disagrees
    /// with the game, which is precisely the class of bug being fixed.</para>
    /// </summary>
    public CalibrationGeometry? LastAdjustGeometry { get; private set; }

    /// <summary>True while the situational numbers are on screen.</summary>
    public bool IsDrawingBadges { get; private set; }
""",
"""    /// <para>Exposed so a test can assert what the player was shown against a
    /// value the window actually used, rather than against a second copy of the
    /// same arithmetic.</para>
    /// </summary>
    public CalibrationGeometry? LastAdjustGeometry { get; private set; }
""")

# ── SetSituationalDeltas / SameDeltas / SetShopOpen / SetForceBadges ─────────
cut("""    /// <summary>
    /// The set label the current numbers arrived with, or empty. Read-only""",
    """    public event Action<bool>? AdjustmentStateChanged;""")

# ── RenderCurrentState: drop badge branches ─────────────────────────────────
s = s.replace("""            IsDrawingHighlight = false;
            IsDrawingBadges = false;
            HasRenderableSkillOrder = false;""",
"""            IsDrawingHighlight = false;
            HasRenderableSkillOrder = false;""")

sub("""        var physicalCalibration = _settingsStore.LoadCalibration(_display.Resolution);
        var dipCalibration = CalibrationGeometry.ForDpi(physicalCalibration, _display.DpiX, 96);
        var badges = BuildBadgeInput();
        _renderer.Render(RootCanvas, renderState, _settings, _display.Resolution, dipCalibration, badges);
        var outcome = DescribeRenderOutcome(renderState, dipCalibration, _display);
        IsDrawingHighlight = outcome.StartsWith("highlight ", StringComparison.Ordinal);
        IsDrawingBadges = badges.WillDraw;
        HasRenderableSkillOrder = renderState.HasRenderableData;
        ReportKitAnomaly(renderState);
        ReportOverlayReason(outcome);
        ReportBadgeReason(badges);
    }""",
"""        var physicalCalibration = _settingsStore.LoadCalibration(_display.Resolution);
        var dipCalibration = CalibrationGeometry.ForDpi(physicalCalibration, _display.DpiX, 96);
        _renderer.Render(RootCanvas, renderState, _settings, _display.Resolution, dipCalibration);
        var outcome = DescribeRenderOutcome(renderState, dipCalibration, _display);
        IsDrawingHighlight = outcome.StartsWith("highlight ", StringComparison.Ordinal);
        HasRenderableSkillOrder = renderState.HasRenderableData;
        ReportKitAnomaly(renderState);
        ReportOverlayReason(outcome);
    }""")

# ── BuildBadgeInput + ReportBadgeReason ─────────────────────────────────────
cut("""    /// <summary>
    /// The situational numbers' inputs for this frame: where they go, what they
    /// say, and whether the shop is believed open.""",
    """    /// <summary>
    /// Names a champion whose ranks do not add up against its level, once.""")

# ── BeginAdjustment / WorkingFor / SwitchAdjustTarget / Describe ─────────────
sub("""    public void BeginCalibration() => BeginAdjustment();

    public void BeginAdjustment() => BeginAdjustment(CalibrationTarget.SkillOrder);

    public void BeginAdjustment(CalibrationTarget target)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => BeginAdjustment(target));
            return;
        }

        if (_adjusting)
        {
            // Already adjusting: treat a second request as "switch to that
            // target" rather than a no-op, so the tray's two items always do
            // what they say even if one is used while the other is open.
            SwitchAdjustTarget(target);
            return;
        }

        _wasVisibleBeforeAdjustment = IsVisible;""",
"""    public void BeginCalibration() => BeginAdjustment();

    public void BeginAdjustment()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(BeginAdjustment);
            return;
        }

        if (_adjusting) return;

        _wasVisibleBeforeAdjustment = IsVisible;""")

sub("""        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _adjustTarget = target;
        _workingCalibration = WorkingFor(target);
        _adjusting = true;
        AdjustmentStateChanged?.Invoke(true);
        SetInteractive(true);
        Activate();
        Focus();
        Diagnostics?.Invoke($"overlay: adjust mode entered for {Describe(target)}");
        RenderAdjustment();
    }

    /// <summary>The working copy for a target: whatever is being edited, else the saved value, else the default.</summary>
    private CalibrationGeometry WorkingFor(CalibrationTarget target)
    {
        if (_workingByTarget.TryGetValue(target, out var inProgress)) return inProgress;
        return _display is null
            ? CalibrationGeometry.Reference
            : _settingsStore.LoadCalibrationOrDefault(target, _display.Resolution);
    }

    private void SwitchAdjustTarget(CalibrationTarget target)
    {
        if (!_adjusting || target == _adjustTarget) return;
        if (_workingCalibration is not null) _workingByTarget[_adjustTarget] = _workingCalibration;
        _adjustTarget = target;
        _workingCalibration = WorkingFor(target);
        Diagnostics?.Invoke($"overlay: adjust mode switched to {Describe(target)}");
        RenderAdjustment();
    }

    private static string Describe(CalibrationTarget target) => target == CalibrationTarget.ItemRow
        ? "the situational item numbers"
        : "the skill-order box";
""",
"""        _adjustMoved = false;
        _workingCalibration = _display is null
            ? CalibrationGeometry.Reference
            : _settingsStore.LoadCalibration(_display.Resolution);
        _adjusting = true;
        AdjustmentStateChanged?.Invoke(true);
        SetInteractive(true);
        Activate();
        Focus();
        Diagnostics?.Invoke($"overlay: adjust mode entered for {AdjustTargetName}");
        RenderAdjustment();
    }

    /// <summary>
    /// What the arrow keys are moving, in one place so the entry line, the save
    /// line and the on-screen heading cannot come to disagree.
    /// </summary>
    private const string AdjustTargetName = "the skill-order box";
""")

# ── OnDisplayChanged ────────────────────────────────────────────────────────
sub("""                // Re-derive for the target currently being adjusted, and drop
                // every working copy: they were keyed to the display that has
                // just gone away.
                _workingByTarget.Clear();
                _touchedTargets.Clear();
                _workingCalibration = _settingsStore.LoadCalibrationOrDefault(_adjustTarget, display.Resolution);
                RenderAdjustment();""",
"""                // Re-derive, and drop the working copy: it was keyed to the
                // display that has just gone away.
                _adjustMoved = false;
                _workingCalibration = _settingsStore.LoadCalibration(display.Resolution);
                RenderAdjustment();""")

# ── HandleAdjustKey ─────────────────────────────────────────────────────────
sub("""    /// <para>Split out of the WPF handler so the rule that decides what gets
    /// SAVED is testable. It is not a cosmetic rule: through 1.0.18 an adjust
    /// session that moved nothing still persisted the item row's invented
    /// default, and that is what put the badges 210 px below the shop row in
    /// the field. A guarantee about which keypresses count cannot be pinned by
    /// a test that has to synthesise <c>KeyEventArgs</c> against a live
    /// <c>PresentationSource</c>.</para>""",
"""    /// <para>Split out of the WPF handler so the rule that decides what gets
    /// SAVED is testable. It is not a cosmetic rule: through 1.0.18 an adjust
    /// session that moved nothing still persisted an invented default as though
    /// it were a measurement. A guarantee about which keypresses count cannot
    /// be pinned by a test that has to synthesise <c>KeyEventArgs</c> against a
    /// live <c>PresentationSource</c>.</para>""")

sub("""            case Key.Tab:
                // Switches which overlay the arrow keys move. Handled here
                // rather than on a second global accelerator: 1.0.13 removed
                // Ctrl+Shift+S because a global hotkey is taken from every
                // other application for as long as this app runs, and that
                // argument did not stop being true for a second one.
                SwitchAdjustTarget(_adjustTarget == CalibrationTarget.SkillOrder
                    ? CalibrationTarget.ItemRow
                    : CalibrationTarget.SkillOrder);
                return true;
            case Key.Enter:""",
"""            case Key.Enter:""")

sub("""        if (handled && moved)
        {
            _touchedTargets.Add(_adjustTarget);
            _workingCalibration = geometry.Normalize();""",
"""        if (handled && moved)
        {
            _adjustMoved = true;
            _workingCalibration = geometry.Normalize();""")

# ── SaveAdjustment ──────────────────────────────────────────────────────────
sub("""        // EVERY target touched this session, not just the one on screen. Tab
        // lets the player move both overlays in one visit, and saving only the
        // visible one would silently drop the other half of their work.
        //
        // TOUCHED, and that word now means MOVED. Until 1.0.19 it meant
        // "visited": `_workingByTarget` is seeded the moment a target is opened
        // or Tabbed to, so tray -> "Adjust item numbers" -> Enter persisted
        // `ItemRowScaledDefault` — a constant the model itself documents as "a
        // starting position, not a measurement" — as though the player had
        // measured it. That is how the field log came to read `badges: 6 shown
        // at 544x904 size 59 pitch 69`, which is that default to the pixel on a
        // 2560x1440 screen, about 210 px below the row it is meant to sit on.
        // Saving nothing is the honest outcome of an adjust session in which
        // nothing was adjusted.
        _workingByTarget[_adjustTarget] = _workingCalibration;
        var saved = 0;
        foreach (var (target, geometry) in _workingByTarget)
        {
            if (!_touchedTargets.Contains(target)) continue;
            _settingsStore.SaveCalibration(target, _display.Resolution, geometry);
            saved++;
            Diagnostics?.Invoke(
                $"overlay: saved {Describe(target)} at {geometry.FirstBoxCenterX:0}x{geometry.CenterY:0}"
                + $" size {geometry.BoxSize:0} pitch {geometry.Spacing:0}"
                + $" for {_display.Resolution.Key}");
        }

        if (saved == 0)
        {
            Diagnostics?.Invoke(
                "overlay: adjust mode saved nothing - neither overlay was moved."
                + " An untouched default is a guess, not a calibration, so it is not written."
                + " Use the arrow keys (Shift for x10), +/- for size and [/] for spacing,"
                + " then press Enter.");
        }

        _settings = _settingsStore.Read();
        _adjusting = false;
        _workingCalibration = null;
        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _lastBadgeReason = null;
        AdjustmentStateChanged?.Invoke(false);""",
"""        // MOVED, not merely visited. Saving nothing is the honest outcome of
        // an adjust session in which nothing was adjusted: an untouched default
        // is a guess, and writing one as though the player had measured it is
        // exactly how the removed item-number row ended up 210 px below its
        // target in the field. The ability HUD's default is a real measurement,
        // so the cost of the rule here is nil and the meaning of "saved" in the
        // log stays honest.
        if (_adjustMoved)
        {
            var geometry = _workingCalibration;
            _settingsStore.SaveCalibration(_display.Resolution, geometry);
            Diagnostics?.Invoke(
                $"overlay: saved {AdjustTargetName} at {geometry.FirstBoxCenterX:0}x{geometry.CenterY:0}"
                + $" size {geometry.BoxSize:0} pitch {geometry.Spacing:0}"
                + $" for {_display.Resolution.Key}");
        }
        else
        {
            Diagnostics?.Invoke(
                "overlay: adjust mode saved nothing - the overlay was not moved."
                + " An untouched default is a guess, not a calibration, so it is not written."
                + " Use the arrow keys (Shift for x10), +/- for size and [/] for spacing,"
                + " then press Enter.");
        }

        _settings = _settingsStore.Read();
        _adjusting = false;
        _workingCalibration = null;
        _adjustMoved = false;
        AdjustmentStateChanged?.Invoke(false);""")

sub("""        _adjusting = false;
        _workingCalibration = null;
        _workingByTarget.Clear();
        _touchedTargets.Clear();
        _lastBadgeReason = null;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    private void RestoreVisibilityAfterAdjustment()""",
"""        _adjusting = false;
        _workingCalibration = null;
        _adjustMoved = false;
        AdjustmentStateChanged?.Invoke(false);
        SetInteractive(false);
        RestoreVisibilityAfterAdjustment();
    }

    private void RestoreVisibilityAfterAdjustment()""")

# ── RenderAdjustment ────────────────────────────────────────────────────────
start = s.index("""    private void RenderAdjustment()
    {""")
end = s.index("""    private void SetNativeClickThrough(bool clickThrough)""")
s = s[:start] + '''    private void RenderAdjustment()
    {
        if (_workingCalibration is null) return;
        RootCanvas.Children.Clear();
        var geometry = CalibrationGeometry.ForDpi(
            _workingCalibration.Normalize(),
            _display?.DpiX ?? 96,
            96);
        LastAdjustGeometry = geometry;

        foreach (var (rect, index) in geometry.GetAbilityRects().Select((rect, index) => (rect, index)))
        {
            var box = new Border
            {
                Width = rect.Width,
                Height = rect.Height,
                Background = new SolidColorBrush(WpfColor.FromArgb(55, 255, 47, 158)),
                BorderBrush = new SolidColorBrush(WpfColor.FromRgb(255, 47, 158)),
                BorderThickness = new Thickness(3),
                CornerRadius = new CornerRadius(8),
                Child = new TextBlock
                {
                    Text = ((OverlayAbility)index).ToString(),
                    Foreground = WpfBrushes.White,
                    FontWeight = FontWeights.Bold,
                    FontSize = 12,
                },
            };
            Canvas.SetLeft(box, rect.Left);
            Canvas.SetTop(box, rect.Top);
            RootCanvas.Children.Add(box);
        }

        var legend = new Border
        {
            Background = new SolidColorBrush(WpfColor.FromArgb(236, 8, 13, 28)),
            BorderBrush = new SolidColorBrush(WpfColor.FromRgb(79, 176, 224)),
            BorderThickness = new Thickness(1.5),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(10, 7, 10, 7),
            Child = new TextBlock
            {
                Text = "Adjusting the skill-order box"
                    + "\\nLine these up with your ability bar"
                    + "\\nNothing is saved unless you actually move them"
                    + "\\nEnter: save \\u00b7 Esc: cancel"
                    + "\\nArrow keys: move \\u00b7 Shift: \\u00d710 \\u00b7 +/-: size \\u00b7 [/]: spacing",
                Foreground = WpfBrushes.White,
                FontSize = 11,
            },
        };
        Canvas.SetLeft(legend, geometry.FirstBoxCenterX + 1.5 * geometry.Spacing);
        Canvas.SetTop(legend, Math.Max(4, geometry.CenterY - geometry.BoxSize / 2 - 80));
        RootCanvas.Children.Add(legend);
    }

''' + s[end:]

# ── WindowMessageHook ───────────────────────────────────────────────────────
sub("""                if (_adjusting)
                {
                    _workingByTarget.Clear();
                    _touchedTargets.Clear();
                    _workingCalibration = _display is null
                        ? null
                        : _settingsStore.LoadCalibrationOrDefault(_adjustTarget, _display.Resolution);
                    RenderAdjustment();
                }""",
"""                if (_adjusting)
                {
                    _adjustMoved = false;
                    _workingCalibration = _display is null
                        ? null
                        : _settingsStore.LoadCalibration(_display.Resolution);
                    RenderAdjustment();
                }""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok  %d -> %d chars' % (original_len, len(s)))
