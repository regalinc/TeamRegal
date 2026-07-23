// TV kiosk view — one department per screen, driven entirely by the `dept`
// URL param so the same page serves all five TVs (e.g.
// tv.html?dept=Plumbing%20Service). Shared data/compute helpers
// (formatMoney, computeScorecardStats, periodRange, jobInPeriod, etc.) come
// from shared.js, loaded before this; rendering here is TV-specific since
// the scale and layout are nothing like the desktop scorecards.

const urlParams = new URLSearchParams(location.search);

// The four field departments are already real employee tags (same ones the
// technician-view quick-filter buttons use). There's no equivalent "Office"
// tag, so Office is a catch-all: anyone not carrying one of the four field
// tags, minus a few system/dispatch accounts that aren't real people.
const FIELD_DEPT_TAGS = ["Plumbing Service", "Plumbing Installation", "HVAC Service", "HVAC Installation"];
const OFFICE_LABEL = "Office";
const VALID_DEPTS = [...FIELD_DEPT_TAGS, OFFICE_LABEL];
const EXCLUDED_TECH_IDS = new Set([
  "pro_932c9cd2fe1642e0b5cb3d7a9c0c94a9", // Marketing Department
  "pro_275a4180be774faa8606cf065969a962", // Urgency Plumbing
  "pro_a66fbc5ec25d48bb8db8a93609a0654f", // Urgency HVAC
]);

const DEPT = urlParams.get("dept");
const PERIOD = urlParams.has("period") ? urlParams.get("period") : "month";
const ROTATE_MS = (Number(urlParams.get("rotate")) || 8) * 1000;

const deptNameEl = document.getElementById("tv-dept-name");
const mainEl = document.getElementById("tv-main");

function departmentOf(tech) {
  if (EXCLUDED_TECH_IDS.has(tech.id)) return null;
  const tags = tech.tags || [];
  for (const dept of FIELD_DEPT_TAGS) {
    if (tags.includes(dept)) return dept;
  }
  return OFFICE_LABEL;
}

// Placeholder until real KPI thresholds are wired in — every tile renders
// neutral for now. Once thresholds exist, this returns "tv-good"/"tv-bad"
// per metric instead of null, and nothing else about the layout changes.
function kpiClass(_metricKey, _value) {
  return null;
}

function renderAvatarBlock(tech, sizeClass, fallbackClass) {
  const initialsText = escapeHtml(initials(tech.name || "?"));
  const bg = tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : "";
  if (!hasRealAvatar(tech)) {
    return `<div class="${fallbackClass}" style="background:${bg}">${initialsText}</div>`;
  }
  return `
    <img class="${sizeClass}" src="${escapeHtml(tech.avatar_url)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
    <div class="${fallbackClass}" style="background:${bg};display:none">${initialsText}</div>
  `;
}

function renderFeatured(entry) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-featured">
      <div class="tv-featured-photo-wrap">
        ${renderAvatarBlock(tech, "tv-featured-photo", "tv-featured-photo-fallback")}
      </div>
      <div class="tv-featured-name">${escapeHtml(tech.name || "Unknown")}</div>
      <div class="tv-featured-rank">#${rank} · ${escapeHtml(DEPT)}</div>
      <div class="tv-tile-grid">
        ${tvTile("Revenue", formatMoney(stats.totalRevenue), kpiClass("revenue", stats.totalRevenue))}
        ${tvTile("Avg ticket", formatMoney(stats.avgTicket), kpiClass("avgTicket", stats.avgTicket))}
        ${tvTile("Completion", `${stats.completionRate.toFixed(0)}%`, kpiClass("completion", stats.completionRate))}
        ${tvTile("Jobs", stats.totalJobs.toLocaleString(), kpiClass("jobs", stats.totalJobs))}
      </div>
    </div>
  `;
}

function tvTile(label, value, cls) {
  return `<div class="tv-tile ${cls || ""}"><div class="tv-tile-label">${escapeHtml(label)}</div><div class="tv-tile-value">${escapeHtml(value)}</div></div>`;
}

function renderRow(entry, isActive) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-row ${isActive ? "tv-row-active" : ""}">
      <div class="tv-row-rank">#${rank}</div>
      ${renderAvatarBlock(tech, "tv-row-photo", "tv-row-photo-fallback")}
      <div>
        <div class="tv-row-name">${escapeHtml(tech.name || "Unknown")}</div>
        <div class="tv-row-meta">${escapeHtml(tech.role || "")}</div>
      </div>
      <div class="tv-row-revenue">${formatMoney(stats.totalRevenue)}</div>
    </div>
  `;
}

let latestData = null;
let ranked = [];
let featuredIndex = 0;
let rotateTimer = null;

function buildRanked(data) {
  const techById = new Map((data.technicians || []).map((t) => [t.id, t]));
  const deptTechs = (data.technicians || []).filter((t) => departmentOf(t) === DEPT);

  const entries = deptTechs.map((tech) => {
    const jobs = (data.jobs || []).filter(
      (j) => (j.assigned_employee_ids || []).includes(tech.id) && jobInPeriod(j, PERIOD)
    );
    const stats = computeScorecardStats(jobs, { splitRevenue: true });
    return { tech, stats };
  });

  entries.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

function render() {
  if (!VALID_DEPTS.includes(DEPT)) {
    deptNameEl.textContent = "Unknown department";
    mainEl.innerHTML = `<p class="tv-empty">No such department. Use ?dept= with one of: ${VALID_DEPTS.map(escapeHtml).join(", ")}</p>`;
    return;
  }

  deptNameEl.textContent = DEPT;

  if (ranked.length === 0) {
    mainEl.innerHTML = `<p class="tv-empty">No technicians found for ${escapeHtml(DEPT)}.</p>`;
    return;
  }

  if (featuredIndex >= ranked.length) featuredIndex = 0;
  const featured = ranked[featuredIndex];

  const list = document.createElement("div");
  list.className = "tv-list";
  list.innerHTML = ranked.map((entry) => renderRow(entry, entry === featured)).join("");

  mainEl.innerHTML = renderFeatured(featured);
  mainEl.appendChild(list);
}

function startRotation() {
  if (rotateTimer) clearInterval(rotateTimer);
  if (ranked.length <= 1) return;
  rotateTimer = setInterval(() => {
    featuredIndex = (featuredIndex + 1) % ranked.length;
    render();
  }, ROTATE_MS);
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestData = data;
    ranked = buildRanked(data);
    render();
    startRotation();
    updateSyncStatus(data.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestData) {
      mainEl.innerHTML = `<p class="tv-empty">Could not load dashboard data yet.</p>`;
    }
    console.error(err);
  }
}

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
