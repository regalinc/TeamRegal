// Semantic diff of two JSON files, ignoring formatting and any dotted paths
// named after the files (e.g. meta.generated_at). Used by the shadow-mode
// sheet/commission workflow to check the cloud output against the committed
// files the Windows pipeline produced.
//
//   node scripts/compare-json.js <committed.json> <cloud.json> [ignorePath...]
const fs = require("fs");
const { diff } = require("./sheet-parsers");

const [, , committedFile, cloudFile, ...ignore] = process.argv;
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));

function strip(obj, dotted) {
  const keys = dotted.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o || typeof o !== "object") return;
    o = o[k];
  }
  if (o && typeof o === "object") delete o[keys[keys.length - 1]];
}

const a = read(committedFile);
const b = read(cloudFile);
for (const p of ignore) {
  strip(a, p);
  strip(b, p);
}
const differences = diff(a, b);
const label = require("path").basename(committedFile);
if (differences.length === 0) {
  console.log(`MATCH  ${label}`);
} else {
  console.log(`DIFFER ${label} (showing up to ${differences.length}):`);
  differences.forEach((d) => console.log(`   ${d}`));
  console.log(`::warning::${label}: cloud result differs from the committed file`);
}
