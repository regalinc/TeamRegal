// Reads the two hand-maintained scorecard workbooks straight from SharePoint
// (Microsoft Graph, app-only, Sites.Selected -- read access to ONE site) and
// turns them into docs/data/hvac-sales.json and docs/data/manual-metrics.json.
//
// This is the cloud replacement for parse-hvac-sales.ps1 and
// parse-manual-metrics.ps1, which drive desktop Excel through COM and so only
// ever ran on a signed-in Windows PC. Parsing lives in sheet-parsers.js, the
// .xlsx reading in xlsx-lite.js (no npm dependencies).
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
// the live scorecard. Each workbook is handled on its own, but any failure
// still ends the run in failure so it's noticed.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { readWorkbook } = require("./xlsx-lite");
const { parseHvacSales, parseManualMetrics, diff } = require("./sheet-parsers");

const OUT_DIR = process.env.OUT_DIR || "docs/data";
const MODE = process.argv.includes("--write") ? "write" : "compare";

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
  return asBuffer ? new Uint8Array(await res.arrayBuffer()) : res.json();
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

// ---- Output ----------------------------------------------------------------

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
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

  const jobs = [
    { label: "hvac-sales.json", file: path.join(OUT_DIR, "hvac-sales.json"), remote: hvacPath, parse: parseHvacSales },
    { label: "manual-metrics.json", file: path.join(OUT_DIR, "manual-metrics.json"), remote: metricsPath, parse: parseManualMetrics },
  ];
  const parsed = [];
  let failures = 0;
  for (const job of jobs) {
    try {
      console.log(`Downloading ${job.remote}`);
      const buffer = await download(token, site, job.remote);
      console.log(`Downloaded ${buffer.length} bytes, reading...`);
      const workbook = await readWorkbook(buffer, async (u8) => zlib.inflateRawSync(u8));
      console.log(`Read ${workbook.sheets.length} sheets, parsing...`);
      parsed.push({ ...job, cloud: job.parse(workbook, console.log) });
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
