// Builds the folder that gets deployed to Cloudflare Pages: a copy of docs/
// with every docs/data/*.json re-written minified.
//
// Why minify: Cloudflare Pages rejects any single file over 25 MiB
// (26,214,400 bytes). dashboard.json is ~35 MB pretty-printed (~25 MB with only
// whitespace removed). The sync scripts keep writing the readable version into
// the repo; only the deployed copy is minified, so nothing else has to change.
//
// Usage: node scripts/prepare-site.js [outDir]      (default outDir: dist)
// Exits non-zero if any output file is over the limit or a JSON file is invalid,
// so a deploy never goes out half-broken.
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "docs");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
const LIMIT = 25 * 1024 * 1024; // Cloudflare Pages per-file limit
const WARN_AT = 22 * 1024 * 1024; // start worrying well before the limit

fs.rmSync(OUT, { recursive: true, force: true });

// Data files no page loads (only the sync scripts use them). Keeping them off the
// deployed site means less data exposed and smaller uploads.
const EXCLUDE = new Set(["data/jobs.json", "data/estimates.json"]);

let failed = false;
const bigFiles = [];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (entry.isFile()) {
      if (EXCLUDE.has(path.relative(SRC, src).split(path.sep).join("/"))) continue;
      if (/\.json$/i.test(entry.name)) {
        try {
          const text = fs.readFileSync(src, "utf8").replace(/^﻿/, "");
          fs.writeFileSync(dst, JSON.stringify(JSON.parse(text)));
        } catch (err) {
          console.error(`ERROR: ${path.relative(SRC, src)} is not valid JSON: ${err.message}`);
          failed = true;
          continue;
        }
      } else {
        fs.copyFileSync(src, dst);
      }
      const size = fs.statSync(dst).size;
      if (size > WARN_AT) bigFiles.push({ file: path.relative(OUT, dst), size });
      if (size > LIMIT) {
        console.error(`ERROR: ${path.relative(OUT, dst)} is ${size} bytes, over Cloudflare Pages' ${LIMIT}-byte per-file limit`);
        failed = true;
      }
    }
  }
}

copyDir(SRC, OUT);

for (const f of bigFiles) {
  console.log(`NOTE: ${f.file} is ${(f.size / 1048576).toFixed(1)} MiB (limit 25 MiB)`);
}
if (failed) process.exit(1);
console.log(`Prepared ${OUT}`);
