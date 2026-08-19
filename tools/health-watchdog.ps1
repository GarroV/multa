# Multa health watchdog for MUSPELHEIM (issue #135).
#
# WHY THIS EXISTS, and why the existing "Docker Watchdog" is not enough:
# on 2026-08-19 the product was down for an hour with every usual health sign green.
# WSL auto-updated itself from the Microsoft Store; RestartManager could not restart
# wslrelay.exe ("Application SID does not match Conductor SID"), a fresh wslrelay came
# up, took port 80 -- and never rebuilt the forward into the container. Docker Desktop
# itself never restarted, so `docker info` was fine, containers were "Up (healthy)",
# Caddy logs were clean, and `wget` INSIDE the container answered 200. Only the outside
# was dead. "Is Docker alive" cannot see this. "Does the product answer" can.
#
# WHAT IT DOES
#   1. asks the product the way the world asks it: http://localhost/v1/health
#   2. answers 200 -> exit silently (no log, no action)
#   3. no answer -> ask the same thing INSIDE the web container:
#        alive inside  => the forward is hanging: restart multa-web-1 (the exact fix
#                         that worked by hand on 2026-08-19)
#        dead inside   => the app itself is down: bring the stack up with the prod file
#   4. verify after acting, and log the outcome either way
#
# WHAT IT MUST NEVER DO
#   * touch Docker Desktop or WSL as a whole. Twenty containers from other projects live
#     on this machine (dodo-pnl, forge-channel, quokka, n8n...); a blanket restart to fix
#     Multa would take them all down. Only multa-* containers are ever touched.
#   * fight a deploy. deploy.cmd recreates containers, and a watchdog racing it would
#     restart a half-built stack. A container younger than $GraceSeconds is left alone.
#   * loop. If the app is genuinely broken, restarting every few minutes hides the problem
#     and fills the log. One action per $ThrottleMinutes, then it waits and keeps logging.
#
# Log: C:\bootstrap\health-watchdog.log -- written only when something is wrong or done.
# ASCII-only on purpose: this file travels over scp to a Windows box, and the existing
# watchdog learned the hard way that non-ASCII comes back as question marks.

param(
    [string]$Url = 'http://localhost/v1/health',
    [string]$WebContainer = 'multa-web-1',
    [string]$ComposeFile = 'C:\projects\multa\docker-compose.prod.yml',
    [string]$LogPath = 'C:\bootstrap\health-watchdog.log',
    [string]$StatePath = 'C:\bootstrap\health-watchdog.state',
    [int]$TimeoutSeconds = 8,
    # A container this young is still starting (or a deploy is in flight): hands off.
    [int]$GraceSeconds = 120,
    # Shortest gap between two repair attempts.
    [int]$ThrottleMinutes = 10,
    # Test hook: pretend the outside check failed, to exercise the repair path for real
    # without breaking production. Everything after the first check runs unchanged.
    [switch]$SimulateOutageForTest
)

$ErrorActionPreference = 'Continue'

function Log($message) {
    Add-Content -Path $LogPath -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message)
}

# curl.exe rather than Invoke-WebRequest: it is what proved the outage by hand, it does
# not depend on the IE engine, and it reports a bare status code we can compare.
function Get-HttpStatus($target) {
    $code = & curl.exe -s -o NUL -m $TimeoutSeconds -w '%{http_code}' $target 2>$null
    if ($LASTEXITCODE -ne 0) { return 0 }
    return [int]$code
}

function Test-InsideContainer {
    # Same question, asked from inside the container: separates "the forward is broken"
    # from "the app is broken". On 2026-08-19 this returned 200 while the outside was dead.
    $out = & docker exec $WebContainer wget -q -O - --timeout=5 http://localhost:80/v1/health 2>$null
    return ($LASTEXITCODE -eq 0 -and $out -match '"ok"\s*:\s*true')
}

function Get-ContainerAgeSeconds {
    $startedAt = & docker inspect $WebContainer --format '{{.State.StartedAt}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $startedAt) { return -1 }
    try {
        return [int]((Get-Date).ToUniversalTime() - [datetime]::Parse($startedAt).ToUniversalTime()).TotalSeconds
    } catch {
        return -1
    }
}

function Test-Throttled {
    if (-not (Test-Path $StatePath)) { return $false }
    try {
        $last = [datetime]::Parse((Get-Content $StatePath -First 1))
    } catch {
        return $false
    }
    return ((Get-Date) - $last).TotalMinutes -lt $ThrottleMinutes
}

function Set-ActionStamp {
    Set-Content -Path $StatePath -Value (Get-Date -Format 'o')
}

# --- 1. the only question that matters ---------------------------------------------
$status = Get-HttpStatus $Url
if ($SimulateOutageForTest) {
    Log "TEST: pretending the outside check failed (real status was $status)"
    $status = 0
}
if ($status -eq 200) { exit 0 }

# Docker itself down is the other watchdog's job -- saying so beats acting on it twice.
& docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Log "product unreachable (status $status) AND docker engine unreachable - leaving it to Docker Watchdog"
    exit 1
}

$age = Get-ContainerAgeSeconds
if ($age -ge 0 -and $age -lt $GraceSeconds) {
    Log "product unreachable (status $status) but $WebContainer is only ${age}s old - starting up or mid-deploy, skip"
    exit 0
}

if (Test-Throttled) {
    Log "product unreachable (status $status) but repaired less than $ThrottleMinutes min ago - not looping, needs a human"
    exit 1
}

# --- 2. which of the two failures is it? ------------------------------------------
$aliveInside = Test-InsideContainer
Set-ActionStamp

if ($aliveInside) {
    Log "product unreachable (status $status) while alive inside the container - port forward hanging, restarting $WebContainer"
    & docker restart $WebContainer *> $null
} else {
    Log "product unreachable (status $status) and dead inside the container too - bringing the stack up"
    & docker compose -f $ComposeFile up -d *> $null
}

# --- 3. did it help? ---------------------------------------------------------------
# Up to ~2 minutes, and that number is measured rather than guessed. With the forward
# intact a restart is back in ~1s (measured on the box). With the forward hanging --
# the case this watchdog exists for -- rebuilding it took longer than 45s on
# 2026-08-19, so the first version reported "STILL DOWN" about a product that came
# back a moment later. A recreated api also waits for a healthy postgres first.
$recovered = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 3
    if ((Get-HttpStatus $Url) -eq 200) { $recovered = $true; break }
}

if ($recovered) {
    Log 'recovered: product answers again'
    exit 0
}

Log 'STILL DOWN after repair attempt - needs a human'
exit 1
