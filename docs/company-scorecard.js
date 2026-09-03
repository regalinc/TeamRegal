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
// rate — so DEPARTMENTS below is config-driven (a list of metric
// descriptors per section) rather than one hardcoded tile set applied to
// every BU. A target of `null` renders the tile with a real number but no
// color, for a metric that's tracked but doesn't have a confirmed target
// yet (see README for which ones and why).

// The 5 overhead ratios (Marketing/Employee Related/Plant & Equipment/
// Vehicle/Administrative) plus Total SG&A and Pretax come from the Chart of
// Accounts as company-wide policy targets, not a department-specific chart
// — applied identically to every department's P&L section rather than
// repeated per department below. Assumption flagged in the README: applying
// BU 30's overhead targets to every other BU hasn't been explicitly
// confirmed for those departments individually.
const OVERHEAD_PNL_METRICS = [
  { key: "marketing", label: "Marketing", target: { goal: 0.03, direction: "max" } },
  { key: "employeeRelated", label: "Employee related", target: { goal: 0.15, direction: "max" } },
  { key: "plantEquipment", label: "Plant & equipment", target: { goal: 0.04, direction: "max" } },
  { key: "vehicle", label: "Vehicle", target: { goal: 0.04, direction: "max" } },
  { key: "administrative", label: "Administrative", target: { goal: 0.03, direction: "max" } },
  { key: "totalExpense", label: "Total SG&A", target: { goal: 0.45, direction: "max" } },
  { key: "netOrdinaryIncome", label: "Pretax", target: { goal: 0.1, direction: "min" } },
];

// BU 10 (HVAC Installation) has its own detailed financial scorecard —
// confirmed account-by-account, replacing the earlier placeholder build that
// mirrored the generic Install pattern used by BU 30/70's "Parts and
// materials" combined tile. It no longer uses OVERHEAD_PNL_METRICS: 5 of its
// 6 shared ratios happen to match the company-wide defaults, but Marketing
// (4% here, not 3%) and Total SG&A (30%, not 45%) don't, and Pretax isn't on
// this department's chart at all — so all 6 are given explicitly below
// rather than half-spread/half-overridden. BU 50 has no chart of its own and
// mirrors this one exactly (see call site), same as before.
//
// A few items from the source list are deliberately left out rather than
// approximated:
//  - "All Forms of Unapplied Labor Expenses" — target is "None - in labor",
//    i.e. already folded into Labor to sales above; not a separate line.
//  - "Job Start-up Costs" and "Equipment Rentals" — confirmed not tracked as
//    their own accounts in QuickBooks; skipped rather than guessing at a
//    Chart of Accounts mapping.
//
// Every range target ("4-8%", "3-4%", "42-45%", etc.) is graded one-sided —
// green once you're under the ceiling (or, for the one margin figure, over
// the floor) — the same convention used everywhere else on this page, not
// true two-sided banding. A metric with zero activity this month (e.g. Sales
// salaries, if the account genuinely has nothing posted to it) will read as
// "green" under this convention even though $0 may not really be the goal.
function installDept(name, buLabel) {
  return {
    name,
    buLabel,
    hcp: [
      // "Average Sale per Job/Ticket (No Service Sales)" — assumes every job
      // tagged to this BU is already an install/replacement job, not a
      // service call, so no extra filtering beyond the existing per-BU scope
      // is needed. Flag if this BU's job data actually mixes the two.
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 15000, direction: "min" } },
    ],
    pnl: [
      { key: "laborCost", label: "Labor to sales (non-burdened)", target: { goal: 0.09, direction: "max" } },
      // Unlike BU 30/70's combined "Parts and materials" tile, this chart
      // gives Equipment (5002) and Materials/parts (5001) separate targets —
      // built as two tiles, not the old combined partsAndMaterials one.
      { key: "equipmentCost", label: "Equipment to sales", target: { goal: 0.35, direction: "max" } },
      { key: "partsCost", label: "Materials/parts to sales", target: { goal: 0.09, direction: "max" } },
      { key: "subcontractCost", label: "Subcontracts", target: { goal: 0.01, direction: "max" } },
      { key: "salesSalary", label: "Sales salaries", target: { goal: 0.04, direction: "max" } },
      { key: "commissionCost", label: "Commissions", target: { goal: 0.08, direction: "max" } },
      { key: "fringeCost", label: "Allocated fringe benefits", target: { goal: 0.04, direction: "max" } },
      { key: "warranty", label: "Warranty", target: { goal: 0.005, direction: "max" } },
      { key: "permits", label: "Permits", target: { goal: 0.005, direction: "max" } },
      { key: "buydowns", label: "Buydowns (financing)", target: { goal: 0.02, direction: "max" } },
      { key: "warrantyLabor", label: "Warranty parts-labor", target: { goal: 0.02, direction: "max" } },
      // "Margin % w/out support wages" — support/admin wages (6022) sit in
      // Expenses, below Gross Profit, not in COGS, so the P&L's existing
      // Gross Profit figure already excludes them. Treated as the same
      // number as every other department's "Gross margin" tile, just
      // relabeled and given this chart's tighter 42-45% band (floor: 42%).
      { key: "grossProfit", label: "Margin % w/out support wages", target: { goal: 0.42, direction: "min" } },
      { key: "marketing", label: "Marketing", target: { goal: 0.04, direction: "max" } },
      { key: "employeeRelated", label: "Employee related", target: { goal: 0.15, direction: "max" } },
      { key: "vehicle", label: "Vehicle", target: { goal: 0.04, direction: "max" } },
      { key: "plantEquipment", label: "Plant & equipment", target: { goal: 0.04, direction: "max" } },
      { key: "administrative", label: "Administration", target: { goal: 0.03, direction: "max" } },
      { key: "totalExpense", label: "Total SG&A", target: { goal: 0.3, direction: "max" } },
    ],
    manual: [
      // Headcount inputs — not yet in manual-metrics.json (null until
      // payroll/fleet data is filled in). Shown as their own count tiles too
      // so it's clear what denominator each Revenue-per-X figure is using,
      // not just the derived dollar amount.
      { key: "employeeCount", label: "Service employees", type: "count", target: null },
      { key: "vehicleCount", label: "Techs / vehicles", type: "count", target: null },
      { key: "crewCount", label: "Install crews (2-man)", type: "count", target: null },
      { key: "revenuePerEmployee", label: "Revenue per employee", type: "money", target: { goal: 400000, direction: "min" }, compute: (m, s, pnl) => (m.employeeCount && pnl ? pnl.totalIncome / m.employeeCount : null) },
      // Source gives two numbers here — "Min 400,000, target 600,000" — a
      // floor and a stretch goal. Graded against the floor, same convention
      // as every other range on this chart; 600k is the stretch, not wired in.
      { key: "revenuePerVehicle", label: "Revenue per tech/vehicle", type: "money", target: { goal: 400000, direction: "min" }, compute: (m, s, pnl) => (m.vehicleCount && pnl ? pnl.totalIncome / m.vehicleCount : null) },
      { key: "revenuePerCrew", label: "Revenue per install crew", type: "money", target: { goal: 2500000, direction: "min" }, compute: (m, s, pnl) => (m.crewCount && pnl ? pnl.totalIncome / m.crewCount : null) },
    ],
  };
}

const DEPARTMENTS = {
  30: {
    name: "HVAC Service",
    buLabel: "30 HVAC Service",
    hcp: [
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 450, direction: "min" } },
      { key: "zeroCall", label: "$0 Call", type: "pct", target: { goal: 0.05, direction: "max", buffer: 1 / 3 } },
      { key: "leadTurnover", label: "Lead turnover", type: "pct", target: { goal: 1 / 12, direction: "min" } },
      { key: "accessorySold", label: "Accessory sold", type: "pct", target: { goal: 1 / 8, direction: "min" } },
      { key: "clubConversion", label: "Club agreement conversion", type: "pct", target: { goal: 0.5, direction: "min" } },
    ],
    pnl: [
      { key: "grossProfit", label: "Gross margin", target: { goal: 0.6, direction: "min" } },
      { key: "laborCost", label: "Labor to sales", target: { goal: 0.22, direction: "max" } },
      { key: "partsCost", label: "Materials/parts", target: { goal: 0.13, direction: "max" } },
      { key: "subcontractCost", label: "Subcontracts", target: { goal: 0.005, direction: "max" } },
      { key: "commissionCost", label: "Commissions", target: { goal: 0.04, direction: "max" } },
      { key: "fringeCost", label: "Fringe benefits", target: { goal: 0.07, direction: "max" } },
      ...OVERHEAD_PNL_METRICS,
    ],
    manual: [
      { key: "efficiency", label: "Service efficiency", type: "pct", target: { goal: 0.8, direction: "min" }, compute: (m, s, pnl) => (m.paidHours && m.billedHours ? m.billedHours / m.paidHours : null) },
      // Gross Profit ÷ paid hours — was wrongly using Housecall Pro revenue
      // here instead of the P&L's actual Gross Profit; revenue and gross
      // profit are not the same number (revenue minus COGS), and the target
      // ($150/hr) was set against GP, not raw revenue. pnl is undefined for
      // a month with no P&L uploaded yet, same "no data" neutral tile as
      // every other P&L-sourced value.
      { key: "productivity", label: "Productivity (GP/hr)", type: "money", target: { goal: 150, direction: "min" }, compute: (m, s, pnl) => (m.paidHours && pnl ? pnl.grossProfit / m.paidHours : null) },
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      { key: "truckInventoryAccuracyPct", label: "Truck inventory accuracy", type: "pct", target: null },
      { key: "reviewsGenerated", label: "Reviews generated", type: "count", target: null },
      { key: "callbackCount", label: "Callback rate", type: "pct", target: null, compute: (m, s) => (m.callbackCount != null && s.totalJobs ? m.callbackCount / s.totalJobs : null) },
      // Tracked for the whole company, but only BU 10/50's KPI chart pairs
      // this with a Revenue-per-vehicle target — shown here as a plain
      // count, same as Reviews generated, rather than inventing a ratio.
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
    ],
  },
  40: {
    name: "HVAC Maintenance",
    buLabel: "40 HVAC Maintenance",
    hcp: [
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 250, direction: "min" } },
      // BU 40's chart frames this as new-vs-renewal, not a flat conversion
      // rate — Housecall Pro's new-vs-renewal distinction isn't confirmed
      // yet (see README), so this is the same conversion math as BU 30's
      // shown with no target until that's resolved, as a placeholder.
      { key: "clubConversion", label: "Club agreement conversion", type: "pct", target: null },
      { key: "totalClubAgreements", label: "Total club agreements", type: "count", target: null },
    ],
    pnl: [
      // No BU 40-specific Gross margin/Labor/Materials target was given —
      // shown for visibility, colored once one is confirmed.
      { key: "grossProfit", label: "Gross margin", target: null },
      { key: "laborCost", label: "Labor to sales", target: null },
      { key: "partsCost", label: "Materials/parts", target: null },
      { key: "subcontractCost", label: "Subcontracts", target: null },
      { key: "commissionCost", label: "Commissions", target: null },
      { key: "fringeCost", label: "Fringe benefits", target: null },
      ...OVERHEAD_PNL_METRICS,
    ],
    manual: [
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      // Yearly direct-mail campaign, not a monthly number — filled in
      // whenever that year's campaign wraps, may sit unchanged most months.
      { key: "ptuConversionPct", label: "PTU conversion", type: "pct", target: { goal: 0.6, direction: "min" } },
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
    ],
  },
  70: {
    name: "Plumbing Service",
    buLabel: "70 Plumbing Service",
    hcp: [
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 850, direction: "min" } },
      { key: "zeroCall", label: "$0 Call", type: "pct", target: { goal: 0.05, direction: "max", buffer: 1 / 3 } },
      { key: "clubConversion", label: "Club agreement conversion", type: "pct", target: { goal: 0.5, direction: "min" } },
      // No Lead turnover/Accessory sold on Plumbing Service's own KPI chart
      // — those are HVAC Service-specific, not carried over here.
    ],
    pnl: [
      // Plumbing's chart gives Gross margin its own bar (50%, lower than
      // HVAC Service's 60%) but no Plumbing-specific Labor/Materials/
      // Subcontract/Commission/Fringe numbers — those stay neutral here
      // until confirmed, same treatment as BU 40's unconfirmed ones.
      { key: "grossProfit", label: "Gross margin", target: { goal: 0.5, direction: "min" } },
      { key: "laborCost", label: "Labor to sales", target: null },
      { key: "partsCost", label: "Materials/parts", target: null },
      { key: "subcontractCost", label: "Subcontracts", target: null },
      { key: "commissionCost", label: "Commissions", target: null },
      { key: "fringeCost", label: "Fringe benefits", target: null },
      ...OVERHEAD_PNL_METRICS,
    ],
    manual: [
      // Service efficiency's 80% target came from the BU 30-detail chart
      // framed generically as "Svc Dept," not confirmed as applying to
      // Plumbing specifically — left neutral rather than assumed.
      { key: "efficiency", label: "Service efficiency", type: "pct", target: null, compute: (m, s, pnl) => (m.paidHours && m.billedHours ? m.billedHours / m.paidHours : null) },
      { key: "productivity", label: "Productivity (GP/hr)", type: "money", target: { goal: 150, direction: "min" }, compute: (m, s, pnl) => (m.paidHours && pnl ? pnl.grossProfit / m.paidHours : null) },
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      { key: "truckInventoryAccuracyPct", label: "Truck inventory accuracy", type: "pct", target: null },
      { key: "reviewsGenerated", label: "Reviews generated", type: "count", target: null },
      { key: "callbackCount", label: "Callback rate", type: "pct", target: { goal: 0.015, direction: "max" }, compute: (m, s) => (m.callbackCount != null && s.totalJobs ? m.callbackCount / s.totalJobs : null) },
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
    ],
  },
  80: {
    name: "Plumbing Maintenance",
    buLabel: "80 Plumbing Maintenance",
    hcp: [
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 250, direction: "min" } },
      // 2B's chart asks for the raw count only ("overall"), not a
      // conversion rate — unlike BU 40's new-vs-renewal framing, there's no
      // synthetic conversion tile to approximate here.
      { key: "totalClubAgreements", label: "Total club agreements", type: "count", target: null },
    ],
    pnl: [
      // 2B's chart has no P&L line items at all (no Gross margin, Labor,
      // etc.) — every non-overhead ratio here is neutral until a target's
      // actually given for this department.
      { key: "grossProfit", label: "Gross margin", target: null },
      { key: "laborCost", label: "Labor to sales", target: null },
      { key: "partsCost", label: "Materials/parts", target: null },
      { key: "subcontractCost", label: "Subcontracts", target: null },
      { key: "commissionCost", label: "Commissions", target: null },
      { key: "fringeCost", label: "Fringe benefits", target: null },
      ...OVERHEAD_PNL_METRICS,
    ],
    manual: [
      // No Service efficiency/Productivity on 2B's chart at all — same
      // "Maintenance" pattern as BU 40, which also skips the hours-based
      // metrics that only the "Service" departments (30, 70) have.
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      { key: "reviewsGenerated", label: "Reviews generated", type: "count", target: null },
      // No explicit callback target for 2B (unlike Plumbing Service's
      // confirmed <1.5%) — tracked, not yet colored.
      { key: "callbackCount", label: "Callback rate", type: "pct", target: null, compute: (m, s) => (m.callbackCount != null && s.totalJobs ? m.callbackCount / s.totalJobs : null) },
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
    ],
  },
  10: installDept("HVAC Installation", "10 HVAC Installation"),
  // There's no separate Plumbing Installation KPI chart — the source for
  // this detailed set was confirmed as BU 10 (HVAC) specifically. This
  // mirrors BU 10's config exactly (same metric shapes and targets, applied
  // to the other install department, each against its own P&L and its own
  // manual headcount entries) rather than inventing different numbers —
  // flag if Plumbing Installation should actually have its own.
  50: installDept("Plumbing Installation", "50 Plumbing Installation"),
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

function tileFor(label, type, value, target) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return renderMiniStat(label, "—", null);
  }
  const t = target ? tier(value, target) : null;
  if (type === "pct") return renderMiniStat(label, `${(value * 100).toFixed(1)}%`, t);
  if (type === "money") return renderMiniStat(label, formatMoney(value), t);
  return renderMiniStat(label, Number(value).toLocaleString(), t);
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
  return sectionHtml("From Housecall Pro", "Live — same data as the rest of the site, scoped to this department and this calendar month.", tiles);
}

function renderPnlSection(dept, pnl) {
  if (!pnl) return sectionHtml("From the P&L", "No P&L uploaded for this month yet.", "");
  const inc = pnl.totalIncome || 0;
  const tiles = dept.pnl
    .map((m) => {
      const raw = m.compute ? m.compute(pnl) : pnl[m.key];
      return tileFor(m.label, "pct", inc && raw !== null ? raw / inc : null, m.target);
    })
    .join("");
  return sectionHtml("From the P&L", `Total income this month: ${escapeHtml(formatMoney(inc))}.`, tiles);
}

function renderManualSection(dept, manual, stats, pnl) {
  const m = manual || {};
  const tiles = dept.manual
    .map((f) => {
      const value = f.compute ? f.compute(m, stats, pnl) : m[f.key];
      return tileFor(f.label, f.type, value === undefined ? null : value, f.target);
    })
    .join("");
  return sectionHtml("Entered by hand", "From payroll and the department's own tracking — filled in monthly, not synced automatically.", tiles);
}

function render() {
  if (!latestData || !currentMonth) return;

  const dept = DEPARTMENTS[currentDept];
  const jobs = (latestData.jobs || []).filter(
    (j) => businessUnitCode(j.business_unit) === currentDept && jobInMonth(j, currentMonth)
  );
  const stats = computeScorecardStats(jobs, { splitRevenue: false });
  stats.nonMemberCount = jobs.filter((j) => !CANCELED_STATUSES.has(j.work_status) && hasTag(j, "Non-Member")).length;

  const pnlMonth = (pnlData && pnlData[currentMonth]) || {};
  const manualMonth = (manualData && manualData[currentMonth]) || {};

  appEl.innerHTML = `
    <div class="scorecard-head">
      <h2 class="dept-name">${escapeHtml(dept.buLabel)}</h2>
      <p class="dept-sub">${escapeHtml(monthLabel(currentMonth))}</p>
    </div>
    ${renderHcpSection(dept, stats, jobs)}
    ${renderPnlSection(dept, pnlMonth[currentDept])}
    ${renderManualSection(dept, manualMonth[currentDept], stats, pnlMonth[currentDept])}
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
