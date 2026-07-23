// TV kiosk view — one department per screen, driven entirely by the `dept`
// URL param so the same page serves all five TVs (e.g.
// tv.html?dept=Plumbing%20Service). Shared data/compute helpers
// (formatMoney, computeScorecardStats, periodRange, jobInPeriod,
// businessUnitCode, etc.) come from shared.js, loaded before this;
// rendering here is TV-specific since the scale and layout are nothing like
// the desktop scorecards.

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

// HVAC Service and Plumbing Service each cover two business units in
// practice (e.g. an "HVAC Service" tech's jobs land under either the "30"
// service BU or the "40" maintenance BU) — rather than one blended
// leaderboard, these two departments' screens split into one section per
// BU, each with its own ranked list and totals row. The other three
// screens (the two Installation departments and Office) aren't tied to a
// specific pair of business units, so they keep the single blended
// leaderboard. `fallbackLabel` only shows if no job in view happens to
// carry that BU's exact string (label is otherwise read live off the data
// — see businessUnitLabelForCode — so it always matches what admin.html
// shows for the same BU rather than risking drift from a hardcoded name).
const DEPT_BU_SPLIT = {
  "HVAC Service": [
    { code: "30", fallbackLabel: "30 HVAC Service" },
    { code: "40", fallbackLabel: "40 HVAC Maintenance" },
  ],
  "Plumbing Service": [
    { code: "70", fallbackLabel: "70 Plumbing Service" },
    { code: "80", fallbackLabel: "80 Plumbing Maintenance" },
  ],
};

// The dept param has to survive being typed on a TV remote's on-screen
// keyboard, which is slow and error-prone for spaces/capitalization/exact
// punctuation — so matching is forgiving rather than an exact string
// comparison: case-insensitive, and treats -, _, and + the same as a space
// (so "plumbing-service" or "PLUMBING_SERVICE" both resolve the same as
// "Plumbing Service"). Every valid URL from before this change still works
// unchanged; this only widens what else also works.
function normalizeDeptKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolveDept(raw) {
  const key = normalizeDeptKey(raw);
  return VALID_DEPTS.find((d) => normalizeDeptKey(d) === key) || null;
}

const DEPT = resolveDept(urlParams.get("dept"));
const PERIOD = urlParams.has("period") ? urlParams.get("period") : "month";

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

function renderAvatarBlock(tech, sizeClass, fallbackClass, { large = false } = {}) {
  const initialsText = escapeHtml(initials(tech.name || "?"));
  const bg = tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : "";
  if (!hasRealAvatar(tech)) {
    return `<div class="${fallbackClass}" style="background:${bg}">${initialsText}</div>`;
  }
  const bigUrl = large ? largeAvatarUrl(tech.avatar_url) : null;
  if (bigUrl) {
    return `
      <img class="${sizeClass}" src="${escapeHtml(bigUrl)}" data-thumb-src="${escapeHtml(tech.avatar_url)}" alt="" onerror="handleLargeAvatarError(this)" />
      <div class="${fallbackClass}" style="background:${bg};display:none">${initialsText}</div>
    `;
  }
  return `
    <img class="${sizeClass}" src="${escapeHtml(tech.avatar_url)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
    <div class="${fallbackClass}" style="background:${bg};display:none">${initialsText}</div>
  `;
}

function tvTile(label, value, cls, sizeClass) {
  return `<div class="${sizeClass || "tv-tile"} ${cls || ""}"><div class="tv-tile-label">${escapeHtml(label)}</div><div class="tv-tile-value">${escapeHtml(value)}</div></div>`;
}

// The full metric set shown per technician/section, in display order.
// sizeClass picks the tile styling ("tv-tile" for the big featured card,
// "tv-row-tile" for the compact list/totals rows).
function metricTiles(stats, sizeClass) {
  return [
    tvTile("Revenue", formatMoney(stats.totalRevenue), kpiClass("revenue", stats.totalRevenue), sizeClass),
    tvTile("Avg ticket", formatMoney(stats.avgTicket), kpiClass("avgTicket", stats.avgTicket), sizeClass),
    tvTile("Completion", `${stats.completionRate.toFixed(0)}%`, kpiClass("completion", stats.completionRate), sizeClass),
    tvTile("Jobs", stats.totalJobs.toLocaleString(), kpiClass("jobs", stats.totalJobs), sizeClass),
    tvTile("Leads", stats.leads.toLocaleString(), kpiClass("leads", stats.leads), sizeClass),
    tvTile("Leads sold", stats.leadsSold.toLocaleString(), kpiClass("leadsSold", stats.leadsSold), sizeClass),
    tvTile("IFO", stats.ifo.toLocaleString(), kpiClass("ifo", stats.ifo), sizeClass),
    tvTile("Accessory sold", stats.accessorySold.toLocaleString(), kpiClass("accessorySold", stats.accessorySold), sizeClass),
  ].join("");
}

function renderFeatured(entry) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-featured">
      <div class="tv-featured-photo-wrap">
        ${renderAvatarBlock(tech, "tv-featured-photo", "tv-featured-photo-fallback", { large: true })}
      </div>
      <div class="tv-featured-name">${escapeHtml(tech.name || "Unknown")}</div>
      <div class="tv-featured-rank">#${rank} · ${escapeHtml(DEPT)}</div>
      <div class="tv-tile-grid">
        ${metricTiles(stats)}
      </div>
    </div>
  `;
}

function renderRow(entry) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-row">
      <div class="tv-row-rank">#${rank}</div>
      ${renderAvatarBlock(tech, "tv-row-photo", "tv-row-photo-fallback")}
      <div class="tv-row-name-block">
        <div class="tv-row-name">${escapeHtml(tech.name || "Unknown")}</div>
        <div class="tv-row-meta">${escapeHtml(tech.role || "")}</div>
      </div>
      <div class="tv-row-metrics">
        ${metricTiles(stats, "tv-row-tile")}
      </div>
    </div>
  `;
}

// One aggregate row at the bottom of a BU section — same tile set as an
// individual row, but summed across every tech in that section (see
// buildBuTotals) rather than any one person's numbers.
function renderTotalsRow(stats) {
  return `
    <div class="tv-row tv-totals-row">
      <div class="tv-row-name-block">
        <div class="tv-row-name">Total</div>
      </div>
      <div class="tv-row-metrics">
        ${metricTiles(stats, "tv-row-tile")}
      </div>
    </div>
  `;
}

function renderBuSection(label, entries, totalsStats) {
  return `
    <div class="tv-bu-section">
      <div class="tv-bu-header">${escapeHtml(label)}</div>
      <div class="tv-list">
        ${entries.map((entry) => renderRow(entry)).join("")}
        ${renderTotalsRow(totalsStats)}
      </div>
    </div>
  `;
}

// Ranks every tech in the department by revenue for the selected period —
// including $0 techs, ranked last, so the full roster is always visible
// rather than only whoever has activity.
function buildRanked(deptTechs, jobs) {
  const entries = deptTechs.map((tech) => {
    const techJobs = jobs.filter((j) => (j.assigned_employee_ids || []).includes(tech.id) && jobInPeriod(j, PERIOD));
    const stats = computeScorecardStats(techJobs, { splitRevenue: true });
    return { tech, stats };
  });
  entries.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

// Same idea as buildRanked, but each tech's jobs are additionally filtered
// to just the given business-unit code — so e.g. an HVAC Service tech who
// works both the "30" and "40" business units gets a separate ranked entry
// (and separate revenue figure) in each BU's section, scoped to only that
// BU's jobs. Every department tech still appears in every BU section, even
// at $0, for the same "full roster always visible" reason as buildRanked.
function buildBuRanked(deptTechs, jobs, code) {
  const entries = deptTechs.map((tech) => {
    const techJobs = jobs.filter(
      (j) =>
        (j.assigned_employee_ids || []).includes(tech.id) &&
        jobInPeriod(j, PERIOD) &&
        businessUnitCode(j.business_unit) === code
    );
    const stats = computeScorecardStats(techJobs, { splitRevenue: true });
    return { tech, stats };
  });
  entries.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

// Aggregate stats for a BU section's totals row — computed directly from
// that BU's jobs (not summed from the individual rows above), same
// unsplit-revenue convention admin.html's department cards use: a job
// belongs to the total once regardless of how many techs worked it.
function buildBuTotals(deptTechs, jobs, code) {
  const techIds = new Set(deptTechs.map((t) => t.id));
  const buJobs = jobs.filter(
    (j) =>
      businessUnitCode(j.business_unit) === code &&
      jobInPeriod(j, PERIOD) &&
      (j.assigned_employee_ids || []).some((id) => techIds.has(id))
  );
  return computeScorecardStats(buJobs, { splitRevenue: false });
}

// The section header shows the business unit's actual name as synced from
// Housecall Pro (e.g. "30 HVAC SERVICE"), read live off any matching job in
// view rather than hardcoded, so it always matches what admin.html shows
// for the same BU. Falls back to the config's fallbackLabel only if no job
// in the current period happens to carry that BU (e.g. an unusually quiet
// period) — rare, but avoids an empty header.
function businessUnitLabelForCode(jobs, code, fallbackLabel) {
  const job = jobs.find((j) => businessUnitCode(j.business_unit) === code);
  return job ? job.business_unit : fallbackLabel;
}

let latestData = null;

function render() {
  if (!VALID_DEPTS.includes(DEPT)) {
    deptNameEl.textContent = "Unknown department";
    mainEl.className = "tv-main";
    mainEl.innerHTML = `<p class="tv-empty">No such department. Use ?dept= with one of: ${VALID_DEPTS.map(escapeHtml).join(
      ", "
    )}<br>(spaces, hyphens, underscores, and capitalization are all fine — e.g. plumbing-service works too)</p>`;
    return;
  }

  deptNameEl.textContent = DEPT;

  if (!latestData) return;

  const deptTechs = latestData.technicians.filter((t) => departmentOf(t) === DEPT);
  const jobs = latestData.jobs || [];

  if (deptTechs.length === 0) {
    mainEl.className = "tv-main";
    mainEl.innerHTML = `<p class="tv-empty">No technicians found for ${escapeHtml(DEPT)}.</p>`;
    return;
  }

  const split = DEPT_BU_SPLIT[DEPT];

  if (split) {
    mainEl.className = "tv-main tv-main-split";
    mainEl.innerHTML = split
      .map(({ code, fallbackLabel }) => {
        const label = businessUnitLabelForCode(jobs, code, fallbackLabel);
        const entries = buildBuRanked(deptTechs, jobs, code);
        const totals = buildBuTotals(deptTechs, jobs, code);
        return renderBuSection(label, entries, totals);
      })
      .join("");
    return;
  }

  // #1 by revenue always holds the featured spot — no timer, no forced
  // cycling. The only way someone else gets featured is by actually
  // overtaking #1 in revenue, which buildRanked's sort already handles on
  // every data refresh; render() just always reads the current #1.
  const entries = buildRanked(deptTechs, jobs);
  const featured = entries[0];
  const rest = entries.slice(1);

  mainEl.className = "tv-main";
  const list = document.createElement("div");
  list.className = "tv-list";
  list.innerHTML = rest.map((entry) => renderRow(entry)).join("");

  mainEl.innerHTML = renderFeatured(featured);
  mainEl.appendChild(list);
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestData = data;
    render();
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
