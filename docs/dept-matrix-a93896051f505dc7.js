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

let pnlData = null;
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

function renderBody(rowGroups) {
  const body = document.getElementById("matrix-body");
  body.innerHTML = "";
  const pnlByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, pnlForDept(c)]));

  for (const group of rowGroups) {
    const groupTr = document.createElement("tr");
    groupTr.className = "group-row";
    groupTr.innerHTML = `<td colspan="${DEPT_ORDER.length + 1}">${escapeHtml(group.group)}</td>`;
    body.appendChild(groupTr);

    for (const key of group.keys) {
      const tr = document.createElement("tr");
      const labelTd = document.createElement("td");
      labelTd.className = "row-label";
      labelTd.textContent = ROW_LABELS[key] || key;
      tr.appendChild(labelTd);

      for (const code of DEPT_ORDER) {
        const c = cellFor(key, code, pnlByDept[code]);
        const td = document.createElement("td");
        td.className = `cell tier-${c.tier}`;
        td.innerHTML = `<div class="cell-inner"><span class="cell-value num">${escapeHtml(c.valueStr)}</span><span class="cell-target num">${escapeHtml(c.captionStr)}</span></div>`;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }
}

function renderSummary(rowGroups) {
  const strip = document.getElementById("summary-strip");
  strip.innerHTML = "";
  const pnlByDept = Object.fromEntries(DEPT_ORDER.map((c) => [c, pnlForDept(c)]));
  const allKeys = rowGroups.flatMap((g) => g.keys);
  const summaries = {};

  for (const code of DEPT_ORDER) {
    const tallies = { good: 0, warn: 0, bad: 0, neutral: 0 };
    for (const key of allKeys) tallies[cellFor(key, code, pnlByDept[code]).tier]++;
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
  const rowGroups = buildRowList();
  renderHeader();
  renderBody(rowGroups);
  const summaries = renderSummary(rowGroups);
  renderCallout(summaries);

  document.getElementById("page-meta").textContent = `Period: ${monthLabel(currentMonth)}. Source: data/pnl-monthly.json.`;
  document.getElementById("page-foot").textContent =
    "Same targets and coloring as the per-department scorecard (company-scorecard.html) — this is a different layout on identical data, not a separate source of truth.";
}

async function loadData() {
  try {
    const res = await fetch(`data/pnl-monthly.json?_=${Date.now()}`, { cache: "no-store" });
    pnlData = res.ok ? await res.json() : {};
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
