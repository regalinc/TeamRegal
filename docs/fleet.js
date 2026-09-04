// Fleet driving-behavior scorecard — pulls from Bouncie (docs/data/bouncie.json,
// synced by scripts/sync-bouncie.js), a wholly separate data source from
// Housecall Pro. Only fetches dashboard.json for technician identity/avatars
// (renderAvatar, escapeHtml, formatDate, periodRange/dateInPeriod, and the
// BOUNCIE_VEHICLE_TECH_IDS mapping all come from shared.js, already loaded).
//
// v1 metric set is exactly what Bouncie's API actually reports per trip —
// trips, miles, average/max speed, hard-braking count, hard-acceleration
// count, idle time. There's deliberately no "speeding" tile yet: Bouncie has
// no speed-limit-aware "speeding" concept at all (confirmed against its API
// spec), just a raw maxSpeed per trip — turning that into a meaningful
// "speeding" metric means picking a threshold (or per-road-type logic) that
// wasn't decided yet, so it's left for a follow-up once that's defined
// rather than guessing at one now.

const urlParams = new URLSearchParams(location.search);
const periodFilter = document.getElementById("period-filter");
const appEl = document.getElementById("app");

let latestBouncie = null;
let latestTechs = null;

// Bouncie reports distance in miles and duration implicitly via
// startTime/endTime — averageSpeed per trip is already Bouncie's own
// driving-time-based figure. Averaging that across several trips here is a
// simple per-trip mean, not distance- or duration-weighted — good enough
// for a glanceable scorecard, not represented as more precise than it is.
function aggregateTrips(trips) {
  if (trips.length === 0) {
    return { tripCount: 0, totalDistance: 0, avgSpeed: 0, maxSpeed: 0, hardBraking: 0, hardAccel: 0, idleMinutes: 0 };
  }
  const totalDistance = trips.reduce((sum, t) => sum + (t.distance || 0), 0);
  const avgSpeed = trips.reduce((sum, t) => sum + (t.averageSpeed || 0), 0) / trips.length;
  const maxSpeed = Math.max(...trips.map((t) => t.maxSpeed || 0));
  const hardBraking = trips.reduce((sum, t) => sum + (t.hardBrakingCount || 0), 0);
  const hardAccel = trips.reduce((sum, t) => sum + (t.hardAccelerationCount || 0), 0);
  const idleMinutes = trips.reduce((sum, t) => sum + (t.totalIdleDuration || 0), 0) / 60;
  return { tripCount: trips.length, totalDistance, avgSpeed, maxSpeed, hardBraking, hardAccel, idleMinutes };
}

function statTiles(stats) {
  return [
    renderMiniStat("Trips", stats.tripCount.toLocaleString()),
    renderMiniStat("Miles", stats.totalDistance.toFixed(0)),
    renderMiniStat("Avg speed", `${stats.avgSpeed.toFixed(0)} mph`),
    renderMiniStat("Max speed", `${stats.maxSpeed.toFixed(0)} mph`),
    renderMiniStat("Hard braking", stats.hardBraking.toLocaleString()),
    renderMiniStat("Hard accel.", stats.hardAccel.toLocaleString()),
    renderMiniStat("Idle time", stats.idleMinutes >= 60 ? `${(stats.idleMinutes / 60).toFixed(1)}h` : `${stats.idleMinutes.toFixed(0)}m`),
  ].join("");
}

function renderDriverCard(tech, stats) {
  const card = document.createElement("div");
  card.className = "tech-card";
  card.innerHTML = `
    <div class="tech-card-header">
      ${renderAvatar(tech)}
      <div>
        <div class="tech-name">${escapeHtml(tech.name || "Unknown")}</div>
        ${tech.role ? `<div class="tech-role">${escapeHtml(tech.role)}</div>` : ""}
      </div>
    </div>
    <div class="tech-mini-stats">${statTiles(stats)}</div>
  `;
  return card;
}

function renderSharedVehiclesCard(vehiclesById, tripsByImei) {
  const rows = Object.entries(tripsByImei)
    .filter(([imei]) => !(imei in BOUNCIE_VEHICLE_TECH_IDS) || BOUNCIE_VEHICLE_TECH_IDS[imei] === null)
    .map(([imei, trips]) => ({ imei, nickName: vehiclesById[imei]?.nickName || imei, stats: aggregateTrips(trips) }))
    .filter((v) => v.stats.tripCount > 0)
    .sort((a, b) => a.nickName.localeCompare(b.nickName));

  if (rows.length === 0) return null;

  const card = document.createElement("div");
  card.className = "tech-card fleet-shared-card";
  card.innerHTML = `
    <div class="tech-card-header">
      <div class="avatar" style="background:var(--text-muted)">FL</div>
      <div>
        <div class="tech-name">Shared &amp; spare vehicles</div>
        <div class="tech-role">Not assigned to one driver</div>
      </div>
    </div>
    <div class="fleet-shared-list">
      ${rows
        .map(
          (v) => `
            <div class="fleet-shared-row">
              <span class="fleet-shared-name">${escapeHtml(v.nickName)}</span>
              <div class="tech-mini-stats">${statTiles(v.stats)}</div>
            </div>
          `
        )
        .join("")}
    </div>
  `;
  return card;
}

function render() {
  if (!latestBouncie || !latestTechs) return;

  const period = periodFilter.value;
  const vehiclesById = {};
  for (const v of latestBouncie.vehicles) vehiclesById[v.imei] = v;

  const tripsByImei = {};
  for (const trip of latestBouncie.trips) {
    if (!dateInPeriod(trip.startTime, period)) continue;
    (tripsByImei[trip.imei] ||= []).push(trip);
  }

  const techsById = {};
  for (const t of latestTechs) techsById[t.id] = t;

  // Every mapped-to-a-real-driver vehicle gets a card, even with zero trips
  // in the selected period — same "full roster always visible" convention
  // the rest of the site uses (a quiet driver reads as 0 trips, not as
  // missing from the page).
  const driverEntries = Object.entries(BOUNCIE_VEHICLE_TECH_IDS)
    .filter(([, techId]) => techId !== null)
    .map(([imei, techId]) => ({ tech: techsById[techId], stats: aggregateTrips(tripsByImei[imei] || []) }))
    .filter((e) => e.tech);
  driverEntries.sort((a, b) => (a.tech.name || "").localeCompare(b.tech.name || ""));

  const totals = driverEntries.reduce(
    (acc, e) => {
      acc.tripCount += e.stats.tripCount;
      acc.totalDistance += e.stats.totalDistance;
      acc.hardBraking += e.stats.hardBraking;
      acc.hardAccel += e.stats.hardAccel;
      return acc;
    },
    { tripCount: 0, totalDistance: 0, hardBraking: 0, hardAccel: 0 }
  );

  appEl.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "stats-row";
  summary.appendChild(renderStatTile({ label: "Total trips", value: totals.tripCount.toLocaleString() }));
  summary.appendChild(renderStatTile({ label: "Total miles", value: totals.totalDistance.toFixed(0) }));
  summary.appendChild(renderStatTile({ label: "Hard braking events", value: totals.hardBraking.toLocaleString() }));
  summary.appendChild(renderStatTile({ label: "Hard acceleration events", value: totals.hardAccel.toLocaleString() }));
  appEl.appendChild(summary);

  const grid = document.createElement("div");
  grid.className = "tech-grid";
  for (const { tech, stats } of driverEntries) grid.appendChild(renderDriverCard(tech, stats));
  const sharedCard = renderSharedVehiclesCard(vehiclesById, tripsByImei);
  if (sharedCard) grid.appendChild(sharedCard);
  appEl.appendChild(grid);
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
      appEl.innerHTML = `<p class="loading">Could not load fleet data yet.</p>`;
    }
    console.error(err);
  }
}

periodFilter.addEventListener("change", () => {
  const params = new URLSearchParams(location.search);
  params.set("period", periodFilter.value);
  history.replaceState(null, "", `${location.pathname}?${params}`);
  render();
});

applyDefaultPeriod(urlParams, periodFilter, "week");
loadData();
setInterval(loadData, POLL_INTERVAL_MS);
