// Andrew Rouscher's dedicated scorecard — a personal daily-use page, not a
// mode of index.html. Reuses shared.js for data fetching, period math, and
// the estimator stat computation (computeEstimatorStats etc.) so this page's
// numbers can never drift from what his card would show on the shared
// dashboard — only the layout and visual treatment are bespoke to this page.

const ANDREW_ID = "pro_ca120cbb55fa40fe9361d492161b101f";

// Flat month over month (unlike the HVAC Installation team's per-month
// dict in tv.js) — $2.5M/year split evenly across 12 months. The YTD view
// tracks cumulative revenue against its own flat $2.5M annual target
// (not prorated to today's date — a running total against a full-year
// quota, same convention a sales quota uses).
const ANDREW_MONTHLY_GOAL = 2_500_000 / 12;
const ANDREW_YTD_GOAL = 2_500_000;

const identityName = document.getElementById("identity-name");
const avatarSlot = document.getElementById("avatar-slot");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroLine = document.getElementById("hero-line");
const ringNumber = document.getElementById("ring-number");
const ringFill = document.getElementById("ring-fill");
const goalCard = document.getElementById("goal-card");
const goalTitle = document.getElementById("goal-title");
const goalFigures = document.getElementById("goal-figures");
const goalFill = document.getElementById("goal-fill");
const goalEmpty = document.getElementById("goal-empty");
const tileGiven = document.getElementById("tile-given");
const tileApproved = document.getElementById("tile-approved");
const tileApprovedNote = document.getElementById("tile-approved-note");
const tileApprovedPeriod = document.getElementById("tile-approved-period");
const tileApprovedSub = document.getElementById("tile-approved-sub");
const tileRevenue = document.getElementById("tile-revenue");
const tileAvgTicket = document.getElementById("tile-avg-ticket");
const estimateListCard = document.getElementById("estimate-list-card");
const estimateListSummary = document.getElementById("estimate-list-summary");
const estimateListBody = document.getElementById("estimate-list-body");

const CIRCUMFERENCE = 2 * Math.PI * 60;

let latestData = null;
let currentPeriod = "month";

function monthLabel(monthsAgo) {
  const d = new Date();
  d.setDate(1); // avoid end-of-month rollover surprises when subtracting months
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toLocaleDateString([], { month: "long" });
}

function periodMeta(period) {
  if (period === "lastmonth") {
    return { goal: ANDREW_MONTHLY_GOAL, goalLabel: monthLabel(1), eyebrow: `${monthLabel(1)} · full month` };
  }
  if (period === "ytd") {
    const year = new Date().getFullYear();
    const [start] = periodRange("ytd");
    const today = new Date();
    return {
      goal: ANDREW_YTD_GOAL,
      goalLabel: String(year),
      eyebrow: `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${today.toLocaleDateString([], { month: "short", day: "numeric" })}`,
    };
  }
  const [start, end] = periodRange("month");
  const daysInMonth = Math.round((end - start) / 86_400_000);
  const dayOfMonth = Math.min(daysInMonth, new Date().getDate());
  return {
    goal: ANDREW_MONTHLY_GOAL,
    goalLabel: monthLabel(0),
    eyebrow: `${monthLabel(0)} · day ${dayOfMonth} of ${daysInMonth}`,
  };
}

function renderEstimateRow(estimate, tech) {
  const givenDate = estimateGivenDate(estimate, tech) || estimate.created_at;
  const won = Boolean(estimate.approved);
  const parts = [`Given ${formatDate(givenDate)}`];
  if (won) parts.push(`Approved ${formatDate(estimate.approved_at)}`);
  return `
    <div class="estimate-row">
      <div class="estimate-left">
        <span class="estimate-customer">${escapeHtml(estimate.customer_label || "Unknown")}</span>
        <span class="estimate-date">${parts.join(" · ")}</span>
      </div>
      <span class="estimate-status ${won ? "won" : "open"}">${won ? "Approved" : "Pending"}</span>
      <span class="estimate-amount ${won ? "won" : ""}">${won ? formatMoney((estimate.approved_amount || 0) / CENTS_PER_DOLLAR) : "—"}</span>
    </div>
  `;
}

function render() {
  if (!latestData) return;

  const tech = (latestData.technicians || []).find((t) => t.id === ANDREW_ID);
  if (!tech) {
    document.querySelector(".page").innerHTML = '<p class="empty-state">Andrew Rouscher was not found in the synced roster.</p>';
    return;
  }

  identityName.textContent = tech.name || "Andrew Rouscher";
  avatarSlot.innerHTML = renderAvatar(tech);

  const allEstimates = latestData.estimates || [];
  const mine = allEstimates.filter((e) => (e.assigned_employee_ids || []).includes(tech.id));

  const estimatesGiven = mine.filter((e) => dateInPeriod(estimateGivenDate(e, tech), currentPeriod));
  const approvedThisPeriod = mine.filter((e) => e.approved && dateInPeriod(e.approved_at, currentPeriod));
  const stats = computeEstimatorStats(estimatesGiven, approvedThisPeriod, currentPeriod);

  const givenInPeriodIds = new Set(estimatesGiven.map((e) => e.id));
  const givenEarlierCount = approvedThisPeriod.filter((e) => !givenInPeriodIds.has(e.id)).length;

  // Closed-period "Approved" folds in estimates with no recorded approval
  // date (see missingApprovedAtEstimates/CLOSED_PERIODS in shared.js) — they
  // never show up in approvedThisPeriod (nothing to date-match), so without
  // this note the headline "Approved" tile can read higher than "Approved
  // this period" with no visible explanation for the gap.
  const undatedCount = CLOSED_PERIODS.has(currentPeriod) ? missingApprovedAtEstimates(estimatesGiven).length : 0;

  const meta = periodMeta(currentPeriod);

  heroEyebrow.textContent = meta.eyebrow;
  ringNumber.textContent = `${stats.closingRate.toFixed(0)}%`;
  ringFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - Math.min(100, stats.closingRate) / 100));

  const earlierClause =
    givenEarlierCount === 0
      ? "all of them given this same period"
      : `${givenEarlierCount} of ${givenEarlierCount === 1 ? "them was" : "them were"} given earlier and closed now`;
  heroLine.innerHTML = `
    <b>${stats.given.toLocaleString()} estimates</b> given, <b>${stats.approved.toLocaleString()} closed</b> so far &mdash;
    ${earlierClause}. <span class="gold-num">${formatMoney(stats.revenue)}</span> accepted, averaging
    <span class="gold-num">${formatMoney(stats.avgTicket)}</span> per closed deal.
  `;

  tileGiven.textContent = stats.given.toLocaleString();
  tileApproved.textContent = stats.approved.toLocaleString();
  tileApprovedNote.textContent =
    undatedCount > 0 ? `incl. ${undatedCount} with no exact approval date on record` : "";
  tileApprovedPeriod.textContent = approvedThisPeriod.length.toLocaleString();
  tileApprovedSub.textContent = givenEarlierCount === 0 ? "all given this period" : `${givenEarlierCount} given earlier, closed now`;
  tileRevenue.textContent = formatMoney(stats.revenue);
  tileAvgTicket.textContent = formatMoney(stats.avgTicket);

  goalTitle.textContent = `Revenue goal · ${meta.goalLabel}`;
  if (meta.goal) {
    goalCard.classList.remove("unset");
    const pct = Math.min(100, Math.round((stats.revenue / meta.goal) * 100));
    goalFigures.innerHTML = `${formatMoney(stats.revenue)} <span class="of">of ${formatMoney(meta.goal)}</span> · ${pct}%`;
    goalFill.style.width = `${pct}%`;
    goalEmpty.hidden = true;
  } else {
    goalCard.classList.add("unset");
    goalFigures.textContent = "";
    goalFill.style.width = "0%";
    goalEmpty.hidden = false;
    goalEmpty.textContent = `No goal set for ${meta.goalLabel} yet.`;
  }

  const sorted = unionById(estimatesGiven, approvedThisPeriod).sort((a, b) => {
    const aDate = estimateGivenDate(a, tech) || a.created_at || "";
    const bDate = estimateGivenDate(b, tech) || b.created_at || "";
    return bDate.localeCompare(aDate); // newest first — this is a daily-glance page, not an audit log
  });

  estimateListSummary.textContent = `${sorted.length} estimate${sorted.length === 1 ? "" : "s"} in view`;
  estimateListBody.innerHTML = sorted.length
    ? sorted.map((e) => renderEstimateRow(e, tech)).join("")
    : '<div class="no-estimates">No estimates match this period.</div>';
}

async function loadData() {
  try {
    const res = await fetch(`${DATA_URL}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    latestData = await res.json();
    render();
    updateSyncStatus(latestData.meta || {});
  } catch (err) {
    syncStatusEl.textContent = "Failed to load data";
    syncStatusEl.classList.add("error");
    if (!latestData) {
      document.querySelector(".page").innerHTML = '<p class="empty-state">Could not load dashboard data yet.</p>';
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
