# Weekly sales commission report for Josh Zieger and Nick Webb.
#
# Commission is a percentage of each sold proposal's real discounted
# subtotal -- NOT proposal.subtotal (that field is misleadingly named; it's
# actually OnCall Air's "Total Investment" figure, with their own Tech Tier
# commission and financing markup already added back on top). The real
# subtotal is reconstructed as total_investment - commission_markup -
# financing_markup - rebate_markup, verified against a real pricing-summary
# screenshot. The percentage depends on system type:
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

  $custName = $p.customer.full_name
  $acceptedAt = [datetime]$p.timestamps.accepted_at
  # NOT proposal.subtotal -- confirmed against a real OnCall Air pricing
  # summary screenshot that the field OnCall Air's webhook literally names
  # "subtotal" is actually their UI's "Total Investment" figure: the real
  # discounted subtotal with Tech Tier commission_markup and
  # financing_markup already added back on top. Backing those back out
  # reconstructs the true (pre-markup) subtotal -- verified to the penny
  # (off by $0.02 from a company-wide "round total investment up to the
  # nearest dollar" office setting, an unavoidable residual of well under
  # $1 that doesn't move a commission total by more than a few cents).
  $totalInvestment = [decimal]$p.proposal.total_investment
  $commissionMarkup = if ($p.proposal.commission_markup) { [decimal]$p.proposal.commission_markup } else { 0 }
  $financingMarkup = if ($p.proposal.financing_markup) { [decimal]$p.proposal.financing_markup } else { 0 }
  $rebateMarkup = if ($p.proposal.rebate_markup) { [decimal]$p.proposal.rebate_markup } else { 0 }
  $subtotal = $totalInvestment - $commissionMarkup - $financingMarkup - $rebateMarkup

  # Match by customer name + same commission week -- not exact date, since
  # the Excel "Date" column and OnCall Air's accepted_at aren't guaranteed
  # to be the same calendar day. @(...) forces a real array even for
  # exactly one match -- a bare Where-Object result's .Count is $null for
  # a single match, not 1 (this only "worked" before because the single-
  # match case was the unconditional else branch, not an explicit -eq 1
  # check -- update-commission-scorecard.ps1 hit that same trap directly).
  $candidates = @($hvacSales | Where-Object {
    (NormalizeName $_.customerName) -eq (NormalizeName $custName) -and
    $_.date -and ([datetime]$_.date -ge $WeekStart) -and ([datetime]$_.date -lt $weekEndExclusive)
  })

  $systemType = $null
  $matchStatus = "ok"
  if (-not $ca) {
    $matchStatus = "unknown CA ($firstName $($p.assigned_consultant.last_name)) -- not Josh or Nick, no rate rules defined"
  } elseif ($candidates.Count -eq 0) {
    $matchStatus = "NO MATCH in hvac-sales.json for '$custName' in this week -- System Type unknown"
  } elseif ($candidates.Count -gt 1) {
    $types = ($candidates | ForEach-Object { "$($_.date):$($_.systemType)" }) -join "; "
    $matchStatus = "AMBIGUOUS -- $($candidates.Count) rows for '$custName' this week ($types) -- pick manually"
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
