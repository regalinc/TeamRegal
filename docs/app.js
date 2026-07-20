const DATA_URL = "data/dashboard.json";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 90 * 60_000; // flag sync status if data hasn't refreshed in 90 min (sync is hourly, plus buffer for GitHub's scheduling jitter)

// Housecall Pro's job money fields (total_amount, outstanding_balance) are in cents.
const CENTS_PER_DOLLAR = 100;

const COMPLETE_STATUSES = new Set(["complete rated", "complete unrated"]);

const app = document.getElementById("app");
const statsEl = document.getElementById("stats");
const searchInput = document.getElementById("search");
const businessUnitFilter = document.getElementById("business-unit-filter");
const tagFilter = document.getElementById("tag-filter");
const statusFilter = document.getElementById("status-filter");
const periodFilter = document.getElementById("period-filter");
const syncStatusEl = document.getElementById("sync-status");

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

// Housecall Pro returns this same URL for every employee who hasn't
// uploaded a real photo — treat it as "no avatar" rather than showing
// everyone the same generic silhouette.
const HCP_PLACEHOLDER_AVATAR = "add_image_thumb_web_round.png";

function hasRealAvatar(tech) {
  return Boolean(tech.avatar_url) && !tech.avatar_url.includes(HCP_PLACEHOLDER_AVATAR);
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

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join("");
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

function renderMiniStat(label, value) {
  return `<div class="tech-mini-stat"><div class="tech-mini-stat-label">${escapeHtml(label)}</div><div class="tech-mini-stat-value">${escapeHtml(value)}</div></div>`;
}

// A per-technician scorecard: header + 4 mini stat tiles (mirroring the team
// summary row above, just scoped to this one person), with the underlying
// job list tucked behind a native <details> toggle instead of shown by
// default — this is a reporting view, not a live per-job schedule.
function renderTechCard(tech, jobs) {
  const card = document.createElement("div");
  card.className = "tech-card";

  const header = document.createElement("div");
  header.className = "tech-card-header";
  header.innerHTML = `
    ${renderAvatar(tech)}
    <div>
      <div class="tech-name">${escapeHtml(tech.name || "Unknown")}</div>
      ${tech.role ? `<div class="tech-role">${escapeHtml(tech.role)}</div>` : ""}
    </div>
  `;
  card.appendChild(header);

  if (tech.tags && tech.tags.length > 0) {
    const tagsRow = document.createElement("div");
    tagsRow.className = "tech-tags";
    tagsRow.innerHTML = tech.tags.map((t) => `<span class="tech-tag-chip">${escapeHtml(t)}</span>`).join("");
    card.appendChild(tagsRow);
  }

  const stats = computeScorecardStats(jobs);
  const statsRow = document.createElement("div");
  statsRow.className = "tech-mini-stats";
  statsRow.innerHTML = [
    renderMiniStat("Jobs", stats.totalJobs.toLocaleString()),
    renderMiniStat("Revenue", formatMoney(stats.totalRevenue)),
    renderMiniStat("Avg ticket", formatMoney(stats.avgTicket)),
    renderMiniStat("Completion", `${stats.completionRate.toFixed(0)}%`),
    renderMiniStat("Leads", stats.leads.toLocaleString()),
    renderMiniStat("Leads sold", stats.leadsSold.toLocaleString()),
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

function computeStats(jobs) {
  const totalJobs = jobs.length;
  const totalRevenueCents = jobs.reduce((sum, j) => sum + (j.total_amount || 0), 0);
  const billedJobs = jobs.filter((j) => (j.total_amount || 0) > 0);
  const avgTicketCents = billedJobs.length ? totalRevenueCents / billedJobs.length : 0;
  const completedJobs = jobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = totalJobs ? (completedJobs.length / totalJobs) * 100 : 0;

  return {
    totalJobs,
    totalRevenue: totalRevenueCents / CENTS_PER_DOLLAR,
    avgTicket: avgTicketCents / CENTS_PER_DOLLAR,
    completionRate,
  };
}

function hasTag(job, tagName) {
  const target = tagName.toLowerCase();
  return (job.tags || []).some((t) => t.toLowerCase() === target);
}

// The per-technician scorecard's numbers are pulled from tags rather than
// raw job counts, per how the business actually tracks these:
// - Jobs: only jobs tagged "Opportunity" count as a "true" job.
// - Revenue: unchanged — still sums every job in view.
// - Avg ticket: total revenue (all jobs) divided by the Opportunity job
//   count, not the raw job count.
// - Completion: unchanged — still scoped to all jobs in view.
// - Leads / Leads sold: jobs tagged "TGL", and of those, ones also tagged
//   "TGL Sold".
function computeScorecardStats(jobs) {
  const totalRevenueCents = jobs.reduce((sum, j) => sum + (j.total_amount || 0), 0);

  const opportunityJobs = jobs.filter((j) => hasTag(j, "Opportunity"));
  const totalJobs = opportunityJobs.length;
  const avgTicketCents = totalJobs ? totalRevenueCents / totalJobs : 0;

  const completedJobs = jobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = jobs.length ? (completedJobs.length / jobs.length) * 100 : 0;

  const leadJobs = jobs.filter((j) => hasTag(j, "TGL"));
  const leadsSoldJobs = leadJobs.filter((j) => hasTag(j, "TGL Sold"));

  return {
    totalJobs,
    totalRevenue: totalRevenueCents / CENTS_PER_DOLLAR,
    avgTicket: avgTicketCents / CENTS_PER_DOLLAR,
    completionRate,
    leads: leadJobs.length,
    leadsSold: leadsSoldJobs.length,
  };
}

function renderStats(stats) {
  statsEl.innerHTML = "";
  statsEl.appendChild(renderStatTile({ label: "Total jobs", value: stats.totalJobs.toLocaleString() }));
  statsEl.appendChild(renderStatTile({ label: "Total revenue", value: formatMoney(stats.totalRevenue) }));
  statsEl.appendChild(renderStatTile({ label: "Average ticket", value: formatMoney(stats.avgTicket) }));
  statsEl.appendChild(
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
    default:
      return null;
  }
}

function jobInPeriod(job, period) {
  if (!period) return true;
  const range = periodRange(period);
  if (!range) return true;

  const startIso = job.schedule?.scheduled_start;
  if (!startIso) return false;
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return false;

  return d >= range[0] && d < range[1];
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

function fillSelect(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = "";
  select.appendChild(new Option(allLabel, ""));
  for (const v of [...values].sort()) select.appendChild(new Option(v, v));
  if ([...values].includes(previous)) select.value = previous;
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

  setSelectFromUrlParam(businessUnitFilter, "bu");
  setSelectFromUrlParam(tagFilter, "tag");
  setSelectFromUrlParam(statusFilter, "status");
  setSelectFromUrlParam(periodFilter, "period");

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

function setSelectFromUrlParam(select, paramName) {
  const value = urlParams.get(paramName);
  if (value && [...select.options].some((o) => o.value === value)) select.value = value;
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

  // The team summary scopes to just the selected roster's jobs when one is
  // set (unassigned jobs belong to no technician, so they drop out too).
  let statsJobs = periodJobs;
  if (rosterActive) {
    statsJobs = statsJobs.filter((j) => (j.assigned_employee_ids || []).some((id) => rosterTechIds.has(id)));
  }

  renderStats(computeStats(statsJobs));

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
    grid.appendChild(renderTechCard(tech, jobs));
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
