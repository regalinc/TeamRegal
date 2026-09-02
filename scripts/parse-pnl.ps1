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

$excel = New-Object -ComObject Excel.Application
$excel.Visible = $false
$excel.DisplayAlerts = $false
$wb = $excel.Workbooks.Open($Path, [Type]::Missing, $true)
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

$result | ConvertTo-Json -Depth 5 | Out-File -FilePath $OutJson -Encoding utf8
Write-Host "Wrote $OutJson"
Get-Content $OutJson
