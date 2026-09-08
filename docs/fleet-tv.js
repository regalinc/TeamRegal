// Fleet Safety TV kiosk — a "best driver / worst driver" leaderboard built
// from Bouncie driving-behavior data (docs/data/bouncie.json), same overall
// shape as tv.js's technician screens (featured #1 card + ranked list,
// reusing renderAvatarBlock/tvTile from shared.js and tv.css's classes
// wholesale) but scoped to drivers across every department rather than one
// business unit, since a fleet doesn't map onto tv.js's per-BU screens.
//
// Every metric here is graded RELATIVE TO THE REST OF THE ROSTER this
// period (top third = green, middle = amber, bottom third = red), not
// against a company-confirmed absolute target the way every other KPI tile
// on this site is — there's no externally-validated "good" idle % or
// hard-braking rate for this fleet yet, unlike, say, avgTicket's $450
// floor. The one genuinely absolute rule is the 75 mph speeding threshold
// itself (a trip counts as "speeding" if its max speed hits that), but how
// MUCH speeding is acceptable wasn't given either, so that rate is also
// graded relatively. Revisit this if/when real fleet-safety targets exist.

const SPEEDING_THRESHOLD_MPH = 75;

// The 4 components of the Safety Score, all "lower is better." Equal-
// weighted for this first pass — no weighting was specified, and there's
// no basis yet to prefer one over another.
const SAFETY_METRIC_KEYS = ["idlePct", "brakingRate", "accelRate", "speedingRate"];

const PERIOD_LABELS = { today: "Today", week: "This week", lastweek: "Last week", month: "This month", lastmonth: "Last month", ytd: "Year to date" };

const urlParams = new URLSearchParams(location.search);
const PERIOD = urlParams.get("period") || "week";

const mainEl = document.getElementById("tv-main");
let latestBouncie = null;
let latestTechs = null;

// Per-driver raw + derived stats for one period's worth of trips. Rates are
// normalized (per-100-miles for discrete events, % of drive+idle time for
// idling, % of trips for speeding) so a driver logging more miles this
// period isn't automatically ranked worse just for driving more — same
// "ratio, not raw count" principle every other scorecard on this site uses.
function computeSafetyStats(trips) {
  const miles = trips.reduce((s, t) => s + (t.distance || 0), 0);
  const driveMinutes = trips.reduce((s, t) => {
    const start = new Date(t.startTime).getTime();
    const end = new Date(t.endTime).getTime();
    return s + (Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 60000 : 0);
  }, 0);
  const idleMinutes = trips.reduce((s, t) => s + (t.totalIdleDuration || 0), 0) / 60;
  const hardBraking = trips.reduce((s, t) => s + (t.hardBrakingCount || 0), 0);
  const hardAccel = trips.reduce((s, t) => s + (t.hardAccelerationCount || 0), 0);
  const speedingTrips = trips.filter((t) => (t.maxSpeed || 0) >= SPEEDING_THRESHOLD_MPH).length;
  const maxSpeed = trips.length ? Math.max(...trips.map((t) => t.maxSpeed || 0)) : 0;

  const activeMinutes = driveMinutes + idleMinutes;
  return {
    tripCount: trips.length,
    miles,
    hardBraking,
    hardAccel,
    speedingTrips,
    maxSpeed,
    // null (not 0) when there's no basis to compute a rate — a quiet driver
    // reads as "no data" (neutral), not as a suspiciously perfect 0%.
    idlePct: activeMinutes > 0 ? (idleMinutes / activeMinutes) * 100 : null,
    brakingRate: miles > 0 ? (hardBraking / miles) * 100 : null,
    accelRate: miles > 0 ? (hardAccel / miles) * 100 : null,
    speedingRate: trips.length > 0 ? (speedingTrips / trips.length) * 100 : null,
  };
}

// This period's roster position (0 = best) for one metric across drivers
// who have data for it — ties keep their stable-sort order, which can split
// two identical values across a tier boundary; acceptable for a first pass,
// not pretending to be more precise than the data supports.
function rankPositions(entries, metricKey) {
  const withData = entries.filter((e) => e.stats[metricKey] !== null).sort((a, b) => a.stats[metricKey] - b.stats[metricKey]);
  const positions = new Map();
  withData.forEach((e, i) => positions.set(e.tech.id, { rank: i, total: withData.length }));
  return positions;
}

function relativeTier(rank, total) {
  if (total < 2) return null; // nothing to compare against
  const pct = rank / (total - 1);
  if (pct <= 1 / 3) return "good";
  if (pct <= 2 / 3) return "warn";
  return "bad";
}

// 100 for the best-positioned driver on this metric, 0 for the worst,
// linear in between — feeds the averaged Safety Score below.
function goodnessScore(rank, total) {
  if (total < 2) return null;
  return ((total - 1 - rank) / (total - 1)) * 100;
}

// Ranks the full roster by an averaged Safety Score (mean of each of the 4
// metrics' goodnessScore) — mirrors tv.js's buildRanked(), just scored off
// a composite instead of raw Revenue. Requires data on ALL 4 metrics before
// assigning a real score, not just "at least one" — a driver with, say,
// only a single zero-distance trip recorded (real edge case hit while
// testing: 0 miles but 1 trip logged) would otherwise get a lucky perfect
// 100 from the one metric that happened to have data, floating to #1 ahead
// of drivers with complete, genuinely good numbers across all 4. A driver
// missing any metric (including a fully quiet one) sorts last instead, same
// "still shows, just at the bottom" convention as $0 techs on the revenue
// TVs, with neutral (not colored) tiles for whatever's missing.
function rankRoster(entries) {
  const positionsByMetric = Object.fromEntries(SAFETY_METRIC_KEYS.map((k) => [k, rankPositions(entries, k)]));

  for (const e of entries) {
    e.tierByMetric = {};
    let sum = 0;
    let count = 0;
    for (const key of SAFETY_METRIC_KEYS) {
      const pos = positionsByMetric[key].get(e.tech.id);
      if (!pos) {
        e.tierByMetric[key] = null;
        continue;
      }
      e.tierByMetric[key] = relativeTier(pos.rank, pos.total);
      sum += goodnessScore(pos.rank, pos.total);
      count++;
    }
    e.safetyScore = count === SAFETY_METRIC_KEYS.length ? Math.round(sum / count) : null;
  }

  entries.sort((a, b) => {
    if (a.safetyScore === null && b.safetyScore === null) return 0;
    if (a.safetyScore === null) return 1;
    if (b.safetyScore === null) return -1;
    return b.safetyScore - a.safetyScore;
  });
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

function scoreClass(score) {
  if (score === null) return null;
  if (score >= 67) return "tv-good";
  if (score >= 34) return "tv-warn";
  return "tv-bad";
}

function fmtPct(v) {
  return v === null ? "—" : `${v.toFixed(0)}%`;
}
function fmtRate(v) {
  return v === null ? "—" : v.toFixed(1);
}

function metricTiles(entry, sizeClass) {
  const { stats, tierByMetric, safetyScore } = entry;
  const cls = { good: "tv-good", warn: "tv-warn", bad: "tv-bad" };
  return [
    tvTile("Safety score", safetyScore === null ? "—" : String(safetyScore), scoreClass(safetyScore), sizeClass),
    tvTile("Idle time", fmtPct(stats.idlePct), tierByMetric.idlePct ? cls[tierByMetric.idlePct] : null, sizeClass),
    tvTile("Speeding (75+)", fmtPct(stats.speedingRate), tierByMetric.speedingRate ? cls[tierByMetric.speedingRate] : null, sizeClass),
    tvTile("Hard braking /100mi", fmtRate(stats.brakingRate), tierByMetric.brakingRate ? cls[tierByMetric.brakingRate] : null, sizeClass),
    tvTile("Hard accel. /100mi", fmtRate(stats.accelRate), tierByMetric.accelRate ? cls[tierByMetric.accelRate] : null, sizeClass),
    tvTile("Max speed", `${stats.maxSpeed.toFixed(0)} mph`, null, sizeClass),
    tvTile("Miles", stats.miles.toFixed(0), null, sizeClass),
    tvTile("Trips", stats.tripCount.toLocaleString(), null, sizeClass),
  ].join("");
}

function renderFeatured(entry, periodLabel) {
  const { tech, rank } = entry;
  return `
    <div class="tv-featured">
      <div class="tv-featured-photo-wrap">
        ${renderAvatarBlock(tech, "tv-featured-photo", "tv-featured-photo-fallback", { large: true })}
      </div>
      <div class="tv-featured-name">${escapeHtml(tech.name || "Unknown")}</div>
      <div class="tv-featured-rank">#${rank} · ${escapeHtml(periodLabel)}</div>
      <div class="tv-tile-grid">
        ${metricTiles(entry)}
      </div>
    </div>
  `;
}

function renderRow(entry) {
  const { tech, rank } = entry;
  return `
    <div class="tv-row">
      <div class="tv-row-rank">#${rank}</div>
      ${renderAvatarBlock(tech, "tv-row-photo", "tv-row-photo-fallback", { large: true })}
      <div class="tv-row-name-block">
        <div class="tv-row-name">${escapeHtml(tech.name || "Unknown")}</div>
        <div class="tv-row-meta">${escapeHtml(tech.role || "")}</div>
      </div>
      <div class="tv-row-metrics">
        ${metricTiles(entry, "tv-row-tile")}
      </div>
    </div>
  `;
}

function render() {
  if (!latestBouncie || !latestTechs) return;

  const techsById = {};
  for (const t of latestTechs) techsById[t.id] = t;

  const tripsByImei = {};
  for (const trip of latestBouncie.trips) {
    if (!dateInPeriod(trip.startTime, PERIOD)) continue;
    (tripsByImei[trip.imei] ||= []).push(trip);
  }

  // Every vehicle mapped to a real driver gets a roster spot, even with
  // zero trips this period — same "full roster always visible" convention
  // fleet.js and the rest of the site use. Shared/spare vehicles (mapped to
  // null) are deliberately excluded — there's no one person to rank.
  const entries = Object.entries(BOUNCIE_VEHICLE_TECH_IDS)
    .filter(([, techId]) => techId !== null)
    .map(([imei, techId]) => ({ tech: techsById[techId], stats: computeSafetyStats(tripsByImei[imei] || []) }))
    .filter((e) => e.tech);

  if (entries.length === 0) {
    mainEl.innerHTML = `<p class="tv-empty">No mapped drivers found.</p>`;
    return;
  }

  rankRoster(entries);

  const periodLabel = PERIOD_LABELS[PERIOD] || PERIOD;
  const featured = entries[0];
  const rest = entries.slice(1);

  mainEl.innerHTML = renderFeatured(featured, periodLabel);
  const list = document.createElement("div");
  list.className = "tv-list";
  list.style.setProperty("--row-count", Math.max(rest.length, 1));
  list.innerHTML = rest.map((entry) => renderRow(entry)).join("");
  mainEl.appendChild(list);
}

async function loadData() {
  try {
    const [bouncieRes, dashRes] = await Promise.all([
      fetch(`data/bouncie.json?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" }),
    ]);
    if (!bouncieRes.ok) throw new Error(`HTTP ${bouncieRes.status} loading bouncie.json`);
    if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status} loading dashboard.json`);

    latestBouncie = await bouncieRes.json();
    const dashData = await dashRes.json();
    latestTechs = dashData.technicians;

    render();
    updateSyncStatus(latestBouncie.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestBouncie) {
      mainEl.innerHTML = `<p class="tv-empty">Could not load fleet data yet.</p>`;
    }
    console.error(err);
  }
}

loadData();
setInterval(loadData, POLL_INTERVAL_MS);

// Same self-reload convention as tv.js — GitHub Pages' 10-min cache on
// tv.css/shared.js/fleet-tv.js means an unattended TV won't necessarily
// pick up a code change just from sitting there; a periodic full reload
// (which re-fetches this versioned HTML) does. No user input state on this
// page to lose, so a reload is always safe here.
const RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
setInterval(() => location.reload(), RELOAD_INTERVAL_MS);
