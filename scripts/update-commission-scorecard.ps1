# Computes this calendar month's commission totals for Josh and Nick,
# bucketed into Wed-Tue pay weeks, and writes docs/data/commission-report.json
# for hvac-sales.html to render as a running "Week N: $X ... MTD: $X" section.
#
# Itemized per-sale detail (customer, System Type, rate, payout) is
# included per week, at the user's explicit request, so the commission
# section can show a dropdown that reconciles to the visible total the
# same way the opportunities list already does. Only *resolved* sales are
# itemized here -- one with no clean System Type match isn't part of the
# total shown, so it isn't part of this breakdown either (it still shows
# up in generate-commission-report.ps1's flagged-for-review output, run by
# hand for payroll). hvac-sales.json already ships both consultants' full
# row data (including customer names) client-side on this same page
# (accepted tradeoff, see its own header comment and the README) -- this
# adds a $ figure next to a name already visible there, not a new category
# of exposure.
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

# Confirmed OnCall-Air-side data-entry mistakes, not guesses -- each one
# was verified by hand against the real customer before being added here.
# Keyed/valued by normalized name. Applied only when matching against
# hvac-sales.json; the page still shows the corrected name so it reads the
# same as the Excel sheet everyone already uses. Duplicated in
# generate-commission-report.ps1 -- keep both in sync.
$NAME_ALIASES = @{
  "jr hartman" = "Ronald Hartman"  # OnCall Air has first_name "Jr", last_name "Hartman" on this customer's record; confirmed 2026-09-14 this is Ronald Hartman (hvac-sales.json Job #61525).
}
function ResolveAliasedName($s) {
  $key = NormalizeName $s
  if ($NAME_ALIASES.ContainsKey($key)) { $NAME_ALIASES[$key] } else { $s }
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

  $custName = ResolveAliasedName $p.customer.full_name
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
  $rate = $null
  $publicReason = $null
  if ($ok) {
    $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
    $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
    $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
    $subtotal = $totalInvestment - $commissionMarkup - $financingMarkup - $rebateMarkup
    $rate = $RATE_GROUPS[$systemType][$ca]
    $commission = $subtotal * $rate
  } else {
    # Two versions of the same fact: a precise technical reason for the
    # console log (whoever's chasing this down via
    # generate-commission-report.ps1 wants the exact cause), and a short,
    # non-technical phrase for the public JSON (Josh/Nick just need "this
    # isn't counted yet," not the internal matching mechanics).
    # A same-week miss can still have a real row -- just dated outside this
    # pay week (e.g. consultation Sept 4, accepted sometime the following
    # week -- a real case this caught). Doesn't change the match/inclusion
    # rule at all (still requires a same-week row to count toward the
    # total), only makes the displayed reason honest about which kind of
    # miss this is, rather than implying "no row exists" when one does.
    $anyRowForName = if ($candidates.Count -eq 0) {
      @($hvacSales | Where-Object { (NormalizeName $_.customerName) -eq (NormalizeName $custName) }).Count -gt 0
    } else { $false }

    # Catches a real, distinct failure mode from the date-mismatch one
    # above: OnCall Air's own customer record can just have the wrong
    # name on it (confirmed live -- a real customer's OnCall Air record
    # had first_name "Jr", last_name "Hartman" where the sheet correctly
    # has "Ronald Hartman", someone's data-entry mistake on OnCall Air's
    # side, not ours to auto-fix). Never auto-matched or counted toward
    # the total either way -- bridging a full first-name mismatch
    # algorithmically risks matching the wrong person if two different
    # customers ever share a last name. Only surfaced as a hint when
    # there's exactly one same-last-name row this week, so whoever's
    # reviewing Pending can spot and manually confirm it in seconds
    # instead of being told (misleadingly) that no row exists at all.
    $lastNameHint = $null
    if ($candidates.Count -eq 0 -and -not $anyRowForName) {
      $custLastName = ((NormalizeName $custName) -split ' ' | Select-Object -Last 1)
      if ($custLastName) {
        $lastNameMatches = @($hvacSales | Where-Object {
          $_.date -and ([datetime]$_.date -ge $weekStart) -and ([datetime]$_.date -lt $weekEndExclusive) -and
          (((NormalizeName $_.customerName) -split ' ' | Select-Object -Last 1) -eq $custLastName)
        })
        if ($lastNameMatches.Count -eq 1) { $lastNameHint = $lastNameMatches[0].customerName }
      }
    }

    $reason = if ($candidates.Count -eq 0) { "no hvac-sales.json match" }
              elseif ($candidates.Count -gt 1) { "ambiguous ($($candidates.Count) matches)" }
              elseif (-not $systemType) { "blank System Type" }
              else { "unrecognized System Type '$systemType'" }
    $unresolved += "$custName ($ca, week of $($weekStart.ToString('yyyy-MM-dd'))): $reason$(if ($lastNameHint) { " -- possible match: $lastNameHint" })"
    $publicReason = if ($candidates.Count -eq 0) {
      if ($lastNameHint) { "possibly logged as `"$lastNameHint`" -- OnCall Air may have the wrong name on file" }
      elseif ($anyRowForName) { "logged under a different date" }
      else { "not yet logged in the sheet" }
    } else { "System Type not entered yet" }
  }

  $computed += [pscustomobject]@{
    CA           = $ca
    WeekStart    = $weekStart
    Date         = $acceptedAt.Date
    Revenue      = $totalInvestment
    Commission   = $commission
    Ok           = $ok
    Reason       = $publicReason
    CustomerName = $custName
    SystemType   = $systemType
    Rate         = $rate
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
# The one pay week immediately before this month, so a week that straddles
# the month boundary (its Wednesday in the prior month, its Tuesday in this
# one -- e.g. Aug 26-Sep 1) still shows up on the 1st/2nd of a new month
# instead of disappearing until enough of it falls in "this month" to get
# picked up by the filter below. Deliberately just the one trailing week,
# not open-ended lookback -- $thisMonth (below) is still the strict
# calendar-month set and is what MTD is summed from, so this extra week
# shows on the page without inflating MTD with the prior month's dollars.
$windowStart = WeekStartFor $monthStart.AddDays(-1)

# One-time manual backfill for sales accepted before the OnCall Air webhook
# went live (2026-09-11) -- the private sold-proposals repo has no history
# before that date. Pulled by Michael from OnCall Air's own "Accepted"
# report on 2026-09-11. Revenue (total_investment) is from that report;
# SystemType/Subtotal, when present, are from Josh/Nick's own manual
# commission sheet for these (Michael read them off by hand, 2026-09-14) --
# without both, there's no way to run a sale through the normal commission
# math, so it stays Pending instead (needs a human to enter System Type and
# confirm the rate; use generate-commission-report.ps1 for the exact
# itemized payroll figures either way).
#
# Feeds two different things: $manualRevenueRows (Revenue only, for the
# Last month/MTD/YTD goal tracker further down) and $manualSupplementRows
# (below) which surfaces each one in the Commission section for whichever
# pay week it falls in -- as a real sale (if SystemType/Subtotal are known)
# or as Pending (if not) -- rather than being invisible everywhere except
# the Revenue tab, which reads as if it never happened. A Pending one is
# never counted toward the Commission total, same "flag, don't guess" rule
# as every other unresolved sale.
$MANUAL_REVENUE_BACKFILL = @(
  @{ CA = "Josh"; Date = "2026-09-09"; Revenue = 15863.00; Name = "Ron Lease";         SystemType = "Legacy";   Subtotal = 13352.50 }
  @{ CA = "Josh"; Date = "2026-09-08"; Revenue = 7550.00;  Name = "Steve O'Brien";     SystemType = "Flex";      Subtotal = 6863.25 }
  @{ CA = "Josh"; Date = "2026-09-03"; Revenue = 15424.00; Name = "Ron Goodling";      SystemType = "Legacy";   Subtotal = 14021.28 }
  @{ CA = "Josh"; Date = "2026-09-03"; Revenue = 13679.00; Name = "Rachel Johnson";    SystemType = "Legacy";   Subtotal = 11514.00 }
  @{ CA = "Josh"; Date = "2026-09-02"; Revenue = 12759.00; Name = "Sirina Cohr";       SystemType = "Legacy";   Subtotal = 10908.17 }
  @{ CA = "Josh"; Date = "2026-09-02"; Revenue = 7928.05;  Name = "Robert White";      SystemType = "Preferred"; Subtotal = 7207.10 }
  @{ CA = "Josh"; Date = "2026-09-01"; Revenue = 16707.00; Name = "Kim Strobeck";      SystemType = "Legacy";   Subtotal = 14063.00 }
  @{ CA = "Josh"; Date = "2026-09-01"; Revenue = 12554.00; Name = "Patricia Bingaman"; SystemType = "Legacy";   Subtotal = 11412.08 }
  @{ CA = "Nick"; Date = "2026-09-07"; Revenue = 18308.00; Name = "Margaret Fedor";    SystemType = "Preferred"; Subtotal = 15410.50 }
)
$manualRevenueRows = $MANUAL_REVENUE_BACKFILL | ForEach-Object {
  [pscustomobject]@{ CA = $_.CA; Date = [datetime]$_.Date; Revenue = [decimal]$_.Revenue }
}
$manualSupplementRows = @(
  $MANUAL_REVENUE_BACKFILL | ForEach-Object {
    $d = [datetime]$_.Date
    $ws = WeekStartFor $d
    if ($ws -ge $windowStart -and $ws -lt $monthEndExclusive) {
      if ($_.SystemType -and $_.Subtotal) {
        $rate = $RATE_GROUPS[$_.SystemType][$_.CA]
        [pscustomobject]@{
          CA = $_.CA; WeekStart = $ws; Date = $d; Revenue = [decimal]$_.Revenue
          Commission = [decimal]$_.Subtotal * $rate; Ok = $true
          Reason = $null; CustomerName = $_.Name; SystemType = $_.SystemType; Rate = $rate
        }
      } else {
        [pscustomobject]@{
          CA = $_.CA; WeekStart = $ws; Date = $d; Revenue = [decimal]$_.Revenue
          Commission = 0; Ok = $false
          Reason = "sold before the OnCall Air webhook went live (Sept 11) -- needs manual commission entry"
          CustomerName = $_.Name; SystemType = $null; Rate = $null
        }
      }
    }
  }
)

# $displayRows drives what's shown on the page (this month plus the one
# trailing week); $thisMonth stays the strict calendar-month subset of it,
# used below only for the MTD sum so a trailing prior-month week is visible
# without counting toward this month's total.
$displayRows = @($computed | Where-Object { $_.WeekStart -ge $windowStart -and $_.WeekStart -lt $monthEndExclusive }) + $manualSupplementRows
$thisMonth = @($displayRows | Where-Object { $_.WeekStart -ge $monthStart })
$weekGroups = $displayRows | Group-Object WeekStart | Sort-Object { [datetime]$_.Name }

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

  # Itemized, resolved-only sales per CA -- these are exactly the rows
  # that make up totals above, so they always sum to it exactly (both
  # computed from the same $g.Group, nothing re-derived separately).
  # Sorted most-recent-first, matching the opportunities list's own
  # convention elsewhere on this page.
  $salesByCa = @{ Josh = @(); Nick = @() }
  # Sold-but-unresolved sales, same shape/grouping as salesByCa above --
  # these are the rows NOT counted in totals (Ok = $false), shown on the
  # page so a viewer can see who's still outstanding instead of the total
  # just silently looking smaller than it should.
  $pendingByCa = @{ Josh = @(); Nick = @() }
  foreach ($ca in @("Josh", "Nick")) {
    $salesByCa[$ca] = @(
      $g.Group | Where-Object { $_.CA -eq $ca -and $_.Ok } | Sort-Object Date -Descending | ForEach-Object {
        [ordered]@{
          customerName = $_.CustomerName
          systemType   = $_.SystemType
          rate         = $_.Rate
          commission   = [math]::Round([double]$_.Commission, 2)
        }
      }
    )
    $pendingByCa[$ca] = @(
      $g.Group | Where-Object { $_.CA -eq $ca -and -not $_.Ok } | Sort-Object Date -Descending | ForEach-Object {
        [ordered]@{
          customerName = $_.CustomerName
          reason       = $_.Reason
        }
      }
    )
  }

  $weeks += [ordered]@{
    label     = $label
    weekStart = $ws.ToString("yyyy-MM-dd")
    weekEnd   = $we.ToString("yyyy-MM-dd")
    totals    = [ordered]@{ Josh = [math]::Round($totals.Josh, 2); Nick = [math]::Round($totals.Nick, 2) }
    sales     = [ordered]@{ Josh = $salesByCa.Josh; Nick = $salesByCa.Nick }
    pending   = [ordered]@{ Josh = $pendingByCa.Josh; Nick = $pendingByCa.Nick }
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

# $manualRevenueRows built earlier, alongside $manualPendingRows -- see the
# $MANUAL_REVENUE_BACKFILL comment above.
$allRevenueRows = @($computed) + @($manualRevenueRows)

# One-time YTD baseline for revenue earned before the granular pipeline
# existed at all -- Josh's and Nick's own Jan 1-Aug 31, 2026 totals, read
# off OnCall Air's own YTD report by Michael (2026-09-15). Distinct from
# $MANUAL_REVENUE_BACKFILL above: that's itemized Sept 1-9 sales (customer,
# date, System Type where known); this is one lump number per CA for the
# stretch before that, where no itemized backfill was practical. Cross-
# checked against the granular pipeline before being added: Michael's
# separately-given "YTD including September" figure for Josh ($3,595,667)
# minus his baseline ($3,407,034.52) comes out to $188,632.48 -- matching
# September's own already-verified total ($188,632.41) to the cent (the
# 7-cent gap is rounding in his rough total, not a bug).
#
# Added on top of the granular sum below rather than folded into
# $allRevenueRows as a row, and that sum is deliberately bounded to this
# cutoff (not $yearStart) so a future webhook/backfill entry dated before
# September -- if the private repo's history ever gets extended backward --
# can never double-count against this lump baseline.
$YTD_REVENUE_BASELINE_CUTOFF = [datetime]"2026-09-01"
$YTD_REVENUE_BASELINE = @{ Josh = 3407034.52; Nick = 501779.53 }

# Revenue is bucketed by the actual accepted calendar date, NOT WeekStart --
# unlike commission, a revenue goal is about when a deal closed, not which
# Wed-Tue pay period it lands in. (A sale accepted Tue 9/1 belongs to
# August's pay week for commission purposes, but it's still September
# revenue.)
$lastMonthStart = $monthStart.AddMonths(-1)
$thisMonthRevenue = $allRevenueRows | Where-Object { $_.Date -ge $monthStart -and $_.Date -lt $monthEndExclusive }
$lastMonthSales = $allRevenueRows | Where-Object { $_.Date -ge $lastMonthStart -and $_.Date -lt $monthStart }
$ytdGranularSales = $allRevenueRows | Where-Object { $_.Date -ge $YTD_REVENUE_BASELINE_CUTOFF -and $_.Date -le $today }

$revenue = [ordered]@{
  lastMonth = [ordered]@{ Josh = (SumRevenue $lastMonthSales "Josh");   Nick = (SumRevenue $lastMonthSales "Nick") }
  mtd       = [ordered]@{ Josh = (SumRevenue $thisMonthRevenue "Josh"); Nick = (SumRevenue $thisMonthRevenue "Nick") }
  ytd       = [ordered]@{
    Josh = [math]::Round($YTD_REVENUE_BASELINE.Josh + (SumRevenue $ytdGranularSales "Josh"), 2)
    Nick = [math]::Round($YTD_REVENUE_BASELINE.Nick + (SumRevenue $ytdGranularSales "Nick"), 2)
  }
}

$result = [ordered]@{
  meta    = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); month = $monthStart.ToString("yyyy-MM") }
  weeks   = $weeks
  mtd     = $mtd
  revenue = $revenue
}

$result | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "`nWrote $($weeks.Count) week(s) for $($monthStart.ToString('MMMM yyyy')) to $OutJson"
Write-Host ("Commission MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $mtd.Josh, $mtd.Nick)
Write-Host ("Revenue MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.mtd.Josh, $revenue.mtd.Nick)
Write-Host ("Revenue YTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.ytd.Josh, $revenue.ytd.Nick)
