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

  # Revenue (total_investment) doesn't depend on System Type at all -- only
  # Commission does, since the rate table is keyed by it. So a sale with an
  # unresolved System Type still counts toward Revenue below; it's excluded
  # from Commission only, same as before.
  $totalInvestment = [decimal]$p.proposal.total_investment

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

  $commission = 0
  if ($ok) {
    $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
    $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
    $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
    $subtotal = $totalInvestment - $commissionMarkup - $financingMarkup - $rebateMarkup
    $rate = $RATE_GROUPS[$systemType][$ca]
    $commission = $subtotal * $rate
  } else {
    $reason = if ($candidates.Count -eq 0) { "no hvac-sales.json match" }
              elseif ($candidates.Count -gt 1) { "ambiguous ($($candidates.Count) matches)" }
              elseif (-not $systemType) { "blank System Type" }
              else { "unrecognized System Type '$systemType'" }
    $unresolved += "$custName ($ca, week of $($weekStart.ToString('yyyy-MM-dd'))): $reason"
  }

  $computed += [pscustomobject]@{
    CA         = $ca
    WeekStart  = $weekStart
    Date       = $acceptedAt.Date
    Revenue    = $totalInvestment
    Commission = $commission
  }
}

if ($unresolved.Count -gt 0) {
  Write-Host "`n$($unresolved.Count) sale(s) couldn't be resolved to a System Type -- excluded from the public totals below, still need manual review via generate-commission-report.ps1:" -ForegroundColor Yellow
  $unresolved | ForEach-Object { Write-Host "  - $_" -ForegroundColor Yellow }
}

# --- Bucket into this calendar month's weeks --------------------------------
$today = (Get-Date).Date
# .Date at the end matters: Get-Date -Year/-Month/-Day without -Hour/-Minute/
# -Second keeps the CURRENT time-of-day, so without it $monthStart lands a
# few hours into 9/1 instead of at midnight -- any sale dated exactly on the
# 1st then falls just before $monthStart and silently gets bucketed into the
# prior month instead of this one.
$monthStart = (Get-Date -Year $today.Year -Month $today.Month -Day 1).Date
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

# --- Revenue (full job price after discounts, NOT the commission-eligible
# subtotal) for goal-tracking on the scorecard's own Last month/MTD/YTD tabs.
# This is proposal.total_investment -- OnCall Air's own sale_price minus
# discounts_total -- deliberately WITHOUT subtracting commission_markup/
# financing_markup/rebate_markup the way the commission math above does:
# those markups are real dollars the customer is paying, just not dollars
# a CA earns commission on, so they belong in revenue but not in Commission.
# Reuses the exact same $computed rows (and the same WeekStart-based "a week
# belongs to whichever month its Wednesday falls in" convention the
# commission weeks/MTD above already use, so a revenue figure and its
# corresponding commission figure always describe the identical set of
# sales) rather than a second, differently-defined month boundary. ------
function SumRevenue($rows, $ca) {
  [math]::Round((($rows | Where-Object { $_.CA -eq $ca } | Measure-Object -Property Revenue -Sum).Sum), 2)
}

# One-time manual backfill for sales accepted before the OnCall Air webhook
# went live (2026-09-11) -- the private sold-proposals repo has no history
# before that date. Pulled by Michael from OnCall Air's own "Accepted"
# report on 2026-09-11, revenue (total_investment) only -- System Type
# wasn't visible in that report, so these are excluded from Commission the
# same way an unresolved webhook sale is above (use
# generate-commission-report.ps1 for the exact itemized payroll figures on
# these). Bucketed by actual accepted date below, so each entry naturally
# stops counting once its date ages out of "this month" -- no manual
# cleanup needed once October starts.
$MANUAL_REVENUE_BACKFILL = @(
  @{ CA = "Josh"; Date = "2026-09-09"; Revenue = 15863.00 }  # Ron Lease
  @{ CA = "Josh"; Date = "2026-09-08"; Revenue = 7550.00 }   # Steve O'Brien
  @{ CA = "Josh"; Date = "2026-09-03"; Revenue = 15424.00 }  # Ron Goodling
  @{ CA = "Josh"; Date = "2026-09-03"; Revenue = 13679.00 }  # Rachel Johnson
  @{ CA = "Josh"; Date = "2026-09-02"; Revenue = 12759.00 }  # Sirina Cohr
  @{ CA = "Josh"; Date = "2026-09-02"; Revenue = 7928.05 }   # Robert White
  @{ CA = "Josh"; Date = "2026-09-01"; Revenue = 16707.00 }  # Kim Strobeck
  @{ CA = "Josh"; Date = "2026-09-01"; Revenue = 12554.00 }  # Patricia Bingaman
  @{ CA = "Nick"; Date = "2026-09-07"; Revenue = 18308.00 }  # Margaret Fedor
)
$manualRevenueRows = $MANUAL_REVENUE_BACKFILL | ForEach-Object {
  [pscustomobject]@{ CA = $_.CA; Date = [datetime]$_.Date; Revenue = [decimal]$_.Revenue }
}
$allRevenueRows = @($computed) + @($manualRevenueRows)

# Revenue is bucketed by the actual accepted calendar date, NOT WeekStart --
# unlike commission, a revenue goal is about when a deal closed, not which
# Wed-Tue pay period it lands in. (A sale accepted Tue 9/1 belongs to
# August's pay week for commission purposes, but it's still September
# revenue.)
$lastMonthStart = $monthStart.AddMonths(-1)
$thisMonthRevenue = $allRevenueRows | Where-Object { $_.Date -ge $monthStart -and $_.Date -lt $monthEndExclusive }
$lastMonthSales = $allRevenueRows | Where-Object { $_.Date -ge $lastMonthStart -and $_.Date -lt $monthStart }
$yearStart = (Get-Date -Year $today.Year -Month 1 -Day 1).Date
$ytdSales = $allRevenueRows | Where-Object { $_.Date -ge $yearStart -and $_.Date -le $today }

$revenue = [ordered]@{
  lastMonth = [ordered]@{ Josh = (SumRevenue $lastMonthSales "Josh");   Nick = (SumRevenue $lastMonthSales "Nick") }
  mtd       = [ordered]@{ Josh = (SumRevenue $thisMonthRevenue "Josh"); Nick = (SumRevenue $thisMonthRevenue "Nick") }
  ytd       = [ordered]@{ Josh = (SumRevenue $ytdSales "Josh");         Nick = (SumRevenue $ytdSales "Nick") }
}

$result = [ordered]@{
  meta    = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); month = $monthStart.ToString("yyyy-MM") }
  weeks   = $weeks
  mtd     = $mtd
  revenue = $revenue
}

$result | ConvertTo-Json -Depth 6 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "`nWrote $($weeks.Count) week(s) for $($monthStart.ToString('MMMM yyyy')) to $OutJson"
Write-Host ("Commission MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $mtd.Josh, $mtd.Nick)
Write-Host ("Revenue MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.mtd.Josh, $revenue.mtd.Nick)
Write-Host ("Revenue YTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.ytd.Josh, $revenue.ytd.Nick)
