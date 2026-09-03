// Department Scorecard — P&L/KPI-driven, separate from the job-tracking
// dashboard (index.html/admin.html/tv.html). Monthly grain (a P&L doesn't
// update hourly), not the live "this month/last month/YTD" period system
// those pages use — a real calendar month, picked from what's actually been
// uploaded. Reuses shared.js for data fetching, tag-based job stats
// (computeScorecardStats), and the KPI tier()/renderMiniStat coloring
// convention every other page already uses, so a green/amber/red tile here
// means the same thing it does everywhere else on the site.
//
// Three data sources, one page:
//  - Housecall Pro (data/dashboard.json) — live, same as every other page.
//  - The monthly P&L (data/pnl-monthly.json) — parsed by hand each month
//    from the actual P&L export (scripts/parse-pnl.ps1) — no automated sync
//    exists for this yet; a human uploads it and the numbers get committed.
//  - Manual entries (data/manual-metrics.json) — paid hours, attendance,
//    callbacks, etc.: things that live in payroll or other spreadsheets
//    Housecall Pro has no way to know about. null until filled in.
//
// Each department's metric set is genuinely different — BU 40's original
// KPI chart has no $0 Call/Lead turnover/Accessory sold at all, and frames
// club agreements as new-vs-renewal rather than BU 30's flat conversion
// rate — so DEPARTMENTS (and the OVERHEAD_PNL_METRICS/installDept() it's
// built from) is config-driven rather than one hardcoded tile set applied
// to every BU. Lives in departments-config.js now, not this file — a
// second page (an internal matrix/comparison view) reads the exact same
// targets from there, so there's one source of truth instead of two copies
// that could quietly drift apart. Loaded via <script> before this file in
// company-scorecard.html. A target of `null` renders the tile with a real
// number but no color, for a metric that's tracked but doesn't have a
// confirmed target yet (see README for which ones and why).

const deptSelect = document.getElementById("dept-select");
const monthSelect = document.getElementById("month-select");
const appEl = document.getElementById("app");

let latestData = null;
let pnlData = null;
let manualData = null;
let currentDept = "30";
let currentMonth = null;

function populateDeptSelect() {
  deptSelect.innerHTML = Object.entries(DEPARTMENTS)
    .map(([code, d]) => `<option value="${code}">${escapeHtml(d.name)}</option>`)
    .join("");
}

// One "YTD-<year>" option per year that has at least one month of P&L
// data, newest year first — isYtd()/ytdYear()/monthLabel() live in
// shared.js now (a second page needs the exact same YTD semantics).
function populateMonthSelect() {
  const months = Object.keys(pnlData || {}).sort().reverse();
  const years = [...new Set(months.map((m) => m.slice(0, 4)))]; // already newest-first, since months is
  const options = years.flatMap((year) => [
    { value: `YTD-${year}`, label: `${year} Year to date` },
    ...months.filter((m) => m.startsWith(year)).map((m) => ({ value: m, label: monthLabel(m) })),
  ]);
  monthSelect.innerHTML = options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
  // Default stays the latest real month, not YTD — least surprise for
  // existing behavior; YTD is an explicit extra choice, not the default.
  currentMonth = months[0] || null;
  if (currentMonth) monthSelect.value = currentMonth;
}

// A specific calendar month, not one of shared.js's "today/this month/..."
// relative periods — periodRange() can't express "July 2026" once today has
// moved past it, which it always eventually will for a P&L month.
function monthRange(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}

function jobInRange(job, [start, end]) {
  const sched = job.schedule?.scheduled_start;
  if (!sched) return false;
  const d = new Date(sched);
  if (Number.isNaN(d.getTime())) return false;
  return d >= start && d < end;
}

function jobInMonth(job, monthStr) {
  return jobInRange(job, monthRange(monthStr));
}

// Jan 1 of `year` through the day after the last day of the latest month
// actually present in the P&L data for that year — not "through today" —
// so YTD job stats line up with exactly the P&L months being summed, even
// once this is used to look back at a completed prior year.
function ytdRange(year, monthKeysInYear) {
  const months = monthKeysInYear.length ? monthKeysInYear : [`${year}-01`];
  const maxMonthNum = Math.max(...months.map((mk) => Number(mk.split("-")[1])));
  return [new Date(year, 0, 1), new Date(year, maxMonthNum, 1)];
}

// sumPnl() lives in shared.js now, alongside the other YTD helpers.

// Flow-type manual fields (activity across the period: hours, review/
// callback counts) are summed for YTD. Everything else — headcount
// snapshots (employeeCount, vehicleCount, crewCount, supportCount,
// productionCount) and attendance/PTU-style percentages — is a
// point-in-time reading, not something that should be added up across
// months, so YTD shows the most recently entered non-null value instead.
// Extend this set if a future summed field gets added to a department's
// manual config.
const YTD_SUM_KEYS = new Set(["paidHours", "billedHours", "reviewsGenerated", "callbackCount"]);

function aggregateManualYtd(monthKeysAscending, deptManualData) {
  const result = {};
  let any = false;
  for (const mk of monthKeysAscending) {
    const m = deptManualData[mk];
    if (!m) continue;
    any = true;
    for (const [k, v] of Object.entries(m)) {
      if (v === null || v === undefined) continue;
      result[k] = YTD_SUM_KEYS.has(k) ? (result[k] || 0) + v : v;
    }
  }
  return any ? result : null;
}

// Formats a target as a short caption ("Target ≤ 9.0%", "Target ≥ $450") in
// the same units the tile itself uses, so a red/amber tile reads as
// self-explanatory from across a room, not just "here's a number and a
// color." Returns null for an untargeted (neutral) metric — nothing to show.
function formatTargetCaption(type, target) {
  if (!target) return null;
  const symbol = target.direction === "min" ? "≥" : "≤";
  let goalStr;
  if (type === "pct") goalStr = `${(target.goal * 100).toFixed(1)}%`;
  else if (type === "money") goalStr = formatMoney(target.goal);
  // A same-P&L dollar-to-dollar comparison (e.g. Labor $2 : Parts $1),
  // not a % of sales — formatted as "2.0:1" to match how the source chart
  // states the target, distinct from a plain count.
  else if (type === "ratio") goalStr = `${target.goal.toFixed(1)}:1`;
  else goalStr = Number(target.goal).toLocaleString();
  return `Target ${symbol} ${goalStr}`;
}

function tileFor(label, type, value, target) {
  const sub = formatTargetCaption(type, target);
  if (value === null || value === undefined || Number.isNaN(value)) {
    return renderMiniStat(label, "—", null, sub);
  }
  const t = target ? tier(value, target) : null;
  if (type === "pct") return renderMiniStat(label, `${(value * 100).toFixed(1)}%`, t, sub);
  if (type === "money") return renderMiniStat(label, formatMoney(value), t, sub);
  if (type === "ratio") return renderMiniStat(label, `${value.toFixed(1)}:1`, t, sub);
  return renderMiniStat(label, Number(value).toLocaleString(), t, sub);
}

function sectionHtml(title, note, tilesHtml) {
  return `
    <section class="scorecard-section">
      <h2 class="section-title">${escapeHtml(title)}</h2>
      ${note ? `<p class="section-note">${note}</p>` : ""}
      <div class="tech-mini-stats scorecard-tiles">${tilesHtml}</div>
    </section>
  `;
}

// Raw (unformatted) value for each known HCP metric key — everything else
// (formatting, coloring) is generic once this returns a plain number.
function hcpValue(key, stats, jobs) {
  switch (key) {
    case "avgTicket":
      return stats.avgTicket;
    case "zeroCall":
      return stats.totalJobs ? stats.ifo / stats.totalJobs : null;
    case "leadTurnover":
      return stats.totalJobs ? stats.leads / stats.totalJobs : null;
    case "accessorySold":
      return stats.totalJobs ? stats.accessorySold / stats.totalJobs : null;
    case "clubConversion": {
      const pool = stats.servicePlansSold + stats.nonMemberCount;
      return pool ? stats.servicePlansSold / pool : null;
    }
    case "totalClubAgreements":
      return stats.servicePlansSold;
    default:
      return null;
  }
}

function renderHcpSection(dept, stats, jobs) {
  const tiles = dept.hcp.map((m) => tileFor(m.label, m.type, hcpValue(m.key, stats, jobs), m.target)).join("");
  const scope = isYtd(currentMonth)
    ? `every job from Jan 1 through the latest month with a P&L uploaded, ${ytdYear(currentMonth)}`
    : monthLabel(currentMonth);
  return sectionHtml("From Housecall Pro", `Live — same data as the rest of the site, scoped to this department and ${escapeHtml(scope)}.`, tiles);
}

function renderPnlSection(dept, pnl) {
  if (!pnl) {
    const msg = isYtd(currentMonth) ? "No P&L uploaded yet this year." : "No P&L uploaded for this month yet.";
    return sectionHtml("From the P&L", msg, "");
  }
  const inc = pnl.totalIncome || 0;
  // pnlMetricValue() (shared.js) does the "÷ Total Income, unless this
  // metric has its own non-pct type/compute()" branching — same helper a
  // second page uses, so a tile always means the same value everywhere.
  const tiles = dept.pnl.map((m) => tileFor(m.label, m.type || "pct", pnlMetricValue(m, pnl), m.target)).join("");
  const totalLabel = isYtd(currentMonth) ? "Total income year to date" : "Total income this month";
  return sectionHtml("From the P&L", `${totalLabel}: ${escapeHtml(formatMoney(inc))}.`, tiles);
}

function renderManualSection(dept, manual, stats, pnl) {
  const m = manual || {};
  const tiles = dept.manual
    .map((f) => {
      const value = f.compute ? f.compute(m, stats, pnl) : m[f.key];
      return tileFor(f.label, f.type, value === undefined ? null : value, f.target);
    })
    .join("");
  const note = isYtd(currentMonth)
    ? "From payroll and the department's own tracking. Hours/reviews/callbacks are summed across the months uploaded so far this year; headcount and attendance-style figures show the most recently entered month instead of a sum."
    : "From payroll and the department's own tracking — filled in monthly, not synced automatically.";
  return sectionHtml("Entered by hand", note, tiles);
}

function render() {
  if (!latestData || !currentMonth) return;

  const dept = DEPARTMENTS[currentDept];
  let jobs, pnlForDept, manualForDept;

  if (isYtd(currentMonth)) {
    const year = ytdYear(currentMonth);
    const yearPrefix = `${year}-`;
    const pnlMonthKeys = Object.keys(pnlData || {}).filter((mk) => mk.startsWith(yearPrefix)).sort();
    const [start, end] = ytdRange(year, pnlMonthKeys);
    jobs = (latestData.jobs || []).filter(
      (j) => businessUnitCode(j.business_unit) === currentDept && jobInRange(j, [start, end])
    );
    pnlForDept = sumPnl(pnlMonthKeys.map((mk) => pnlData[mk]?.[currentDept]).filter(Boolean));
    const manualMonthKeys = Object.keys(manualData || {}).filter((mk) => mk.startsWith(yearPrefix)).sort();
    const deptManualData = Object.fromEntries(manualMonthKeys.map((mk) => [mk, manualData[mk]?.[currentDept]]));
    manualForDept = aggregateManualYtd(manualMonthKeys, deptManualData);
  } else {
    jobs = (latestData.jobs || []).filter(
      (j) => businessUnitCode(j.business_unit) === currentDept && jobInMonth(j, currentMonth)
    );
    pnlForDept = (pnlData && pnlData[currentMonth] && pnlData[currentMonth][currentDept]) || null;
    manualForDept = (manualData && manualData[currentMonth] && manualData[currentMonth][currentDept]) || null;
  }

  const stats = computeScorecardStats(jobs, { splitRevenue: false });
  stats.nonMemberCount = jobs.filter((j) => !CANCELED_STATUSES.has(j.work_status) && hasTag(j, "Non-Member")).length;

  appEl.innerHTML = `
    <div class="scorecard-head">
      <h2 class="dept-name">${escapeHtml(dept.buLabel)}</h2>
      <p class="dept-sub">${escapeHtml(monthLabel(currentMonth))}</p>
    </div>
    ${renderHcpSection(dept, stats, jobs)}
    ${renderPnlSection(dept, pnlForDept)}
    ${renderManualSection(dept, manualForDept, stats, pnlForDept)}
  `;
}

async function loadData() {
  try {
    const [dashRes, pnlRes, manualRes] = await Promise.all([
      fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`data/pnl-monthly.json?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`data/manual-metrics.json?_=${Date.now()}`, { cache: "no-store" }),
    ]);
    if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status}`);
    latestData = await dashRes.json();
    pnlData = pnlRes.ok ? await pnlRes.json() : {};
    manualData = manualRes.ok ? await manualRes.json() : {};

    if (!monthSelect.options.length) populateMonthSelect();
    render();
    updateSyncStatus(latestData.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestData) {
      appEl.innerHTML = '<p class="empty">Could not load dashboard data yet.</p>';
    }
    console.error(err);
  }
}

populateDeptSelect();
deptSelect.addEventListener("change", () => {
  currentDept = deptSelect.value;
  render();
});
monthSelect.addEventListener("change", () => {
  currentMonth = monthSelect.value;
  render();
});

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
