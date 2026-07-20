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
  setSelectFromUrlParam(urlParams, periodFilter, "period");
}

function renderDeptCard(name, jobs) {
  const colorVar = deptColorVar(name);
  const headerHtml = `<div class="tech-name dept-name"><span class="dept-color-dot"></span>${escapeHtml(name)}</div>`;
  const card = renderScorecard({ headerHtml, jobs });
  card.classList.add("dept-card", "dept-full");
  card.style.setProperty("--dept-accent", `var(${colorVar})`);
  return card;
}

function render(data) {
  const filters = currentFilters();
  const filteredJobs = (data.jobs || []).filter((j) => jobMatchesFilters(j, filters));
  const periodJobs = filteredJobs.filter((j) => jobInPeriod(j, filters.period));

  renderStatsInto(statsEl, computeStats(periodJobs));

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
