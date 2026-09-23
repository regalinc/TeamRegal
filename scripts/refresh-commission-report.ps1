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
$HealthFile = "docs/data/refresh-health.json"
$LogDir   = Join-Path $env:LOCALAPPDATA "TeamRegal"
$LogFile  = Join-Path $LogDir "refresh-commission-report.log"

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Log {
  param([string]$Message)
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -Path $LogFile -Value $line -Encoding utf8
  Write-Host $line
}

# Records that this script successfully pulled and recomputed -- belt and
# suspenders alongside commission-report.json's own meta.generated_at
# (which already updates every run) so hvac-sales.html's staleness banner
# reads from ONE place for all three refresh scripts rather than each
# having its own shape. See refresh-hvac-sales.ps1's copy of this same
# function for the real incident it exists to catch faster next time.
function RecordHealthCheck([string]$Key) {
  $health = if (Test-Path $HealthFile) { Get-Content $HealthFile -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $health | Add-Member -NotePropertyName $Key -NotePropertyValue ((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")) -Force
  ($health | ConvertTo-Json) | Out-File -FilePath $HealthFile -Encoding utf8
}

# Serialize against the other refresh scripts (HVAC Sales, Manual Metrics)
# -- all of them run git pull/commit/push against this same TeamRegal
# checkout, and if two fire close enough together, git's own ref-locking
# makes one fail outright rather than just wait (real incident
# 2026-09-21 through 2026-09-23: this task and Manual Metrics were
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
  #    update-commission-scorecard.ps1 from the local checkout on disk, so a
  #    stale clone silently keeps running old scoring/report logic forever
  #    even after a fix is pushed to main. (Discovered 2026-09-11: a revenue-
  #    tracking change sat on origin/main for 40+ minutes while this machine's
  #    stale checkout kept regenerating commission-report.json without it.)
  Set-Location $RepoRoot
  & git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) {
    Log "git pull in TeamRegal failed ($LASTEXITCODE), aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
  }

  # 2. Pull the latest sold-proposal payloads.
  Set-Location $OncallairRepo
  & git pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) {
    Log "git pull in oncallair-sales-data failed ($LASTEXITCODE), aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
  }

  # 3. Recompute this month's commission totals.
  Set-Location $RepoRoot
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "update-commission-scorecard.ps1")
  if ($LASTEXITCODE -ne 0) {
    Log "update-commission-scorecard.ps1 exited $LASTEXITCODE, aborting this run"
    Log "--- refresh end (error) ---"
    exit 1
  }

  # 3.5. Reaching here means both repos pulled cleanly and the recompute
  #      succeeded -- record that regardless of whether $DataFile itself
  #      changed below.
  Set-Location $RepoRoot
  RecordHealthCheck "commission"

  # 4. Did the committed data file actually change? Either way there's now
  #    something to commit -- at minimum the health check above, which
  #    always differs run to run.
  & git diff --quiet -- $DataFile
  $filesToCommit = @($HealthFile)
  $commitMessage = "Refresh health check"
  if ($LASTEXITCODE -ne 0) {
    $filesToCommit += $DataFile
    $commitMessage = "Refresh commission report"
    Log "$DataFile changed, committing"
  } else {
    Log "no change in $DataFile, recording health check only"
  }

  # 5. Commit just these files (path-scoped, so any unrelated dirty file in
  #    the tree is left alone).
  & git add -- $filesToCommit
  & git commit -q -m $commitMessage -- $filesToCommit
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }

  # 6. Rebase onto whatever the hourly HCP sync bot (or the HVAC Sales
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
finally {
  $repoLock.ReleaseMutex()
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
