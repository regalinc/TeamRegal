// Per-department metric/target config — the single source of truth for
// what each business unit's scorecard tracks and what "good" means for it.
// Originally lived inside company-scorecard.js; pulled out so a second page
// (an internal matrix/comparison view) can read the exact same targets
// without copying numbers into a second place that could drift out of sync.
// Loaded before company-scorecard.js (and before that other page's script)
// — both just reference the globals this file defines.
//
// Each department entry has three metric-descriptor lists:
//  - hcp: sourced from live Housecall Pro job data (computeScorecardStats).
//  - pnl: sourced from data/pnl-monthly.json, each ratio's value ÷ Total
//    Income unless the descriptor gives its own non-"pct" `type` (see BU
//    70's Labor-to-parts ratio) with its own `compute(pnl)`.
//  - manual: sourced from data/manual-metrics.json (payroll/tracking data
//    with no Housecall Pro or P&L equivalent), each optionally computed via
//    `compute(manual, stats, pnl)`.
// A `target` of `null` means "tracked, no confirmed threshold yet" — still
// shown, just uncolored. See README for which targets are confirmed vs.
// assumed, and why.

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
      // Reconciled against admin.html's separate (and until now, stale)
      // kpiTier coloring, which had this at 7.5% while this chart still said
      // 5% — 7.5% confirmed as the real target; both pages now grade off
      // this one number instead of two different ones.
      { key: "zeroCall", label: "$0 Call", type: "pct", target: { goal: 0.075, direction: "max", buffer: 1 / 3 } },
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
      // "Average Sale per service invoice, with sales of techs included" —
      // $250, confirmed against a detailed BU 40 chart: matches the
      // existing target exactly, no change.
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 250, direction: "min" } },
      // BU 40's chart frames this as new-vs-renewal, not a flat conversion
      // rate — Housecall Pro's new-vs-renewal distinction isn't confirmed
      // yet (see README), so this is the same conversion math as BU 30's
      // shown with no target until that's resolved, as a placeholder.
      { key: "clubConversion", label: "Club agreement conversion", type: "pct", target: null },
      { key: "totalClubAgreements", label: "Total club agreements", type: "count", target: null },
    ],
    // Combined with a detailed BU 40-specific financial KPI list — additive,
    // not a replacement, same treatment as BU 70. The 6 shared overhead
    // ratios (Marketing/Employee related/Vehicle/Plant & equipment/
    // Administrative/Total SG&A) plus Pretax weren't mentioned on this
    // chart at all, so OVERHEAD_PNL_METRICS' company-wide defaults stay as
    // they were — Pretax's 10% there already matches this chart's own
    // "10% or greater" exactly.
    pnl: [
      // No BU 40-specific Gross margin target was given — shown for
      // visibility, colored once one is confirmed.
      { key: "grossProfit", label: "Gross margin", target: null },
      { key: "laborCost", label: "Labor to sales (non-burdened)", target: { goal: 0.34, direction: "max" } },
      // "None" on this chart — read the same as BU 70's hard 0% (a
      // Maintenance department doesn't sell equipment; Install does).
      { key: "equipmentCost", label: "Equipment to sales", target: { goal: 0, direction: "max" } },
      { key: "partsCost", label: "Materials/parts", target: { goal: 0.06, direction: "max" } },
      { key: "subcontractCost", label: "Subcontracts", target: null },
      { key: "commissionCost", label: "Commissions", target: null },
      { key: "fringeCost", label: "Fringe benefits", target: null },
      // Not a % of sales — a same-P&L dollar comparison ($1 labor for
      // every $1 of parts). Same "ratio" tile type as BU 70's Labor-to-
      // parts, a tighter confirmed ratio here (1.0, not 2.0).
      { key: "laborToPartsRatio", label: "Labor to parts ratio", type: "ratio", target: { goal: 1, direction: "min" }, compute: (pnl) => (pnl.partsCost ? pnl.laborCost / pnl.partsCost : null) },
      ...OVERHEAD_PNL_METRICS,
    ],
    manual: [
      { key: "attendancePct", label: "Attendance", type: "pct", target: null },
      // Yearly direct-mail campaign, not a monthly number — filled in
      // whenever that year's campaign wraps, may sit unchanged most months.
      { key: "ptuConversionPct", label: "PTU conversion", type: "pct", target: { goal: 0.6, direction: "min" } },
      { key: "vehicleCount", label: "Vehicles", type: "count", target: null },
      // Only a "no sales" Efficiency variant given for this department
      // (paid÷billed) — unlike BU 70's two variants, which turned out to
      // be one metric read two ways, this is the only one on this chart.
      // Needs its own paidHours/billedHours, not yet collected for BU 40.
      { key: "paidHours", label: "Paid hours", type: "count", target: null },
      { key: "billedHours", label: "Billed hours", type: "count", target: null },
      { key: "efficiencyNoSales", label: "Service efficiency (no sales)", type: "pct", target: { goal: 0.8, direction: "min" }, compute: (m) => (m.paidHours && m.billedHours ? m.paidHours / m.billedHours : null) },
      // GP $ per PTU specialist per day — a distinct metric from Service's
      // GP/hr Productivity tile (which this department doesn't have at
      // all), not a units-confused duplicate like BU 70's per-day figure
      // turned out to be. Needs a new "PTU tech-days" input, not yet
      // collected.
      { key: "ptuTechDays", label: "PTU specialist tech-days", type: "count", target: null },
      { key: "gpPerPtuTechDay", label: "GP per PTU specialist tech-day", type: "money", target: { goal: 150, direction: "min" }, compute: (m, s, pnl) => (m.ptuTechDays && pnl ? pnl.grossProfit / m.ptuTechDays : null) },
      // Revenue per employee is explicitly a Service+Maintenance *combined*
      // figure on this chart ("Service & maint together") — needs BU 30's
      // P&L too, not just this department's own, via resolvePnlForDept()
      // (company-scorecard.js). One shared headcount number entered here,
      // not split per department, since techs work both service and
      // maintenance calls.
      { key: "employeeCount", label: "Service employees (Svc + Maint combined)", type: "count", target: null },
      {
        key: "revenuePerEmployee",
        label: "Revenue per employee (Svc + Maint combined)",
        type: "money",
        target: { goal: 100000, direction: "min" },
        compute: (m, s, pnl) => {
          if (!m.employeeCount || !pnl) return null;
          const svcPnl = resolvePnlForDept("30");
          return svcPnl ? (pnl.totalIncome + svcPnl.totalIncome) / m.employeeCount : null;
        },
      },
      { key: "revenuePerVehicle", label: "Revenue per tech/vehicle", type: "money", target: { goal: 80000, direction: "min" }, compute: (m, s, pnl) => (m.vehicleCount && pnl ? pnl.totalIncome / m.vehicleCount : null) },
      { key: "supportCount", label: "Support staff", type: "count", target: null },
      { key: "productionCount", label: "Field/production staff", type: "count", target: null },
      // "1 to 3 ratio (.33 or less)" — same direction as BU 70's
      // Production-to-support ratio (production ÷ support), a different
      // confirmed number (3, not 2): 1:3 support:production is the same
      // statement as production:support >= 3.
      { key: "productionToSupportRatio", label: "Production to support ratio", type: "ratio", target: { goal: 3, direction: "min" }, compute: (m) => (m.supportCount ? m.productionCount / m.supportCount : null) },
    ],
  },
  70: {
    name: "Plumbing Service",
    buLabel: "70 Plumbing Service",
    hcp: [
      // Reconciled against admin.html's separate (and until now, stale)
      // kpiTier coloring, which had this at $500 while this chart still
      // said $850 — $500 confirmed as the real target.
      { key: "avgTicket", label: "Avg ticket", type: "money", target: { goal: 500, direction: "min" } },
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
