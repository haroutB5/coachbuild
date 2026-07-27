@echo off
REM Relaunches CoachBuild Overlay Host elevated (triggers a UAC prompt).
REM Only needed if Ctrl+F10/Ctrl+F11/Ctrl+F12 don't respond while League has
REM focus -- the SYSTEM TRAY ICON is the primary control and does NOT need this.
REM See overlay-host/README.md's "Hotkeys and elevation" section.
REM
REM `npm run start:admin` delegates HERE rather than inlining the PowerShell,
REM because every path below must be ABSOLUTE. An elevated process launched via
REM `-Verb RunAs` does NOT inherit the launching shell's working directory --
REM Windows starts it in C:\Windows\System32. So a relative exe path, or passing
REM a bare "." as the app argument, is resolved against System32 and Electron
REM fails with "Unable to find Electron app". %~dp0 is this script's own
REM directory, which is the one thing guaranteed correct regardless of where it
REM was invoked from. -WorkingDirectory pins it explicitly too, belt and braces.
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0node_modules\electron\dist\electron.exe' -ArgumentList '\"%~dp0.\"' -WorkingDirectory '%~dp0' -Verb RunAs"
