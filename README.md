# Housecall Pro Technician Dashboard

Pulls jobs and technicians from the [Housecall Pro Public API](https://docs.housecallpro.com/) every 15 minutes via GitHub Actions, and shows a live per-technician job dashboard as a static site on GitHub Pages.

## How it works

- `scripts/sync.js` — calls `GET /employees` and `GET /jobs`, filters out canceled jobs, groups jobs by assigned technician, and writes the result to `docs/data/*.json`.
- `.github/workflows/sync.yml` — runs the sync script every 15 minutes (and on manual trigger), then commits any changed data files.
- `docs/` — static dashboard (plain HTML/CSS/JS, no build step) served by GitHub Pages. Polls `data/dashboard.json` every 60 seconds in the browser.

**Privacy note:** the dashboard data intentionally excludes customer phone/email and full street address (only city/state/zip), and technician contact info, since this repo is public. If you make the repo private (requires a paid GitHub plan for Pages), you can widen `toPublicJob`/`toPublicTechnician` in `scripts/sync.js` to include more fields.

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

After that, the workflow refreshes data every 15 minutes on its own — no machine or Claude session needs to be running.

## Local testing

```
$env:HCP_API_KEY="your_key_here"   # PowerShell
node scripts/sync.js
```

Then open `docs/index.html` directly in a browser (or serve `docs/` with any static file server) to preview.

## Adjusting the data window

`scripts/sync.js` fetches jobs from 1 day back through 13 days forward (`WINDOW_DAYS_BACK` / `WINDOW_DAYS_FORWARD`). Change those constants if you want a shorter or longer look-ahead.
