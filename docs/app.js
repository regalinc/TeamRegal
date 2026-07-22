// Per-technician view. Shared helpers (formatMoney, computeStats,
// computeScorecardStats, scorecard rendering, period filtering, avatars,
// etc.) live in shared.js, loaded before this.

const app = document.getElementById("app");
const statsEl = document.getElementById("stats");
const searchInput = document.getElementById("search");
const businessUnitFilter = document.getElementById("business-unit-filter");
const tagFilter = document.getElementById("tag-filter");
const statusFilter = document.getElementById("status-filter");
const periodFilter = document.getElementById("period-filter");

const techSelectEl = document.getElementById("tech-select");
const techSelectToggle = document.getElementById("tech-select-toggle");
const techSelectPanel = document.getElementById("tech-select-panel");
const techSelectSearch = document.getElementById("tech-select-search");
const techSelectAllBtn = document.getElementById("tech-select-all");
const techSelectClearBtn = document.getElementById("tech-select-clear");
const techSelectList = document.getElementById("tech-select-list");
const techSelectCategories = document.getElementById("tech-select-categories");

// Lets a screen be a single bookmarkable link, e.g.
// ?bu=HVAC or ?techs=Jack%20Tomlinson,Trevor%20McWilliams
const urlParams = new URLSearchParams(location.search);
const INITIAL_ROSTER_NEEDLES = (urlParams.get("techs") || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// The technician multi-select: empty set = "all technicians". Selecting via
// the dropdown keeps the URL's `techs` param in sync (technician ids) so the
// resulting view stays a bookmarkable link, same as setting `?techs=` by hand.
const selectedTechIds = new Set();

let latestData = null;
let urlFiltersApplied = false;

function renderTechCard(tech, jobs, extraStats) {
  const headerHtml = `
    ${renderAvatar(tech)}
    <div>
      <div class="tech-name">${escapeHtml(tech.name || "Unknown")}</div>
      ${tech.role ? `<div class="tech-role">${escapeHtml(tech.role)}</div>` : ""}
    </div>
  `;
  const tagsHtml =
    tech.tags && tech.tags.length > 0 ? tech.tags.map((t) => `<span class="tech-tag-chip">${escapeHtml(t)}</span>`).join("") : "";

  return renderScorecard({ headerHtml, tagsHtml, jobs, extraStats });
}

// Estimates given/approved use the estimate's created_at, same as
// Housecall Pro's own reporting — kept for that direct comparison. Approved
// stays a subset of "given," matching how the other paired scorecard
// metrics (Leads/Leads sold, etc.) work.
function computeEstimateStats(estimatesGiven) {
  const approved = estimatesGiven.filter((e) => e.approved).length;
  return { given: estimatesGiven.length, approved };
}

function currentFilters() {
  return {
    text: searchInput.value.trim().toLowerCase(),
    businessUnit: businessUnitFilter.value,
    tag: tagFilter.value,
    status: statusFilter.value,
    period: periodFilter.value,
  };
}

function jobMatchesFilters(job, filters, techById) {
  if (filters.businessUnit && job.business_unit !== filters.businessUnit) return false;
  if (filters.tag && !(job.tags || []).includes(filters.tag)) return false;
  if (filters.status && job.work_status !== filters.status) return false;

  if (filters.text) {
    const techNames = (job.assigned_employee_ids || [])
      .map((id) => techById.get(id)?.name)
      .filter(Boolean)
      .join(" ");
    const blob = [job.description, job.customer_label, job.city, job.state, job.business_unit, ...(job.tags || []), techNames]
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
  const businessUnits = new Set();
  for (const job of data.jobs || []) {
    for (const t of job.tags || []) tags.add(t);
    if (job.work_status) statuses.add(job.work_status);
    if (job.business_unit) businessUnits.add(job.business_unit);
  }

  fillSelect(businessUnitFilter, businessUnits, "All business units");
  fillSelect(tagFilter, tags, "All job tags");
  fillSelect(statusFilter, statuses, "All statuses");
}

// The technician roster: empty selection = everyone. Otherwise only
// technicians whose id is in selectedTechIds.
function getRosterTechs(technicians) {
  if (selectedTechIds.size === 0) return technicians;
  return technicians.filter((t) => selectedTechIds.has(t.id));
}

function applyUrlFiltersOnce(data) {
  if (urlFiltersApplied) return;
  urlFiltersApplied = true;

  const q = urlParams.get("q");
  if (q) searchInput.value = q;

  setSelectFromUrlParam(urlParams, businessUnitFilter, "bu");
  setSelectFromUrlParam(urlParams, tagFilter, "tag");
  setSelectFromUrlParam(urlParams, statusFilter, "status");
  applyDefaultPeriod(urlParams, periodFilter, "month");

  // Resolve the initial "?techs=" needles (names or ids) against the real
  // technician list now that it's loaded, seeding the multi-select.
  if (INITIAL_ROSTER_NEEDLES.length > 0) {
    for (const tech of data.technicians || []) {
      if (INITIAL_ROSTER_NEEDLES.includes((tech.id || "").toLowerCase()) || INITIAL_ROSTER_NEEDLES.includes((tech.name || "").toLowerCase())) {
        selectedTechIds.add(tech.id);
      }
    }
  }
}

function updateTechsUrlParam() {
  const url = new URL(location.href);
  if (selectedTechIds.size === 0) url.searchParams.delete("techs");
  else url.searchParams.set("techs", [...selectedTechIds].join(","));
  history.replaceState(null, "", url);
}

function updateTechSelectToggleLabel(technicians) {
  if (selectedTechIds.size === 0) {
    techSelectToggle.textContent = "All technicians";
  } else if (selectedTechIds.size === 1) {
    const tech = technicians.find((t) => selectedTechIds.has(t.id));
    techSelectToggle.textContent = tech ? tech.name : "1 technician";
  } else {
    techSelectToggle.textContent = `${selectedTechIds.size} technicians selected`;
  }
  syncCategoryButtonsActiveState(technicians);
}

// Highlights a category button when the current selection exactly matches
// every technician carrying that employee tag (so the button reflects
// reality whether it got there via the button itself or manual checkboxes).
function syncCategoryButtonsActiveState(technicians) {
  for (const btn of techSelectCategories.querySelectorAll(".tech-category-btn")) {
    const matchingIds = technicians.filter((t) => (t.tags || []).includes(btn.dataset.tag)).map((t) => t.id);
    const isActive =
      matchingIds.length > 0 &&
      matchingIds.length === selectedTechIds.size &&
      matchingIds.every((id) => selectedTechIds.has(id));
    btn.classList.toggle("active", isActive);
  }
}

// Clicking a category button selects exactly the technicians carrying that
// employee tag, replacing any prior selection. Clicking an already-active
// category again clears back to "All technicians".
function applyCategoryFilter(tag) {
  const technicians = latestData?.technicians || [];
  selectedTechIds.clear();
  for (const tech of technicians) {
    if ((tech.tags || []).includes(tag)) selectedTechIds.add(tech.id);
  }
  for (const row of techSelectList.querySelectorAll(".tech-select-row")) {
    const checkbox = row.querySelector("input");
    checkbox.checked = selectedTechIds.has(checkbox.value);
  }
  updateTechSelectToggleLabel(technicians);
  updateTechsUrlParam();
  rerenderFromCache();
}

function populateTechDropdown(data) {
  const technicians = [...(data.technicians || [])].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  techSelectList.innerHTML = "";
  if (technicians.length === 0) {
    techSelectList.innerHTML = '<div class="tech-select-empty">No technicians found.</div>';
  } else {
    for (const tech of technicians) {
      const label = document.createElement("label");
      label.className = "tech-select-row";
      label.dataset.name = (tech.name || "").toLowerCase();
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(tech.id)}" ${selectedTechIds.has(tech.id) ? "checked" : ""}/> <span>${escapeHtml(tech.name || "Unknown")}</span>`;
      techSelectList.appendChild(label);
    }
  }

  updateTechSelectToggleLabel(technicians);
}

function onTechCheckboxChange(e) {
  if (e.target.tagName !== "INPUT") return;
  if (e.target.checked) selectedTechIds.add(e.target.value);
  else selectedTechIds.delete(e.target.value);
  updateTechSelectToggleLabel(latestData?.technicians || []);
  updateTechsUrlParam();
  rerenderFromCache();
}

function applyTechSearchFilter() {
  const q = techSelectSearch.value.trim().toLowerCase();
  for (const row of techSelectList.querySelectorAll(".tech-select-row")) {
    row.classList.toggle("hidden-by-search", q.length > 0 && !row.dataset.name.includes(q));
  }
}

function render(data) {
  const techById = new Map((data.technicians || []).map((t) => [t.id, t]));
  const filters = currentFilters();
  const filteredJobs = (data.jobs || []).filter((j) => jobMatchesFilters(j, filters, techById));

  const rosterTechs = getRosterTechs(data.technicians || []).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const rosterActive = selectedTechIds.size > 0;
  const rosterTechIds = new Set(rosterTechs.map((t) => t.id));

  // The period filter now scopes everything on the page consistently — the
  // team summary, every technician's scorecard, and the unassigned-jobs
  // list — since this is a reporting view, not a live per-job schedule.
  const periodJobs = filteredJobs.filter((j) => jobInPeriod(j, filters.period));

  // Estimates given/approved (creation-date scoped, like Housecall Pro's
  // own reporting) vs. approved-this-period (approval-date scoped) are two
  // different slices of the same data — see computeEstimateStats and the
  // "Approved this period" tile below. Neither is filtered by the
  // job-specific filters above (tag/status/business unit/search); only by
  // period and technician.
  const allEstimates = data.estimates || [];
  const periodEstimates = allEstimates.filter((e) => dateInPeriod(e.created_at, filters.period));
  const approvedThisPeriod = allEstimates.filter((e) => e.approved && dateInPeriod(e.approved_at, filters.period));

  // The team summary scopes to just the selected roster's jobs when one is
  // set (unassigned jobs belong to no technician, so they drop out too).
  let statsJobs = periodJobs;
  if (rosterActive) {
    statsJobs = statsJobs.filter((j) => (j.assigned_employee_ids || []).some((id) => rosterTechIds.has(id)));
  }

  renderStatsInto(statsEl, computeStats(statsJobs));

  app.innerHTML = "";

  if (!data.technicians || data.technicians.length === 0) {
    app.innerHTML = '<p class="empty">No technicians found.</p>';
    return;
  }

  if (rosterActive && rosterTechs.length === 0) {
    app.innerHTML = '<p class="empty">No technicians match the current selection.</p>';
    return;
  }

  const scorecardsTitle = document.createElement("h2");
  scorecardsTitle.className = "section-title";
  scorecardsTitle.textContent = "Technician scorecards";
  app.appendChild(scorecardsTitle);

  const grid = document.createElement("div");
  grid.className = "tech-grid";
  for (const tech of rosterTechs) {
    const jobs = periodJobs.filter((j) => (j.assigned_employee_ids || []).includes(tech.id));

    const techEstimatesGiven = periodEstimates.filter((e) => (e.assigned_employee_ids || []).includes(tech.id));
    const estimateStats = computeEstimateStats(techEstimatesGiven);
    const techApprovedThisPeriod = approvedThisPeriod.filter((e) => (e.assigned_employee_ids || []).includes(tech.id)).length;
    const extraStats = [
      { label: "Estimates given", value: estimateStats.given.toLocaleString() },
      { label: "Estimates approved", value: estimateStats.approved.toLocaleString() },
      { label: "Approved this period", value: techApprovedThisPeriod.toLocaleString() },
    ];

    grid.appendChild(renderTechCard(tech, jobs, extraStats));
  }
  app.appendChild(grid);

  if (!rosterActive) {
    const unassignedJobs = periodJobs.filter((j) => (j.assigned_employee_ids || []).length === 0);
    if (unassignedJobs.length > 0) {
      const title = document.createElement("h2");
      title.className = "section-title";
      title.textContent = `Unassigned jobs (${unassignedJobs.length})`;
      app.appendChild(title);

      const list = document.createElement("ul");
      list.className = "job-list";
      for (const job of unassignedJobs) list.appendChild(renderJobItem(job));
      app.appendChild(list);
    }
  }
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestData = data;
    populateFilterOptions(data);
    applyUrlFiltersOnce(data);
    populateTechDropdown(data);
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
businessUnitFilter.addEventListener("change", rerenderFromCache);
tagFilter.addEventListener("change", rerenderFromCache);
statusFilter.addEventListener("change", rerenderFromCache);
periodFilter.addEventListener("change", rerenderFromCache);

techSelectToggle.addEventListener("click", () => {
  techSelectPanel.hidden = !techSelectPanel.hidden;
  if (!techSelectPanel.hidden) techSelectSearch.focus();
});
document.addEventListener("click", (e) => {
  if (!techSelectEl.contains(e.target)) techSelectPanel.hidden = true;
});
techSelectList.addEventListener("change", onTechCheckboxChange);
techSelectSearch.addEventListener("input", applyTechSearchFilter);
techSelectCategories.addEventListener("click", (e) => {
  const btn = e.target.closest(".tech-category-btn");
  if (!btn) return;
  applyCategoryFilter(btn.classList.contains("active") ? "__none__" : btn.dataset.tag);
});
techSelectAllBtn.addEventListener("click", () => {
  for (const row of techSelectList.querySelectorAll(".tech-select-row:not(.hidden-by-search)")) {
    const checkbox = row.querySelector("input");
    checkbox.checked = true;
    selectedTechIds.add(checkbox.value);
  }
  updateTechSelectToggleLabel(latestData?.technicians || []);
  updateTechsUrlParam();
  rerenderFromCache();
});
techSelectClearBtn.addEventListener("click", () => {
  selectedTechIds.clear();
  for (const checkbox of techSelectList.querySelectorAll("input")) checkbox.checked = false;
  updateTechSelectToggleLabel(latestData?.technicians || []);
  updateTechsUrlParam();
  rerenderFromCache();
});

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
