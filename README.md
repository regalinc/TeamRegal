# Housecall Pro Technician Dashboard

Pulls jobs and technicians from the [Housecall Pro Public API](https://docs.housecallpro.com/) hourly via GitHub Actions, and shows a live per-technician job dashboard as a static site on GitHub Pages.

## How it works

- `scripts/sync.js` — calls `GET /employees` and `GET /jobs`, filters out canceled jobs, groups jobs by assigned technician, and writes the result to `docs/data/*.json`. Includes each job's tags and `total_amount`/`outstanding_balance` (Housecall Pro reports these in cents; the dashboard converts to dollars).
- `.github/workflows/sync.yml` — runs the sync script hourly (and on manual trigger), then commits any changed data files. The data file is several MB (more as the year goes on — see "Adjusting the data window" below), so consecutive bot-only syncs **amend and force-push over the previous data commit** rather than stacking a new commit each time — otherwise a frequent cadence would bloat the repo's git history within days. A real (human) commit always breaks the chain and gets a fresh data commit stacked after it, never amended. This means the data-commit history isn't preserved — only the latest sync is ever visible in `git log`, by design. Note: GitHub Actions' `schedule` trigger is best-effort and gets deprioritized under load, so even an hourly cron can land later than expected — check the Actions tab for actual run times if the dashboard's "Last synced" looks stale.
- `docs/` — static dashboard (plain HTML/CSS/JS, no build step) served by GitHub Pages. Polls `data/dashboard.json` every 60 seconds in the browser. It's a reporting view: a **Team summary** row (Total jobs, Total revenue, Average ticket, Completion rate) at the top, then a **Technician scorecard** per person — same 4 metrics, scoped to just their jobs — with the underlying job list tucked behind a "N jobs in view" toggle rather than shown by default. Filter bar covers technician/job text search, a multi-select technician picker, business unit, tag, status, and a reporting period (all auto-detected from your data except the period options, which are fixed).

**Period filter:** Today / This week / Last week / This month / Last month / Year to date scope the team summary *and* every technician's scorecard consistently — pick "This month" and both the top numbers and each person's tiles reflect only that month's jobs. Period boundaries are computed from each job's `schedule.scheduled_start` (there's no separate completion/invoice date synced yet), in the viewer's local time, with weeks starting Sunday. Only options the synced window can answer accurately are offered — see below.

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

## Adjusting the data window

`scripts/sync.js` fetches jobs from *at least* 62 days back through 13 days forward (`MIN_WINDOW_DAYS_BACK` / `WINDOW_DAYS_FORWARD`), plus however far back Jan 1 of the current year is — whichever is larger. The 62-day floor is so "This month" and "Last month" are always fully covered no matter what day of the current month it is (worst case: the last day of a 31-day month needs the full current month plus the full previous month behind it). The Jan-1 floor is what makes "Year to date" accurate; it's ~62 days in January and grows to ~365 by December, so the data file gradually grows over the year and resets smaller again each new January.

This doesn't bloat git history the way it might seem to — the sync commit is amended and force-pushed in place (see above), so the repo only ever carries one data commit's worth of history regardless of window size, just a bigger blob in that one commit as the year goes on.

**Going back further than the current year (e.g. multi-year trends or a rolling "Last quarter" that crosses years) isn't a small change.** That would mean either storing small periodic rollup summaries instead of full job detail for older data, or moving off git-committed JSON to a real database. Ask if you want that built out.
