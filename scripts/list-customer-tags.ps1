# Enumerates every distinct customer tag in the account, with a count of
# how many customers carry it -- so we can pick out the real membership
# tier tags by name instead of guessing/relying on memory. The /customers
# list endpoint already returns `tags` inline (confirmed via
# probe-membership.ps1), so this is one paginated scan, no per-customer
# detail calls.
#
# Usage:
#   $env:HCP_API_KEY = "your_key"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\list-customer-tags.ps1

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
  $resp = Invoke-WebRequest -Uri $uri -Headers $Headers -Method Get -UseBasicParsing
  return ($resp.Content | ConvertFrom-Json)
}

$tagCounts = @{}
$page = 1
$totalPages = 1
$totalCustomers = 0

do {
  $body = Invoke-Hcp -Path "/customers" -Query @{ page = $page; page_size = 100 }
  if (-not $body -or -not $body.customers) { break }
  $totalPages = $body.total_pages
  if ($page -eq 1) { Write-Host "Total customers to scan: $($body.total_items) across $totalPages pages..." }

  foreach ($c in $body.customers) {
    $totalCustomers++
    foreach ($t in ($c.tags | Where-Object { $_ })) {
      if (-not $tagCounts.ContainsKey($t)) { $tagCounts[$t] = 0 }
      $tagCounts[$t]++
    }
  }

  if ($page % 10 -eq 0) { Write-Host "...page $page / $totalPages ($totalCustomers customers so far)" }
  $page++
} while ($page -le $totalPages -and $page -le 300)

Write-Host "`nScanned $totalCustomers customers.`n"
Write-Host "=== Every distinct customer tag, most common first ==="
$tagCounts.GetEnumerator() | Sort-Object -Property Value -Descending | ForEach-Object {
  "{0,5}  {1}" -f $_.Value, $_.Key
}

Write-Host "`nDone. Paste this list back into chat -- point out which ones are membership tiers."
