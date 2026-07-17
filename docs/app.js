const DATA_URL = "data/dashboard.json";
const POLL_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 30 * 60_000; // flag sync status if data hasn't refreshed in 30 min

const app = document.getElementById("app");
const searchInput = document.getElementById("search");
const syncStatusEl = document.getElementById("sync-status");

let latestData = null;

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
    <div class="job-sub">${escapeHtml([job.customer_label, location].filter(Boolean).join(" · "))}</div>
  `;
  return li;
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

function renderTechCard(tech, jobs) {
  const card = document.createElement("div");
  card.className = "tech-card";
  card.dataset.searchBlob = [tech.name, tech.role, ...jobs.map((j) => j.description), ...jobs.map((j) => j.customer_label)]
    .join(" ")
    .toLowerCase();

  const sortedJobs = [...jobs].sort((a, b) => {
    const at = a.schedule?.scheduled_start || "";
    const bt = b.schedule?.scheduled_start || "";
    return at.localeCompare(bt);
  });

  const header = document.createElement("div");
  header.className = "tech-card-header";
  header.innerHTML = `
    <div class="avatar" style="background:${tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : ""}">${initials(tech.name || "?")}</div>
    <div>
      <div class="tech-name">${escapeHtml(tech.name || "Unknown")}</div>
      ${tech.role ? `<div class="tech-role">${escapeHtml(tech.role)}</div>` : ""}
    </div>
    <div class="job-count">${sortedJobs.length} job${sortedJobs.length === 1 ? "" : "s"}</div>
  `;
  card.appendChild(header);

  if (sortedJobs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-jobs";
    empty.textContent = "No jobs in the current window.";
    card.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "job-list";
    for (const job of sortedJobs) list.appendChild(renderJobItem(job));
    card.appendChild(list);
  }

  return card;
}

function render(data) {
  app.innerHTML = "";

  if (!data.technicians || data.technicians.length === 0) {
    app.innerHTML = '<p class="empty">No technicians found.</p>';
    return;
  }

  const grid = document.createElement("div");
  grid.className = "tech-grid";
  for (const tech of data.technicians) {
    const jobs = data.by_technician[tech.id] || [];
    grid.appendChild(renderTechCard(tech, jobs));
  }
  app.appendChild(grid);

  if (data.unassigned && data.unassigned.length > 0) {
    const title = document.createElement("h2");
    title.className = "section-title";
    title.textContent = `Unassigned jobs (${data.unassigned.length})`;
    app.appendChild(title);

    const list = document.createElement("ul");
    list.className = "job-list";
    for (const job of data.unassigned) list.appendChild(renderJobItem(job));
    app.appendChild(list);
  }

  applyFilter();
}

function applyFilter() {
  const q = searchInput.value.trim().toLowerCase();
  const cards = document.querySelectorAll(".tech-card");
  for (const card of cards) {
    const match = !q || card.dataset.searchBlob.includes(q);
    card.style.display = match ? "" : "none";
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

searchInput.addEventListener("input", applyFilter);

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
