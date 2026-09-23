# Unattended refresh of the Manual Metrics data feeding company-scorecard.html's
# "Entered by hand" section.
#
# Runs parse-manual-metrics.ps1 against the OneDrive workbook and, if
# docs/data/manual-metrics.json actually changed, commits and pushes it.
# Same shape as refresh-hvac-sales.ps1 -- meant to be driven by Windows Task
# Scheduler a few times a day (see the Register-ScheduledTask snippet at the
# bottom of this file), but also fine to double-click / run by hand any time.
#
# It is a no-op when:
#   - the workbook is open in Excel or unreachable (parser exits 1, nothing
#     is written, the live scorecard keeps its last-good numbers)
#   - the parsed data is byte-for-byte identical to what's committed
#
# So scheduling it often is cheap: most runs do nothing, and the first run
# after a department manager edits the sheet is the one that ships.
#
# Requirements on the machine it runs on: Excel installed, the OneDrive
# folder synced locally (not online-only), git on PATH with push
# credentials cached, and the user logged in (Excel COM needs a real
# session, so schedule it "run only when user is logged on").

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataFile = "docs/data/manual-metrics.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-manual-metrics.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
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

  # 3. Did the committed file actually change?
  & git diff --quiet -- $DataFile
  if ($LASTEXITCODE -eq 0) {
    Log "no change in $DataFile, nothing to commit"
    Log "--- refresh end (no-op) ---"
    exit 0
  }

  Log "$DataFile changed, committing"

  # 4. Commit just this one file (path-scoped, so any unrelated dirty file
  #    in the tree is left alone).
  & git add -- $DataFile
  & git commit -q -m "Refresh manual metrics" -- $DataFile
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
# Fires 12:35, 16:05 and 19:05 on weekdays -- a few minutes after
# refresh-hvac-sales.ps1's own slots, same offset reasoning as
# refresh-commission-report.ps1 (so this always sees that run's freshest
# data if the two ever needed to agree on something, though today they
# don't share any fields).
#
#   $ps  = "powershell.exe"
#   $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\dev\TeamRegal\scripts\refresh-manual-metrics.ps1"'
#   $act = New-ScheduledTaskAction -Execute $ps -Argument $arg
#   $trg = @(
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 12:35PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:05PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 7:05PM
#   )
#   $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
#   Register-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics" -Action $act -Trigger $trg -Settings $set -Description "Parse the Manual Metrics workbook and push docs/data/manual-metrics.json if it changed."
#
# Check what it's been doing:   Get-Content "$env:LOCALAPPDATA\TeamRegal\refresh-manual-metrics.log" -Tail 40
# Run it now without waiting:    Start-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics"
# Remove it:                     Unregister-ScheduledTask -TaskName "TeamRegal - Refresh Manual Metrics" -Confirm:$false
# ---------------------------------------------------------------------------
