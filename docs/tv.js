// TV kiosk view — one screen per department/business-unit, driven entirely
// by the `dept` URL param so the same page serves every physical TV (e.g.
// tv.html?dept=Office or tv.html?dept=30). Shared data/compute helpers
// (formatMoney, computeScorecardStats, periodRange, jobInPeriod,
// businessUnitCode, etc.) come from shared.js, loaded before this;
// rendering here is TV-specific since the scale and layout are nothing like
// the desktop scorecards.

const urlParams = new URLSearchParams(location.search);

// The four field departments are already real employee tags (same ones the
// technician-view quick-filter buttons use). There's no equivalent "Office"
// tag, so Office is a catch-all: anyone not carrying one of the four field
// tags, minus a few system/dispatch accounts that aren't real people.
const FIELD_DEPT_TAGS = ["Plumbing Service", "Plumbing Installation", "HVAC Service", "HVAC Installation"];
const OFFICE_LABEL = "Office";
const EXCLUDED_TECH_IDS = new Set([
  "pro_932c9cd2fe1642e0b5cb3d7a9c0c94a9", // Marketing Department
  "pro_275a4180be774faa8606cf065969a962", // Urgency Plumbing
  "pro_a66fbc5ec25d48bb8db8a93609a0654f", // Urgency HVAC
]);

// Screens that show one tag-roster's full leaderboard, unscoped to any one
// business unit — unchanged from the original design.
const SINGLE_DEPTS = ["Plumbing Installation", "HVAC Installation", OFFICE_LABEL];

// HVAC Service and Plumbing Service each cover two business units in
// practice (e.g. an "HVAC Service" tech's jobs land under either the "30"
// service BU or the "40" maintenance BU). Showing both BUs on one screen
// (two stacked sections) was too dense, so each BU now gets its own
// dedicated screen instead — same roster (rosterTag), same featured-card +
// list layout as the single-tag screens, just scoped to that one BU's jobs.
// `fallbackLabel` only shows if no job in view happens to carry that BU's
// exact string (the header/rank subtitle otherwise read it live off the
// data — see businessUnitLabelForCode — so it always matches what
// admin.html shows for the same BU rather than risking drift from a
// hardcoded name).
const BU_DEPTS = {
  30: { rosterTag: "HVAC Service", fallbackLabel: "30 HVAC Service" },
  40: { rosterTag: "HVAC Service", fallbackLabel: "40 HVAC Maintenance" },
  70: { rosterTag: "Plumbing Service", fallbackLabel: "70 Plumbing Service" },
  80: { rosterTag: "Plumbing Service", fallbackLabel: "80 Plumbing Maintenance" },
};

// Four plumbers who split their time between Plumbing Installation (BU 50)
// and Plumbing Service (BU 70) work — they carry only the "Plumbing
// Installation" tag, so they don't show on the BU 70/80 screens, and a
// single blended number would mix $15k installs with $500 service calls.
// FLEX_DEPT gets its own screen (renderPlumbingFlexScreen) where each
// person's card is split: a graded Service half (BU 70 targets) and a
// plain Install half (BU 50 jobs, no targets to grade against on a TV).
// Manual id list, same pattern as INSTALLATION_TEAM_TECH_IDS — add a
// name here if the roster changes.
const FLEX_DEPT = "Plumbing Flex";
const PLUMBING_FLEX_TECH_IDS = new Set([
  "pro_1526b39a952147619f19902966416543", // Justin Baker
  "pro_79f4ca1c644741dc89563174e5b5d4fa", // Jason Smeltzer
  "pro_9a3f2249ef464465a1522f4a3ccfef5a", // Brandon Soltes
  "pro_878f7465a7ae48a39312d99aedaa3fd1", // Bradley Adams
]);

const VALID_DEPTS = [...SINGLE_DEPTS, FLEX_DEPT, ...Object.keys(BU_DEPTS)];

// The dept param has to survive being typed on a TV remote's on-screen
// keyboard, which is slow and error-prone for spaces/capitalization/exact
// punctuation — so matching is forgiving rather than an exact string
// comparison: case-insensitive, and treats -, _, and + the same as a space
// (so "plumbing-service" or "PLUMBING_SERVICE" both resolve the same as
// "Plumbing Service"). Every valid URL from before this change still works
// unchanged; this only widens what else also works.
function normalizeDeptKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ");
}

function resolveDept(raw) {
  const key = normalizeDeptKey(raw);
  return VALID_DEPTS.find((d) => normalizeDeptKey(d) === key) || null;
}

const DEPT = resolveDept(urlParams.get("dept"));
const PERIOD = urlParams.has("period") ? urlParams.get("period") : "month";

const deptNameEl = document.getElementById("tv-dept-name");
const mainEl = document.getElementById("tv-main");

function departmentOf(tech) {
  // Apprentices don't get their own TV row yet, same reason they don't get
  // their own scorecard on index.html — see APPRENTICE_TECH_IDS in
  // shared.js. Distinct from EXCLUDED_TECH_IDS below (those are
  // dispatch/system accounts that aren't real people at all).
  if (EXCLUDED_TECH_IDS.has(tech.id) || isApprentice(tech)) return null;
  const tags = tech.tags || [];
  for (const dept of FIELD_DEPT_TAGS) {
    if (tags.includes(dept)) return dept;
  }
  return OFFICE_LABEL;
}

// KPI targets (tier(), kpiTier()) live in shared.js and read DEPARTMENTS
// from departments-config.js — the same confirmed per-department targets
// the department scorecard/matrix pages use, not a separate copy. admin.html's
// department cards and index.html's technician cards (when a single BU is
// selected) grade against those exact same numbers too. For a BU screen
// (DEPT is "10"/"30"/"40"/"50"/"70"/"80"), kpiTier(DEPT, ...) finds that
// department's targets directly; for a tag-only screen (Office,
// installation) it returns null for every metric since DEPARTMENTS has no
// entry for those, so the tile stays neutral.
const TIER_CLASS = { good: "tv-good", warn: "tv-warn", bad: "tv-bad" };

function kpiClass(metricKey, stats) {
  const result = kpiTier(DEPT, metricKey, stats);
  return result ? TIER_CLASS[result] : null;
}

// Same mapping, graded against an explicit BU code rather than DEPT — the
// Plumbing Flex screen's Service tiles grade against BU 70 even though
// DEPT is "Plumbing Flex" (which has no DEPARTMENTS entry).
function tierClassFor(buCode, metricKey, stats) {
  const result = kpiTier(buCode, metricKey, stats);
  return result ? TIER_CLASS[result] : null;
}

// The HVAC Installation team's monthly revenue goal — given by the
// business, not derived from data. Needs manually adding to at the start of
// each month (ask for the new number rather than guessing or carrying last
// month's forward). Keyed by "YYYY-MM" so a month with no entry shows "no
// goal set" instead of silently reusing a stale number forever.
const INSTALLATION_MONTHLY_GOALS = {
  "2026-08": 475000,
  "2026-09": 450000,
  "2026-10": 415000,
  "2026-11": 415000,
  "2026-12": 415000,
};

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function currentMonthGoal() {
  return INSTALLATION_MONTHLY_GOALS[currentMonthKey()] ?? null;
}

function currentMonthName() {
  return new Date().toLocaleString([], { month: "long" });
}

// renderAvatarBlock()/tvTile() live in shared.js now — fleet-tv.js (the
// driving-behavior kiosk) reuses both.

// Per-screen tile suppression: a metric that just isn't a thing for that
// department. Plumbing Service / Plumbing Maintenance (BU 70/80) don't
// work leads the way HVAC Service does, so Leads / Leads sold only ever
// read 0 there — dropped from those two screens' tile grids at the user's
// request. Keyed by DEPT (a bare "70"/"80" for a BU screen).
const BU_HIDDEN_TV_TILES = {
  70: new Set(["Leads", "Leads sold"]),
  80: new Set(["Leads", "Leads sold"]),
};

// The full metric set shown per technician, in display order. sizeClass
// picks the tile styling ("tv-tile" for the big featured card, "tv-row-tile"
// for a compact list row).
function metricTiles(stats, sizeClass) {
  const hidden = BU_HIDDEN_TV_TILES[DEPT] || new Set();
  return [
    ["Revenue", formatMoney(stats.totalRevenue), kpiClass("revenue", stats)],
    ["Avg ticket", formatMoney(stats.avgTicket), kpiClass("avgTicket", stats)],
    ["Completion", `${stats.completionRate.toFixed(0)}%`, kpiClass("completion", stats)],
    ["Jobs", stats.totalJobs.toLocaleString(), kpiClass("jobs", stats)],
    ["Leads", stats.leads.toLocaleString(), kpiClass("leads", stats)],
    ["Leads sold", stats.leadsSold.toLocaleString(), kpiClass("leadsSold", stats)],
    ["$0 Call", stats.ifo.toLocaleString(), kpiClass("ifo", stats)],
    ["Accessory sold", stats.accessorySold.toLocaleString(), kpiClass("accessorySold", stats)],
  ]
    .filter(([label]) => !hidden.has(label))
    .map(([label, value, cls]) => tvTile(label, value, cls, sizeClass))
    .join("");
}

function renderFeatured(entry, screenLabel) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-featured">
      <div class="tv-featured-photo-wrap">
        ${renderAvatarBlock(tech, "tv-featured-photo", "tv-featured-photo-fallback", { large: true })}
      </div>
      <div class="tv-featured-name">${escapeHtml(tech.name || "Unknown")}</div>
      <div class="tv-featured-rank">#${rank} · ${escapeHtml(screenLabel)}</div>
      <div class="tv-tile-grid">
        ${metricTiles(stats)}
      </div>
    </div>
  `;
}

function renderRow(entry) {
  const { tech, stats, rank } = entry;
  return `
    <div class="tv-row">
      <div class="tv-row-rank">#${rank}</div>
      ${renderAvatarBlock(tech, "tv-row-photo", "tv-row-photo-fallback", { large: true })}
      <div class="tv-row-name-block">
        <div class="tv-row-name">${escapeHtml(tech.name || "Unknown")}</div>
        <div class="tv-row-meta">${escapeHtml(tech.role || "")}</div>
      </div>
      <div class="tv-row-metrics">
        ${metricTiles(stats, "tv-row-tile")}
      </div>
    </div>
  `;
}

function renderInstallationGoal(monthRevenue, goal) {
  if (goal === null) {
    return `<div class="tv-goal-missing">No revenue goal set for ${escapeHtml(currentMonthName())} yet.</div>`;
  }
  const pct = goal > 0 ? Math.min(100, (monthRevenue / goal) * 100) : 0;
  return `
    <div class="tv-goal">
      <div class="tv-goal-label">${escapeHtml(currentMonthName())} Revenue Goal</div>
      <div class="tv-goal-value">${escapeHtml(formatMoney(monthRevenue))} <span class="tv-goal-of">of ${escapeHtml(
    formatMoney(goal)
  )}</span></div>
      <div class="tv-goal-track"><div class="tv-goal-fill" style="width:${pct}%"></div></div>
      <div class="tv-goal-pct">${pct.toFixed(0)}% of goal</div>
    </div>
  `;
}

function installationTiles(stats) {
  return [
    tvTile("Revenue", formatMoney(stats.totalRevenue), kpiClass("revenue", stats), "tv-team-tile"),
    tvTile("Jobs", stats.totalJobs.toLocaleString(), kpiClass("jobs", stats), "tv-team-tile"),
    tvTile("Completion", `${stats.completionRate.toFixed(0)}%`, kpiClass("completion", stats), "tv-team-tile"),
    tvTile("Accessory sold", stats.accessorySold.toLocaleString(), kpiClass("accessorySold", stats), "tv-team-tile"),
  ].join("");
}

// The whole roster's faces, laid out in a row — the point of this screen is
// "team performance", not any one person's, so it shows every member up
// front rather than making it feel like a data table with no one in it.
// Sorted alphabetically (there's no ranking here to sort by) and reuses the
// same renderAvatarBlock/hasRealAvatar/largeAvatarUrl helpers the ranked
// screens use for their featured/row photos, so a missing avatar falls back
// to the same colored-initials treatment everywhere on the TV.
function renderInstallationTeamPhotos(techs) {
  const sorted = [...techs].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return `
    <div class="tv-team-photos">
      ${sorted
        .map(
          (tech) => `
            <div class="tv-team-photo-item">
              ${renderAvatarBlock(tech, "tv-team-photo", "tv-team-photo-fallback", { large: true })}
              <div class="tv-team-photo-name">${escapeHtml(tech.name || "Unknown")}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

// HVAC Installation doesn't rank individual techs at all — see
// INSTALLATION_TEAM_TECH_IDS in shared.js for why — so this screen is a
// single large team card instead of the featured-card + list layout every
// other screen uses. The 5-tile set matches what the technician view's
// team card shows (INSTALLATION_TEAM_HIDDEN_TILES): no Leads/RCC/$0 Call,
// this department doesn't work off those tags. Revenue is unsplit — a team
// total, not a personal attribution — same as the technician-view card.
function renderInstallationTeamScreen() {
  const jobs = latestData.jobs || [];

  function teamJobsInPeriod(period) {
    return jobs.filter(
      (j) =>
        (j.assigned_employee_ids || []).some((id) => INSTALLATION_TEAM_REVENUE_TECH_IDS.has(id)) &&
        businessUnitCode(j.business_unit) === "10" &&
        jobInPeriod(j, period)
    );
  }

  // The goal is always this calendar month's revenue, regardless of
  // whatever ?period= this screen's own tiles are showing — a monthly goal
  // doesn't mean anything scoped to "this week" or "YTD".
  const monthRevenue = computeScorecardStats(teamJobsInPeriod("month"), { splitRevenue: false, rawJobCount: true }).totalRevenue;
  const goal = currentMonthGoal();

  const screenStats = computeScorecardStats(teamJobsInPeriod(PERIOD), { splitRevenue: false, rawJobCount: true });

  const teamTechs = (latestData.technicians || []).filter((t) => INSTALLATION_TEAM_TECH_IDS.has(t.id));

  mainEl.innerHTML = `
    <div class="tv-team">
      ${renderInstallationTeamPhotos(teamTechs)}
      ${renderInstallationGoal(monthRevenue, goal)}
      <div class="tv-team-tiles">
        ${installationTiles(screenStats)}
      </div>
    </div>
  `;
}

// ---- Plumbing Flex screen (BU 50 + BU 70 split cards) ----

// One person's card: a graded Service half (their BU 70 jobs, the same
// tile set + colouring a BU-70-filtered technician card shows on
// index.html, including the two estimate tiles) and a plain Install half
// (their BU 50 jobs — Jobs + split Revenue, no targets to grade against
// on a TV).
function renderFlexCard(entry) {
  const { tech, serviceStats: s, installStats: i, estStats: e, totalRevenue, totalJobs } = entry;
  const svc = (label, value, metricKey) => tvTile(label, value, tierClassFor("70", metricKey, s), "tv-flex-tile");

  const serviceTiles = [
    tvTile("Jobs", s.totalJobs.toLocaleString(), null, "tv-flex-tile"),
    tvTile("Revenue (split)", formatMoney(s.totalRevenue), null, "tv-flex-tile"),
    svc("Avg ticket", formatMoney(s.avgTicket), "avgTicket"),
    tvTile("Completion", `${s.completionRate.toFixed(0)}%`, null, "tv-flex-tile"),
    tvTile("RCC sold", s.servicePlansSold.toLocaleString(), null, "tv-flex-tile"),
    svc("$0 Call", s.ifo.toLocaleString(), "ifo"),
    svc("Accessory sold", s.accessorySold.toLocaleString(), "accessorySold"),
    tvTile("Est. given", e.given.toLocaleString(), null, "tv-flex-tile"),
    tvTile("Est. approved", e.approved.toLocaleString(), tierClassFor("70", "estimateClosingRate", e), "tv-flex-tile"),
  ].join("");

  const installTiles = [
    tvTile("Jobs", i.totalJobs.toLocaleString(), null, "tv-flex-tile"),
    tvTile("Revenue (split)", formatMoney(i.totalRevenue), null, "tv-flex-tile"),
  ].join("");

  return `
    <div class="tv-flex-card">
      <div class="tv-flex-head">
        ${renderAvatarBlock(tech, "tv-flex-photo", "tv-flex-photo-fallback", { large: true })}
        <div class="tv-flex-name-block">
          <div class="tv-flex-name">${escapeHtml(tech.name || "Unknown")}</div>
          <div class="tv-flex-total">${escapeHtml(formatMoney(totalRevenue))} total &middot; ${totalJobs.toLocaleString()} job${
    totalJobs === 1 ? "" : "s"
  }</div>
        </div>
      </div>
      <div class="tv-flex-sections">
        <div class="tv-flex-section tv-flex-section-install">
          <div class="tv-flex-section-label"><span class="tv-flex-bu">BU 50</span> Install</div>
          <div class="tv-flex-grid tv-flex-grid-install">${installTiles}</div>
        </div>
        <div class="tv-flex-section tv-flex-section-service">
          <div class="tv-flex-section-label"><span class="tv-flex-bu">BU 70</span> Service</div>
          <div class="tv-flex-grid tv-flex-grid-service">${serviceTiles}</div>
        </div>
      </div>
    </div>
  `;
}

function renderPlumbingFlexScreen() {
  const jobs = latestData.jobs || [];
  // Canceled estimates excluded, same as every other estimate count on
  // the site (isCanceledEstimate, shared.js).
  const allEstimates = (latestData.estimates || []).filter((est) => !isCanceledEstimate(est));
  const techs = (latestData.technicians || []).filter((t) => PLUMBING_FLEX_TECH_IDS.has(t.id));

  if (techs.length === 0) {
    mainEl.innerHTML = `<p class="tv-empty">No Plumbing Flex technicians found in the synced roster.</p>`;
    return;
  }

  const entries = techs.map((tech) => {
    const techJobs = jobs.filter((j) => (j.assigned_employee_ids || []).includes(tech.id) && jobInPeriod(j, PERIOD));
    const serviceStats = computeScorecardStats(
      techJobs.filter((j) => businessUnitCode(j.business_unit) === "70"),
      { splitRevenue: true }
    );
    const installStats = computeScorecardStats(
      techJobs.filter((j) => businessUnitCode(j.business_unit) === "50"),
      { splitRevenue: true }
    );

    // Estimates aren't BU-scoped here — the estimate's own business_unit
    // field is blank on ~80% of them, so this counts all the tech's
    // estimates, exactly as the BU-70-filtered technician card on
    // index.html does. estimateGivenDate is created_at for everyone but
    // Andrew (none of these four).
    const mine = allEstimates.filter((est) => (est.assigned_employee_ids || []).includes(tech.id));
    const estGiven = mine.filter((est) => dateInPeriod(estimateGivenDate(est, tech), PERIOD));
    const estApproved = mine.filter((est) => est.approved && dateInPeriod(est.approved_at, PERIOD));
    const estStats = computeEstimatorStats(estGiven, estApproved, PERIOD);
    // Fraction under the key kpiTier/hcpMetricValue read, so "Estimates
    // approved" grades against BU 70's estimateClosingRate target (>= 50%).
    estStats.estimateClosingRate = estStats.given ? estStats.approved / estStats.given : null;

    return {
      tech,
      serviceStats,
      installStats,
      estStats,
      totalRevenue: serviceStats.totalRevenue + installStats.totalRevenue,
      totalJobs: serviceStats.totalJobs + installStats.totalJobs,
    };
  });

  // Alphabetical by name — this is a small fixed crew, not a leaderboard,
  // so a stable name order reads more naturally than a revenue ranking.
  entries.sort((a, b) => (a.tech.name || "").localeCompare(b.tech.name || ""));

  const list = document.createElement("div");
  list.className = "tv-flex-list";
  list.innerHTML = entries.map(renderFlexCard).join("");
  mainEl.innerHTML = "";
  mainEl.appendChild(list);
}

// Ranks every tech in the roster by revenue for the selected period —
// including $0 techs, ranked last, so the full roster is always visible
// rather than only whoever has activity.
function buildRanked(deptTechs, jobs) {
  const entries = deptTechs.map((tech) => {
    const techJobs = jobs.filter((j) => (j.assigned_employee_ids || []).includes(tech.id) && jobInPeriod(j, PERIOD));
    const stats = computeScorecardStats(techJobs, { splitRevenue: true });
    return { tech, stats };
  });
  entries.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

// Same idea as buildRanked, but each tech's jobs are additionally filtered
// to just the given business-unit code — so an HVAC Service tech's BU-30
// screen ranking and BU-40 screen ranking can (and often do) differ, since
// each is scoped to only that BU's jobs.
function buildBuRanked(deptTechs, jobs, code) {
  const entries = deptTechs.map((tech) => {
    const techJobs = jobs.filter(
      (j) =>
        (j.assigned_employee_ids || []).includes(tech.id) &&
        jobInPeriod(j, PERIOD) &&
        businessUnitCode(j.business_unit) === code
    );
    const stats = computeScorecardStats(techJobs, { splitRevenue: true });
    return { tech, stats };
  });
  entries.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

// A BU screen's header/rank-subtitle text: the business unit's actual name
// as synced from Housecall Pro (e.g. "30 HVAC SERVICE"), read live off any
// matching job in view rather than hardcoded, so it always matches what
// admin.html shows for the same BU. Falls back to the config's
// fallbackLabel only if no job in the current period happens to carry that
// BU (e.g. an unusually quiet period) — rare, but avoids an empty header.
function businessUnitLabelForCode(jobs, code, fallbackLabel) {
  const job = jobs.find((j) => businessUnitCode(j.business_unit) === code);
  return job ? job.business_unit : fallbackLabel;
}

let latestData = null;

function renderRoster(entries, screenLabel) {
  const featured = entries[0];
  const rest = entries.slice(1);

  mainEl.innerHTML = renderFeatured(featured, screenLabel);
  const list = document.createElement("div");
  list.className = "tv-list";
  // Row/tile sizing in tv.css reads this to scale down as more people need
  // to fit — see the comment on .tv-row there for why that's necessary.
  list.style.setProperty("--row-count", Math.max(rest.length, 1));
  list.innerHTML = rest.map((entry) => renderRow(entry)).join("");
  mainEl.appendChild(list);
}

function render() {
  mainEl.className = "tv-main";

  if (!VALID_DEPTS.includes(DEPT)) {
    deptNameEl.textContent = "Unknown department";
    mainEl.innerHTML = `<p class="tv-empty">No such department. Use ?dept= with one of: ${VALID_DEPTS.map(escapeHtml).join(
      ", "
    )}<br>(spaces, hyphens, underscores, and capitalization are all fine — e.g. hvac-installation works too)</p>`;
    return;
  }

  if (!latestData) return;

  // HVAC Installation doesn't rank individual techs — see
  // renderInstallationTeamScreen for why — so it skips the standard
  // roster/ranking path entirely and renders its own single team card.
  if (DEPT === "HVAC Installation") {
    // "10" prefixed to match how every other screen's header reads (e.g.
    // "30 HVAC SERVICE", read live off a job's business_unit) — this screen
    // has no such job to read it off of (it's the one tag-only screen with a
    // single-BU identity), so it's spelled out by hand instead. Display text
    // only; DEPT itself (matched against SINGLE_DEPTS above) is unchanged.
    deptNameEl.textContent = "10 HVAC Installation";
    mainEl.className = "tv-main";
    renderInstallationTeamScreen();
    return;
  }

  if (DEPT === FLEX_DEPT) {
    deptNameEl.textContent = "Plumbing Flex · BU 50 + 70";
    mainEl.className = "tv-main";
    renderPlumbingFlexScreen();
    return;
  }

  const jobs = latestData.jobs || [];
  const buConfig = BU_DEPTS[DEPT];
  const rosterTag = buConfig ? buConfig.rosterTag : DEPT;
  const deptTechs = latestData.technicians.filter((t) => departmentOf(t) === rosterTag);

  const screenLabel = buConfig ? businessUnitLabelForCode(jobs, DEPT, buConfig.fallbackLabel) : DEPT;
  deptNameEl.textContent = screenLabel;

  if (deptTechs.length === 0) {
    mainEl.innerHTML = `<p class="tv-empty">No technicians found for ${escapeHtml(screenLabel)}.</p>`;
    return;
  }

  // #1 by revenue always holds the featured spot — no timer, no forced
  // cycling. The only way someone else gets featured is by actually
  // overtaking #1 in revenue, which the ranking's sort already handles on
  // every data refresh; render() just always reads the current #1.
  if (buConfig) {
    const entries = buildBuRanked(deptTechs, jobs, DEPT);
    renderRoster(entries, screenLabel);
    return;
  }

  const entries = buildRanked(deptTechs, jobs);
  renderRoster(entries, screenLabel);
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    latestData = data;
    render();
    updateSyncStatus(data.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestData) {
      mainEl.innerHTML = `<p class="tv-empty">Could not load dashboard data yet.</p>`;
    }
    console.error(err);
  }
}

loadData();
setInterval(loadData, POLL_INTERVAL_MS);

// loadData's 60s poll only ever re-fetches data/dashboard.json (already
// cache-busted with a timestamp above) — it never re-requests tv.html,
// tv.css, shared.js, or tv.js themselves, so a code change (like this
// comment) never reaches a TV that's simply been left running since before
// the change shipped. GitHub Pages caches those four files for 10 minutes
// (Cache-Control: max-age=600) each, so even someone physically pressing
// refresh on the TV isn't guaranteed to see a change — the browser can
// still be within that window and serve the old cached copies with no
// network request at all. A real page reload is the only thing that
// re-requests tv.html and therefore re-reads its (versioned, see
// ASSET_VERSION in tv.html) <script>/<link> tags — so this does one
// automatically, on a schedule, without needing anyone to visit the
// physical TV in person. Six hours balances "picks up a change same-day"
// against "don't reload a shop-floor screen so often the brief loading
// flash becomes annoying" — there's no user input state on this page to
// lose, so a reload is always safe here.
const RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => location.reload(), RELOAD_INTERVAL_MS);
