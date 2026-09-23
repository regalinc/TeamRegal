# Unattended refresh of the HVAC Sales scorecard data.
#
# Runs parse-hvac-sales.ps1 against the OneDrive workbook and, if
# docs/data/hvac-sales.json actually changed, commits and pushes it. Meant
# to be driven by Windows Task Scheduler a few times a day (see the
# Register-ScheduledTask snippet at the bottom of this file), but it's also
# fine to double-click / run by hand any time.
#
# It is a true no-op (writes nothing at all) only when the workbook is open
# in Excel or unreachable -- parser exits 1, nothing is written, the live
# scorecard keeps its last-good numbers. Otherwise every successful run
# commits and pushes SOMETHING: docs/data/hvac-sales.json when the parsed
# data actually changed (the first run after Josh/Nick add rows is the one
# that ships), and always docs/data/refresh-health.json, a tiny timestamp
# file the scorecard reads to show whether this pipeline is still alive --
# added after a real incident (2026-09-21 through 2026-09-23) where a
# different refresh script failed silently for two days before anyone
# noticed.
#
# Requirements on the machine it runs on: Excel installed, the OneDrive
# folder synced locally (not online-only), git on PATH with push
# credentials cached, and the user logged in (Excel COM needs a real
# session, so schedule it "run only when user is logged on").

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataFile = "docs/data/hvac-sales.json"
$HealthFile = "docs/data/refresh-health.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-hvac-sales.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

# Records that this script successfully reached and parsed its source, for
# hvac-sales.html's own staleness banner -- separate from $DataFile itself
# because that file's commit-on-diff logic deliberately has no per-run
# timestamp (see parse-hvac-sales.ps1's header comment: a timestamp there
# would make every run look like a change). Real incident this exists to
# catch faster next time: 2026-09-21 through 2026-09-23, a *different*
# script (Commission Report) failed silently for two days because nothing
# was watching its log -- this file lets the page itself notice instead of
# relying on Michael happening to check.
function RecordHealthCheck([string]$Key) {
  $health = if (Test-Path $HealthFile) { Get-Content $HealthFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $health | Add-Member -NotePropertyName $Key -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")) -Force
  ($health | ConvertTo-Json) | Out-File -FilePath $HealthFile -Encoding utf8
}

Set-Location $RepoRoot

# Serialize against the other refresh scripts (Commission Report, Manual
# Metrics) -- all of them run git pull/commit/push against this same
# TeamRegal checkout, and if two fire close enough together, git's own
# ref-locking makes one fail outright rather than just wait (real incident
# 2026-09-21 through 2026-09-23: Commission Report and Manual Metrics were
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

  # 1. Parse the workbook. Non-zero exit = locked/missing/empty source;
  #    parse-hvac-sales.ps1 guarantees it wrote nothing in that case.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "parse-hvac-sales.ps1")
  if ($LASTEXITCODE -ne 0) {
    Log "parser exited $LASTEXITCODE (workbook locked, offline, or empty), nothing to do"
    Log "--- refresh end (skipped) ---"
    exit 0
  }

  # 1.5. Heads-up only, never blocking -- a consultation that's logged once
  #      "not sold" and then re-logged as a new row once it closes (instead
  #      of the original row being updated) is the single most common way
  #      this sheet grows accidental duplicate rows (three real ones found
  #      2026-09-17: Timothy Hare, Scott Kerr, Glenn Nelson). Just the count
  #      goes in this log -- full detail is find-duplicate-sales.ps1's job,
  #      run by hand, since sorting real repeat customers from actual
  #      duplicates needs a person looking at it.
  $dupOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "find-duplicate-sales.ps1")
  $dupCount = ($dupOutput | Select-String -Pattern "^\d+ possible duplicate pair" | ForEach-Object { ($_ -split " ")[0] })
  if ($dupCount) {
    Log "$dupCount possible duplicate row pair(s) in the sheet -- run scripts\find-duplicate-sales.ps1 to review"
  }

  # 1.6. Reaching here means the workbook was readable and parsed cleanly --
  #      record that regardless of whether $DataFile itself changed below.
  RecordHealthCheck "hvacSales"

  # 2. Did the committed data file actually change? Either way there's now
  #    something to commit -- at minimum the health check above, which
  #    always differs run to run.
  & git diff --quiet -- $DataFile
  $filesToCommit = @($HealthFile)
  $commitMessage = "Refresh health check"
  if ($LASTEXITCODE -ne 0) {
    $filesToCommit += $DataFile
    $commitMessage = "Refresh HVAC sales data"
    Log "$DataFile changed, committing"
  } else {
    Log "no change in $DataFile, recording health check only"
  }

  # 3. Commit just these files (path-scoped, so any unrelated dirty file in
  #    the tree is left alone).
  & git add -- $filesToCommit
  & git commit -q -m $commitMessage -- $filesToCommit
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

  # 4. Rebase onto whatever the hourly HCP sync bot pushed in the meantime,
  #    then push. --autostash so an unrelated dirty file in the tree (an
  #    in-progress edit elsewhere) doesn't block the rebase. One retry if
  #    the push races another bot commit.
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
