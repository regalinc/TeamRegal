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
# Rate table and the true-subtotal reconstruction (proposal.subtotal minus
# OnCall Air's own commission_markup/financing_markup/rebate_markup) are
# intentionally duplicated from generate-commission-report.ps1 rather than
# shared, to keep these two scripts independent -- keep both in sync if the
# rate table or the subtotal math ever changes.
#
# CORRECTED 2026-09-16: this used to subtract the markups from
# total_investment instead of proposal.subtotal, on the theory that
# "subtotal" was OnCall Air's misleadingly-named Total Investment figure
# with the markups already added back on top. That theory was wrong --
# total_investment and subtotal are two independently-tracked numbers
# (subtotal = sale_price - discounts_total; total_investment = balance_due,
# a different figure that happens to equal subtotal only when
# financing_markup is $0) -- confirmed against Michael's own manually-
# computed commission for 7 real Josh sales, which matched proposal.subtotal
# minus the markups to within a few cents on every one (one exact to the
# penny) and were off by hundreds of dollars using total_investment.
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
  "out house storage" = "Outhouse Storage"  # OnCall Air has this commercial account as "Out House Storage" (two words); the sheet has it as one word, "Outhouse Storage" -- confirmed by Michael 2026-09-17.
}
function ResolveAliasedName($s) {
  $key = NormalizeName $s
  if ($NAME_ALIASES.ContainsKey($key)) { $NAME_ALIASES[$key] } else { $s }
}

# Manual System Type overrides for a webhook-captured sale whose automatic
# same-pay-week match to hvac-sales.json failed -- not a name problem (that's
# $NAME_ALIASES above), a DATE one: the consultation was logged in one pay
# week but accepted in a later one, so the row exists but falls outside the
# $weekStart/$weekEndExclusive window the normal match requires (deliberately
# strict -- see the "same-week miss" comment further down -- broadening it
# to match across weeks automatically risks pairing the wrong sale when two
# customers share a name). Keyed by the sold-proposal payload's own
# proposal.id (stable, unique, never reused) -> confirmed System Type,
# approved by Michael after manual review.
# Judy Bakk (proposal 5780155): hvac-sales.json has her consultation dated
# 9/4 (the week of Sept 2-8), but she wasn't accepted until 9/11 (the week
# of Sept 9-15) -- exactly the cross-week case this table exists for.
# System Type confirmed Legacy off the payload's own equipment line ("Bryant®
# Legacy™ ... Heat Pump Condensing Unit"), approved 2026-09-16.
$MANUAL_SYSTEM_TYPE_OVERRIDES = @{
  "5780155" = "Legacy"  # Judy Bakk
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
  # from Commission only, same as before. Deliberately total_investment, NOT
  # proposal.subtotal, here -- Revenue wants the customer's actual balance
  # due (full price after discounts), while Commission below wants the
  # pre-markup subtotal. The two fields measure different things and are
  # NOT interchangeable -- see the header comment's 2026-09-16 correction.
  $totalInvestment = [decimal]$p.proposal.total_investment

  $custName = ResolveAliasedName $p.customer.full_name
  # Matched by name only -- NOT scoped to this pay week. CORRECTED
  # 2026-09-17: the sheet's "Date" column is when the estimate/consultation
  # was scheduled, a different thing entirely from OnCall Air's
  # accepted_at (the sale date this row's own pay week comes from) -- the
  # two can legitimately be days or weeks apart (confirmed real cases:
  # Judy Bakk, Andrew Krepps, both logged a full pay week or more before
  # they actually signed). Requiring them to land in the same week was
  # catching real, unambiguous matches as if they were missing. The actual
  # risk a date check would guard against -- two different customers
  # sharing the same name -- is still caught below: multiple candidates is
  # still "ambiguous," never guessed at.
  # @(...) forces a real array even when Where-Object matches exactly one
  # row -- otherwise PowerShell hands back a bare object whose .Count is
  # $null, not 1, and a genuinely clean single match gets misclassified.
  $candidates = @($hvacSales | Where-Object { (NormalizeName $_.customerName) -eq (NormalizeName $custName) })

  # A name match with more than one row is usually a genuine repeat
  # customer (confirmed real case 2026-09-23: Geri Bates, an unrelated
  # Boiler sale in May and a Flex sale in September) rather than the
  # ambiguity a date filter was originally meant to guard against. Narrow
  # to whichever candidate(s) fall in THIS sale's own commission week
  # before giving up -- still never guesses: if more than one candidate is
  # left even after narrowing, it's genuinely ambiguous and stays flagged.
  if ($candidates.Count -gt 1) {
    $sameWeek = @($candidates | Where-Object { $_.date -and ([datetime]$_.date -ge $weekStart) -and ([datetime]$_.date -lt $weekEndExclusive) })
    if ($sameWeek.Count -eq 1) { $candidates = $sameWeek }
  }

  $systemType = if ($candidates.Count -eq 1) { $candidates[0].systemType } else { $null }
  $ok = $candidates.Count -eq 1 -and $systemType -and $RATE_GROUPS.ContainsKey($systemType)

  if (-not $ok -and $MANUAL_SYSTEM_TYPE_OVERRIDES.ContainsKey([string]$p.proposal.id)) {
    $systemType = $MANUAL_SYSTEM_TYPE_OVERRIDES[[string]$p.proposal.id]
    $ok = $true
  }

  $commission = 0
  $rate = $null
  $publicReason = $null
  if ($ok) {
    $proposalSubtotal = [decimal]$p.proposal.subtotal
    $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
    $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
    $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
    $subtotal = $proposalSubtotal - $commissionMarkup - $financingMarkup - $rebateMarkup
    $rate = $RATE_GROUPS[$systemType][$ca]
    $commission = $subtotal * $rate
  } else {
    # Two versions of the same fact: a precise technical reason for the
    # console log (whoever's chasing this down via
    # generate-commission-report.ps1 wants the exact cause), and a short,
    # non-technical phrase for the public JSON (Josh/Nick just need "this
    # isn't counted yet," not the internal matching mechanics).
    #
    # Catches a real failure mode distinct from "not logged at all": OnCall
    # Air's own customer record can just have the wrong name on it
    # (confirmed live -- a real customer's OnCall Air record had
    # first_name "Jr", last_name "Hartman" where the sheet correctly has
    # "Ronald Hartman", someone's data-entry mistake on OnCall Air's side,
    # not ours to auto-fix). Never auto-matched or counted toward the
    # total either way -- bridging a full first-name mismatch
    # algorithmically risks matching the wrong person if two different
    # customers ever share a last name. Only surfaced as a hint when
    # there's exactly one same-last-name row anywhere in the sheet (not
    # week-scoped, same reasoning as the name match above), so whoever's
    # reviewing Pending can spot and manually confirm it in seconds
    # instead of being told (misleadingly) that no row exists at all.
    $lastNameHint = $null
    if ($candidates.Count -eq 0) {
      $custLastName = ((NormalizeName $custName) -split ' ' | Select-Object -Last 1)
      if ($custLastName) {
        $lastNameMatches = @($hvacSales | Where-Object {
          ((NormalizeName $_.customerName) -split ' ' | Select-Object -Last 1) -eq $custLastName
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
      else { "not yet logged in the sheet" }
    } else { "System Type not entered yet" }
  }

  # Closing-behavior signals -- purely a function of the webhook's own
  # timestamps, unrelated to the hvac-sales.json match/System Type/rate
  # chain above, so these are captured for EVERY accepted proposal
  # (Ok or not) rather than gated behind $ok like Commission is. A sale
  # stuck in Pending over a name/date-matching issue still really did close
  # same-day or not; excluding it here would just be losing real signal for
  # a reason that has nothing to do with what these two measure.
  # Same-day close: last_presented_at and accepted_at fall on the same
  # local calendar date -- $null (not false) when last_presented_at is
  # missing, so a payload with no presentation timestamp on record doesn't
  # silently count as a "didn't close same-day" data point.
  $sameDayClose = if ($p.timestamps.last_presented_at) {
    ([datetime]$p.timestamps.last_presented_at).Date -eq $acceptedAt.Date
  } else { $null }
  # Days from the real consultation to acceptance. Prefers the Excel
  # sheet's own Date column (whenever exactly one row matches this sale by
  # name) over the webhook's created_at -- confirmed real case 2026-09-23:
  # Mark Lindsay's accepted proposal carried a created_at from October
  # 2024, two years before Michael confirmed Josh actually ran him again,
  # because Housecall Pro reused/revived an old estimate record rather than
  # creating a fresh one. The Excel date is the human-confirmed visit date
  # and doesn't have that failure mode. Falls back to created_at only when
  # there's no single matching row to trust instead; $null (not 0) when
  # neither is available.
  $consultationDate = if ($candidates.Count -eq 1 -and $candidates[0].date) { [datetime]$candidates[0].date }
                       elseif ($p.timestamps.created_at) { [datetime]$p.timestamps.created_at }
                       else { $null }
  $daysToClose = if ($consultationDate) { ($acceptedAt - $consultationDate).TotalDays } else { $null }
  # How much of the deal's own price was given away as discount/rebate --
  # discounts_total + instant_rebates_total only. customer_direct_rebates_total
  # is deliberately excluded at the user's request (2026-09-16): those are
  # utility-company rebates, not something Regal gave up, so including them
  # would make a CA's own discounting look bigger than it really was. $null
  # (not 0) when sale_price is missing/zero, same "don't fabricate a data
  # point" reasoning as SameDayClose/DaysToClose above.
  $salePrice = if ($p.proposal.sale_price) { [decimal]$p.proposal.sale_price } else { $null }
  $discountPct = if ($salePrice -and $salePrice -gt 0) {
    $discountsTotal = if ($p.proposal.discounts_total) { [decimal]$p.proposal.discounts_total } else { 0 }
    $instantRebates = if ($p.proposal.instant_rebates_total) { [decimal]$p.proposal.instant_rebates_total } else { 0 }
    ($discountsTotal + $instantRebates) / $salePrice
  } else { $null }

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
    SameDayClose = $sameDayClose
    DaysToClose  = $daysToClose
    DiscountPct  = $discountPct
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

# Closing-behavior stats -- same $thisMonth scope as Commission MTD above
# (so every figure on the page describes the same set of sales), but
# Ok/Pending doesn't matter here (see the SameDayClose/DaysToClose comment
# where they're captured) and $manualSupplementRows entries (the
# pre-webhook backfill) simply have no SameDayClose/DaysToClose property at
# all, so PowerShell reads them as $null and they're naturally excluded
# below without any extra filtering. sampleSize is included alongside each
# rate/average so the page can show "(5 of 11)" rather than a bare
# percentage that reads as more certain than a small sample actually is.
function ComputeClosingStats($rows, $ca) {
  $caRows = @($rows | Where-Object { $_.CA -eq $ca })
  $withPresented = @($caRows | Where-Object { $null -ne $_.SameDayClose })
  $sameDayCount = @($withPresented | Where-Object { $_.SameDayClose -eq $true }).Count
  $withDays = @($caRows | Where-Object { $null -ne $_.DaysToClose })
  $withDiscount = @($caRows | Where-Object { $null -ne $_.DiscountPct })
  [ordered]@{
    sameDayRate    = if ($withPresented.Count -gt 0) { [math]::Round($sameDayCount / $withPresented.Count, 4) } else { $null }
    sameDayCount   = $sameDayCount
    sameDaySample  = $withPresented.Count
    avgDaysToClose = if ($withDays.Count -gt 0) { [math]::Round(($withDays | Measure-Object -Property DaysToClose -Average).Average, 1) } else { $null }
    daysSample     = $withDays.Count
    avgDiscountPct = if ($withDiscount.Count -gt 0) { [math]::Round(($withDiscount | Measure-Object -Property DiscountPct -Average).Average, 4) } else { $null }
    discountSample = $withDiscount.Count
  }
}
$closingStats = [ordered]@{
  Josh = ComputeClosingStats $thisMonth "Josh"
  Nick = ComputeClosingStats $thisMonth "Nick"
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
  meta         = [ordered]@{ generated_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); month = $monthStart.ToString("yyyy-MM") }
  weeks        = $weeks
  mtd          = $mtd
  revenue      = $revenue
  closingStats = $closingStats
}

$result | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "`nWrote $($weeks.Count) week(s) for $($monthStart.ToString('MMMM yyyy')) to $OutJson"
Write-Host ("Commission MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $mtd.Josh, $mtd.Nick)
Write-Host ("Revenue MTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.mtd.Josh, $revenue.mtd.Nick)
Write-Host ("Revenue YTD -- Josh: `${0:N2}   Nick: `${1:N2}" -f $revenue.ytd.Josh, $revenue.ytd.Nick)
