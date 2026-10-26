# Flags OnCall Air sales that may be double-counted, from the sold-proposal
# webhook files. Built 2026-10-26 after Kara Tate: two options (PLATINUM $7,620,
# BRONZE $13,771) on one consultation were both accepted an hour apart, the
# first by mistake, and only the second survived in OnCall Air -- but the
# webhook repo keeps both files, so commission counted both until Michael's
# staff noticed.
#
# Two kinds of finding:
#   flags       NEED A DECISION -- more than one live proposal where there is
#               probably one sale:
#                 same-consultation  different proposals, same consultation code
#                 same-customer      same customer name, different consultations,
#                                    accepted within -RepeatCustomerDays of each other
#               A flag is silenced by listing the mistaken proposal in
#               $SUPERSEDED_PROPOSAL_IDS, or (if both are real sales) every
#               proposal of the group in $CONFIRMED_SEPARATE_PROPOSAL_IDS, both in
#               commission-overrides.ps1.
#   reaccepted  INFORMATION ONLY -- the SAME proposal accepted again (usually at
#               a new price). The commission scripts already keep the latest
#               acceptance; this just says so (Pedro Domingos, 2026-10-12).
#
# Tested against all 59 payloads on 2026-10-26: flagged only Kara Tate (before
# she was resolved) -- no false positives.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\find-duplicate-proposals.ps1
#   ... -OutJson out.json     # machine-readable result (used by the weekly email
#                             # draft and the cloud job's GitHub-issue alert)
#
# Flag text (title/body) deliberately carries NO dollar amounts: the cloud job
# posts it as a GitHub issue on a public repo.
param(
  [string]$SoldProposalsDir = "C:\dev\oncallair-sales-data\sold-proposals",
  [int]$RepeatCustomerDays = 14,
  [string]$OutJson
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "commission-overrides.ps1")

function Iso($d) { $d.ToString("yyyy-MM-ddTHH:mm:sszzz") }

$entries = @(Get-ChildItem -Path (Join-Path $SoldProposalsDir "*.json") -ErrorAction SilentlyContinue |
  ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json } |
  Where-Object { $_.timestamps.accepted_at } |
  ForEach-Object {
    [pscustomobject]@{
      Proposal = [string]$_.proposal.id
      Consult  = [string]$_.consultation.code
      Customer = ("$($_.customer.first_name) $($_.customer.last_name)").Trim()
      CA       = [string]$_.assigned_consultant.first_name
      Label    = [string]$_.proposal.label
      Subtotal = [decimal]$_.proposal.subtotal
      Accepted = [datetime]$_.timestamps.accepted_at
    }
  })

# Same proposal accepted more than once -> information only; the latest wins.
$reaccepted = @($entries | Group-Object Proposal | Where-Object { $_.Count -gt 1 } | ForEach-Object {
    $versions = @($_.Group | Sort-Object Accepted)
    [ordered]@{
      proposal = $_.Name
      customer = $versions[-1].Customer
      ca       = $versions[-1].CA
      versions = @($versions | ForEach-Object { [ordered]@{ subtotal = $_.Subtotal; acceptedAt = (Iso $_.Accepted) } })
    }
  })

# What's live: latest acceptance per proposal, minus the hand-listed mistakes.
$live = @($entries | Group-Object Proposal | ForEach-Object { $_.Group | Sort-Object Accepted -Descending | Select-Object -First 1 } |
  Where-Object { -not $SUPERSEDED_PROPOSAL_IDS.ContainsKey($_.Proposal) })

function IsConfirmedSeparate($group) {
  @($group | Where-Object { -not $CONFIRMED_SEPARATE_PROPOSAL_IDS.ContainsKey($_.Proposal) }).Count -eq 0
}

function ProposalList($group) {
  @($group | Sort-Object Accepted | ForEach-Object {
      [ordered]@{ id = $_.Proposal; label = $_.Label; subtotal = $_.Subtotal; acceptedAt = (Iso $_.Accepted) }
    })
}

$flags = @()
$coveredProposals = @{}

# Rule 1: one consultation, more than one live proposal.
foreach ($g in ($live | Where-Object { $_.Consult } | Group-Object Consult | Where-Object { $_.Count -gt 1 })) {
  if (IsConfirmedSeparate $g.Group) { continue }
  $first = $g.Group | Sort-Object Accepted | Select-Object -First 1
  $flags += [ordered]@{
    rule      = "same-consultation"
    key       = $g.Name
    customer  = $first.Customer
    ca        = $first.CA
    title     = "Possible duplicate sale: $($first.Customer) ($($g.Name))"
    body      = "Two different OnCall Air proposals were accepted for the same consultation ($($g.Name)) for $($first.Customer). It may be one sale where an option was accepted by mistake and replaced -- or two real sales. Check OnCall Air, then tell Claude which one to count. (Amounts are in the Wednesday commission email, not here.)"
    proposals = ProposalList $g.Group
  }
  $g.Group | ForEach-Object { $coveredProposals[$_.Proposal] = $true }
}

# Rule 2: same customer, different consultations, close together.
foreach ($g in ($live | Where-Object { $_.Customer } | Group-Object { $_.Customer.ToLower() } | Where-Object { $_.Count -gt 1 })) {
  $items = @($g.Group | Sort-Object Accepted)
  if (@($items | Where-Object { -not $coveredProposals.ContainsKey($_.Proposal) }).Count -eq 0) { continue }
  if (@($items | Select-Object -ExpandProperty Consult -Unique).Count -lt 2) { continue }
  if (($items[-1].Accepted - $items[0].Accepted).TotalDays -gt $RepeatCustomerDays) { continue }
  if (IsConfirmedSeparate $items) { continue }
  $flags += [ordered]@{
    rule      = "same-customer"
    key       = $g.Name
    customer  = $items[0].Customer
    ca        = $items[0].CA
    title     = "Possible duplicate sale: $($items[0].Customer) (accepted twice)"
    body      = "$($items[0].Customer) has more than one OnCall Air proposal accepted within $RepeatCustomerDays days, on different consultations. It may be a repeat entry -- or two real sales. Check OnCall Air, then tell Claude which one to count. (Amounts are in the Wednesday commission email, not here.)"
    proposals = ProposalList $items
  }
}

$result = [ordered]@{
  generated_at = (Iso (Get-Date))
  flags        = $flags
  reaccepted   = $reaccepted
}

if ($OutJson) { $result | ConvertTo-Json -Depth 8 | Out-File -FilePath $OutJson -Encoding utf8 }

Write-Host "$($entries.Count) accepted payload(s); $($flags.Count) possible duplicate(s); $($reaccepted.Count) re-accepted proposal(s)."
foreach ($f in $flags) {
  Write-Host "FLAG  [$($f.rule)] $($f.customer) ($($f.ca))" -ForegroundColor Yellow
  foreach ($p in $f.proposals) { Write-Host "        #$($p.id) $($p.label) `$$($p.subtotal) accepted $($p.acceptedAt)" }
}
foreach ($r in $reaccepted) {
  Write-Host "note  $($r.customer): proposal $($r.proposal) accepted $($r.versions.Count)x -- latest counts"
}
