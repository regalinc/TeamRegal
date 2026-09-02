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
//    from the actual P&L export (see scripts/ — no automated sync exists
//    for this yet; a human uploads it and the numbers get committed).
//  - Manual entries (data/manual-metrics.json) — paid hours, attendance,
//    callbacks, etc.: things that live in payroll or other spreadsheets
//    Housecall Pro has no way to know about. null until filled in.

// V1 is HVAC Service (BU 30) only — every other department's P&L data is
// already being captured (see pnl-monthly.json), but their KPI targets
// haven't been confirmed yet. Extending DEPARTMENTS below is the whole job
// once they are; nothing else about this page is BU-30-specific.
const DEPARTMENTS = {
  30: { name: "HVAC Service", buLabel: "30 HVAC Service" },
};

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

function populateMonthSelect() {
  const months = Object.keys(pnlData || {}).sort().reverse();
  monthSelect.innerHTML = months.map((m) => `<option value="${m}">${escapeHtml(monthLabel(m))}</option>`).join("");
  currentMonth = months[0] || null;
  if (currentMonth) monthSelect.value = currentMonth;
}

function monthLabel(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

// A specific calendar month, not one of shared.js's "today/this month/..."
// relative periods — periodRange() can't express "July 2026" once today has
// moved past it, which it always eventually will for a P&L month.
function monthRange(monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  return [new Date(y, m - 1, 1), new Date(y, m, 1)];
}

function jobInMonth(job, monthStr) {
  const sched = job.schedule?.scheduled_start;
  if (!sched) return false;
  const d = new Date(sched);
  if (Number.isNaN(d.getTime())) return false;
  const [start, end] = monthRange(monthStr);
  return d >= start && d < end;
}

// Same 15%-buffer three-tier grading every other page uses (tier() in
// shared.js) — a metric here reads the same way a job-tracking KPI does
// elsewhere on the site.
function pctTile(label, value, opts) {
  const pct = value === null || Number.isNaN(value) ? null : value * 100;
  const display = pct === null ? "—" : `${pct.toFixed(1)}%`;
  const t = pct === null || !opts ? null : tier(value, opts);
  return renderMiniStat(label, display, t);
}

function moneyTile(label, value, opts) {
  const display = value === null || value === undefined ? "—" : formatMoney(value);
  const t = value === null || value === undefined || !opts ? null : tier(value, opts);
  return renderMiniStat(label, display, t);
}

function countTile(label, value) {
  const display = value === null || value === undefined ? "—" : Number(value).toLocaleString();
  return renderMiniStat(label, display, null);
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

function renderHcpSection(jobs) {
  const stats = computeScorecardStats(jobs, { splitRevenue: false });
  const nonMemberJobs = jobs.filter((j) => !CANCELED_STATUSES.has(j.work_status) && hasTag(j, "Non-Member"));
  const clubPool = stats.servicePlansSold + nonMemberJobs.length;
  const clubConversion = clubPool ? stats.servicePlansSold / clubPool : null;

  return sectionHtml(
    "From Housecall Pro",
    "Live — same data as the rest of the site, scoped to this department and this calendar month.",
    [
      moneyTile("Avg ticket", stats.avgTicket, { goal: 450, direction: "min" }),
      pctTile("$0 Call", stats.totalJobs ? stats.ifo / stats.totalJobs : null, { goal: 0.05, direction: "max", buffer: 1 / 3 }),
      pctTile("Lead turnover", stats.totalJobs ? stats.leads / stats.totalJobs : null, { goal: 1 / 12, direction: "min" }),
      pctTile("Accessory sold", stats.totalJobs ? stats.accessorySold / stats.totalJobs : null, { goal: 1 / 8, direction: "min" }),
      pctTile("Club agreement conversion", clubConversion, { goal: 0.5, direction: "min" }),
    ].join("")
  );
}

function renderPnlSection(pnl) {
  if (!pnl) {
    return sectionHtml("From the P&L", "No P&L uploaded for this month yet.", "");
  }
  const inc = pnl.totalIncome || 0;
  const ratio = (n) => (inc ? n / inc : null);

  return sectionHtml(
    "From the P&L",
    `Total income this month: ${escapeHtml(formatMoney(inc))}.`,
    [
      pctTile("Gross margin", ratio(pnl.grossProfit), { goal: 0.6, direction: "min" }),
      pctTile("Labor to sales", ratio(pnl.laborCost), { goal: 0.22, direction: "max" }),
      pctTile("Materials/parts", ratio(pnl.partsCost), { goal: 0.13, direction: "max" }),
      pctTile("Subcontracts", ratio(pnl.subcontractCost), { goal: 0.005, direction: "max" }),
      pctTile("Commissions", ratio(pnl.commissionCost), { goal: 0.04, direction: "max" }),
      pctTile("Fringe benefits", ratio(pnl.fringeCost), { goal: 0.07, direction: "max" }),
      pctTile("Marketing", ratio(pnl.marketing), { goal: 0.03, direction: "max" }),
      pctTile("Employee related", ratio(pnl.employeeRelated), { goal: 0.15, direction: "max" }),
      pctTile("Plant & equipment", ratio(pnl.plantEquipment), { goal: 0.04, direction: "max" }),
      pctTile("Vehicle", ratio(pnl.vehicle), { goal: 0.04, direction: "max" }),
      pctTile("Administrative", ratio(pnl.administrative), { goal: 0.03, direction: "max" }),
      pctTile("Total SG&A", ratio(pnl.totalExpense), { goal: 0.45, direction: "max" }),
      pctTile("Pretax", ratio(pnl.netOrdinaryIncome), { goal: 0.1, direction: "min" }),
    ].join("")
  );
}

function renderManualSection(manual, jobStats) {
  const m = manual || {};
  const paidHours = m.paidHours || null;
  const billedHours = m.billedHours || null;
  const efficiency = paidHours && billedHours ? billedHours / paidHours : null;
  const productivity = paidHours ? jobStats.totalRevenue / paidHours : null;
  const callbackPct = m.callbackCount != null && jobStats.totalJobs ? m.callbackCount / jobStats.totalJobs : null;

  return sectionHtml(
    "Entered by hand",
    "From payroll and the department's own tracking — filled in monthly, not synced automatically.",
    [
      pctTile("Service efficiency", efficiency, { goal: 0.8, direction: "min" }),
      moneyTile("Productivity (GP/hr)", productivity, { goal: 150, direction: "min" }),
      pctTile("Attendance", m.attendancePct != null ? m.attendancePct : null, null),
      pctTile("Truck inventory accuracy", m.truckInventoryAccuracyPct != null ? m.truckInventoryAccuracyPct : null, null),
      countTile("Reviews generated", m.reviewsGenerated),
      pctTile("Callback rate", callbackPct, null),
    ].join("")
  );
}

function render() {
  if (!latestData || !currentMonth) return;

  const dept = DEPARTMENTS[currentDept];
  const jobs = (latestData.jobs || []).filter(
    (j) => businessUnitCode(j.business_unit) === currentDept && jobInMonth(j, currentMonth)
  );
  const stats = computeScorecardStats(jobs, { splitRevenue: false });

  const pnlMonth = (pnlData && pnlData[currentMonth]) || {};
  const manualMonth = (manualData && manualData[currentMonth]) || {};

  appEl.innerHTML = `
    <div class="scorecard-head">
      <h2 class="dept-name">${escapeHtml(dept.buLabel)}</h2>
      <p class="dept-sub">${escapeHtml(monthLabel(currentMonth))}</p>
    </div>
    ${renderHcpSection(jobs)}
    ${renderPnlSection(pnlMonth[currentDept])}
    ${renderManualSection(manualMonth[currentDept], stats)}
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
