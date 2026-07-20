// Shared between index.html (per-technician) and admin.html (per-department)
// — pure helpers and rendering pieces with no page-specific DOM assumptions
// beyond the #sync-status element both pages have in their header.

const DATA_URL = "data/dashboard.json";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 90 * 60_000; // flag sync status if data hasn't refreshed in 90 min (sync is hourly, plus buffer for GitHub's scheduling jitter)

// Housecall Pro's job money fields (total_amount, outstanding_balance) are in cents.
const CENTS_PER_DOLLAR = 100;

const COMPLETE_STATUSES = new Set(["complete rated", "complete unrated"]);

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

function renderMiniStat(label, value) {
  return `<div class="tech-mini-stat"><div class="tech-mini-stat-label">${escapeHtml(label)}</div><div class="tech-mini-stat-value">${escapeHtml(value)}</div></div>`;
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

// Every scorecard's numbers (technician or department) are pulled from tags
// rather than raw job counts, per how the business actually tracks these:
// - Jobs: only jobs tagged "Opportunity" count as a "true" job — except in
//   business units 10 and 50 (AOR departments), where every job counts like
//   it used to; see RAW_JOB_COUNT_BU_CODES below.
// - Revenue: unchanged — still sums every job in view.
// - Avg ticket: total revenue (all jobs) divided by the Jobs count above
//   (Opportunity-tagged, or raw for BU 10/50), not a separate billed-job count.
// - Completion: unchanged — still scoped to all jobs in view.
// - Leads / Leads sold: jobs tagged "TGL", and of those, ones also tagged
//   "TGL Sold".
// - RCC sold: jobs tagged "Membership Sold" — Housecall Pro's
//   membership/service-plan sales report isn't exposed via the public API,
//   so this tag is the stand-in the business tracks it with instead.
// - IFO: jobs tagged "IFO".
// - Accessory sold: jobs tagged "Accessory Sold".
// Business units whose numeric code (the leading token of the business_unit
// string, e.g. "10" in "10 HVAC AOR") are AOR ("Agreement of Record"?)
// departments where "Jobs" should count every job like it used to, not just
// ones tagged "Opportunity" — that tag isn't how those two departments are
// worked, so filtering by it would undercount them.
const RAW_JOB_COUNT_BU_CODES = new Set(["10", "50"]);

function businessUnitCode(businessUnit) {
  return (businessUnit || "").trim().split(" ")[0];
}

function countsTowardJobs(job) {
  if (RAW_JOB_COUNT_BU_CODES.has(businessUnitCode(job.business_unit))) return true;
  return hasTag(job, "Opportunity");
}

function computeScorecardStats(jobs) {
  const totalRevenueCents = jobs.reduce((sum, j) => sum + (j.total_amount || 0), 0);

  const countedJobs = jobs.filter(countsTowardJobs);
  const totalJobs = countedJobs.length;
  const avgTicketCents = totalJobs ? totalRevenueCents / totalJobs : 0;

  const completedJobs = jobs.filter((j) => COMPLETE_STATUSES.has(j.work_status));
  const completionRate = jobs.length ? (completedJobs.length / jobs.length) * 100 : 0;

  const leadJobs = jobs.filter((j) => hasTag(j, "TGL"));
  const leadsSoldJobs = leadJobs.filter((j) => hasTag(j, "TGL Sold"));

  const servicePlansSoldJobs = jobs.filter((j) => hasTag(j, "Membership Sold"));

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
function renderScorecard({ headerHtml, tagsHtml, jobs }) {
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
    renderMiniStat("RCC sold", stats.servicePlansSold.toLocaleString()),
    renderMiniStat("IFO", stats.ifo.toLocaleString()),
    renderMiniStat("Accessory sold", stats.accessorySold.toLocaleString()),
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
