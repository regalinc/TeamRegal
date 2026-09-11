# Follow-up to probe-membership.ps1: scans every job for one customer and
# prints any line item that looks like a membership discount (name/desc
# contains the search term) OR has an implicit discount (unit_price below
# unit_cost -- e.g. a waived service-call fee).
#
# Usage:
#   $env:HCP_API_KEY = "your_key"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\find-membership-discounts.ps1 -CustomerId cus_e39e0fbc35bb440992cbd94919ca6eea

param(
  [Parameter(Mandatory = $true)]
  [string]$CustomerId,
  [string]$Term = "discount"
)

$ErrorActionPreference = "Stop"
$ApiBase = "https://api.housecallpro.com"
$ApiKey = $env:HCP_API_KEY
if (-not $ApiKey) { Write-Host 'Set HCP_API_KEY first.' -ForegroundColor Yellow; exit 1 }
$Headers = @{ Accept = "application/json"; Authorization = "Token $ApiKey" }

function Invoke-Hcp {
  param([string]$Path, [hashtable]$Query)
  $uri = $ApiBase + $Path
  if ($Query -and $Query.Count -gt 0) {
    $pairs = $Query.GetEnumerator() | ForEach-Object { "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString([string]$_.Value))" }
    $uri += "?" + ($pairs -join "&")
  }
  try {
    $resp = Invoke-WebRequest -Uri $uri -Headers $Headers -Method Get -UseBasicParsing
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    Write-Host "  (skipping $Path -- $($_.Exception.Message))" -ForegroundColor DarkGray
    return $null
  }
}

# Pull every job for this customer (paginated).
$allJobs = @()
$page = 1
do {
  $body = Invoke-Hcp -Path "/jobs" -Query @{ customer_id = $CustomerId; page = $page; page_size = 100 }
  if (-not $body) { break }
  $allJobs += $body.jobs
  $totalPages = $body.total_pages
  $page++
} while ($page -le $totalPages -and $page -le 20)

Write-Host "Found $($allJobs.Count) jobs for $CustomerId. Checking line items on each..."

# Recurrence fields come back on the job-list response we already have --
# no extra API calls. A "Billing - ..." job with a populated recurrence_id
# / recurrence_rule would be HCP's own auto-generated membership billing
# job, and could be the closest thing to a real signup-date/cadence signal
# since there's no dedicated membership object in this API.
Write-Host "`n=== Every job for this customer (id/invoice # included so a Housecall Pro invoice # can be traced back to a job id) ==="
$allJobs | Sort-Object { $_.created_at } | ForEach-Object {
  [pscustomobject]@{
    JobId             = $_.id
    JobDesc           = $_.description
    InvoiceNumber     = $_.invoice_number
    WorkStatus        = $_.work_status
    Completed         = $_.work_timestamps.completed_at
    RecurrenceId      = $_.recurrence_id
    RecurrenceNumber  = $_.recurrence_number
    RecurrenceRule    = $_.recurrence_rule
    RecurrenceStatus  = $_.recurrence_status
  }
} | Format-List *

$discountMatches = @()
$implicitDiscounts = @()

foreach ($job in $allJobs) {
  $jobDate = if ($job.work_timestamps.completed_at) { $job.work_timestamps.completed_at } else { $job.schedule.scheduled_start }
  $li = Invoke-Hcp -Path "/jobs/$($job.id)/line_items"
  if (-not $li -or -not $li.data) { continue }

  foreach ($item in $li.data) {
    $hay = "$($item.name) $($item.description)"
    if ($hay -match [regex]::Escape($Term)) {
      $discountMatches += [pscustomobject]@{
        JobId       = $job.id
        JobDesc     = $job.description
        Date        = $jobDate
        LineName    = $item.name
        UnitCost    = $item.unit_cost
        UnitPrice   = $item.unit_price
        Amount      = $item.amount
        Qty         = $item.quantity
      }
    }
    elseif ($item.unit_cost -and $item.unit_price -lt $item.unit_cost) {
      $implicitDiscounts += [pscustomobject]@{
        JobId       = $job.id
        JobDesc     = $job.description
        Date        = $jobDate
        LineName    = $item.name
        UnitCost    = $item.unit_cost
        UnitPrice   = $item.unit_price
        Amount      = $item.amount
        ImpliedSavingsCents = $item.unit_cost - $item.amount
      }
    }
  }
}

Write-Host "`n=== Line items matching '$Term' by name/description ==="
if ($discountMatches.Count -eq 0) {
  Write-Host "  none found across $($allJobs.Count) jobs"
} else {
  $discountMatches | Format-List *
}

Write-Host "`n=== Line items with unit_price below unit_cost (implicit discount / waived amount) ==="
if ($implicitDiscounts.Count -eq 0) {
  Write-Host "  none found"
} else {
  $implicitDiscounts | Format-List *
  $total = ($implicitDiscounts | Measure-Object -Property ImpliedSavingsCents -Sum).Sum
  Write-Host ("`nTotal implied savings across these lines: `${0:N2}" -f ($total / 100))
}

Write-Host "`nDone. Paste both tables back into chat."
