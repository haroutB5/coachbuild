@echo off
REM Relaunches CoachBuild Overlay Host elevated (triggers a UAC prompt).
REM Only needed if Ctrl+F10/Ctrl+F11 don't respond while League has focus --
REM the SYSTEM TRAY ICON is the primary control and does NOT need this.
REM See overlay-host/README.md's "Hotkeys and elevation" section.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0node_modules\electron\dist\electron.exe' -ArgumentList '\"%~dp0.\"' -Verb RunAs"
