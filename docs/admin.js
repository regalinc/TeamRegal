// Per-department (business unit) view. Same visual language and metric set
// as app.js's technician scorecards (see shared.js's computeScorecardStats),
// just grouped by job.business_unit instead of by assigned technician.

const app = document.getElementById("app");
const statsEl = document.getElementById("stats");
const searchInput = document.getElementById("search");
const tagFilter = document.getElementById("tag-filter");
const statusFilter = document.getElementById("status-filter");
const periodFilter = document.getElementById("period-filter");

const urlParams = new URLSearchParams(location.search);

let latestData = null;
let urlFiltersApplied = false;

const UNASSIGNED_BU_LABEL = "No business unit set";

// Fixed categorical color per department, keyed by its business-unit numeric
// code (the leading token, e.g. "10" in "10 HVAC AOR") so a department's
// color never changes as filters narrow which cards are visible — color
// follows the department's identity, not its rank on screen. Values are the
// CSS custom properties defined in style.css (theme-aware, already
// validated for CVD-safe contrast in that fixed order).
const DEPT_COLOR_VARS = {
  "10": "--series-blue",
  "30": "--series-green",
  "40": "--series-magenta",
  "50": "--series-yellow",
  "70": "--series-aqua",
  "80": "--series-orange",
};
const DEPT_COLOR_FALLBACK = "--series-violet"; // any department code not in the map above

function deptColorVar(name) {
  if (name === UNASSIGNED_BU_LABEL) return "--series-muted";
  const code = (name || "").trim().split(" ")[0];
  return DEPT_COLOR_VARS[code] || DEPT_COLOR_FALLBACK;
}

const UNKNOWN_LEAD_SOURCE_LABEL = "Unknown source";
const LEAD_SOURCE_FEATURED_COUNT = 6;
// Lead source values are open-ended (not a fixed known list like business
// units), so color is assigned by a stable hash of the name instead of a
// hardcoded map — the same source string always lands on the same color,
// without needing to know every possible source in advance.
const LEAD_SOURCE_COLOR_VARS = [
  "--series-blue",
  "--series-green",
  "--series-magenta",
  "--series-yellow",
  "--series-aqua",
  "--series-orange",
  "--series-violet",
];

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function leadSourceColorVar(name) {
  if (name === UNKNOWN_LEAD_SOURCE_LABEL) return "--series-muted";
  return LEAD_SOURCE_COLOR_VARS[hashString(name) % LEAD_SOURCE_COLOR_VARS.length];
}

function currentFilters() {
  return {
    text: searchInput.value.trim().toLowerCase(),
    tag: tagFilter.value,
    status: statusFilter.value,
    period: periodFilter.value,
  };
}

function jobMatchesFilters(job, filters) {
  if (filters.tag && !(job.tags || []).includes(filters.tag)) return false;
  if (filters.status && job.work_status !== filters.status) return false;

  if (filters.text) {
    const blob = [job.description, job.customer_label, job.city, job.state, job.business_unit, ...(job.tags || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!blob.includes(filters.text)) return false;
  }

  return true;
}

function populateFilterOptions(data) {
  const tags = new Set();
  const statuses = new Set();
  for (const job of data.jobs || []) {
    for (const t of job.tags || []) tags.add(t);
    if (job.work_status) statuses.add(job.work_status);
  }

  fillSelect(tagFilter, tags, "All job tags");
  fillSelect(statusFilter, statuses, "All statuses");
}

function applyUrlFiltersOnce() {
  if (urlFiltersApplied) return;
  urlFiltersApplied = true;

  const q = urlParams.get("q");
  if (q) searchInput.value = q;

  setSelectFromUrlParam(urlParams, tagFilter, "tag");
  setSelectFromUrlParam(urlParams, statusFilter, "status");
  applyDefaultPeriod(urlParams, periodFilter, "month");
}

function renderNamedCard(name, jobs, colorVar, { full = true, extraStats = [] } = {}) {
  const headerHtml = `<div class="tech-name dept-name"><span class="dept-color-dot"></span>${escapeHtml(name)}</div>`;
  const card = renderScorecard({ headerHtml, jobs, extraStats });
  card.classList.add("dept-card");
  if (full) card.classList.add("dept-full");
  card.style.setProperty("--dept-accent", `var(${colorVar})`);
  return card;
}

function renderDeptCard(name, jobs) {
  // Cancellation breakdown per department, alongside the company-wide total
  // in the summary row above — jobs here already includes canceled ones
  // (see render()), so this is scoped correctly without any extra filtering.
  const cancelStats = computeCancellationStats(jobs);
  const extraStats = [
    { label: "Cancelled", value: `${cancelStats.canceledCount.toLocaleString()} (${cancelStats.rate.toFixed(1)}%)` },
  ];
  return renderNamedCard(name, jobs, deptColorVar(name), { extraStats });
}

function render(data) {
  const filters = currentFilters();
  const filteredJobs = (data.jobs || []).filter((j) => jobMatchesFilters(j, filters));
  // Includes canceled jobs (jobMatchesFilters doesn't exclude them) — every
  // stat computation below filters them out itself except the cancellation
  // stat, which needs them to compute a rate.
  const periodJobs = filteredJobs.filter((j) => jobInPeriod(j, filters.period));

  renderStatsInto(statsEl, computeStats(periodJobs));
  const cancelStats = computeCancellationStats(periodJobs);
  statsEl.appendChild(
    renderStatTile({
      label: "Cancelled calls",
      value: `${cancelStats.canceledCount.toLocaleString()} (${cancelStats.rate.toFixed(1)}%)`,
      meterPct: cancelStats.rate,
    })
  );

  app.innerHTML = "";

  if (periodJobs.length === 0) {
    app.innerHTML = '<p class="empty">No jobs match the current filters.</p>';
    return;
  }

  const byDept = new Map();
  for (const job of periodJobs) {
    const key = job.business_unit || UNASSIGNED_BU_LABEL;
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(job);
  }

  const deptNames = [...byDept.keys()].sort((a, b) => {
    if (a === UNASSIGNED_BU_LABEL) return 1;
    if (b === UNASSIGNED_BU_LABEL) return -1;
    return a.localeCompare(b);
  });

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Department scorecards";
  app.appendChild(title);

  const stack = document.createElement("div");
  stack.className = "dept-stack";
  for (const name of deptNames) {
    stack.appendChild(renderDeptCard(name, byDept.get(name)));
  }
  app.appendChild(stack);

  renderLeadSourceSection(periodJobs);
}

function renderLeadSourceSection(periodJobs) {
  const byLeadSource = new Map();
  for (const job of periodJobs) {
    const key = job.lead_source || UNKNOWN_LEAD_SOURCE_LABEL;
    if (!byLeadSource.has(key)) byLeadSource.set(key, []);
    byLeadSource.get(key).push(job);
  }

  // Rank by revenue (computeStats already excludes canceled jobs) and drop
  // sources with $0 — a source nobody converted from isn't useful to show.
  const ranked = [...byLeadSource.entries()]
    .map(([name, jobs]) => ({ name, jobs, revenue: computeStats(jobs).totalRevenue }))
    .filter((entry) => entry.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);

  if (ranked.length === 0) return;

  const title = document.createElement("h2");
  title.className = "section-title";
  title.textContent = "Lead source performance";
  app.appendChild(title);

  const featured = ranked.slice(0, LEAD_SOURCE_FEATURED_COUNT);
  const overflow = ranked.slice(LEAD_SOURCE_FEATURED_COUNT);

  app.appendChild(renderLeadSourceBar(featured));

  if (overflow.length > 0) {
    const details = document.createElement("details");
    details.className = "tech-job-details";
    const summary = document.createElement("summary");
    summary.textContent = `+${overflow.length} more lead source${overflow.length === 1 ? "" : "s"}`;
    details.appendChild(summary);

    const grid = document.createElement("div");
    grid.className = "tech-grid";
    for (const entry of overflow) {
      grid.appendChild(renderNamedCard(entry.name, entry.jobs, leadSourceColorVar(entry.name), { full: false }));
    }
    details.appendChild(grid);
    app.appendChild(details);
  }
}

// A single horizontal bar split into equal-width segments, one per featured
// lead source, each showing its own name/count/$ value. Segments are equal
// width rather than sized by revenue share — lead source revenue is
// typically very skewed (one channel can outweigh another 1000:1), and a
// strictly proportional segment for the smaller ones would be too thin to
// hold a legible label. Equal width keeps all of them readable; the ranking
// (highest revenue first, left to right) still conveys relative importance.
function renderLeadSourceBar(entries) {
  const wrap = document.createElement("div");
  wrap.className = "lead-bar";
  for (const entry of entries) {
    const stats = computeStats(entry.jobs);
    const colorVar = leadSourceColorVar(entry.name);
    const seg = document.createElement("div");
    seg.className = "lead-bar-segment";
    seg.style.background = `var(${colorVar})`;
    seg.innerHTML = `
      <div class="lead-bar-name">${escapeHtml(entry.name)}</div>
      <div class="lead-bar-stat">${stats.totalJobs.toLocaleString()} job${stats.totalJobs === 1 ? "" : "s"} · ${formatMoney(stats.totalRevenue)}</div>
    `;
    wrap.appendChild(seg);
  }
  return wrap;
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestData = data;
    populateFilterOptions(data);
    applyUrlFiltersOnce();
    render(data);
    updateSyncStatus(data.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestData) {
      app.innerHTML = `<p class="empty">Could not load dashboard data yet. If this is a brand-new deployment, the sync workflow may not have run yet.</p>`;
    }
    console.error(err);
  }
}

function rerenderFromCache() {
  if (latestData) render(latestData);
}

searchInput.addEventListener("input", rerenderFromCache);
tagFilter.addEventListener("change", rerenderFromCache);
statusFilter.addEventListener("change", rerenderFromCache);
periodFilter.addEventListener("change", rerenderFromCache);

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
