import subprocess, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LATCH = os.path.join(ROOT, 'desktop/src/CoachBuild.Core/ShopVisibilityLatch.cs')
WINDOW = os.path.join(ROOT, 'desktop/src/CoachBuild.Desktop/Overlay/OverlayWindow.xaml.cs')

TIMEOUT_BLOCK = '''        if (_open && !shopEdge && observation.At - _openSince >= OpenLatchTimeout)
        {
            _open = false;
            LatchesTimedOut++;
            reason = ReasonOpenTimedOut;
        }
'''

OVERRIDE_BLOCK = '''        var droppedOverride = false;
        if (!open && _forceBadges)
        {
            _forceBadges = false;
            droppedOverride = true;
        }
'''

MUTANTS = {
    'M7 no open-latch backstop (pills can strand for the match)': [
        (LATCH, TIMEOUT_BLOCK, ''),
    ],
    'M8 a fresh press does not re-arm the open latch': [
        (LATCH, '                _openSince = observation.At;\n', ''),
    ],
    'M9 closing the latch no longer clears the manual override': [
        (WINDOW, OVERRIDE_BLOCK, '        var droppedOverride = false;\n'),
    ],
    'M10 the override is cleared on OPEN as well as close': [
        (WINDOW, '        if (!open && _forceBadges)', '        if (_forceBadges)'),
    ],
}

env = dict(os.environ)
env['DOTNET_ROOT'] = r'C:\Claude\tools\dotnet'


def run_tests():
    out = subprocess.run(
        ['C:/Claude/tools/dotnet/dotnet.exe', 'test', '--nologo'],
        cwd=os.path.join(ROOT, 'desktop'),
        capture_output=True, text=True, env=env)
    return out.stdout + out.stderr


for name, edits in MUTANTS.items():
    backups = {path: open(path, encoding='utf-8').read() for path, _, _ in edits}
    try:
        ok = True
        for path, old, new in edits:
            s = open(path, encoding='utf-8').read()
            if s.count(old) != 1:
                print('=== ' + name + ' ===')
                print('  ANCHOR MISS (%d) in %s' % (s.count(old), os.path.basename(path)))
                ok = False
                break
            open(path, 'w', encoding='utf-8', newline='').write(s.replace(old, new))
        if not ok:
            continue

        text = run_tests()
        killed = sorted({
            line.strip().split()[1].split('.')[-1]
            for line in text.splitlines()
            if 'Failed CoachBuild' in line and line.strip().startswith('Failed ')
        })
        print('=== ' + name + ' ===')
        if 'error CS' in text:
            print('  DID NOT COMPILE')
        elif killed:
            for k in killed:
                print('  killed: ' + k)
        else:
            print('  *** SURVIVED - nothing tests this ***')
        for line in text.splitlines():
            if line.strip().startswith(('Passed!', 'Failed!')):
                print('  ' + line.strip())
    finally:
        for path, original in backups.items():
            open(path, 'w', encoding='utf-8', newline='').write(original)

print('restored')
