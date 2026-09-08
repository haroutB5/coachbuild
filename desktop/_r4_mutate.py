"""Round 4 mutation proof.

Every new guarantee is removed in turn and the suite is run against the wound.
A mutant that SURVIVES is a guarantee nobody is actually holding.

Run from `desktop/`:
    C:/Users/Ht/AppData/Local/Programs/Python/Python314/python.exe _r4_mutate.py

Note (round 2's lesson, still true): subprocess resolves `dotnet` from the
PARENT process's PATH, not from the `env` dict you pass it, so the absolute
exe path is used below. Every mutant "survives" otherwise.
"""

import io
import subprocess
import sys

DOTNET = r"C:/Claude/tools/dotnet/dotnet.exe"

SRC = "src/CoachBuild.Core/SituationalSetLocator.cs"
DATA = "src/CoachBuild.Core/SituationalOverlayData.cs"
APPLY = "src/CoachBuild.Core/ItemSetApplyService.cs"
GEOM = "src/CoachBuild.Desktop/Overlay/CalibrationModel.cs"
RENDER = "src/CoachBuild.Desktop/Overlay/OverlayRenderer.cs"
WINDOW = "src/CoachBuild.Desktop/Overlay/OverlayWindow.xaml.cs"

# (id, description, file, needle, replacement)
MUTANTS = [
    (
        "M1",
        "the pill goes back ABOVE the slot (the 1.0.19 rule)",
        RENDER,
        """    public static Rect PlaceBadge(Rect slot, System.Windows.Size pill) => new(
        slot.Left + (slot.Width - pill.Width) / 2,
        Math.Max(0d, slot.Top + (slot.Height - pill.Height) / 2),
        pill.Width,
        pill.Height);""",
        """    public static Rect PlaceBadge(Rect slot, System.Windows.Size pill) => new(
        slot.Left + (slot.Width - pill.Width) / 2,
        Math.Max(0d, slot.Top - pill.Height - Math.Max(2d, slot.Height * 0.08)),
        pill.Width,
        pill.Height);""",
    ),
    (
        "M2",
        "adjust mode draws its own box again instead of the real pill",
        WINDOW,
        "            previewRects.Add(OverlayRenderer.PlaceBadgeOnCanvas(RootCanvas, pill, rect));",
        "            previewRects.Add(rect);",
    ),
    (
        "M3",
        "the badge anchor gains a term for the row's length",
        GEOM,
        "                clean.CenterY - clean.BoxSize / 2,",
        "                clean.CenterY - clean.BoxSize / 2 + count * 3,",
    ),
    (
        "M4",
        "an unreadable id SHORTENS the row again",
        SRC,
        '            if (!item.TryGetProperty("id", out var id)) { ids.Add(0); continue; }',
        '            if (!item.TryGetProperty("id", out var id)) continue;',
    ),
    (
        "M5",
        "the row cross-check always agrees",
        SRC,
        "        disagreement = string.Empty;\n        if (!block.Known) return true;",
        "        disagreement = string.Empty;\n        return true;\n#pragma warning disable CS0162\n        if (!block.Known) return true;",
    ),
    (
        "M6",
        "an UNKNOWN block disagrees, so any wire change deletes the feature",
        SRC,
        "        if (!block.Known) return true;",
        '        if (!block.Known) { disagreement = "unknown"; return false; }',
    ),
    (
        "M7",
        "the block POSITION drops out of the label",
        SRC,
        '        ? $"\\"{SetTitle}\\" — Situational is block {BlockOrdinal} of {BlockCount}"\n            + $" ({ItemIds.Count} item{(ItemIds.Count == 1 ? "" : "s")})"',
        '        ? $"\\"{SetTitle}\\""',
    ),
    (
        "M8",
        "adjust mode stops naming the set",
        WINDOW,
        "        var setNote = isItemRow && _situationalSetLabel.Length > 0",
        "        var setNote = false",
    ),
    (
        "M9",
        "the badge diagnostic line drops the set it aimed at",
        WINDOW,
        '                + (_situationalSetLabel.Length > 0 ? $" for {_situationalSetLabel}" : string.Empty);',
        "                + string.Empty;",
    ),
    (
        "M10",
        "a new set label alone no longer repaints",
        WINDOW,
        "        if (!labelChanged && SameDeltas(_situational, next))",
        "        if (SameDeltas(_situational, next))",
    ),
    (
        "M11",
        "an unknown block gets a prose name instead of an empty label",
        DATA,
        "            championId, deltas, at, block.Known ? block.Describe() : string.Empty);",
        "            championId, deltas, at, block.Describe());",
    ),
    (
        "M12",
        'a fully rejected row reports itself as "none supplied" again',
        APPLY,
        '                : rejections.Count > 0\n                    ? $"situational: every number was rejected for champion {request.ChampionId}"\n                        + "; none will be drawn (reasons on the line above)"\n                    : $"situational: none supplied for champion {request.ChampionId}; no numbers will be drawn");',
        '                : $"situational: none supplied for champion {request.ChampionId}; no numbers will be drawn");',
    ),
    (
        "M13",
        "Riot's own long block label counts as ours",
        SRC,
        '                if (!string.Equals(type.GetString(), BlockType, StringComparison.OrdinalIgnoreCase)) continue;',
        '                if (type.GetString()?.Contains(BlockType, StringComparison.OrdinalIgnoreCase) != true) continue;',
    ),
]


# BYTES, NOT TEXT, and this is not fussiness. The first version of this script
# read with encoding="utf-8-sig" (which STRIPS a BOM) and wrote with the same
# codec (which ADDS one), so every restored file came back with a byte-order
# mark it never had. Five source files ended up modified by a script whose whole
# contract is to leave the tree exactly as it found it, including
# CalibrationModel.cs, which no mutant of the final set even needed to touch and
# which showed up in `git diff` as a one-line change nobody made.
def read(path):
    with open(path, "rb") as handle:
        return handle.read()


def write(path, data):
    with open(path, "wb") as handle:
        handle.write(data)


def run_suite():
    result = subprocess.run(
        [DOTNET, "test", "CoachBuild.Desktop.sln", "--nologo", "-v", "q"],
        capture_output=True,
        text=True,
        errors="replace",
    )
    output = result.stdout + result.stderr
    if "error CS" in output:
        return "BUILD-BROKE", []
    failures = sorted(
        {
            line.split("     ", 1)[1].split(" [FAIL]")[0].strip()
            for line in output.splitlines()
            if "[FAIL]" in line and "     " in line
        }
    )
    return ("KILLED" if failures else "SURVIVED"), failures


def main():
    print("baseline...")
    verdict, failures = run_suite()
    if verdict != "SURVIVED":
        print(f"BASELINE IS NOT GREEN: {verdict} {failures}")
        return 1

    results = []
    for ident, description, path, needle, replacement in MUTANTS:
        original = read(path)
        crlf = b"\r\n" in original
        find = needle.encode("utf-8")
        put = replacement.encode("utf-8")
        if crlf:
            find = find.replace(b"\n", b"\r\n")
            put = put.replace(b"\n", b"\r\n")
        if find not in original:
            print(f"{ident}: NEEDLE NOT FOUND in {path}")
            results.append((ident, description, "NEEDLE-MISSING", []))
            continue
        write(path, original.replace(find, put, 1))
        try:
            verdict, failures = run_suite()
        finally:
            write(path, original)
        results.append((ident, description, verdict, failures))
        print(f"{ident} {verdict:14s} {description}")
        for failure in failures:
            print(f"      - {failure.rsplit('.', 1)[-1]}")

    print("\n--- summary ---")
    survivors = [row for row in results if row[2] != "KILLED"]
    for ident, description, verdict, failures in results:
        print(f"{ident:4s} {verdict:14s} {len(failures):2d} killed  {description}")
    print(f"\n{len(results) - len(survivors)}/{len(results)} killed")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
