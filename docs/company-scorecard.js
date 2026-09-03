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
    // Confirmed against a detailed BU 70-specific financial KPI list —
    // dropped the shared OVERHEAD_PNL_METRICS spread here since several of
    // its 7 ratios now have BU 70-specific numbers that differ from the
    // company-wide default (Marketing 5% not 3%, Vehicle 6% not 4%,
    // Plant & equipment 5% not 4%, Administration 4% not 3%, Total SG&A
    // 30-35% not 45%) — all 7 given explicitly so nothing is silently
    // half-overridden. Employee related (15%) and Pretax (10%) happen to
    // match the shared default anyway.
    pnl: [
      // "Margin % w/out support wages" — changes the existing Gross margin
      // target from a flat 50% to this chart's 48-50% band (floor: 48%),
      // same relabel/treatment as BU 10/50 (support wages already sit below
      // Gross Profit on the P&L, not in COGS, so it's the same number).
      // Flagging this as a real target change, not just an addition.
      { key: "grossProfit", label: "Margin % w/out support wages", target: { goal: 0.48, direction: "min" } },
      { key: "laborCost", label: "Labor to sales (non-burdened)", target: { goal: 0.21, direction: "max" } },
      // Service department — a hard 0% target (installs/replacements sell
      // the equipment, not Service), unlike BU 10/50's 35% ceiling.
      { key: "equipmentCost", label: "Equipment to sales", target: { goal: 0, direction: "max" } },
      { key: "partsCost", label: "Materials/parts to sales", target: { goal: 0.13, direction: "max" } },
      { key: "subcontractCost", label: "Subcontracts", target: { goal: 0.01, direction: "max" } },
      { key: "commissionCost", label: "Commissions", target: { goal: 0.08, direction: "max" } },
      { key: "fringeCost", label: "Allocated fringe benefits", target: { goal: 0.07, direction: "max" } },
      { key: "warranty", label: "Warranty", target: { goal: 0.005, direction: "max" } },
      // Buydowns' target is explicitly "N/A" on this chart — tracked (the
      // account is real and BU 70 posts to it some months) but shown
      // neutral rather than invented a threshold.
      { key: "buydowns", label: "Buydowns (financing)", target: null },
      // Not a % of sales — a same-P&L dollar comparison ($2 labor for every
      // $1 of parts). Uses the new "ratio" tile type, which skips the
      // ÷ income step renderPnlSection normally does.
      { key: "laborToPartsRatio", label: "Labor to parts ratio", type: "ratio", target: { goal: 2, direction: "min" }, compute: (pnl) => (pnl.partsCost ? pnl.laborCost / pnl.partsCost : null) },
      { key: "marketing", label: "Marketing", target: { goal: 0.05, direction: "max" } },
      { key: "employeeRelated", label: "Employee related (incl. support wages)", target: { goal: 0.15, direction: "max" } },
      { key: "vehicle", label: "Vehicle", target: { goal: 0.06, direction: "max" } },
      { key: "plantEquipment", label: "Plant & equipment", target: { goal: 0.05, direction: "max" } },
      { key: "administrative", label: "Administration", target: { goal: 0.04, direction: "max" } },
      { key: "totalExpense", label: "Total SG&A", target: { goal: 0.35, direction: "max" } },
      { key: "netOrdinaryIncome", label: "Pretax", target: { goal: 0.1, direction: "min" } },
    ],
    manual: [
      // Efficiency — the source chart's "with sales"/"without sales" split
      // turned out to be one metric, not two; collapsed back to a single
      // tile (billed÷paid) at the "with sales" target, which is the
      // formula/target pairing that was actually confirmed.
      { key: "efficiency", label: "Service efficiency", type: "pct", target: { goal: 0.75, direction: "min" }, compute: (m, s, pnl) => (m.paidHours && m.billedHours ? m.billedHours / m.paidHours : null) },
      // Productivity — GP/hr is the one confirmed target ($150/hr); the
      // "$150/day/tech" figure from the source chart turned out to be the
      // same target restated, not a second one, so no separate per-day
      // tile/input. Revenue/hr stays as its own tile (a different formula,
      // not a duplicate of GP/hr) — an earlier fix deliberately corrected
      // GP/hr away from revenue, so that one keeps Gross Profit specifically.
      { key: "productivity", label: "Productivity (GP/hr)", type: "money", target: { goal: 150, direction: "min" }, compute: (m, s, pnl) => (m.paidHours && pnl ? pnl.grossProfit / m.paidHours : null) },
      { key: "productivityRevenue", label: "Productivity (Revenue/hr, with sales)", type: "money", target: { goal: 60, direction: "min" }, compute: (m, s) => (m.paidHours ? s.totalRevenue / m.paidHours : null) },
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      { key: "truckInventoryAccuracyPct", label: "Truck inventory accuracy", type: "pct", target: null },
      { key: "reviewsGenerated", label: "Reviews generated", type: "count", target: null },
      { key: "callbackCount", label: "Callback rate", type: "pct", target: { goal: 0.015, direction: "max" }, compute: (m, s) => (m.callbackCount != null && s.totalJobs ? m.callbackCount / s.totalJobs : null) },
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
      // Headcount inputs — not yet collected for BU 70 (null until
      // payroll/fleet data is filled in, same "build it, leave it blank"
      // treatment as BU 10/50's headcount tiles).
      { key: "employeeCount", label: "Service employees", type: "count", target: null },
      { key: "revenuePerEmployee", label: "Revenue per employee", type: "money", target: { goal: 100000, direction: "min" }, compute: (m, s, pnl) => (m.employeeCount && pnl ? pnl.totalIncome / m.employeeCount : null) },
      // vehicleCount already exists above. Two numbers given here too
      // ("Min 100,000, target 120,000") — graded against the floor, same
      // convention as every other two-number target on this page.
      { key: "revenuePerVehicle", label: "Revenue per tech/vehicle", type: "money", target: { goal: 100000, direction: "min" }, compute: (m, s, pnl) => (m.vehicleCount && pnl ? pnl.totalIncome / m.vehicleCount : null) },
      { key: "supportCount", label: "Support staff", type: "count", target: null },
      { key: "productionCount", label: "Field/production staff", type: "count", target: null },
      // "1 support to 2 field production or greater" — read as production
      // staff should be at least 2x support staff, and labeled by that more
      // intuitive direction rather than the source's support:production
      // phrasing. Not confirmed who counts as "support" (dispatch/CSR?)
      // vs. "production" (apprentices included?) for Plumbing Service
      // specifically — the tile computes correctly either way once the
      // two counts above are filled in, but worth confirming the
      // definition before anyone starts entering numbers.
      { key: "productionToSupportRatio", label: "Production to support ratio", type: "ratio", target: { goal: 2, direction: "min" }, compute: (m) => (m.supportCount ? m.productionCount / m.supportCount : null) },
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

// "YTD-2026" is a synthetic month-select value (never a real key in
// pnl-monthly.json/manual-metrics.json) meaning "every month uploaded for
// 2026 so far" — one such option is offered per year that actually has at
// least one month of P&L data, newest year first.
function isYtd(monthStr) {
  return typeof monthStr === "string" && monthStr.startsWith("YTD-");
}
function ytdYear(monthStr) {
  return Number(monthStr.slice(4));
}

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

function monthLabel(monthStr) {
  if (isYtd(monthStr)) return `${ytdYear(monthStr)} year to date`;
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

// Adds every numeric field across a year's worth of monthly P&L objects —
// the resulting dollar sums flow through the exact same ÷ Total Income
// tile logic a single month uses, so no separate YTD-ratio math is needed.
function sumPnl(pnlMonthsForDept) {
  if (!pnlMonthsForDept.length) return null;
  const sums = {};
  for (const pnl of pnlMonthsForDept) {
    for (const [k, v] of Object.entries(pnl)) {
      if (typeof v === "number") sums[k] = (sums[k] || 0) + v;
    }
  }
  return sums;
}

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
  const tiles = dept.pnl
    .map((m) => {
      // Most P&L tiles are "this account ÷ Total Income." A metric with an
      // explicit non-"pct" type (e.g. BU 70's Labor-to-parts $ ratio) is a
      // same-P&L comparison between two accounts, not a share of sales —
      // its compute() returns the finished value directly, skipping the
      // ÷ income step entirely.
      if (m.type && m.type !== "pct") {
        const value = m.compute ? m.compute(pnl) : pnl[m.key];
        return tileFor(m.label, m.type, value, m.target);
      }
      const raw = m.compute ? m.compute(pnl) : pnl[m.key];
      return tileFor(m.label, "pct", inc && raw !== null && raw !== undefined ? raw / inc : null, m.target);
    })
    .join("");
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
