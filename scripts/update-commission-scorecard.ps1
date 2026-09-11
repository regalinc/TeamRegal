# Computes this calendar month's commission totals for Josh and Nick,
# bucketed into Wed-Tue pay weeks, and writes docs/data/commission-report.json
# for hvac-sales.html to render as a running "Week N: $X ... MTD: $X" section.
#
# Deliberately aggregate-only in what it writes: per-week, per-CA dollar
# totals, nothing itemized. hvac-sales.json already ships both consultants'
# full row data client-side (accepted tradeoff, see its own header comment
# and the README), but that's opportunity/close records, not dollar
# amounts -- this file adds real commission $ to a page served from the
# public TeamRegal repo, so it stays limited to numbers a person would
# already see about their own pay, not a customer-by-customer breakdown.
# The itemized version (customer, subtotal, system type, flagged
# mismatches) lives only in the private weekly CSV from
# generate-commission-report.ps1, run by hand for payroll.
#
# Rate table and the true-subtotal reconstruction (total_investment minus
# OnCall Air's own commission_markup/financing_markup/rebate_markup, NOT
# the misleadingly-named proposal.subtotal field) are intentionally
# duplicated from generate-commission-report.ps1 rather than shared, to
# keep these two scripts independent -- keep both in sync if the rate
# table or the subtotal math ever changes.
#
# A week "belongs" to whichever calendar month its Wednesday start date
# falls in, and MTD is just the sum of that month's weeks -- so the
# displayed weekly figures always add up to the displayed MTD figure
# exactly, even though a Wed-Tue week can technically straddle a month
# boundary.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update-commission-scorecard.ps1

param(
  [string]$SoldProposalsDir = "C:\dev\oncallair-sales-data\sold-proposals",
  [string]$HvacSalesJson = "C:\dev\TeamRegal\docs\data\hvac-sales.json",
  [string]$OutJson = "C:\dev\TeamRegal\docs\data\commission-report.json"
)

$ErrorActionPreference = "Stop"

$RATE_GROUPS = @{
  "Flex"       = @{ Josh = 0.06; Nick = 0.03 }
  "Legacy"     = @{ Josh = 0.06; Nick = 0.04 }
  "Preferred"  = @{ Josh = 0.06; Nick = 0.04 }
  "Boiler"     = @{ Josh = 0.06; Nick = 0.04 }
  "Mini-Split" = @{ Josh = 0.06; Nick = 0.04 }
  "Evolution"  = @{ Josh = 0.08; Nick = 0.05 }
  "NTI"        = @{ Josh = 0.08; Nick = 0.05 }
  "Tankless"   = @{ Josh = 0.08; Nick = 0.05 }
}

function NormalizeName($s) {
  if (-not $s) { return "" }
  ($s.Trim().ToLower() -replace '\s+', ' ')
}

# Wednesday-of-the-week a given date falls in (the pay week's start).
function WeekStartFor([datetime]$date) {
  $daysSinceWednesday = (([int]$date.DayOfWeek) - [int][DayOfWeek]::Wednesday + 7) % 7
  return $date.Date.AddDays(-$daysSinceWednesday)
}

$hvacSales = (Get-Content $HvacSalesJson -Raw | ConvertFrom-Json).records
$allPayloads = Get-ChildItem "$SoldProposalsDir\*.json" -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json }

Write-Host "Loaded $($hvacSales.Count) hvac-sales.json rows, $($allPayloads.Count) sold-proposal payload(s)."

$unresolved = @()
$computed = @()

foreach ($p in $allPayloads) {
  if (-not $p.timestamps.accepted_at) { continue }
  $acceptedAt = [datetime]$p.timestamps.accepted_at
  $weekStart = WeekStartFor $acceptedAt
  $weekEndExclusive = $weekStart.AddDays(7)

  $firstName = $p.assigned_consultant.first_name
  $ca = if ($firstName -eq "Josh") { "Josh" } elseif ($firstName -eq "Nick") { "Nick" } else { $null }
  if (-not $ca) { continue }  # not one of the two this scorecard tracks

  $custName = $p.customer.full_name
  # @(...) forces a real array even when Where-Object matches exactly one
  # row -- otherwise PowerShell hands back a bare object whose .Count is
  # $null, not 1, and a genuinely clean single match gets misclassified.
  $candidates = @($hvacSales | Where-Object {
    (NormalizeName $_.customerName) -eq (NormalizeName $custName) -and
    $_.date -and ([datetime]$_.date -ge $weekStart) -and ([datetime]$_.date -lt $weekEndExclusive)
  })

  $systemType = if ($candidates.Count -eq 1) { $candidates[0].systemType } else { $null }
  $ok = $candidates.Count -eq 1 -and $systemType -and $RATE_GROUPS.ContainsKey($systemType)

  if (-not $ok) {
    $reason = if ($candidates.Count -eq 0) { "no hvac-sales.json match" }
              elseif ($candidates.Count -gt 1) { "ambiguous ($($candidates.Count) matches)" }
              elseif (-not $systemType) { "blank System Type" }
              else { "unrecognized System Type '$systemType'" }
    $unresolved += "$custName ($ca, week of $($weekStart.ToString('yyyy-MM-dd'))): $reason"
    continue
  }

  $totalInvestment = [decimal]$p.proposal.total_investment
  $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
  $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
  $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
  $subtotal = $totalInvestment - $commissionMarkup - $financingMarkup - $rebateMarkup

  $rate = $RATE_GROUPS[$systemType][$ca]
  $computed += [pscustomobject]@{
    CA         = $ca
    WeekStart  = $weekStart
    Commission = $subtotal * $rate
  }
}

if ($unresolved.Count -gt 0) {
  Write-Host "`n$($unresolved.Count) sale(s) couldn't be resolved to a System Type -- excluded from the public totals below, still need manual review via generate-commission-report.ps1:" -ForegroundColor Yellow
  $unresolved | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

# --- Bucket into this calendar month's weeks --------------------------------
$today = (Get-Date).Date
$monthStart = Get-Date -Year $today.Year -Month $today.Month -Day 1
$monthEndExclusive = $monthStart.AddMonths(1)

$thisMonth = $computed | Where-Object { $_.WeekStart -ge $monthStart -and $_.WeekStart -lt $monthEndExclusive }
$weekGroups = $thisMonth | Group-Object WeekStart | Sort-Object { [datetime]$_.Name }

$weeks = @()
$weekNum = 0
foreach ($g in $weekGroups) {
  $ws = [datetime]$g.Name
  $we = $ws.AddDays(6)
  # The week containing today reads "Current Week" instead of a sequential
  # number -- it's always the last one chronologically (a sale can't land
  # in a future week), so numbering only advances for the completed weeks
  # before it.
  $isCurrent = $today -ge $ws -and $today -lt $ws.AddDays(7)
  $label = if ($isCurrent) { "Current Week" } else { $weekNum++; "Week $weekNum" }
  $totals = @{ Josh = 0.0; Nick = 0.0 }
  foreach ($row in $g.Group) { $totals[$row.CA] += [double]$row.Commission }
  $weeks += [ordered]@{
    label     = $label
    weekStart = $ws.ToString("yyyy-MM-dd")
    weekEnd   = $we.ToString("yyyy-MM-dd")
    totals    = [ordered]@{ Josh = [math]::Round($totals.Josh, 2); Nick = [math]::Round($totals.Nick, 2) }
  }
}

$mtd = [ordered]@{
  Josh = [math]::Round((($thisMonth | Where-Object { $_.CA -eq "Josh" } | Measure-Object -Property Commission -Sum).Sum), 2)
  Nick = [math]::Round((($thisMonth | Where-Object { $_.CA -eq "Nick" } | Measure-Object -Property Commission -Sum).Sum), 2)
}

$result = [ordered]@{
  meta  = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); month = $monthStart.ToString("yyyy-MM") }
  weeks = $weeks
  mtd   = $mtd
}

$result | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "`nWrote $($weeks.Count) week(s) for $($monthStart.ToString('MMMM yyyy')) to $OutJson"
Write-Host ("MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $mtd.Josh, $mtd.Nick)
