import io

def sub(s, old, new, count=1):
    assert s.count(old) == count, (s.count(old), old[:80])
    return s.replace(old, new)


# ── App.xaml.cs ──────────────────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/App.xaml.cs'
s = io.open(p, encoding='utf-8').read()

s = sub(s, """    string? Error = null,
    OverlayState? Overlay = null,
    /// <summary>
    /// The WPA deltas that came with the most recent item-set write, or null.
    /// Carried on the snapshot rather than read out of CompanionState by the UI
    /// so the overlay has exactly one source of truth per tick.
    /// </summary>
    SituationalOverlaySet? Situational = null);""",
"""    string? Error = null,
    OverlayState? Overlay = null);""")

s = sub(s, """        _overlay.GameMode = () => (_services as ILiveOverlayPushSource)?.CurrentGameMode;
        _overlay.ManualBadgeOverrideCleared += OnManualBadgeOverrideCleared;
        _overlay.AdjustmentStateChanged += OnAdjustmentStateChanged;""",
"""        _overlay.GameMode = () => (_services as ILiveOverlayPushSource)?.CurrentGameMode;
        _overlay.AdjustmentStateChanged += OnAdjustmentStateChanged;""")

# OnManualBadgeOverrideCleared
start = s.index("""    /// <summary>
    /// The overlay dropped "Show item numbers now" because the player pressed""")
end = s.index("""    private void OnHotkeyPressed(HotkeyBinding binding)""")
s = s[:start] + s[end:]

# snapshot tick: shop watcher gate + force-badges reset + situational push
s = sub(s, """        // The watcher's own 50 ms timer owns the key edges; this only tells it
        // whether a game is running, which is the gate that resets the latch
        // between matches.
        var inGame = snapshot.Overlay?.InGame == true;
        if (inGame) RetryShopBindsIfFallback();
        _shopWatcher?.SetInGame(inGame);

        // "Show item numbers NOW" is a per-game override, and the verb is the
        // contract. It is also the one tray item that is disabled out of a game
        // (there is no shop to sit over), so a player who leaves it ticked
        // cannot untick it afterwards — leaving it latched would silently turn
        // a one-off "show me anyway" into "show me in every future game", with
        // the only control greyed out.
        if (!inGame && _trayState.ForceItemNumbers)
        {
            _trayState = _trayState with { ForceItemNumbers = false };
            _overlay?.SetForceBadges(false);
            _tray?.UpdateState(_trayState);
            _log?.Info("badges: manual override cleared (the game ended)");
        }

        if (snapshot.Overlay is not null)
        {
            _overlay?.ApplyState(snapshot.Overlay);
            // Champion-MATCHED, not merely present. The item set is written in
            // champ select and the numbers are drawn in game, so the data
            // outlives the phase that produced it — and anything that outlives
            // a phase can outlive the champion it described. `For` returns null
            // for every champion but the one the set was written for.
            // The set LABEL travels with the deltas and never without them: it
            // names the one shop set the positional mapping is true of and the
            // block position the saved calibration is true of, and a label left
            // behind by another champion's write would send the player to line
            // their numbers up against the wrong row.
            var situational = snapshot.Situational;
            var situationalDeltas = situational?.For(snapshot.Overlay.ChampionId ?? 0);
            _overlay?.SetSituationalDeltas(
                situationalDeltas,
                situationalDeltas is null ? string.Empty : situational!.SetLabel);
            if (_trayState.OverlayVisible) _overlay?.ShowInactive();
        }""",
"""        // The watcher's own 50 ms timer owns the key edges; this only tells it
        // whether a game is running, which is the gate that resets the latch
        // between matches.
        var inGame = snapshot.Overlay?.InGame == true;
        if (inGame) RetryShopBindsIfFallback();
        _shopWatcher?.SetInGame(inGame);

        if (snapshot.Overlay is not null)
        {
            _overlay?.ApplyState(snapshot.Overlay);
            if (_trayState.OverlayVisible) _overlay?.ShowInactive();
        }""")

s = sub(s, """            case TrayCommand.Adjust:
                _overlay?.BeginAdjustment();
                break;
            case TrayCommand.AdjustItems:
                _overlay?.BeginAdjustment(CalibrationTarget.ItemRow);
                break;
            case TrayCommand.ToggleItemNumbers:
                _trayState = _trayState with { ForceItemNumbers = !_trayState.ForceItemNumbers };
                _overlay?.SetForceBadges(_trayState.ForceItemNumbers);
                _tray?.UpdateState(_trayState);
                break;
            case TrayCommand.CancelAdjust:""",
"""            case TrayCommand.Adjust:
                _overlay?.BeginAdjustment();
                break;
            case TrayCommand.CancelAdjust:""")

s = sub(s, """            _state.IsCompanionBusy,
            status.LastError,
            BuildOverlayState(),
            _state.Situational));""",
"""            _state.IsCompanionBusy,
            status.LastError,
            BuildOverlayState()));""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── Tray/TrayController.cs ───────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/Tray/TrayController.cs'
s = io.open(p, encoding='utf-8').read()

s = sub(s, """    CancelAdjust,
    AdjustItems,
    ToggleItemNumbers,
    RepairWebView2,""", """    CancelAdjust,
    RepairWebView2,""")

s = sub(s, """        _menu.Items.Add(AdjustItem());
        if (!_state.IsAdjusting)
        {
            _menu.Items.Add(MenuItem(
                TrayMenuState.AdjustItemsMenuVerb,
                (_, _) => RaiseCommand(TrayCommand.AdjustItems)));
            var showNumbers = new Forms.ToolStripMenuItem(TrayMenuState.ShowItemNumbersVerb)
            {
                Checked = _state.ForceItemNumbers,
                CheckOnClick = true,
                // Only meaningful in a game: there is no shop to sit over
                // otherwise, and an item that can be ticked to no effect is a
                // control that lies about what it does.
                Enabled = _state.IsInGame,
            };
            showNumbers.Click += (_, _) => RaiseCommand(TrayCommand.ToggleItemNumbers);
            _menu.Items.Add(showNumbers);
        }

        _menu.Items.Add(new Forms.ToolStripSeparator());""",
"""        _menu.Items.Add(AdjustItem());

        _menu.Items.Add(new Forms.ToolStripSeparator());""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── Tray/TrayMenuState.cs ────────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/Tray/TrayMenuState.cs'
s = io.open(p, encoding='utf-8').read()

s = sub(s, """    string? AdjustHotkeyAdvice = null,
    /// <summary>The player has asked for the situational numbers by hand, overriding the shop latch.</summary>
    bool ForceItemNumbers = false,
    string? WebVersion = null,""",
"""    string? AdjustHotkeyAdvice = null,
    string? WebVersion = null,""")

start = s.index("""    /// <summary>
    /// The second calibration target (1.0.16): where the situational WPA""")
end = s.index("""    public const string OpenLogFolderVerb = "Open log folder";""")
s = s[:start] + s[end:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
