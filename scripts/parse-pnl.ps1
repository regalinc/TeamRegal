# Parses a monthly QuickBooks P&L export (one column per business unit, same
# shape as the "July P&L.xlsx" this was built against) into the JSON shape
# docs/data/pnl-monthly.json expects. Not part of the automated hourly sync —
# a P&L only exists once a month closes, so this is run by hand each month
# after the file is uploaded, and its output is pasted into
# pnl-monthly.json under that month's key.
#
# Usage:
#   powershell -File scripts/parse-pnl.ps1 -Path "C:\path\to\Month P&L.xlsx"
#
# Requires Windows + Excel (uses COM automation — this repo has no Node/
# Python-based xlsx tooling available in the environment this was built in).
#
# Account-to-bucket mapping is hand-derived from Regal's Chart of Accounts
# (Plumbing Department/Accounting/Chart of Accounts.xlsx) — update the
# range arrays below if the chart of accounts changes.
param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [string]$OutJson = "$env:TEMP\pnl_parsed.json"
)

# Track which EXCEL.EXE PID this run spawns, so cleanup at the end can force-
# kill exactly that process rather than trusting Quit() alone. A prior run
# left an orphaned background Excel process holding a workbook open in
# Protected View; a later run's Workbooks.Open() silently returned that
# stale, already-open workbook instead of the new file, producing a second
# month's output that was actually a byte-for-byte copy of the first. Never
# touches any Excel window the user already had open — only the PID this
# script itself creates.
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
$ws = $wb.Worksheets.Item("Sheet1")
$used = $ws.UsedRange
$rows = $used.Rows.Count
$cols = $used.Columns.Count

# --- Locate BU columns from the header row (row 1) ---
$buColMap = @{}   # buCode -> column index
for ($c = 1; $c -le $cols; $c++) {
  $h = $used.Cells.Item(1, $c).Text.Trim()
  if ($h -match '^(\d+)\s') { $buColMap[$Matches[1]] = $c }
}
Write-Host "BU columns found:" ($buColMap.Keys -join ", ")

# --- Account groupings (top-level account numbers only; "Total NNNN" rows used
#     for accounts that have hyphenated sub-account children, to avoid double-counting) ---
$MARKETING = @("6001","6002","6003","6004","6005","6006","6007","6008","6009")
$EMPLOYEE_RELATED = @("6020","6021","6022","6023","6024","6025","6026","6027","6028","6029","6030","6031","6032","6033","6034","6035","6036","6037")
$PLANT_EQUIPMENT = @("6050","6051","6052","6053","6054","6055","6056","6057","6058","6059","6060","6061","6062","6063")
$VEHICLE = @("6075","6076","6077","6078","6079")
$ADMINISTRATIVE = @("6101","6102","6103","6104","6105","6106","6107","6108","6109","6110","6111","6112","6113","6114","6115","6116","6117","6118","6119","6120")

function Get-CellNum($r, $c) {
  $v = $used.Cells.Item($r, $c).Value2
  if ($null -eq $v) { return 0 }
  return [double]$v
}

$result = @{}
foreach ($bu in $buColMap.Keys) {
  $result[$bu] = @{
    totalIncome = 0; grossProfit = 0; totalExpense = 0; netOrdinaryIncome = 0; netIncome = 0
    laborCost = 0; partsCost = 0; equipmentCost = 0; subcontractCost = 0; commissionCost = 0; fringeCost = 0
    marketing = 0; employeeRelated = 0; plantEquipment = 0; vehicle = 0; administrative = 0
    permits = 0; warranty = 0; buydowns = 0; warrantyLabor = 0; salesSalary = 0
  }
}

for ($r = 1; $r -le $rows; $r++) {
  # Row label is the rightmost non-empty cell among the first 5 columns —
  # labels sit at different indent depths ("Total Income" vs. a nested
  # "5004-M · Paid Time Off" sub-account).
  $label = $null
  for ($lc = 5; $lc -ge 1; $lc--) {
    $t = $used.Cells.Item($r, $lc).Text.Trim()
    if ($t -ne "") { $label = $t; break }
  }
  if ($null -eq $label) { continue }

  # Matches the leading account number only — NOT the "·" separator that
  # follows it. A prior version matched through that character and silently
  # produced zero for every bucket, because the "·" in this script file
  # didn't survive round-tripping through PowerShell 5.1's default encoding
  # and so never matched the correctly-decoded text Excel returns via COM.
  $acct = $null
  if ($label -match '^(\d{4}(-[A-Z])?)\b') { $acct = $Matches[1] }

  $bucket = $null
  if ($label -eq "Total Income") { $bucket = "totalIncome" }
  elseif ($label -eq "Gross Profit") { $bucket = "grossProfit" }
  elseif ($label -eq "Total Expense") { $bucket = "totalExpense" }
  elseif ($label -eq "Net Ordinary Income") { $bucket = "netOrdinaryIncome" }
  elseif ($label -eq "Net Income") { $bucket = "netIncome" }
  elseif ($label -match '^Total 5003') { $bucket = "laborCost" }
  elseif ($acct -eq "5001") { $bucket = "partsCost" }
  elseif ($acct -eq "5002") { $bucket = "equipmentCost" }
  elseif ($acct -eq "5005") { $bucket = "subcontractCost" }
  elseif ($acct -eq "5011") { $bucket = "commissionCost" }
  elseif ($acct -eq "5006") { $bucket = "permits" }
  elseif ($acct -eq "5007") { $bucket = "warranty" }
  elseif ($acct -eq "5008") { $bucket = "buydowns" }
  elseif ($acct -eq "5010") { $bucket = "warrantyLabor" }
  elseif ($acct -eq "5012") { $bucket = "salesSalary" }
  elseif ($label -match '^Total 5004') { $bucket = "fringeCost" }
  elseif ($acct -and $MARKETING -contains $acct) { $bucket = "marketing" }
  elseif ($acct -and $EMPLOYEE_RELATED -contains $acct) { $bucket = "employeeRelated" }
  elseif ($label -match '^Total 6026') { $bucket = "employeeRelated" }  # payroll tax total, child of Employee Related range
  elseif ($acct -and $PLANT_EQUIPMENT -contains $acct) { $bucket = "plantEquipment" }
  elseif ($acct -and $VEHICLE -contains $acct) { $bucket = "vehicle" }
  elseif ($acct -and $ADMINISTRATIVE -contains $acct) { $bucket = "administrative" }

  if ($null -eq $bucket) { continue }
  # Skip hyphenated sub-account rows for the two categories with a dedicated
  # Total row (5004-*, 6026-*) so they aren't summed on top of it.
  if ($acct -match '^(5004|6026)-') { continue }

  foreach ($bu in $buColMap.Keys) {
    $val = Get-CellNum $r $buColMap[$bu]
    $result[$bu][$bucket] += $val
  }
}

$wb.Close($false)
$excel.Quit()
[System.Runtime.Interopservices.Marshal]::ReleaseComObject($excel) | Out-Null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

# Fail-safe: Quit() can leave the process alive if Excel thinks a dialog is
# still pending (e.g. a Protected View file). Force-kill the exact PID this
# run spawned so the next invocation always starts from a clean process.
if ($spawnedPid) {
  Start-Sleep -Milliseconds 500
  if (Get-Process -Id $spawnedPid -ErrorAction SilentlyContinue) {
    Stop-Process -Id $spawnedPid -Force -ErrorAction SilentlyContinue
  }
}

$result | ConvertTo-Json -Depth 5 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "Wrote $OutJson"
Get-Content $OutJson
