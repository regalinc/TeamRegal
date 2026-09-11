# One-off probe: what does the Housecall Pro API actually expose for a
# membership "what you saved" report?
#
# Runs entirely on YOUR machine using YOUR API key -- nothing here touches
# GitHub, the repo, or any log anyone else could see. Built in PowerShell
# (not Node/Python) since that's what's actually available on this machine.
#
# Usage:
#   $env:HCP_API_KEY = "paste_your_key_here"
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-membership.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File probe-membership.ps1 -LastName "Smith"
#
# What it checks, in order:
#   1. Customer search by last name -- does the match include a `tags`
#      field, and does it contain something like "Whole Home Membership"?
#   2. Full single-customer detail fetch (list endpoints sometimes trim
#      fields the single-resource endpoint includes).
#   3. That customer's jobs -> full detail on the most recent one -> do
#      line items / a discount named like "Whole Home Membership Discount"
#      show up anywhere on it?
#   4. A handful of plausible dedicated-membership endpoints (recurring
#      service plans / memberships). Most will 404 -- that's useful
#      information too: it tells us HCP's public API doesn't expose that
#      object at all, so a renewal-date report can't be built from it.
#
# Prints raw JSON so we see real field names, not a guess. Paste whichever
# sections come back with real data into chat.

param(
  [string]$LastName = "Meskey"
)

$ErrorActionPreference = "Stop"
$ApiBase = "https://api.housecallpro.com"
$ApiKey = $env:HCP_API_KEY

if (-not $ApiKey) {
  Write-Host 'Set HCP_API_KEY first, e.g.:  $env:HCP_API_KEY = "your_key"' -ForegroundColor Yellow
  exit 1
}

$Headers = @{ Accept = "application/json"; Authorization = "Token $ApiKey" }

# Returns @{ Status = <int or $null>; Body = <parsed object, or raw text, or $null> }
function Invoke-Hcp {
  param([string]$Path, [hashtable]$Query)

  $uri = $ApiBase + $Path
  if ($Query -and $Query.Count -gt 0) {
    $pairs = $Query.GetEnumerator() | ForEach-Object { "$([uri]::EscapeDataString($_.Key))=$([uri]::EscapeDataString([string]$_.Value))" }
    $uri += "?" + ($pairs -join "&")
  }

  try {
    $resp = Invoke-WebRequest -Uri $uri -Headers $Headers -Method Get -UseBasicParsing
    $parsed = $null
    if ($resp.Content) { try { $parsed = $resp.Content | ConvertFrom-Json } catch { $parsed = $resp.Content } }
    return @{ Status = [int]$resp.StatusCode; Body = $parsed }
  }
  catch {
    $r = $_.Exception.Response
    if (-not $r) { return @{ Status = $null; Body = "ERROR: $($_.Exception.Message)" } }
    $status = [int]$r.StatusCode
    $stream = $r.GetResponseStream()
    $reader = New-Object System.IO.StreamReader($stream)
    $text = $reader.ReadToEnd()
    $parsed = $null
    if ($text) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $text } }
    return @{ Status = $status; Body = $parsed }
  }
}

function Show-Result {
  param([string]$Title, [hashtable]$Result, [int]$MaxChars = 3000)
  Write-Host ""
  Write-Host ("=" * 78)
  Write-Host "$Title  ->  HTTP $($Result.Status)"
  Write-Host ("=" * 78)
  $text = $Result.Body | ConvertTo-Json -Depth 10
  if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) + "`n... [truncated, $($text.Length) chars total]" }
  Write-Host $text
}

# 1. Search customers by last name. Trying a couple of likely query-param
# names since we don't have the docs in front of us -- whichever one
# actually filters (fewer results than the unfiltered list) is the real one.
$r = Invoke-Hcp -Path "/customers" -Query @{ q = $LastName; page_size = 10 }
Show-Result "GET /customers?q=$LastName" $r

$customer = $null
if ($r.Body -and $r.Body.customers -and $r.Body.customers.Count -gt 0) { $customer = $r.Body.customers[0] }

if (-not $customer) {
  $r2 = Invoke-Hcp -Path "/customers" -Query @{ search = $LastName; page_size = 10 }
  Show-Result "GET /customers?search=$LastName" $r2
  if ($r2.Body -and $r2.Body.customers -and $r2.Body.customers.Count -gt 0) { $customer = $r2.Body.customers[0] }
}

if (-not $customer) {
  Write-Host "`nNo match via search params -- would need a paginated scan instead. Stopping here."
  exit 0
}

$custId = $customer.id
Write-Host "`n>>> Matched customer id: $custId"
Write-Host ">>> Top-level keys on the search-result customer object: $(($customer.PSObject.Properties.Name | Sort-Object) -join ', ')"
Write-Host ">>> tags field on search result: $($customer.tags | ConvertTo-Json -Compress)"

# 2. Full single-customer fetch.
$r = Invoke-Hcp -Path "/customers/$custId"
Show-Result "GET /customers/$custId" $r
if ($r.Body) {
  Write-Host ">>> tags field on full customer record: $($r.Body.tags | ConvertTo-Json -Compress)"
}

# 3. This customer's jobs.
$r = Invoke-Hcp -Path "/jobs" -Query @{ customer_id = $custId; page_size = 25 }
Show-Result "GET /jobs?customer_id=$custId" $r

$jobs = @()
if ($r.Body -and $r.Body.jobs) { $jobs = $r.Body.jobs }
Write-Host "`n>>> $($jobs.Count) jobs found for this customer."

if ($jobs.Count -gt 0) {
  $job = $jobs[0]
  $jobId = $job.id
  Write-Host ">>> Top-level keys on a job-list entry: $(($job.PSObject.Properties.Name | Sort-Object) -join ', ')"

  $r = Invoke-Hcp -Path "/jobs/$jobId"
  Show-Result "GET /jobs/$jobId  (full detail)" $r
  if ($r.Body) {
    Write-Host ">>> Top-level keys on full job detail: $(($r.Body.PSObject.Properties.Name | Sort-Object) -join ', ')"
    if ($r.Body.PSObject.Properties.Name -contains "invoice") {
      Write-Host ">>> invoice sub-object keys: $(($r.Body.invoice.PSObject.Properties.Name | Sort-Object) -join ', ')"
    }
    if ($r.Body.PSObject.Properties.Name -contains "line_items") {
      Write-Host ">>> line_items present directly on job: $($r.Body.line_items | ConvertTo-Json -Depth 6 -Compress)"
    }
  }

  foreach ($sub in @("line_items", "invoice", "invoices")) {
    $r = Invoke-Hcp -Path "/jobs/$jobId/$sub"
    Show-Result "GET /jobs/$jobId/$sub" $r
  }
}

# 4. Speculative membership-specific endpoints. Most of these will 404 --
# that's a real, useful answer (means it's not exposed here).
foreach ($path in @(
    "/customers/$custId/memberships",
    "/customers/$custId/recurring_service_plans",
    "/memberships",
    "/recurring_service_plans",
    "/company/memberships"
  )) {
  $r = Invoke-Hcp -Path $path
  Show-Result "GET $path" $r 800
}

Write-Host "`n`nDone. Paste whichever sections above actually returned useful data back into chat."
