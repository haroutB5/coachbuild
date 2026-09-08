import io

def sub(s, old, new, count=1):
    assert s.count(old) == count, (s.count(old), old[:90])
    return s.replace(old, new)


# ── App.xaml.cs ──────────────────────────────────────────────────────────────
p = 'src/CoachBuild.Desktop/App.xaml.cs'
s = io.open(p, encoding='utf-8').read()

s = sub(s, """    private GlobalHotkeyService? _hotkeys;
    private ShopKeyWatcher? _shopWatcher;

    // True while the watcher is polling League's DEFAULT P because the player's
    // own config could not be read. Drives one retry per game start; see
    // RetryShopBindsIfFallback.
    private bool _shopBindsAreFallback;
    private VelopackUpdateService? _updates;""",
"""    private GlobalHotkeyService? _hotkeys;
    private VelopackUpdateService? _updates;""")

s = sub(s, """        StartHotkeys();
        StartShopWatcher(settingsStore);
        _webViewEnvironment""", """        StartHotkeys();
        _webViewEnvironment""")

# StartShopWatcher + LogConfigSearch + RetryShopBindsIfFallback, in one span
start = s.index("""    /// <summary>
    /// Starts the shop-key watcher, and writes down what it decided to watch.""")
end = s.index("""    private void OnHotkeyPressed(HotkeyBinding binding)""")
s = s[:start] + s[end:]

s = sub(s, """        // The watcher's own 50 ms timer owns the key edges; this only tells it
        // whether a game is running, which is the gate that resets the latch
        // between matches.
        var inGame = snapshot.Overlay?.InGame == true;
        if (inGame) RetryShopBindsIfFallback();
        _shopWatcher?.SetInGame(inGame);

        if (snapshot.Overlay is not null)""",
"""        if (snapshot.Overlay is not null)""")

s = sub(s, """        _hotkeys?.Dispose();
        _shopWatcher?.Dispose();
        _hotkeys = null;""",
"""        _hotkeys?.Dispose();
        _hotkeys = null;""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── OverlaySettingsStore.cs: the chat gate ───────────────────────────────────
p = 'src/CoachBuild.Desktop/Overlay/OverlaySettingsStore.cs'
s = io.open(p, encoding='utf-8').read()

start = s.index("""    /// <summary>
    /// Whether a shop-key press may be IGNORED while League's chat input looks""")
end = s.index("""    /// <summary>
    /// The shared account secret the ranked-LP capture posts with""")
s = s[:start] + s[end:]

s = sub(s, """            // Every field has to be here: Save() clones before it writes, so a
            // field missed in this method is silently reset to its default on
            // the next write of ANY other setting.
            ChatGateEnabled = settings.ChatGateEnabled,
            RankSampleSecret = settings.RankSampleSecret,""",
"""            // Every field has to be here: Save() clones before it writes, so a
            // field missed in this method is silently reset to its default on
            // the next write of ANY other setting. That is also why
            // ItemRowCalibrations is cloned below despite nothing reading it.
            RankSampleSecret = settings.RankSampleSecret,""")

io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── ComplianceRules.cs: the evidence comment that named LogConfigSearch ──────
p = 'src/CoachBuild.Core/ComplianceRules.cs'
s = io.open(p, encoding='utf-8').read()
s = sub(s, """    // ID, no dashed UUID, no session=, no remoting-auth-token. A user-profile
    // path is different, and it is reachable by construction rather than by
    // accident: LeagueConfigLocator.Candidates() (ShopBindResolver.cs) adds
    // SpecialFolder.LocalApplicationData to the search list, and App.xaml.cs's
    // LogConfigSearch joins the first eight candidates into one Info line
    // whenever no League config is found. On an ordinary install that line
    // contains <drive>:\\Users\\<their Windows account name>\\AppData\\Local\\...
    // -- a name, written into the one file the user is now asked to upload.""",
"""    // ID, no dashed UUID, no session=, no remoting-auth-token. A user-profile
    // path is different: any line that names a filesystem path the app probed
    // carries <drive>:\\Users\\<their Windows account name>\\... on an ordinary
    // install -- a name, written into the one file the user is now asked to
    // upload. The line that motivated this rule ("shop: looked for League's
    // Config in N place(s): ...") was removed with the item-number overlay in
    // 1.0.22; the rule stays, because it defends against the SHAPE and the
    // upload is what it defends, not any one caller.""")
io.open(p, 'w', encoding='utf-8', newline='').write(s)


# ── DiagnosticsUploadTests.cs: same cross-reference ─────────────────────────
p = 'tests/CoachBuild.Core.Tests/DiagnosticsUploadTests.cs'
s = io.open(p, encoding='utf-8').read()
s = sub(s, """    /// user-profile path is different: it is reachable by construction, via
    /// LeagueConfigLocator's %LOCALAPPDATA% candidate and App.LogConfigSearch's
    /// one-line join of the first eight candidates. See
    /// ComplianceRules.UserProfileRegex.</para>""",
"""    /// user-profile path is different: any line naming a path the app probed
    /// carries one. The specific line in the fixture below no longer has a
    /// producer (it went with the item-number overlay in 1.0.22), and the rule
    /// is deliberately kept anyway -- it defends the SHAPE, in a file the user
    /// uploads by hand, against every future line and every older build's log.
    /// See ComplianceRules.UserProfileRegex.</para>""")
io.open(p, 'w', encoding='utf-8', newline='').write(s)

print('ok')
