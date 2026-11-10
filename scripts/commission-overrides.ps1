# Hand-kept corrections to the OnCall Air sold-proposal data, shared by the
# commission scripts (update-commission-scorecard.ps1, generate-commission-
# report.ps1) and the duplicate check (find-duplicate-proposals.ps1) -- dot-
# source this file; it only defines variables.
#
# Why they're needed: OnCall Air fires a webhook each time a proposal is
# accepted, and the oncallair-sales-data repo only ever adds files. If an
# acceptance is later undone in OnCall Air, its file is still there.

# A proposal that was accepted BY MISTAKE and then un-accepted, with the
# customer accepting a DIFFERENT option instead. Excluded entirely. Key =
# proposal.id (as a string), value = why (for humans).
# (A proposal accepted TWICE, same id, is handled automatically by keeping the
# latest acceptance -- it doesn't belong here.)
$SUPERSEDED_PROPOSAL_IDS = @{
  '5914400' = 'Kara Tate -- PLATINUM 7620 dollars accepted 2026-10-23 6:18 AM in error; un-accepted, customer re-accepted BRONZE 5914273 (13771 dollars) at 7:48 AM (confirmed by Michael 2026-10-26)'
}

# Proposals that look like a duplicate (same consultation, or same customer
# within two weeks) but are genuinely SEPARATE sales -- e.g. two systems sold
# to one customer. Listing every proposal id of the group silences the
# find-duplicate-proposals.ps1 warning for it. Key = proposal.id, value = why.
$CONFIRMED_SEPARATE_PROPOSAL_IDS = @{
}

# Pay weeks that are NOT the normal Wednesday-Tuesday. A pay week is Wed-Tue
# unless a date falls inside one of these (Start/End are both inclusive dates).
# Used by every commission script via PayWeekFor below, so the scorecard, the
# payroll report and the email draft always agree on where a week begins/ends.
#
# Veterans Day (Wed 2026-11-11) -- payroll for the Nov 4 week was run EARLY, on
# Tue 11/10, so that week is closed at Mon 11/9 and the next week starts on
# 11/10 and runs a day long (8 days, through Tue 11/17). Normal Wed-Tue weeks
# resume Wed 11/18. Requested by Michael 2026-11-10. Nothing was accepted on
# 11/10 when the Nov 4 week was paid, so no sale is paid twice.
#   Paid = $true  -> already paid; the scheduled Wednesday draft skips it rather
#                    than building a second email for it.
#   Note          -> shown as a line in the email draft for that week.
$PAY_WEEK_OVERRIDES = @(
  @{ Start = "2026-11-04"; End = "2026-11-09"; Paid = $true;  Note = "" }
  @{ Start = "2026-11-10"; End = "2026-11-17"; Paid = $false; Note = "This is an 8-day pay week (Tuesday 11/10 - Tuesday 11/17) because last week's payroll was run a day early for Veterans Day. Normal Wednesday-Tuesday weeks resume Wednesday 11/18." }
)

# The pay week a date falls in: @{ Start; End; Paid; Note } (dates, End inclusive).
function PayWeekFor([datetime]$date) {
  $d = $date.Date
  foreach ($o in $PAY_WEEK_OVERRIDES) {
    if ($d -ge [datetime]$o.Start -and $d -le [datetime]$o.End) {
      return @{ Start = [datetime]$o.Start; End = [datetime]$o.End; Paid = [bool]$o.Paid; Note = [string]$o.Note }
    }
  }
  $daysSinceWednesday = (([int]$d.DayOfWeek) - [int][DayOfWeek]::Wednesday + 7) % 7
  $start = $d.AddDays(-$daysSinceWednesday)
  return @{ Start = $start; End = $start.AddDays(6); Paid = $false; Note = "" }
}

# The most recent pay week that is completely over as of $today.
function LastCompletedPayWeek([datetime]$today) {
  $cur = PayWeekFor $today
  return (PayWeekFor $cur.Start.AddDays(-1))
}
