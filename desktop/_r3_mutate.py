"""Round 3 mutation proof.

Removes each new guarantee in turn and records which tests die. A green suite
proves nothing on its own; this proves the tests are load-bearing.

NOTE (from round 2, and it cost a whole mutation run): Python's subprocess
resolves the executable from the PARENT process's PATH, not from the `env` you
pass it, so `['dotnet', ...]` silently runs C:\\Program Files\\dotnet
(runtime-only) and EVERY mutant "survives". Absolute path only.
"""
import io
import os
import re
import subprocess
import sys

ROOT = r"C:\Claude\AI\coachbuild\desktop"
DOTNET = r"C:/Claude/tools/dotnet/dotnet.exe"
ENV = dict(os.environ, DOTNET_ROOT=r"C:\Claude\tools\dotnet")

SRC = {
    "reader": os.path.join(ROOT, r"src\CoachBuild.Core\LeagueKeybindReader.cs"),
    "resolver": os.path.join(ROOT, r"src\CoachBuild.Core\ShopBindResolver.cs"),
    "watcher": os.path.join(ROOT, r"src\CoachBuild.Desktop\Overlay\ShopKeyWatcher.cs"),
    "window": os.path.join(ROOT, r"src\CoachBuild.Desktop\Overlay\OverlayWindow.xaml.cs"),
    "store": os.path.join(ROOT, r"src\CoachBuild.Desktop\Overlay\OverlaySettingsStore.cs"),
}

MUTANTS = [
    ("M1 layout hook ignored (revert to the US table)", "reader",
     """        if (punctuationLayout is not null)
        {
            uint fromLayout;
            try { fromLayout = punctuationLayout(character); }
            catch { fromLayout = 0; }
            if (fromLayout != 0) { virtualKey = fromLayout; return true; }
        }

""", ""),

    ("M2 layout hook consulted AFTER the US table", "reader",
     """        if (punctuationLayout is not null)
        {
            uint fromLayout;
            try { fromLayout = punctuationLayout(character); }
            catch { fromLayout = 0; }
            if (fromLayout != 0) { virtualKey = fromLayout; return true; }
        }

        if (Punctuation.TryGetValue(character, out virtualKey)) return true;""",
     """        if (Punctuation.TryGetValue(character, out virtualKey)) return true;
        if (punctuationLayout is not null)
        {
            uint fromLayout;
            try { fromLayout = punctuationLayout(character); }
            catch { fromLayout = 0; }
            if (fromLayout != 0) { virtualKey = fromLayout; return true; }
        }
"""),

    ("M3 Riot manifests never consulted", "resolver",
     "        foreach (var path in ManifestCandidates(readFile, programDataDirectory)) Add(path);\n\n"
     "        Add(@\"C:\\Riot Games\\League of Legends\\Config\");",
     "        Add(@\"C:\\Riot Games\\League of Legends\\Config\");"),

    ("M4 manifests consulted AFTER the hardcoded guess", "resolver",
     "        foreach (var path in ManifestCandidates(readFile, programDataDirectory)) Add(path);\n\n"
     "        Add(@\"C:\\Riot Games\\League of Legends\\Config\");",
     "        Add(@\"C:\\Riot Games\\League of Legends\\Config\");\n"
     "        foreach (var path in ManifestCandidates(readFile, programDataDirectory)) Add(path);"),

    ("M5 the WATCHING line names the character but not the key", "resolver",
     'bind => $"{bind.Display} (vk 0x{bind.VirtualKey:X2})"',
     'bind => $"{bind.Display}"'),

    ("M6 the fallback stops announcing that the config was unread", "resolver",
     '"League\'s default (YOUR CONFIG WAS NOT READ)"',
     '"a default"'),

    ("M7 UpdateBinds is a no-op", "watcher",
     "        lock (_tickGate) _binds = binds;",
     "        _ = binds;"),

    ("M8 an untouched target is persisted again (revert to 1.0.18)", "window",
     "            if (!_touchedTargets.Contains(target)) continue;\n", ""),

    ("M9 Enter and Esc count as a move", "window",
     """            case Key.Escape:
                moved = false;""",
     """            case Key.Escape:
                moved = true;"""),

    ("M10 a stored default is read back as a calibration", "store",
     """                if (target == CalibrationTarget.ItemRow
                    && IsSameGeometry(geometry, CalibrationGeometry.ItemRowScaledDefault(display)))
                {
                    return null;
                }

""", ""),

    ("M11 the sentinel is applied to the skill box too", "store",
     "                if (target == CalibrationTarget.ItemRow\n"
     "                    && IsSameGeometry(geometry, CalibrationGeometry.ItemRowScaledDefault(display)))",
     "                if (IsSameGeometry(geometry, target == CalibrationTarget.ItemRow\n"
     "                        ? CalibrationGeometry.ItemRowScaledDefault(display)\n"
     "                        : CalibrationGeometry.ScaledDefault(display)))"),
]


def run():
    result = subprocess.run(
        [DOTNET, "test", os.path.join(ROOT, "CoachBuild.Desktop.sln"), "--nologo"],
        cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=1800)
    out = result.stdout + result.stderr
    if "error CS" in out:
        return ["<DID NOT COMPILE>"]
    failed = sorted(set(re.findall(r"^\s+(?:X|Failed)\s+(\S+)", out, re.M)))
    if not failed:
        failed = sorted(set(re.findall(r"\[FAIL\]\s+(\S+)", out)))
    return failed


def main():
    report = []
    for name, key, old, new in MUTANTS:
        path = SRC[key]
        original = io.open(path, encoding="utf-8").read()
        if old not in original:
            report.append((name, ["<PATTERN NOT FOUND - mutation did not apply>"]))
            continue
        io.open(path, "w", encoding="utf-8", newline="").write(original.replace(old, new, 1))
        try:
            killed = run()
        finally:
            io.open(path, "w", encoding="utf-8", newline="").write(original)
        report.append((name, killed))
        print(f"{name}: {len(killed)} killed")
        sys.stdout.flush()

    print("\n=== MUTATION REPORT ===")
    for name, killed in report:
        print(f"\n{name}")
        if not killed:
            print("  *** SURVIVED - no test noticed ***")
        for test in killed:
            print(f"  - {test}")


if __name__ == "__main__":
    main()
