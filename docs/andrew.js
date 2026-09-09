// Andrew Rouscher's dedicated scorecard — a personal daily-use page, not a
// mode of index.html. Reuses shared.js for data fetching, period math, and
// the estimator stat computation (computeEstimatorStats etc.) so this page's
// numbers can never drift from what his card would show on the shared
// dashboard — only the layout and visual treatment are bespoke to this page.

const ANDREW_ID = "pro_ca120cbb55fa40fe9361d492161b101f";

// Flat month over month (unlike the HVAC Installation team's per-month
// dict in tv.js) — $1.75M/year split evenly across 12 months. The YTD
// view tracks cumulative revenue against its own flat $1.75M annual
// target (not prorated to today's date — a running total against a
// full-year quota, same convention a sales quota uses).
const ANDREW_MONTHLY_GOAL = 1_750_000 / 12;
const ANDREW_YTD_GOAL = 1_750_000;

// A closing-rate target, not a revenue one — a ratio rather than a
// cumulative dollar figure, so unlike the two goals above it doesn't need
// prorating by how much of the period has elapsed and applies the same way
// to all three period tabs (last month's closing rate, this month's
// so-far rate, and the year's blended rate are all just "approved ÷
// given"). Shown as a tick mark on the closing ring plus a "Target N%"
// caption — see the ring-target-tick math in render().
const ANDREW_CLOSING_GOAL_PCT = 50;

// How many days an open (undecided) estimate can sit before the follow-up
// nudge calls it out by name rather than just counting it — see the
// "behind pace" branch in render(). Picked as "the better part of a work
// week without an answer," not tied to any Housecall Pro or company policy.
const STALE_ESTIMATE_DAYS = 5;

const greetingEl = document.getElementById("greeting");
const identityName = document.getElementById("identity-name");
const avatarSlot = document.getElementById("avatar-slot");
const todayStrip = document.getElementById("today-strip");
const heroEyebrow = document.getElementById("hero-eyebrow");
const heroLine = document.getElementById("hero-line");
const trendLine = document.getElementById("trend-line");
const ringNumber = document.getElementById("ring-number");
const ringFill = document.getElementById("ring-fill");
const ringTarget = document.getElementById("ring-target");
const ringTargetTick = document.getElementById("ring-target-tick");
const goalCard = document.getElementById("goal-card");
const goalTitle = document.getElementById("goal-title");
const goalFigures = document.getElementById("goal-figures");
const goalFill = document.getElementById("goal-fill");
const goalEmpty = document.getElementById("goal-empty");
const paceBadge = document.getElementById("pace-badge");
const paceDetail = document.getElementById("pace-detail");
const followupNudge = document.getElementById("followup-nudge");
const tileGiven = document.getElementById("tile-given");
const tileApproved = document.getElementById("tile-approved");
const tileApprovedNote = document.getElementById("tile-approved-note");
const tileRevenue = document.getElementById("tile-revenue");
const tileAvgTicket = document.getElementById("tile-avg-ticket");
const estimateListCard = document.getElementById("estimate-list-card");
const estimateListSummary = document.getElementById("estimate-list-summary");
const estimateListBody = document.getElementById("estimate-list-body");

const CIRCUMFERENCE = 2 * Math.PI * 60;

// Where the target tick sits on the ring, in the SVG's own (pre-rotation)
// coordinate space. The ring-fill circle's stroke-dasharray/dashoffset
// trick (see render()) starts drawing from this same circle's local angle
// 0 and, combined with the ring's `transform: rotate(-90deg)` in CSS,
// ends up sweeping clockwise on screen starting from the top — the same
// convention every "progress ring" built this way uses. Parametrizing the
// tick with the identical (cx + r·cos θ, cy + r·sin θ) formula, θ = pct/100
// of a full turn, guarantees it lands exactly where the fill's leading
// edge would be at that percentage, without having to separately reason
// about the CSS rotation. Verified visually (screenshot) once, not just
// derived — see the andrew.html/andrew.css comments for the ring markup.
function ringTickPoints(pct, innerR, outerR) {
  const cx = 74;
  const cy = 74;
  const theta = (pct / 100) * 2 * Math.PI;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return {
    x1: cx + innerR * cos,
    y1: cy + innerR * sin,
    x2: cx + outerR * cos,
    y2: cy + outerR * sin,
  };
}

let latestData = null;
let currentPeriod = "month";

function monthLabel(monthsAgo) {
  const d = new Date();
  d.setDate(1); // avoid end-of-month rollover surprises when subtracting months
  d.setMonth(d.getMonth() - monthsAgo);
  return d.toLocaleDateString([], { month: "long" });
}

function greetingPrefix() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function firstName(fullName) {
  return (fullName || "").trim().split(/\s+/)[0] || "there";
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// How far ahead of (or behind) a flat, evenly-paced march toward the goal
// Andrew's actual revenue is right now — e.g. on day 10 of a 30-day month,
// "on pace" means a third of the goal. Only meaningful for an open period
// with a real goal: "lastmonth" is already over (nothing left to pace
// against), and periodMeta's own periodRange("ytd") spans Jan 1 through
// *today*, not the full year, so the full-year boundaries are computed
// here instead rather than reusing that (different purpose: that range is
// for filtering estimates, this one is for measuring how much of the full
// year has elapsed). Also returns what it'd take to actually catch up —
// daysRemaining and the flat $/day needed for the rest of the period to
// still hit goal — a "behind pace" number alone says how big the hole is
// but not what to do about it today.
function paceInfo(period, revenue, goal) {
  if (period === "lastmonth" || !goal) return null;
  const now = new Date();
  const [start, end] =
    period === "ytd" ? [new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1)] : periodRange("month");
  const fracElapsed = Math.min(1, Math.max(0, (now - start) / (end - start)));
  const daysRemaining = Math.max(1, Math.ceil((end - now) / 86_400_000));
  const perDayNeeded = Math.max(0, goal - revenue) / daysRemaining;
  return { diff: revenue - goal * fracElapsed, daysRemaining, perDayNeeded };
}

// The prior-cycle window to compare this period's numbers against,
// capped at the same relative cutoff `period` is at right now — MTD on
// day 9 compares against last month's day 1–9, not last month's full
// total, which would always look "behind" until the month ends and
// wouldn't actually be a fair comparison. A period that's already fully
// elapsed (lastmonth) compares against the prior full cycle instead,
// since there's no "so far" to match on either side. Returns null for
// any period with no sensible prior cycle to compare against.
function comparisonRange(period) {
  const now = new Date();
  if (period === "month") {
    const dayOfMonth = now.getDate();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - 1, dayOfMonth + 1);
    return { range: [start, end], label: "last month" };
  }
  if (period === "lastmonth") {
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { range: [start, end], label: "the month before" };
  }
  if (period === "week") {
    const [thisWeekStart] = periodRange("week");
    const dayOfWeek = now.getDay();
    const start = new Date(thisWeekStart.getFullYear(), thisWeekStart.getMonth(), thisWeekStart.getDate() - 7);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOfWeek + 1);
    return { range: [start, end], label: "last week" };
  }
  if (period === "ytd") {
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / 86_400_000);
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear() - 1, 0, dayOfYear + 2);
    return { range: [start, end], label: "last year" };
  }
  return null;
}

// A closed-period-style stats calc for an arbitrary past date window (not
// one of the named periods dateInPeriod knows about) — used only for the
// trend-line comparison windows above. A window that's fully in the past
// means every estimate given in it has already had its chance to close,
// so this always applies the same "closed period" logic
// computeEstimatorStats uses for lastmonth/lastweek (union with
// missingApprovedAtEstimates) rather than the "still open" branch it
// uses for month/week/ytd.
function statsForWindow(pool, tech, start, end) {
  const inWindow = (dateStr) => Boolean(dateStr) && new Date(dateStr) >= start && new Date(dateStr) < end;
  const given = pool.filter((e) => inWindow(estimateGivenDate(e, tech)));
  const approvedByDate = pool.filter((e) => e.approved && inWindow(e.approved_at));
  const approved = unionById(approvedByDate, missingApprovedAtEstimates(given));
  const revenueCents = approved.reduce((sum, e) => sum + (e.approved_amount || 0), 0);
  return { given: given.length, closingRate: given.length ? (approved.length / given.length) * 100 : 0, revenue: revenueCents / CENTS_PER_DOLLAR };
}

// One "▲ 8pts closing" / "▼ $1.1K revenue" chip for the trend line.
// Treats a sub-unit difference as flat (a neutral "→", not a false up/down)
// rather than letting rounding noise claim a direction that isn't real.
function trendChip(delta, unit, metricLabel) {
  const flat = unit === "pt" ? Math.round(delta) === 0 : Math.abs(delta) < 1;
  const dirClass = flat ? "flat" : delta > 0 ? "up" : "down";
  const arrow = flat ? "→" : delta > 0 ? "▲" : "▼";
  const amount = unit === "pt" ? `${Math.abs(Math.round(delta))}pt${Math.abs(Math.round(delta)) === 1 ? "" : "s"}` : formatMoney(Math.abs(delta));
  return `<span class="trend-value ${dirClass}">${arrow} ${amount} ${metricLabel}</span>`;
}

function periodMeta(period) {
  if (period === "lastmonth") {
    return {
      goal: ANDREW_MONTHLY_GOAL,
      goalLabel: monthLabel(1),
      eyebrow: `${monthLabel(1)} · full month`,
      givenPhrase: `given in ${monthLabel(1)}`,
    };
  }
  if (period === "week") {
    // No established weekly revenue target (only the monthly/annual ones
    // above were ever set) — goal stays null rather than inventing one by
    // dividing the monthly goal by ~4.3, so the goal card honestly shows
    // "No goal set" instead of a number nobody actually agreed to.
    const [start] = periodRange("week");
    const weekLabel = `Week of ${start.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    return {
      goal: null,
      goalLabel: weekLabel,
      eyebrow: `${weekLabel} · ${new Date().toLocaleDateString([], { weekday: "long" })}`,
      givenPhrase: "given this week",
    };
  }
  if (period === "ytd") {
    const year = new Date().getFullYear();
    const [start] = periodRange("ytd");
    const today = new Date();
    return {
      goal: ANDREW_YTD_GOAL,
      goalLabel: String(year),
      eyebrow: `${start.toLocaleDateString([], { month: "short", day: "numeric" })} – ${today.toLocaleDateString([], { month: "short", day: "numeric" })}`,
      givenPhrase: "given this year",
    };
  }
  const [start, end] = periodRange("month");
  const daysInMonth = Math.round((end - start) / 86_400_000);
  const dayOfMonth = Math.min(daysInMonth, new Date().getDate());
  return {
    goal: ANDREW_MONTHLY_GOAL,
    goalLabel: monthLabel(0),
    eyebrow: `${monthLabel(0)} · day ${dayOfMonth} of ${daysInMonth}`,
    givenPhrase: "given this month",
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
        ${estimate.estimate_number ? `<span class="estimate-number">#${escapeHtml(estimate.estimate_number)}</span>` : ""}
        <span class="estimate-date">${parts.join(" · ")}</span>
      </div>
      <span class="estimate-status ${won ? "won" : "open"}">${won ? "Approved" : "Pending"}</span>
      <span class="estimate-amount ${won ? "won" : ""}">${won ? formatMoney((estimate.approved_amount || 0) / CENTS_PER_DOLLAR) : "—"}</span>
    </div>
  `;
}

// renderAvatar (shared.js) always uses tech.avatar_url — Housecall Pro's
// API only ever returns a 40x40 thumbnail, fine for the ~36px avatars
// style.css uses elsewhere but visibly blurry at this page's much larger
// 76px identity photo. largeAvatarUrl/handleLargeAvatarError (shared.js)
// swap in the "original" full-res photo where one resolves, with the same
// two-stage fallback (original -> thumb -> colored initials) the TV
// kiosk's featured/row photos already use for the same reason — see
// renderAvatarBlock in tv.js for the pattern this mirrors. Falls back to
// the plain thumb via renderAvatar when there's no largeAvatarUrl at all
// (MANUAL_AVATAR_OVERRIDES not set and tech.avatar_url isn't a
// thumb_web_round path).
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

function render() {
  if (!latestData) return;

  const tech = (latestData.technicians || []).find((t) => t.id === ANDREW_ID);
  if (!tech) {
    document.querySelector(".page").innerHTML = '<p class="empty-state">Andrew Rouscher was not found in the synced roster.</p>';
    return;
  }

  greetingEl.textContent = `${greetingPrefix()}, ${firstName(tech.name)} 👋`;
  identityName.textContent = tech.name || "Andrew Rouscher";
  avatarSlot.innerHTML = renderLargeAvatar(tech);

  // Excludes canceled estimates (customer called in and canceled before it
  // was ever presented) — see isCanceledEstimate/CANCELED_ESTIMATE_STATUSES
  // in shared.js.
  const allEstimates = (latestData.estimates || []).filter((e) => !isCanceledEstimate(e));
  const mine = allEstimates.filter((e) => (e.assigned_employee_ids || []).includes(tech.id));

  // Today's wins, independent of whichever period tab is selected — a
  // daily-use page deserves a "here's what's fresh today" moment. Only
  // shown when there's actually something to celebrate; an empty "0 today"
  // banner would just read as a scoreboard calling out a slow morning, not
  // as encouragement.
  const now = new Date();
  const approvedToday = mine.filter((e) => e.approved && e.approved_at && isSameCalendarDay(new Date(e.approved_at), now));
  if (approvedToday.length > 0) {
    const todayRevenue = approvedToday.reduce((sum, e) => sum + (e.approved_amount || 0) / CENTS_PER_DOLLAR, 0);
    todayStrip.hidden = false;
    todayStrip.innerHTML = `🎉 <b>${approvedToday.length} approved today</b> — ${escapeHtml(formatMoney(todayRevenue))} in the books.`;
  } else {
    todayStrip.hidden = true;
  }

  const estimatesGiven = mine.filter((e) => dateInPeriod(estimateGivenDate(e, tech), currentPeriod));
  const approvedThisPeriod = mine.filter((e) => e.approved && dateInPeriod(e.approved_at, currentPeriod));
  const stats = computeEstimatorStats(estimatesGiven, approvedThisPeriod, currentPeriod);

  // Two subsets of "Approved" worth calling out — neither overlaps the
  // other, so they can just be listed together: estimates approved this
  // period that were given in an earlier one (the ones that make Approved
  // ≠ "given and closed within this period"), and estimates given this
  // period that are approved but have no recorded approval date at all
  // (see missingApprovedAtEstimates in shared.js — a real Housecall Pro
  // gap, not a bug) so they can't match any period by date and would
  // otherwise need a fallback to land in "Approved" anywhere at all.
  const givenInPeriodIds = new Set(estimatesGiven.map((e) => e.id));
  const givenEarlierCount = approvedThisPeriod.filter((e) => !givenInPeriodIds.has(e.id)).length;
  const undatedCount = missingApprovedAtEstimates(estimatesGiven).length;

  // Independent of the goal/pace system below — this compares against his
  // own recent past, not a target, so it still has something to say on
  // the "week" tab (no revenue goal exists there) and even once a goal's
  // already been hit for the period.
  const comparison = comparisonRange(currentPeriod);
  const compStats = comparison ? statsForWindow(mine, tech, comparison.range[0], comparison.range[1]) : null;
  if (compStats && compStats.given > 0) {
    trendLine.hidden = false;
    trendLine.innerHTML = `vs ${comparison.label}: ${trendChip(stats.closingRate - compStats.closingRate, "pt", "closing")} · ${trendChip(stats.revenue - compStats.revenue, "$", "revenue")}`;
  } else {
    trendLine.hidden = true;
  }

  const meta = periodMeta(currentPeriod);

  heroEyebrow.textContent = meta.eyebrow;
  ringNumber.textContent = `${stats.closingRate.toFixed(0)}%`;
  ringFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - Math.min(100, stats.closingRate) / 100));

  const closingHit = stats.given > 0 && stats.closingRate >= ANDREW_CLOSING_GOAL_PCT;
  ringNumber.classList.toggle("hit", closingHit);
  ringTarget.textContent = `Target ${ANDREW_CLOSING_GOAL_PCT}%`;
  const tick = ringTickPoints(ANDREW_CLOSING_GOAL_PCT, 50, 74);
  ringTargetTick.setAttribute("x1", tick.x1.toFixed(2));
  ringTargetTick.setAttribute("y1", tick.y1.toFixed(2));
  ringTargetTick.setAttribute("x2", tick.x2.toFixed(2));
  ringTargetTick.setAttribute("y2", tick.y2.toFixed(2));

  // Kept to just the headline facts — given/closed counts, revenue, avg
  // ticket — with no "so far" (wrong on a closed period that's already
  // over) and no given-earlier/no-date-on-record provenance clause (that
  // nuance already has its own note directly under the Approved/Approved
  // this period tiles below; repeating it here as a dangling sentence
  // fragment just competed with the headline number for attention).
  heroLine.innerHTML = `
    <b>${stats.given.toLocaleString()} estimates</b> ${meta.givenPhrase}, <b>${stats.approved.toLocaleString()} closed</b> &mdash;
    <span class="gold-num">${formatMoney(stats.revenue)}</span> accepted, averaging
    <span class="gold-num">${formatMoney(stats.avgTicket)}</span> per deal.
  `;

  tileGiven.textContent = stats.given.toLocaleString();
  tileApproved.textContent = stats.approved.toLocaleString();
  const approvedNoteParts = [];
  if (givenEarlierCount > 0) approvedNoteParts.push(`${givenEarlierCount} given earlier`);
  if (undatedCount > 0) approvedNoteParts.push(`${undatedCount} with no exact date on record`);
  tileApprovedNote.textContent = approvedNoteParts.length ? `incl. ${approvedNoteParts.join(" · ")}` : "";
  tileRevenue.textContent = formatMoney(stats.revenue);
  tileAvgTicket.textContent = formatMoney(stats.avgTicket);

  goalTitle.textContent = `Revenue goal · ${meta.goalLabel}`;
  if (meta.goal) {
    goalCard.classList.remove("unset");
    const pct = Math.min(100, Math.round((stats.revenue / meta.goal) * 100));
    goalFigures.innerHTML = `${formatMoney(stats.revenue)} <span class="of">of ${formatMoney(meta.goal)}</span> · ${pct}%`;
    goalFill.style.width = `${pct}%`;
    goalEmpty.hidden = true;

    const goalHit = stats.revenue >= meta.goal;
    goalCard.classList.toggle("hit", goalHit);
    if (goalHit) {
      paceBadge.hidden = false;
      paceBadge.className = "pace-badge hit";
      paceBadge.textContent = "🎉 Goal hit — nice work!";
      paceDetail.hidden = true;
      followupNudge.hidden = true;
    } else {
      const pace = paceInfo(currentPeriod, stats.revenue, meta.goal);
      if (pace) {
        paceBadge.hidden = false;
        paceBadge.className = `pace-badge ${pace.diff >= 0 ? "ahead" : "behind"}`;
        paceBadge.textContent =
          pace.diff >= 0
            ? `↑ ${formatMoney(pace.diff)} ahead of pace`
            : `${formatMoney(Math.abs(pace.diff))} behind an even pace`;
      } else {
        paceBadge.hidden = true;
      }

      // A concrete next step, not just a number — only when there's
      // actually behind-pace *and* something on his own plate to act on.
      // Deliberately scoped to estimatesGiven (the same period-bounded set
      // the ring/hero line already use), not his whole all-time backlog —
      // an all-time count runs into the hundreds for anyone who's been
      // here a while and stops reading as "do this today."
      if (pace && pace.diff < 0) {
        // Reframes the same gap as a daily number, not just a lump sum —
        // "$32K behind" doesn't say what to actually do today; "~$1.5K/day
        // for the rest of the month" does.
        paceDetail.hidden = false;
        paceDetail.textContent = `Needs ≈${formatMoney(pace.perDayNeeded)}/day for the rest of ${meta.goalLabel} to catch up.`;

        const openInPeriod = estimatesGiven.filter((e) => !e.approved);
        const staleCount = openInPeriod.filter((e) => {
          const given = estimateGivenDate(e, tech);
          return given && (now - new Date(given)) / 86_400_000 >= STALE_ESTIMATE_DAYS;
        }).length;
        if (openInPeriod.length > 0) {
          followupNudge.hidden = false;
          const openCount = openInPeriod.length;
          const openWord = openCount === 1 ? "estimate" : "estimates";
          const summary =
            staleCount > 0
              ? `📞 <b>${staleCount} of ${openCount} open ${openWord}</b> ${meta.givenPhrase} ${staleCount === 1 ? "hasn't" : "haven't"} heard back in ${STALE_ESTIMATE_DAYS}+ days — a follow-up call could help close the gap.`
              : `📞 <b>${openCount} open ${openWord}</b> ${meta.givenPhrase} — checking in on ${openCount === 1 ? "it" : "them"} could help close the gap.`;

          // Names the single longest-open one specifically — a starting
          // point, not just a pile to sort through himself. Only when the
          // stale-days threshold is actually met (staleCount > 0
          // guarantees the oldest one qualifies, since it's the max-age
          // estimate in the set).
          let spotlight = "";
          if (staleCount > 0) {
            const oldest = openInPeriod
              .map((e) => ({ e, given: estimateGivenDate(e, tech) }))
              .filter((x) => x.given)
              .sort((a, b) => new Date(a.given) - new Date(b.given))[0];
            if (oldest) {
              const days = Math.floor((now - new Date(oldest.given)) / 86_400_000);
              spotlight = `<div class="nudge-spotlight">Start with <b>${escapeHtml(oldest.e.customer_label || "Unknown")}</b> — ${days} day${days === 1 ? "" : "s"} and counting.</div>`;
            }
          }
          followupNudge.innerHTML = summary + spotlight;
        } else {
          followupNudge.hidden = true;
        }
      } else {
        paceDetail.hidden = true;
        followupNudge.hidden = true;
      }
    }
  } else {
    goalCard.classList.remove("hit");
    goalCard.classList.add("unset");
    goalFigures.textContent = "";
    goalFill.style.width = "0%";
    goalEmpty.hidden = false;
    goalEmpty.textContent = `No goal set for ${meta.goalLabel} yet.`;
    paceBadge.hidden = true;
    paceDetail.hidden = true;
    followupNudge.hidden = true;
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
