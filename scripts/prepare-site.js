// Builds the folder that gets deployed to Cloudflare Pages.
//
//   dist/            company-wide site (index, admin, scorecard, fleet, TVs ...) -- Cloudflare
//                    Access lets only the owner + Devin + Derick in.
//   dist/josh/       Josh's own HVAC Sales page + ONLY his data    -- Access: Josh + owner
//   dist/nick/       Nick's own HVAC Sales page + ONLY his data    -- Access: Nick + owner
//   dist/andrew/     Andrew's own page + ONLY his data             -- Access: Andrew + owner
//
// Why separate folders with filtered data: the login rule alone would stop Nick
// from opening Josh's URL, but the old pages fetched the whole company
// dashboard.json and filtered client-side. Here each person's folder simply does
// not contain anyone else's page, goals, tokens, or data, so there is nothing to
// find even with dev tools. verifyIsolation() below fails the build (so nothing
// is deployed) if anything of another consultant's turns up in a person folder,
// or any personal page/data file is left in the company-wide root.
//
// Also: every docs/data/*.json is re-written minified. Cloudflare Pages rejects any
// single file over 25 MiB; dashboard.json is ~35 MB pretty-printed.
//
// Usage: node scripts/prepare-site.js [outDir]      (default outDir: dist)
// Exits non-zero on any problem so a deploy never goes out half-broken.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "docs");
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "dist"));
const LIMIT = 25 * 1024 * 1024; // Cloudflare Pages per-file limit
const WARN_AT = 22 * 1024 * 1024; // start worrying well before the limit

// kind "hvac" = hvac-sales.* template; kind "andrew" = andrew.* page.
const PEOPLE = [
  { slug: "josh", ca: "Josh", kind: "hvac", fullName: "Josh Zieger", token: "3cf6d793d05b3191", techId: "pro_62aa1ba4432340829b0aba02abd1d307", photo: "josh-zieger.jpg" },
  { slug: "nick", ca: "Nick", kind: "hvac", fullName: "Nick Webb", token: "b062ff740c81f5e8", techId: "pro_27fcce8f21bc4186b44abe4d9a87c03f", photo: "nick-webb.jpg" },
  { slug: "andrew", ca: "Andrew", kind: "andrew", fullName: "Andrew Rouscher", token: null, techId: "pro_ca120cbb55fa40fe9361d492161b101f", photo: "andrew-rouscher.jpg" },
];

// Personal pages/data that must NOT be in the company-wide root.
const ROOT_EXCLUDE = new Set([
  "hvac-sales.html", "hvac-sales.js", "hvac-sales.css",
  "andrew.html", "andrew.js", "andrew.css",
  "data/hvac-sales.json", "data/commission-report.json",
  // No page loads these (only the sync scripts do).
  "data/jobs.json", "data/estimates.json",
]);

let failed = false;
const problems = [];
function fail(msg) {
  failed = true;
  problems.push(msg);
  console.error("ERROR: " + msg);
}

const stripBom = (s) => s.replace(/^﻿/, "");
const readJson = (p) => JSON.parse(stripBom(fs.readFileSync(p, "utf8")));
const writeJson = (p, obj) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
};
const writeText = (p, text) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const rel = (p) => path.relative(SRC, p).split(path.sep).join("/");

// ---------------------------------------------------------------- root copy
fs.rmSync(OUT, { recursive: true, force: true });
const bigFiles = [];

function noteSize(file) {
  const size = fs.statSync(file).size;
  if (size > WARN_AT) bigFiles.push({ file: path.relative(OUT, file), size });
  if (size > LIMIT) fail(`${path.relative(OUT, file)} is ${size} bytes, over Cloudflare Pages' ${LIMIT}-byte per-file limit`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else if (entry.isFile()) {
      if (ROOT_EXCLUDE.has(rel(src))) continue;
      if (/\.json$/i.test(entry.name)) {
        try {
          fs.writeFileSync(dst, JSON.stringify(readJson(src)));
        } catch (err) {
          fail(`${rel(src)} is not valid JSON: ${err.message}`);
          continue;
        }
      } else if (rel(src) === "shared.js") {
        // The root site has no use for the consultants' page tokens.
        let t = fs.readFileSync(src, "utf8");
        t = dropLinesContaining(t, PEOPLE.map((p) => p.token).filter(Boolean));
        fs.writeFileSync(dst, t);
      } else {
        fs.copyFileSync(src, dst);
      }
    }
  }
}

function dropLinesContaining(text, needles) {
  if (!needles.length) return text;
  return text
    .split("\n")
    .filter((line) => !needles.some((n) => line.includes(n)))
    .join("\n");
}

// Remove whole-line // comments (and /* */ blocks for css, <!-- --> for html) so notes
// about other people never ship inside a personal folder.
function stripComments(text, ext) {
  if (ext === ".js") return text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  if (ext === ".css") return text.replace(/\/\*[\s\S]*?\*\//g, "");
  if (ext === ".html") return text.replace(/<!--[\s\S]*?-->/g, "");
  return text;
}

// ------------------------------------------------------------ person folders
function removeOtherPeopleFromGoals(text, person) {
  // hvac-sales.js: per-consultant goal tables keyed by first name.
  const others = PEOPLE.filter((p) => p.kind === "hvac" && p.slug !== person.slug);
  for (const o of others) {
    const blockRe = new RegExp(`^  ${o.ca}: \\{[\\s\\S]*?^  \\},?\\r?\\n`, "m");
    const lineRe = new RegExp(`^  ${o.ca}: [0-9_]+,?\\r?\\n`, "m");
    if (!blockRe.test(text)) fail(`hvac-sales.js: could not find ${o.ca}'s monthly-goal block to remove`);
    text = text.replace(blockRe, "");
    if (!lineRe.test(text)) fail(`hvac-sales.js: could not find ${o.ca}'s YTD-goal line to remove`);
    text = text.replace(lineRe, "");
    text = text.replace(new RegExp(`${o.ca}: "[0-9-]+",?\\s*`, "g"), "");
  }
  return text;
}

function pruneCaKeys(node, keepCa) {
  // Drops any object key that is a different consultant's name, anywhere in the tree.
  const names = new Set(PEOPLE.map((p) => p.ca));
  if (Array.isArray(node)) return node.map((n) => pruneCaKeys(n, keepCa));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (names.has(k) && k !== keepCa) continue;
      out[k] = pruneCaKeys(v, keepCa);
    }
    return out;
  }
  return node;
}

function buildPerson(person) {
  const dir = path.join(OUT, person.slug);
  const others = PEOPLE.filter((p) => p.slug !== person.slug);
  const pageBase = person.kind === "hvac" ? "hvac-sales" : "andrew";

  // --- code: page, script, stylesheet, shared.js ---
  writeText(path.join(dir, "index.html"), stripComments(fs.readFileSync(path.join(SRC, `${pageBase}.html`), "utf8"), ".html"));
  writeText(path.join(dir, `${pageBase}.css`), stripComments(fs.readFileSync(path.join(SRC, `${pageBase}.css`), "utf8"), ".css"));

  let js = fs.readFileSync(path.join(SRC, `${pageBase}.js`), "utf8");
  js = stripComments(js, ".js");
  if (person.kind === "hvac") {
    const hook = 'resolveToken(urlParams.get("u"))';
    if (!js.includes(hook)) fail("hvac-sales.js: token lookup line not found");
    js = js.replace(hook, `resolveToken(${JSON.stringify(person.token)})`);
    js = removeOtherPeopleFromGoals(js, person);
    // (Nick's start-date entry was removed above for everyone but Nick; tidy the empty object.)
    js = js.replace(/const CA_EFFECTIVE_START_DATE = \{\s*\};?/, "const CA_EFFECTIVE_START_DATE = {};");
  }
  writeText(path.join(dir, `${pageBase}.js`), js);
  try { new vm.Script(js, { filename: `${person.slug}/${pageBase}.js` }); } catch (err) { fail(`${person.slug}/${pageBase}.js no longer parses after filtering: ${err.message}`); }

  let shared = fs.readFileSync(path.join(SRC, "shared.js"), "utf8");
  shared = dropLinesContaining(shared, others.flatMap((o) => [o.token, o.techId]).filter(Boolean));
  shared = stripComments(shared, ".js");
  writeText(path.join(dir, "shared.js"), shared);
  try { new vm.Script(shared, { filename: `${person.slug}/shared.js` }); } catch (err) { fail(`${person.slug}/shared.js no longer parses after filtering: ${err.message}`); }

  // --- assets: logos + this person's own photo only ---
  for (const f of ["logo-color.png", "logo-white.png"]) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.copyFileSync(path.join(SRC, "assets", f), path.join(dir, "assets", f));
  }
  const photoSrc = path.join(SRC, "assets", "tech-photos", person.photo);
  if (fs.existsSync(photoSrc)) {
    fs.mkdirSync(path.join(dir, "assets", "tech-photos"), { recursive: true });
    fs.copyFileSync(photoSrc, path.join(dir, "assets", "tech-photos", person.photo));
  }

  // --- data ---
  const dash = readJson(path.join(SRC, "data", "dashboard.json"));
  const tech = (dash.technicians || []).find((t) => t.id === person.techId);
  if (!tech) fail(`${person.slug}: technician ${person.techId} not found in dashboard.json`);

  let salesRows = [];
  if (person.kind === "hvac") {
    const sales = readJson(path.join(SRC, "data", "hvac-sales.json"));
    salesRows = (sales.records || []).filter((r) => r.ca === person.ca);
    writeJson(path.join(dir, "data", "hvac-sales.json"), { ...sales, meta: { ...(sales.meta || {}), record_count: salesRows.length }, records: salesRows });
    const report = readJson(path.join(SRC, "data", "commission-report.json"));
    writeJson(path.join(dir, "data", "commission-report.json"), pruneCaKeys(report, person.ca));
  }

  const jobNumbers = new Set(salesRows.map((r) => String(r.job || "").trim()).filter(Boolean));
  const personDash = {
    meta: dash.meta,
    technicians: tech ? [tech] : [],
    // Estimates this person is on; any other consultant's id is dropped from a shared estimate's assignee list.
    estimates: (dash.estimates || [])
      .filter((e) => (e.assigned_employee_ids || []).includes(person.techId))
      .map((e) => ({ ...e, assigned_employee_ids: e.assigned_employee_ids.filter((id) => !others.some((o) => o.techId === id)) })),
    // The HVAC page only reads invoice_number + created_at, and only for this consultant's own sold rows.
    jobs: person.kind === "hvac"
      ? (dash.jobs || [])
          .filter((j) => j.invoice_number && jobNumbers.has(String(j.invoice_number).trim()))
          .map((j) => ({ invoice_number: j.invoice_number, created_at: j.created_at }))
      : [],
    by_technician: {},
    unassigned: [],
  };
  writeJson(path.join(dir, "data", "dashboard.json"), personDash);
  fs.copyFileSync(path.join(OUT, "data", "refresh-health.json"), path.join(dir, "data", "refresh-health.json"));
}

// ---------------------------------------------------------------- verification
function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function jsonKeysDeep(node, fn) {
  if (Array.isArray(node)) node.forEach((n) => jsonKeysDeep(n, fn));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) { fn(k); jsonKeysDeep(v, fn); }
}

function verifyIsolation() {
  // 1. The company-wide root must hold no personal page, data file, or consultant token.
  for (const f of ROOT_EXCLUDE) {
    if (fs.existsSync(path.join(OUT, f))) fail(`root still contains ${f}`);
  }
  const rootShared = fs.readFileSync(path.join(OUT, "shared.js"), "utf8");
  for (const p of PEOPLE) if (p.token && rootShared.includes(p.token)) fail(`root shared.js still contains ${p.slug}'s token`);

  // 2. Each person folder must hold nothing belonging to the others.
  for (const person of PEOPLE) {
    const dir = path.join(OUT, person.slug);
    const others = PEOPLE.filter((p) => p.slug !== person.slug);
    walk(dir, (file) => {
      const r = path.relative(OUT, file).split(path.sep).join("/");
      const ext = path.extname(file).toLowerCase();
      for (const o of others) {
        if (r.includes(o.photo)) fail(`${r} is ${o.slug}'s photo`);
      }
      if (![".js", ".html", ".css", ".json"].includes(ext)) return;
      const text = fs.readFileSync(file, "utf8");
      for (const o of others) {
        const hay = [o.token, o.techId, o.fullName, o.fullName.split(" ")[1]].filter(Boolean);
        for (const needle of hay) {
          // a customer could legitimately be named "Webb"; only enforce last names for code files
          if (needle === o.fullName.split(" ")[1] && ext === ".json") continue;
          if (text.includes(needle)) fail(`${r} contains ${o.slug}'s "${needle}"`);
        }
        // first names: only in this page's own code (not shared.js, which names the whole roster)
        if (/(^|\/)(hvac-sales|andrew)\.(js|html|css)$/.test(r) || r.endsWith("/index.html")) {
          if (new RegExp(`\\b${o.ca}\\b`).test(text)) fail(`${r} mentions ${o.ca}`);
        }
      }
    });
    // structured checks on the data
    const dash = JSON.parse(fs.readFileSync(path.join(dir, "data", "dashboard.json"), "utf8"));
    if ((dash.technicians || []).length !== 1 || dash.technicians[0].id !== person.techId) fail(`${person.slug}/dashboard.json technicians is not exactly this person`);
    for (const e of dash.estimates || []) if (!(e.assigned_employee_ids || []).includes(person.techId)) fail(`${person.slug}/dashboard.json holds an estimate that is not theirs`);
    if (person.kind === "hvac") {
      const sales = JSON.parse(fs.readFileSync(path.join(dir, "data", "hvac-sales.json"), "utf8"));
      for (const rec of sales.records || []) if (rec.ca !== person.ca) fail(`${person.slug}/hvac-sales.json holds a row for ${rec.ca}`);
      const report = JSON.parse(fs.readFileSync(path.join(dir, "data", "commission-report.json"), "utf8"));
      jsonKeysDeep(report, (k) => {
        if (PEOPLE.some((p) => p.ca === k && p.ca !== person.ca)) fail(`${person.slug}/commission-report.json has a "${k}" key`);
      });
    }
  }
}

// ---------------------------------------------------------------------- main
copyDir(SRC, OUT);
for (const p of PEOPLE) {
  try {
    buildPerson(p);
  } catch (err) {
    fail(`${p.slug}: ${err.stack || err.message}`);
  }
}
walk(OUT, noteSize);
if (!failed) verifyIsolation();

for (const f of bigFiles) console.log(`NOTE: ${f.file} is ${(f.size / 1048576).toFixed(1)} MiB (limit 25 MiB)`);
if (failed) {
  console.error(`\n${problems.length} problem(s); not safe to deploy.`);
  process.exit(1);
}
console.log(`Prepared ${OUT} (root + ${PEOPLE.map((p) => p.slug).join(", ")})`);
