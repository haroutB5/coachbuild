# CoachBuild Desktop performance verification

This folder is for traces captured from the packaged WPF app on a Windows
machine with League running. It is not a benchmark of a synthetic WPF window.

## Acceptance targets

- Whole-app working set under 120 MB in a normal borderless and windowed League
  session.
- Idle GPU under 1% after the overlay reaches a stable state.
- No renderer redraw when the immutable overlay render signature is unchanged.
- Overlay remains click-through and does not activate or steal focus outside
  adjustment mode.
- Calibration follows the active display bounds and per-monitor DPI.

## Capture

1. Start the installed per-user app and record the process tree and display
   scale. Close unrelated capture-heavy applications.
2. Capture an idle lobby and an active borderless League session:

   ```powershell
   wpr -start CPU -filemode
   # Reproduce: lobby idle, champ select, and an in-progress game.
   wpr -stop desktop/perf/coachbuild.etl
   wpa desktop/perf/coachbuild.etl
   ```

3. In WPA, inspect CoachBuild.Desktop and its WebView2 child processes for
   working set, CPU, GPU engine utilization, and allocation spikes. Compare
   before/after a level update and after moving the window between monitors.
4. Use the overlay renderer's redraw counter and the WPF visual tree to confirm
   that repeated identical snapshots do not repaint. A stable game state may
   still cause bridge/LCU polling; that is not a redraw.
5. Record the Windows display scale, League HUD scale, monitor bounds, and
   whether the game was borderless or windowed next to every measurement.

Do not report a target as verified from a development machine without a real
League trace. Keep captured ETL files local; they are not release artifacts.
