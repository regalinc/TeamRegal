// Turns the two hand-maintained workbooks (already read by xlsx-lite.js) into
// the JSON shapes docs/data/hvac-sales.json and manual-metrics.json use. The
// cloud twin of parse-hvac-sales.ps1 and parse-manual-metrics.ps1 -- same
// sheets, same column positions, same rules. Change one side, change the other
// until the PowerShell versions are retired.
//
// A workbook here is { sheets: [{ name, rows: Map<rowNumber, Map<col, value>> }] }.

const MONTH_TABS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Column layout per department tab; keys must match departments-config.js's
// `manual` keys and parse-manual-metrics.ps1 verbatim. Column A is Month, data
// starts in column B. pct: entered as whole numbers (83 = 83%), stored as 0.83.
const c = (key, pct = false) => ({ key, pct });
const DEPARTMENTS = [
  { sheet: "30 HVAC Service", code: "30", columns: [c("paidHours"), c("billedHours"), c("attendancePct", true), c("truckInventoryAccuracyPct", true), c("reviewsGenerated"), c("callbackCount"), c("vehicleCount"), c("employeeCount"), c("dso")] },
  { sheet: "40 HVAC Maintenance", code: "40", columns: [c("paidHours"), c("attendancePct", true), c("ptuConversionPct", true), c("vehicleCount"), c("billedHours"), c("ptuTechDays"), c("employeeCount"), c("supportCount"), c("productionCount"), c("newCustClubConversion", true), c("renewalRate", true), c("callbackCount")] },
  { sheet: "70 Plumbing Service", code: "70", columns: [c("paidHours"), c("billedHours"), c("attendancePct", true), c("truckInventoryAccuracyPct", true), c("reviewsGenerated"), c("callbackCount"), c("vehicleCount"), c("employeeCount"), c("supportCount"), c("productionCount"), c("dso")] },
  { sheet: "80 Plumbing Maintenance", code: "80", columns: [c("paidHours"), c("attendancePct", true), c("reviewsGenerated"), c("callbackCount"), c("vehicleCount")] },
  { sheet: "10 HVAC Installation", code: "10", columns: [c("employeeCount"), c("vehicleCount"), c("crewCount"), c("callbackCount")] },
  { sheet: "50 Plumbing Installation", code: "50", columns: [c("employeeCount"), c("vehicleCount"), c("crewCount")] },
];

// What Excel shows for a plain cell (PowerShell's .Text on these General-
// formatted columns): numbers as digits, text trimmed, empty as "".
function text(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

// A numeric cell is an Excel serial date (PowerShell's `-is [double]` accepted
// any number); the integer part is the calendar day, the fraction a time of day
// that FromOADate(...).ToString("yyyy-MM-dd") ignored.
function asDate(v) {
  if (typeof v !== "number") return null;
  return new Date(Math.floor(v - 25569) * 86400000);
}
const isoDay = (d) => d.toISOString().slice(0, 10);

function sheetNamed(wb, name) {
  const ws = wb.sheets.find((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!ws) throw new Error(`worksheet "${name}" not found (have: ${wb.sheets.map((s) => `"${s.name}"`).join(", ")})`);
  return ws;
}

// Rows holding a value, from `firstRow` down, as [rowNumber, cells] pairs.
function rowsFrom(ws, firstRow) {
  return [...ws.rows.entries()].filter(([n]) => n >= firstRow).sort((a, b) => a[0] - b[0]);
}

function parseHvacSales(wb, log = () => {}) {
  const records = [];
  for (const month of MONTH_TABS) {
    const ws = sheetNamed(wb, month);
    let monthCount = 0;
    // Rows 1-2 are header + spacer; a row with no CA is a blank row.
    for (const [, cells] of rowsFrom(ws, 3)) {
      const ca = text(cells.get(1));
      if (ca === "") continue;
      const d = asDate(cells.get(2));
      records.push({
        ca,
        date: d ? isoDay(d) : null,
        customerName: text(cells.get(3)),
        job: text(cells.get(4)),
        systemType: text(cells.get(5)),
        clubMember: text(cells.get(6)),
        lead: text(cells.get(7)),
        customerType: text(cells.get(8)),
        sold: text(cells.get(9)).toLowerCase() === "yes",
      });
      monthCount++;
    }
    log(`${month}: ${monthCount} records`);
  }
  if (records.length === 0) throw new Error("parsed 0 HVAC Sales records across all 12 tabs -- treating as a read failure");
  return { meta: { record_count: records.length }, records };
}

function parseManualMetrics(wb, log = () => {}) {
  const data = {};
  for (const dept of DEPARTMENTS) {
    const ws = sheetNamed(wb, dept.sheet);
    let monthCount = 0;
    for (const [rowNum, cells] of rowsFrom(ws, 2)) {
      const month = asDate(cells.get(1));
      if (!month) continue;
      const monthKey = month.toISOString().slice(0, 7);
      const entry = {};
      dept.columns.forEach((col, i) => {
        const raw = cells.get(i + 2);
        if (raw === null || raw === undefined || raw === "") {
          entry[col.key] = null;
          return;
        }
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${dept.sheet} row ${rowNum} "${col.key}": "${raw}" is not a number`);
        entry[col.key] = col.pct ? n / 100 : n;
      });
      (data[monthKey] ||= {})[dept.code] = entry;
      monthCount++;
    }
    log(`${dept.sheet}: ${monthCount} month row(s)`);
  }
  if (Object.keys(data).length === 0) throw new Error("parsed 0 Manual Metrics months -- treating as a read failure");
  return data;
}

// Deep diff with a small numeric tolerance (PowerShell and JS print doubles a
// little differently). Returns up to `limit` human-readable differences.
function diff(a, b, where = "", out = [], limit = 15) {
  if (out.length >= limit) return out;
  if (typeof a === "number" && typeof b === "number") {
    if (Math.abs(a - b) > 1e-9) out.push(`${where}: committed ${a} vs cloud ${b}`);
    return out;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b) out.push(`${where}: committed ${JSON.stringify(a)} vs cloud ${JSON.stringify(b)}`);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in a)) out.push(`${where}.${k}: only in cloud`);
    else if (!(k in b)) out.push(`${where}.${k}: only in committed`);
    else diff(a[k], b[k], `${where}.${k}`, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

module.exports = { parseHvacSales, parseManualMetrics, diff };
