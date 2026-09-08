# Parses the hand-maintained "HVAC Sales" workbook (one tab per calendar
# month, each row a single sales consultation) into docs/data/hvac-sales.json.
# Not part of the automated hourly sync — this workbook lives on the user's
# OneDrive, not a cloud API GitHub Actions can reach, so (like
# parse-pnl.ps1) this is run by hand whenever the sheet has new rows worth
# picking up, and its output is committed like any other data file.
#
# Usage:
#   powershell -File scripts/parse-hvac-sales.ps1 -Path "C:\path\to\HVAC Sales.2026.xlsx"
#
# Requires Windows + Excel (COM automation — see parse-pnl.ps1's header
# comment for why this repo has no Node/Python xlsx tooling instead).
#
# Only columns A-I are read (CA, Date, Customer Name, Job, System Type, Club
# Member, Lead, Customer Type, Sold) — everything from column J on (Job
# Complete, the warranty/bonus filing columns, Financing, Cooler Bag) is
# deliberately skipped per the user's explicit request when this scorecard
# was scoped; add columns here if that scope ever grows.
#
# Every month tab shares one 17-column header (verified against all 12
# before this was written) with a blank row 2 as a spacer — real data starts
# at row 3. A row with no CA is treated as a trailing blank row and skipped,
# which is also how a not-yet-arrived future month (an empty tab) naturally
# produces zero records for it without any special-casing.
param(
  [string]$Path = "C:\Users\MichaelLohssJr\OneDrive - Regal, Inc,\Regal, Inc\HVAC Sales\2026\HVAC Sales.2026.xlsx",
  [string]$OutJson = "docs\data\hvac-sales.json"
)

$MONTH_TABS = @("January ", "February ", "March ", "April", "May", "June", "July", "August", "September", "October", "November", "December")

# Same PID-tracking pattern as parse-pnl.ps1 — only force-kills the EXCEL.EXE
# process this run itself spawns, never a window the user already had open.
$excelPidsBefore = @(Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false

Start-Sleep -Milliseconds 300
$spawnedPid = Get-Process EXCEL -ErrorAction SilentlyContinue |
  Where-Object { $excelPidsBefore -notcontains $_.Id } |
  Select-Object -First 1 -ExpandProperty Id

$wb = $excel.Workbooks.Open($Path, [Type]::Missing, $true)
Write-Host "Opened workbook: $($wb.Name)"

$records = @()
foreach ($monthName in $MONTH_TABS) {
  $ws = $wb.Worksheets.Item($monthName)
  $used = $ws.UsedRange
  $rows = $used.Rows.Count

  $monthCount = 0
  for ($r = 3; $r -le $rows; $r++) {
    $ca = $used.Cells.Item($r, 1).Text.Trim()
    if ($ca -eq "") { continue }

    # .Value2 is Excel's OLE Automation date (a double) for a real date
    # cell — reading the raw value instead of .Text sidesteps any ambiguity
    # in how a "1/2/26"-style display string should be parsed (US vs. other
    # date order, 2-digit year).
    $dateVal = $used.Cells.Item($r, 2).Value2
    $dateIso = $null
    if ($dateVal -is [double]) {
      $dateIso = [DateTime]::FromOADate($dateVal).ToString("yyyy-MM-dd")
    }

    $soldText = $used.Cells.Item($r, 9).Text.Trim()

    $records += [ordered]@{
      ca           = $ca
      date         = $dateIso
      customerName = $used.Cells.Item($r, 3).Text.Trim()
      job          = $used.Cells.Item($r, 4).Text.Trim()
      systemType   = $used.Cells.Item($r, 5).Text.Trim()
      clubMember   = $used.Cells.Item($r, 6).Text.Trim()
      lead         = $used.Cells.Item($r, 7).Text.Trim()
      customerType = $used.Cells.Item($r, 8).Text.Trim()
      sold         = ($soldText -eq "Yes")
    }
    $monthCount++
  }
  Write-Host "$($monthName.Trim()): $monthCount records"
}

$wb.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

if ($spawnedPid) {
  Start-Sleep -Milliseconds 500
  if (Get-Process -Id $spawnedPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $spawnedPid -Force -ErrorAction SilentlyContinue
  }
}

$meta = [ordered]@{
  generated_at  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  record_count  = $records.Count
}
$result = [ordered]@{ meta = $meta; records = $records }

# Full regenerate every run (not an incremental merge like the P&L parser's
# manual paste-under-this-month's-key pattern) — re-reading all 12 tabs
# fresh each time is simple and can't drift, since the source workbook is
# the only truth here and there's nothing to preserve across runs.
$result | ConvertTo-Json -Depth 5 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "Wrote $($records.Count) records to $OutJson"
