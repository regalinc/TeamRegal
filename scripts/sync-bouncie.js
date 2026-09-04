// Syncs Bouncie fleet-tracking data (vehicle-mounted GPS/OBD devices) into
// a static JSON feed — same overall shape as scripts/sync.js for Housecall
// Pro, but Bouncie's auth is a meaningfully different animal: HCP uses one
// static API key forever, while Bouncie uses OAuth2 with an access token
// that expires hourly AND a refresh token that itself rotates (the old one
// is fully invalidated) on every single use. That means this script's own
// run produces a brand new refresh token every time, which it has no way to
// persist itself — see REFRESH_TOKEN_OUT below, and sync-bouncie.yml, which
// picks that file up and writes it back to this repo's
// BOUNCIE_REFRESH_TOKEN secret via `gh secret set` immediately after this
// script exits successfully.
//
// Vehicle -> technician mapping is NOT done here — it lives in
// BOUNCIE_VEHICLE_TECH_IDS in shared.js, same as every other manual
// ID-mapping list in this repo (MANUAL_AVATAR_OVERRIDES,
// INSTALLATION_TEAM_TECH_IDS, ...). This script only writes what Bouncie
// actually reports (vehicles by IMEI, trips by IMEI) — keeping the synced
// data a plain factual record and letting the frontend own the
// business-logic mapping, so a reassigned truck is a one-line frontend edit
// rather than a re-sync.

const fs = require("fs");
const os = require("os");
const path = require("path");

const CLIENT_ID = process.env.BOUNCIE_CLIENT_ID;
const CLIENT_SECRET = process.env.BOUNCIE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.BOUNCIE_REFRESH_TOKEN;

// Bouncie validates this against the app's registered Redirect URI on a
// refresh_token grant too (even though, per Bouncie's own docs, no actual
// redirect happens for this grant type) — must exactly match what's set on
// the Bouncie Developer Portal for the "regal-vehicle-matrix" app.
const REDIRECT_URI = "www.regalofyork.com";

const OUT_DIR = path.join(__dirname, "..", "docs", "data");
const OUT_FILE = path.join(OUT_DIR, "bouncie.json");

// A location OUTSIDE the repo — this is a live, sensitive credential, and
// must never end up in a git-tracked file even transiently. RUNNER_TEMP is
// GitHub Actions' own scratch directory (wiped after the job); falls back
// to the OS temp dir for local runs.
const REFRESH_TOKEN_OUT = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "bouncie-refresh-token.txt");

// Bouncie's /v1/trips endpoint caps the starts-after..ends-before window at
// one week per its own docs, and there's no fleet-wide trips endpoint —
// one request per vehicle. Re-fetching a wide window every run (the way
// scripts/sync.js re-fetches ~all of HCP's year every hour) would multiply
// badly here: 37 vehicles x many weekly chunks is a lot of requests for an
// hourly job, just to re-derive data we already have. So this syncs
// incrementally instead: fetch a short recent window each run, merge it
// into whatever's already on disk (deduped by transactionId — Bouncie's own
// docs warn duplicate trip events are possible), and prune anything past
// RETENTION_DAYS. History builds up gradually over the following days/weeks
// after this first ships rather than being fully backfilled on day one.
const LOOKBACK_DAYS = 3;
const RETENTION_DAYS = 180;

async function refreshAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.error("Missing BOUNCIE_CLIENT_ID / BOUNCIE_CLIENT_SECRET / BOUNCIE_REFRESH_TOKEN environment variable.");
    process.exit(1);
  }

  const res = await fetch("https://auth.bouncie.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: REFRESH_TOKEN,
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) {
    throw new Error(`Bouncie token refresh failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = await res.json();

  // Written immediately, before anything below has a chance to throw — a
  // mid-sync failure should never strand the repo on a refresh token that
  // Bouncie has, by this point, already invalidated.
  fs.writeFileSync(REFRESH_TOKEN_OUT, data.refresh_token, "utf8");

  return data.access_token;
}

async function bouncieGet(accessToken, endpoint, params) {
  const url = new URL(`https://api.bouncie.dev/v1/${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);

  const res = await fetch(url, {
    headers: { Authorization: accessToken, "Content-Type": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${endpoint} failed: HTTP ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Drops the GPS path (a full polyline/geojson trace per trip) — a driving-
// behavior scorecard has no use for the exact route, and it'd bloat the
// synced file for no benefit. gps-format is still a required query param on
// the request itself even though its value is discarded here.
function toPublicTrip(trip) {
  return {
    transactionId: trip.transactionId,
    imei: trip.imei,
    startTime: trip.startTime,
    endTime: trip.endTime,
    distance: trip.distance,
    averageSpeed: trip.averageSpeed,
    maxSpeed: trip.maxSpeed,
    hardBrakingCount: trip.hardBrakingCount,
    hardAccelerationCount: trip.hardAccelerationCount,
    totalIdleDuration: trip.totalIdleDuration,
  };
}

function loadExistingTrips() {
  try {
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
    return Array.isArray(existing.trips) ? existing.trips : [];
  } catch {
    return [];
  }
}

async function main() {
  const accessToken = await refreshAccessToken();

  const rawVehicles = await bouncieGet(accessToken, "vehicles", {});
  const vehicles = rawVehicles.map((v) => ({
    imei: v.imei,
    vin: v.vin,
    nickName: v.nickName,
    model: v.model,
    odometer: v.stats?.odometer ?? null,
  }));

  const startsAfter = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const endsBefore = new Date().toISOString();

  const freshTrips = [];
  for (const vehicle of vehicles) {
    const rawTrips = await bouncieGet(accessToken, "trips", {
      imei: vehicle.imei,
      "gps-format": "geojson",
      "starts-after": startsAfter,
      "ends-before": endsBefore,
    });
    for (const trip of rawTrips) freshTrips.push(toPublicTrip(trip));
  }

  const byId = new Map();
  for (const trip of loadExistingTrips()) byId.set(trip.transactionId, trip);
  for (const trip of freshTrips) byId.set(trip.transactionId, trip);

  const retentionCutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const trips = [...byId.values()]
    .filter((t) => new Date(t.startTime).getTime() >= retentionCutoff)
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

  const meta = {
    last_synced_at: new Date().toISOString(),
    lookback_days: LOOKBACK_DAYS,
    retention_days: RETENTION_DAYS,
    vehicle_count: vehicles.length,
    trip_count: trips.length,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ meta, vehicles, trips }, null, 2));

  console.log(`Wrote ${trips.length} trips (${freshTrips.length} fetched this run) across ${vehicles.length} vehicles to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
