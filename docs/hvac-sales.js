// HVAC Sales scorecard — one consultant's personal page, selected via an
// opaque ?u=<token> (HVAC_SALES_TOKENS, shared.js) rather than a human
// name — see that map's own comment for why: a name-based ?ca=Josh /
// ?ca=Nick param used to work here, and either consultant could see the
// other's page just by swapping in a guessed name. One shared template
// rather than a hardcoded page per person (unlike andrew.js, which is
// the only one of its kind) — this is the same "one page, many instances
// via a URL param" pattern tv.html and company-scorecard.html already
// use for exactly this reason: two people today, and a new consultant
// added to HVAC_SALES_TOKENS just works here without a new page.
//
// Data comes from docs/data/hvac-sales.json (scripts/parse-hvac-sales.ps1,
// hand-run against the "HVAC Sales" workbook — not part of the automated
// hourly sync, see that script's header comment) for the opportunity/close
// records, and dashboard.json for the consultant's real name/avatar via
// HVAC_SALES_TOKENS (shared.js).
//
// greetingPrefix/firstName/monthLabel intentionally mirror andrew.js's
// versions of the same tiny helpers rather than importing them — small
// enough that centralizing three one-liners into shared.js for two pages
// wasn't worth touching andrew.js's already-shipped, daily-used code for.

const urlParams = new URLSearchParams(location.search);

// Case-forgiving the same way the old ?ca= lookup was — a bookmarked or
// hand-typed token shouldn't 404-style fail over case alone. Unlike the
// old name-based version, no partial/fuzzy match of any kind: a token
// either matches one of HVAC_SALES_TOKENS's keys exactly (case aside) or
// it doesn't, and the empty state below deliberately doesn't enumerate
// the valid ones — doing that would just recreate the guessing problem
// this token scheme exists to close.
function resolveToken(raw) {
  const key = String(raw || "").trim().toLowerCase();
  const match = Object.keys(HVAC_SALES_TOKENS).find((token) => token.toLowerCase() === key);
  return match ? HVAC_SALES_TOKENS[match] : null;
}

const TOKEN_ENTRY = resolveToken(urlParams.get("u"));

const greetingEl = document.getElementById("greeting");
const identityName = document.getElementById("identity-name");
const avatarSlot = document.getElementById("avatar-slot");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroLine = document.getElementById("hero-line");
const ringNumber = document.getElementById("ring-number");
const ringFill = document.getElementById("ring-fill");
const tileRan = document.getElementById("tile-ran");
const tileSold = document.getElementById("tile-sold");
const tileSoldNote = document.getElementById("tile-sold-note");
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

// Housecall Pro's "Job #" (invoice_number, synced by scripts/sync.js) is
// the same number staff already type into the spreadsheet's "Job" column
// once something sells — an exact join key, unlike matching by customer
// name (privacy-masked in synced data, see the README's "HVAC Sales
// scorecard" section for the fuller story on why that path was rejected).
function buildJobsByInvoiceNumber(jobs) {
  const map = new Map();
  for (const j of jobs) {
    if (j.invoice_number) map.set(String(j.invoice_number).trim(), j);
  }
  return map;
}

// A job created via the OnCall Air integration is created the moment the
// proposal is accepted — so a matched job's created_at is effectively "the
// day it actually sold," which can land in a different month than the
// original consultation (schedule.scheduled_start on that job is the
// *install* date, not the sale date, and isn't used here). Falls back to
// the row's own consultation date when there's no Job number yet to join
// on (not sold, or sold but not typed in yet) — same period for both ran
// and sold in that case, matching this page's original behavior exactly
// rather than silently losing the record from either count.
function resolveSoldDate(record, jobsByInvoiceNumber) {
  if (!record.sold) return null;
  const job = record.job ? jobsByInvoiceNumber.get(String(record.job).trim()) : null;
  return (job && job.created_at) || record.date;
}

// {ran, sold, rate} per distinct value of `field` — ran and sold are two
// independently-dated sets now (see resolveSoldDate above), not one set
// counted two ways, so a sold job that ran in an earlier period still
// counts toward this period's "sold" even though it's absent from this
// period's "ran". Same convention as Andrew Rouscher's page: rate is a
// simple sold-count ÷ ran-count ratio of two independent counts, not a
// strict per-record cohort conversion rate. A record with no value for
// `field` (the "not sold" rows that never got a System Type/lead filled
// in) is grouped under "Unknown" rather than dropped, same "never silently
// drop data" convention the rest of this app uses.
function closingRateBreakdown(ranRecords, soldRecords, field) {
  const groups = new Map();
  const bump = (key, which) => {
    if (!groups.has(key)) groups.set(key, { ran: 0, sold: 0 });
    groups.get(key)[which]++;
  };
  for (const r of ranRecords) bump(r[field] || "Unknown", "ran");
  for (const r of soldRecords) bump(r[field] || "Unknown", "sold");
  return [...groups.entries()]
    .map(([label, g]) => ({ label, ran: g.ran, sold: g.sold, rate: g.ran ? (g.sold / g.ran) * 100 : 0 }))
    .sort((a, b) => b.ran - a.ran);
}

// Sold-job counts per System Type, from the sold-this-period set (see
// resolveSoldDate above) — a count, not a rate (System Type is only
// meaningfully known once a job sells, so a "ran" denominator wouldn't
// mean the same thing it does for the other three breakdowns).
function systemTypeBreakdown(soldRecords) {
  const counts = new Map();
  for (const r of soldRecords) {
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
  // Both dates explicitly labeled once they can actually differ (a sold
  // job whose Job # matched a Housecall Pro job created on a later date
  // than the consultation) — a bare date would be ambiguous about which
  // one it is, same reasoning as andrew.js's estimate rows.
  const dateParts = [`Ran ${formatDate(r.date)}`];
  if (r.sold && r.soldDateResolved && r.soldDateResolved !== r.date) {
    dateParts.push(`Sold ${formatDate(r.soldDateResolved)}`);
  }
  const meta = [dateParts.join(" · "), r.lead, r.systemType].filter(Boolean).join(" · ");
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

  if (!TOKEN_ENTRY) {
    // Deliberately generic — no "here are the valid options" list. That
    // would hand back exactly the kind of guessable enumeration this
    // token scheme replaced ?ca=Josh/?ca=Nick to get away from.
    document.querySelector(".page").innerHTML = "<p class=\"empty-state\">This link isn't valid. Check the URL you were given.</p>";
    return;
  }

  const { ca: CA, techId } = TOKEN_ENTRY;
  const tech = (latestDashboard.technicians || []).find((t) => t.id === techId);
  if (!tech) {
    document.querySelector(".page").innerHTML = '<p class="empty-state">Consultant not found in the synced roster.</p>';
    return;
  }

  greetingEl.textContent = `${greetingPrefix()}, ${firstName(tech.name)} 👋`;
  identityName.textContent = tech.name || CA;
  avatarSlot.innerHTML = renderLargeAvatar(tech);

  const jobsByInvoiceNumber = buildJobsByInvoiceNumber(latestDashboard.jobs || []);
  const mine = (latestSales.records || []).map((r) => ({ ...r, soldDateResolved: resolveSoldDate(r, jobsByInvoiceNumber) })).filter((r) => r.ca === CA);

  // Two independently-dated views of the same roster (see resolveSoldDate):
  // "ran" by the consultation date, "sold" by the resolved sold date — a
  // job sold this period can be present in one set and absent from the
  // other, same as Andrew Rouscher's given/approved split.
  const ranInPeriod = mine.filter((r) => dateInPeriod(r.date, currentPeriod));
  const soldInPeriod = mine.filter((r) => r.sold && dateInPeriod(r.soldDateResolved, currentPeriod));

  const ran = ranInPeriod.length;
  const sold = soldInPeriod.length;
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
  // Of this period's sold count, however many actually ran in some other
  // period — the same "given earlier" transparency Andrew Rouscher's page
  // surfaces for the identical situation, so the number never looks like
  // it disagrees with the record list below it.
  const soldFromEarlierCount = soldInPeriod.filter((r) => !dateInPeriod(r.date, currentPeriod)).length;
  tileSoldNote.textContent = soldFromEarlierCount > 0 ? `incl. ${soldFromEarlierCount} from an earlier period` : "";

  renderRateBreakdown("breakdown-club-member", closingRateBreakdown(ranInPeriod, soldInPeriod, "clubMember"));
  renderRateBreakdown("breakdown-lead", closingRateBreakdown(ranInPeriod, soldInPeriod, "lead"));
  renderRateBreakdown("breakdown-customer-type", closingRateBreakdown(ranInPeriod, soldInPeriod, "customerType"));
  renderSystemTypeBreakdown(systemTypeBreakdown(soldInPeriod));

  // Union, not just "ran this period" — a job sold this period but run
  // earlier belongs in the list too, or the record list would silently
  // disagree with the Sold tile/note above it. Records are unique object
  // references (one per source row, freshly mapped above), so a plain Set
  // dedupes a row present in both sets without needing a synthetic id.
  const listRecords = [...new Set([...ranInPeriod, ...soldInPeriod])];
  const sorted = listRecords.sort((a, b) => (b.soldDateResolved || b.date || "").localeCompare(a.soldDateResolved || a.date || ""));
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
