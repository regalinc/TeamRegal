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

const VALID_DEPTS = [...SINGLE_DEPTS, ...Object.keys(BU_DEPTS)];

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

// KPI targets (KPI_THRESHOLDS_BY_BU, tier(), kpiTier()) live in shared.js —
// admin.html's department cards and index.html's technician cards (when a
// single BU is selected) grade against the exact same numbers, so they're
// defined once rather than duplicated per page. For a BU screen (DEPT is
// "30"/"40"/"70"/"80"), kpiTier(DEPT, ...) finds that BU's targets directly;
// for a tag-only screen (Office, installation) it returns null for every
// metric since those aren't in KPI_THRESHOLDS_BY_BU, so the tile stays neutral.
const TIER_CLASS = { good: "tv-good", warn: "tv-warn", bad: "tv-bad" };

function kpiClass(metricKey, stats) {
  const result = kpiTier(DEPT, metricKey, stats);
  return result ? TIER_CLASS[result] : null;
}

// The HVAC Installation team's monthly revenue goal — given by the
// business, not derived from data. Needs manually adding to at the start of
// each month (ask for the new number rather than guessing or carrying last
// month's forward). Keyed by "YYYY-MM" so a month with no entry shows "no
// goal set" instead of silently reusing a stale number forever.
const INSTALLATION_MONTHLY_GOALS = {
  "2026-08": 475000,
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

function renderAvatarBlock(tech, sizeClass, fallbackClass, { large = false } = {}) {
  const initialsText = escapeHtml(initials(tech.name || "?"));
  const bg = tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : "";
  if (!hasRealAvatar(tech)) {
    return `<div class="${fallbackClass}" style="background:${bg}">${initialsText}</div>`;
  }
  const bigUrl = large ? largeAvatarUrl(tech) : null;
  if (bigUrl) {
    return `
      <img class="${sizeClass}" src="${escapeHtml(bigUrl)}" data-thumb-src="${escapeHtml(tech.avatar_url)}" alt="" onerror="handleLargeAvatarError(this)" />
      <div class="${fallbackClass}" style="background:${bg};display:none">${initialsText}</div>
    `;
  }
  return `
    <img class="${sizeClass}" src="${escapeHtml(tech.avatar_url)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'" />
    <div class="${fallbackClass}" style="background:${bg};display:none">${initialsText}</div>
  `;
}

function tvTile(label, value, cls, sizeClass) {
  return `<div class="${sizeClass || "tv-tile"} ${cls || ""}"><div class="tv-tile-label">${escapeHtml(label)}</div><div class="tv-tile-value">${escapeHtml(value)}</div></div>`;
}

// The full metric set shown per technician, in display order. sizeClass
// picks the tile styling ("tv-tile" for the big featured card, "tv-row-tile"
// for a compact list row).
function metricTiles(stats, sizeClass) {
  return [
    tvTile("Revenue", formatMoney(stats.totalRevenue), kpiClass("revenue", stats), sizeClass),
    tvTile("Avg ticket", formatMoney(stats.avgTicket), kpiClass("avgTicket", stats), sizeClass),
    tvTile("Completion", `${stats.completionRate.toFixed(0)}%`, kpiClass("completion", stats), sizeClass),
    tvTile("Jobs", stats.totalJobs.toLocaleString(), kpiClass("jobs", stats), sizeClass),
    tvTile("Leads", stats.leads.toLocaleString(), kpiClass("leads", stats), sizeClass),
    tvTile("Leads sold", stats.leadsSold.toLocaleString(), kpiClass("leadsSold", stats), sizeClass),
    tvTile("$0 Call", stats.ifo.toLocaleString(), kpiClass("ifo", stats), sizeClass),
    tvTile("Accessory sold", stats.accessorySold.toLocaleString(), kpiClass("accessorySold", stats), sizeClass),
  ].join("");
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
