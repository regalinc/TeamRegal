# Flags likely-duplicate rows in the HVAC Sales workbook (docs/data/hvac-sales.json)
# for a human to review and delete/merge by hand in Excel -- this script never
# writes anything, it only prints.
#
# Built 2026-09-17 after finding three real duplicates by hand while auditing
# Josh's and Nick's scorecards: the same consultation ends up on two separate
# rows instead of one row being updated. The common pattern behind all three:
#
#   - Timothy Hare: identical Job # (53223) typed on two rows, three weeks
#     apart -- a straight copy/paste duplicate.
#   - Scott Kerr / Glenn Nelson: a consultation gets logged the day it
#     happens (often "not sold yet", System Type/Job blank), and when the
#     customer decides later, a NEW row gets added for the outcome instead
#     of updating the original row -- leaving the original as an orphaned
#     "not sold" leftover that never gets deleted.
#
# Detection is intentionally a heuristic, not an exact rule -- there's no
# single field that reliably marks a duplicate (Job # doesn't, since two of
# the three real cases had different Job #s on each row). Anything with the
# same CA + same Customer Name within $WithinDays of each other is flagged
# for a human to look at, same "never silently resolve, always surface"
# convention as the rest of this app. A real repeat customer (a commercial
# account visited several times a year, e.g. Crispus Attucks) will also get
# flagged -- that's an expected, cheap false positive; confirm before
# touching the sheet, same as generate-commission-report.ps1's "ambiguous"
# rows.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\find-duplicate-sales.ps1
#   ...-WithinDays 45          # widen/narrow the date-proximity window
#   ...-HvacSalesJson "path"   # point at a different hvac-sales.json

param(
  [string]$HvacSalesJson = "C:\dev\TeamRegal\docs\data\hvac-sales.json",
  [int]$WithinDays = 30
)

$ErrorActionPreference = "Stop"

function NormalizeName($s) {
  if (-not $s) { return "" }
  ($s.Trim().ToLower() -replace '\s+', ' ')
}

$records = (Get-Content $HvacSalesJson -Raw | ConvertFrom-Json).records
Write-Host "Loaded $($records.Count) rows from $HvacSalesJson`n"

$groups = $records | Where-Object { $_.customerName } | Group-Object { "$($_.ca)|$(NormalizeName $_.customerName)" }

$flagged = @()
foreach ($g in $groups) {
  if ($g.Group.Count -lt 2) { continue }
  $rows = @($g.Group | Where-Object { $_.date } | Sort-Object { [datetime]$_.date })
  $undated = @($g.Group | Where-Object { -not $_.date })

  # Pair up rows that are close in time (or share a Job #) -- an "Unknown"
  # commercial account with real visits 6 months apart shouldn't be flagged
  # just because it recurs.
  for ($i = 0; $i -lt $rows.Count; $i++) {
    for ($j = $i + 1; $j -lt $rows.Count; $j++) {
      $days = ([datetime]$rows[$j].date - [datetime]$rows[$i].date).Days
      $sameJob = $rows[$i].job -and $rows[$j].job -and ($rows[$i].job -eq $rows[$j].job)
      if ($days -le $WithinDays -or $sameJob) {
        $flagged += , @($rows[$i], $rows[$j])
      }
    }
  }
  # A row with no date at all (seen in one real case) can't be date-compared
  # -- flag it against every dated row for the same person instead.
  foreach ($u in $undated) {
    foreach ($r in $rows) { $flagged += , @($u, $r) }
  }
}

if ($flagged.Count -eq 0) {
  Write-Host "No likely duplicates found."
  exit 0
}

Write-Host "$($flagged.Count) possible duplicate pair(s) -- confirm in Excel before deleting/merging anything:`n"
foreach ($pair in $flagged) {
  $a, $b = $pair
  Write-Host "  $($a.ca) / $($a.customerName)"
  Write-Host ("    {0}  job={1,-8} sold={2,-5} type={3,-10} lead={4,-10} club={5,-5} custType={6}" -f $a.date, $a.job, $a.sold, $a.systemType, $a.lead, $a.clubMember, $a.customerType)
  Write-Host ("    {0}  job={1,-8} sold={2,-5} type={3,-10} lead={4,-10} club={5,-5} custType={6}" -f $b.date, $b.job, $b.sold, $b.systemType, $b.lead, $b.clubMember, $b.customerType)
  Write-Host ""
}
