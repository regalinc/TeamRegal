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
  // "Total jobs" only counts jobs that have actually started (in progress or
  // complete) — same NOT_YET_STARTED_STATUSES exclusion completion rate
  // already used below, now applied to the job count too, so a tech/BU with
  // a full week scheduled ahead doesn't look busier than one who's already
  // done the same amount of real work. Revenue/Avg ticket are untouched —
  // those still reflect every non-canceled job, same as always.
  const startedJobs = jobs.filter((j) => !NOT_YET_STARTED_STATUSES.has(j.work_status));
  const totalJobs = startedJobs.length;
  const totalRevenueCents = jobs.reduce((sum, j) => sum + (j.total_amount || 0), 0);
  const billedJobs = jobs.filter((j) => (j.total_amount || 0) > 0);
  const avgTicketCents = billedJobs.length ? totalRevenueCents / billedJobs.length : 0;
  const completedJobs = startedJobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = startedJobs.length ? (completedJobs.length / startedJobs.length) * 100 : 0;

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

function computeScorecardStats(allJobs, { splitRevenue = false } = {}) {
  const jobs = allJobs.filter((j) => !CANCELED_STATUSES.has(j.work_status));
  const totalRevenueCents = jobs.reduce((sum, j) => sum + jobRevenueCents(j, splitRevenue), 0);

  // "Jobs" only counts jobs that have actually started (in progress or
  // complete), same as completion rate's denominator below — a job merely
  // scheduled for later in the period hasn't happened yet, so it shouldn't
  // count toward Jobs (or, by extension, Avg ticket's denominator) any more
  // than it counts toward Completion. This is on top of the existing
  // tag-based countsTowardJobs filter, not a replacement for it.
  const countedJobs = jobs.filter((j) => countsTowardJobs(j) && !NOT_YET_STARTED_STATUSES.has(j.work_status));
  const totalJobs = countedJobs.length;
  const avgTicketCents = totalJobs ? totalRevenueCents / totalJobs : 0;

  const startedJobs = jobs.filter((j) => !NOT_YET_STARTED_STATUSES.has(j.work_status));
  const completedJobs = startedJobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = startedJobs.length ? (completedJobs.length / startedJobs.length) * 100 : 0;

  const leadJobs = jobs.filter((j) => hasTag(j, "TGL"));
  const leadsSoldJobs = leadJobs.filter((j) => hasTag(j, "TGL Sold"));

  const servicePlansSoldJobs = jobs.filter((j) => hasTag(j, "Membership Sold"));

  // Housecall Pro's tag is "IFO" and stays that way here (stats.ifo) since
  // it has to match the real tag on synced jobs — only the on-screen tile
  // label reads "$0 Call" instead (renderMiniStat/tvTile call sites).
  const ifoJobs = jobs.filter((j) => hasTag(j, "IFO"));

  const accessorySoldJobs = jobs.filter((j) => hasTag(j, "Accessory Sold"));

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

function jobInPeriod(job, period) {
  return dateInPeriod(job.schedule?.scheduled_start, period);
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
function renderScorecard({ headerHtml, tagsHtml, jobs, extraStats = [], splitRevenue = false, kpiBuCode = null }) {
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

  const stats = computeScorecardStats(jobs, { splitRevenue });
  const statsRow = document.createElement("div");
  statsRow.className = "tech-mini-stats";
  statsRow.innerHTML = [
    renderMiniStat("Jobs", stats.totalJobs.toLocaleString()),
    renderMiniStat(splitRevenue ? "Revenue (split)" : "Revenue", formatMoney(stats.totalRevenue)),
    renderMiniStat("Avg ticket", formatMoney(stats.avgTicket), kpiTier(kpiBuCode, "avgTicket", stats)),
    renderMiniStat("Completion", `${stats.completionRate.toFixed(0)}%`),
    renderMiniStat("Leads", stats.leads.toLocaleString(), kpiTier(kpiBuCode, "leads", stats)),
    renderMiniStat("Leads sold", stats.leadsSold.toLocaleString()),
    renderMiniStat("RCC sold", stats.servicePlansSold.toLocaleString()),
    renderMiniStat("$0 Call", stats.ifo.toLocaleString(), kpiTier(kpiBuCode, "ifo", stats)),
    renderMiniStat("Accessory sold", stats.accessorySold.toLocaleString(), kpiTier(kpiBuCode, "accessorySold", stats)),
    ...extraStats.map((s) => renderMiniStat(s.label, s.value)),
  ].join("");
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
