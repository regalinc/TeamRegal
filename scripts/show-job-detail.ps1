# Shows everything about one job: full line-item list (unfiltered, unlike
# find-membership-discounts.ps1 which only prints matches) and the
# invoice-level totals. Use this to see a discount/fee line in its full
# billing context -- what else is on the same invoice, and what the
# invoice actually totaled.
#
# Usage:
#   $env:HCP_API_KEY = "your_key"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\show-job-detail.ps1 -JobId job_096852ecec944b8cb0675c4f7d4c3d16

param(
  [string]$JobId = "job_096852ecec944b8cb0675c4f7d4c3d16"
)

$ErrorActionPreference = "Stop"
$ApiBase = "https://api.housecallpro.com"
$ApiKey = $env:HCP_API_KEY
if (-not $ApiKey) { Write-Host 'Set HCP_API_KEY first.' -ForegroundColor Yellow; exit 1 }
$Headers = @{ Accept = "application/json"; Authorization = "Token $ApiKey" }

function Invoke-Hcp {
  param([string]$Path)
  try {
    $resp = Invoke-WebRequest -Uri ($ApiBase + $Path) -Headers $Headers -Method Get -UseBasicParsing
    return ($resp.Content | ConvertFrom-Json)
  } catch {
    Write-Host "  (failed $Path -- $($_.Exception.Message))" -ForegroundColor DarkGray
    return $null
  }
}

$job = Invoke-Hcp "/jobs/$JobId"
if ($job) {
  Write-Host "`n=== Job ==="
  [pscustomobject]@{
    Id             = $job.id
    Description    = $job.description
    WorkStatus     = $job.work_status
    Tags           = ($job.tags -join ", ")
    InvoiceNumber  = $job.invoice_number
    Subtotal       = "`$" + ("{0:N2}" -f ($job.subtotal / 100))
    TotalAmount    = "`$" + ("{0:N2}" -f ($job.total_amount / 100))
    Completed      = $job.work_timestamps.completed_at
  } | Format-List *
}

$li = Invoke-Hcp "/jobs/$JobId/line_items"
if ($li -and $li.data) {
  Write-Host "`n=== ALL line items on this job ($($li.data.Count) total) ==="
  $li.data | ForEach-Object {
    [pscustomobject]@{
      Name        = $_.name
      Description = $_.description
      Kind        = $_.kind
      Qty         = $_.quantity
      UnitCost    = "`$" + ("{0:N2}" -f ($_.unit_cost / 100))
      UnitPrice   = "`$" + ("{0:N2}" -f ($_.unit_price / 100))
      Amount      = "`$" + ("{0:N2}" -f ($_.amount / 100))
      Taxable     = $_.taxable
    }
  } | Format-List *
  $lineTotal = ($li.data | Measure-Object -Property amount -Sum).Sum
  Write-Host ("Sum of all line-item amounts: `${0:N2}" -f ($lineTotal / 100))
}

$inv = Invoke-Hcp "/jobs/$JobId/invoices"
if ($inv -and $inv.invoices) {
  Write-Host "`n=== Invoice(s) on this job ==="
  foreach ($i in $inv.invoices) {
    [pscustomobject]@{
      InvoiceNumber = $i.invoice_number
      Status        = $i.status
      Subtotal      = "`$" + ("{0:N2}" -f ($i.subtotal / 100))
      Amount        = "`$" + ("{0:N2}" -f ($i.amount / 100))
      DueAmount     = "`$" + ("{0:N2}" -f ($i.due_amount / 100))
      InvoiceDate   = $i.invoice_date
      PaidAt        = $i.paid_at
    } | Format-List *
    Write-Host "  -- items on this invoice --"
    $i.items | ForEach-Object {
      [pscustomobject]@{
        Name      = $_.name
        Type      = $_.type
        UnitCost  = "`$" + ("{0:N2}" -f ($_.unit_cost / 100))
        UnitPrice = "`$" + ("{0:N2}" -f ($_.unit_price / 100))
        Amount    = "`$" + ("{0:N2}" -f ($_.amount / 100))
      }
    } | Format-Table -AutoSize
  }
}

Write-Host "`nDone. Paste all three sections back into chat."
