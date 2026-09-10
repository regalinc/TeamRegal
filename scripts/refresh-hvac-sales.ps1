# Unattended refresh of the HVAC Sales scorecard data.
#
# Runs parse-hvac-sales.ps1 against the OneDrive workbook and, if
# docs/data/hvac-sales.json actually changed, commits and pushes it. Meant
# to be driven by Windows Task Scheduler a few times a day (see the
# Register-ScheduledTask snippet at the bottom of this file), but it's also
# fine to double-click / run by hand any time.
#
# It is a no-op when:
#   - the workbook is open in Excel or unreachable (parser exits 1, nothing
#     is written, the live scorecard keeps its last-good numbers)
#   - the parsed data is byte-for-byte identical to what's committed
#
# So scheduling it often is cheap: most runs do nothing, and the first run
# after Josh/Nick add rows to the sheet is the one that ships.
#
# Requirements on the machine it runs on: Excel installed, the OneDrive
# folder synced locally (not online-only), git on PATH with push
# credentials cached, and the user logged in (Excel COM needs a real
# session, so schedule it "run only when user is logged on").

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataFile = "docs/data/hvac-sales.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-hvac-sales.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

Set-Location $RepoRoot

try {
  Log "--- refresh start ---"

  # 1. Parse the workbook. Non-zero exit = locked/missing/empty source;
  #    parse-hvac-sales.ps1 guarantees it wrote nothing in that case.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "parse-hvac-sales.ps1")
  if ($LASTEXITCODE -ne 0) {
    Log "parser exited $LASTEXITCODE (workbook locked, offline, or empty), nothing to do"
    Log "--- refresh end (skipped) ---"
    exit 0
  }

  # 2. Did the committed file actually change?
  & git diff --quiet -- $DataFile
  if ($LASTEXITCODE -eq 0) {
    Log "no change in $DataFile, nothing to commit"
    Log "--- refresh end (no-op) ---"
    exit 0
  }

  Log "$DataFile changed, committing"

  # 3. Commit just this one file (path-scoped, so any unrelated dirty file
  #    in the tree is left alone).
  & git add -- $DataFile
  & git commit -q -m "Refresh HVAC sales data" -- $DataFile
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

  # 4. Rebase onto whatever the hourly HCP sync bot pushed in the meantime,
  #    then push. One retry if the push races another bot commit.
  foreach ($attempt in 1..2) {
    & git pull --rebase origin main
    if ($LASTEXITCODE -ne 0) {
      & git rebase --abort 2>$null
      throw "git pull --rebase failed ($LASTEXITCODE), resolve by hand"
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

# ---------------------------------------------------------------------------
# One-time setup: register the scheduled task (run once in PowerShell as the
# user who owns the OneDrive folder; no admin needed for a user task).
# Fires 12:30, 16:00 and 19:00 on weekdays, only when that user is logged on.
#
#   $ps  = "powershell.exe"
#   $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\dev\TeamRegal\scripts\refresh-hvac-sales.ps1"'
#   $act = New-ScheduledTaskAction -Execute $ps -Argument $arg
#   $trg = @(
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 12:30PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:00PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 7:00PM
#   )
#   $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
#   Register-ScheduledTask -TaskName "TeamRegal - Refresh HVAC Sales" -Action $act -Trigger $trg -Settings $set -Description "Parse the HVAC Sales workbook and push docs/data/hvac-sales.json if it changed."
#
# Check what it's been doing:   Get-Content "$env:LOCALAPPDATA\TeamRegal\refresh-hvac-sales.log" -Tail 40
# Run it now without waiting:    Start-ScheduledTask -TaskName "TeamRegal - Refresh HVAC Sales"
# Remove it:                     Unregister-ScheduledTask -TaskName "TeamRegal - Refresh HVAC Sales" -Confirm:$false
# ---------------------------------------------------------------------------
