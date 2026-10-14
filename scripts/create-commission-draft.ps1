# Builds the weekly sales-commission email for the controller and leaves it as
# an UNSENT draft in Outlook -- it never sends anything. Michael reviews the
# draft Wednesday morning and sends it himself.
#
# What it does:
#   1. (unless -SkipRefresh) runs the HVAC Sales and Commission refreshes so
#      the sheet's System Types and the OnCall Air sold-proposal files are
#      current -- a sale accepted late Tuesday can land hours later.
#   2. Runs generate-commission-report.ps1 for the target Wed-Tue pay week
#      (the payroll source of truth: it flags any sale it can't rate, rather
#      than guessing) and reads its CSV.
#   3. Builds the email (summary + every sale with its math) and saves it to
#      the Outlook Drafts folder via the classic-Outlook COM object.
#
# A sale that can't be rated (no/ambiguous System Type, unknown consultant) is
# listed at the TOP of the draft as "needs review -- not in the totals" and the
# subject gets a [REVIEW NEEDED] tag, so a short payout is never silent.
#
# The recipient is NOT stored in this repo (it's public). Put the controller's
# address(es) in  %LOCALAPPDATA%\TeamRegal\commission-email-to.txt  (one line,
# semicolon-separated if several), or pass -To. With neither, the draft is
# saved with the To line blank.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create-commission-draft.ps1
#   ...-WeekStart "2026-10-07"      # a specific week (the Wednesday it starts)
#   ...-SkipRefresh                  # just rebuild from the data already on disk
#   ...-Force                        # replace/duplicate even if a draft with this subject exists
#
# Scheduled: "TeamRegal - Commission Email Draft", Wednesdays 05:50 (after the
# 05:30/05:35 refreshes). Log: %LOCALAPPDATA%\TeamRegal\create-commission-draft.log
param(
  [datetime]$WeekStart,
  [string]$To,
  [switch]$SkipRefresh,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$LogDir = Join-Path $env:LOCALAPPDATA "TeamRegal"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "create-commission-draft.log"
function Log([string]$msg) { "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $msg" | Tee-Object -FilePath $LogFile -Append | Write-Host }

try {
  Log "--- draft start ---"

  # Most recently completed Wed-Tue week (same rule as generate-commission-report.ps1).
  if (-not $WeekStart) {
    $today = (Get-Date).Date
    $daysSinceTuesday = (([int]$today.DayOfWeek) - [int][DayOfWeek]::Tuesday + 7) % 7
    if ($daysSinceTuesday -eq 0) { $daysSinceTuesday = 7 }
    $WeekStart = $today.AddDays(-$daysSinceTuesday - 6)
  }
  $WeekStart = $WeekStart.Date
  $weekEnd = $WeekStart.AddDays(6)
  $rangeText = if ($WeekStart.Month -eq $weekEnd.Month) { "$($WeekStart.ToString('MMM d'))-$($weekEnd.ToString('%d')), $($weekEnd.Year)" } else { "$($WeekStart.ToString('MMM d'))-$($weekEnd.ToString('MMM d')), $($weekEnd.Year)" }
  $longRange = "Wednesday, $($WeekStart.ToString('MMM d')) - Tuesday, $($weekEnd.ToString('MMM d, yyyy'))"

  if (-not $SkipRefresh) {
    foreach ($s in "refresh-hvac-sales.ps1", "refresh-commission-report.ps1") {
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $s) | Out-Null
        Log "ran $s (exit $LASTEXITCODE)"
      } catch { Log "WARNING: $s failed: $($_.Exception.Message) -- continuing with data on disk" }
    }
  }

  $csv = Join-Path $env:TEMP "commission-draft-$($WeekStart.ToString('yyyyMMdd')).csv"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "generate-commission-report.ps1") -WeekStart $WeekStart -OutCsv $csv | Out-Null
  if (-not (Test-Path $csv)) { throw "generate-commission-report.ps1 produced no CSV (no sales in the week?)" }
  $rows = @(Import-Csv $csv)
  Remove-Item $csv -ErrorAction SilentlyContinue
  if ($rows.Count -eq 0) { throw "no sales found for the week of $($WeekStart.ToString('yyyy-MM-dd'))" }

  $inv = [Globalization.CultureInfo]::InvariantCulture
  function M($v) { '$' + ([decimal]::Parse("$v", $inv)).ToString('N2', $inv) }
  function Esc($s) { [System.Net.WebUtility]::HtmlEncode("$s") }
  $names = @{ Josh = "Josh Zieger"; Nick = "Nick Webb" }

  $good = @($rows | Where-Object { $_.Status -eq "ok" -and $_.Commission -ne "" })
  $flagged = @($rows | Where-Object { -not ($_.Status -eq "ok" -and $_.Commission -ne "") })

  $totals = @{}
  foreach ($ca in "Josh", "Nick") {
    $sum = [decimal]0
    foreach ($r in ($good | Where-Object { $_.CA -eq $ca })) { $sum += [decimal]::Parse($r.Commission, $inv) }
    $totals[$ca] = [math]::Round($sum, 2)
  }
  $grand = $totals.Josh + $totals.Nick

  $sections = ""
  foreach ($ca in "Josh", "Nick") {
    $mine = @($good | Where-Object { $_.CA -eq $ca } | Sort-Object AcceptedAt)
    $body = ""
    foreach ($r in $mine) {
      $mk = @()
      if ([decimal]::Parse($r.CommissionMarkup, $inv) -ne 0) { $mk += "$(M $r.CommissionMarkup) commission" }
      if ([decimal]::Parse($r.FinancingMarkup, $inv) -ne 0) { $mk += "$(M $r.FinancingMarkup) financing" }
      if ([decimal]::Parse($r.RebateMarkup, $inv) -ne 0) { $mk += "$(M $r.RebateMarkup) rebate" }
      $mkText = if ($mk.Count) { "&minus; " + ($mk -join " &minus; ") } else { "&mdash;" }
      $acc = ([datetime]$r.AcceptedAt).ToString("ddd M/d h:mm tt")
      $pct = [math]::Round([decimal]::Parse($r.Rate, $inv) * 100, 0)
      $body += "<tr><td>$(Esc $r.Customer)</td><td>$acc</td><td class='n'>$(M $r.GrossSubtotal)</td><td class='n'>$mkText</td><td class='n'>$(M $r.Subtotal)</td><td>$(Esc $r.SystemType) @ $pct%</td><td class='n b'>$(M $r.Commission)</td></tr>`n"
    }
    if (-not $body) { $body = "<tr><td colspan='7'>No sales this week.</td></tr>`n" }
    $sections += "<h3>$($names[$ca]) ($($mine.Count) sales)</h3><table><tr><th>Customer</th><th>Accepted</th><th>Subtotal</th><th>Markups removed</th><th>Commission base</th><th>System / rate</th><th>Commission</th></tr>`n$body<tr class='tot'><td colspan='6'>$($ca) total</td><td class='n b'>$(M $totals[$ca])</td></tr></table>"
  }

  $flagHtml = ""
  if ($flagged.Count) {
    $items = ($flagged | ForEach-Object { "<li><b>$(Esc $_.Customer)</b> ($(Esc $_.CA), $(M $_.GrossSubtotal)) &ndash; $(Esc $_.Status)</li>" }) -join ""
    $flagHtml = "<div class='review'><b>Needs review &ndash; NOT included in the totals below:</b><ul>$items</ul></div>"
  }

  $ct = ([datetime]::Now).ToString("ddd M/d/yyyy h:mm tt")
  $html = @"
<html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222}h2{margin:14px 0 4px}h3{margin:20px 0 6px}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}th{background:#f0f0f0;font-size:12px}td.n{text-align:right;white-space:nowrap}.b{font-weight:bold}tr.tot td{background:#fafafa;font-weight:bold}.review{border:2px solid #c77700;background:#fff6e5;padding:8px 12px;margin:12px 0}.note{color:#666;font-size:12px;margin-top:18px}</style></head><body>
<p>Hi,</p>
<p>Here are the sales commissions for the pay week <b>$longRange</b>. Each line shows the math: sale subtotal, less the markups OnCall Air adds on top, times the consultant's rate for that system type.</p>
$flagHtml
<h2>Commission summary</h2>
<table><tr><th>Consultant</th><th>Commission</th></tr><tr><td>Josh Zieger</td><td class="n b">$(M $totals.Josh)</td></tr><tr><td>Nick Webb</td><td class="n b">$(M $totals.Nick)</td></tr><tr class="tot"><td>Total</td><td class="n b">$(M $grand)</td></tr></table>
$sections
<p class="note">Source: OnCall Air sold-proposal data and the sales sheet (system type), prepared $ct. A proposal that was re-accepted is counted once, at its final price.</p>
</body></html>
"@

  $subject = "Sales commission - pay week $rangeText"
  if ($flagged.Count) { $subject = "[REVIEW NEEDED] $subject" }

  if (-not $To) {
    $toFile = Join-Path $LogDir "commission-email-to.txt"
    if (Test-Path $toFile) { $To = (Get-Content $toFile -Raw).Trim() }
  }

  # Outlook rejects COM calls (RPC_E_CALL_REJECTED / RPC failed) for a few
  # seconds while it's starting up, which is exactly the state it's in when
  # this runs at 05:50 with Outlook closed -- retry instead of failing.
  $ol = $null
  $drafts = $null
  for ($attempt = 1; $attempt -le 8 -and -not $drafts; $attempt++) {
    try {
      $ol = New-Object -ComObject Outlook.Application
      $drafts = $ol.Session.GetDefaultFolder(16)   # olFolderDrafts
    } catch {
      Log "Outlook not ready (attempt $attempt): $($_.Exception.Message.Split([char]10)[0])"
      Start-Sleep -Seconds 8
    }
  }
  if (-not $drafts) { throw "could not reach Outlook after several attempts" }
  # Match on the base subject (with or without the review tag) so a re-run
  # replaces its own earlier draft instead of stacking duplicates.
  $baseSubject = "Sales commission - pay week $rangeText"
  $existing = @($drafts.Items | Where-Object { $_.Subject -eq $baseSubject -or $_.Subject -eq "[REVIEW NEEDED] $baseSubject" })
  if ($existing.Count -and -not $Force) {
    Log "a draft '$baseSubject' already exists in Drafts -- leaving it alone (use -Force to replace)"
    return
  }
  foreach ($e in $existing) { $e.Delete() | Out-Null }

  $mail = $ol.CreateItem(0)
  $mail.Subject = $subject
  if ($To) { $mail.To = $To }
  $mail.HTMLBody = $html
  $mail.Save()
  Log "saved draft '$subject' (To: $(if ($To) { $To } else { '<blank>' }); Josh $(M $totals.Josh), Nick $(M $totals.Nick), $($flagged.Count) flagged)"
  Log "--- draft end (saved) ---"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Log "--- draft end (error) ---"
  exit 1
}
