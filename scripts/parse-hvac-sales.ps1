# Parses the hand-maintained "HVAC Sales" workbook (one tab per calendar
# month, each row a single sales consultation) into docs/data/hvac-sales.json.
# Not part of the automated hourly sync -- this workbook lives on the user's
# OneDrive, not a cloud API GitHub Actions can reach, so (like parse-pnl.ps1)
# this is run either by hand or by the scheduled refresh-hvac-sales.ps1
# wrapper (Windows Task Scheduler), and its output is committed like any
# other data file.
#
# Usage:
#   powershell -File scripts/parse-hvac-sales.ps1 -Path "C:\path\to\HVAC Sales.2026.xlsx"
#
# Requires Windows + Excel (COM automation -- see parse-pnl.ps1's header
# comment for why this repo has no Node/Python xlsx tooling instead).
#
# Only columns A-I are read (CA, Date, Customer Name, Job, System Type, Club
# Member, Lead, Customer Type, Sold) -- everything from column J on (Job
# Complete, the warranty/bonus filing columns, Financing, Cooler Bag) is
# deliberately skipped per the user's explicit request when this scorecard
# was scoped; add columns here if that scope ever grows.
#
# Every month tab shares one 17-column header (verified against all 12
# before this was written) with a blank row 2 as a spacer -- real data starts
# at row 3. A row with no CA is treated as a trailing blank row and skipped,
# which is also how a not-yet-arrived future month (an empty tab) naturally
# produces zero records for it without any special-casing.
#
# The workbook lives under OneDrive and is usually a Files-On-Demand
# placeholder (a reparse point, not real local bytes). Headless Excel
# (Visible = $false) refuses to open those directly -- "Microsoft Excel
# cannot access the file" -- even when the bytes are actually cached. So we
# copy it to a plain local temp file first (which also forces OneDrive to
# hydrate it) and open that copy read-only; the temp copy is deleted on the
# way out, success or failure.
#
# FAILURE HANDLING: the output file is only overwritten on a clean, non-empty
# parse. If the workbook can't be copied or opened (source path missing, or
# it's genuinely open with an exclusive lock in Excel), or if zero rows come
# back across all 12 tabs, the script writes nothing and exits 1 -- a locked
# or missing source can never blank the live scorecard.
param(
  [string]$Path = "C:\Users\MichaelLohssJr\OneDrive - Regal, Inc,\Regal, Inc\HVAC Sales\2026\HVAC Sales.2026.xlsx",
  [string]$OutJson = "docs\data\hvac-sales.json"
)

$ErrorActionPreference = "Stop"

$MONTH_TABS = @("January ", "February ", "March ", "April", "May", "June", "July", "August", "September", "October", "November", "December")

# Same PID-tracking pattern as parse-pnl.ps1 -- only force-kills the EXCEL.EXE
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

# Local temp copy of the workbook (see header comment) -- set once we make
# it, cleared once we delete it, so Close-Excel can tidy up on any path.
$tempCopy = $null

# Tear down the Excel COM instance (and only the PID this run spawned), and
# delete the temp copy if one was made.
function Close-Excel {
  param([object]$Workbook)
  if ($Workbook) { try { $Workbook.Close($false) } catch {} }
  try { $excel.Quit() } catch {}
  try { [System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  if ($spawnedPid) {
    Start-Sleep -Milliseconds 500
    if (Get-Process -Id $spawnedPid -ErrorAction SilentlyContinue) {
      Stop-Process -Id $spawnedPid -Force -ErrorAction SilentlyContinue
    }
  }
  if ($script:tempCopy -and (Test-Path -LiteralPath $script:tempCopy)) {
    Remove-Item -LiteralPath $script:tempCopy -Force -ErrorAction SilentlyContinue
  }
}

$wb = $null
$records = @()
try {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Source workbook not found at '$Path'."
  }

  # Copy to a plain local file first -- forces OneDrive to hydrate the
  # placeholder and gives Excel a path with no reparse point / cloud
  # handshake to choke on. Unblock-File clears any Mark-of-the-Web.
  $tempCopy = Join-Path $env:TEMP ("hvac-sales-parse-" + [guid]::NewGuid().ToString("N") + ".xlsx")
  Copy-Item -LiteralPath $Path -Destination $tempCopy -Force
  Unblock-File -LiteralPath $tempCopy -ErrorAction SilentlyContinue

  # Read-only open of the copy.
  $wb = $excel.Workbooks.Open($tempCopy, [Type]::Missing, $true)
  if (-not $wb) { throw "Workbooks.Open returned nothing for the temp copy of '$Path'." }
  Write-Host "Opened workbook copy: $($wb.Name)"

  foreach ($monthName in $MONTH_TABS) {
    $ws = $wb.Worksheets.Item($monthName)
    $used = $ws.UsedRange
    $rows = $used.Rows.Count

    $monthCount = 0
    for ($r = 3; $r -le $rows; $r++) {
      $ca = $used.Cells.Item($r, 1).Text.Trim()
      if ($ca -eq "") { continue }

      # .Value2 is Excel's OLE Automation date (a double) for a real date
      # cell -- reading the raw value instead of .Text sidesteps any ambiguity
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
}
catch {
  Close-Excel -Workbook $wb
  Write-Error ("HVAC sales parse failed -- '" + $OutJson + "' left unchanged. " + $_.Exception.Message)
  Write-Error "If the workbook is open in Excel, close it and re-run. If it's a OneDrive online-only file, right-click it and choose 'Always keep on this device'."
  exit 1
}

Close-Excel -Workbook $wb

# A real parse of this workbook always returns at least January's rows. Zero
# across all 12 tabs means a read failure that didn't throw (e.g. a stale
# already-open workbook handed back by Excel) -- don't overwrite with it.
if ($records.Count -eq 0) {
  Write-Error "Parsed 0 records across all 12 tabs -- '$OutJson' left unchanged (treating this as a read failure, not an empty year)."
  exit 1
}

$meta = [ordered]@{
  generated_at  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  record_count  = $records.Count
}
$result = [ordered]@{ meta = $meta; records = $records }

# Full regenerate every run (not an incremental merge like the P&L parser's
# manual paste-under-this-month's-key pattern) -- re-reading all 12 tabs
# fresh each time is simple and can't drift, since the source workbook is
# the only truth here and there's nothing to preserve across runs.
$result | ConvertTo-Json -Depth 5 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "Wrote $($records.Count) records to $OutJson"
