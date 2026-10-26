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
