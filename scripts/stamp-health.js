// Records that a cloud sync ran, in docs/data/refresh-health.json -- the same
// file and keys (hvacSales / commission / manualMetrics) the Windows refresh
// scripts stamp, which the scorecard pages read to show their "sync may be
// stuck" banner. A key is only re-stamped if its stamp is older than
// MIN_AGE_HOURS, so an hourly job doesn't add a commit every hour just to
// move a timestamp (the banner only cares about "since the last business day").
//
//   node scripts/stamp-health.js hvacSales commission manualMetrics
const fs = require("fs");

const FILE = "docs/data/refresh-health.json";
const MIN_AGE_HOURS = 12;
const keys = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(FILE, "utf8").replace(/^﻿/, ""));
const now = Date.now();
let changed = false;
for (const k of keys) {
  const prev = health[k] ? Date.parse(health[k]) : NaN;
  if (Number.isNaN(prev) || now - prev > MIN_AGE_HOURS * 3600 * 1000) {
    health[k] = new Date(now).toISOString();
    changed = true;
  }
}
if (changed) fs.writeFileSync(FILE, JSON.stringify(health, null, 4) + "\n");
console.log(changed ? "health stamps updated" : "health stamps still fresh");
