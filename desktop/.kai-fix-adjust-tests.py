import io

p = 'tests/CoachBuild.Desktop.Tests/SkillOrderAdjustTests.cs'
s = io.open(p, encoding='utf-8').read()

start = s.index("""    [Fact]
    public void Every_arrow_size_and_pitch_key_still_moves_the_box_it_is_documented_to_move()""")
end = s.index("""    [Fact]
    public void There_is_exactly_one_adjust_target_and_Tab_is_not_a_switch_any_more()""")

replacement = '''    [Fact]
    public void Every_arrow_size_and_pitch_key_still_moves_the_box_it_is_documented_to_move()
    {
        // The legend on screen promises arrows, +/- and [/]. This is that
        // promise, key by key, measured where it is stored.
        //
        // PHYSICAL PIXELS, not DIPs. The keys move _workingCalibration, which
        // is physical; LastAdjustGeometry is that value put through
        // CalibrationGeometry.ForDpi for the preview, so on a 192-DPI monitor
        // it is half. Asserting against the preview would make this test pass
        // or fail on the DPI of whatever machine ran it.
        RunOnSta((window, store) =>
        {
            window.ShowInactive();
            var display = window.CurrentDisplay!.Resolution;
            var start = store.LoadCalibration(display);
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Right, step: 10);
            window.HandleAdjustKey(Key.Down, step: 4);
            window.HandleAdjustKey(Key.OemPlus, step: 3);
            window.HandleAdjustKey(Key.OemCloseBrackets, step: 5);
            window.HandleAdjustKey(Key.Enter);

            Assert.Equal(
                start with
                {
                    FirstBoxCenterX = start.FirstBoxCenterX + 10,
                    CenterY = start.CenterY + 4,
                    BoxSize = start.BoxSize + 3,
                    Spacing = start.Spacing + 5,
                },
                store.LoadCalibration(display));
        });
    }

    [Fact]
    public void The_opposite_key_undoes_each_move_exactly()
    {
        // Pure equality of the same transform, so this one is DPI-agnostic and
        // says something the test above cannot: the pairs are inverses, not
        // merely four keys that each change something.
        RunOnSta(window =>
        {
            window.ShowInactive();
            window.BeginAdjustment();
            var start = window.LastAdjustGeometry!;

            window.HandleAdjustKey(Key.Right, step: 10);
            window.HandleAdjustKey(Key.Down, step: 4);
            window.HandleAdjustKey(Key.OemPlus, step: 3);
            window.HandleAdjustKey(Key.OemCloseBrackets, step: 5);
            Assert.NotEqual(start, window.LastAdjustGeometry);

            window.HandleAdjustKey(Key.Left, step: 10);
            window.HandleAdjustKey(Key.Up, step: 4);
            window.HandleAdjustKey(Key.OemMinus, step: 3);
            window.HandleAdjustKey(Key.OemOpenBrackets, step: 5);
            Assert.Equal(start, window.LastAdjustGeometry);
        });
    }

    [Fact]
    public void A_saved_box_is_what_the_next_session_loads_and_the_next_game_paints()
    {
        // End to end through the real store, on the real display key: the value
        // Enter wrote is the value LoadCalibration hands the renderer, and it
        // survives a store built fresh from the same file.
        RunOnSta((window, store) =>
        {
            window.ShowInactive();
            var display = window.CurrentDisplay!.Resolution;
            var start = store.LoadCalibration(display);
            window.BeginAdjustment();

            window.HandleAdjustKey(Key.Right, step: 7);
            window.HandleAdjustKey(Key.Enter);

            var saved = store.LoadCalibration(display);
            Assert.Equal(start.FirstBoxCenterX + 7, saved.FirstBoxCenterX);
            Assert.Equal(saved, new OverlaySettingsStore(store.Path).LoadCalibration(display));
        });
    }

'''

s = s[:start] + replacement + s[end:]
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
