# Parses the hand-maintained "Manual Metrics" workbook (one tab per
# department, one row per calendar month) into docs/data/manual-metrics.json
# -- the numbers company-scorecard.html's "Entered by hand" section needs
# that have no Housecall Pro or P&L equivalent (paid/billed hours,
# attendance, headcounts, etc. -- see departments-config.js's `manual`
# arrays for the full list per department). Same shape and same reasoning
# as parse-hvac-sales.ps1: the source workbook is a local OneDrive file
# GitHub Actions can't reach, so this runs locally (by hand or via the
# scheduled refresh-manual-metrics.ps1 wrapper) and its output is committed
# like any other data file.
#
# Usage:
#   powershell -File scripts\parse-manual-metrics.ps1 -Path "C:\path\to\Manual Metrics.xlsx"
#
# Requires Windows + Excel (COM automation -- see parse-pnl.ps1's header
# comment for why this repo has no Node/Python xlsx tooling instead).
#
# Column layout per department tab is hardcoded below in $DEPARTMENTS,
# matching each department's `manual` field list in departments-config.js
# exactly (key names here must match those `key`s verbatim). Column A on
# every tab is "Month" (a real date, the 1st of the month); data starts row
# 2, no blank spacer row (this workbook was built fresh for this pipeline,
# unlike HVAC Sales' inherited layout). A row with no Month value is treated
# as a trailing blank row and skipped.
#
# Percent columns (Attendance %, PTU Conversion %, Truck Inventory Accuracy
# %, New-Customer Club Conversion %, Existing-Customer Renewal Rate %) are
# entered by managers as plain whole numbers (83 meaning 83%) -- divided by
# 100 here since manual-metrics.json's *Pct fields are read as decimal
# fractions everywhere else on the site (company-scorecard.js multiplies by
# 100 for display). Every other column is a plain count, written through
# as-is. callbackCount and reviewsGenerated are raw counts despite
# "Callback rate" being the display label on the computed tile -- see
# departments-config.js's own comment on that key.
#
# The workbook lives under OneDrive and is usually a Files-On-Demand
# placeholder -- same Copy-Item-to-temp-first handling as parse-hvac-sales.ps1,
# see that script's header comment for why.
#
# FAILURE HANDLING: the output file is only overwritten on a clean parse
# (zero rows across all tabs is legitimate here, unlike HVAC Sales, since a
# brand new workbook or a month with nothing entered yet is a real state --
# so an empty result still writes, but a copy/open failure never does).
param(
  [string]$Path = "C:\Users\MichaelLohssJr\OneDrive - Regal, Inc,\Regal, Inc\Company Scorecard\Manual Metrics.xlsx",
  [string]$OutJson = "docs\data\manual-metrics.json"
)

$ErrorActionPreference = "Stop"

# sheet name -> BU code, and each tab's columns in on-sheet order (must match
# departments-config.js's `manual` key names exactly). Pct = $true means
# divide the entered whole number by 100 before writing.
$DEPARTMENTS = @(
  @{
    Sheet = "30 HVAC Service"; Code = "30"
    Columns = @(
      @{ Key = "paidHours"; Pct = $false }, @{ Key = "billedHours"; Pct = $false },
      @{ Key = "attendancePct"; Pct = $true }, @{ Key = "truckInventoryAccuracyPct"; Pct = $true },
      @{ Key = "reviewsGenerated"; Pct = $false }, @{ Key = "callbackCount"; Pct = $false },
      @{ Key = "vehicleCount"; Pct = $false }, @{ Key = "employeeCount"; Pct = $false },
      @{ Key = "dso"; Pct = $false }
    )
  },
  @{
    Sheet = "40 HVAC Maintenance"; Code = "40"
    Columns = @(
      @{ Key = "attendancePct"; Pct = $true }, @{ Key = "ptuConversionPct"; Pct = $true },
      @{ Key = "vehicleCount"; Pct = $false }, @{ Key = "paidHours"; Pct = $false },
      @{ Key = "billedHours"; Pct = $false }, @{ Key = "ptuTechDays"; Pct = $false },
      @{ Key = "employeeCount"; Pct = $false }, @{ Key = "supportCount"; Pct = $false },
      @{ Key = "productionCount"; Pct = $false }, @{ Key = "newCustClubConversion"; Pct = $true },
      @{ Key = "renewalRate"; Pct = $true }
    )
  },
  @{
    Sheet = "70 Plumbing Service"; Code = "70"
    Columns = @(
      @{ Key = "paidHours"; Pct = $false }, @{ Key = "billedHours"; Pct = $false },
      @{ Key = "attendancePct"; Pct = $true }, @{ Key = "truckInventoryAccuracyPct"; Pct = $true },
      @{ Key = "reviewsGenerated"; Pct = $false }, @{ Key = "callbackCount"; Pct = $false },
      @{ Key = "vehicleCount"; Pct = $false }, @{ Key = "employeeCount"; Pct = $false },
      @{ Key = "supportCount"; Pct = $false }, @{ Key = "productionCount"; Pct = $false },
      @{ Key = "dso"; Pct = $false }
    )
  },
  @{
    Sheet = "80 Plumbing Maintenance"; Code = "80"
    Columns = @(
      @{ Key = "attendancePct"; Pct = $true }, @{ Key = "reviewsGenerated"; Pct = $false },
      @{ Key = "callbackCount"; Pct = $false }, @{ Key = "vehicleCount"; Pct = $false }
    )
  },
  @{
    Sheet = "10 HVAC Installation"; Code = "10"
    Columns = @(
      @{ Key = "employeeCount"; Pct = $false }, @{ Key = "vehicleCount"; Pct = $false },
      @{ Key = "crewCount"; Pct = $false }
    )
  },
  @{
    Sheet = "50 Plumbing Installation"; Code = "50"
    Columns = @(
      @{ Key = "employeeCount"; Pct = $false }, @{ Key = "vehicleCount"; Pct = $false },
      @{ Key = "crewCount"; Pct = $false }
    )
  }
)

# Same PID-tracking pattern as parse-hvac-sales.ps1 -- only force-kills the
# EXCEL.EXE process this run itself spawns, never a window the user already
# had open.
$excelPidsBefore = @(Get-Process EXCEL -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$excel.AskToUpdateLinks = $false

Start-Sleep -Milliseconds 300
$spawnedPid = Get-Process EXCEL -ErrorAction SilentlyContinue |
  Where-Object { $excelPidsBefore -notcontains $_.Id } |
  Select-Object -First 1 -ExpandProperty Id

$tempCopy = $null

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
# $data.($month).($deptCode) = @{ key = value }
$data = [ordered]@{}

try {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Source workbook not found at '$Path'."
  }

  $tempCopy = Join-Path $env:TEMP ("manual-metrics-parse-" + [guid]::NewGuid().ToString("N") + ".xlsx")
  Copy-Item -LiteralPath $Path -Destination $tempCopy -Force
  Unblock-File -LiteralPath $tempCopy -ErrorAction SilentlyContinue

  $wb = $excel.Workbooks.Open($tempCopy, [Type]::Missing, $true)
  if (-not $wb) { throw "Workbooks.Open returned nothing for the temp copy of '$Path'." }
  Write-Host "Opened workbook copy: $($wb.Name)"

  foreach ($dept in $DEPARTMENTS) {
    $ws = $wb.Worksheets.Item($dept.Sheet)
    $used = $ws.UsedRange
    $rows = $used.Rows.Count

    $monthCount = 0
    for ($r = 2; $r -le $rows; $r++) {
      $monthVal = $used.Cells.Item($r, 1).Value2
      if (-not ($monthVal -is [double])) { continue }
      $monthKey = [DateTime]::FromOADate($monthVal).ToString("yyyy-MM")

      $entry = [ordered]@{}
      for ($c = 0; $c -lt $dept.Columns.Count; $c++) {
        $col = $dept.Columns[$c]
        $raw = $used.Cells.Item($r, $c + 2).Value2
        # PowerShell coerces the RHS to the LHS's type on -eq, so a naive
        # "$raw -eq `"`"" is true for a numeric 0 (`"`" casts to 0) -- a real
        # value that must NOT be dropped as blank (BU 80's July Vehicles=0
        # caught exactly this). Only a genuine string counts as "blank" here.
        if ($null -eq $raw -or ($raw -is [string] -and $raw -eq "")) {
          $entry[$col.Key] = $null
        }
        elseif ($col.Pct) {
          $entry[$col.Key] = [double]$raw / 100.0
        }
        else {
          $entry[$col.Key] = [double]$raw
        }
      }

      if (-not $data.Contains($monthKey)) { $data[$monthKey] = [ordered]@{} }
      $data[$monthKey][$dept.Code] = $entry
      $monthCount++
    }
    Write-Host "$($dept.Sheet): $monthCount month row(s)"
  }
}
catch {
  Close-Excel -Workbook $wb
  Write-Error ("Manual metrics parse failed -- '" + $OutJson + "' left unchanged. " + $_.Exception.Message)
  Write-Error "If the workbook is open in Excel, close it and re-run. If it's a OneDrive online-only file, right-click it and choose 'Always keep on this device'."
  exit 1
}

Close-Excel -Workbook $wb

# Full regenerate every run (same reasoning as parse-hvac-sales.ps1) -- the
# workbook is the only source of truth, so there's nothing to preserve
# across runs; an empty result is written as-is (a brand new department
# tab with no rows yet is a legitimate state, unlike HVAC Sales where zero
# rows across all 12 month tabs is always a read failure).
$data | ConvertTo-Json -Depth 5 | Out-File -FilePath $OutJson -Encoding utf8
$monthTotal = $data.Keys.Count
Write-Host "Wrote $monthTotal month(s) to $OutJson"
