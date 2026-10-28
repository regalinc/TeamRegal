# Builds the weekly sales-commission email for the controller and saves it as
# an unsent .eml file (Desktop\Commission Emails by default) -- it never sends
# anything. Michael double-clicks it Wednesday morning, it opens in Outlook as
# an editable message, he reviews it and sends it himself.
#
# What it does:
#   1. (unless -SkipRefresh) runs the HVAC Sales and Commission refreshes so
#      the sheet's System Types and the OnCall Air sold-proposal files are
#      current -- a sale accepted late Tuesday can land hours later.
#   2. Runs generate-commission-report.ps1 for the target Wed-Tue pay week
#      (the payroll source of truth: it flags any sale it can't rate, rather
#      than guessing) and reads its CSV.
#   3. Builds the email (summary + every sale with its math) and writes it as
#      an .eml with X-Unsent: 1 so Outlook opens it as an unsent message.
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
#   ...-Force                        # rebuild even if this week's .eml already exists
#   ...-OutDir "C:\some\folder"      # write somewhere other than Desktop\Commission Emails
#
# Scheduled: "TeamRegal - Commission Email Draft", Wednesdays 05:50 (after the
# 05:30/05:35 refreshes). Log: %LOCALAPPDATA%\TeamRegal\create-commission-draft.log
param(
  [datetime]$WeekStart,
  [string]$To,
  [switch]$SkipRefresh,
  [switch]$Force,
  [string]$OutDir
)

$ErrorActionPreference = "Stop"
# Not $env:LOCALAPPDATA: under Task Scheduler (cmd.exe /c powershell ...) the
# 2026-10-28 05:50 run logged into the scheduler log only and found no
# commission-email-to.txt, i.e. the env var didn't point at the real folder
# there. The shell-folder API doesn't depend on the environment.
$LocalApp = [Environment]::GetFolderPath("LocalApplicationData")
if (-not $LocalApp) { $LocalApp = Join-Path $env:USERPROFILE "AppData\Local" }
$LogDir = Join-Path $LocalApp "TeamRegal"
New-Item -ItemType Directory -Force $LogDir | Out-Null
$LogFile = Join-Path $LogDir "create-commission-draft.log"
function Log([string]$msg) { "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $msg" | Tee-Object -FilePath $LogFile -Append | Write-Host }

try {
  Log "--- draft start ---"
  Log "env: user=$([Environment]::UserName) profile=$env:USERPROFILE localapp=$LocalApp logdir=$LogDir cwd=$((Get-Location).Path)"

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

  # Sales that may be double-counted (find-duplicate-proposals.ps1). Unlike a
  # sale that can't be rated, these ARE in the totals -- the box asks for a
  # decision before paying. Only ones touching this pay week are shown.
  $dupFlags = @()
  $reaccepted = @()
  try {
    $dupJson = Join-Path $env:TEMP "commission-draft-dupes.json"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "find-duplicate-proposals.ps1") -OutJson $dupJson | Out-Null
    $dup = Get-Content $dupJson -Raw | ConvertFrom-Json
    Remove-Item $dupJson -ErrorAction SilentlyContinue
    $weekEndExclusive = $weekEnd.AddDays(1)
    $inWeek = { param($p) ([datetime]$p.acceptedAt) -ge $WeekStart -and ([datetime]$p.acceptedAt) -lt $weekEndExclusive }
    $dupFlags = @($dup.flags | Where-Object { @($_.proposals | Where-Object { & $inWeek $_ }).Count -gt 0 })
    $reaccepted = @($dup.reaccepted | Where-Object { & $inWeek $_.versions[-1] })
  } catch {
    Log "WARNING: duplicate check failed: $($_.Exception.Message)"
  }

  $flagHtml = ""
  if ($flagged.Count) {
    $items = ($flagged | ForEach-Object { "<li><b>$(Esc $_.Customer)</b> ($(Esc $_.CA), $(M $_.GrossSubtotal)) &ndash; $(Esc $_.Status)</li>" }) -join ""
    $flagHtml = "<div class='review'><b>Needs review &ndash; NOT included in the totals below:</b><ul>$items</ul></div>"
  }
  if ($dupFlags.Count) {
    $items = ($dupFlags | ForEach-Object {
        $f = $_
        $opts = ($f.proposals | ForEach-Object { "$(Esc $_.label) $(M $_.subtotal) (accepted $(([datetime]$_.acceptedAt).ToString('ddd M/d h:mm tt')))" }) -join " &nbsp;<b>and</b>&nbsp; "
        "<li><b>$(Esc $f.customer)</b> ($(Esc $f.ca)): $opts</li>"
      }) -join ""
    $flagHtml += "<div class='review'><b>Possible duplicate &ndash; counted TWICE in the totals below until you confirm:</b><ul>$items</ul>Same customer, more than one proposal accepted. If one was accepted by mistake, tell Claude which one to drop; if both are real sales, no change is needed.</div>"
  }
  $reacceptedNote = ""
  if ($reaccepted.Count) {
    $items = ($reaccepted | ForEach-Object { "$(Esc $_.customer) (" + (($_.versions | ForEach-Object { M $_.subtotal }) -join " &rarr; ") + ")" }) -join "; "
    $reacceptedNote = "<p class='note'>Re-accepted proposals, counted once at the final price: $items.</p>"
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
$reacceptedNote
<p class="note">Source: OnCall Air sold-proposal data and the sales sheet (system type), prepared $ct. A proposal that was re-accepted is counted once, at its final price.</p>
</body></html>
"@

  $subject = "Sales commission - pay week $rangeText"
  if ($flagged.Count -or $dupFlags.Count) { $subject = "[REVIEW NEEDED] $subject" }

  if (-not $To) {
    $toFile = Join-Path $LogDir "commission-email-to.txt"
    if (Test-Path $toFile) { $To = (Get-Content $toFile -Raw).Trim() }
    Log "recipient file: $toFile exists=$(Test-Path $toFile) to='$To'"
  }

  # Written as an .eml with "X-Unsent: 1", which Outlook opens as an editable,
  # unsent message (To/Subject/body filled in) rather than a received one.
  # This replaced creating a draft through classic Outlook's COM object
  # (2026-10-14): Michael uses the NEW Outlook, which has no COM interface,
  # and the draft saved by classic never synced up to his mailbox. Nothing is
  # sent -- he double-clicks the file, adds/confirms the recipient, and sends.
  if (-not $OutDir) { $OutDir = Join-Path ([Environment]::GetFolderPath("Desktop")) "Commission Emails" }
  New-Item -ItemType Directory -Force $OutDir | Out-Null
  $baseName = ("Sales commission - pay week $rangeText") -replace '[\\/:*?"<>|]', '-'
  $emlPath = Join-Path $OutDir "$baseName.eml"
  if ((Test-Path $emlPath) -and -not $Force) {
    Log "'$emlPath' already exists -- leaving it alone (use -Force to rebuild)"
    return
  }

  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($html))
  $b64Lines = for ($i = 0; $i -lt $b64.Length; $i += 76) { $b64.Substring($i, [math]::Min(76, $b64.Length - $i)) }
  $headers = @("X-Unsent: 1")
  if ($To) { $headers += "To: $To" }
  $headers += "Subject: $subject"
  $headers += "MIME-Version: 1.0"
  $headers += "Content-Type: text/html; charset=utf-8"
  $headers += "Content-Transfer-Encoding: base64"
  $eml = ($headers -join "`r`n") + "`r`n`r`n" + ($b64Lines -join "`r`n") + "`r`n"
  [IO.File]::WriteAllText($emlPath, $eml, (New-Object Text.ASCIIEncoding))
  Log "saved '$emlPath' (To: $(if ($To) { $To } else { '<blank>' }); Josh $(M $totals.Josh), Nick $(M $totals.Nick), $($flagged.Count) flagged, $($dupFlags.Count) possible duplicate(s))"
  Log "--- draft end (saved) ---"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Log "--- draft end (error) ---"
  exit 1
}
