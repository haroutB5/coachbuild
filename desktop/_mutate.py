import io, sys, shutil, os

LATCH = r"src/CoachBuild.Core/ShopVisibilityLatch.cs"
BAK = r"src/CoachBuild.Core/ShopVisibilityLatch.cs.pristine"

mode = sys.argv[1]

if mode == "save":
    shutil.copyfile(LATCH, BAK)
    print("saved")
    sys.exit(0)

if mode == "restore":
    shutil.copyfile(BAK, LATCH)
    print("restored")
    sys.exit(0)

shutil.copyfile(BAK, LATCH)
s = io.open(LATCH, encoding="utf-8").read()

if mode == "no-allchat":
    # Regress to the shipped 1.0.16 behaviour: Shift+Enter is invisible.
    old = "        var chatDown = observation.ChatKeyDown || observation.ChatAllKeyDown;"
    new = "        var chatDown = observation.ChatKeyDown;"
    assert old in s
    s = s.replace(old, new, 1)
    old2 = "            if (observation.ChatAllKeyDown)"
    new2 = "            if (false)"
    assert old2 in s
    s = s.replace(old2, new2, 1)

elif mode == "no-insist":
    old = "                if (_suppressedThisBelief >= 1 && observation.At - _firstSuppressedAt >= InsistGap)"
    new = "                if (false)"
    assert old in s
    s = s.replace(old, new, 1)

elif mode == "no-expiry":
    old = "        if (_chatOpen && observation.At - _chatSince >= ChatBeliefTimeout)"
    new = "        if (false && _chatOpen && observation.At - _chatSince >= ChatBeliefTimeout)"
    assert old in s
    s = s.replace(old, new, 1)

else:
    raise SystemExit("unknown mode " + mode)

io.open(LATCH, "w", encoding="utf-8", newline="\n").write(s)
print("mutated:", mode)
