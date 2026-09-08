import subprocess, os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
LATCH = os.path.join(ROOT, 'desktop/src/CoachBuild.Core/ShopVisibilityLatch.cs')
WATCH = os.path.join(ROOT, 'desktop/src/CoachBuild.Desktop/Overlay/ShopKeyWatcher.cs')
STORE = os.path.join(ROOT, 'desktop/src/CoachBuild.Desktop/Overlay/OverlaySettingsStore.cs')

MUTANTS = {
    'M1 gate is always on (revert the 1.0.18 default)': [
        (LATCH, '        _chatGateEnabled = chatGateEnabled;',
                '        _chatGateEnabled = true;'),
    ],
    'M2 insistence resets on every belief transition (reinstate the 1.0.17 defect)': [
        (LATCH, '''        var wasOpen = _chatOpen;
        _chatOpen = true;
        _chatSince = at;
        return wasOpen ? null : note;''',
                '''        var wasOpen = _chatOpen;
        _chatOpen = true;
        _chatSince = at;
        _suppressedSincePress = 0;
        _firstSuppressedAt = TimeSpan.Zero;
        return wasOpen ? null : note;'''),
        (LATCH, '''        var wasOpen = _chatOpen;
        _chatOpen = false;
        _chatSince = TimeSpan.Zero;
        return wasOpen ? note : null;''',
                '''        var wasOpen = _chatOpen;
        _chatOpen = false;
        _chatSince = TimeSpan.Zero;
        _suppressedSincePress = 0;
        _firstSuppressedAt = TimeSpan.Zero;
        return wasOpen ? note : null;'''),
    ],
    'M3 the honoured-press line stops naming the gate': [
        (WATCH, '''            + $" {bypassed} honoured while chat looked open,"
            + $" chat gate {(_latch.ChatGateEnabled ? "on" : "off")})");''',
                '''            + $")");'''),
    ],
    'M4 CloneSettings forgets the new field': [
        (STORE, '            ChatGateEnabled = settings.ChatGateEnabled,\n', ''),
    ],
    'M5 the belief still writes its lines with the gate off': [
        (LATCH, '    private string? GateNote(string? note) => _chatGateEnabled ? note : null;',
                '    private string? GateNote(string? note) => note;'),
    ],
    'M6 an honoured press no longer ends the insistence run': [
        (LATCH, '''                _suppressedSincePress = 0;
                _firstSuppressedAt = TimeSpan.Zero;

                reason''',
                '''                reason'''),
    ],
}

env = dict(os.environ)
env['DOTNET_ROOT'] = r'C:\Claude\tools\dotnet'
env['PATH'] = r'C:\Claude\tools\dotnet;' + env['PATH']


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
