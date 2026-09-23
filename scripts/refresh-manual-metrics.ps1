# Unattended refresh of the Manual Metrics data feeding company-scorecard.html's
# "Entered by hand" section.
#
# Runs parse-manual-metrics.ps1 against the OneDrive workbook and, if
# docs/data/manual-metrics.json actually changed, commits and pushes it.
# Same shape as refresh-hvac-sales.ps1 -- meant to be driven by Windows Task
# Scheduler a few times a day (see the Register-ScheduledTask snippet at the
# bottom of this file), but also fine to double-click / run by hand any time.
#
# It is a true no-op (writes nothing at all) only when the workbook is open
# in Excel or unreachable -- parser exits 1, nothing is written, the live
# scorecard keeps its last-good numbers. Otherwise every successful run
# commits and pushes SOMETHING: docs/data/manual-metrics.json when the
# parsed data actually changed (the first run after a department manager
# edits the sheet is the one that ships), and always
# docs/data/refresh-health.json, a tiny timestamp file the dashboard reads
# to show whether this pipeline is still alive -- added after a real
# incident (2026-09-21 through 2026-09-23) where a different refresh
# script failed silently for two days before anyone noticed.
#
# Requirements on the machine it runs on: Excel installed, the OneDrive
# folder synced locally (not online-only), git on PATH with push
# credentials cached, and the user logged in (Excel COM needs a real
# session, so schedule it "run only when user is logged on").

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataFile = "docs/data/manual-metrics.json"
$HealthFile = "docs/data/refresh-health.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-manual-metrics.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

# Records that this script successfully reached and parsed its source --
# separate from $DataFile itself because that file's commit-on-diff logic
# has no per-run timestamp of its own (a timestamp there would make every
# run look like a change). See refresh-hvac-sales.ps1's copy of this same
# function for the real incident it exists to catch faster next time.
function RecordHealthCheck([string]$Key) {
  $health = if (Test-Path $HealthFile) { Get-Content $HealthFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $health | Add-Member -NotePropertyName $Key -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")) -Force
  ($health | ConvertTo-Json) | Out-File -FilePath $HealthFile -Encoding utf8
}

Set-Location $RepoRoot

# Serialize against the other refresh scripts (HVAC Sales, Commission
# Report) -- all of them run git pull/commit/push against this same
# TeamRegal checkout, and if two fire close enough together, git's own
# ref-locking makes one fail outright rather than just wait (real incident
# 2026-09-21 through 2026-09-23: this task and Commission Report were
# scheduled at the identical times and silently failed nearly every run
# for two days with "cannot lock ref" / "Cannot fast-forward to multiple
# branches"). A named Mutex holds even if trigger times ever drift back
# into collision, or a run just happens to take longer than usual --
# unlike relying on the schedule's own spacing, which is a guess about how
# long each run takes.
$repoLock = New-Object System.Threading.Mutex($false, "Global\TeamRegal-Refresh-Lock")
if (-not $repoLock.WaitOne([TimeSpan]::FromMinutes(5))) {
  Log "Could not get the shared TeamRegal refresh lock within 5 minutes -- another refresh script is still running (or stuck); skipping this run rather than racing it"
  exit 1
}

try {
  Log "--- refresh start ---"

  # 1. Pull TeamRegal itself first -- this script invokes
  #    parse-manual-metrics.ps1 from the local checkout on disk, so a stale
  #    clone would silently keep running old parsing logic forever even
  #    after a fix is pushed to main (see refresh-commission-report.ps1's
  #    header comment for the real incident this pattern is copied from).
  & git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) {
    Log "git pull in TeamRegal failed ($LASTEXITCODE), aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
  }

  # 2. Parse the workbook. Non-zero exit = locked/missing source;
  #    parse-manual-metrics.ps1 guarantees it wrote nothing in that case.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "parse-manual-metrics.ps1")
  if ($LASTEXITCODE -ne 0) {
    Log "parser exited $LASTEXITCODE (workbook locked, offline, or missing), nothing to do"
    Log "--- refresh end (skipped) ---"
    exit 0
  }

  # 2.5. Reaching here means the workbook was readable and parsed cleanly --
  #      record that regardless of whether $DataFile itself changed below.
  RecordHealthCheck "manualMetrics"

  # 3. Did the committed data file actually change? Either way there's now
  #    something to commit -- at minimum the health check above, which
  #    always differs run to run.
  & git diff --quiet -- $DataFile
  $filesToCommit = @($HealthFile)
  $commitMessage = "Refresh health check"
  if ($LASTEXITCODE -ne 0) {
    $filesToCommit += $DataFile
    $commitMessage = "Refresh manual metrics"
    Log "$DataFile changed, committing"
  } else {
    Log "no change in $DataFile, recording health check only"
  }

  # 4. Commit just these files (path-scoped, so any unrelated dirty file in
  #    the tree is left alone).
  & git add -- $filesToCommit
  & git commit -q -m $commitMessage -- $filesToCommit
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

  # 5. Rebase onto whatever the hourly HCP sync bot (or any other refresh
  #    script) pushed in the meantime, then push. --autostash so an
  #    unrelated dirty file doesn't block the rebase. One retry if the push
  #    races another commit.
  foreach ($attempt in 1..2) {
    & git fetch origin main
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed ($LASTEXITCODE)" }
    & git rebase --autostash FETCH_HEAD
    if ($LASTEXITCODE -ne 0) {
      & git rebase --abort 2>$null
      throw "git rebase failed ($LASTEXITCODE), resolve by hand"
    }
    & git push origin HEAD:main
    if ($LASTEXITCODE -eq 0) {
      Log "pushed (attempt $attempt)"
      Log "--- refresh end (pushed) ---"
      exit 0
    }
    Log "push rejected on attempt $attempt, retrying after rebase"
    Start-Sleep -Seconds 3
  }
  throw "git push failed after 2 attempts"
}
catch {
  Log "ERROR: $($_.Exception.Message)"
  Log "--- refresh end (error) ---"
  exit 1
}
finally {
  $repoLock.ReleaseMutex()
}

# ---------------------------------------------------------------------------
# One-time setup: register the scheduled task (run once in PowerShell as the
# user who owns the OneDrive folder; no admin needed for a user task).
# Fires 12:40, 16:10 and 19:10 on weekdays -- deliberately NOT the same
# slots as refresh-hvac-sales.ps1 (12:30/16:00/19:00) or
# refresh-commission-report.ps1 (12:35/16:05/19:05). This task used to sit
# on Commission Report's exact times, and both scripts run git pull/commit/
# push against this same checkout -- when they fired together, git's own
# ref-locking made one fail outright, silently, for two days
# (2026-09-21 through 2026-09-23) before anyone noticed. All three scripts
# now also hold a shared mutex around their whole run as a second, timing-
# independent guard against this -- see refresh-hvac-sales.ps1's own
# comment on it -- but keep these three schedules staggered anyway so a
# normal run rarely has to wait on another one at all.
#
#   $ps  = "powershell.exe"
#   $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\dev\TeamRegal\scripts\refresh-manual-metrics.ps1"'
#   $act = New-ScheduledTaskAction -Execute $ps -Argument $arg
#   $trg = @(
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 12:40PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:10PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 7:10PM
#   )
#   $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
#   Register-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics" -Action $act -Trigger $trg -Settings $set -Description "Parse the Manual Metrics workbook and push docs/data/manual-metrics.json if it changed."
#
# Check what it's been doing:   Get-Content "$env:LOCALAPPDATA\TeamRegal\refresh-manual-metrics.log" -Tail 40
# Run it now without waiting:    Start-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics"
# Remove it:                     Unregister-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics" -Confirm:$false
# ---------------------------------------------------------------------------
