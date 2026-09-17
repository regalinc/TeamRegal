# Weekly sales commission report for Josh Zieger and Nick Webb.
#
# Commission is a percentage of each sold proposal's real discounted
# subtotal: proposal.subtotal - commission_markup - financing_markup -
# rebate_markup. The percentage depends on system type:
#
# CORRECTED 2026-09-16: this used to subtract the markups from
# total_investment instead of proposal.subtotal, on the theory that
# "subtotal" was misleadingly named -- actually OnCall Air's "Total
# Investment" figure with the markups already added back on top. That
# theory was checked against a real pricing-summary screenshot at the time
# and seemed to hold, but the screenshot happened to be a sale with
# financing_markup = $0, where total_investment and subtotal coincide by
# construction -- not a case that could distinguish the two formulas at
# all. Confirmed wrong against Michael's own manually-computed commission
# for 7 real Josh sales (several with nonzero financing_markup): using
# proposal.subtotal as the base matched his numbers to within a few cents
# on every one (one exact to the penny); using total_investment was off by
# hundreds of dollars on several. total_investment and subtotal are two
# independently-tracked OnCall Air numbers, not one field with markups
# added back on -- subtotal = sale_price - discounts_total;
# total_investment = balance_due, a different figure entirely that only
# equals subtotal when financing_markup happens to be $0.
#
# THIS MEANS ANY COMMISSION ALREADY PAID OUT USING A PRIOR RUN OF THIS
# SCRIPT MAY HAVE BEEN UNDERSTATED FOR ANY SALE WITH NONZERO
# financing_markup -- worth reviewing past payroll runs against this fix.
#
#   System type                          Josh   Nick
#   Flex                                   6%     3%
#   Legacy / Preferred / Boiler / Mini-Split 6%     4%
#   Evolution / NTI / Tankless              8%     5%
#
# (Boiler folds into Legacy/Preferred, Mini-Split folds into Preferred,
# NTI and Tankless both fold into the Evolution/Navien tier -- confirmed
# against every real System Type value seen in hvac-sales.json. "Navien"
# itself never appears as its own value in that sheet.)
#
# Two data sources, matched by customer name + same commission week
# (Wed-Tue) -- there's no shared ID between them:
#   1. Sold-proposal webhooks (docs/data/../oncallair-sales-data repo) --
#      gives the real dollar subtotal, the assigned CA, and the accepted_at
#      timestamp that defines which week a sale belongs to (this is the
#      same "accepted date" the user already reports commissions off of).
#   2. hvac-sales.json (synced from the manually-maintained HVAC Sales
#      Excel workbook) -- the only place System Type is tracked at all.
#
# A webhook record with zero or multiple hvac-sales.json matches in its
# week is flagged for manual review rather than guessed at -- this number
# becomes someone's paycheck, so ambiguity gets surfaced, not resolved
# silently.
#
# Usage:
#   # Default: most recently completed Wed-Tue week as of today
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\generate-commission-report.ps1
#
#   # A specific week (pass the Wednesday it starts on)
#   ...-WeekStart "2026-09-03"

param(
  [datetime]$WeekStart,
  [string]$SoldProposalsDir = "C:\dev\oncallair-sales-data\sold-proposals",
  [string]$HvacSalesJson = "C:\dev\TeamRegal\docs\data\hvac-sales.json",
  [string]$OutCsv = "commission-report-$(Get-Date -Format yyyyMMdd-HHmmss).csv"
)

$ErrorActionPreference = "Stop"

# --- Commission rate table -------------------------------------------------
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

# --- Work out the target week (Wed 00:00:00 -> Tue 23:59:59) ---------------
if (-not $WeekStart) {
  $today = (Get-Date).Date
  $daysSinceTuesday = (([int]$today.DayOfWeek) - [int][DayOfWeek]::Tuesday + 7) % 7
  if ($daysSinceTuesday -eq 0) { $daysSinceTuesday = 7 }  # today IS Tuesday -> that week isn't over yet
  $weekEnd = $today.AddDays(-$daysSinceTuesday)            # most recent completed Tuesday
  $WeekStart = $weekEnd.AddDays(-6)                        # the Wednesday 6 days before it
} else {
  $weekEnd = $WeekStart.AddDays(6)
}
$weekEndExclusive = $weekEnd.AddDays(1)  # < this, so all of Tuesday is included regardless of time-of-day
Write-Host "Commission week: $($WeekStart.ToString('yyyy-MM-dd')) (Wed) through $($weekEnd.ToString('yyyy-MM-dd')) (Tue)`n"

function NormalizeName($s) {
  if (-not $s) { return "" }
  ($s.Trim().ToLower() -replace '\s+', ' ')
}

# Confirmed OnCall-Air-side data-entry mistakes, not guesses -- each one
# was verified by hand against the real customer before being added here.
# Keyed/valued by normalized name. Applied only when matching against
# hvac-sales.json; the report still prints/exports the corrected name so
# it reads the same as the Excel sheet everyone already uses.
$NAME_ALIASES = @{
  "jr hartman" = "Ronald Hartman"  # OnCall Air has first_name "Jr", last_name "Hartman" on this customer's record; confirmed 2026-09-14 this is Ronald Hartman (hvac-sales.json Job #61525).
  "out house storage" = "Outhouse Storage"  # OnCall Air has this commercial account as "Out House Storage" (two words); the sheet has it as one word, "Outhouse Storage" -- confirmed by Michael 2026-09-17.
}
function ResolveAliasedName($s) {
  $key = NormalizeName $s
  if ($NAME_ALIASES.ContainsKey($key)) { $NAME_ALIASES[$key] } else { $s }
}

# --- Load hvac-sales.json (System Type source) ------------------------------
$hvacSales = (Get-Content $HvacSalesJson -Raw | ConvertFrom-Json).records
Write-Host "Loaded $($hvacSales.Count) rows from hvac-sales.json"

# --- Load sold-proposal webhooks, filtered to this week by accepted_at -----
$allPayloads = Get-ChildItem "$SoldProposalsDir\*.json" -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json }

$weekPayloads = $allPayloads | Where-Object {
  $acc = $_.timestamps.accepted_at
  $acc -and ([datetime]$acc -ge $WeekStart) -and ([datetime]$acc -lt $weekEndExclusive)
}
Write-Host "Found $($allPayloads.Count) sold-proposal payload(s) total, $($weekPayloads.Count) in this week.`n"

# --- Build the report --------------------------------------------------------
$rows = @()
foreach ($p in $weekPayloads) {
  $firstName = $p.assigned_consultant.first_name
  $ca = if ($firstName -eq "Josh") { "Josh" } elseif ($firstName -eq "Nick") { "Nick" } else { $null }

  $custName = ResolveAliasedName $p.customer.full_name
  $acceptedAt = [datetime]$p.timestamps.accepted_at
  # See the header comment's 2026-09-16 correction -- proposal.subtotal is
  # the real base, not total_investment.
  $proposalSubtotal = [decimal]$p.proposal.subtotal
  $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
  $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
  $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
  $subtotal = $proposalSubtotal - $commissionMarkup - $financingMarkup - $rebateMarkup

  # Match by customer name only -- NOT scoped to this pay week. CORRECTED
  # 2026-09-17: the Excel "Date" column is when the estimate/consultation
  # was scheduled, a different thing entirely from OnCall Air's
  # accepted_at (the sale date) -- the two can legitimately be days or
  # weeks apart (confirmed real cases: Judy Bakk, Andrew Krepps, both
  # logged a full pay week or more before they actually signed). A
  # same-week requirement here was catching real, unambiguous matches as
  # if they were missing. The actual risk a date check would guard
  # against -- two different customers sharing the same name -- is still
  # caught below: multiple candidates is still "ambiguous," never guessed.
  # @(...) forces a real array even for exactly one match -- a bare
  # Where-Object result's .Count is $null for a single match, not 1 (this
  # only "worked" before because the single-match case was the
  # unconditional else branch, not an explicit -eq 1 check --
  # update-commission-scorecard.ps1 hit that same trap directly).
  $candidates = @($hvacSales | Where-Object { (NormalizeName $_.customerName) -eq (NormalizeName $custName) })

  $systemType = $null
  $matchStatus = "ok"
  if (-not $ca) {
    $matchStatus = "unknown CA ($firstName $($p.assigned_consultant.last_name)) -- not Josh or Nick, no rate rules defined"
  } elseif ($candidates.Count -eq 0) {
    $matchStatus = "NO MATCH in hvac-sales.json for '$custName' -- System Type unknown"
  } elseif ($candidates.Count -gt 1) {
    $types = ($candidates | ForEach-Object { "$($_.date):$($_.systemType)" }) -join "; "
    $matchStatus = "AMBIGUOUS -- $($candidates.Count) rows for '$custName' ($types) -- pick manually"
  } else {
    $systemType = $candidates[0].systemType
    if (-not $systemType) { $matchStatus = "matched row has blank System Type" }
    elseif (-not $RATE_GROUPS.ContainsKey($systemType)) { $matchStatus = "unrecognized System Type '$systemType' -- no rate rule for it" }
  }

  $rate = $null
  $commission = $null
  if ($matchStatus -eq "ok" -and $ca -and $systemType -and $RATE_GROUPS.ContainsKey($systemType)) {
    $rate = $RATE_GROUPS[$systemType][$ca]
    $commission = [math]::Round($subtotal * $rate, 2)
  }

  $rows += [pscustomobject]@{
    CA           = if ($ca) { $ca } else { "$firstName $($p.assigned_consultant.last_name)" }
    Customer     = $custName
    AcceptedAt   = $acceptedAt.ToString("yyyy-MM-dd HH:mm")
    Subtotal     = $subtotal
    SystemType   = $systemType
    Rate         = $rate
    Commission   = $commission
    Status       = $matchStatus
    ConsultationCode = $p.consultation.code
  }
}

$rows = $rows | Sort-Object CA, AcceptedAt
$rows | Export-Csv -Path $OutCsv -NoTypeInformation

Write-Host "=== Commission report: $($WeekStart.ToString('yyyy-MM-dd')) to $($weekEnd.ToString('yyyy-MM-dd')) ==="
$rows | Format-Table CA, Customer, Subtotal, SystemType, Rate, Commission, Status -AutoSize

$flagged = $rows | Where-Object { $_.Status -ne "ok" }
if ($flagged.Count -gt 0) {
  Write-Host "`n$($flagged.Count) row(s) need manual review before totals below can be trusted:" -ForegroundColor Yellow
  $flagged | ForEach-Object { Write-Host "  - $($_.Customer) ($($_.CA)): $($_.Status)" -ForegroundColor Yellow }
}

Write-Host "`n=== Totals by CA (clean rows only) ==="
$rows | Where-Object { $_.Commission -ne $null } | Group-Object CA | ForEach-Object {
  $total = ($_.Group | Measure-Object -Property Commission -Sum).Sum
  "{0,-6} `${1,10:N2}  ({2} sale(s))" -f $_.Name, $total, $_.Count
}

Write-Host "`nWrote $($rows.Count) rows to $OutCsv"
