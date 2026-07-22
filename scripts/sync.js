// Pulls live job + technician data from the Housecall Pro API and writes
// static JSON files that the dashboard (docs/) reads. Run by
// .github/workflows/sync.yml on a schedule, or locally via `npm run sync`.

const fs = require("fs");
const path = require("path");

const API_BASE = "https://api.housecallpro.com";
const API_KEY = process.env.HCP_API_KEY;
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // safety cap against runaway pagination

// Job data window: at least 62 days back through 13 days out. The 62-day
// floor reliably covers "this month" and "last month" for the dashboard's
// period filter no matter what day of the current month it is — worst case
// is the last day of a 31-day month needing the full current month (31
// days) plus the full previous month (31 days) behind it. On top of that
// floor, the back side always stretches to cover Jan 1 of the current year
// so "Year to date" is accurate — this grows from ~62 days in January up to
// ~365 days by December (see daysBackToStartOfYear below).
const MIN_WINDOW_DAYS_BACK = 62;
const WINDOW_DAYS_FORWARD = 13;

function daysBackToStartOfYear(date) {
  const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
}

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

function windowDaysBack(now) {
  return Math.max(MIN_WINDOW_DAYS_BACK, daysBackToStartOfYear(now));
}

// Jobs are fetched in date-range chunks rather than one long paginated
// crawl over the whole window. A single crawl needs ~1 page per ~10 days
// (~29 pages at the old fixed 62-day window, up to ~47 pages once the
// window grows to a full year for "Year to date") — HCP's page-number
// pagination isn't a stable cursor, and against a live, constantly-updated
// dataset, a crawl that long can silently drop records as jobs are created
// mid-crawl and shift what page existing jobs land on (classic
// offset-pagination drift). Keeping each chunk short (and thus its page
// count low, typically 1-3 pages) keeps each individual crawl fast enough
// that this drift isn't a real risk, at the cost of more total requests.
const JOB_FETCH_CHUNK_DAYS = 14;

async function fetchJobsInWindow() {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - windowDaysBack(now));
  const windowEnd = new Date(now);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + WINDOW_DAYS_FORWARD);

  const jobs = [];
  const seenIds = new Set();
  let chunkStart = windowStart;

  while (chunkStart < windowEnd) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + JOB_FETCH_CHUNK_DAYS);
    if (chunkEnd > windowEnd) chunkEnd.setTime(windowEnd.getTime());

    const chunkJobs = await fetchAllPages(
      "/jobs",
      {
        scheduled_start_min: isoStartOfDay(chunkStart),
        scheduled_start_max: isoStartOfDay(chunkEnd),
        sort_by: "created_at",
        sort_direction: "asc",
      },
      "jobs"
    );

    // Chunk boundaries are date-only (start-of-day), so a job scheduled
    // exactly at a boundary could in principle appear in two adjacent
    // chunks — de-dupe defensively by id.
    for (const job of chunkJobs) {
      if (seenIds.has(job.id)) continue;
      seenIds.add(job.id);
      jobs.push(job);
    }

    chunkStart = chunkEnd;
  }

  return jobs;
}

const ESTIMATE_WORK_STATUSES = ["unscheduled", "scheduled", "in_progress", "completed", "canceled"];

// Estimates have no creation-date range filter (only scheduled_start/end,
// the on-site visit time — many estimates never have one), so this can't be
// chunked by date the way fetchJobsInWindow is. As a partial mitigation
// against the same offset-pagination drift that silently dropped job
// records (see fetchJobsInWindow's comment), each work_status is fetched
// separately — a real, disjoint filter that shortens each individual crawl
// — and within each, paging stops as soon as an estimate's created_at falls
// before the sync window, since results are sorted newest-first and nothing
// after that point can still be in range. A defensive id de-dupe guards
// against the same estimate turning up in more than one status bucket if
// its status changes mid-sync.
async function fetchEstimatesInWindow() {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDaysBack(now));

  const estimates = [];
  const seenIds = new Set();

  for (const workStatus of ESTIMATE_WORK_STATUSES) {
    let page = 1;
    let totalPages = 1;

    do {
      const data = await hcpGet("/estimates", {
        work_status: workStatus,
        sort_by: "created_at",
        sort_direction: "desc",
        page,
        page_size: PAGE_SIZE,
      });

      let reachedCutoff = false;
      for (const est of data.estimates || []) {
        if (new Date(est.created_at) < cutoff) {
          reachedCutoff = true;
          continue;
        }
        if (seenIds.has(est.id)) continue;
        seenIds.add(est.id);
        estimates.push(est);
      }

      totalPages = data.total_pages || 1;
      page += 1;
      if (reachedCutoff) break;
    } while (page <= totalPages && page <= MAX_PAGES);
  }

  return estimates;
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

// Lead source is also free text on the customer record, so the same
// real-world source can end up spelled more than one way (e.g. a dropped
// apostrophe) and get split into separate entries on the lead source
// chart. Known variants are canonicalized to one name here; add to this
// map as new duplicates turn up rather than fixing them in HCP itself,
// since re-typed history wouldn't retroactively fix already-synced jobs.
const LEAD_SOURCE_ALIASES = {
  lowes: "Lowe's",
};

function normalizeLeadSource(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;
  return LEAD_SOURCE_ALIASES[trimmed.toLowerCase()] || trimmed;
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
    // The customer's lead source (set once on the customer record — how they
    // originally found the company), not the job-level lead_source field,
    // which is usually unset since HCP treats lead source as a customer
    // attribute rather than something logged per job.
    lead_source: normalizeLeadSource(customer.lead_source),
    total_amount: typeof job.total_amount === "number" ? job.total_amount : 0,
    outstanding_balance: typeof job.outstanding_balance === "number" ? job.outstanding_balance : 0,
    completed_at: job.work_timestamps?.completed_at || null,
    updated_at: job.updated_at,
  };
}

// "Approved" counts an option the customer approved themselves or one a
// pro marked approved on their behalf (e.g. after a phone call) — both
// represent a real conversion.
const APPROVED_OPTION_STATUSES = new Set(["approved", "pro approved"]);

// There's no dedicated "approved at" field on an estimate, and the obvious
// stand-in — the approved option's own updated_at — turned out to be
// unreliable: it bumps on *any* change to the option, including the
// resulting job's status progressing (scheduled -> started -> completed)
// long after the actual approval decision. In practice this meant ~13% of
// approved estimates showed an approval date weeks or months later than
// when they were really approved.
//
// Instead, approved_at is derived by diffing against the *previous* sync's
// output (passed in as `previousRecord`): the first time we observe an
// estimate's approved flag flip from false to true (or see it approved
// with no prior record at all — nothing to diff against) is recorded as
// its approved_at, using this sync run's own timestamp. That's accurate to
// within one sync interval, which beats trusting a field that can silently
// drift by months.
//
// The unavoidable gap: an estimate that was *already* approved as of the
// last sync just carries forward whatever approved_at that sync recorded —
// including null, if it was already approved before this diffing approach
// shipped (or first entered the sync window already approved) and we
// therefore never observed the actual transition. Those stay null (and so
// drop out of every approval-date-scoped stat) unless Housecall Pro's
// approval status genuinely changes again later. There's no way to
// retroactively recover a timestamp we never observed; only a real-time
// webhook integration (a bigger project — see README) would close this gap
// for good.
function toPublicEstimate(estimate, previousRecord, syncedAtIso) {
  const customer = estimate.customer || {};
  const approvedOptions = (estimate.options || []).filter((o) =>
    APPROVED_OPTION_STATUSES.has((o.approval_status || "").toLowerCase())
  );
  const approved = approvedOptions.length > 0;

  let approvedAt = null;
  if (approved) {
    approvedAt = previousRecord && previousRecord.approved ? previousRecord.approved_at : syncedAtIso;
  }

  // Revenue an estimator actually closed — sum of the approved option(s)'
  // total_amount, same cents-based money field convention as jobs.
  const approvedAmount = approvedOptions.reduce((sum, o) => sum + (typeof o.total_amount === "number" ? o.total_amount : 0), 0);

  return {
    id: estimate.id,
    estimate_number: estimate.estimate_number || null,
    customer_label: [customer.first_name, customer.last_name ? customer.last_name[0] + "." : null].filter(Boolean).join(" "),
    created_at: estimate.created_at,
    assigned_employee_ids: (estimate.assigned_employees || []).map((e) => e.id),
    approved,
    approved_at: approvedAt,
    approved_amount: approvedAmount,
  };
}

// Reads the previous sync's estimates.json, if any (there won't be one on
// the very first-ever run), so toPublicEstimate can diff against it to
// derive approved_at. Missing/unparseable file -> empty map, same as
// "we have no prior observation for any of these."
function loadPreviousEstimatesById() {
  const previousPath = path.join(OUT_DIR, "estimates.json");
  try {
    const raw = JSON.parse(fs.readFileSync(previousPath, "utf8"));
    return new Map(raw.map((e) => [e.id, e]));
  } catch {
    return new Map();
  }
}

async function main() {
  assertApiKey();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const syncedAt = new Date();
  const syncedAtIso = syncedAt.toISOString();

  const previousEstimatesById = loadPreviousEstimatesById();

  console.log("Fetching employees...");
  const employees = await fetchEmployees();
  console.log(`  ${employees.length} employees`);

  console.log("Fetching jobs...");
  // Canceled jobs are kept (not dropped) so the dashboard can report a
  // cancellation rate — the client-side stat computations exclude them from
  // every other metric, same as before.
  const rawJobs = await fetchJobsInWindow();
  console.log(`  ${rawJobs.length} jobs fetched`);

  console.log("Fetching estimates...");
  const rawEstimates = await fetchEstimatesInWindow();
  console.log(`  ${rawEstimates.length} estimates fetched`);

  const technicians = employees.map(toPublicTechnician);
  const publicJobs = rawJobs.map(toPublicJob);
  const publicEstimates = rawEstimates.map((e) => toPublicEstimate(e, previousEstimatesById.get(e.id), syncedAtIso));

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
    last_synced_at: syncedAtIso,
    window_days_back: windowDaysBack(syncedAt),
    window_days_forward: WINDOW_DAYS_FORWARD,
    technician_count: technicians.length,
    job_count: publicJobs.length,
    estimate_count: publicEstimates.length,
  };

  fs.writeFileSync(path.join(OUT_DIR, "technicians.json"), JSON.stringify(technicians, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "jobs.json"), JSON.stringify(publicJobs, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, "estimates.json"), JSON.stringify(publicEstimates, null, 2));
  fs.writeFileSync(
    path.join(OUT_DIR, "dashboard.json"),
    // `jobs` is the deduped flat list (one entry per job regardless of how many
    // technicians it's assigned to) — the dashboard uses it for filtering and
    // metrics so multi-technician jobs aren't double-counted in revenue/totals.
    JSON.stringify(
      { meta, technicians, jobs: publicJobs, estimates: publicEstimates, by_technician: byTechnician, unassigned },
      null,
      2
    )
  );

  console.log(`Wrote data to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
