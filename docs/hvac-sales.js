// HVAC Sales scorecard — one consultant's personal page, selected via
// ?ca=Josh / ?ca=Nick (the exact "CA" value used in the source workbook).
// One shared template rather than a hardcoded page per person (unlike
// andrew.js, which is the only one of its kind) — this is the same
// "one page, many instances via a URL param" pattern tv.html and
// company-scorecard.html already use for exactly this reason: two people
// today, and a new consultant added to HVAC_SALES_CA_TECH_IDS (shared.js)
// just works here without a new page.
//
// Data comes from docs/data/hvac-sales.json (scripts/parse-hvac-sales.ps1,
// hand-run against the "HVAC Sales" workbook — not part of the automated
// hourly sync, see that script's header comment) for the opportunity/close
// records, and dashboard.json for the consultant's real name/avatar via
// HVAC_SALES_CA_TECH_IDS (shared.js).
//
// greetingPrefix/firstName/monthLabel intentionally mirror andrew.js's
// versions of the same tiny helpers rather than importing them — small
// enough that centralizing three one-liners into shared.js for two pages
// wasn't worth touching andrew.js's already-shipped, daily-used code for.

const urlParams = new URLSearchParams(location.search);
const CA = urlParams.get("ca");

const greetingEl = document.getElementById("greeting");
const identityName = document.getElementById("identity-name");
const avatarSlot = document.getElementById("avatar-slot");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroLine = document.getElementById("hero-line");
const ringNumber = document.getElementById("ring-number");
const ringFill = document.getElementById("ring-fill");
const tileRan = document.getElementById("tile-ran");
const tileSold = document.getElementById("tile-sold");
const recordListCard = document.getElementById("record-list-card");
const recordListSummary = document.getElementById("record-list-summary");
const recordListBody = document.getElementById("record-list-body");

const CIRCUMFERENCE = 2 * Math.PI * 60;

function greetingPrefix() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(fullName) {
  return (fullName || "").trim().split(/\s+/)[0] || "there";
}

function monthLabel(monthsAgo) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toLocaleDateString([], { month: "long" });
}

function periodMeta(period) {
  if (period === "lastmonth") {
    return { eyebrow: `${monthLabel(1)} · full month`, ranPhrase: `in ${monthLabel(1)}` };
  }
  if (period === "ytd") {
    const [start] = periodRange("ytd");
    const today = new Date();
    return {
      eyebrow: `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${today.toLocaleDateString([], { month: "short", day: "numeric" })}`,
      ranPhrase: "this year",
    };
  }
  const [start, end] = periodRange("month");
  const daysInMonth = Math.round((end - start) / 86_400_000);
  const dayOfMonth = Math.min(daysInMonth, new Date().getDate());
  return { eyebrow: `${monthLabel(0)} · day ${dayOfMonth} of ${daysInMonth}`, ranPhrase: "this month" };
}

function renderLargeAvatar(tech) {
  if (!hasRealAvatar(tech)) return renderAvatar(tech);
  const bigUrl = largeAvatarUrl(tech);
  if (!bigUrl) return renderAvatar(tech);

  const bg = tech.color_hex ? "#" + tech.color_hex.replace(/^#/, "") : "";
  const initialsText = escapeHtml(initials(tech.name || "?"));
  return `
    <img class="avatar" src="${escapeHtml(bigUrl)}" data-thumb-src="${escapeHtml(tech.avatar_url)}" alt="" onerror="handleLargeAvatarError(this)" />
    <div class="avatar" style="background:${bg};display:none">${initialsText}</div>
  `;
}

// {ran, sold, rate} per distinct value of `field` among the given records —
// used for the Club Member / Lead / Customer Type breakdowns. A record with
// no value for that field (the two "not sold" rows in the source data that
// never got a System Type/lead filled in) is grouped under "Unknown" rather
// than dropped, same "never silently drop data" convention the rest of this
// app uses (e.g. "Unknown source"/"No business unit set").
function closingRateBreakdown(records, field) {
  const groups = new Map();
  for (const r of records) {
    const key = r[field] || "Unknown";
    if (!groups.has(key)) groups.set(key, { ran: 0, sold: 0 });
    const g = groups.get(key);
    g.ran++;
    if (r.sold) g.sold++;
  }
  return [...groups.entries()]
    .map(([label, g]) => ({ label, ran: g.ran, sold: g.sold, rate: g.ran ? (g.sold / g.ran) * 100 : 0 }))
    .sort((a, b) => b.ran - a.ran);
}

// Sold-job counts per System Type — a count, not a rate (System Type is
// only meaningfully known once a job is sold; most "not sold" rows never
// got one filled in at all, so a "ran" denominator here wouldn't mean the
// same thing it does for the other three breakdowns).
function systemTypeBreakdown(records) {
  const counts = new Map();
  for (const r of records) {
    if (!r.sold) continue;
    const key = r.systemType || "Unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

function renderRateBreakdown(containerId, rows) {
  const el = document.getElementById(containerId);
  if (rows.length === 0) {
    el.innerHTML = '<div class="breakdown-empty">No opportunities match this period.</div>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r) => `
        <div class="breakdown-row">
          <span class="breakdown-label">${escapeHtml(r.label)}</span>
          <div class="breakdown-bar-track"><div class="breakdown-bar-fill" style="width:${r.rate}%"></div></div>
          <span class="breakdown-figures"><b>${r.rate.toFixed(0)}%</b> (${r.sold}/${r.ran})</span>
        </div>
      `
    )
    .join("");
}

function renderSystemTypeBreakdown(rows) {
  const el = document.getElementById("breakdown-system-type");
  if (rows.length === 0) {
    el.innerHTML = '<div class="breakdown-empty">No sold jobs match this period.</div>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.count));
  el.innerHTML = rows
    .map(
      (r) => `
        <div class="breakdown-row">
          <span class="breakdown-label">${escapeHtml(r.label)}</span>
          <div class="breakdown-bar-track"><div class="breakdown-bar-fill" style="width:${(r.count / max) * 100}%"></div></div>
          <span class="breakdown-figures"><b>${r.count}</b></span>
        </div>
      `
    )
    .join("");
}

function renderRecordRow(r) {
  const meta = [formatDate(r.date), r.lead, r.systemType].filter(Boolean).join(" · ");
  return `
    <div class="record-row">
      <div class="record-left">
        <span class="record-customer">${escapeHtml(r.customerName || "Unknown")}</span>
        <span class="record-meta">${escapeHtml(meta)}</span>
      </div>
      <span class="record-status ${r.sold ? "won" : "open"}">${r.sold ? "Sold" : "Not sold"}</span>
    </div>
  `;
}

let latestDashboard = null;
let latestSales = null;
let currentPeriod = "month";

function render() {
  if (!latestDashboard || !latestSales) return;

  if (!CA || !HVAC_SALES_CA_TECH_IDS[CA]) {
    document.querySelector(".page").innerHTML = `<p class="empty-state">Use ?ca= with one of: ${Object.keys(HVAC_SALES_CA_TECH_IDS)
      .map(escapeHtml)
      .join(", ")}</p>`;
    return;
  }

  const techId = HVAC_SALES_CA_TECH_IDS[CA];
  const tech = (latestDashboard.technicians || []).find((t) => t.id === techId);
  if (!tech) {
    document.querySelector(".page").innerHTML = `<p class="empty-state">${escapeHtml(CA)} was not found in the synced roster.</p>`;
    return;
  }

  greetingEl.textContent = `${greetingPrefix()}, ${firstName(tech.name)} 👋`;
  identityName.textContent = tech.name || CA;
  avatarSlot.innerHTML = renderLargeAvatar(tech);

  const mine = (latestSales.records || []).filter((r) => r.ca === CA);
  const inPeriod = mine.filter((r) => dateInPeriod(r.date, currentPeriod));

  const ran = inPeriod.length;
  const sold = inPeriod.filter((r) => r.sold).length;
  const closingRate = ran ? (sold / ran) * 100 : 0;

  const meta = periodMeta(currentPeriod);
  heroEyebrow.textContent = meta.eyebrow;
  ringNumber.textContent = `${closingRate.toFixed(0)}%`;
  ringFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - Math.min(100, closingRate) / 100));

  heroLine.innerHTML = `
    <b>${ran.toLocaleString()} opportunities</b> ran ${meta.ranPhrase}, <span class="accent-num">${sold.toLocaleString()} sold</span>
    — a ${closingRate.toFixed(0)}% closing rate.
  `;

  tileRan.textContent = ran.toLocaleString();
  tileSold.textContent = sold.toLocaleString();

  renderRateBreakdown("breakdown-club-member", closingRateBreakdown(inPeriod, "clubMember"));
  renderRateBreakdown("breakdown-lead", closingRateBreakdown(inPeriod, "lead"));
  renderRateBreakdown("breakdown-customer-type", closingRateBreakdown(inPeriod, "customerType"));
  renderSystemTypeBreakdown(systemTypeBreakdown(inPeriod));

  const sorted = [...inPeriod].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  recordListSummary.textContent = `${sorted.length} opportunit${sorted.length === 1 ? "y" : "ies"} in view`;
  recordListBody.innerHTML = sorted.length ? sorted.map(renderRecordRow).join("") : '<div class="no-records">No opportunities match this period.</div>';
}

async function loadData() {
  try {
    const [dashRes, salesRes] = await Promise.all([
      fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" }),
      fetch(`data/hvac-sales.json?_=${Date.now()}`, { cache: "no-store" }),
    ]);
    if (!dashRes.ok) throw new Error(`HTTP ${dashRes.status} loading dashboard.json`);
    if (!salesRes.ok) throw new Error(`HTTP ${salesRes.status} loading hvac-sales.json`);

    latestDashboard = await dashRes.json();
    latestSales = await salesRes.json();

    render();
    // The dashboard.json meta, not hvac-sales.json's — that file has no
    // ongoing sync cadence to flag as stale (it's hand-run whenever the
    // workbook has new rows, same as pnl-monthly.json/manual-metrics.json
    // on company-scorecard.html, which follows this identical convention).
    updateSyncStatus(latestDashboard.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestSales) {
      document.querySelector(".page").innerHTML = '<p class="empty-state">Could not load sales data yet.</p>';
    }
    console.error(err);
  }
}

document.querySelector(".period-controls").addEventListener("click", (e) => {
  const btn = e.target.closest(".period-btn");
  if (!btn || btn.dataset.period === currentPeriod) return;
  currentPeriod = btn.dataset.period;
  for (const b of document.querySelectorAll(".period-btn")) {
    const active = b === btn;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
  render();
});

loadData();
setInterval(loadData, POLL_INTERVAL_MS);
