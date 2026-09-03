// Department Scorecard — matrix view. A second, unlisted page alongside
// company-scorecard.html: same data, same DEPARTMENTS targets (both load
// departments-config.js), same tier()/pnlMetricValue()/YTD helpers from
// shared.js — just laid out as departments-in-columns / ratios-in-rows
// instead of one department's cards at a time, so a manager can scan a row
// to compare every department on one ratio, or a column for one
// department's full picture.
//
// Deliberately NOT linked from index.html/admin.html/company-scorecard.html
// nav, and this filename isn't guessable — the only real protection that
// gives is against casual URL guessing, not against anyone who browses the
// public GitHub repo directly (flagged to the user before this was built).

const DEPT_META = {
  10: { name: "HVAC Installation", accent: "--dept-10" },
  30: { name: "HVAC Service", accent: "--dept-30" },
  40: { name: "HVAC Maintenance", accent: "--dept-40" },
  50: { name: "Plumbing Installation", accent: "--dept-50" },
  70: { name: "Plumbing Service", accent: "--dept-70" },
  80: { name: "Plumbing Maintenance", accent: "--dept-80" },
};
const DEPT_ORDER = ["10", "30", "40", "50", "70", "80"];

// Canonical row label + group + order for every pnl-array key seen across
// DEPARTMENTS — a department's own label/type/target still drives each of
// its own cells (via departments-config.js), this just decides where the
// row sits and what to call it in the shared left column. A key that shows
// up in a department's pnl config but isn't listed here falls into "Other"
// automatically, so a future new metric can't silently vanish from the page.
const ROW_ORDER = [
  { group: "Profitability", keys: ["grossProfit"] },
  {
    group: "Direct cost ratios",
    keys: [
      "laborCost", "equipmentCost", "partsCost", "subcontractCost", "salesSalary",
      "commissionCost", "fringeCost", "warranty", "permits", "buydowns",
      "warrantyLabor", "laborToPartsRatio",
    ],
  },
  { group: "Overhead", keys: ["marketing", "employeeRelated", "vehicle", "plantEquipment", "administrative"] },
  { group: "Total", keys: ["totalExpense", "netOrdinaryIncome"] },
];
const ROW_LABELS = {
  grossProfit: "Gross margin", laborCost: "Labor to sales", equipmentCost: "Equipment to sales",
  partsCost: "Materials/parts", subcontractCost: "Subcontracts", salesSalary: "Sales salaries",
  commissionCost: "Commissions", fringeCost: "Fringe benefits", warranty: "Warranty",
  permits: "Permits", buydowns: "Buydowns", warrantyLabor: "Warranty parts-labor",
  laborToPartsRatio: "Labor to parts ratio", marketing: "Marketing", employeeRelated: "Employee related",
  vehicle: "Vehicle", plantEquipment: "Plant & equipment", administrative: "Administrative",
  totalExpense: "Total SG&A", netOrdinaryIncome: "Pretax",
};

// A second, much narrower row set sourced from each department's `manual`
// list (data/manual-metrics.json) instead of `pnl` — deliberately curated,
// not a "every manual key" union like ROW_ORDER: most manual fields
// (attendance, reviews generated, paid hours...) are single-department
// tracking with no cross-department comparison value. Revenue-per-X figures
// are the exception — genuinely comparable dollars-per-headcount-unit
// across departments, which is exactly what this page is for.
const MANUAL_ROW_ORDER = [
  { group: "Revenue efficiency", keys: ["revenuePerEmployee", "revenuePerVehicle", "revenuePerCrew"] },
];
const MANUAL_ROW_LABELS = {
  revenuePerEmployee: "Revenue per employee",
  revenuePerVehicle: "Revenue per tech/vehicle",
  revenuePerCrew: "Revenue per install crew",
};

let pnlData = null;
let manualData = null;
let currentMonth = null;

function buildRowList() {
  const seenKeys = new Set();
  for (const code of DEPT_ORDER) {
    for (const m of DEPARTMENTS[code].pnl) seenKeys.add(m.key);
  }
  const groups = ROW_ORDER.map((g) => ({ ...g, keys: g.keys.filter((k) => seenKeys.has(k)) })).filter((g) => g.keys.length);
  const orderedKeys = new Set(groups.flatMap((g) => g.keys));
  const leftover = [...seenKeys].filter((k) => !orderedKeys.has(k));
  if (leftover.length) groups.push({ group: "Other", keys: leftover });
  return groups;
}

// Same idea as buildRowList(), scoped to MANUAL_ROW_ORDER's curated keys
// only — no "Other" catch-all here, since most manual keys are
// intentionally excluded, not accidentally missing.
function buildManualRowList() {
  const seenKeys = new Set();
  for (const code of DEPT_ORDER) {
    for (const m of DEPARTMENTS[code].manual) seenKeys.add(m.key);
  }
  return MANUAL_ROW_ORDER.map((g) => ({ ...g, keys: g.keys.filter((k) => seenKeys.has(k)) })).filter((g) => g.keys.length);
}

function populateMonthSelect() {
  const sel = document.getElementById("month-select");
  const months = Object.keys(pnlData || {}).sort().reverse();
  const years = [...new Set(months.map((m) => m.slice(0, 4)))];
  const options = years.flatMap((year) => [
    { value: `YTD-${year}`, label: `${year} Year to date` },
    ...months.filter((m) => m.startsWith(year)).map((m) => ({ value: m, label: monthLabel(m) })),
  ]);
  sel.innerHTML = options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join("");
  currentMonth = months[0] || null;
  if (currentMonth) sel.value = currentMonth;
}

// Resolves the P&L object each department should be graded against for the
// currently selected period — a single month's object as-is, or every
// matching year's month summed via shared.js's sumPnl() for YTD.
function pnlForDept(deptCode) {
  if (isYtd(currentMonth)) {
    const yearPrefix = `${ytdYear(currentMonth)}-`;
    const months = Object.keys(pnlData || {}).filter((mk) => mk.startsWith(yearPrefix)).sort();
    return sumPnl(months.map((mk) => pnlData[mk]?.[deptCode]).filter(Boolean));
  }
  return (pnlData && pnlData[currentMonth] && pnlData[currentMonth][deptCode]) || null;
}
// Some departments' compute() functions (from departments-config.js) call
// resolvePnlForDept() by that exact global name to reach another
// department's P&L — e.g. BU 40's Revenue per employee, a confirmed
// Service+Maintenance combined figure. That function is defined in
// company-scorecard.js, which this page doesn't load — this alias gives
// the same name the same meaning here too, so the identical compute()
// closure works unmodified on both pages.
const resolvePnlForDept = pnlForDept;

// Same idea as pnlForDept(), for a department's `manual` data
// (data/manual-metrics.json) — single month as-is, or YTD-aggregated via
// shared.js's aggregateManualYtd() (sums flow-type fields, takes the most
// recent value for headcount/attendance-style ones).
function manualForDept(deptCode) {
  if (isYtd(currentMonth)) {
    const yearPrefix = `${ytdYear(currentMonth)}-`;
    const monthKeys = Object.keys(manualData || {}).filter((mk) => mk.startsWith(yearPrefix)).sort();
    const deptManualData = Object.fromEntries(monthKeys.map((mk) => [mk, manualData[mk]?.[deptCode]]));
    return aggregateManualYtd(monthKeys, deptManualData);
  }
  return (manualData && manualData[currentMonth] && manualData[currentMonth][deptCode]) || null;
}

function formatTargetCaption(type, target) {
  if (!target) return null;
  const symbol = target.direction === "min" ? "≥" : "≤";
  let goalStr;
  if (type === "pct") goalStr = `${(target.goal * 100).toFixed(1)}%`;
  else if (type === "money") goalStr = formatMoney(target.goal);
  else if (type === "ratio") goalStr = `${target.goal.toFixed(1)}:1`;
  else goalStr = Number(target.goal).toLocaleString();
  return goalStr ? `Target ${symbol} ${goalStr}` : null;
}

function formatValue(type, value) {
  if (type === "pct") return `${(value * 100).toFixed(1)}%`;
  if (type === "money") return formatMoney(value);
  if (type === "ratio") return `${value.toFixed(1)}:1`;
  return Number(value).toLocaleString();
}

// A single row-key/deptCode cell: looks up that department's own metric
// definition for this key (label/type/target/compute), or renders a
// "not tracked" neutral cell if that department's chart never had this
// ratio on it at all — distinct wording from "tracked but no target yet".
function cellFor(rowKey, deptCode, pnl) {
  const metric = DEPARTMENTS[deptCode].pnl.find((m) => m.key === rowKey);
  if (!metric) return { tier: "neutral", valueStr: "—", captionStr: "Not tracked" };
  const type = metric.type || "pct";
  const value = pnlMetricValue(metric, pnl);
  const caption = formatTargetCaption(type, metric.target) || "No target set";
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { tier: "neutral", valueStr: "—", captionStr: caption };
  }
  const t = metric.target ? tier(value, metric.target) : "neutral";
  return { tier: t, valueStr: formatValue(type, value), captionStr: caption };
}

// Same shape as cellFor(), for a manual-list metric — the value is
// whatever that metric's own compute(manual, stats, pnl) returns directly
// (no stats section on this page, so `null` in that slot; every
// Revenue-per-X compute() ignores it anyway), not a ÷ income ratio.
function cellForManual(rowKey, deptCode, manual, pnl) {
  const metric = DEPARTMENTS[deptCode].manual.find((m) => m.key === rowKey);
  if (!metric) return { tier: "neutral", valueStr: "—", captionStr: "Not tracked" };
  const type = metric.type || "count";
  const value = metric.compute ? metric.compute(manual || {}, null, pnl) : (manual || {})[rowKey];
  const caption = formatTargetCaption(type, metric.target) || "No target set";
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { tier: "neutral", valueStr: "—", captionStr: caption };
  }
  const t = metric.target ? tier(value, metric.target) : "neutral";
  return { tier: t, valueStr: formatValue(type, value), captionStr: caption };
}

function renderHeader() {
  const row = document.getElementById("header-row");
  row.innerHTML = '<th class="row-label">KPI</th>';
  for (const code of DEPT_ORDER) {
    const dept = DEPARTMENTS[code];
    const pnl = pnlForDept(code);
    const rev = pnl ? formatMoney(pnl.totalIncome || 0) : "—";
    const th = document.createElement("th");
    th.className = "dept-th";
    th.style.setProperty("--dept-accent", `var(${DEPT_META[code].accent})`);
    th.innerHTML = `
      <div><span class="dept-dot"></span><span class="dept-code">BU ${escapeHtml(code)}</span></div>
      <div class="dept-name">${escapeHtml(dept.name)}</div>
      <div class="dept-rev num">${escapeHtml(rev)} rev.</div>
    `;
    row.appendChild(th);
  }
}

// Appends one section's group-divider + data rows into #matrix-body.
// `label`/`cellOf` abstract over the two row kinds (pnl-sourced vs.
// manual-sourced) so the actual DOM-building code is written once.
function appendRowGroups(body, rowGroups, labelOf, cellOf) {
  for (const group of rowGroups) {
    const groupTr = document.createElement("tr");
    groupTr.className = "group-row";
    groupTr.innerHTML = `<td colspan="${DEPT_ORDER.length + 1}">${escapeHtml(group.group)}</td>`;
    body.appendChild(groupTr);

    for (const key of group.keys) {
      const tr = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.className = "row-label";
      labelTd.textContent = labelOf(key);
      tr.appendChild(labelTd);

      for (const code of DEPT_ORDER) {
        const c = cellOf(key, code);
        const td = document.createElement("td");
        td.className = `cell tier-${c.tier}`;
        td.innerHTML = `<div class="cell-inner"><span class="cell-value num">${escapeHtml(c.valueStr)}</span><span class="cell-target num">${escapeHtml(c.captionStr)}</span></div>`;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }
}

function renderBody(pnlRowGroups, manualRowGroups) {
  const body = document.getElementById("matrix-body");
  body.innerHTML = "";
  const pnlByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, pnlForDept(c)]));
  const manualByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, manualForDept(c)]));

  appendRowGroups(body, pnlRowGroups, (key) => ROW_LABELS[key] || key, (key, code) => cellFor(key, code, pnlByDept[code]));
  appendRowGroups(
    body,
    manualRowGroups,
    (key) => MANUAL_ROW_LABELS[key] || key,
    (key, code) => cellForManual(key, code, manualByDept[code], pnlByDept[code])
  );
}

function renderSummary(pnlRowGroups, manualRowGroups) {
  const strip = document.getElementById("summary-strip");
  strip.innerHTML = "";
  const pnlByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, pnlForDept(c)]));
  const manualByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, manualForDept(c)]));
  const pnlKeys = pnlRowGroups.flatMap((g) => g.keys);
  const manualKeys = manualRowGroups.flatMap((g) => g.keys);
  const summaries = {};

  for (const code of DEPT_ORDER) {
    const tallies = { good: 0, warn: 0, bad: 0, neutral: 0 };
    for (const key of pnlKeys) tallies[cellFor(key, code, pnlByDept[code]).tier]++;
    for (const key of manualKeys) tallies[cellForManual(key, code, manualByDept[code], pnlByDept[code]).tier]++;
    const scored = tallies.good + tallies.warn + tallies.bad;
    const total = scored + tallies.neutral;
    summaries[code] = { tallies, total };

    const dept = DEPARTMENTS[code];
    const rev = pnlByDept[code] ? formatMoney(pnlByDept[code].totalIncome || 0) : "—";
    const card = document.createElement("div");
    card.className = "summary-card";
    card.style.setProperty("--dept-accent", `var(${DEPT_META[code].accent})`);
    card.innerHTML = `
      <div class="summary-dept">BU ${escapeHtml(code)}</div>
      <div class="summary-name">${escapeHtml(dept.name)}</div>
      <div class="summary-rev num">${escapeHtml(rev)} revenue</div>
      <div class="summary-bar">
        ${tallies.good ? `<span class="b-good" style="width:${(tallies.good / total) * 100}%"></span>` : ""}
        ${tallies.warn ? `<span class="b-warn" style="width:${(tallies.warn / total) * 100}%"></span>` : ""}
        ${tallies.bad ? `<span class="b-bad" style="width:${(tallies.bad / total) * 100}%"></span>` : ""}
      </div>
      <div class="summary-tally"><span class="num">${tallies.good}</span> on target · <span class="num">${tallies.warn + tallies.bad}</span> under · <span class="num">${tallies.neutral}</span> untargeted</div>
    `;
    strip.appendChild(card);
  }
  return summaries;
}

// A real, current finding pulled from the data each render, not a fixed
// sentence — the best and worst department by on-target ratio (among ones
// with at least one scored/targeted metric), so the callout stays accurate
// as the month/YTD selection changes instead of describing a stale example.
function renderCallout(summaries) {
  const scored = DEPT_ORDER.map((code) => {
    const s = summaries[code];
    const denom = s.total - s.tallies.neutral;
    return { code, name: DEPARTMENTS[code].name, denom, good: s.tallies.good, under: s.tallies.warn + s.tallies.bad };
  }).filter((d) => d.denom > 0);

  const el = document.getElementById("callout");
  if (scored.length < 2) {
    el.innerHTML = "<strong>Not enough targeted metrics yet</strong> to compare departments for this period.";
    return;
  }
  const best = scored.reduce((a, b) => (b.good / b.denom > a.good / a.denom ? b : a));
  const worst = scored.reduce((a, b) => (b.under / b.denom > a.under / a.denom ? b : a));
  el.innerHTML = worst.code === best.code
    ? `<strong>BU ${escapeHtml(worst.code)} (${escapeHtml(worst.name)})</strong> is the only department with targeted ratios to compare this period.`
    : `<strong>What the column view surfaces:</strong> BU ${escapeHtml(worst.code)} (${escapeHtml(worst.name)}) is under target on ${worst.under} of ${worst.denom} scored ratios this period; BU ${escapeHtml(best.code)} (${escapeHtml(best.name)}) is on target for ${best.good} of ${best.denom}. Reading straight down a column makes that gap obvious in about two seconds — comparing six separate cards doesn't.`;
}

function render() {
  const pnlRowGroups = buildRowList();
  const manualRowGroups = buildManualRowList();
  renderHeader();
  renderBody(pnlRowGroups, manualRowGroups);
  const summaries = renderSummary(pnlRowGroups, manualRowGroups);
  renderCallout(summaries);

  document.getElementById("page-meta").textContent =
    `Period: ${monthLabel(currentMonth)}. Sources: data/pnl-monthly.json, data/manual-metrics.json.`;
  document.getElementById("page-foot").textContent =
    "Same targets and coloring as the per-department scorecard (company-scorecard.html) — this is a different layout on identical data, not a separate source of truth.";
}

async function loadData() {
  try {
    const [pnlRes, manualRes] = await Promise.all([
      fetch(`data/pnl-monthly.json?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`data/manual-metrics.json?_=${Date.now()}`, { cache: "no-store" }),
    ]);
    pnlData = pnlRes.ok ? await pnlRes.json() : {};
    manualData = manualRes.ok ? await manualRes.json() : {};
    if (!Object.keys(pnlData).length) {
      document.querySelector(".matrix-wrap").innerHTML = '<p class="empty">No P&L data uploaded yet.</p>';
      return;
    }
    populateMonthSelect();
    render();
  } catch (err) {
    document.querySelector(".matrix-wrap").innerHTML = '<p class="empty">Could not load P&L data.</p>';
    console.error(err);
  }
}

document.getElementById("month-select").addEventListener("change", (e) => {
  currentMonth = e.target.value;
  render();
});

loadData();
