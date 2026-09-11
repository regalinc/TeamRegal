# Housecall Pro's UI calls this feature "Service Plans" (Service Plans >
# Payments, with Plan status / Due date / Payment date filters) -- a
# different name than the "memberships" / "recurring_service_plans" guesses
# probe-membership.ps1 already ruled out. Trying the real name and a few
# variations to see if it's exposed via the public API at all.
#
# Usage:
#   $env:HCP_API_KEY = "your_key"
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\probe-service-plans.ps1 -CustomerId cus_e39e0fbc35bb440992cbd94919ca6eea

param(
  [string]$CustomerId = "cus_e39e0fbc35bb440992cbd94919ca6eea"
)

$ErrorActionPreference = "Stop"
$ApiBase = "https://api.housecallpro.com"
$ApiKey = $env:HCP_API_KEY
if (-not $ApiKey) { Write-Host 'Set HCP_API_KEY first.' -ForegroundColor Yellow; exit 1 }
$Headers = @{ Accept = "application/json"; Authorization = "Token $ApiKey" }

function Show-Probe {
  param([string]$Path)
  try {
    $resp = Invoke-WebRequest -Uri ($ApiBase + $Path) -Headers $Headers -Method Get -UseBasicParsing
    Write-Host "`nGET $Path  ->  HTTP $($resp.StatusCode)" -ForegroundColor Green
    $body = $resp.Content | ConvertFrom-Json
    $body | ConvertTo-Json -Depth 8 | Select-Object -First 1
    ($body | ConvertTo-Json -Depth 8) -split "`n" | Select-Object -First 60
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    Write-Host "`nGET $Path  ->  HTTP $status" -ForegroundColor DarkGray
  }
}

foreach ($path in @(
    "/service_plans",
    "/company/service_plans",
    "/customers/$CustomerId/service_plans",
    "/service_plans/payments",
    "/customers/$CustomerId/service_plan_payments",
    "/subscriptions",
    "/customers/$CustomerId/subscriptions"
  )) {
  Show-Probe $path
}

Write-Host "`n`nDone. Paste back whichever path(s) returned HTTP 200."
