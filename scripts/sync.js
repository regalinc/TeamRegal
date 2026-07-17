// Pulls live job + technician data from the Housecall Pro API and writes
// static JSON files that the dashboard (docs/) reads. Run by
// .github/workflows/sync.yml on a schedule, or locally via `npm run sync`.

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.housecallpro.com";
const API_KEY = process.env.HCP_API_KEY;
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap against runaway pagination

// Job data window: yesterday through 13 days out, so the dashboard covers
// "what already happened today" through "what's coming up".
const WINDOW_DAYS_BACK = 1;
const WINDOW_DAYS_FORWARD = 13;

// Statuses that represent a cancellation, per the `work_status` values
// documented for Job objects (distinct from the query-filter enum).
const CANCELED_STATUSES = new Set(["user canceled", "pro canceled"]);

const OUT_DIR = path.join(__dirname, "..", "docs", "data");

function assertApiKey() {
  if (!API_KEY) {
    console.error("Missing HCP_API_KEY environment variable.");
    process.exit(1);
  }
}

async function hcpGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, value);
  }

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${API_KEY}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Housecall Pro API ${res.status} ${res.statusText} for ${url.pathname}${url.search}: ${body.slice(0, 500)}`
    );
  }

  return res.json();
}

// Fetches every page of a paginated HCP list endpoint and returns the
// combined items from `itemsKey` (e.g. "jobs", "employees").
async function fetchAllPages(pathname, params, itemsKey) {
  const items = [];
  let page = 1;
  let totalPages = 1;

  do {
    const data = await hcpGet(pathname, { ...params, page, page_size: PAGE_SIZE });
    items.push(...(data[itemsKey] || []));
    totalPages = data.total_pages || 1;
    page += 1;
  } while (page <= totalPages && page <= MAX_PAGES);

  return items;
}

function isoStartOfDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function fetchEmployees() {
  return fetchAllPages("/employees", {}, "employees");
}

async function fetchJobsInWindow() {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_DAYS_BACK);
  const windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + WINDOW_DAYS_FORWARD);

  return fetchAllPages(
    "/jobs",
    {
      scheduled_start_min: isoStartOfDay(windowStart),
      scheduled_start_max: isoStartOfDay(windowEnd),
      sort_by: "created_at",
      sort_direction: "asc",
    },
    "jobs"
  );
}

// Housecall Pro tag entry is free-text, so the same tag can come back with
// stray whitespace (e.g. "Customer Service Specialist " vs "Customer
// Service Specialist") and fragment what should be one department/tag.
function normalizeTags(tags) {
  const seen = new Set();
  for (const raw of tags || []) {
    const t = String(raw).trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

// Public dashboard data intentionally omits customer PII (phone, email,
// full street address) and technician contact info — only what a
// technician needs to see their own schedule at a glance.
function toPublicTechnician(employee) {
  return {
    id: employee.id,
    name: `${employee.first_name || ""} ${employee.last_name || ""}`.trim(),
    role: employee.role || null,
    color_hex: employee.color_hex || null,
    avatar_url: employee.avatar_url || null,
    // Department membership is modeled as employee tags in Housecall Pro
    // (e.g. "HVAC", "Plumbing") — the dashboard treats these as departments.
    tags: normalizeTags(employee.tags),
  };
}

function toPublicJob(job) {
  const customer = job.customer || {};
  const address = job.address || {};
  return {
    id: job.id,
    description: job.description || "",
    work_status: job.work_status,
    customer_label: [customer.first_name, customer.last_name ? customer.last_name[0] + "." : null]
      .filter(Boolean)
      .join(" "),
    city: address.city || null,
    state: address.state || null,
    zip: address.zip || null,
    schedule: job.schedule || null,
    assigned_employee_ids: (job.assigned_employees || []).map((e) => e.id),
    tags: normalizeTags(job.tags),
    business_unit: job.job_fields?.business_unit?.name || null,
    total_amount: typeof job.total_amount === "number" ? job.total_amount : 0,
    outstanding_balance: typeof job.outstanding_balance === "number" ? job.outstanding_balance : 0,
    updated_at: job.updated_at,
  };
}

async function main() {
  assertApiKey();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("Fetching employees...");
  const employees = await fetchEmployees();
  console.log(`  ${employees.length} employees`);

  console.log("Fetching jobs...");
  const rawJobs = await fetchJobsInWindow();
  const jobs = rawJobs.filter((j) => !CANCELED_STATUSES.has(j.work_status));
  console.log(`  ${rawJobs.length} jobs fetched, ${jobs.length} after dropping canceled`);

  const technicians = employees.map(toPublicTechnician);
  const publicJobs = jobs.map(toPublicJob);

  const byTechnician = {};
  for (const tech of technicians) byTechnician[tech.id] = [];
  const unassigned = [];

  for (const job of publicJobs) {
    if (job.assigned_employee_ids.length === 0) {
      unassigned.push(job);
      continue;
    }
    for (const empId of job.assigned_employee_ids) {
      if (!byTechnician[empId]) byTechnician[empId] = [];
      byTechnician[empId].push(job);
    }
  }

  const meta = {
    last_synced_at: new Date().toISOString(),
    window_days_back: WINDOW_DAYS_BACK,
    window_days_forward: WINDOW_DAYS_FORWARD,
    technician_count: technicians.length,
    job_count: publicJobs.length,
  };

  fs.writeFileSync(path.join(OUT_DIR, "technicians.json"), JSON.stringify(technicians, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "jobs.json"), JSON.stringify(publicJobs, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "dashboard.json"),
    // `jobs` is the deduped flat list (one entry per job regardless of how many
    // technicians it's assigned to) — the dashboard uses it for filtering and
    // metrics so multi-technician jobs aren't double-counted in revenue/totals.
    JSON.stringify({ meta, technicians, jobs: publicJobs, by_technician: byTechnician, unassigned }, null, 2)
  );

  console.log(`Wrote data to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
