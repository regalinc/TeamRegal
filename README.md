# Housecall Pro Technician Dashboard

Pulls jobs and technicians from the [Housecall Pro Public API](https://docs.housecallpro.com/) hourly via GitHub Actions, and shows a live per-technician job dashboard as a static site on GitHub Pages.

## How it works

- `scripts/sync.js` — calls `GET /employees`, `GET /jobs`, and `GET /estimates`, groups jobs by assigned technician, and writes the result to `docs/data/*.json`. Includes each job's tags and `total_amount`/`outstanding_balance` (Housecall Pro reports these in cents; the dashboard converts to dollars). The synced `lead_source` comes from the **customer** record embedded in each job response (`job.customer.lead_source`), not the job's own `lead_source` field — Housecall Pro treats lead source as an attribute of the customer (set once, however they originally found the company), and the job-level field is typically unset. Canceled jobs (`user canceled`/`pro canceled`) are kept in the synced data — the Company Metrics page needs them to compute a cancellation rate — but `computeStats`/`computeScorecardStats` in `shared.js` exclude them from every other metric, so nothing else changes.
- `.github/workflows/sync.yml` — runs the sync script hourly (and on manual trigger), then commits any changed data files. The data file is several MB (more as the year goes on — see "Adjusting the data window" below), so consecutive bot-only syncs **amend and force-push over the previous data commit** rather than stacking a new commit each time — otherwise a frequent cadence would bloat the repo's git history within days. A real (human) commit always breaks the chain and gets a fresh data commit stacked after it, never amended. This means the data-commit history isn't preserved — only the latest sync is ever visible in `git log`, by design. Note: GitHub Actions' `schedule` trigger is best-effort and gets deprioritized under load — the cron runs at `:17` past the hour rather than `:00` specifically because `:00`/`:30` are documented as the most congested minutes (everyone else's cron fires there too); on `0 * * * *` actual runs were observed landing 2.5-11 hours apart despite the hourly setting. Moving off the hour mark should land much closer to hourly, but there's still no hard guarantee — check the Actions tab for actual run times if the dashboard's "Last synced" looks stale, and trigger manually if you need it fresher right away.
- `docs/` — static dashboard (plain HTML/CSS/JS, no build step) served by GitHub Pages, two pages sharing `shared.js` (data formatting, scorecard rendering, period math) plus a page-specific script each:
  - `index.html` / `app.js` — the **technician view**. A **Team summary** row (raw Total jobs/Total revenue/Average ticket/Completion rate) at the top, then a **scorecard per technician** with the underlying job list tucked behind a "N jobs in view" toggle rather than shown by default. Filter bar covers technician/job text search, a multi-select technician picker (with employee-tag quick-filter buttons), business unit, tag, status, and a reporting period.
  - `admin.html` / `admin.js` — the **department view** (linked from the technician view's header). Same scorecard layout, grouped by `business_unit` instead of by technician, with a company-wide summary row at top. See "Department (admin) view" below.

  Both pages poll `data/dashboard.json` every 60 seconds in the browser. **Scorecards on both pages use tag-based numbers, not raw job counts** — see `computeScorecardStats` in `shared.js`: "Jobs" only counts jobs tagged `Opportunity`, "Leads"/"Leads sold" use the `TGL`/`TGL Sold` tags, "RCC sold" uses `Membership Sold` (Housecall Pro's own membership-sales report isn't exposed via the public API), "IFO" and "Accessory sold" use their own like-named tags. The page-level summary rows are the one place raw totals (`computeStats`) still show, by design — that's the "how much actually happened" number, scorecards are "how the business tracks it."

  The **technician view** also has three estimate-based tiles per scorecard (`app.js`), computed from the synced `estimates` — see "Estimates" below.

**Period filter:** Today / This week / Last week / This month / Last month / Year to date scope the team summary *and* every technician's scorecard consistently — pick "This month" and both the top numbers and each person's tiles reflect only that month's jobs. Period boundaries are computed from each job's `schedule.scheduled_start` (there's no separate completion/invoice date synced yet), in the viewer's local time, with weeks starting Sunday. Only options the synced window can answer accurately are offered — see below. **Both pages default to "This month" on a fresh load** (no `?period=` in the URL) — pass `?period=` (empty) or another value explicitly to override, e.g. for a bookmarked screen that should show all synced time.

**Business unit vs. technician tags:** the "Business unit" filter uses Housecall Pro's native `job_fields.business_unit` field on each job (set under Settings → Business Units in Housecall Pro). Technicians also carry their own employee tags (shown as small chips on each card) — useful for role/specialty context, but those aren't currently a filter; business unit is the source of truth for department-style reporting since it's a structured field rather than free-text tags.

**Privacy note:** the dashboard data intentionally excludes customer phone/email and full street address (only city/state/zip), and technician contact info, since this repo is public. Revenue figures (total_amount, outstanding_balance) *are* included, by request — if that's no longer wanted, remove those fields in `toPublicJob` in `scripts/sync.js`. If you make the repo private (requires a paid GitHub plan for Pages), you can widen `toPublicJob`/`toPublicTechnician` to include more fields, like full addresses or contact info.

## One-time setup

1. **Create the API key** in Housecall Pro (requires the MAX plan): account settings → API keys. Copy it.
2. **Push this project** to your GitHub repo:
   ```
   git init
   git add .
   git commit -m "Initial Housecall Pro dashboard"
   git branch -M main
   git remote add origin <YOUR_REPO_URL>
   git push -u origin main
   ```
3. **Add the API key as a repo secret**: repo → Settings → Secrets and variables → Actions → New repository secret → name `HCP_API_KEY`, value = your key.
4. **Enable GitHub Pages**: repo → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/docs`.
5. **Run the sync once manually**: repo → Actions → "Sync Housecall Pro data" → Run workflow. This populates `docs/data/` for the first time.
6. Visit the Pages URL (shown in Settings → Pages once it's live, usually `https://<you>.github.io/<repo>/`).

After that, the workflow refreshes data hourly on its own — no machine or Claude session needs to be running.

## Local testing

```
$env:HCP_API_KEY="your_key_here"   # PowerShell
node scripts/sync.js
```

Then serve `docs/` with any static file server and open it in a browser — opening `index.html` directly via `file://` won't work because the dashboard fetches `data/dashboard.json` over HTTP. If you don't have Node/Python handy, `_serve.ps1` in this repo is a zero-dependency PowerShell static server:

```
powershell -ExecutionPolicy Bypass -File _serve.ps1
```

Then visit http://localhost:8743/index.html.

## Bookmarkable views (e.g. for an external screen/TV)

The dashboard reads its filter state from the URL on load, so a single link can be a fixed view for a lobby or shop-floor screen:

| Param | Effect | Example |
|---|---|---|
| `techs` | Show only these technicians (comma-separated names or ids; case-insensitive) | `?techs=Jack Tomlinson,Trevor McWilliams` |
| `bu` | Pre-select a business unit | `?bu=40 HVAC MAINT` |
| `tag` | Pre-select a job tag | `?tag=Opportunity` |
| `status` | Pre-select a status | `?status=in progress` |
| `period` | Pre-select a reporting period | `?period=month` (values: `today`, `week`, `lastweek`, `month`, `lastmonth`, `ytd`) |
| `q` | Pre-fill the text search | `?q=furnace` |

Params combine (e.g. `?techs=...&bu=...`). Spaces need URL-encoding (`%20` or `+`) if you're typing the link by hand — most browsers do this automatically when you paste a link with spaces into the address bar. When `techs` is set, the unassigned-jobs section and per-technician stats scope to just that roster; the viewer can still use the filter bar on top of it unless you don't want that (there's currently no way to hide the filter bar — ask if you want a `kiosk` mode that hides it for an unattended screen).

**Picking technicians from the UI:** the "All technicians" control in the filter bar is a searchable multi-select checklist (sorted alphabetically) — no need to hand-build a `techs=` URL. Selecting/deselecting technicians there updates the address bar's `techs` param live, so once you've picked the set you want, the current URL is already the bookmarkable link for that view.

## Department (admin) view

`admin.html` groups the same synced jobs by `job_fields.business_unit` instead of by technician, so management can see department-level totals (HVAC Service, Plumbing Installation, etc.) without individual technician names. It shares the filter bar (search/tag/status/period) and scorecard styling with the technician view, minus the business-unit filter itself (redundant — that's now the grouping) and the technician picker. Jobs with no business unit set land in a trailing "No business unit set" card rather than being dropped.

Each department has a **fixed color identity** (a top border + dot on its card) assigned by business-unit code, not by rank or filter state, so a department's color never changes as you filter — see `DEPT_COLOR_VARS` in `admin.js` and the `--series-*` custom properties in `style.css` (theme-aware, validated CVD-safe order). Every department renders as a full-width card in a vertical stack (not a multi-column grid) so each one gets the same prominent treatment.

**Cancelled calls** shows at two levels: a company-wide tile in the summary row (count + rate across the current filtered/period view), and a "Cancelled" mini-stat on every individual department card scoped to just that department's jobs. Both use `computeCancellationStats` in `shared.js` — the one place canceled jobs are counted rather than excluded from a stat.

**Lead source performance** groups jobs by the **customer's** `lead_source` (see `scripts/sync.js` above — distinct from business unit/technician) — **every job from that source counts, tagged or not**; a job also tagged for another tracked program (`Opportunity`, `TGL`, `IFO`, `Membership Sold`, `Accessory Sold`, ...) still originated from this lead source and belongs in its total. Sources with $0 revenue in view are dropped entirely — not useful to show — and jobs with no lead source land in an "Unknown source" bucket (muted gray, not a real category, same treatment as "No business unit set"). Ranked by revenue, the top 6 render as a **column chart** (`renderLeadSourceChart` in `admin.js`) with bar height proportional to revenue (a 6% minimum height keeps a small source visible as a color swatch rather than invisible) — lead source revenue is typically heavily skewed (one channel can outweigh another 1000:1), so equal-width/equal-height segments would misrepresent the relative sizes; a genuinely small source now reads as small. Each bar's name/count/$ label sits below it (never inside), in its own fixed-height zone independent of the bar, so a long wrapped label can never compress or distort the bar's height. Sources past the top 6 sit behind a "+N more lead sources" toggle, shown as a smaller multi-column card grid. Both cancellation-per-department and lead source performance are **Company Metrics (`admin.html`) only** — the technician view doesn't show them.

**This is not real access control.** The whole site is public with no login (same as the technician view), so `admin.html` is just a different, unadvertised-beyond-the-nav-link page — anyone with the URL can view it. If you actually need to restrict who can see it, the realistic path on this architecture is making the GitHub repo private and upgrading to a paid GitHub plan (Pro/Team/Enterprise) — GitHub Pages on a private repo then requires being a logged-in collaborator, which is real auth tied to GitHub identity rather than obscurity. Ask if you want that set up.

## Estimates

The technician view's scorecards (`app.js`) carry three tiles pulled from `GET /estimates` rather than jobs:

- **Estimates given** — count of estimates created within the selected period, assigned to that technician (`estimate.created_at`, same field Housecall Pro's own reporting uses).
- **Estimates approved** — of those same period-given estimates, how many are (currently) approved. This intentionally mirrors Housecall Pro's native reporting, including its known quirk: an estimate given last month but approved this month won't count as approved in either month's "Estimates approved" tile, because both tiles are scoped by *creation* date.
- **Approved this period** — the fix for that quirk. Counts estimates approved *within* the selected period regardless of when they were originally given, so an estimate created last month and approved this month correctly shows up this month.

**Estimator cards.** Any technician tagged `Estimator` (office staff who write estimates rather than do field work — `isEstimator`/`renderEstimatorCard` in `app.js`) gets an entirely different card instead of the standard one: the usual field-tech tiles (Jobs, Revenue, Leads, RCC sold, IFO, Accessory sold, ...) would all read zero for them, since those all derive from jobs they're never assigned to. Their card shows four tiles instead — Estimates given (creation-date scoped, as above), **Estimates approved**, **Closing %**, and **Revenue accepted**.

Unlike the regular scorecard's separate Estimates approved / Approved this period pair, an estimator's **Estimates approved** is a single number covering both at once (`computeEstimatorStats`/`unionById` in `app.js`): estimates given this period that are currently approved, plus estimates (given whenever) whose approval landed in this period — de-duplicated by id, so an estimate given *and* approved in the same period is never counted twice. Two people looking at "5 approved" and "2 approved this period" could otherwise reasonably read that as 7, 5, or 2 depending on whether they assumed overlap — collapsing it to one number removes that ambiguity. Closing % (this combined approved count ÷ Estimates given) and Revenue accepted (sum of `approved_amount`, see below, across that same combined set) are both derived from it too, so every number on the card is consistent with what "Estimates approved" actually counts — an estimate given last period but approved this one still lifts all three, crediting the estimator for closing older proposals rather than only ever measuring what they gave in the exact selected period; Closing % can exceed 100% in a period where more old proposals close than new ones are given. The expandable detail list shows that same combined set (date given, date approved if applicable, customer, and amount if approved), so every estimate contributing to a tile above is visible in the list below it.

`toPublicEstimate` (`scripts/sync.js`) also carries `estimate_number`, `customer_label` (first name + last initial, same minimal-PII convention as jobs), and `approved_amount` (cents — sum of the approved option(s)' `total_amount`, Housecall Pro's same cents-based money convention as jobs) to support this.

**How `approved_at` is actually determined.** Housecall Pro's API has no dedicated "approved at" field. The obvious stand-in — the approved option's own `updated_at` — turned out to be unreliable in practice: it bumps on *any* change to that option, including the resulting job's status progressing (scheduled → started → completed) long after the real approval decision, so an estimate approved in March could show an "approval date" from July just because its job wasn't finished until then. (A Housecall Pro webhook, `estimate.option.approval_status_changed`, does fire with an accurate timestamp the moment approval status actually changes — but consuming it would mean standing up a persistent server endpoint to receive it, a real piece of new infrastructure this otherwise fully static-site-plus-scheduled-polling project doesn't have. That remains the real fix if it's ever worth building.)

Instead, `sync.js` derives `approved_at` itself by diffing against the *previous* sync's `docs/data/estimates.json` (read back in via `loadPreviousEstimatesById` before that file gets overwritten): the first time a sync observes an estimate's `approved` flag flip from `false` to `true`, it stamps that estimate with *that sync run's own timestamp* — accurate to within one sync interval, which beats a field that can silently drift by months. An estimate that was *already* approved as of the previous sync just carries forward whatever `approved_at` that sync recorded.

The unavoidable gap: for an estimate that was already approved before this diffing approach shipped (or that first entered the sync window already approved), there's no prior observation to diff against, so `approved_at` is `null` — it drops out of every approval-date-scoped stat (Approved this period, Closing %, Revenue accepted on estimator cards) until Housecall Pro's approval status genuinely changes again. There's no way to retroactively recover a timestamp that was never observed.

"Approved" means an estimate has at least one option with `approval_status` of `approved` or `pro approved` (a pro manually marking it approved, e.g. after a phone call, counts the same as a customer clicking approve themselves).

**There's no `approved_at` field on an estimate.** The closest available signal is the approved option's own `updated_at`, used in `toPublicEstimate` (`scripts/sync.js`) as a best-effort proxy for when it was approved. This is usually accurate — `updated_at` bumps when the approval status changes — but could in principle be thrown off if an estimate is edited for an unrelated reason after approval, since that would also bump `updated_at` without a new approval happening. There's no better field available via the public API to avoid this.

**Estimates can't be fetched in date-chunks like jobs**, since the `/estimates` endpoint's only date filter is `scheduled_start`/`scheduled_end` (the on-site visit time — many estimates never have one). `fetchEstimatesInWindow` in `scripts/sync.js` instead fetches each `work_status` bucket (`unscheduled`, `scheduled`, `in_progress`, `completed`, `canceled`) separately, sorted newest-first, stopping each as soon as an estimate's `created_at` falls before the sync window — a partial mitigation against the same pagination drift that once silently dropped job records (see "Adjusting the data window" below), since no better one is available here.

## Adjusting the data window

`scripts/sync.js` fetches jobs from *at least* 62 days back through 13 days forward (`MIN_WINDOW_DAYS_BACK` / `WINDOW_DAYS_FORWARD`), plus however far back Jan 1 of the current year is — whichever is larger. The 62-day floor is so "This month" and "Last month" are always fully covered no matter what day of the current month it is (worst case: the last day of a 31-day month needs the full current month plus the full previous month behind it). The Jan-1 floor is what makes "Year to date" accurate; it's ~62 days in January and grows to ~365 by December, so the data file gradually grows over the year and resets smaller again each new January.

This doesn't bloat git history the way it might seem to — the sync commit is amended and force-pushed in place (see above), so the repo only ever carries one data commit's worth of history regardless of window size, just a bigger blob in that one commit as the year goes on.

**Going back further than the current year (e.g. multi-year trends or a rolling "Last quarter" that crosses years) isn't a small change.** That would mean either storing small periodic rollup summaries instead of full job detail for older data, or moving off git-committed JSON to a real database. Ask if you want that built out.
