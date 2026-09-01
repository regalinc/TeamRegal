// Shared between index.html (per-technician) and admin.html (per-department)
// — pure helpers and rendering pieces with no page-specific DOM assumptions
// beyond the #sync-status element both pages have in their header.

const DATA_URL = "data/dashboard.json";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 90 * 60_000; // flag sync status if data hasn't refreshed in 90 min (sync is hourly, plus buffer for GitHub's scheduling jitter)

// Housecall Pro's job money fields (total_amount, outstanding_balance) are in cents.
const CENTS_PER_DOLLAR = 100;

const COMPLETE_STATUSES = new Set(["complete rated", "complete unrated"]);

// Canceled jobs are synced (not dropped) so the Company Metrics page can
// report a cancellation rate, but every other metric below excludes them —
// same behavior as when the sync script dropped them entirely.
const CANCELED_STATUSES = new Set(["user canceled", "pro canceled"]);

// A job merely scheduled for later (or not yet scheduled at all) hasn't had
// any chance to be completed — counting it against completion rate makes a
// tech/department/BU look worse for having a full week ahead of them rather
// than for anything they've actually done. Completion rate's denominator
// excludes these; a job only enters the calculation once real work has
// begun (in progress or complete).
const NOT_YET_STARTED_STATUSES = new Set(["needs scheduling", "scheduled"]);

// A canceled estimate (customer called in and canceled before it was ever
// presented) shouldn't count as "given" anywhere — same idea as
// CANCELED_STATUSES for jobs above, just estimates' own work_status value
// (see ESTIMATE_WORK_STATUSES in sync.js) instead of jobs' string. Found via
// a real example: 5 canceled estimates were still counting as "given" on
// Andrew's card with no way to tell them apart from ones still open.
// Confirmed against real synced data: Housecall Pro's estimate work_status
// values are "user canceled"/"pro canceled" (matching jobs' exact
// CANCELED_STATUSES above), not the plain "canceled" ESTIMATE_WORK_STATUSES
// (sync.js) uses to *query* the API — a returned field can use different
// wording than the filter parameter that fetched it, apparently.
const CANCELED_ESTIMATE_STATUSES = new Set(["user canceled", "pro canceled"]);

function isCanceledEstimate(estimate) {
  return CANCELED_ESTIMATE_STATUSES.has(estimate.work_status);
}

const syncStatusEl = document.getElementById("sync-status");

function statusClass(status) {
  return "status-" + String(status || "").toLowerCase().replace(/\s+/g, "-");
}

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function jobTimeLabel(job) {
  const sched = job.schedule;
  if (!sched || !sched.scheduled_start) return "Unscheduled";
  const start = formatTime(sched.scheduled_start);
  const end = formatTime(sched.scheduled_end);
  return end ? `${start} – ${end}` : start;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
}

// Housecall Pro returns this same URL for every employee who hasn't
// uploaded a real photo — treat it as "no avatar" rather than showing
// everyone the same generic silhouette.
const HCP_PLACEHOLDER_AVATAR = "add_image_thumb_web_round.png";

function hasRealAvatar(tech) {
  return Boolean(tech.avatar_url) && !tech.avatar_url.includes(HCP_PLACEHOLDER_AVATAR);
}

// A handful of employees' Housecall Pro accounts don't have a resolvable
// "original" even after a fresh re-upload (confirmed by directly probing the
// CDN, re-checked hours later — not a one-off processing delay). Manual
// override maps a technician id straight to a locally-hosted high-res file
// (docs/assets/tech-photos/) so the TV kiosk isn't stuck upscaling their
// 40px Housecall Pro thumb. Keyed by id, not name, so a name change or
// duplicate name never accidentally mismatches. This is a standing
// workaround, not a permanent fix — remove an entry if Housecall Pro's own
// "original" ever becomes available for that person; nothing here checks
// that automatically.
const MANUAL_AVATAR_OVERRIDES = {
  "pro_7c54b30de89c4b6ea22a9053f0662f3d": "assets/tech-photos/juan-puello.jpg", // Juan Puello
  "pro_8fc589c75489437bb66ff45ca0aea7ac": "assets/tech-photos/aidan-shaull.jpg", // Aidan Shaull
  "pro_4a63b04bb5a64d97b8e1728dd8ea77fb": "assets/tech-photos/roger-renoll.jpg", // Roger Renoll
  "pro_0c24f7fb4b534fde920650a76dc8365f": "assets/tech-photos/hector-rivera.jpg", // Hector Rivera
  "pro_add4ba12688e47c696e827fb91a7d9fd": "assets/tech-photos/josh-miller.jpg", // Josh Miller
  "pro_1b87fcb406c9484b84e8fccd6f2c777b": "assets/tech-photos/benjamin-murphy.jpg", // Benjamin Murphy
  "pro_5c675ceab86d44cfbe75a1bfe6ecb25d": "assets/tech-photos/dakota-shelley.jpg", // Dakota Shelley
  "pro_8a84b31fc8b64893b17a0ca1bc133778": "assets/tech-photos/damien-cedrone.jpg", // Damien Cedrone
  "pro_ece63ff4afeb4b9fa5d9ee78be0c6e68": "assets/tech-photos/jacob-harvey.jpg", // Jacob Harvey
  "pro_048a0f2df6b2480aaa1a1ae03924fa9e": "assets/tech-photos/mark-zink.jpg", // Mark Zink
  "pro_8e95601ea8db4c5193be8f19fb319a44": "assets/tech-photos/pete-lalic.jpg", // Pete Lalic
  "pro_ca120cbb55fa40fe9361d492161b101f": "assets/tech-photos/andrew-rouscher.jpg", // Andrew Rouscher — his own largeAvatarUrl() 403s (see andrew.js), same gap as the rest of this list
};

// Apprentices — currently training/riding along with a real technician, not
// yet working (or being scored) independently. Two things follow from that:
// they don't get their own scorecard/TV row (departmentOf in tv.js and
// getRosterTechs in app.js both exclude them from the roster entirely), and
// they don't count toward a job's revenue split (jobRevenueCents below) — a
// 2-assignee job that's really "one tech plus a trainee" should split as if
// it were a 1-person job, not 50/50, since the apprentice isn't the one
// whose numbers that revenue is meant to represent. No dedicated Housecall
// Pro tag exists for this yet, so it's a manual id list, same pattern as
// MANUAL_AVATAR_OVERRIDES above — remove an entry once that person is no
// longer an apprentice.
const APPRENTICE_TECH_IDS = new Set([
  "pro_b5ab5cc9e362414cb376d0a02d64bef8", // Trevor McWilliams
  "pro_06aeac3b71a24c60a826c7e11499d8b5", // Jaylees Vazquez
]);

function isApprentice(tech) {
  return APPRENTICE_TECH_IDS.has(tech.id);
}

// HVAC Installation techs don't control their own job pipeline — work gets
// sold and handed to them, so an individual's Revenue/Jobs/Avg ticket mostly
// reflects what landed on their schedule, not their own performance. There's
// no meaningful individual number to show, so the whole roster rolls into
// one team card instead of individual scorecards — on the technician view
// (renderInstallationTeamCard, app.js) and the TV kiosk (tv.js) both, hence
// living here rather than in just one of those files. Scoped to their BU 10
// work specifically wherever it's used — the occasional job they pick up in
// another business unit (helping out when Installation's own queue is
// light) isn't really "their" work. This is the complete HVAC Installation
// roster as of writing — a new hire in that department needs adding here
// too, same as APPRENTICE_TECH_IDS/MANUAL_AVATAR_OVERRIDES above. Unlike
// apprentices, these are real techs — they stay selectable in the
// technician-view picker/quick-filters; only the per-tech card is skipped.
const INSTALLATION_TEAM_TECH_IDS = new Set([
  "pro_8a84b31fc8b64893b17a0ca1bc133778", // Damien Cedrone
  "pro_86c3193093ac454e801f62babb7cf494", // Jack Tomlinson
  "pro_eb9324081cb94741812e207380d65695", // Ryan Dubbs
  "pro_5c675ceab86d44cfbe75a1bfe6ecb25d", // Dakota Shelley
  "pro_c45a8b2541c64ac4b0f305364c5f5295", // Christian Glatfelter
  "pro_ece63ff4afeb4b9fa5d9ee78be0c6e68", // Jacob Harvey
  "pro_8e95601ea8db4c5193be8f19fb319a44", // Pete Lalic
  "pro_048a0f2df6b2480aaa1a1ae03924fa9e", // Mark Zink
  "pro_23fac61aafad4b4fa31992b5efaafae9", // Kevin Carter
]);
// Same tiles hidden wherever the team's numbers show — that department
// doesn't work off Leads (TGL)/RCC (Membership Sold)/$0 Call (IFO) tagging.
const INSTALLATION_TEAM_HIDDEN_TILES = new Set(["leads", "leadsSold", "rccSold", "ifo"]);

// Rodney Glatfelter manages the Installation team and occasionally takes an
// odd BU 10 job himself — that revenue should land in the team's total the
// same as everyone else's. He's office staff, not an installation tech
// though: he keeps his own individual scorecard elsewhere (deliberately NOT
// added to INSTALLATION_TEAM_TECH_IDS, which is what suppresses the
// individual card) and doesn't get a tile in the team photo strip
// (renderInstallationTeamPhotos, tv.js filters on INSTALLATION_TEAM_TECH_IDS
// directly, not this set). This set is for revenue/job-total attribution
// only — team card/screen job filters use this instead of
// INSTALLATION_TEAM_TECH_IDS so his jobs count without his face showing up.
const INSTALLATION_TEAM_MANAGER_ID = "pro_3f2297b66a9742d09eaf20976a20183a"; // Rodney Glatfelter
const INSTALLATION_TEAM_REVENUE_TECH_IDS = new Set([...INSTALLATION_TEAM_TECH_IDS, INSTALLATION_TEAM_MANAGER_ID]);

// Housecall Pro's avatar CDN stores an employee's photo at several sizes
// under sibling folders that share the same filename — the API only ever
// returns the "thumb_web_round" (40x40) one, but an "original" (full
// upload resolution, confirmed 1000px+ on the accounts checked) sits right
// next to it. The desktop dashboard's avatars are a genuinely fixed ~36px
// (style.css), so the native thumb is already the right resolution there and
// this swap isn't used. The TV kiosk is a different story even for its
// "small" row photos: everything on that page is sized in vw/vh specifically
// so it scales UP to fill whatever screen it's opened on (see tv.css), so a
// row photo that looks native-res in a browser tab renders well past 40px on
// a real TV and needs this same swap — not just the bigger featured photo.
// Not every employee has an "original" (older/re-synced accounts may only
// have the thumb, or see MANUAL_AVATAR_OVERRIDES above), so callers must
// fall back gracefully — see handleLargeAvatarError.
function largeAvatarUrl(tech) {
  if (MANUAL_AVATAR_OVERRIDES[tech.id]) return MANUAL_AVATAR_OVERRIDES[tech.id];
  const url = tech.avatar_url;
  if (!url || !url.includes("/thumb_web_round/")) return null;
  return url.replace("/thumb_web_round/", "/original/");
}

// <img onerror> handler for an avatar requested via largeAvatarUrl. First
// failure means this employee has no "original" variant — fall back to the
// known-good thumb URL stashed in data-thumb-src. A second failure (thumb
// itself 404s, or there's no photo at all) falls back to the colored-
// initials sibling element, same as renderAvatar's single-stage handler.
function handleLargeAvatarError(img) {
  if (img.dataset.fallbackStage !== "thumb" && img.dataset.thumbSrc) {
    img.dataset.fallbackStage = "thumb";
    img.src = img.dataset.thumbSrc;
    return;
  }
  img.style.display = "none";
  img.nextElementSibling.style.display = "flex";
}

// Renders the technician's real photo when Housecall Pro has one on file,
// falling back to the colored-initials avatar otherwise (including if the
// photo URL 404s at runtime).
function renderAvatar(tech) {
  const bg = tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : "";
  const initialsText = escapeHtml(initials(tech.name || "?"));
  const fallback = `<div class="avatar" style="background:${bg}">${initialsText}</div>`;
  if (!hasRealAvatar(tech)) return fallback;

  return `
    <img class="avatar" src="${escapeHtml(tech.avatar_url)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
    <div class="avatar" style="background:${bg};display:none">${initialsText}</div>
  `;
}

// Compact money formatting per the stat-tile contract: $1,284 / $12.9K / $4.2M
function formatMoney(dollars) {
  const abs = Math.abs(dollars);
  let out;
  if (abs >= 1_000_000) out = `$${(dollars / 1_000_000).toFixed(1)}M`;
  else if (abs >= 10_000) out = `$${(dollars / 1_000).toFixed(1)}K`;
  else out = `$${Math.round(dollars).toLocaleString()}`;
  return out;
}

function renderJobItem(job) {
  const li = document.createElement("li");
  li.className = "job-item";

  const location = [job.city, job.state].filter(Boolean).join(", ");

  li.innerHTML = `
    <div class="job-item-top">
      <span class="job-time">${jobTimeLabel(job)}</span>
      <span class="status-badge ${statusClass(job.work_status)}">${job.work_status || "unknown"}</span>
    </div>
    <div class="job-desc">${escapeHtml(job.description || "(no description)")}</div>
    <div class="job-sub">${escapeHtml([job.customer_label, location, job.business_unit].filter(Boolean).join(" · "))}</div>
    ${job.completed_at ? `<div class="job-completed">Completed ${formatDate(job.completed_at)}</div>` : ""}
  `;
  return li;
}

const KPI_MINI_CLASS = { good: "kpi-good", warn: "kpi-warn", bad: "kpi-bad" };

function renderMiniStat(label, value, tierResult) {
  const cls = tierResult ? KPI_MINI_CLASS[tierResult] : "";
  return `<div class="tech-mini-stat ${cls}"><div class="tech-mini-stat-label">${escapeHtml(label)}</div><div class="tech-mini-stat-value">${escapeHtml(value)}</div></div>`;
}

function renderStatTile({ label, value, meterPct }) {
  const tile = document.createElement("div");
  tile.className = "stat-tile";
  tile.innerHTML = `
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value">${escapeHtml(value)}</div>
    ${meterPct !== undefined ? `<div class="stat-meter-track"><div class="stat-meter-fill" style="width:${meterPct}%"></div></div>` : ""}
  `;
  return tile;
}

// Raw totals — used for the page-level summary row (Team/Company summary),
// as opposed to computeScorecardStats' tag-based numbers used on each card.
function computeStats(allJobs) {
  const jobs = allJobs.filter((j) => !CANCELED_STATUSES.has(j.work_status));
  const startedJobs = jobs.filter((j) => !NOT_YET_STARTED_STATUSES.has(j.work_status));
  const completedJobs = startedJobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = startedJobs.length ? (completedJobs.length / startedJobs.length) * 100 : 0;

  // Every total below — Jobs, Revenue, Avg ticket — only counts completed
  // work. A `scheduled` or `in progress` job's total_amount is very often a
  // pre-set quote for a visit that hasn't happened yet, not real revenue; on
  // the first day of a new month, with most of the month's work still
  // scheduled ahead, that inflated a BU/tech's numbers well past anything
  // actually done (confirmed: a $0-billed month showed thousands of dollars
  // from scheduled/in-progress jobs alone). Completion rate above is
  // unaffected — it's deliberately a ratio of started vs. completed, not a
  // "total."
  const totalJobs = completedJobs.length;
  const totalRevenueCents = completedJobs.reduce((sum, j) => sum + (j.total_amount || 0), 0);
  const billedJobs = completedJobs.filter((j) => (j.total_amount || 0) > 0);
  const avgTicketCents = billedJobs.length ? totalRevenueCents / billedJobs.length : 0;

  return {
    totalJobs,
    totalRevenue: totalRevenueCents / CENTS_PER_DOLLAR,
    avgTicket: avgTicketCents / CENTS_PER_DOLLAR,
    completionRate,
  };
}

// Unlike computeStats/computeScorecardStats, this looks AT the canceled jobs
// rather than excluding them — pass it the same raw (unfiltered-by-cancellation)
// job list used elsewhere so the rate is "canceled ÷ everything in view."
function computeCancellationStats(allJobs) {
  const canceledJobs = allJobs.filter((j) => CANCELED_STATUSES.has(j.work_status));
  const rate = allJobs.length ? (canceledJobs.length / allJobs.length) * 100 : 0;
  return { canceledCount: canceledJobs.length, totalCount: allJobs.length, rate };
}

function hasTag(job, tagName) {
  const target = tagName.toLowerCase();
  return (job.tags || []).some((t) => t.toLowerCase() === target);
}

// Every scorecard's numbers (technician or department) are pulled from tags
// rather than raw job counts, per how the business actually tracks these:
// - Jobs: only jobs tagged "Opportunity" count as a "true" job — except:
//   business unit 10 (HVAC AOR) counts only jobs tagged "Oncall Air" instead,
//   and business unit 50 (Plumbing AOR) counts every job, raw. Neither of
//   those departments is worked off the "Opportunity" tag, so filtering by
//   it would miscount them. See countsTowardJobs below.
// - Revenue: unchanged — still sums every job in view.
// - Avg ticket: total revenue (all jobs) divided by the Jobs count above,
//   not a separate billed-job count.
// - Completion: unchanged — still scoped to all jobs in view.
// - Leads / Leads sold: jobs tagged "TGL", and of those, ones also tagged
//   "TGL Sold".
// - RCC sold: jobs tagged "Membership Sold" — Housecall Pro's
//   membership/service-plan sales report isn't exposed via the public API,
//   so this tag is the stand-in the business tracks it with instead.
// - IFO: jobs tagged "IFO".
// - Accessory sold: jobs tagged "Accessory Sold".
const RAW_JOB_COUNT_BU_CODES = new Set(["50"]);

function businessUnitCode(businessUnit) {
  return (businessUnit || "").trim().split(" ")[0];
}

// Regal's KPI targets, keyed by business-unit code — the single source of
// truth shared by the TV kiosk (every screen), admin.html's department
// cards (always, since each card is already scoped to one BU), and
// index.html's technician cards (only when a single business unit is
// selected in the filter bar, since an unfiltered tech's jobs can span two
// BUs with different goals and there'd be no one goal to grade against).
// Three-tier grading per metric: "good" if the goal is met, "bad" if missed
// by more than `buffer` (15% by default), "warn" in between. `direction:
// "min"` is a floor (higher is better, e.g. Avg ticket); `direction: "max"`
// is a ceiling (lower is better, e.g. IFO) and the buffer band sits above
// the goal instead of below it. `buffer` can be overridden per metric when
// the amber band isn't the default 15% — see IFO below (green under 7.5%,
// amber 7.5-10%, a wider band than 15% of 7.5% would give).
function tier(value, { goal, direction, buffer = 0.15 }) {
  if (direction === "min") {
    if (value >= goal) return "good";
    return value >= goal * (1 - buffer) ? "warn" : "bad";
  }
  if (value < goal) return "good";
  return value < goal * (1 + buffer) ? "warn" : "bad";
}

// A tech/section with zero jobs in the period returns null (neutral) for
// every ratio-based KPI here rather than a misleading pass or fail on no
// data. Deliberately duplicated per BU even where two happen to match today
// (IFO/Accessory sold are currently identical across all four) — editing
// one BU's target should never silently change another's.
const KPI_THRESHOLDS_BY_BU = {
  30: {
    // Green under 7.5%, amber 7.5-10%, red past 10% — a wider amber band
    // than the default 15% buffer would give, so it's spelled out explicitly
    // (buffer: 1/3 makes goal*(1+buffer) land exactly on 10%).
    ifo: (stats) => (stats.totalJobs ? tier(stats.ifo / stats.totalJobs, { goal: 0.075, direction: "max", buffer: 1 / 3 }) : null),
    avgTicket: (stats) => (stats.totalJobs ? tier(stats.avgTicket, { goal: 450, direction: "min" }) : null),
    leads: (stats) => (stats.totalJobs ? tier(stats.leads / stats.totalJobs, { goal: 1 / 12, direction: "min" }) : null),
    accessorySold: (stats) => (stats.totalJobs ? tier(stats.accessorySold / stats.totalJobs, { goal: 1 / 8, direction: "min" }) : null),
  },
  40: {
    // Green under 7.5%, amber 7.5-10%, red past 10% — a wider amber band
    // than the default 15% buffer would give, so it's spelled out explicitly
    // (buffer: 1/3 makes goal*(1+buffer) land exactly on 10%).
    ifo: (stats) => (stats.totalJobs ? tier(stats.ifo / stats.totalJobs, { goal: 0.075, direction: "max", buffer: 1 / 3 }) : null),
    avgTicket: (stats) => (stats.totalJobs ? tier(stats.avgTicket, { goal: 250, direction: "min" }) : null),
    leads: (stats) => (stats.totalJobs ? tier(stats.leads / stats.totalJobs, { goal: 1 / 12, direction: "min" }) : null),
    accessorySold: (stats) => (stats.totalJobs ? tier(stats.accessorySold / stats.totalJobs, { goal: 1 / 8, direction: "min" }) : null),
  },
  // BU 70/80 (Plumbing Service): same IFO/Accessory sold bars as HVAC
  // Service, no Leads target given yet, and their own Avg ticket bars.
  70: {
    // Green under 7.5%, amber 7.5-10%, red past 10% — a wider amber band
    // than the default 15% buffer would give, so it's spelled out explicitly
    // (buffer: 1/3 makes goal*(1+buffer) land exactly on 10%).
    ifo: (stats) => (stats.totalJobs ? tier(stats.ifo / stats.totalJobs, { goal: 0.075, direction: "max", buffer: 1 / 3 }) : null),
    avgTicket: (stats) => (stats.totalJobs ? tier(stats.avgTicket, { goal: 500, direction: "min" }) : null),
    accessorySold: (stats) => (stats.totalJobs ? tier(stats.accessorySold / stats.totalJobs, { goal: 1 / 8, direction: "min" }) : null),
  },
  80: {
    // Green under 7.5%, amber 7.5-10%, red past 10% — a wider amber band
    // than the default 15% buffer would give, so it's spelled out explicitly
    // (buffer: 1/3 makes goal*(1+buffer) land exactly on 10%).
    ifo: (stats) => (stats.totalJobs ? tier(stats.ifo / stats.totalJobs, { goal: 0.075, direction: "max", buffer: 1 / 3 }) : null),
    avgTicket: (stats) => (stats.totalJobs ? tier(stats.avgTicket, { goal: 300, direction: "min" }) : null),
    accessorySold: (stats) => (stats.totalJobs ? tier(stats.accessorySold / stats.totalJobs, { goal: 1 / 8, direction: "min" }) : null),
  },
};

// Looks up the "good"/"warn"/"bad" tier for one metric under one BU's
// targets, or null if that BU has no targets defined (e.g. Office,
// installation, BU 10/50) or no target for that particular metric (e.g.
// Leads on BU 70/80). `buCode` accepts either a bare code ("30") or a full
// business_unit string ("30 HVAC SERVICE") — callers don't need to know
// which they have on hand.
function kpiTier(buCode, metricKey, stats) {
  const code = businessUnitCode(String(buCode || ""));
  const thresholds = KPI_THRESHOLDS_BY_BU[code];
  if (!thresholds) return null;
  const check = thresholds[metricKey];
  if (!check) return null;
  return check(stats);
}

function countsTowardJobs(job) {
  const code = businessUnitCode(job.business_unit);
  if (code === "10") return hasTag(job, "Oncall Air");
  if (RAW_JOB_COUNT_BU_CODES.has(code)) return true;
  return hasTag(job, "Opportunity");
}

// Housecall Pro splits a job's revenue evenly across however many
// technicians are on site for it (a $100 job splits $50/$50 for two techs,
// $33.33 each for three, ...) rather than crediting each one the full
// amount — so a technician's own revenue figure should reflect just their
// share of a shared job, not the whole thing. This only makes sense at the
// individual level: a job belongs to one department regardless of how many
// people worked it, so department cards and the page-level raw totals
// (computeStats) keep summing full job amounts — only computeScorecardStats
// takes a splitRevenue flag, passed by the technician view specifically.
function jobRevenueCents(job, splitRevenue) {
  const amount = job.total_amount || 0;
  if (!splitRevenue) return amount;
  // Apprentices don't count toward the split — a job with one real tech and
  // one apprentice splits as if it were a 1-person job (the real tech gets
  // full credit), not 50/50. See APPRENTICE_TECH_IDS above. Floors at 1 even
  // if every assignee happens to be an apprentice, to avoid a divide-by-zero;
  // that job won't be attributed to anyone's card anyway since apprentices
  // don't get one.
  const realAssignees = (job.assigned_employee_ids || []).filter((id) => !APPRENTICE_TECH_IDS.has(id));
  const assigneeCount = realAssignees.length || 1;
  return amount / assigneeCount;
}

function computeScorecardStats(allJobs, { splitRevenue = false, rawJobCount = false } = {}) {
  const jobs = allJobs.filter((j) => !CANCELED_STATUSES.has(j.work_status));

  const startedJobs = jobs.filter((j) => !NOT_YET_STARTED_STATUSES.has(j.work_status));
  const completedJobs = startedJobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = startedJobs.length ? (completedJobs.length / startedJobs.length) * 100 : 0;

  // Every total below — Jobs, Revenue, Avg ticket, Leads, Leads sold, RCC
  // sold, $0 Call, Accessory sold — only counts completed jobs, not
  // scheduled or in-progress ones. Two reasons, same root cause: a
  // scheduled/in-progress job's total_amount is often a pre-set quote for
  // work that hasn't happened yet (confirmed inflating a BU/tech's Revenue
  // by thousands of dollars on the first day of a new month, before almost
  // anything was actually done), and every one of these tags represents an
  // outcome decided during the visit itself (IFO, Accessory sold, a lead
  // converting) — not yet knowable for a job that hasn't happened yet
  // either. Completion rate above is unaffected — it's deliberately a ratio
  // of started vs. completed, not a "total."
  const totalRevenueCents = completedJobs.reduce((sum, j) => sum + jobRevenueCents(j, splitRevenue), 0);

  // rawJobCount skips the tag-based countsTowardJobs filter entirely — see
  // SIMPLIFIED_SCORECARD_TECH_IDS in app.js, currently the only caller that
  // passes it. A completed job still has to be a completed job either way
  // (that filter already ran above); this only changes whether a specific
  // tag is additionally required.
  const countedJobs = completedJobs.filter((j) => rawJobCount || countsTowardJobs(j));
  const totalJobs = countedJobs.length;
  const avgTicketCents = totalJobs ? totalRevenueCents / totalJobs : 0;

  const leadJobs = completedJobs.filter((j) => hasTag(j, "TGL"));
  const leadsSoldJobs = leadJobs.filter((j) => hasTag(j, "TGL Sold"));

  const servicePlansSoldJobs = completedJobs.filter((j) => hasTag(j, "Membership Sold"));

  // Housecall Pro's tag is "IFO" and stays that way here (stats.ifo) since
  // it has to match the real tag on synced jobs — only the on-screen tile
  // label reads "$0 Call" instead (renderMiniStat/tvTile call sites).
  const ifoJobs = completedJobs.filter((j) => hasTag(j, "IFO"));

  const accessorySoldJobs = completedJobs.filter((j) => hasTag(j, "Accessory Sold"));

  return {
    totalJobs,
    totalRevenue: totalRevenueCents / CENTS_PER_DOLLAR,
    avgTicket: avgTicketCents / CENTS_PER_DOLLAR,
    completionRate,
    leads: leadJobs.length,
    leadsSold: leadsSoldJobs.length,
    servicePlansSold: servicePlansSoldJobs.length,
    ifo: ifoJobs.length,
    accessorySold: accessorySoldJobs.length,
  };
}

// Technicians tagged "Estimator" (office staff who write estimates rather
// than do field work) get a different card entirely — the usual field-tech
// tiles (Jobs, Revenue, Leads, RCC sold, IFO, Accessory sold, ...) would all
// read zero for them, since those are all derived from jobs they were never
// assigned to. Lives in shared.js (not just app.js) since andrew.js — a
// dedicated page for one estimator — needs the exact same math, not a
// second implementation that could quietly drift from this one.
const ESTIMATOR_TAG = "Estimator";

function isEstimator(tech) {
  return (tech.tags || []).includes(ESTIMATOR_TAG);
}

// Estimates given normally counts by the estimate's created_at (record
// creation date) — but for Andrew (Andy) Rouscher specifically, created_at
// didn't match his actual calendar (a created_at-scoped count of 30 vs. 19
// scheduled site visits, both for the same date range), so his card scopes
// by the estimate's scheduled visit date instead. This is a narrow, id-
// scoped exception, not a change to the metric's default definition — every
// other estimator keeps using created_at. An estimate with no scheduled
// visit (phone/remote estimates don't have one) drops out of Andy's count
// entirely for a given period rather than falling back to created_at, since
// there's no visit to attribute to a period.
const SCHEDULE_SCOPED_ESTIMATOR_IDS = new Set([
  "pro_ca120cbb55fa40fe9361d492161b101f", // Andrew Rouscher
]);

function estimateGivenDate(estimate, tech) {
  if (!SCHEDULE_SCOPED_ESTIMATOR_IDS.has(tech.id)) return estimate.created_at;

  const scheduledStart = estimate.schedule?.scheduled_start;
  // No scheduled visit at all (phone/remote estimate) — falls back to
  // created_at instead of dropping out of every period. Previously returned
  // null here, which silently excluded these from "given" in any period at
  // all; found via a real ~$164K gap between this site's YTD revenue and
  // Housecall Pro's own report — every one of the missing estimates had no
  // scheduled_start, so they never counted as "given" anywhere, which also
  // made them invisible to "Estimates approved"/Revenue accepted since
  // those are built on top of "given." A visit that IS scheduled still
  // takes priority when present, per the comment below.
  if (!scheduledStart) return estimate.created_at;
  // A visit scheduled for later (e.g. "This month" includes the rest of the
  // month, not just up to today) hasn't happened yet — he hasn't had the
  // chance to present it, so it shouldn't count as "given" and drag down
  // Closing % as an unclosed estimate before its appointment even occurs.
  // It'll start counting once its scheduled date actually passes.
  if (new Date(scheduledStart) > new Date()) return null;
  return scheduledStart;
}

// De-dupes estimates (by id) that may appear in more than one of the given
// lists — used to combine "given this period" and "approved this period"
// into a single set without double-counting an estimate that's in both.
function unionById(...lists) {
  const seenIds = new Set();
  const combined = [];
  for (const list of lists) {
    for (const item of list) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      combined.push(item);
    }
  }
  return combined;
}

// Estimates given/approved use the estimate's created_at, same as Housecall
// Pro's own reporting — kept for that direct comparison. Approved stays a
// subset of "given," matching how the other paired scorecard metrics
// (Leads/Leads sold, etc.) work. Used for the three estimate tiles a
// non-estimator field tech's card also carries (extraStats in app.js).
function computeEstimateStats(estimatesGiven) {
  const approved = estimatesGiven.filter((e) => e.approved).length;
  return { given: estimatesGiven.length, approved };
}

// A "closed" period is one that's entirely over and can't gain new activity
// — lastweek/lastmonth are done, so an approval landing after the fact
// shouldn't retroactively move that period's own numbers every time someone
// checks back. today/week/month/ytd all include the present moment, so
// they stay "live" (see the union below). Confirmed real, not theoretical:
// an estimate given July 30 and approved August 4 was showing as "approved"
// in BOTH July's and August's totals — its $ amount double-counted across
// the two periods, and July's own "Approved"/Revenue would have kept
// creeping up indefinitely as more July-given estimates eventually closed,
// even though July itself was long over.
const CLOSED_PERIODS = new Set(["lastweek", "lastmonth"]);

// For an open (still-current) period, "Estimates approved" is a single
// number covering two different things — estimates given this period that
// are currently approved, plus estimates (given whenever) whose approval
// landed in this period — de-duplicated so an estimate given *and* approved
// in the same period isn't counted twice. That deliberately mixes scopes:
// an estimate given last period but approved this one still counts,
// crediting the estimator for closing older proposals rather than only
// ever measuring what they gave this exact period.
//
// For a closed period, that same carry-over logic is exactly what causes
// the double-count above — so "approved" there is scoped to
// approvedThisPeriodEstimates (approval actually landed in that period),
// regardless of when the estimate was given. An estimate given in a closed
// period but approved later (with a real approved_at) belongs entirely to
// whichever period it was actually approved in, not this one — it still
// shows up in the "given" count/list here, just not in "approved."
//
// One exception: a small number of estimates were already approved before
// sync.js started diffing approval status to derive approved_at (see the
// "Estimates" section of the README) — there's no way to recover a
// timestamp that was never observed, so approved_at is null for them
// forever, not just temporarily. dateInPeriod(null, ...) is false for
// every period, so approvedThisPeriodEstimates alone would make one of
// these silently vanish from every period's "Approved" count, even though
// it's genuinely closed. The only date on record for one is when it was
// given, so — closed-period only, and gated on approved_at truly being
// missing rather than "currently approved" in general — it's counted in
// whichever period it was given, the same way the old carry-over logic
// would have credited it. This can't reintroduce the double-count above:
// an estimate with a real approved_at (like the July 30/August 4 case)
// never enters this fallback at all.
const missingApprovedAtEstimates = (estimatesGiven) => estimatesGiven.filter((e) => e.approved && !e.approved_at);
//
// Closing %, Revenue accepted, and Avg ticket are all derived from
// whichever "approved" set applies, so every number on the card stays
// consistent with what "Estimates approved" actually counts. Avg ticket
// answers "how big is a typical deal once it closes" — revenue accepted
// divided by that same approved count, not by estimates given (most of
// which never close), so it isn't dragged down by pending estimates the
// way a naive revenue-over-given ratio would be.
function computeEstimatorStats(estimatesGiven, approvedThisPeriodEstimates, period) {
  const given = estimatesGiven.length;
  const approvedEstimates = CLOSED_PERIODS.has(period)
    ? unionById(approvedThisPeriodEstimates, missingApprovedAtEstimates(estimatesGiven))
    : unionById(estimatesGiven.filter((e) => e.approved), approvedThisPeriodEstimates);
  const approved = approvedEstimates.length;
  const closingRate = given ? (approved / given) * 100 : 0;
  const revenueCents = approvedEstimates.reduce((sum, e) => sum + (e.approved_amount || 0), 0);
  const revenue = revenueCents / CENTS_PER_DOLLAR;
  const avgTicket = approved ? revenue / approved : 0;
  return { given, approved, closingRate, revenue, avgTicket };
}

// Renders the 4-tile raw-totals row into any container element (the page's
// top-level summary).
function renderStatsInto(el, stats) {
  el.innerHTML = "";
  el.appendChild(renderStatTile({ label: "Total jobs", value: stats.totalJobs.toLocaleString() }));
  el.appendChild(renderStatTile({ label: "Total revenue", value: formatMoney(stats.totalRevenue) }));
  el.appendChild(renderStatTile({ label: "Average ticket", value: formatMoney(stats.avgTicket) }));
  el.appendChild(
    renderStatTile({
      label: "Completion rate",
      value: `${stats.completionRate.toFixed(0)}%`,
      meterPct: stats.completionRate,
    })
  );
}

// Period boundaries are computed in the viewer's local time, keyed off the
// job's scheduled_start (the only date field currently synced — not a
// completion/invoice date). Weeks start on Sunday. Bounds are [start, end).
function periodRange(period) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  const today = startOfDay(now);

  switch (period) {
    case "today":
      return [today, addDays(today, 1)];
    case "week": {
      const start = addDays(today, -today.getDay());
      return [start, addDays(start, 7)];
    }
    case "lastweek": {
      const start = addDays(today, -today.getDay() - 7);
      return [start, addDays(start, 7)];
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return [start, new Date(now.getFullYear(), now.getMonth() + 1, 1)];
    }
    case "lastmonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [start, new Date(now.getFullYear(), now.getMonth(), 1)];
    }
    case "ytd": {
      const start = new Date(now.getFullYear(), 0, 1);
      return [start, addDays(today, 1)];
    }
    default:
      return null;
  }
}

function dateInPeriod(isoString, period) {
  if (!period) return true;
  const range = periodRange(period);
  if (!range) return true;

  if (!isoString) return false;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return false;

  return d >= range[0] && d < range[1];
}

// A completed job is placed in whichever period it was actually FINISHED
// in, not whichever period it was originally scheduled for — a job booked
// in June but not actually completed until August (a reschedule, a delay,
// a multi-visit job that dragged on) should count toward August's numbers,
// not June's, since that's when the revenue was actually realized. This
// matches how Housecall Pro's own "completed this month" reports work —
// confirmed by reconciling a $15,966 gap between this dashboard's BU 10
// Installation-team revenue and HCP's own monthly report down to exactly
// one job that was scheduled in June but completed in August. A job that
// ISN'T complete yet (scheduled, in progress, canceled, needs scheduling)
// has no completed_at, so it still falls back to its scheduled date — that
// stays the only date those statuses have, and it's still the right one
// for showing e.g. an upcoming job under the week it's booked for.
function jobInPeriod(job, period) {
  const dateStr = COMPLETE_STATUSES.has(job.work_status) && job.completed_at ? job.completed_at : job.schedule?.scheduled_start;
  return dateInPeriod(dateStr, period);
}

function fillSelect(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = "";
  select.appendChild(new Option(allLabel, ""));
  for (const v of [...values].sort()) select.appendChild(new Option(v, v));
  if ([...values].includes(previous)) select.value = previous;
}

function setSelectFromUrlParam(urlParams, select, paramName) {
  const value = urlParams.get(paramName);
  if (value && [...select.options].some((o) => o.value === value)) select.value = value;
}

// Both pages default to "This month" on a fresh load, but an explicit
// "?period=" URL param (e.g. a bookmarked kiosk link asking for "All synced
// time") always wins.
function applyDefaultPeriod(urlParams, periodFilter, defaultValue) {
  if (urlParams.has("period")) setSelectFromUrlParam(urlParams, periodFilter, "period");
  else periodFilter.value = defaultValue;
}

function updateSyncStatus(meta) {
  if (!meta.last_synced_at) {
    syncStatusEl.textContent = "Not synced yet";
    syncStatusEl.classList.add("stale");
    return;
  }
  const syncedAt = new Date(meta.last_synced_at);
  const ageMs = Date.now() - syncedAt.getTime();
  const label = Number.isNaN(syncedAt.getTime())
    ? "Last synced: unknown"
    : `Last synced: ${syncedAt.toLocaleString()}`;
  syncStatusEl.textContent = label;
  syncStatusEl.classList.toggle("stale", ageMs > STALE_AFTER_MS);
}

// A scorecard: header line + tag-based mini stat tiles (computeScorecardStats
// — same metric set as computeStats' raw totals, but scoped to just this
// card's jobs), with the underlying job list tucked behind a native
// <details> toggle instead of shown by default. Used for both per-technician
// (index.html) and per-department (admin.html) cards so the numbers speak
// the same language at both altitudes.
function renderScorecard({
  headerHtml,
  tagsHtml,
  jobs,
  extraStats = [],
  splitRevenue = false,
  kpiBuCode = null,
  hiddenTiles = new Set(),
  rawJobCount = false,
}) {
  const card = document.createElement("div");
  card.className = "tech-card";

  if (headerHtml) {
    const header = document.createElement("div");
    header.className = "tech-card-header";
    header.innerHTML = headerHtml;
    card.appendChild(header);
  }

  if (tagsHtml) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "tech-tags";
    tagsRow.innerHTML = tagsHtml;
    card.appendChild(tagsRow);
  }

  const stats = computeScorecardStats(jobs, { splitRevenue, rawJobCount });
  // Keyed so a caller can omit specific tiles (hiddenTiles) for techs whose
  // department doesn't use that tag/workflow at all — see
  // SIMPLIFIED_SCORECARD_TECH_IDS in app.js. admin.html's department cards
  // never pass hiddenTiles, so this is a no-op there.
  const tiles = [
    { key: "jobs", html: renderMiniStat("Jobs", stats.totalJobs.toLocaleString()) },
    { key: "revenue", html: renderMiniStat(splitRevenue ? "Revenue (split)" : "Revenue", formatMoney(stats.totalRevenue)) },
    { key: "avgTicket", html: renderMiniStat("Avg ticket", formatMoney(stats.avgTicket), kpiTier(kpiBuCode, "avgTicket", stats)) },
    { key: "completion", html: renderMiniStat("Completion", `${stats.completionRate.toFixed(0)}%`) },
    { key: "leads", html: renderMiniStat("Leads", stats.leads.toLocaleString(), kpiTier(kpiBuCode, "leads", stats)) },
    { key: "leadsSold", html: renderMiniStat("Leads sold", stats.leadsSold.toLocaleString()) },
    { key: "rccSold", html: renderMiniStat("RCC sold", stats.servicePlansSold.toLocaleString()) },
    { key: "ifo", html: renderMiniStat("$0 Call", stats.ifo.toLocaleString(), kpiTier(kpiBuCode, "ifo", stats)) },
    { key: "accessorySold", html: renderMiniStat("Accessory sold", stats.accessorySold.toLocaleString(), kpiTier(kpiBuCode, "accessorySold", stats)) },
  ];
  const statsRow = document.createElement("div");
  statsRow.className = "tech-mini-stats";
  statsRow.innerHTML =
    tiles
      .filter((t) => !hiddenTiles.has(t.key))
      .map((t) => t.html)
      .join("") + extraStats.map((s) => renderMiniStat(s.label, s.value)).join("");
  card.appendChild(statsRow);

  const sortedJobs = [...jobs].sort((a, b) => {
    const at = a.schedule?.scheduled_start || "";
    const bt = b.schedule?.scheduled_start || "";
    return at.localeCompare(bt);
  });

  const details = document.createElement("details");
  details.className = "tech-job-details";
  const summary = document.createElement("summary");
  summary.textContent = `${sortedJobs.length} job${sortedJobs.length === 1 ? "" : "s"} in view`;
  details.appendChild(summary);

  if (sortedJobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-jobs";
    empty.textContent = "No jobs match the current filters.";
    details.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "job-list";
    for (const job of sortedJobs) list.appendChild(renderJobItem(job));
    details.appendChild(list);
  }
  card.appendChild(details);

  return card;
}
