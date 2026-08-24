# ---------------------------------------------------------------------------
# rebake-consensus.ps1 - regenerate public/consensus/item-set-consensus.json,
# and if (and only if) it actually changed, commit, push and DEPLOY it.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
# public/consensus/item-set-consensus.json is a STATIC file that ships with the
# build. It is a frozen snapshot of the corpus at bake time, and the export
# BELIEVES a stored `null` with no live fallback (see resolveOtpConsensus in
# components/hextech/itemSetsApply.ts): a champion-role written as null shows no
# OTP block at all, however many games the ingest has collected since.
#
# The ingest jobs grow the corpus every few hours. The artifact never notices.
# After the 2026-08-22 sample-floor bake there are ~281 champion-roles sitting
# below the 21-game floor, every one of which crosses it on its own, and NOTHING
# surfaces any of them until a human regenerates and redeploys. Five consecutive
# entries in HANDOFF-otp-artifact.md flagged this by hand. This is the automation.
#
# ── A PUSH ALONE SHIPS NOTHING. BOTH STEPS ARE REQUIRED. ────────────────────
# This project has NO git-triggered build (established in HANDOFF-otp-artifact.md
# Lane AC: `link: undefined` on the Vercel project, every recent deployment
# `source: "cli"`, no workflows). On top of that, vercel.json serves
# /consensus/(.*) with s-maxage=31536000 - a YEAR at the edge. So regenerating
# and pushing changes precisely nothing that a user sees; only a new deployment
# puts new bytes behind that URL. Steps 3 and 4 below are not belt-and-braces.
#
# ── THE DEPLOY RUNS FROM A CLEAN DETACHED WORKTREE, NOT THE REPO ────────────
# `vercel --archive=tgz` uploads the DIRECTORY IT RUNS IN, and this repo's
# working tree carries a gitignored .env.local still pointing at the OLD,
# quota-exhausted, matchday-shared Neon project. Deploying from the working tree
# would upload it. The worktree is checked for .env* before a single byte is
# uploaded, and removed afterwards with a plain `git worktree remove`.
#
# ── IT REFUSES RATHER THAN SHIPPING SOMETHING WRONG ─────────────────────────
# Every guard below is a failure that has actually happened on this repo, not a
# hypothetical. Exit codes are distinct so Task Scheduler's LastTaskResult says
# WHICH refusal fired without anyone opening the log:
#
#    0  success, deployed  -- or a clean NO-OP (the common case)
#   70  git preconditions  (wrong branch / dirty artifact / diverged from origin)
#   71  auth               (git push credentials or Vercel CLI not usable here)
#   75  an ingest is running, or the next ingest slot is too close
#   76  coverage.otp REGRESSED against what production is serving
#   77  patch flip - the artifact patch and the live patch disagree
#       (the human path is -AcceptPatchFlip, see RUN BY HAND)
#   78  DATABASE_URL could not be resolved to the rebuilt Neon project
#   79  deadline reached before the work could be done safely
#   80  generate / commit / push / deploy / post-deploy verification failed
#
# The NO-OP is the one to understand: an unchanged artifact must NOT produce a
# commit and must NOT burn a deployment. This matters MORE now the job is daily
# rather than weekly: it runs 7x as often, so 7x as many chances to churn an
# empty commit, and a job that churns is a job that gets ignored - and then its
# real failures get ignored too.
#
# ── RUN BY HAND ─────────────────────────────────────────────────────────────
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebake-consensus.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebake-consensus.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebake-consensus.ps1 -AcceptPatchFlip
#
# -AcceptPatchFlip is the human path out of exit 77. The unattended job must
# never decide on its own that a thin first-bake of a new patch is fine to
# ship; an operator running this switch is that decision. It skips ONLY the
# cross-patch coverage guard (76), which is meaningless across patches; every
# other guard still applies, and when the patches happen to match it is a
# no-op.
#
# -DryRun does everything up to and including the comparison and every guard,
# and then stops before `git add`. It is the honest rehearsal: it spends the
# same ~1,730 requests, so it costs the same Neon compute as a real bake.
#
# Registered by scripts/register-rebake-task.ps1 as CoachBuildConsensusRebake.
# The cadence is pinned in lib/ingestCadence.ts and asserted by
# lib/__tests__/ingestCadence.test.ts. It must not live only in Task Scheduler:
# a cadence that exists only there is what caused the 2026-08-20 Neon outage.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    # Repo root. Derived from this script's own location so the job survives a
    # machine or username migration, but overridable for testing.
    [string]$Root = "",
    # The deployment the sample is drawn from. Production on purpose: the
    # generator issues the SAME request the live export issues, against the SAME
    # deployment, so the artifact cannot disagree with the path it replaces.
    [string]$Base = "https://coachbuild.vercel.app",
    # The deployment whose CURRENTLY SERVED artifact the regression guard
    # compares against. Defaults to -Base, which is what you want: the guard's
    # whole point is "do not ship a corpus thinner than the one already live".
    #
    # It is separable only so the refusal can be TESTED. A guard whose deny path
    # has never fired is not a guard - the last one on this repo that was taken
    # on trust turned out to unwind only its own file and let the caller carry
    # straight on. Point this at a fixture serving a higher coverage.otp and the
    # run must refuse with 76.
    [string]$CompareBase = "",
    # Wall-clock ceiling for the whole run, and the clearance required in front
    # of the next scheduled ingest. Riot's key budget is per-KEY, not per
    # process, and lib/pro/pacer.ts only serialises within one process
    # (CLAUDE.md gotcha (d)) - two overlapping Riot-calling jobs is how the key
    # gets suspended and every surface in the app goes dark.
    [int]$DeadlineMinutes = 60,
    # Do everything except commit / push / deploy.
    [switch]$DryRun,
    # Accept a patch flip (exit 77) that a human has looked at. See RUN BY HAND.
    [switch]$AcceptPatchFlip,
    # Branch this is allowed to operate on. A bake committed onto a stray
    # branch would push nothing and deploy the wrong tree.
    [string]$Branch = "main"
)

$ErrorActionPreference = "Continue"

if ($Root -eq "") { $Root = Split-Path -Parent $PSScriptRoot }
if ($CompareBase -eq "") { $CompareBase = $Base }
$artifactRel = "public/consensus/item-set-consensus.json"
$artifactAbs = Join-Path $Root "public\consensus\item-set-consensus.json"

# ── logging ────────────────────────────────────────────────────────────────
# One shared, bounded log, same convention as the ingest wrappers, so an
# operator looks in one place. -Encoding utf8 on every writer: PS 5.1's bare
# *>> redirect writes UTF-16LE while Add-Content writes ANSI, and a
# mixed-encoding log renders as garbage to tail/grep.
$logDir = Join-Path $env:LOCALAPPDATA "CoachBuild"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir "consensus-rebake.log"
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) {
    $text = Get-Content $log -Raw
    Set-Content $log $text.Substring([int]($text.Length / 2)) -Encoding utf8
}

# The logger must never be able to abort the run it only describes. MEASURED
# 2026-08-21: a forgotten `tail -f` from another lane held a log open without
# sharing writes, Add-Content threw, and with a Stop preference that killed a
# five-hour walk before its first line. Retry briefly, then give up quietly.
function Say($m) {
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $line = "[rebake $stamp] $m"
    for ($t = 1; $t -le 3; $t++) {
        try { Add-Content -Path $log -Value $line -Encoding utf8 -ErrorAction Stop; break }
        catch { Start-Sleep -Milliseconds 200 }
    }
    Write-Output $line
}

function Refuse($code, $why) {
    Say "REFUSING ($code): $why"
    exit $code
}

$startedAt = Get-Date
$deadline = $startedAt.AddMinutes($DeadlineMinutes)
Say "start pid=$PID root=$Root base=$Base compare=$CompareBase deadline=$($deadline.ToString('HH:mm:ss')) local dryrun=$DryRun"

# ── PATH, before anything shells out ───────────────────────────────────────
# Task Scheduler's environment does NOT carry the interactive PATH, and this
# machine has a corporate node shadow ("MDXT Connect" node64) earlier in PATH
# than the real Node.js. Pin the real one FIRST or tsx resolves against the
# wrong runtime. Git is pinned for the same reason: it is not on the scheduled
# task's PATH by default on this box, and `git` failing to resolve would look
# like a clean tree rather than a broken tool.
$env:Path = 'C:\Program Files\nodejs;C:\Program Files\Git\cmd;' + $env:Path

# ── (78) which database ────────────────────────────────────────────────────
# The generator draws its sample over HTTP, not SQL, so this does not choose the
# connection - production does. It is a PROVENANCE guard: if this checkout's
# secret store no longer resolves to the rebuilt project, the machine's idea of
# "which database CoachBuild uses" has moved underneath us, and baking a corpus
# snapshot in that state is exactly the class of mistake that took nine hours to
# notice on 2026-08-20. Log the endpoint, never the credential.
#
# The sentinel test below is the load-bearing half, not decoration: an `exit`
# inside a DOT-SOURCED script unwinds only that file (MEASURED 2026-08-21 - the
# caller carried straight on past the refusal), so the guard only works because
# the CALLER checks $CbnewDbResolved.
. (Join-Path $PSScriptRoot '_cbnew-db.ps1') -Root $Root -LogPath $log
if (-not $CbnewDbResolved) { exit 78 }

# _cbnew-db.ps1 refuses the OLD project by name and refuses an unpooled
# endpoint. It does not assert the POSITIVE: that we landed on the rebuilt
# project rather than some third one. Name it.
$expectedEndpoint = 'ep-sparkling-block-zayzlal1'
if ($env:DATABASE_URL -notmatch [regex]::Escape($expectedEndpoint)) {
    Refuse 78 "DATABASE_URL did not resolve to $expectedEndpoint (the rebuilt Neon project)"
}
Say "database endpoint confirmed: $expectedEndpoint"

Set-Location $Root

# ── (75) nothing may be ingesting ──────────────────────────────────────────
# THREE bakes were wasted on a corpus moving underneath the generator, and on
# 2026-08-22 a running CoachBuildMatchIngest forced a 45-minute hold. Two
# independent checks, because neither alone is sufficient:
#
#   * Task state. Note that a RUNNING task reports LastTaskResult 267009
#     (0x41301, "still running") - that is not a failure code, and killing a
#     task that reports it is the wrong move. Wait.
#   * Live node processes. A hand-started walk, or a supervisor chunk, has no
#     task state at all. Match on the COMMAND LINE, which is the only place the
#     script name appears - every one of them is just "node.exe" by image name.
$ingestTasks = @(
    'CoachBuildOtpPriority', 'CoachBuildOtpIngest', 'CoachBuildMatchIngest',
    'CoachBuildProstageIngest', 'CoachBuildDraftIngest', 'CoachBuildOtpWalkOneShot',
    'CoachBuildRebuildPhase1'
)
$running = @()
$nextSlot = $null
foreach ($name in $ingestTasks) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t) { continue }
    if ($t.State -eq 'Running') { $running += $name; continue }
    $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
    # NextRunTime is LOCAL time, not UTC. Comparing it against a UTC "now"
    # reads an hour of clearance that is not there (or refuses over one that
    # is). This tripped an earlier lane; compare local against local.
    if ($info -and $info.NextRunTime -and $t.Settings.Enabled) {
        if (-not $nextSlot -or $info.NextRunTime -lt $nextSlot.When) {
            $nextSlot = [pscustomobject]@{ Task = $name; When = $info.NextRunTime }
        }
    }
}
if ($running.Count -gt 0) {
    Refuse 75 ("ingest task(s) RUNNING: " + ($running -join ', ') +
               " - a corpus moving underneath the generator produces a bake nobody can reproduce")
}

$liveNode = @()
try {
    $liveNode = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'ingest-|generate-consensus|supervise-otp' } |
        ForEach-Object { "pid=$($_.ProcessId)" })
} catch {
    Refuse 75 "could not enumerate node processes to prove nothing is ingesting: $($_.Exception.Message)"
}
if ($liveNode.Count -gt 0) {
    Refuse 75 ("live ingest/generator node process(es): " + ($liveNode -join ', '))
}

# A hand-run priority walk announces itself with a lock file even between
# chunks, when no node process is up.
foreach ($lock in @('.otp-priority.lock', 'otp-priority.lock')) {
    if (Test-Path (Join-Path $Root $lock)) { Refuse 75 "$lock present - a priority walk is in flight" }
}

if ($nextSlot) {
    $clearance = [int]($nextSlot.When - (Get-Date)).TotalMinutes
    Say "next scheduled writer: $($nextSlot.Task) at $($nextSlot.When) local ($clearance min clearance)"
    if ($clearance -lt $DeadlineMinutes) {
        Refuse 75 ("only $clearance min before $($nextSlot.Task) - this run needs $DeadlineMinutes. " +
                   "Two Riot-calling jobs share ONE key budget and exceeding it SUSPENDS the key.")
    }
} else {
    Say "next scheduled writer: none found (no enabled ingest task has a NextRunTime)"
}
Say "preconditions clear: no task running, no ingest node process, no lock file"

# ── (70) git preconditions ─────────────────────────────────────────────────
$branchNow = (& git rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
if ($branchNow -ne $Branch) { Refuse 70 "on branch '$branchNow', expected '$Branch'" }

$dirty = (& git status --porcelain -- $artifactRel 2>&1 | Out-String).Trim()
if ($dirty -ne '') { Refuse 70 "$artifactRel already has uncommitted changes ('$dirty') - a human is mid-bake" }

# ── (71) auth, proven BEFORE any work is done ──────────────────────────────
# A scheduled task runs without an interactive shell. Both of these are
# file-backed on this machine (git's `store` helper reads ~/.git-credentials;
# the Vercel CLI reads AppData\Roaming\xdg.data\com.vercel.cli\auth.json), so
# both SHOULD work unattended - but "should" is how a scheduled job fails
# silently for a month. Prove it in under two seconds, before spending two
# minutes of Neon compute on a bake that could not have been shipped anyway.
#
# GIT_TERMINAL_PROMPT=0 is the whole point: without it a missing credential
# BLOCKS on a prompt that no one will ever answer, and the task sits Running
# until its ExecutionTimeLimit kills it.
$env:GIT_TERMINAL_PROMPT = '0'
$remoteHead = (& git ls-remote origin $Branch 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $remoteHead -eq '') {
    Refuse 71 "git ls-remote origin $Branch failed with no terminal prompt available: $remoteHead"
}
$remoteSha = ($remoteHead -split '\s+')[0]
$localSha = (& git rev-parse HEAD 2>&1 | Out-String).Trim()
if ($remoteSha -ne $localSha) {
    Refuse 70 ("local HEAD $($localSha.Substring(0,7)) != origin/$Branch $($remoteSha.Substring(0,7)). " +
               "Reconcile by hand - this script never force-pushes and never resets.")
}
Say "git auth OK, HEAD in sync with origin/$Branch at $($localSha.Substring(0,7))"

$who = (& npx vercel whoami 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0 -or $who -notmatch 'harout-b5-1151') {
    Refuse 71 "vercel CLI is not authenticated as harout-b5-1151 in this context: $($who.Trim())"
}
Say "vercel auth OK (harout-b5-1151)"

# ── what production is serving RIGHT NOW ───────────────────────────────────
# Fetched, never read out of a handoff. The served file is the only thing the
# regression guard can honestly compare against: the file on disk is what the
# LAST run wrote, which is not necessarily what is deployed.
function Get-ArtifactFacts($text, $label) {
    $patch = $null; $combos = $null; $pro = $null; $otp = $null
    if ($text -match '"patch":\s*"([^"]+)"') { $patch = $Matches[1] }
    if ($text -match '"coverage":\s*\{"combos":(\d+),"pro":(\d+),"otp":(\d+)\}') {
        $combos = [int]$Matches[1]; $pro = [int]$Matches[2]; $otp = [int]$Matches[3]
    }
    if ($null -eq $patch -or $null -eq $otp) { return $null }
    return [pscustomobject]@{
        Label = $label; Patch = $patch; Combos = $combos; Pro = $pro; Otp = $otp
        Bytes = [System.Text.Encoding]::UTF8.GetByteCount($text)
    }
}

# PS 5.1 hands back Content as a string for some content types and a byte[] for
# others depending on how the response is sniffed; decode either shape rather
# than [string]-casting a byte[] into "System.Byte[]" and calling it a 404.
function Read-ArtifactText($uri) {
    $r = Invoke-WebRequest -Uri $uri -UseBasicParsing `
            -Headers @{ 'Cache-Control' = 'no-cache' } -TimeoutSec 60
    if ($r.StatusCode -ne 200) { return $null }
    if ($r.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($r.Content) }
    return [string]$r.Content
}

$servedText = $null
try { $servedText = Read-ArtifactText "$CompareBase/consensus/item-set-consensus.json" } catch { }
if (-not $servedText) {
    # FAIL CLOSED. A 404 here is served AS application/json (vercel.json's
    # /consensus/(.*) header rule applies to the 404 page too), so a parse
    # failure is indistinguishable from a missing file by content-type - and
    # either way there is nothing to compare a regression against.
    Refuse 80 "could not fetch the served artifact from $CompareBase - nothing to compare against, refusing to bake blind"
}
$served = Get-ArtifactFacts $servedText 'served'
if (-not $served) { Refuse 80 "the served artifact did not parse as a consensus artifact (a 404 page is served as application/json - check the URL)" }
Say "served: patch=$($served.Patch) combos=$($served.Combos) pro=$($served.Pro) otp=$($served.Otp) bytes=$($served.Bytes)"

if ((Get-Date) -gt $deadline) { Refuse 79 "deadline reached before generation started" }

# ── generate, into a TEMP file ─────────────────────────────────────────────
# Never straight over the tracked file. A failed or no-op generation must leave
# the working tree exactly as it found it; writing first and deciding afterwards
# is how a half-written artifact ends up staged by somebody else's `git add -A`.
$stampForName = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$tmpOut = Join-Path $env:TEMP "rebake-consensus-$stampForName.json"
Say "generating against $Base (~1,730 requests, ~5 min, ~0.03 CU-hours)"
& npx tsx scripts/generate-consensus-artifact.mts --base $Base --out $tmpOut 2>&1 |
    Out-File -FilePath $log -Append -Encoding utf8
$genCode = $LASTEXITCODE
if ($genCode -ne 0 -or -not (Test-Path $tmpOut)) {
    Refuse 80 "generation failed (exit $genCode) - see the lines above in $log"
}

$newText = Get-Content $tmpOut -Raw
$new = Get-ArtifactFacts $newText 'new'
if (-not $new) { Refuse 80 "the generated file did not parse as a consensus artifact" }
Say "generated: patch=$($new.Patch) combos=$($new.Combos) pro=$($new.Pro) otp=$($new.Otp) bytes=$($new.Bytes)"

# ── (77) patch flip ────────────────────────────────────────────────────────
# When the live patch moves, isConsensusArtifactFresh goes false for all 865
# combos at once and the whole export silently reverts to the database path.
# That IS the case this job most needs to catch - but it is also the one case
# where the coverage guard below cannot help, because a fresh patch legitimately
# bakes thin and "did coverage regress?" is meaningless across patches.
#
# So: refuse, loudly, and let LastTaskResult 77 be the alarm. This converts the
# silent quota regression that five handoff entries flagged into a visible one,
# without letting an unattended job decide on its own that a thin new-patch
# artifact is fine to ship.
$patchFlipAccepted = $false
if ($new.Patch -ne $served.Patch) {
    if (-not $AcceptPatchFlip) {
        Refuse 77 ("PATCH FLIP: serving $($served.Patch), generated $($new.Patch). The deployed artifact " +
                   "is now STALE for every combo and the export has silently reverted to the database. " +
                   "A first-bake-of-a-patch is thin by nature and coverage cannot be compared across " +
                   "patches, so this needs a human: re-run with -AcceptPatchFlip. Generated file kept at $tmpOut")
    }
    $patchFlipAccepted = $true
    Say ("PATCH FLIP ACCEPTED by operator: serving $($served.Patch), generated $($new.Patch); " +
         "cross-patch coverage guard (76) skipped")
} elseif ($AcceptPatchFlip) {
    Say "-AcceptPatchFlip given but patches match ($($new.Patch)); ignored"
}

# ── (76) coverage.otp must not regress ─────────────────────────────────────
# Compared against what is SERVED, not against the file on disk and never
# against a number written in a document.
#
# It runs BEFORE the no-op check, deliberately. If the artifact turns out to be
# unchanged the job ships nothing anyway, so a refusal here costs nothing - but
# "served coverage is HIGHER than anything this repo can produce" means the repo
# and production have diverged (something was deployed from another checkout),
# and that is worth a loud refusal rather than a quiet no-op that hides it.
#
# A deliberate floor change CAN lower this legitimately - that is exactly what
# 26ce46a did, 546 -> 265 - and refusing is still the correct behaviour here.
# That bake needed a human to predict the new number in advance and reconcile
# every one of the 281 losses against `n <= 20`. An unattended job has no way to
# tell a deliberate narrowing from a corpus that has gone wrong, and the two
# look identical from here.
if (-not $patchFlipAccepted -and $new.Otp -lt $served.Otp) {
    Refuse 76 ("coverage.otp REGRESSED $($served.Otp) -> $($new.Otp). Refusing to commit, push or " +
               "deploy. If this is an intended narrowing (a floor change), bake it by hand and " +
               "reconcile the losses. Generated file kept at $tmpOut")
}
# The pro side gets a warning rather than a refusal: it is not what this job
# exists to protect, and pro entries legitimately churn as the match corpus
# grows. Stated so a reader does not mistake silence for a check.
if ($new.Pro -lt $served.Pro) {
    Say "WARNING: coverage.pro fell $($served.Pro) -> $($new.Pro). Not a refusal (this job gates on otp), but worth a look."
}
if ($patchFlipAccepted) {
    Say "coverage not compared (patch flip): otp $($served.Otp) -> $($new.Otp), pro $($served.Pro) -> $($new.Pro), patch $($served.Patch) -> $($new.Patch)"
} else {
    Say "coverage OK: otp $($served.Otp) -> $($new.Otp), pro $($served.Pro) -> $($new.Pro), patch $($new.Patch) unchanged"
}

# ── the NO-OP path - the common case, and it must not churn ────────────────
# Reached only once the patch matches and coverage has not regressed.
# The serializer is deterministic and one-line-per-combo precisely so that
# identical data regenerates to an identical file. Everything except generatedAt
# must match; generatedAt changes on every single run by construction and means
# nothing on its own.
#
# CRLF is normalised away before comparing. core.autocrlf is `input` on this
# machine so both files are LF today, but a checkout on a box configured
# otherwise would make every single week a "change" and turn this job into the
# commit-churn it exists to avoid.
function Get-ComparableArtifact($t) {
    return ((($t -replace "`r`n", "`n") -split "`n") | Where-Object { $_ -notmatch '^"generatedAt":' }) -join "`n"
}
$currentText = Get-Content $artifactAbs -Raw
if ((Get-ComparableArtifact $newText) -eq (Get-ComparableArtifact $currentText)) {
    Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
    Say ("NO-OP: regenerated artifact is byte-identical to $artifactRel except generatedAt " +
         "(patch $($new.Patch), pro $($new.Pro), otp $($new.Otp)). No commit, no push, no deployment.")
    Say "done in $([int]((Get-Date) - $startedAt).TotalMinutes) min"
    exit 0
}

if ($DryRun) {
    Say "-DryRun: would commit, push and deploy otp $($served.Otp) -> $($new.Otp). Generated file kept at $tmpOut"
    exit 0
}
if ((Get-Date) -gt $deadline) { Refuse 79 "deadline reached before commit - nothing was committed, pushed or deployed" }

# ── commit, by explicit path ───────────────────────────────────────────────
Copy-Item $tmpOut $artifactAbs -Force
$msg = "chore(consensus): scheduled re-bake - otp $($served.Otp) -> $($new.Otp), pro $($served.Pro) -> $($new.Pro) (patch $($new.Patch))"
& git add -- $artifactRel 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
& git commit -m $msg 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) { Refuse 80 "git commit failed - see $log" }
$sha = (& git rev-parse HEAD 2>&1 | Out-String).Trim()
Say "committed $($sha.Substring(0,7)): $msg"

# Verify the bytes are in the COMMIT TREE, not merely on disk. Explicit-path
# staging silently drops files in some situations and no working-tree check
# detects it; `git cat-file` reads the object database.
$treeBytes = (& git cat-file -s "${sha}:$artifactRel" 2>&1 | Out-String).Trim()
$diskBytes = (Get-Item $artifactAbs).Length
if ("$treeBytes" -ne "$diskBytes") {
    Refuse 80 "commit tree holds $treeBytes bytes for $artifactRel but disk holds $diskBytes - NOT pushing"
}
Say "commit tree verified: $treeBytes bytes at ${sha}:$artifactRel"

# ── push ───────────────────────────────────────────────────────────────────
# Plain fast-forward. Never --force, never --no-verify.
& git push origin $Branch 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
if ($LASTEXITCODE -ne 0) { Refuse 80 "git push failed - see $log. NOT deploying an unpushed tree." }
$remoteAfter = ((& git ls-remote origin $Branch 2>&1 | Out-String).Trim() -split '\s+')[0]
if ($remoteAfter -ne $sha) { Refuse 80 "push reported success but origin/$Branch is $remoteAfter, not $sha" }
Say "pushed $($sha.Substring(0,7)) -> origin/$Branch (verified by ls-remote, no --force)"

# ── deploy, from a clean detached worktree ─────────────────────────────────
$wt = Join-Path (Split-Path $Root -Parent) ".cb-rebake-deploy-$stampForName"
& git worktree add --detach $wt $sha 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $wt)) { Refuse 80 "could not create deploy worktree at $wt" }

$deployUrl = $null
$deployFailure = $null
try {
    # The check the whole worktree exists for. --archive=tgz uploads the
    # directory it runs in; the repo's working tree carries a gitignored
    # .env.local pointing at the OLD exhausted Neon project.
    $envFiles = @(Get-ChildItem -Path $wt -Recurse -Depth 2 -Force -Filter '.env*' -ErrorAction SilentlyContinue)
    if ($envFiles.Count -gt 0) {
        $deployFailure = "deploy worktree contains " + (($envFiles | ForEach-Object { $_.FullName }) -join ', ') + " - refusing to upload it"
    } else {
        # Only .vercel/project.json is copied in. An unlinked `--yes` does not
        # fail, it CREATES A NEW PROJECT and deploys there - a success message
        # for a deployment nobody will ever see.
        New-Item -ItemType Directory -Path (Join-Path $wt '.vercel') -Force | Out-Null
        Copy-Item (Join-Path $Root '.vercel\project.json') (Join-Path $wt '.vercel\project.json') -Force
        Say "deploying from clean worktree $wt (no .env* present, project linked)"
        Push-Location $wt
        $out = (& npx vercel --prod --archive=tgz --yes 2>&1 | Out-String)
        $deployCode = $LASTEXITCODE
        Pop-Location
        $out | Out-File -FilePath $log -Append -Encoding utf8
        if ($deployCode -ne 0) {
            $deployFailure = "vercel deploy exited $deployCode"
        } else {
            $m = [regex]::Matches($out, 'https://[a-z0-9\-]+\.vercel\.app')
            if ($m.Count -gt 0) { $deployUrl = $m[$m.Count - 1].Value }
        }
    }
} finally {
    # Plain remove, never --force.
    & git worktree remove $wt 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
    if (Test-Path $wt) { Say "WARNING: deploy worktree $wt still present - remove it by hand" }
}
if ($deployFailure) { Refuse 80 $deployFailure }
Say "deployed: $deployUrl"

# ── verify by the SHIPPED BYTES ────────────────────────────────────────────
# Not by the deploy's exit code. The alias takes a moment to move, so retry -
# but a persistent mismatch is a failure, not a slow CDN.
$verified = $false
for ($a = 1; $a -le 6; $a++) {
    Start-Sleep -Seconds 10
    try {
        $liveText = Read-ArtifactText "$Base/consensus/item-set-consensus.json"
        $facts = Get-ArtifactFacts $liveText 'live'
        if ($facts -and $facts.Otp -eq $new.Otp -and $facts.Patch -eq $new.Patch -and $facts.Bytes -eq $new.Bytes) {
            Say "VERIFIED live after $($a * 10)s: patch=$($facts.Patch) otp=$($facts.Otp) bytes=$($facts.Bytes)"
            $verified = $true
            break
        }
        # Byte count, not content-type: /consensus/* 404s are served AS
        # application/json by vercel.json's header rule, so content-type cannot
        # tell a missing file from a real one. Status and size can.
        Say "not live yet (attempt $a/6): otp=$(if ($facts) { $facts.Otp } else { 'unparsed' }) bytes=$(if ($facts) { $facts.Bytes } else { 'n/a' })"
    } catch { Say "verification fetch failed (attempt $a/6): $($_.Exception.Message)" }
}
if (-not $verified) {
    Refuse 80 ("deployed $deployUrl but $Base is still not serving the new artifact after 60s. " +
               "The commit is pushed; re-run or deploy by hand.")
}

Remove-Item $tmpOut -Force -ErrorAction SilentlyContinue
Say "done: otp $($served.Otp) -> $($new.Otp), commit $($sha.Substring(0,7)), $deployUrl, $([int]((Get-Date) - $startedAt).TotalMinutes) min"
exit 0
