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

// Request timing / rate-limit telemetry, printed at the end of every run
// (see logRequestStats). Added 2026-11-02 to size a possible parallel-fetch
// speedup: a run is ~200 sequential requests taking ~20 minutes, and we don't
// know how fast HCP answers or how much concurrency it tolerates. Purely
// observational -- nothing here changes what the sync fetches or writes, and
// it never logs the Authorization header.
// totalMs/minMs/maxMs = time until HCP starts answering (headers); totalBodyMs =
// time spent downloading + parsing the JSON bodies afterwards.
const requestStats = {
  count: 0,
  totalMs: 0,
  totalBodyMs: 0,
  minMs: Infinity,
  maxMs: 0,
  slowest: null,
  byStatus: {},
  byEndpoint: {},
  rateLimitHeaders: {},
};
const RATE_LIMIT_HEADER = /rate|limit|retry|remaining|throttle/i;

function recordRequest(pathname, ms, res) {
  try {
    requestStats.count += 1;
    requestStats.totalMs += ms;
    requestStats.minMs = Math.min(requestStats.minMs, ms);
    if (ms > requestStats.maxMs) {
      requestStats.maxMs = ms;
      requestStats.slowest = `${pathname} (${Math.round(ms)}ms)`;
    }
    requestStats.byStatus[res.status] = (requestStats.byStatus[res.status] || 0) + 1;
    const ep = (requestStats.byEndpoint[pathname] ||= { count: 0, totalMs: 0 });
    ep.count += 1;
    ep.totalMs += ms;
    for (const [name, value] of res.headers) {
      if (RATE_LIMIT_HEADER.test(name)) requestStats.rateLimitHeaders[name] = value; // last value seen
    }
    if (!res.ok) console.warn(`HCP ${res.status} on ${pathname} after ${Math.round(ms)}ms`);
  } catch (e) {
    // telemetry must never break a sync
  }
}

function logRequestStats() {
  try {
    const s = requestStats;
    if (!s.count) return;
    const endpoints = Object.fromEntries(
      Object.entries(s.byEndpoint).map(([p, v]) => [p, `${v.count} req, avg ${Math.round(v.totalMs / v.count)}ms`])
    );
    console.log(
      "HCP request stats: " +
        JSON.stringify(
          {
            requests: s.count,
            wait_for_response_seconds: Math.round(s.totalMs / 1000),
            body_download_seconds: Math.round(s.totalBodyMs / 1000),
            avg_response_ms: Math.round(s.totalMs / s.count),
            min_response_ms: Math.round(s.minMs),
            max_response_ms: Math.round(s.maxMs),
            slowest: s.slowest,
            by_status: s.byStatus,
            by_endpoint: endpoints,
            rate_limit_headers: s.rateLimitHeaders,
          },
          null,
          2
        )
    );
  } catch (e) {
    // telemetry must never break a sync
  }
}

// Parallel fetching (added 2026-11-11 to cut the run from ~20 minutes to a few:
// it was ~200 requests one after another at ~6 s each). HCP_CONCURRENCY caps how
// many requests are in flight at once; set it to 1 to get the old behaviour.
// Results are always put back in their original order, so the output files
// are identical to what a sequential run produces.
const HCP_CONCURRENCY = Math.max(1, Number(process.env.HCP_CONCURRENCY) || 4);
const MAX_ATTEMPTS = 6; // per request, for 429 / 5xx / network errors

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn over items with at most `limit` in flight; returns results in item order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Global cap on requests in flight, however many crawls run at once.
let inFlight = 0;
const waiting = [];
async function acquireSlot() {
  if (inFlight < HCP_CONCURRENCY) {
    inFlight += 1;
    return;
  }
  await new Promise((resolve) => waiting.push(resolve));
}
function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else inFlight -= 1;
}

async function hcpGet(pathname, params) {
  const url = new URL(API_BASE + pathname);
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, value);
  }

  for (let attempt = 1; ; attempt++) {
    let startedAt = performance.now();
    let res;
    try {
      await acquireSlot();
      startedAt = performance.now(); // time the request itself, not the wait for a slot
      try {
        res = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Token ${API_KEY}`,
          },
        });
      } finally {
        releaseSlot();
      }
    } catch (err) {
      // network hiccup (reset, DNS, timeout) -- retry like a 5xx
      if (attempt >= MAX_ATTEMPTS) throw err;
      const wait = Math.min(30000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(`HCP network error on ${url.pathname} (attempt ${attempt}): ${err.message}; retrying in ${Math.round(wait)}ms`);
      await sleep(wait);
      continue;
    }
    recordRequest(url.pathname, performance.now() - startedAt, res);

    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = (retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt)) + Math.random() * 500;
        console.warn(`HCP ${res.status} on ${url.pathname} (attempt ${attempt}); retrying in ${Math.round(wait)}ms`);
        await res.text().catch(() => "");
        await sleep(wait);
        continue;
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Housecall Pro API ${res.status} ${res.statusText} for ${url.pathname}${url.search}: ${body.slice(0, 500)}`
      );
    }

    const bodyStartedAt = performance.now();
    const body = await res.json();
    requestStats.totalBodyMs += performance.now() - bodyStartedAt;
    return body;
  }
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

  // Work out the date chunks first, then fetch them in parallel (see
  // HCP_CONCURRENCY); each chunk's own pages are still fetched in order.
  const chunks = [];
  let chunkStart = windowStart;
  while (chunkStart < windowEnd) {
    const chunkEnd = new Date(chunkStart);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + JOB_FETCH_CHUNK_DAYS);
    if (chunkEnd > windowEnd) chunkEnd.setTime(windowEnd.getTime());
    chunks.push({ start: chunkStart, end: chunkEnd });
    chunkStart = chunkEnd;
  }

  const perChunk = await mapLimit(chunks, HCP_CONCURRENCY, (chunk) =>
    fetchAllPages(
      "/jobs",
      {
        scheduled_start_min: isoStartOfDay(chunk.start),
        scheduled_start_max: isoStartOfDay(chunk.end),
        sort_by: "created_at",
        sort_direction: "asc",
      },
      "jobs"
    )
  );

  // Chunk boundaries are date-only (start-of-day), so a job scheduled
  // exactly at a boundary could in principle appear in two adjacent
  // chunks — de-dupe defensively by id (in chunk order, as before).
  const jobs = [];
  const seenIds = new Set();
  for (const chunkJobs of perChunk) {
    for (const job of chunkJobs) {
      if (seenIds.has(job.id)) continue;
      seenIds.add(job.id);
      jobs.push(job);
    }
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

  // One independent crawl per work_status, run in parallel (each crawl's own
  // pages stay sequential -- it stops early once it passes the cutoff).
  async function crawlStatus(workStatus) {
    const found = [];
    const fetchPage = (p) =>
      hcpGet("/estimates", {
        work_status: workStatus,
        sort_by: "created_at",
        sort_direction: "desc",
        page: p,
        page_size: PAGE_SIZE,
      });
    // Returns true once a page contains an estimate older than the cutoff
    // (results are newest-first, so nothing after it can be in range).
    const consume = (data) => {
      let reachedCutoff = false;
      for (const est of data.estimates || []) {
        if (new Date(est.created_at) < cutoff) {
          reachedCutoff = true;
          continue;
        }
        found.push(est);
      }
      return reachedCutoff;
    };

    // Page 1 tells us how many pages there are; the rest are fetched a batch
    // at a time and consumed strictly in page order, so the result is the same
    // as the old one-page-at-a-time crawl (at worst a batch of extra pages is
    // fetched past the cutoff and ignored).
    const first = await fetchPage(1);
    const totalPages = first.total_pages || 1;
    if (consume(first)) return found;

    let page = 2;
    while (page <= totalPages && page <= MAX_PAGES) {
      const batch = [];
      for (let p = page; p < page + HCP_CONCURRENCY && p <= totalPages && p <= MAX_PAGES; p++) batch.push(p);
      const datas = await Promise.all(batch.map(fetchPage));
      let done = false;
      for (const data of datas) {
        if (consume(data)) {
          done = true;
          break;
        }
      }
      if (done) break;
      page += batch.length;
    }

    return found;
  }

  const perStatus = await mapLimit(ESTIMATE_WORK_STATUSES, HCP_CONCURRENCY, crawlStatus);

  // De-dupe by id, in status order, exactly as the sequential version did.
  const estimates = [];
  const seenIds = new Set();
  for (const list of perStatus) {
    for (const est of list) {
      if (seenIds.has(est.id)) continue;
      seenIds.add(est.id);
      estimates.push(est);
    }
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

// Most customers are a person (first_name + last_name), but a commercial
// account is stored with those blank and the business name in company_name
// instead — first/last-name-only logic left those showing as "Unknown"
// (both toPublicJob and toPublicEstimate render an empty customer_label
// that way). Falls back to company_name only when there's truly no
// person name to build from, so it never overrides a real name a
// commercial account might also have on file.
function customerLabel(customer) {
  const personName = [customer.first_name, customer.last_name ? customer.last_name[0] + "." : null]
    .filter(Boolean)
    .join(" ");
  // Confirmed by hand: company_name (first guess) actually returned Regal's
  // own business name, not the customer's — wrong field. The customer
  // profile's "Company" field is company instead.
  return personName || customer.company || "";
}

function toPublicJob(job) {
  const customer = job.customer || {};
  const address = job.address || {};
  return {
    id: job.id,
    description: job.description || "",
    work_status: job.work_status,
    customer_label: customerLabel(customer),
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
    // The human-facing "Job #" shown in Housecall Pro's own UI (same number
    // as QuickBooks' invoice number) — distinct from the opaque internal
    // `id` above. Lets hvac-sales.js join a spreadsheet row's manually-typed
    // "Job" number back to this exact job, rather than guessing off a
    // privacy-masked customer name. String, not number — seen as e.g.
    // "51731" but not guaranteed to stay purely numeric forever.
    invoice_number: job.invoice_number || null,
    // When this job record was actually created in Housecall Pro — for a
    // job created via the OnCall Air integration, this is effectively "the
    // day the proposal was accepted," which can be well after the original
    // sales-call date (schedule.scheduled_start here is the *install* date,
    // not the sale date). hvac-sales.js uses this, not scheduled_start, to
    // attribute a sold job to the month it actually sold in.
    created_at: job.created_at || null,
  };
}

// "Approved" counts an option the customer approved themselves or one a
// pro marked approved on their behalf (e.g. after a phone call) — both
// represent a real conversion.
const APPROVED_OPTION_STATUSES = new Set(["approved", "pro approved"]);

// Commit fd87ff5 (2026-07-22) started deriving approved_at by diffing syncs.
// Estimates created after this have been observed since creation, so a null
// approved_at on one of them means "created and approved within one sync".
const APPROVED_AT_DIFFING_SHIPPED = "2026-07-22T20:00:00Z";

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
// estimate's approved flag flip from false to true is recorded as its
// approved_at, using this sync run's own timestamp. That's accurate to
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
//
// Critically, "no previous record at all" must fall into that same unknown
// bucket (null), NOT be treated as a fresh transition — a bug caught via a
// real example (an estimate genuinely approved back in January showing an
// "Approved" date of today, the first day it happened to sync with no prior
// record to diff against). Only an explicit previousRecord showing
// approved: false is a real observed transition worth stamping.
function toPublicEstimate(estimate, previousRecord, syncedAtIso) {
  const customer = estimate.customer || {};
  const approvedOptions = (estimate.options || []).filter((o) =>
    APPROVED_OPTION_STATUSES.has((o.approval_status || "").toLowerCase())
  );
  const approved = approvedOptions.length > 0;

  let approvedAt = null;
  if (approved && previousRecord) {
    approvedAt = previousRecord.approved ? previousRecord.approved_at : syncedAtIso;
  }
  // Same-interval approvals: an estimate created AND approved between two
  // syncs (a comfort advisor / tech selling on the spot) is first observed
  // already approved with no previous record, so the diff above can't stamp
  // it — and it silently vanished from every approval-date-scoped stat
  // (found 2026-11-06 via Korry Dunkle's estimate 14072; ~250 estimates
  // since August were affected). Diffing has existed since
  // APPROVED_AT_DIFFING_SHIPPED, so any estimate created after that was
  // watched from birth: if its first sighting is already approved, the
  // approval happened between creation and that sighting (hours), and
  // created_at is the best available stand-in. Pre-diffing estimates (the
  // README's "unavoidable gap") are left null on purpose. This also
  // self-heals existing null records on the next sync, since it re-derives
  // from created_at rather than relying on carried-forward state.
  if (approved && !approvedAt && estimate.created_at && estimate.created_at >= APPROVED_AT_DIFFING_SHIPPED) {
    approvedAt = estimate.created_at;
  }

  // Revenue an estimator actually closed — sum of the approved option(s)'
  // total_amount, same cents-based money field convention as jobs.
  const approvedAmount = approvedOptions.reduce((sum, o) => sum + (typeof o.total_amount === "number" ? o.total_amount : 0), 0);

  return {
    id: estimate.id,
    estimate_number: estimate.estimate_number || null,
    customer_label: customerLabel(customer),
    created_at: estimate.created_at,
    // Not every estimate has a scheduled site visit (phone/remote estimates
    // don't), so this is often null — see SCHEDULE_SCOPED_ESTIMATOR_IDS in
    // app.js for the one place that reads it instead of created_at.
    schedule: estimate.schedule || null,
    // NOT job_fields — Estimates carry their own separate estimate_fields
    // wrapper for this, confirmed against a real raw API response (a
    // first guess of job_fields, mirroring toPublicJob below, silently
    // returned null for every one of 3117 estimates on the first sync
    // attempt after this was added). Many estimates inherit this from the
    // job they were created from, but it's set on the estimate record
    // itself either way, so no job-lookup/join is needed to get it. Added
    // so company-scorecard.js can compute an Estimate closing % per
    // department — see "estimateClosingRate" in
    // departments-config.js/shared.js.
    business_unit: estimate.estimate_fields?.business_unit?.name || null,
    assigned_employee_ids: (estimate.assigned_employees || []).map((e) => e.id),
    // Kept specifically so the dashboard can exclude canceled estimates from
    // Given/Approved/Revenue counts (CANCELED_ESTIMATE_STATUSES/
    // isCanceledEstimate in shared.js) — added after a real example: a
    // customer called in and canceled before the estimate was ever
    // presented, but with no work_status synced there was no way to tell
    // that apart from a legitimately given one still sitting there open.
    // Note this returned value ("user canceled"/"pro canceled", confirmed
    // against real synced data) doesn't match ESTIMATE_WORK_STATUSES above
    // ("canceled") — that array is only the *query filter* values used to
    // fetch estimates by bucket, not what the API returns on the object
    // itself. Not normalized here; shared.js compares against the raw value.
    work_status: estimate.work_status || null,
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

  // Note (from a one-off debug run): a `GET /estimates` object has no
  // reference back to the job it was created from — the full field set is
  // id, estimate_number, work_status, lead_source, customer, address,
  // created_at, updated_at, company_name, company_id, work_timestamps,
  // schedule, assigned_employees, estimate_fields{job_type, business_unit},
  // assigned_route_template_id, options. So an estimate whose own
  // estimate_fields.business_unit is null (~80% of them) can't have a BU
  // inferred from a job; the only way to attribute one is for staff to
  // set the Business Unit on the estimate itself in Housecall Pro.

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
  logRequestStats();
}

main().catch((err) => {
  console.error(err);
  logRequestStats(); // a failed run's numbers (e.g. a 429) are the most useful ones
  process.exit(1);
});
