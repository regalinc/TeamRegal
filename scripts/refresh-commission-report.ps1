# Unattended refresh of the commission scorecard section on
# hvac-sales.html.
#
# Pulls the latest sold-proposal webhook payloads from the private
# oncallair-sales-data repo, recomputes this month's Josh/Nick commission
# totals against the (already-synced) hvac-sales.json, and if
# docs/data/commission-report.json actually changed, commits and pushes it
# to TeamRegal. Meant to run on the same Task Scheduler cadence as
# refresh-hvac-sales.ps1 (see that script's own registration snippet) so
# the two stay in step -- System Type data and commission data are both
# fresh, or both a few hours stale, never out of sync with each other.
#
# It is a no-op when:
#   - the private repo has nothing new to pull
#   - the recomputed commission-report.json is byte-for-byte identical to
#     what's committed (this is common -- most runs land between sales)
#
# Requirements: git on PATH with push credentials cached for BOTH
# TeamRegal and oncallair-sales-data, and the oncallair-sales-data repo
# already cloned locally (see OncallairRepo path below).

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$OncallairRepo = "C:\dev\oncallair-sales-data"
$DataFile = "docs/data/commission-report.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-commission-report.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

try {
  Log "--- refresh start ---"

  # 1. Pull the latest sold-proposal payloads.
  Set-Location $OncallairRepo
  & git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) {
    Log "git pull in oncallair-sales-data failed ($LASTEXITCODE), aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
  }

  # 2. Recompute this month's commission totals.
  Set-Location $RepoRoot
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update-commission-scorecard.ps1")
  if ($LASTEXITCODE -ne 0) {
    Log "update-commission-scorecard.ps1 exited $LASTEXITCODE, aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
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
  & git commit -q -m "Refresh commission report" -- $DataFile
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

  # 5. Rebase onto whatever the hourly HCP sync bot (or the HVAC Sales
  #    refresh) pushed in the meantime, then push. --autostash so an
  #    unrelated dirty file doesn't block the rebase. One retry if the
  #    push races another commit.
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

# ---------------------------------------------------------------------------
# One-time setup: register the scheduled task (run once in PowerShell; no
# admin needed for a user task). Same cadence as "TeamRegal - Refresh HVAC
# Sales" on purpose -- fires a few minutes after it so a commission run
# always sees that run's freshest System Type data, not a race with it.
#
#   $ps  = "powershell.exe"
#   $arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\dev\TeamRegal\scripts\refresh-commission-report.ps1"'
#   $act = New-ScheduledTaskAction -Execute $ps -Argument $arg
#   $trg = @(
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 12:35PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 4:05PM
#     New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 7:05PM
#   )
#   $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
#   Register-ScheduledTask -TaskName "TeamRegal - Refresh Commission Report" -Action $act -Trigger $trg -Settings $set -Description "Pull sold-proposal webhooks and push docs/data/commission-report.json if this month's totals changed."
#
# Check what it's been doing:   Get-Content "$env:LOCALAPPDATA\TeamRegal\refresh-commission-report.log" -Tail 40
# Run it now without waiting:    Start-ScheduledTask -TaskName "TeamRegal - Refresh Commission Report"
# Remove it:                     Unregister-ScheduledTask -TaskName "TeamRegal - Refresh Commission Report" -Confirm:$false
# ---------------------------------------------------------------------------
