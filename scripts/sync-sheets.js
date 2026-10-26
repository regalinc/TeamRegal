// Reads the two hand-maintained scorecard workbooks straight from SharePoint
// (Microsoft Graph, app-only, Sites.Selected -- read access to ONE site) and
// turns them into docs/data/hvac-sales.json and docs/data/manual-metrics.json.
//
// This is the cloud replacement for parse-hvac-sales.ps1 and
// parse-manual-metrics.ps1, which drive desktop Excel through COM and so only
// ever ran on a signed-in Windows PC. Same sheets, same column positions, same
// output shape -- if you change one side, change the other until the PowerShell
// versions are retired.
//
// Modes:
//   node scripts/sync-sheets.js --compare   parse, then diff against the
//                                           committed JSON; writes nothing.
//                                           (Shadow mode while both pipelines run.)
//   node scripts/sync-sheets.js --write     parse and overwrite the JSON files.
//
// Env (all from GitHub Actions secrets):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   Entra app "TeamRegal Sheet Sync"
// Optional:
//   SP_SITE_ID          skip the site lookup (format: host,siteGuid,webGuid)
//   SP_HOSTNAME / SP_SITE_PATH   default regalinc.sharepoint.com / /sites/RegalInc
//   HVAC_SALES_PATH     default "HVAC Installation/HVAC Sales.<year>.xlsx"
//   MANUAL_METRICS_PATH default "Company Scorecard/Manual Metrics.xlsx"
//   OUT_DIR             default docs/data
//
// Paths are relative to the root of the site's default document library
// ("Shared Documents").
//
// FAILURE HANDLING mirrors the PowerShell parsers: nothing is written unless
// the parse succeeded and is non-empty, so a failed download can never blank
// the live scorecard.

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const OUT_DIR = process.env.OUT_DIR || "docs/data";
const MODE = process.argv.includes("--write") ? "write" : "compare";

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

// ---- Microsoft Graph -------------------------------------------------------

async function getToken() {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    signal: AbortSignal.timeout(60_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // error / error_description only -- never echo the request (it holds the secret).
    throw new Error(`Microsoft sign-in failed (${res.status}): ${body.error || "?"} ${(body.error_description || "").split("\r")[0]}`);
  }
  return body.access_token;
}

async function graph(token, url, asBuffer = false) {
  const res = await fetch(url.startsWith("http") ? url : `https://graph.microsoft.com/v1.0${url}`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  return asBuffer ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function siteId(token) {
  if (process.env.SP_SITE_ID) return process.env.SP_SITE_ID;
  const host = process.env.SP_HOSTNAME || "regalinc.sharepoint.com";
  const sitePath = process.env.SP_SITE_PATH || "/sites/RegalInc";
  return (await graph(token, `/sites/${host}:${sitePath}`)).id;
}

async function download(token, site, relPath) {
  const encoded = relPath.split("/").map(encodeURIComponent).join("/");
  return graph(token, `/sites/${site}/drive/root:/${encoded}:/content`, true);
}

// ---- Cell helpers ----------------------------------------------------------

// Text of a cell the way Excel shows a plain value (PowerShell's .Text on the
// General-formatted cells these sheets use): formulas -> their result, rich
// text -> joined runs, numbers -> plain digits.
function cellText(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) v = v.result;
    else if ("richText" in v) v = v.richText.map((t) => t.text).join("");
    else if ("text" in v) v = v.text;
    if (v === null || v === undefined) return "";
  }
  if (v instanceof Date) return isoDay(v);
  return String(v).trim();
}

// Raw value like Excel's .Value2: formulas -> result, everything else as-is.
function cellRaw(cell) {
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date) && "result" in v) return v.result;
  return v;
}

function isoDay(d) {
  // ExcelJS builds dates from the serial in UTC, so the UTC fields ARE the
  // calendar date typed in the cell (no timezone shift to undo).
  return d.toISOString().slice(0, 10);
}

// A date cell is a Date when it carries a date format, a bare number when it
// doesn't -- PowerShell's `-is [double]` accepted both, so do the same.
function asDate(raw) {
  if (raw instanceof Date) return raw;
  if (typeof raw === "number") return new Date(Math.round((raw - 25569) * 86400000));
  return null;
}

// Rows that actually hold a value, from `firstRow` down. ws.rowCount follows
// FORMATTING, not content: a row or column styled all the way down the sheet
// reports ~1,048,576 rows, and a plain `for (r <= rowCount)` loop then churns
// through a million empty rows (that's what hung the first cloud run).
function dataRows(ws, firstRow) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    if (n >= firstRow) rows.push(row);
  });
  return rows;
}

function sheetNamed(wb, name) {
  const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (!ws) throw new Error(`worksheet "${name}" not found (have: ${wb.worksheets.map((w) => `"${w.name}"`).join(", ")})`);
  return ws;
}

// ---- HVAC Sales ------------------------------------------------------------

async function parseHvacSales(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const records = [];
  for (const month of MONTH_TABS) {
    const ws = sheetNamed(wb, month);
    let monthCount = 0;
    // Rows 1-2 are header + spacer; a row with no CA is a blank row.
    for (const row of dataRows(ws, 3)) {
      const ca = cellText(row.getCell(1));
      if (ca === "") continue;
      const d = asDate(cellRaw(row.getCell(2)));
      records.push({
        ca,
        date: d ? isoDay(d) : null,
        customerName: cellText(row.getCell(3)),
        job: cellText(row.getCell(4)),
        systemType: cellText(row.getCell(5)),
        clubMember: cellText(row.getCell(6)),
        lead: cellText(row.getCell(7)),
        customerType: cellText(row.getCell(8)),
        sold: cellText(row.getCell(9)).toLowerCase() === "yes",
      });
      monthCount++;
    }
    console.log(`${month}: ${monthCount} records`);
  }
  if (records.length === 0) throw new Error("parsed 0 HVAC Sales records across all 12 tabs -- treating as a read failure");
  return { meta: { record_count: records.length }, records };
}

// ---- Manual Metrics --------------------------------------------------------

async function parseManualMetrics(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const data = {};
  for (const dept of DEPARTMENTS) {
    const ws = sheetNamed(wb, dept.sheet);
    let monthCount = 0;
    for (const row of dataRows(ws, 2)) {
      const r = row.number;
      const month = asDate(cellRaw(row.getCell(1)));
      if (!month) continue;
      const monthKey = month.toISOString().slice(0, 7);
      const entry = {};
      dept.columns.forEach((col, i) => {
        const raw = cellRaw(row.getCell(i + 2));
        if (raw === null || raw === undefined || raw === "") {
          entry[col.key] = null;
          return;
        }
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(n)) throw new Error(`${dept.sheet} row ${r} "${col.key}": "${raw}" is not a number`);
        entry[col.key] = col.pct ? n / 100 : n;
      });
      (data[monthKey] ||= {})[dept.code] = entry;
      monthCount++;
    }
    console.log(`${dept.sheet}: ${monthCount} month row(s)`);
  }
  if (Object.keys(data).length === 0) throw new Error("parsed 0 Manual Metrics months -- treating as a read failure");
  return data;
}

// ---- Output / comparison ---------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
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
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) out.push(`${where}.${k}: only in cloud`);
    else if (!(k in b)) out.push(`${where}.${k}: only in committed`);
    else diff(a[k], b[k], `${where}.${k}`, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

async function main() {
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    console.log("Microsoft credentials (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET) are not set yet -- nothing to do.");
    return;
  }

  const year = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric" }).format(new Date());
  const hvacPath = process.env.HVAC_SALES_PATH || `HVAC Installation/HVAC Sales.${year}.xlsx`;
  const metricsPath = process.env.MANUAL_METRICS_PATH || "Company Scorecard/Manual Metrics.xlsx";

  console.log("Signing in to Microsoft...");
  const token = await getToken();
  console.log("Signed in.");
  const site = await siteId(token);
  console.log(`Site: ${site}`);

  // Each workbook is handled on its own: one that can't be read (moved, locked,
  // renamed) must not stop the other from syncing -- but the run still ends in
  // failure so it's noticed.
  const hvacFile = path.join(OUT_DIR, "hvac-sales.json");
  const metricsFile = path.join(OUT_DIR, "manual-metrics.json");
  const jobs = [
    { label: "hvac-sales.json", file: hvacFile, remote: hvacPath, parse: parseHvacSales },
    { label: "manual-metrics.json", file: metricsFile, remote: metricsPath, parse: parseManualMetrics },
  ];
  const parsed = [];
  let failures = 0;
  for (const job of jobs) {
    try {
      console.log(`Downloading ${job.remote}`);
      const buffer = await download(token, site, job.remote);
      console.log(`Downloaded ${buffer.length} bytes, parsing...`);
      parsed.push({ ...job, cloud: await job.parse(buffer) });
    } catch (err) {
      failures++;
      console.log(`::error::${job.label}: ${err.message}`);
    }
  }

  if (MODE === "write") {
    for (const p of parsed) {
      writeJson(p.file, p.cloud);
      console.log(`Wrote ${p.label}`);
    }
    if (failures) process.exitCode = 1;
    return;
  }

  let mismatches = 0;
  for (const { label, file, cloud } of parsed) {
    const differences = diff(readJson(file), cloud);
    if (differences.length === 0) {
      console.log(`MATCH  ${label}`);
    } else {
      mismatches++;
      console.log(`DIFFER ${label} (showing up to ${differences.length}):`);
      differences.forEach((d) => console.log(`   ${d}`));
    }
  }
  if (failures) process.exitCode = 1;
  if (mismatches) console.log("::warning::Cloud parse differs from the committed data (see log). Small differences are expected if the sheet changed since the PC last synced.");
}

// A healthy run is a few seconds. If something stalls (a Graph call, a parse),
// say so and stop instead of sitting until the job timeout, and always exit
// explicitly so an open socket can't keep a finished run alive.
const watchdog = setTimeout(() => {
  console.error("::error::sync-sheets stalled for 3 minutes -- giving up (see the last log line above for where)");
  process.exit(2);
}, 180_000);

main()
  .then(() => {
    clearTimeout(watchdog);
    process.exit(process.exitCode || 0);
  })
  .catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
