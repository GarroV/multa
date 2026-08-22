# Multa autodeploy for MUSPELHEIM (issue #14).
#
# WHY THIS EXISTS
# Until 2026-08-22 every deploy needed a human to type one command, even when the code was
# already pushed, reviewed and green. Worse, the person typing it was usually not the person
# who wrote the code: the assistant cannot run a deploy (the permission classifier blocks
# irreversible outward actions, and rightly so), so the owner had to finish someone else's
# work by hand. That is exactly the kind of chore a scheduled task does better.
#
# WHAT IT DOES, every few minutes
#   1. fetch origin/main
#   2. compare it with the commit the running stack was BUILT from (.deployed), not with
#      the working tree: the tree can already hold new code while containers are still old
#      -- that is precisely the state a manual deploy leaves behind when it is skipped
#   3. nothing new -> exit silently (no log line, no action)
#   4. new commit -> check out, back up the database, run deploy.cmd, smoke the health
#      endpoint, and record the commit as deployed
#
# WHAT IT MUST NEVER DO
#   * run two deploys at once. deploy.cmd rebuilds images for minutes while the task fires
#     every few minutes; a second builder would fight the first over the same containers.
#     A lock file guards it, and a stale lock (crash, reboot mid-build) expires by time.
#   * retry a broken build forever. The commit is recorded as deployed once the build
#     itself finished, even if the smoke check then failed: a bad commit must be fixed by
#     a new commit, not rebuilt every five minutes while the log fills up.
#   * deploy without a database backup. Migrations run on api start (dist/migrate.js), so
#     by the time anything looks wrong the schema has already moved.
#
# Log: C:\projects\multa\autodeploy.log -- written only when something happened.
# ASCII-only on purpose: this file runs on a Windows box where .ps1 without a BOM is read
# as ANSI, and non-ASCII comments come back as garbage (the same lesson the health
# watchdog learned).

param(
    [string]$Repo = 'C:\projects\multa',
    [string]$Branch = 'main',
    [string]$LogPath = 'C:\projects\multa\autodeploy.log',
    [string]$StatePath = 'C:\projects\multa\.deployed',
    [string]$LockPath = 'C:\projects\multa\.autodeploy.lock',
    [string]$BackupDir = 'C:\backups\multa-autodeploy',
    [string]$HealthUrl = 'http://localhost/v1/health',
    [int]$LockStaleMinutes = 40,
    [int]$KeepBackups = 5
)

$ErrorActionPreference = 'Stop'

# Git talks on stderr even when all is well ("From github.com:..."), and PowerShell with
# ErrorActionPreference=Stop turns that into a fatal NativeCommandError -- the first version of
# this script died on a successful fetch, before it could log anything. Routing git through cmd
# keeps its chatter away from the PowerShell error stream; the exit code is what we judge by.
function Invoke-Git([string]$Arguments) {
    $out = cmd /c "git $Arguments 2>&1"
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join [Environment]::NewLine) }
}

function Write-Log([string]$Message) {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -Path $LogPath -Value "$stamp $Message" -Encoding utf8
}

# A lock older than $LockStaleMinutes is a leftover from a crash or a reboot mid-build, not
# a live deploy: a full rebuild takes minutes, never that long.
if (Test-Path $LockPath) {
    $age = (Get-Date) - (Get-Item $LockPath).LastWriteTime
    if ($age.TotalMinutes -lt $LockStaleMinutes) { exit 0 }
    Write-Log "lock is stale ($([int]$age.TotalMinutes) min) -- taking over"
}

Set-Content -Path $LockPath -Value $PID -Encoding ascii

try {
    Set-Location $Repo

    # --depth=1: the server never needs history, only the tip of the branch.
    $fetch = Invoke-Git "fetch --depth=1 origin $Branch"
    if ($fetch.Code -ne 0) {
        Write-Log "fetch failed (exit $($fetch.Code)): $($fetch.Out)"
        exit 1
    }

    $rev = Invoke-Git "rev-parse origin/$Branch"
    if ($rev.Code -ne 0) {
        Write-Log "rev-parse failed (exit $($rev.Code)): $($rev.Out)"
        exit 1
    }
    $target = $rev.Out.Trim()
    $deployed = if (Test-Path $StatePath) { (Get-Content $StatePath -Raw).Trim() } else { '' }

    if ($target -eq $deployed) { exit 0 }

    $short = $target.Substring(0, 7)
    $from = if ($deployed) { $deployed.Substring(0, 7) } else { 'unknown' }
    Write-Log "new commit $short (running stack built from $from) -- deploying"

    $checkout = Invoke-Git "checkout -f -B $Branch origin/$Branch"
    if ($checkout.Code -ne 0) {
        Write-Log "checkout failed (exit $($checkout.Code)): $($checkout.Out)"
        exit 1
    }

    # Backup before the build: api applies migrations at start, so a schema change is
    # already in effect by the time anyone notices trouble.
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $dump = Join-Path $BackupDir "before_$short.sql"
    cmd /c "docker exec multa-postgres-1 pg_dump -U multa -d multa > `"$dump`" 2>nul"
    if (-not (Test-Path $dump) -or (Get-Item $dump).Length -eq 0) {
        Write-Log 'backup produced nothing -- deploy aborted (postgres down?)'
        exit 1
    }
    # Keep the last few: these are deploy insurance, not the backup archive (that is what
    # the daily "PG Docker Backup" task is for).
    Get-ChildItem $BackupDir -Filter 'before_*.sql' |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $KeepBackups |
        Remove-Item -Force -ErrorAction SilentlyContinue

    cmd /c "$Repo\deploy.cmd"
    $tail = if (Test-Path "$Repo\deploy.log") { Get-Content "$Repo\deploy.log" -Tail 1 } else { '' }
    $built = $tail -match 'DEPLOY_DONE_0'

    if (-not $built) {
        Write-Log "build FAILED for $short ($tail) -- stack left as it was, fix and push again"
        # Recorded anyway: a broken commit must be fixed by the next commit, not rebuilt
        # every few minutes.
        Set-Content -Path $StatePath -Value $target -Encoding ascii
        exit 1
    }

    # The product is asked the way the world asks it, from outside the container.
    $ok = $false
    try {
        $res = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 10 -UseBasicParsing
        $ok = $res.StatusCode -eq 200
    } catch {
        $ok = $false
    }

    Set-Content -Path $StatePath -Value $target -Encoding ascii
    if ($ok) {
        Write-Log "deployed $short -- health 200"
    } else {
        Write-Log "deployed $short -- BUILD OK but health check did not answer 200"
    }
} finally {
    Remove-Item $LockPath -Force -ErrorAction SilentlyContinue
}
