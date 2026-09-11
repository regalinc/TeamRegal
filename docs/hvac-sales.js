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

// Revenue goals, per CA — same two-tier shape as Andrew Rouscher's page
// (ANDREW_MONTHLY_GOAL/ANDREW_YTD_GOAL in andrew.js): a monthly dict keyed
// "YYYY-MM" (like the HVAC Installation TV screen's INSTALLATION_MONTHLY_GOALS
// in tv.js — needs a new entry added by hand each month) covers the
// lastmonth/MTD period tabs, and a separate flat annual figure covers YTD —
// not the sum of the monthly entries, a real distinct target the business
// sets, not derived from the months (Andrew's YTD goal works the same way).
// Tracked against real revenue — the reconstructed true subtotal per sold
// proposal (docs/data/commission-report.json's "revenue" section, written
// by scripts/update-commission-scorecard.ps1 from the same OnCall Air
// webhook data commission is computed from), not commission dollars, which
// are a small percentage of this and would never reach these targets.
const HVAC_SALES_MONTHLY_GOALS = {
  Josh: {
    "2026-08": 300000,
    "2026-09": 300000,
    "2026-10": 275000,
    "2026-11": 275000,
    "2026-12": 275000,
  },
  Nick: {},
};
const HVAC_SALES_YTD_GOALS = {
  Josh: 3600000,
  Nick: null,
};

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
const commissionMonthEl = document.getElementById("commission-month");
const commissionWeeksEl = document.getElementById("commission-weeks");
const commissionMtdValueEl = document.getElementById("commission-mtd-value");
const goalCard = document.getElementById("goal-card");
const goalTitle = document.getElementById("goal-title");
const goalFigures = document.getElementById("goal-figures");
const goalFill = document.getElementById("goal-fill");
const goalEmpty = document.getElementById("goal-empty");
const paceBadge = document.getElementById("pace-badge");

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

// Commission dollars need to read exactly right (this is pay, not a KPI
// tile) — shared.js's formatMoney rounds to whole dollars and abbreviates
// to K/M above $10k, which isn't what you want for an exact figure.
function formatDollarsPrecise(amount) {
  return `$${(amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function commissionMonthLabel(monthStr) {
  if (!monthStr) return "";
  const [y, m] = monthStr.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString([], { month: "long", year: "numeric" });
}

// weekStart/weekEnd come through as "yyyy-MM-dd" strings (from
// commission-report.json, written by update-commission-scorecard.ps1) —
// appending T00:00:00 avoids the UTC-midnight-parses-as-previous-local-day
// surprise plain "yyyy-MM-dd" parsing has in most timezones.
function commissionWeekRange(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  const fmt = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}

// A row scheduled for a future date hasn't actually happened yet — it
// shouldn't count as "ran" (or drag down a closing rate as an unsold
// opportunity) just because its Date falls within the selected period,
// the same way an HVAC Installation job that's scheduled but not yet
// started doesn't count toward that team's Jobs/Revenue elsewhere on this
// site (NOT_YET_STARTED_STATUSES, shared.js) — a full calendar month's
// worth of already-booked future appointments would otherwise inflate
// "opportunities ran" and tank the closing rate for a month that's still
// in progress. periodRange("today")'s own end boundary (start of
// tomorrow, in local time) is reused here rather than a fresh comparison,
// so "today" means exactly the same thing here as it does everywhere else
// period filtering happens on this site.
function hasHappened(dateStr) {
  if (!dateStr) return false;
  const [, todayEnd] = periodRange("today");
  const d = new Date(dateStr);
  return !Number.isNaN(d.getTime()) && d < todayEnd;
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

function monthKey(monthsAgo) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// How far ahead of (or behind) a flat, evenly-paced march toward the goal
// this period's revenue actually is right now — mirrors andrew.js's
// identical helper exactly (see its own comment for the full reasoning).
// Only meaningful for an open period with a real goal: "lastmonth" is
// already over, and a null/missing goal has nothing to pace against.
function paceInfo(period, revenue, goal) {
  if (period === "lastmonth" || !goal) return null;
  const now = new Date();
  const [start, end] =
    period === "ytd" ? [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)] : periodRange("month");
  const fracElapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return { diff: revenue - goal * fracElapsed };
}

function goalMeta(CA, period) {
  if (period === "lastmonth") {
    return { goal: (HVAC_SALES_MONTHLY_GOALS[CA] || {})[monthKey(1)] ?? null, goalLabel: monthLabel(1) };
  }
  if (period === "ytd") {
    return { goal: HVAC_SALES_YTD_GOALS[CA] ?? null, goalLabel: String(new Date().getFullYear()) };
  }
  return { goal: (HVAC_SALES_MONTHLY_GOALS[CA] || {})[monthKey(0)] ?? null, goalLabel: monthLabel(0) };
}

// Revenue here is the reconstructed true subtotal (commission-report.json's
// "revenue" section — see HVAC_SALES_MONTHLY_GOALS's own comment above for
// why that file and not a separate one), not the Sold tile's opportunity
// count above it — two different things that happen to share this page.
function goalRevenue(CA, period) {
  if (!latestCommission || !latestCommission.revenue) return 0;
  const bucket =
    period === "lastmonth" ? latestCommission.revenue.lastMonth : period === "ytd" ? latestCommission.revenue.ytd : latestCommission.revenue.mtd;
  return (bucket && bucket[CA]) || 0;
}

// Same structure/behavior as andrew.js's goal-card rendering (pace badge,
// hit state, empty state for a month with no target set) — see that
// file's comments for the full reasoning behind each piece. formatMoney
// (abbreviated, shared.js), not formatDollarsPrecise — these are large
// round targets ($300,000), not exact-to-the-cent pay like the commission
// section below.
function renderGoal(CA, period) {
  const { goal, goalLabel } = goalMeta(CA, period);
  const revenue = goalRevenue(CA, period);

  goalTitle.textContent = `Revenue goal · ${goalLabel}`;
  if (goal) {
    goalCard.classList.remove("unset");
    const pct = Math.min(100, Math.round((revenue / goal) * 100));
    goalFigures.innerHTML = `${formatMoney(revenue)} <span class="of">of ${formatMoney(goal)}</span> · ${pct}%`;
    goalFill.style.width = `${pct}%`;
    goalEmpty.hidden = true;

    const goalHit = revenue >= goal;
    goalCard.classList.toggle("hit", goalHit);
    if (goalHit) {
      paceBadge.hidden = false;
      paceBadge.className = "pace-badge hit";
      paceBadge.textContent = "🎉 Goal hit — nice work!";
    } else {
      const pace = paceInfo(period, revenue, goal);
      if (pace) {
        paceBadge.hidden = false;
        paceBadge.className = `pace-badge ${pace.diff >= 0 ? "ahead" : "behind"}`;
        paceBadge.textContent =
          pace.diff >= 0 ? `↑ ${formatMoney(pace.diff)} ahead of pace` : `${formatMoney(Math.abs(pace.diff))} behind an even pace`;
      } else {
        paceBadge.hidden = true;
      }
    }
  } else {
    goalCard.classList.remove("hit");
    goalCard.classList.add("unset");
    goalFigures.textContent = "";
    goalFill.style.width = "0%";
    goalEmpty.hidden = false;
    goalEmpty.textContent = `No goal set for ${goalLabel} yet.`;
    paceBadge.hidden = true;
  }
}

// Commission is separate from the ran/sold/period stuff above it — it's
// always "this calendar month," not scoped by the Last month/MTD/YTD
// period buttons (a commission week is a fixed Wed-Tue pay cycle, not
// something that makes sense to re-slice by an arbitrary period toggle).
// latestCommission can be null (fetch failed, or the file doesn't exist
// yet on a fresh deploy) — render an empty state rather than throwing.
function renderCommission(CA) {
  if (!latestCommission) {
    commissionMonthEl.textContent = "";
    commissionWeeksEl.innerHTML = '<div class="commission-empty">Commission data not available right now.</div>';
    commissionMtdValueEl.textContent = "—";
    return;
  }

  commissionMonthEl.textContent = commissionMonthLabel(latestCommission.meta && latestCommission.meta.month);

  const weeks = latestCommission.weeks || [];
  commissionWeeksEl.innerHTML = weeks.length
    ? weeks
        .map((w) => {
          const value = (w.totals && w.totals[CA]) || 0;
          return `
            <div class="commission-week-row">
              <span class="commission-week-label">${escapeHtml(w.label)}<span class="commission-week-range"> · ${commissionWeekRange(w.weekStart, w.weekEnd)}</span></span>
              <span class="commission-week-value">${formatDollarsPrecise(value)}</span>
            </div>
          `;
        })
        .join("")
    : '<div class="commission-empty">No commission recorded yet this month.</div>';

  const mtd = (latestCommission.mtd && latestCommission.mtd[CA]) || 0;
  commissionMtdValueEl.textContent = formatDollarsPrecise(mtd);
}

function renderRecordRow(r) {
  // Both dates explicitly labeled once they can actually differ (a sold
  // job whose Job # matched a Housecall Pro job created on a later date
  // than the consultation) — a bare date would be ambiguous about which
  // one it is, same reasoning as andrew.js's estimate rows.
  const upcoming = !r.sold && !hasHappened(r.date);
  const dateParts = [`${upcoming ? "Scheduled" : "Ran"} ${formatDate(r.date)}`];
  if (r.sold && r.soldDateResolved && r.soldDateResolved !== r.date) {
    dateParts.push(`Sold ${formatDate(r.soldDateResolved)}`);
  }
  const meta = [dateParts.join(" · "), r.lead, r.systemType].filter(Boolean).join(" · ");
  const statusClass = r.sold ? "won" : upcoming ? "scheduled" : "open";
  const statusLabel = r.sold ? "Sold" : upcoming ? "Scheduled" : "Not sold";
  return `
    <div class="record-row">
      <div class="record-left">
        <span class="record-customer">${escapeHtml(r.customerName || "Unknown")}</span>
        <span class="record-meta">${escapeHtml(meta)}</span>
      </div>
      <span class="record-status ${statusClass}">${statusLabel}</span>
    </div>
  `;
}

let latestDashboard = null;
let latestSales = null;
let latestCommission = null;
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
  // other, same as Andrew Rouscher's given/approved split. "ran" also
  // requires hasHappened — a consultation scheduled for later this month
  // hasn't happened yet, so it doesn't count as run (or as an unsold
  // opportunity) just because its date falls in the period. scheduledInPeriod
  // is the broader, ungated set used only for the record list below, so a
  // future appointment still shows there for visibility.
  const scheduledInPeriod = mine.filter((r) => dateInPeriod(r.date, currentPeriod));
  const ranInPeriod = scheduledInPeriod.filter((r) => hasHappened(r.date));
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

  renderGoal(CA, currentPeriod);
  renderCommission(CA);

  renderRateBreakdown("breakdown-club-member", closingRateBreakdown(ranInPeriod, soldInPeriod, "clubMember"));
  renderRateBreakdown("breakdown-lead", closingRateBreakdown(ranInPeriod, soldInPeriod, "lead"));
  renderRateBreakdown("breakdown-customer-type", closingRateBreakdown(ranInPeriod, soldInPeriod, "customerType"));
  renderSystemTypeBreakdown(systemTypeBreakdown(soldInPeriod));

  // Union of scheduledInPeriod (not ranInPeriod) and soldInPeriod — a job
  // sold this period but run earlier belongs in the list too, and so does
  // a consultation booked for later this period that hasn't happened yet
  // (shown, per an explicit request, even though it's excluded from the
  // Ran tile/metrics above until its date actually arrives). Records are
  // unique object references (one per source row, freshly mapped above),
  // so a plain Set dedupes a row present in both sets without needing a
  // synthetic id.
  const listRecords = [...new Set([...scheduledInPeriod, ...soldInPeriod])];
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

    // Own try/catch, deliberately not part of the Promise.all above or the
    // outer catch below — a missing/failed commission-report.json (e.g. a
    // fresh deploy before the first scheduled refresh has run) shouldn't
    // take down the rest of the page. renderCommission already handles
    // latestCommission staying null.
    try {
      const commissionRes = await fetch(`data/commission-report.json?_=${Date.now()}`, { cache: "no-store" });
      latestCommission = commissionRes.ok ? await commissionRes.json() : null;
    } catch (commissionErr) {
      latestCommission = null;
      console.error(commissionErr);
    }

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
