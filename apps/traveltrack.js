// PUT IN: apps/traveltrack.js (REPLACES the current one)
// (this banner line is for verification only, delete it after checking the path)

/**
 * TravelTrack — trips, expenses, mileage, and loyalty miles.
 *
 * REBUILT, not ported. The standalone runs on Base44 (traveltrack.base44.app,
 * branded "TripLedger" in its own page titles), which has no api/ folder to
 * point at — see lib/traveltrack/schema.js and api/traveltrack/*.js for the
 * new backend this app talks to through the seam.
 *
 * Base44's page list was: Expenses, Expense Form, Trips, Trip Form, Redeem
 * Miles, Reports, Org Settings, Account Settings, Org Setup. Trip Form and
 * Expense Form are folded into their list views as an inline create/edit
 * panel here (same pattern the rest of the shell uses), and Org Settings +
 * Account Settings are one Settings view with the org section gated by role.
 * "Org Setup" (initial org creation on Base44) has no shell equivalent —
 * there is exactly one org here, P&M, and it always exists.
 *
 * PERMISSIONS. This is the first self-serve app in the shell: everyone with
 * the app grants their own trips and expenses (data_scope "own" — the "am"
 * role, today). data_scope "all" (admin/manager) sees the whole team's,
 * approves/rejects/reimburses expenses, and edits Org Settings. Filtering is
 * enforced server-side in api/traveltrack/*.js; the data_scope flag here only
 * drives which controls the UI shows.
 */

import { ENDPOINTS } from '../js/api.js';

/* ------------------------------------------------------------------ *
 * CONSTANTS — mirror lib/traveltrack/schema.js. Kept as a plain local
 * copy rather than imported, matching how ErrorEngine and GivingGauge
 * keep their own front-end enum lists: apps/ never imports lib/, which
 * is server-side code.
 * ------------------------------------------------------------------ */

const EXPENSE_CATEGORIES = [
  'Airfare', 'Lodging', 'Meals', 'Mileage', 'Rental Car',
  'Parking & Tolls', 'Rideshare/Taxi', 'Registration/Fees', 'Other'
];
const MILEAGE_CATEGORY = 'Mileage';

const PAYMENT_METHODS = [
  ['company_card', 'Company card'],
  ['personal_reimburse', 'Personal — reimburse']
];

const TRIP_STATUSES = [
  ['potential', 'Potential'],
  ['confirmed', 'Confirmed'],
  ['attended', 'Attended'],
  ['did_not_attend', 'Did Not Attend'],
  ['cancelled', 'Cancelled']
];

// Legacy values from the first build. Normalized on read so an existing
// record never renders as a blank/unknown status. Mirrors
// normalizeTripStatus() in lib/traveltrack/schema.js.
const LEGACY_TRIP_STATUS = { planned: 'potential', in_progress: 'confirmed', completed: 'attended' };
function normStatus(s) {
  const k = String(s || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (TRIP_STATUSES.some((p) => p[0] === k)) return k;
  return LEGACY_TRIP_STATUS[k] || 'potential';
}

// Per-category icon + hue, so an expense list is scannable at a glance
// (the standalone did this and Ryan called it out specifically). Hues are
// token names, never raw hex — see css/tokens.css.
const CATEGORY_META = {
  'Airfare':            { hue: 'chart-1',    icon: 'M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 0 0-3-3L13 8 4.8 6.2a1 1 0 0 0-.9 1.7l6 3.4-2.5 2.5-2.6-.6a.8.8 0 0 0-.7 1.3l2 2 2 2a.8.8 0 0 0 1.3-.7l-.6-2.6 2.5-2.5 3.4 6a1 1 0 0 0 1.7-.9Z' },
  'Lodging':            { hue: 'chart-4',    icon: 'M3 21h18M4 21V8l8-5 8 5v13M9 21v-5h6v5' },
  'Meals':              { hue: 'chart-2',    icon: 'M3 2v7a3 3 0 0 0 3 3v10M6 2v7M9 2v7M18 2c-1.7 1.5-2.5 4-2.5 7s.8 4 2.5 4v9' },
  'Mileage':            { hue: 'chart-3',    icon: 'M5 17h14M6 17V9l2-4h8l2 4v8M7 13h10M8 20v-3M16 20v-3' },
  'Rental Car':         { hue: 'chart-6',    icon: 'M5 17h14M6 17V9l2-4h8l2 4v8M7 13h10M8 20v-3M16 20v-3' },
  'Parking & Tolls':    { hue: 'chart-9',    icon: 'M6 3h6a5 5 0 0 1 0 10H9v8H6V3Zm3 3v4h3a2 2 0 0 0 0-4H9Z' },
  'Rideshare/Taxi':     { hue: 'chart-8',    icon: 'M5 17h14M6 17V9l2-4h8l2 4v8M7 13h10M8 20v-3M16 20v-3' },
  'Registration/Fees':  { hue: 'chart-5',    icon: 'M4 4h16v6a2 2 0 0 0 0 4v6H4v-6a2 2 0 0 0 0-4V4Zm10 0v16' },
  'Other':              { hue: 'chart-7',    icon: 'M4 6h16M4 12h16M4 18h10' }
};

function categoryMeta(cat) {
  return CATEGORY_META[cat] || CATEGORY_META['Other'];
}

function categoryIcon(cat) {
  const m = categoryMeta(cat);
  return '<span class="cat-icon" style="--cat:var(--' + m.hue + ')">' +
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + m.icon + '"/></svg>' +
    '</span>';
}

/* Date-range filter shared by Dashboard, Trips and Expenses. "ytd" is the
   current calendar year so far; a bare year string filters to that year. */
function rangeOptions(rows, dateField) {
  const years = new Set();
  rows.forEach((r) => {
    const y = String(r[dateField] || '').slice(0, 4);
    if (/^\d{4}$/.test(y)) years.add(y);
  });
  const sorted = Array.from(years).sort().reverse();
  return [['all', 'All time'], ['ytd', 'Year to date']].concat(sorted.map((y) => [y, y]));
}

function inRange(dateStr, range) {
  if (range === 'all') return true;
  const y = String(dateStr || '').slice(0, 4);
  if (range === 'ytd') return y === String(new Date().getFullYear());
  return y === range;
}

const TRIP_PURPOSES = [
  'Client visit', 'Trade show', 'Sales call', 'Training/conference', 'Vendor visit', 'Other'
];

const EXPENSE_STATUSES = [
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['reimbursed', 'Reimbursed']
];

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function fmtMoney(n) {
  n = Number(n) || 0;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  const parts = String(d).split('-');
  if (parts.length !== 3) return esc(d);
  const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  if (isNaN(dt.getTime())) return esc(d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function today() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + mm + '-' + dd;
}

function labelOf(pairs, val) {
  const hit = pairs.find((p) => p[0] === val);
  return hit ? hit[1] : val;
}

function statusClass(status) {
  // Expense statuses
  if (status === 'approved' || status === 'reimbursed') return 'ok';
  if (status === 'rejected') return 'bad';
  // Trip statuses
  if (status === 'attended') return 'ok';
  if (status === 'confirmed') return 'info';
  if (status === 'did_not_attend' || status === 'cancelled') return 'bad';
  if (status === 'potential') return 'warn';
  return 'muted';
}

// Small line icons for the trip cards. currentColor so they follow
// .trip-meta's --muted text color without a token of their own.
const ICON_PIN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>';
const ICON_CALENDAR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';
const ICON_PEOPLE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>';

// Two-segment donut for the dashboard's spend-vs-redeemed comparison.
// segments: [{ value, varName }] — varName is a CSS custom property name
// (e.g. 'accent'), never a raw hex, so this stays token-driven.
function donutSVG(segments) {
  const total = segments.reduce((s, p) => s + p.value, 0) || 1;
  const r = 46, C = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments.map((p) => {
    const len = Math.max(0, (p.value / total) * C);
    const arc = `<circle cx="60" cy="60" r="${r}" fill="none" stroke-width="16" style="stroke:var(--${p.varName})" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"/>`;
    offset += len;
    return arc;
  }).join('');
  return `<svg width="120" height="120" viewBox="0 0 120 120">${arcs}</svg>`;
}

/* ------------------------------------------------------------------ *
 * CHARTS
 *
 * Hand-rolled SVG rather than a charting library: the shell has no build
 * step and one real dependency, and these are four simple shapes. Every
 * color is a CSS custom property name, never a hex — css/tokens.css owns
 * color, and the test suite enforces it.
 * ------------------------------------------------------------------ */

// Rotating series palette. Distinct hues that already exist as tokens.
const CHART_HUES = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8', 'chart-9'];

function hueAt(i) {
  return CHART_HUES[i % CHART_HUES.length];
}

/**
 * Donut + legend. entries = [[label, value], ...].
 * opts.hueFor(label, i) picks a token name, so the category chart can
 * reuse the same hue as that category's icon in the expense list.
 */
function donutChart(entries, opts) {
  const { money = true, empty = 'Nothing to show yet.', hueFor } = opts || {};
  const rows = entries.filter((e) => Number(e[1]) > 0);
  if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;

  const total = rows.reduce((s, e) => s + Number(e[1]), 0);
  const segs = rows.map(([label, value], i) => ({
    label, value: Number(value),
    varName: hueFor ? hueFor(label, i) : hueAt(i)
  }));

  const fmt = (v) => (money ? fmtMoney(v) : String(v));
  return `
    <div class="donut-wrap">
      ${donutSVG(segs)}
      <div class="donut-legend">
        ${segs.map((s) => `
          <div class="row">
            <span class="sw" style="background:var(--${s.varName})"></span>
            <span>${esc(s.label)}</span>
            <span class="amt">${fmt(s.value)}</span>
            <span class="pct">${Math.round((s.value / total) * 100)}%</span>
          </div>`).join('')}
      </div>
    </div>`;
}

/**
 * Single-series area/line chart. points = [[label, value], ...] in order.
 * Labels are thinned so a 12-month axis stays readable at card width.
 */
function lineChart(points, opts) {
  const { money = true, empty = 'Nothing to show yet.', hue = 'accent' } = opts || {};
  if (!points.length) return `<div class="empty">${esc(empty)}</div>`;
  if (points.length === 1) {
    return `<div class="chart-single">${esc(points[0][0])}<span>${money ? fmtMoney(points[0][1]) : points[0][1]}</span></div>`;
  }

  const W = 560, H = 200, padL = 52, padR = 12, padT = 14, padB = 28;
  const max = Math.max(...points.map((p) => Number(p[1]) || 0)) || 1;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v) => padT + innerH - ((Number(v) || 0) / max) * innerH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

  // Four horizontal gridlines with value labels.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f;
    const yy = y(v);
    return `<line class="grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"/>
            <text class="axis" x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${money ? fmtMoneyShort(v) : Math.round(v)}</text>`;
  }).join('');

  const step = Math.ceil(points.length / 7);
  const xLabels = points.map((p, i) =>
    (i % step === 0 || i === points.length - 1)
      ? `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p[0])}</text>`
      : '').join('');

  const dots = points.map((p, i) =>
    `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="3" style="fill:var(--${hue})"><title>${esc(p[0])}: ${money ? fmtMoney(p[1]) : p[1]}</title></circle>`).join('');

  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${ticks}
        <path d="${area}" style="fill:var(--${hue});opacity:.10"/>
        <path d="${line}" fill="none" style="stroke:var(--${hue})" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${xLabels}
      </svg>
    </div>`;
}

/**
 * Multi-series line chart on a shared x axis (year-over-year).
 * series = [{ name, points: [[label, value], ...] }, ...]; every series is
 * expected to share the same label sequence.
 */
function multiLineChart(series, opts) {
  const { money = true, empty = 'Nothing to show yet.' } = opts || {};
  const live = series.filter((s) => s.points.some((p) => Number(p[1]) > 0));
  if (!live.length) return `<div class="empty">${esc(empty)}</div>`;

  const labels = live[0].points.map((p) => p[0]);
  const W = 560, H = 210, padL = 52, padR = 12, padT = 14, padB = 40;
  const max = Math.max(...live.flatMap((s) => s.points.map((p) => Number(p[1]) || 0))) || 1;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const x = (i) => padL + (labels.length === 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
  const y = (v) => padT + innerH - ((Number(v) || 0) / max) * innerH;

  const ticks = [0, 0.5, 1].map((f) => {
    const yy = y(max * f);
    return `<line class="grid" x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}"/>
            <text class="axis" x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${money ? fmtMoneyShort(max * f) : Math.round(max * f)}</text>`;
  }).join('');

  const step = Math.ceil(labels.length / 7);
  const xLabels = labels.map((l, i) =>
    (i % step === 0 || i === labels.length - 1)
      ? `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="middle">${esc(l)}</text>`
      : '').join('');

  const paths = live.map((s, si) => {
    const hue = hueAt(si);
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ');
    const dots = s.points.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="2.5" style="fill:var(--${hue})"><title>${esc(s.name)} ${esc(p[0])}: ${money ? fmtMoney(p[1]) : p[1]}</title></circle>`).join('');
    return `<path d="${d}" fill="none" style="stroke:var(--${hue})" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join('');

  const legend = live.map((s, si) =>
    `<span class="ck"><span class="sw" style="background:var(--${hueAt(si)})"></span>${esc(s.name)}</span>`).join('');

  return `
    <div class="chart">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${ticks}${paths}${xLabels}
      </svg>
      <div class="chart-legend">${legend}</div>
    </div>`;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-03" -> "Mar 26". Kept short so a 12-point axis fits at card width.
function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) return String(ym || '');
  return MONTH_ABBR[Number(m[2]) - 1] + ' ' + m[1].slice(2);
}

function fmtMoneyShort(n) {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1000) return '$' + Math.round(n / 1000) + 'k';
  return '$' + Math.round(n);
}

function downloadCSV(filename, rows) {
  const csv = rows.map((row) => row.map((cell) => {
    const s = String(cell == null ? '' : cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * IMPORT — bringing trips over from the standalone Base44 export.
 *
 * That export is TRIP-centric with a shared budget across every attendee
 * (Travel/Lodging/Event/Onsite Travel/Food Budget columns, one Total Spent,
 * one Miles Redeemed, one Net Cost per trip). This app's data model is
 * PERSON-centric (one traveler per trip, itemized expenses per person),
 * so an import is a lossy translation, not a straight copy:
 *   - Multiple attendees -> the trip is attributed to the FIRST listed
 *     person; everyone else is named in the trip's notes, not modeled
 *     as their own trip or expense.
 *   - The five budget columns + Total Spent collapse into ONE "Other"
 *     expense per trip (the budget breakdown survives as free text in
 *     the expense description, not as separate line items).
 *   - Since every row is a trip that already happened, the expense is
 *     created and immediately marked "reimbursed" rather than "pending"
 *     — there is no live approval to do on a closed historical trip.
 * ------------------------------------------------------------------ */

function parseCSV(text) {
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { pushField(); pushRow(); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx].trim() : ''; });
      return obj;
    });
}

// The standalone's two statuses map straight onto two of ours now that the
// status set matches how the shop actually talks about a trip. "Did Not
// Attend" is its own status here rather than being flattened to cancelled.
const IMPORT_STATUS_MAP = { 'attended': 'attended', 'did not attend': 'did_not_attend' };
const IMPORT_BUDGET_COLS = ['Travel Budget', 'Lodging Budget', 'Event Budget', 'Onsite Travel Budget', 'Food Budget'];

// The standalone's exports come in two shapes, and this importer detects and
// handles either one:
//   "summary" — one row per trip: Trip Name, Attendees, five budget columns,
//     one Total Spent. Collapses to one "Other" expense per trip.
//   "detailed" — flat Type=Trip/Expense rows (Category, Amount, Trip /
//     Project, Payment Method, Status, Notes per line item). Far better
//     fidelity: real categories, real Pending/Approved status, itemized
//     amounts — used whenever it's available.
// "detailed" rows lack a trip's End Date and Attendees (only a single Date
// and a Created By column), so those two fields default to Start Date and
// "Unknown" and are left EDITABLE in the preview table below, rather than
// guessed at silently.

const IMPORT_CATEGORY_MAP = {
  hotels: 'Lodging', flights: 'Airfare', registration: 'Registration/Fees',
  meals: 'Meals', other: 'Other', entertainment: 'Other'
};

function categorizeTransport(name, notes) {
  const s = (String(name || '') + ' ' + String(notes || '')).toLowerCase();
  if (/park/.test(s)) return 'Parking & Tolls';
  if (/uber|lyft|taxi|cab/.test(s)) return 'Rideshare/Taxi';
  if (/rental|hertz|avis|enterprise/.test(s)) return 'Rental Car';
  return 'Rideshare/Taxi';
}

function tripKeyOf(title) {
  return String(title || '').trim().toLowerCase();
}

function buildDetailedPlan(rows) {
  const trips = [];
  const expenses = [];
  rows.forEach((row) => {
    const type = String(row['Type'] || '').trim().toLowerCase();
    if (type === 'trip') {
      const title = String(row['Name'] || '').trim() || 'Imported trip';
      const status = IMPORT_STATUS_MAP[String(row['Status'] || '').trim().toLowerCase()] || 'attended';
      const startDate = String(row['Date'] || '').trim();
      const traveler = String(row['Created By'] || '').trim() || 'Unknown';
      trips.push({
        key: tripKeyOf(title), title, destination: String(row['Destination'] || '').trim(),
        purpose: 'Other', start_date: startDate, end_date: startDate, status,
        notes: 'Imported from the standalone TravelTrack export.',
        traveler, traveler_name: traveler,
        // The detailed export carries only Created By, not the full
        // attendee list, so this seeds one name; the import preview lets
        // it be corrected before anything is written.
        attendees: traveler && traveler !== 'Unknown' ? [traveler] : [],
        miles_value: Number(row['Miles Redeemed']) || 0
      });
    } else if (type === 'expense') {
      const tripTitle = String(row['Trip / Project'] || '').trim();
      const sourceCat = String(row['Category'] || '').trim().toLowerCase();
      const category = sourceCat === 'transport'
        ? categorizeTransport(row['Name'], row['Notes'])
        : (IMPORT_CATEGORY_MAP[sourceCat] || 'Other');
      const name = String(row['Name'] || '').trim();
      const notes = String(row['Notes'] || '').trim();
      const paymentMethod = String(row['Payment Method'] || '').trim().toLowerCase() === 'company card' ? 'company_card' : 'personal_reimburse';
      const srcStatus = String(row['Status'] || '').trim().toLowerCase();
      const finalStatus = srcStatus === 'approved' ? 'approved' : (srcStatus === 'rejected' ? 'rejected' : 'pending');
      expenses.push({
        tripKey: tripKeyOf(tripTitle), tripTitleForDisplay: tripTitle || '(no trip)',
        date: String(row['Date'] || '').trim(), category,
        amount: Number(row['Amount']) || 0, payment_method: paymentMethod,
        description: notes ? (name ? name + ' — ' + notes : notes) : (name || 'Imported expense'),
        finalStatus
      });
    }
  });
  return { trips, expenses };
}

function buildSummaryPlan(rows) {
  const trips = [];
  const expenses = [];
  rows.forEach((row) => {
    const attendees = String(row['Attendees'] || '').split(';').map((s) => s.trim()).filter(Boolean);
    const primary = attendees[0] || 'Unknown';
    const status = IMPORT_STATUS_MAP[String(row['Status'] || '').trim().toLowerCase()] || 'attended';

    const budgetParts = [];
    IMPORT_BUDGET_COLS.forEach((k) => {
      const v = Number(row[k]);
      if (v) budgetParts.push(k.replace(' Budget', '') + ' ' + fmtMoney(v));
    });
    const miles = Number(row['Miles Redeemed']) || 0;
    const totalSpent = Number(row['Total Spent']) || 0;
    const netCost = Number(row['Net Cost']);
    const startDate = String(row['Start Date'] || '').trim();
    const endDate = String(row['End Date'] || '').trim() || startDate;
    const title = String(row['Trip Name'] || '').trim() || 'Imported trip';

    const notesLines = [];
    if (attendees.length > 1) notesLines.push('Attendees: ' + attendees.join(', '));
    if (budgetParts.length) notesLines.push('Budget — ' + budgetParts.join(', '));
    if (miles) notesLines.push('Miles redeemed: ' + miles.toLocaleString());
    notesLines.push('Imported from the standalone TravelTrack export.');

    trips.push({
      key: tripKeyOf(title), title, destination: String(row['Destination'] || '').trim(),
      purpose: 'Other', start_date: startDate, end_date: endDate, status,
      notes: notesLines.join('\n'), traveler: primary, traveler_name: primary,
      attendees: attendees.slice(),
      miles_value: miles
    });

    if (totalSpent > 0) {
      let desc = 'Historical import';
      if (budgetParts.length) desc += ' — ' + budgetParts.join(', ');
      if (miles) desc += '. Miles redeemed: ' + miles.toLocaleString() + '.';
      if (!Number.isNaN(netCost) && netCost !== totalSpent) desc += ' Net cost after miles: ' + fmtMoney(netCost) + '.';
      expenses.push({
        tripKey: tripKeyOf(title), tripTitleForDisplay: title, date: endDate || startDate,
        category: 'Other', amount: totalSpent, payment_method: 'company_card',
        description: desc, finalStatus: 'reimbursed'
      });
    }
  });
  return { trips, expenses };
}

function buildImportPlan(rows) {
  if (!rows.length) return { trips: [], expenses: [], format: 'empty' };
  const keys = Object.keys(rows[0]);
  if (keys.includes('Type') && keys.includes('Category')) {
    return Object.assign({ format: 'detailed' }, buildDetailedPlan(rows));
  }
  if (keys.includes('Trip Name')) {
    return Object.assign({ format: 'summary' }, buildSummaryPlan(rows));
  }
  return { trips: [], expenses: [], format: 'unknown' };
}

export default {
  id: 'traveltrack',

  styles: `
  .page{padding:24px 32px 60px;max-width:1720px}
  .page-hd{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;flex-wrap:wrap;gap:12px}
  .page-hd h1{font-size:28px;font-weight:800;letter-spacing:-.02em}
  .page-hd .sub{font-size:13px;color:var(--muted);margin-top:2px}
  .tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .btn{
    background:var(--accent);border:1px solid var(--accent);color:var(--on-accent);
    border-radius:var(--radius-sm);padding:8px 16px;font-size:13px;font-weight:700;
    cursor:pointer;font-family:inherit;transition:.12s;
  }
  .btn:hover{opacity:.92}
  .btn.ghost{background:var(--card);color:var(--ink);border-color:var(--line)}
  .btn.ghost:hover{border-color:var(--faint)}
  .btn.danger{background:var(--danger);border-color:var(--danger)}
  .btn:disabled{opacity:.5;cursor:default}
  .btn-sm{padding:5px 11px;font-size:12px;border-radius:var(--radius-sm)}

  /* ---------- KPI strip ---------- */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:16px 18px}
  .kpi .v{font-size:24px;font-weight:800;letter-spacing:-.02em}
  .kpi .l{font-size:12px;color:var(--muted);margin-top:3px;font-weight:600}

  /* ---------- filters ---------- */
  .filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
  .filt{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    padding:6px 13px;font-size:12.5px;font-weight:600;color:var(--muted);
    cursor:pointer;font-family:inherit;transition:.12s;
  }
  .filt:hover{color:var(--ink)}
  .filt[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}

  /* ---------- tables ---------- */
  .tbl-wrap{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{
    text-align:left;padding:11px 16px;font-size:11px;font-weight:700;text-transform:uppercase;
    letter-spacing:.04em;color:var(--muted);background:var(--head-bg);border-bottom:1px solid var(--line);
  }
  tbody td{padding:12px 16px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  tbody tr.clickable{cursor:pointer}
  tbody tr.clickable:hover{background:var(--row-hover)}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .empty{padding:48px 24px;text-align:center;color:var(--muted)}
  .empty h3{font-size:15px;font-weight:700;color:var(--ink);margin-bottom:4px}

  /* ---------- chips ---------- */
  .chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:99px;font-size:11.5px;font-weight:700}
  .chip.ok{background:var(--success-tint);color:var(--success)}
  .chip.bad{background:var(--danger-tint);color:var(--danger)}
  .chip.muted{background:var(--line-soft);color:var(--muted)}
  .chip.gold{background:var(--accent-tint);color:var(--accent-deep)}
  .chip.info{background:var(--hue-blue-tint);color:var(--hue-blue-deep)}
  .chip.warn{background:var(--warn-tint);color:var(--warn)}

  /* ---------- category icons ---------- */
  .cat-icon{
    display:inline-flex;align-items:center;justify-content:center;
    width:28px;height:28px;flex:0 0 28px;border-radius:var(--radius-sm);
    color:var(--cat);
    /* The chart palette has no paired tint token, so the soft background is
       derived from the same colour. color-mix keeps that in CSS rather than
       hardcoding nine more hex values. */
    background:color-mix(in srgb, var(--cat) 13%, var(--card));
  }
  .cat-cell{display:flex;align-items:center;gap:9px}

  /* ---------- inline status select (change without opening the trip) ---------- */
  .status-select{
    -webkit-appearance:none;appearance:none;border:1px solid transparent;
    border-radius:99px;padding:3px 22px 3px 10px;font-size:11.5px;font-weight:700;
    font-family:inherit;cursor:pointer;
    background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
    background-position:calc(100% - 11px) 52%,calc(100% - 7px) 52%;
    background-size:4px 4px,4px 4px;background-repeat:no-repeat;
  }
  .status-select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .status-select.ok{background-color:var(--success-tint);color:var(--success)}
  .status-select.bad{background-color:var(--danger-tint);color:var(--danger)}
  .status-select.info{background-color:var(--hue-blue-tint);color:var(--hue-blue-deep)}
  .status-select.warn{background-color:var(--warn-tint);color:var(--warn)}
  .status-select.muted{background-color:var(--line-soft);color:var(--muted)}

  /* ---------- typeahead ---------- */
  .ta{position:relative}
  .ta-menu{
    position:absolute;left:0;right:0;top:100%;z-index:30;margin-top:3px;
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    box-shadow:var(--shadow-pop);max-height:220px;overflow-y:auto;
  }
  .ta-menu[hidden]{display:none}
  .ta-opt{padding:8px 11px;font-size:13px;cursor:pointer}
  .ta-opt:hover,.ta-opt.active{background:var(--accent-tint);color:var(--accent-deep)}
  .ta-empty{padding:8px 11px;font-size:12.5px;color:var(--muted)}
  .ta-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
  .ta-chip{
    display:inline-flex;align-items:center;gap:5px;padding:3px 6px 3px 10px;
    border-radius:99px;background:var(--accent-tint);color:var(--accent-deep);
    font-size:12px;font-weight:600;
  }
  .ta-chip button{
    background:none;border:none;color:inherit;cursor:pointer;font-size:14px;
    line-height:1;padding:0 2px;opacity:.7;font-family:inherit;
  }
  .ta-chip button:hover{opacity:1}

  /* ---------- dashboard grid ---------- */
  .dash-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px;align-items:start}
  .dash-grid .card.wide{grid-column:1/-1}
  .dash-customize{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);
    padding:16px 18px;margin-bottom:16px;
  }
  .dash-customize h3{font-size:14px;font-weight:700;margin-bottom:4px}
  .dash-customize .hint{font-size:12px;color:var(--muted);margin-bottom:12px}
  .dash-toggles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px}
  .dash-toggle{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
  .dash-toggle input{width:15px;height:15px;accent-color:var(--accent);cursor:pointer}

  /* ---------- receipt ---------- */
  .receipt-box{border:1px dashed var(--line);border-radius:var(--radius-sm);padding:12px;text-align:center}
  .receipt-box img{max-width:100%;max-height:190px;border-radius:var(--radius-sm);display:block;margin:0 auto 9px}
  .receipt-hint{font-size:11.5px;color:var(--muted);margin-top:6px}
  .receipt-busy{font-size:12.5px;color:var(--accent-deep);font-weight:600}

  /* ---------- dashboard ---------- */
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media (max-width:900px){.grid2{grid-template-columns:1fr}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);overflow:hidden}
  .card-hd{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}
  .card-hd h3{font-size:14px;font-weight:700}
  .card-hd .meta{font-size:11.5px;color:var(--muted)}
  .card-bd{padding:6px 0}
  .mini-row{display:flex;justify-content:space-between;align-items:center;padding:10px 18px;border-bottom:1px solid var(--line-soft)}
  .mini-row:last-child{border-bottom:none}
  .mini-row .t{font-size:13px;font-weight:600}
  .mini-row .s{font-size:11.5px;color:var(--muted);margin-top:1px}

  /* ---------- report bars ---------- */
  .bar-row{padding:10px 18px}
  .bar-row .top{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px}
  .bar-row .top .lab{font-weight:600}
  .bar-track{height:7px;border-radius:99px;background:var(--line-soft);overflow:hidden}
  .bar-fill{height:100%;background:var(--accent);border-radius:99px}

  /* ---------- panel (create/edit) ---------- */
  .scrim{
    position:fixed;top:var(--shell-header-h);right:0;bottom:0;left:0;
    background:rgba(28,36,48,.32);opacity:0;pointer-events:none;transition:opacity .18s;z-index:110;
  }
  .scrim.open{opacity:1;pointer-events:auto}
  .panel{
    position:fixed;top:var(--shell-header-h);right:0;bottom:0;width:min(520px,100%);
    background:var(--bg);z-index:120;overflow-y:auto;
    transform:translateX(100%);transition:transform .22s cubic-bezier(.4,0,.2,1);
    box-shadow:-14px 0 40px rgba(16,24,40,.13);
  }
  .panel.open{transform:none}
  .panel-in{padding:20px 24px 40px}
  .panel-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:0 0 16px}
  .panel-top h2{font-size:20px;font-weight:800;letter-spacing:-.02em}
  .panel-top .sub{font-size:12px;color:var(--muted);margin-top:2px}
  .x{
    background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);
    width:30px;height:30px;flex:0 0 30px;cursor:pointer;font-size:15px;color:var(--muted);font-family:inherit;
  }
  .x:hover{color:var(--ink)}

  .field{margin-bottom:14px}
  .field label{display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:5px}
  .field input, .field select, .field textarea{
    width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:var(--radius-sm);
    font-size:13.5px;font-family:inherit;background:var(--card);color:var(--ink);
  }
  .field input:focus, .field select:focus, .field textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
  .field textarea{resize:vertical;min-height:64px}
  .field-row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .field .hint{font-size:11.5px;color:var(--muted);margin-top:4px}
  .form-actions{display:flex;gap:8px;margin-top:18px}
  .form-err{background:var(--danger-tint);color:var(--danger);border-radius:var(--radius-sm);padding:9px 12px;font-size:12.5px;margin-bottom:12px}

  .detail-line{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--line-soft);font-size:13px}
  .detail-line .k{color:var(--muted)}
  .detail-line .v{font-weight:600;text-align:right}
  .section-hd{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:20px 0 8px}

  /* ---------- redeem miles ---------- */
  .redeem-form{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:20px;max-width:460px;margin-bottom:22px}
  .redeem-list-row{display:flex;justify-content:space-between;align-items:center;padding:11px 16px;border-bottom:1px solid var(--line-soft)}
  .redeem-list-row:last-child{border-bottom:none}
  .redeem-list-row .t{font-size:13px;font-weight:600}
  .redeem-list-row .s{font-size:11.5px;color:var(--muted);margin-top:1px}
  .redeem-list-row .v{font-weight:700;font-variant-numeric:tabular-nums}

  /* ---------- donut ---------- */
  .donut-wrap{display:flex;align-items:center;gap:20px;padding:14px 18px;flex-wrap:wrap}
  .donut-legend{display:flex;flex-direction:column;gap:8px;font-size:12.5px;flex:1 1 190px;min-width:0}
  .donut-legend .row{display:flex;align-items:center;gap:7px}
  .donut-legend .sw{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
  .donut-legend .sw.spend{background:var(--accent)}
  .donut-legend .sw.miles{background:var(--success)}
  .donut-legend .amt{font-weight:700;margin-left:auto;white-space:nowrap}
  .donut-legend .pct{color:var(--muted);font-size:11.5px;width:34px;text-align:right;flex:0 0 auto}

  /* ---------- line / area charts ---------- */
  .chart{padding:10px 14px 4px}
  .chart svg{width:100%;height:auto;display:block;overflow:visible}
  .chart .grid{stroke:var(--line);stroke-width:1}
  .chart .axis{fill:var(--muted);font-size:10px;font-family:var(--font)}
  .chart .dot{stroke:var(--card);stroke-width:1.5}
  .chart-legend{display:flex;gap:14px;flex-wrap:wrap;padding:4px 4px 8px;font-size:12px;color:var(--muted)}
  .chart-legend .ck{display:inline-flex;align-items:center;gap:6px}
  .chart-legend .sw{width:10px;height:10px;border-radius:3px;display:inline-block}
  .chart-single{padding:22px 18px;font-size:13px;color:var(--muted);display:flex;justify-content:space-between}
  .chart-single span{font-weight:700;color:var(--ink)}

  /* ---------- trip cards ---------- */
  .trip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
  .trip-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;cursor:pointer;transition:.12s}
  .trip-card:hover{border-color:var(--faint);box-shadow:var(--shadow-card)}
  .trip-card-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px}
  .trip-card-hd h3{font-size:16px;font-weight:700;letter-spacing:-.01em;line-height:1.3}
  .trip-meta{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);margin-bottom:5px}
  .trip-meta svg{flex:0 0 auto;opacity:.7}
  .trip-figures{margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)}
  .figure-row{display:flex;justify-content:space-between;font-size:13px;padding:3px 0}
  .figure-row .k{color:var(--muted)}
  .figure-row .v{font-weight:600;font-variant-numeric:tabular-nums}
  .figure-row.net .k, .figure-row.net .v{font-weight:700;color:var(--ink)}
  .figure-row .miles-credit{color:var(--success)}
  .trip-card .bar-track{margin:4px 0 8px}

  /* ---------- settings ---------- */
  .settings-wrap{max-width:640px}
  .settings-note{font-size:12.5px;color:var(--muted);background:var(--line-soft);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:16px}
  `,

  template: `
    <div class="page" id="ttDash">
      <div class="page-hd">
        <div>
          <h1>Dashboard.</h1>
          <div class="sub" id="dashSub"></div>
        </div>
        <div class="tools">
          <select class="filt" id="dashRange" style="cursor:pointer"></select>
          <button class="btn ghost" id="dashCustomize">Customize</button>
          <button class="btn ghost" id="dashNewTrip">+ New trip</button>
          <button class="btn ghost" id="dashLogMiles">+ Log miles</button>
          <button class="btn" id="dashNewExpense">+ New expense</button>
        </div>
      </div>
      <div class="kpis" id="dashKpis"></div>
      <div id="dashCustomizePanel" hidden></div>
      <div class="dash-grid" id="dashCards"></div>
    </div>

    <div class="page" id="ttTrips" hidden>
      <div class="page-hd">
        <div><h1>Trips.</h1><div class="sub" id="tripsSub"></div></div>
        <div class="tools">
          <button class="btn ghost" id="tripsExportBtn">Export CSV</button>
          <button class="btn" id="tripsNewBtn">+ New trip</button>
        </div>
      </div>
      <div class="kpis" id="tripsKpis"></div>
      <div class="filters" id="tripsFilters"></div>
      <div class="trip-grid" id="tripsTbl"></div>
    </div>

    <div class="page" id="ttExpenses" hidden>
      <div class="page-hd">
        <div><h1>Expenses.</h1><div class="sub" id="expSub"></div></div>
        <div class="tools">
          <button class="btn ghost" id="expExportBtn">Export CSV</button>
          <button class="btn" id="expNewBtn">+ New expense</button>
        </div>
      </div>
      <div class="filters" id="expFilters"></div>
      <div class="tbl-wrap"><div id="expTbl"></div></div>
    </div>

    <div class="page" id="ttMiles" hidden>
      <div class="page-hd">
        <div><h1 id="milesTitle">Redeem Miles.</h1><div class="sub" id="milesSub"></div></div>
      </div>
      <div class="redeem-form" id="redeemForm"></div>
      <div class="section-hd">By trip</div>
      <div class="tbl-wrap"><div id="redeemTripList"></div></div>
    </div>

    <div class="page" id="ttReports" hidden>
      <div class="page-hd">
        <div><h1>Reports.</h1><div class="sub" id="reportsSub"></div></div>
        <div class="tools">
          <select class="filt" id="reportsYear" style="cursor:pointer"></select>
          <button class="btn ghost" id="reportsExportBtn">Export CSV</button>
        </div>
      </div>
      <div class="kpis" id="reportsKpis"></div>
      <div class="dash-grid">
        <div class="card">
          <div class="card-hd"><h3>Spend by category</h3></div>
          <div class="card-bd" id="reportsByCat"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3 id="reportsByWhoHd">Spend by month</h3></div>
          <div class="card-bd" id="reportsByWho"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Spend by trip</h3></div>
          <div class="card-bd" id="reportsByTrip"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Payment method</h3></div>
          <div class="card-bd" id="reportsByPayment"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Approval status</h3></div>
          <div class="card-bd" id="reportsByStatus"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3 id="reportsMilesHd">Redeemed by trip</h3></div>
          <div class="card-bd" id="reportsMiles"></div>
        </div>
        <div class="card wide">
          <div class="card-hd"><h3>Monthly trend</h3></div>
          <div class="card-bd" id="reportsTrend"></div>
        </div>
        <div class="card wide">
          <div class="card-hd"><h3>Trip summary</h3><span class="meta" id="reportsTableMeta"></span></div>
          <div class="card-bd"><div id="reportsTable"></div></div>
        </div>
      </div>
    </div>

    <div class="page" id="ttSettings" hidden>
      <div class="page-hd"><div><h1>Settings.</h1><div class="sub">Your travel preferences and shop-wide policy.</div></div></div>
      <div class="settings-wrap">
        <div class="section-hd">Account settings</div>
        <div class="card"><div class="panel-in" id="acctForm"></div></div>
        <div class="section-hd" id="orgHd" hidden>Org settings</div>
        <div class="card" id="orgCard" hidden><div class="panel-in" id="orgForm"></div></div>
        <div class="section-hd" id="importHd" hidden>Import trips</div>
        <div class="card" id="importCard" hidden><div class="panel-in" id="importPanel"></div></div>
      </div>
    </div>

    <div class="scrim" id="ttScrim"></div>
    <aside class="panel" id="ttPanel" aria-label="Form" tabindex="-1"><div class="panel-in" id="ttPanelIn"></div></aside>
  `,

  async mount(ctx) {
    this._root = ctx.root;
    const root = ctx.root;
    const $ = (sel) => root.querySelector(sel);
    const $$ = (sel) => Array.from(root.querySelectorAll(sel));

    const scope = (ctx.perms && ctx.perms.data_scope) || 'own';
    const seesAll = scope === 'all';
    const me = (ctx.user && (ctx.user.username || ctx.user.name)) || '';

    const data = { trips: [], expenses: [], people: [], org: null, account: null, canEditOrg: false };
    const filters = {
      trips: 'active', expenses: 'pending', expensesMine: !seesAll,
      // Date-range filters, independent per view so changing one doesn't
      // silently re-scope another.
      dashRange: 'all', tripsRange: 'all', expensesRange: 'all',
      expenseCategory: 'all',
      expensesByTrip: false
    };
    let reportsYear = new Date().getFullYear();

    async function loadAll() {
      const [tripsRes, expRes, settingsRes] = await Promise.all([
        ctx.api.get(ENDPOINTS.ttTrips),
        ctx.api.get(ENDPOINTS.ttExpenses),
        ctx.api.get(ENDPOINTS.ttSettings)
      ]);
      data.trips = (tripsRes && tripsRes.trips) || [];
      data.expenses = (expRes && expRes.expenses) || [];
      data.org = (settingsRes && settingsRes.org) || { mileage_rate: 0.67, per_diem_rate: 0, approval_threshold: 500, policy_notes: '', redemption_label: 'Miles / Rewards' };
      data.account = (settingsRes && settingsRes.account) || { home_airport: '', default_payment_method: 'personal_reimburse' };
      data.people = (settingsRes && settingsRes.people) || [];
      data.canEditOrg = !!(settingsRes && settingsRes.can_edit_org);
    }

    function tripLabel(id) {
      const t = data.trips.find((x) => x.id === id);
      return t ? t.title : null;
    }

    function expensesForTrip(id) {
      return data.expenses.filter((e) => e.trip_id === id);
    }

    /* Only trips we actually attended count toward spend totals (Ryan's
       rule, and what the standalone did: its header read "Total Spent (11
       trips)" across 12 trips, excluding the Did Not Attend one).
       Money on a trip that didn't happen is still real, so it is never
       hidden — the KPI strip reports it on its own line instead of
       silently folding it into the total. */
    function countsTowardSpend(trip) {
      return trip && normStatus(trip.status) === 'attended';
    }

    // An expense counts if its trip counts. Expenses with no trip attached
    // count too — there's no trip status to disqualify them.
    function expenseCounts(e) {
      if (!e.trip_id) return true;
      const t = data.trips.find((x) => x.id === e.trip_id);
      if (!t) return true;
      return countsTowardSpend(t);
    }

    /* ---------------- panel plumbing (shared by trip/expense/loyalty forms) ---------------- */

    const scrim = $('#ttScrim');
    const panel = $('#ttPanel');
    const panelIn = $('#ttPanelIn');

    function openPanel(html) {
      panelIn.innerHTML = html;
      scrim.classList.add('open');
      panel.classList.add('open');
    }
    function closePanel() {
      scrim.classList.remove('open');
      panel.classList.remove('open');
    }
    scrim.addEventListener('click', closePanel);

    /* ---------------- Typeahead ----------------
       One implementation shared by "pick a trip" (single) and "add team
       members" (multi). Type to filter, click or Enter to choose. Built as
       a plain input + menu rather than a <select> because a select can't be
       typed into past its first letter, which is the whole ask. */

    function buildTypeahead(hostEl, opts) {
      const { options, multi = false, placeholder = '', selected = [], onChange } = opts;
      let chosen = selected.slice();
      let active = -1;

      hostEl.classList.add('ta');
      hostEl.innerHTML = `
        <input type="text" class="ta-input" placeholder="${esc(placeholder)}" autocomplete="off">
        <div class="ta-menu" hidden></div>
        ${multi ? '<div class="ta-chips"></div>' : ''}
      `;
      const input = hostEl.querySelector('.ta-input');
      const menu = hostEl.querySelector('.ta-menu');
      const chips = hostEl.querySelector('.ta-chips');

      const labelFor = (v) => {
        const hit = options.find((o) => o.value === v);
        return hit ? hit.label : v;
      };

      function renderChips() {
        if (!chips) return;
        chips.innerHTML = chosen.map((v) => `
          <span class="ta-chip">${esc(labelFor(v))}<button type="button" data-remove="${esc(v)}" aria-label="Remove">&times;</button></span>
        `).join('');
        chips.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
          chosen = chosen.filter((v) => v !== b.dataset.remove);
          renderChips();
          if (onChange) onChange(chosen);
        }));
      }

      function matches() {
        const q = input.value.trim().toLowerCase();
        return options
          .filter((o) => !multi || !chosen.includes(o.value))
          .filter((o) => !q || o.label.toLowerCase().includes(q))
          .slice(0, 40);
      }

      function renderMenu() {
        const list = matches();
        active = list.length ? 0 : -1;
        if (!list.length) {
          // Multi-select doubles as free entry: the shop's trips include
          // people who may not have a shell login, so an unmatched name is
          // still addable rather than a dead end.
          menu.innerHTML = multi && input.value.trim()
            ? `<div class="ta-opt active" data-add-raw>Add "${esc(input.value.trim())}"</div>`
            : '<div class="ta-empty">No matches</div>';
        } else {
          menu.innerHTML = list.map((o, i) =>
            `<div class="ta-opt${i === 0 ? ' active' : ''}" data-value="${esc(o.value)}">${esc(o.label)}</div>`).join('');
        }
        menu.hidden = false;
        menu.querySelectorAll('[data-value]').forEach((el) => {
          el.addEventListener('mousedown', (e) => { e.preventDefault(); pick(el.dataset.value); });
        });
        const rawEl = menu.querySelector('[data-add-raw]');
        if (rawEl) rawEl.addEventListener('mousedown', (e) => { e.preventDefault(); pick(input.value.trim()); });
      }

      function pick(value) {
        if (!value) return;
        if (multi) {
          if (!chosen.includes(value)) chosen.push(value);
          input.value = '';
          renderChips();
        } else {
          chosen = [value];
          input.value = labelFor(value);
        }
        menu.hidden = true;
        if (onChange) onChange(chosen);
      }

      input.addEventListener('focus', renderMenu);
      input.addEventListener('input', renderMenu);
      input.addEventListener('blur', () => { setTimeout(() => { menu.hidden = true; }, 120); });
      input.addEventListener('keydown', (e) => {
        const opts2 = Array.from(menu.querySelectorAll('.ta-opt'));
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!opts2.length) return;
          active = e.key === 'ArrowDown'
            ? Math.min(active + 1, opts2.length - 1)
            : Math.max(active - 1, 0);
          opts2.forEach((el, i) => el.classList.toggle('active', i === active));
          opts2[active].scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
          if (menu.hidden) return;
          e.preventDefault();
          const el = opts2[active] || opts2[0];
          if (!el) return;
          pick(el.dataset.value !== undefined ? el.dataset.value : input.value.trim());
        } else if (e.key === 'Escape') {
          menu.hidden = true;
        }
      });

      if (!multi && chosen.length) input.value = labelFor(chosen[0]);
      renderChips();

      return {
        value: () => (multi ? chosen.slice() : (chosen[0] || '')),
        set: (v) => { chosen = Array.isArray(v) ? v.slice() : (v ? [v] : []); renderChips(); if (!multi) input.value = chosen[0] ? labelFor(chosen[0]) : ''; }
      };
    }

    /* Known people for the attendee picker: everyone already named on a
       trip, plus the signed-in user. Deliberately not the shell's full user
       list — trips include people without logins, and the picker accepts
       free text anyway. */
    function knownPeople() {
      // The server merges shell accounts, the org's extra roster, and every
      // name already on a trip (api/traveltrack/settings.js). Fall back to
      // deriving it locally if that list didn't come through, so the picker
      // is never empty.
      const set = new Set(data.people || []);
      if (!set.size) {
        data.trips.forEach((t) => {
          (t.attendees || []).forEach((n) => { if (n) set.add(n); });
          if (t.traveler_name) set.add(t.traveler_name);
        });
      }
      if (ctx.user && ctx.user.name) set.add(ctx.user.name);
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    }

    /* ---------------- Trip form/detail ---------------- */

    function tripFormHtml(trip) {
      const isEdit = !!trip;
      const t = trip || { title: '', destination: '', purpose: 'Client visit', start_date: today(), end_date: today(), status: 'potential', notes: '', miles_value: 0, attendees: [] };
      return `
        <div class="panel-top">
          <div><h2>${isEdit ? 'Edit trip' : 'New trip'}</h2><div class="sub">${isEdit ? esc(t.id) : 'Plan a trip'}</div></div>
          <button class="x" data-close>&times;</button>
        </div>
        <div id="tripFormErr"></div>
        <form id="tripForm">
          <div class="field"><label>Title</label><input name="title" value="${esc(t.title)}" placeholder="NSPRA Conference — Chicago" required></div>
          <div class="field"><label>Destination</label><input name="destination" value="${esc(t.destination)}" placeholder="Chicago, IL" required></div>
          <div class="field-row">
            <div class="field"><label>Start date</label><input type="date" name="start_date" value="${esc(t.start_date)}" required></div>
            <div class="field"><label>End date</label><input type="date" name="end_date" value="${esc(t.end_date)}" required></div>
          </div>
          <div class="field-row">
            <div class="field"><label>Purpose</label><select name="purpose">${TRIP_PURPOSES.map((p) => `<option value="${esc(p)}"${p === t.purpose ? ' selected' : ''}>${esc(p)}</option>`).join('')}</select></div>
            <div class="field"><label>Status</label><select name="status">${TRIP_STATUSES.map(([v, l]) => `<option value="${v}"${v === normStatus(t.status) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Team members</label><div id="tripAttendees"></div>
            <div class="hint">Type to search. A name that isn't on the list yet can be added as typed.</div>
          </div>
          <div class="field"><label>${esc(redeemLabel())} (dollar credit)</label><input type="number" step="0.01" min="0" name="miles_value" value="${esc(t.miles_value || 0)}" style="max-width:160px">
            <div class="hint">Nets against Total Spent as Net Cost, same as the standalone app's Miles Redeemed figure.</div>
          </div>
          <div class="field"><label>Notes</label><textarea name="notes" placeholder="Optional">${esc(t.notes || '')}</textarea></div>
          <div class="form-actions">
            <button type="submit" class="btn">${isEdit ? 'Save trip' : 'Create trip'}</button>
            <button type="button" class="btn ghost" data-close>Cancel</button>
            ${isEdit ? '<button type="button" class="btn danger" id="tripDeleteBtn" style="margin-left:auto">Delete</button>' : ''}
          </div>
        </form>
        ${isEdit ? tripExpensesHtml(t) : ''}
      `;
    }

    function tripExpensesHtml(t) {
      const linked = expensesForTrip(t.id);
      if (!linked.length) return '';
      const total = linked.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      return `
        <div class="section-hd">Expenses on this trip (${fmtMoney(total)})</div>
        <div class="tbl-wrap">
          <table>
            <tbody>
              ${linked.map((e) => `
                <tr><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td class="num">${fmtMoney(e.amount)}</td>
                <td><span class="chip ${statusClass(e.status)}">${esc(labelOf(EXPENSE_STATUSES, e.status))}</span></td></tr>
              `).join('')}
            </tbody>
          </table>
        </div>`;
    }

    function openTripPanel(trip) {
      openPanel(tripFormHtml(trip));
      const form = panelIn.querySelector('#tripForm');
      panelIn.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));

      const people = knownPeople();
      const attendeePicker = buildTypeahead(panelIn.querySelector('#tripAttendees'), {
        options: people.map((n) => ({ value: n, label: n })),
        multi: true,
        placeholder: 'Search team members...',
        selected: (trip && trip.attendees) || []
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = Object.fromEntries(fd.entries());
        body.attendees = attendeePicker.value();
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          if (trip) {
            await ctx.api.request(ENDPOINTS.ttTrips + '?id=' + encodeURIComponent(trip.id), { method: 'PATCH', body });
          } else {
            await ctx.api.post(ENDPOINTS.ttTrips, body);
          }
          await loadAll();
          closePanel();
          renderTrips();
          renderDashboard();
        } catch (err) {
          panelIn.querySelector('#tripFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not save trip')}</div>`;
          submitBtn.disabled = false;
        }
      });

      const delBtn = panelIn.querySelector('#tripDeleteBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this trip? Expenses already logged against it are not deleted.')) return;
          try {
            await ctx.api.request(ENDPOINTS.ttTrips + '?id=' + encodeURIComponent(trip.id), { method: 'DELETE' });
            await loadAll();
            closePanel();
            renderTrips();
            renderDashboard();
          } catch (err) {
            panelIn.querySelector('#tripFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not delete trip')}</div>`;
          }
        });
      }
    }

    /* ---------------- Expense form/detail ---------------- */

    function expenseFormHtml(exp, prefillTripId) {
      const isEdit = !!exp;
      const e = exp || {
        trip_id: prefillTripId || '', date: today(), category: EXPENSE_CATEGORIES[0],
        amount: '', miles: '', payment_method: data.account.default_payment_method || 'personal_reimburse', description: ''
      };
      const isMileage = e.category === MILEAGE_CATEGORY;
      const canApprove = seesAll && (!ctx.perms || ctx.perms.can_edit !== false);
      const readOnly = isEdit && !canApprove && exp.status !== 'pending';

      return `
        <div class="panel-top">
          <div><h2>${isEdit ? 'Expense' : 'New expense'}</h2><div class="sub">${isEdit ? esc(exp.id) + ' · ' + esc(labelOf(EXPENSE_STATUSES, exp.status)) : 'Log a cost'}</div></div>
          <button class="x" data-close>&times;</button>
        </div>
        <div id="expFormErr"></div>
        <form id="expForm">
          <div class="field"><label>Trip (optional)</label>
            <select name="trip_id">
              <option value="">— No trip —</option>
              ${data.trips.filter((t) => seesAll || t.traveler === me).map((t) => `<option value="${esc(t.id)}"${t.id === e.trip_id ? ' selected' : ''}>${esc(t.title)}</option>`).join('')}
            </select>
          </div>
          <div class="field-row">
            <div class="field"><label>Date</label><input type="date" name="date" value="${esc(e.date)}" ${readOnly ? 'disabled' : ''} required></div>
            <div class="field"><label>Category</label>
              <select name="category" id="expCategory" ${readOnly ? 'disabled' : ''}>
                ${EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c)}"${c === e.category ? ' selected' : ''}>${esc(c)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="field" id="expMilesField" ${isMileage ? '' : 'hidden'}>
            <label>Miles</label><input type="number" step="0.1" min="0" name="miles" value="${esc(e.miles || '')}" ${readOnly ? 'disabled' : ''}>
            <div class="hint">Reimbursed at ${fmtMoney(data.org.mileage_rate)}/mile — amount is computed.</div>
          </div>
          <div class="field" id="expAmountField" ${isMileage ? 'hidden' : ''}>
            <label>Amount</label><input type="number" step="0.01" min="0" name="amount" value="${esc(e.amount || '')}" ${readOnly ? 'disabled' : ''}>
          </div>
          <div class="field"><label>Payment method</label>
            <select name="payment_method" ${readOnly ? 'disabled' : ''}>
              ${PAYMENT_METHODS.map(([v, l]) => `<option value="${v}"${v === e.payment_method ? ' selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Description</label><textarea name="description" ${readOnly ? 'disabled' : ''} placeholder="What was this for?">${esc(e.description || '')}</textarea></div>
          <div class="field"><label>Receipt</label>
            <div class="receipt-box" id="receiptBox">
              <div id="receiptPreview">${e.receipt_url ? `<img src="${esc(e.receipt_url)}" alt="Receipt">` : ''}</div>
              ${readOnly ? (e.receipt_url ? '' : '<div class="receipt-hint">No receipt attached.</div>') : `
                <input type="file" id="receiptFile" accept="image/*" capture="environment" style="font-size:12px">
                <div class="receipt-hint" id="receiptHint">Take a photo or choose an image. The date, amount, merchant and category are read from it and filled in below for you to check.</div>
              `}
              <input type="hidden" name="receipt_url" id="receiptUrl" value="${esc(e.receipt_url || '')}">
            </div>
          </div>
          ${!readOnly ? `
            <div class="form-actions">
              <button type="submit" class="btn">${isEdit ? 'Save' : 'Submit expense'}</button>
              <button type="button" class="btn ghost" data-close>Cancel</button>
              ${isEdit && (exp.submitted_by === me || canApprove) ? '<button type="button" class="btn danger" id="expDeleteBtn" style="margin-left:auto">Delete</button>' : ''}
            </div>
          ` : ''}
        </form>
        ${isEdit ? expenseDetailHtml(exp, canApprove) : ''}
      `;
    }

    function expenseDetailHtml(exp, canApprove) {
      let lines = `
        <div class="detail-line"><span class="k">Submitted by</span><span class="v">${esc(exp.submitted_by_name || exp.submitted_by)}</span></div>
        ${exp.trip_id ? `<div class="detail-line"><span class="k">Trip</span><span class="v">${esc(tripLabel(exp.trip_id) || exp.trip_id)}</span></div>` : ''}
        ${exp.approved_by ? `<div class="detail-line"><span class="k">Reviewed by</span><span class="v">${esc(exp.approved_by)}</span></div>` : ''}
        ${exp.reimbursed_at ? `<div class="detail-line"><span class="k">Reimbursed</span><span class="v">${fmtDate(exp.reimbursed_at.slice(0, 10))}</span></div>` : ''}
      `;
      if (canApprove) {
        lines += `
          <div class="section-hd">Review</div>
          <div class="form-actions">
            ${exp.status !== 'approved' ? '<button class="btn ghost" data-status="approved">Approve</button>' : ''}
            ${exp.status !== 'rejected' ? '<button class="btn ghost" data-status="rejected">Reject</button>' : ''}
            ${exp.status === 'approved' ? '<button class="btn" data-status="reimbursed">Mark reimbursed</button>' : ''}
            ${exp.status !== 'pending' ? '<button class="btn ghost" data-status="pending">Reopen</button>' : ''}
          </div>
        `;
      }
      return `<div class="section-hd">Detail</div>` + lines;
    }

    // Tells the person who submitted an expense what happened to it — Ryan's
    // ask (Aug 2026): approving, rejecting, or marking reimbursed only
    // updated the record; the submitter had to go check for themselves.
    // Best-effort and silent on failure, same pattern as BackBone's lead/
    // inquiry notifications: a notification hiccup must never block the
    // approve/reject/reimburse action that already succeeded. Skipped when
    // the approver is also the submitter (self-review), and skipped on
    // "pending" (reopening is a correction, not a decision worth a ping).
    async function notifyExpenseStatus(exp, status) {
      const who = String(exp.submitted_by || '').toLowerCase();
      if (!who || who === me.toLowerCase()) return;
      const STATUS_TITLE = {
        approved: 'Expense approved',
        rejected: 'Expense rejected',
        reimbursed: 'Expense reimbursed',
      };
      const verb = STATUS_TITLE[status];
      if (!verb) return;
      try {
        await ctx.api.post(ENDPOINTS.notifications, {
          title: verb + ': ' + fmtMoney(exp.amount) + ' \u2014 ' + (exp.category || 'Expense'),
          types: ['handoff'],
          appIds: ['traveltrack'],
          assignedTo: who,
          link: { type: 'expense', id: exp.id, label: (exp.category || 'Expense') + ' \u2014 ' + fmtMoney(exp.amount) },
        });
      } catch (e) {
        console.warn('Could not create expense status notification:', e);
      }
    }

    function openExpensePanel(exp, prefillTripId) {
      openPanel(expenseFormHtml(exp, prefillTripId));
      panelIn.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));

      const catSel = panelIn.querySelector('#expCategory');
      if (catSel) catSel.addEventListener('change', () => { catSel.dataset.touched = '1'; });

      // ---- Receipt: upload the image, then read it for a prefill --------
      // The two are separate calls on purpose: the upload must stick even
      // if extraction fails (a photo you can look at later beats no photo
      // at all), and extraction never overwrites a field you already typed.
      const fileInput = panelIn.querySelector('#receiptFile');
      if (fileInput) {
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          const hint = panelIn.querySelector('#receiptHint');
          const setHint = (msg, busy) => {
            if (hint) hint.innerHTML = busy ? `<span class="receipt-busy">${esc(msg)}</span>` : esc(msg);
          };

          let dataUrl;
          try {
            dataUrl = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result);
              r.onerror = () => reject(new Error('Could not read that file'));
              r.readAsDataURL(file);
            });
          } catch (err) {
            setHint(err.message, false);
            return;
          }

          panelIn.querySelector('#receiptPreview').innerHTML = `<img src="${dataUrl}" alt="Receipt">`;
          setHint('Uploading...', true);

          try {
            const up = await ctx.api.post(ENDPOINTS.ttReceipt + '?action=upload', {
              data_url: dataUrl, filename: file.name
            });
            if (up && up.url) panelIn.querySelector('#receiptUrl').value = up.url;
          } catch (err) {
            console.error('[traveltrack] receipt upload failed:', err);
            setHint('Could not upload the photo: ' + (err.message || 'unknown error') + '. You can still fill the expense in by hand.', false);
            return;
          }

          setHint('Reading the receipt...', true);
          try {
            const out = await ctx.api.post(ENDPOINTS.ttReceipt + '?action=extract', { data_url: dataUrl });
            const f = (out && out.fields) || {};
            const setIfEmpty = (sel, val) => {
              if (!val) return false;
              const el = panelIn.querySelector(sel);
              if (!el || (el.value && String(el.value).trim())) return false;
              el.value = val;
              return true;
            };
            const filled = [];
            if (setIfEmpty('[name="date"]', f.date)) filled.push('date');
            if (setIfEmpty('[name="amount"]', f.amount)) filled.push('amount');
            if (setIfEmpty('[name="description"]', f.description)) filled.push('merchant');
            if (f.category && catSel && !catSel.dataset.touched) {
              catSel.value = f.category;
              catSel.dispatchEvent(new Event('change'));
              filled.push('category');
            }
            setHint(filled.length
              ? 'Filled in ' + filled.join(', ') + ' from the photo. Check them before submitting.'
              : 'Receipt saved. Nothing could be read from it automatically, so fill the details in by hand.', false);
          } catch (err) {
            console.error('[traveltrack] receipt extract failed:', err);
            setHint('Receipt saved, but it could not be read automatically: ' + (err.message || 'unknown error') + '. Fill the details in by hand.', false);
          }
        });
      }

      if (catSel) {
        catSel.addEventListener('change', () => {
          const isMileage = catSel.value === MILEAGE_CATEGORY;
          panelIn.querySelector('#expMilesField').hidden = !isMileage;
          panelIn.querySelector('#expAmountField').hidden = isMileage;
        });
      }

      const form = panelIn.querySelector('#expForm');
      if (form) {
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          const body = Object.fromEntries(fd.entries());
          if (!body.trip_id) body.trip_id = null;
          const submitBtn = form.querySelector('button[type="submit"]');
          submitBtn.disabled = true;
          try {
            if (exp) {
              await ctx.api.request(ENDPOINTS.ttExpenses + '?id=' + encodeURIComponent(exp.id), { method: 'PATCH', body });
            } else {
              await ctx.api.post(ENDPOINTS.ttExpenses, body);
            }
            await loadAll();
            closePanel();
            renderExpenses();
            renderDashboard();
          } catch (err) {
            panelIn.querySelector('#expFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not save expense')}</div>`;
            submitBtn.disabled = false;
          }
        });
      }

      const delBtn = panelIn.querySelector('#expDeleteBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this expense?')) return;
          try {
            await ctx.api.request(ENDPOINTS.ttExpenses + '?id=' + encodeURIComponent(exp.id), { method: 'DELETE' });
            await loadAll();
            closePanel();
            renderExpenses();
            renderDashboard();
          } catch (err) {
            panelIn.querySelector('#expFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not delete expense')}</div>`;
          }
        });
      }

      panelIn.querySelectorAll('[data-status]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await ctx.api.request(ENDPOINTS.ttExpenses + '?id=' + encodeURIComponent(exp.id), {
              method: 'PATCH', body: { status: btn.dataset.status }
            });
            notifyExpenseStatus(exp, btn.dataset.status);
            await loadAll();
            closePanel();
            renderExpenses();
            renderDashboard();
          } catch (err) {
            panelIn.querySelector('#expFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not update status')}</div>`;
          }
        });
      });
    }

    /* ---------------- Redeem Miles ---------------- */
    // Internal tracking only, no connected accounts. Pick a trip, log a
    // dollar amount (+ optional note); it adds to that trip's running
    // total. See lib/traveltrack/schema.js for why this lives on the trip
    // record rather than a separate loyalty-account entity.

    function redeemLabel() {
      return (data.org && data.org.redemption_label) || 'Miles / Rewards';
    }

    function redeemableTrips() {
      const rows = seesAll ? data.trips.slice() : data.trips.filter((t) => t.traveler === me);
      return rows.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
    }

    // Shared by the Redeem Miles page and the dashboard's "+ Log miles"
    // panel, so the two can never drift apart.
    function redeemFormHtml(idPrefix) {
      return `
        <div id="${idPrefix}Err"></div>
        <form id="${idPrefix}El">
          <div class="field"><label>Trip</label><div id="${idPrefix}Trip"></div></div>
          <div class="field"><label>Amount ($)</label><input type="number" step="0.01" min="0.01" name="amount" required></div>
          <div class="field"><label>Note</label><input name="note" placeholder="Optional — e.g. companion ticket"></div>
          <button type="submit" class="btn btn-sm">Add redemption</button>
        </form>`;
    }

    function wireRedeemForm(root, idPrefix, onDone) {
      const trips = redeemableTrips();
      const picker = buildTypeahead(root.querySelector('#' + idPrefix + 'Trip'), {
        options: trips.map((t) => ({ value: t.id, label: t.title + ' — ' + fmtDate(t.start_date) })),
        placeholder: 'Type to search trips...'
      });
      const form = root.querySelector('#' + idPrefix + 'El');
      if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = root.querySelector('#' + idPrefix + 'Err');
        const tripId = picker.value();
        if (!tripId) {
          errEl.innerHTML = '<div class="form-err">Pick a trip first.</div>';
          return;
        }
        const fd = new FormData(form);
        const body = Object.fromEntries(fd.entries());
        body.trip_id = tripId;
        const btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        try {
          await ctx.api.post(ENDPOINTS.ttMiles, body);
          await loadAll();
          renderDashboard();
          if (onDone) onDone();
        } catch (err) {
          errEl.innerHTML = `<div class="form-err">${esc(err.message || 'Could not log redemption')}</div>`;
          btn.disabled = false;
        }
      });
    }

    function renderRedeemForm() {
      $('#redeemForm').innerHTML =
        '<div class="section-hd" style="margin-top:0">Log a redemption</div>' + redeemFormHtml('redeem');
      wireRedeemForm(root, 'redeem', () => renderMiles());
    }

    function openRedeemPanel() {
      openPanel(`
        <div class="panel-top">
          <div><h2>Log ${esc(redeemLabel().toLowerCase())}</h2><div class="sub">Applies a dollar credit to a trip</div></div>
          <button class="x" data-close>&times;</button>
        </div>
        ${redeemFormHtml('panelRedeem')}
      `);
      panelIn.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));
      wireRedeemForm(panelIn, 'panelRedeem', () => {
        closePanel();
        renderMiles();
      });
    }

    function renderMiles() {
      $('#milesTitle').textContent = redeemLabel() + '.';
      $('#milesSub').textContent = 'Internal tracking only — no accounts connected.';
      renderRedeemForm();

      const trips = redeemableTrips();
      if (!trips.length) {
        $('#redeemTripList').innerHTML = '<div class="empty"><h3>No trips yet</h3><p>Plan a trip first, then redemptions can be logged against it.</p></div>';
        return;
      }

      $('#redeemTripList').innerHTML = trips.map((t) => {
        const spent = expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const miles = Number(t.miles_value) || 0;
        return `
          <div class="redeem-list-row">
            <div><div class="t">${esc(t.title)}</div><div class="s">${fmtDate(t.start_date)} · Spent ${fmtMoney(spent)}</div></div>
            <div class="v" style="color:${miles ? 'var(--success)' : 'var(--muted)'}">${miles ? '-' + fmtMoney(miles) : fmtMoney(0)}</div>
          </div>`;
      }).join('');
    }

    /* ---------------- Dashboard ----------------
       Cards are a registry, not hardcoded markup: each entry knows how to
       render itself from the already-filtered rows, and which cards are
       visible is a per-user preference. Adding a report later = one entry
       here, and it shows up in Customize automatically. */

    const DASH_CARDS = [
      { id: 'recent_trips',    label: 'Recent trips' },
      { id: 'recent_expenses', label: 'Recent expenses' },
      { id: 'spend_vs_miles',  label: 'Spending vs. redeemed' },
      { id: 'by_category',     label: 'Spending by category' },
      { id: 'monthly_trend',   label: 'Monthly trend' },
      { id: 'year_over_year',  label: 'Year-over-year comparison' },
      { id: 'by_traveler',     label: 'Spending by traveler' },
      { id: 'by_payment',      label: 'Payment method' },
      { id: 'trips_by_status', label: 'Trips by status' },
      { id: 'top_trips',       label: 'Most expensive trips' }
    ];

    const DASH_DEFAULT = ['recent_trips', 'recent_expenses', 'spend_vs_miles', 'by_category', 'monthly_trend', 'trips_by_status'];
    const DASH_PREF_KEY = 'traveltrack.dashCards';

    function dashVisible() {
      try {
        const raw = localStorage.getItem(DASH_PREF_KEY);
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) return list.filter((id) => DASH_CARDS.some((c) => c.id === id));
        }
      } catch (e) { /* blocked storage — fall through to the default set */ }
      return DASH_DEFAULT.slice();
    }

    function setDashVisible(list) {
      try { localStorage.setItem(DASH_PREF_KEY, JSON.stringify(list)); }
      catch (e) { /* preference simply won't persist */ }
    }

    // Horizontal bar list, reused by the several "X by Y" cards.
    function barListHtml(entries, opts) {
      const { money = true, empty = 'Nothing to show yet.' } = opts || {};
      if (!entries.length) return `<div class="empty">${esc(empty)}</div>`;
      const max = Math.max(...entries.map((e) => e[1])) || 1;
      return entries.map(([label, value]) => `
        <div class="bar-row">
          <div class="top"><span class="lab">${esc(label)}</span><span>${money ? fmtMoney(value) : String(value)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${Math.round((value / max) * 100)}%"></div></div>
        </div>`).join('');
    }

    function renderDashboard() {
      const mine = (r, field) => seesAll || r[field] === me;
      const allTrips = data.trips.filter((t) => mine(t, 'traveler'));
      const allExpenses = data.expenses.filter((e) => mine(e, 'submitted_by'));

      // Range filter applies to every card and KPI on this screen.
      const trips = allTrips.filter((t) => inRange(t.start_date, filters.dashRange));
      const expenses = allExpenses.filter((e) => inRange(e.date, filters.dashRange));

      const ranges = rangeOptions(allExpenses.concat(allTrips.map((t) => ({ date: t.start_date }))), 'date');
      const rangeSel = $('#dashRange');
      rangeSel.innerHTML = ranges.map(([v, l]) => `<option value="${esc(v)}"${filters.dashRange === v ? ' selected' : ''}>${esc(l)}</option>`).join('');

      const upcoming = trips.filter((t) => ['potential', 'confirmed'].includes(normStatus(t.status))).length;
      // Spend totals count only trips we attended (see countsTowardSpend).
      // countedExpenses is what every money figure on this screen uses;
      // `expenses` stays the full set for the recent-activity list, which
      // should still show what was logged regardless of trip outcome.
      const countedExpenses = expenses.filter(expenseCounts);
      const countedTrips = trips.filter(countsTowardSpend);
      const spendTotal = countedExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const excludedTotal = expenses.filter((e) => !expenseCounts(e)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const pending = expenses.filter((e) => e.status === 'pending');
      const pendingTotal = pending.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const milesTotal = countedTrips.reduce((s, t) => s + (Number(t.miles_value) || 0), 0);
      const rangeLabel = (ranges.find((r) => r[0] === filters.dashRange) || ['', 'All time'])[1];

      const dashKpiRows = [
        [String(upcoming), 'Upcoming trips'],
        [fmtMoney(spendTotal), 'Total spend'],
        [String(pending.length), 'Pending expenses'],
        [fmtMoney(pendingTotal), 'Awaiting approval'],
        [fmtMoney(milesTotal), redeemLabel() + ' redeemed'],
        [fmtMoney(Math.max(0, spendTotal - milesTotal)), 'Net cost']
      ];
      if (excludedTotal > 0) dashKpiRows.push([fmtMoney(excludedTotal), 'On trips not attended']);

      $('#dashKpis').innerHTML = dashKpiRows
        .map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

      $('#dashSub').textContent = (seesAll ? "The whole team's trips and expenses" : 'Your trips and expenses') + ' · ' + rangeLabel;

      // ---- card renderers ----
      const body = {
        recent_trips: () => {
          const rows = trips.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).slice(0, 6);
          return rows.length ? rows.map((t) => `
            <div class="mini-row"><div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.destination)} · ${fmtDate(t.start_date)}</div></div>
            <span class="chip ${statusClass(normStatus(t.status))}">${esc(labelOf(TRIP_STATUSES, normStatus(t.status)))}</span></div>
          `).join('') : '<div class="empty">No trips in this range.</div>';
        },
        recent_expenses: () => {
          const rows = expenses.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 6);
          return rows.length ? rows.map((e) => `
            <div class="mini-row">
              <div style="display:flex;align-items:center;gap:9px">
                ${categoryIcon(e.category)}
                <div><div class="t">${esc(e.description || e.category)}</div><div class="s">${esc(e.category)} · ${fmtDate(e.date)}</div></div>
              </div>
              <span class="v" style="font-weight:700">${fmtMoney(e.amount)}</span>
            </div>
          `).join('') : '<div class="empty">No expenses in this range.</div>';
        },
        spend_vs_miles: () => {
          const applied = Math.min(milesTotal, spendTotal);
          const oop = Math.max(0, spendTotal - applied);
          if (spendTotal <= 0) return '<div class="empty">No spend in this range.</div>';
          // Blue vs green, NOT accent vs success: TravelTrack's accent is a
          // green almost identical to --success, so those two together made
          // one indistinguishable green ring.
          return donutChart(
            [['Out of pocket', oop], [redeemLabel(), applied]],
            { hueFor: (label) => (label === 'Out of pocket' ? 'hue-blue' : 'success') });
        },
        by_category: () => {
          const by = {};
          countedExpenses.forEach((e) => { by[e.category] = (by[e.category] || 0) + (Number(e.amount) || 0); });
          // Donut hues match each category's icon in the expense list, so
          // the two read as the same colour language.
          return donutChart(Object.entries(by).sort((a, b) => b[1] - a[1]), {
            empty: 'No expenses in this range.',
            hueFor: (label) => categoryMeta(label).hue
          });
        },
        monthly_trend: () => {
          const by = {};
          countedExpenses.forEach((e) => { const k = String(e.date).slice(0, 7); if (k) by[k] = (by[k] || 0) + (Number(e.amount) || 0); });
          const pts = Object.entries(by).sort((a, b) => a[0].localeCompare(b[0]))
            .map(([k, v]) => [monthLabel(k), v]);
          return lineChart(pts, { empty: 'No expenses in this range.' });
        },
        year_over_year: () => {
          // Always compares full calendar years regardless of the range
          // filter — comparing a range against itself would say nothing.
          const byYear = {};
          allExpenses.filter(expenseCounts).forEach((e) => {
            const y = String(e.date).slice(0, 4);
            const m = Number(String(e.date).slice(5, 7));
            if (!/^\d{4}$/.test(y) || !m) return;
            (byYear[y] = byYear[y] || new Array(12).fill(0))[m - 1] += Number(e.amount) || 0;
          });
          const years = Object.keys(byYear).sort().slice(-3);
          const series = years.map((y) => ({
            name: y,
            points: MONTH_ABBR.map((mn, i) => [mn, byYear[y][i]])
          }));
          return multiLineChart(series, { empty: 'Not enough history yet.' });
        },
        by_traveler: () => {
          const by = {};
          countedExpenses.forEach((e) => { const k = e.submitted_by_name || e.submitted_by || 'Unknown'; by[k] = (by[k] || 0) + (Number(e.amount) || 0); });
          return donutChart(Object.entries(by).sort((a, b) => b[1] - a[1]), { empty: 'No expenses in this range.' });
        },
        by_payment: () => {
          const by = {};
          countedExpenses.forEach((e) => { const k = labelOf(PAYMENT_METHODS, e.payment_method); by[k] = (by[k] || 0) + (Number(e.amount) || 0); });
          return donutChart(Object.entries(by).sort((a, b) => b[1] - a[1]), { empty: 'No expenses in this range.' });
        },
        trips_by_status: () => {
          const by = {};
          trips.forEach((t) => { const k = labelOf(TRIP_STATUSES, normStatus(t.status)); by[k] = (by[k] || 0) + 1; });
          return donutChart(Object.entries(by).sort((a, b) => b[1] - a[1]), { money: false, empty: 'No trips in this range.' });
        },
        top_trips: () => {
          const rows = countedTrips.map((t) => [t.title, expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0)])
            .filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);
          return barListHtml(rows, { empty: 'No trip spend in this range.' });
        }
      };

      const visible = dashVisible();
      $('#dashCards').innerHTML = DASH_CARDS.filter((c) => visible.includes(c.id)).map((c) => {
        const label = c.id === 'spend_vs_miles' ? 'Spending vs. ' + redeemLabel() : c.label;
        const wide = ['monthly_trend', 'year_over_year', 'top_trips'].includes(c.id);
        return `
          <div class="card${wide ? ' wide' : ''}">
            <div class="card-hd"><h3>${esc(label)}</h3></div>
            <div class="card-bd">${body[c.id]()}</div>
          </div>`;
      }).join('') || '<div class="empty">No cards selected. Use Customize to pick some.</div>';
    }

    function renderDashCustomize() {
      const visible = dashVisible();
      const panel = $('#dashCustomizePanel');
      panel.innerHTML = `
        <div class="dash-customize">
          <h3>Dashboard cards</h3>
          <div class="hint">Pick what shows here. Saved in this browser.</div>
          <div class="dash-toggles">
            ${DASH_CARDS.map((c) => `
              <label class="dash-toggle">
                <input type="checkbox" data-card="${esc(c.id)}"${visible.includes(c.id) ? ' checked' : ''}>
                <span>${esc(c.id === 'spend_vs_miles' ? 'Spending vs. ' + redeemLabel() : c.label)}</span>
              </label>`).join('')}
          </div>
          <div class="form-actions"><button class="btn btn-sm ghost" id="dashResetCards">Reset to default</button></div>
        </div>`;
      panel.querySelectorAll('[data-card]').forEach((box) => {
        box.addEventListener('change', () => {
          const next = Array.from(panel.querySelectorAll('[data-card]'))
            .filter((b) => b.checked).map((b) => b.dataset.card);
          setDashVisible(next);
          renderDashboard();
        });
      });
      panel.querySelector('#dashResetCards').addEventListener('click', () => {
        setDashVisible(DASH_DEFAULT.slice());
        renderDashCustomize();
        renderDashboard();
      });
    }

    /* ---------------- Trips view ---------------- */

    const TRIP_FILTERS = [
      ['upcoming', 'Upcoming'],
      ['attended', 'Attended'],
      ['all', 'All']
    ];

    function renderTripsFilters() {
      const ranges = rangeOptions(data.trips, 'start_date');
      $('#tripsFilters').innerHTML =
        TRIP_FILTERS.map(([k, l]) =>
          `<button class="filt" data-filt="${k}" aria-pressed="${filters.trips === k}">${esc(l)}</button>`).join('') +
        `<select class="filt" id="tripsRange" style="margin-left:8px;cursor:pointer">
          ${ranges.map(([v, l]) => `<option value="${esc(v)}"${filters.tripsRange === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>`;
      $$('#tripsFilters [data-filt]').forEach((b) => b.addEventListener('click', () => {
        filters.trips = b.dataset.filt;
        renderTrips();
      }));
      const sel = $('#tripsRange');
      if (sel) sel.addEventListener('change', () => { filters.tripsRange = sel.value; renderTrips(); });
    }

    // Attendees live on the trip record now. Older imported trips carried
    // them as a line in notes ("Attendees: A, B, C") before that field
    // existed, so fall back to parsing that rather than showing one name
    // for a trip five people went on.
    function attendeesOf(t) {
      if (Array.isArray(t.attendees) && t.attendees.length) return t.attendees;
      const m = /Attendees:\s*(.+)/.exec(t.notes || '');
      if (m) return m[1].split(',').map((s) => s.trim()).filter(Boolean);
      const solo = t.traveler_name || t.traveler;
      return solo ? [solo] : [];
    }

    function attendeesLabel(t) {
      const list = attendeesOf(t);
      return list.length ? list.join(', ') : 'Unknown';
    }

    function filteredTrips() {
      let rows = seesAll ? data.trips.slice() : data.trips.filter((t) => t.traveler === me);
      if (filters.trips === 'upcoming') rows = rows.filter((t) => ['potential', 'confirmed'].includes(normStatus(t.status)));
      if (filters.trips === 'attended') rows = rows.filter((t) => normStatus(t.status) === 'attended');
      rows = rows.filter((t) => inRange(t.start_date, filters.tripsRange));
      rows.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));
      return rows;
    }

    function renderTrips() {
      renderTripsFilters();
      const rows = filteredTrips();

      $('#tripsSub').textContent = rows.length + (rows.length === 1 ? ' trip' : ' trips');

      const withSpend = rows.map((t) => {
        const spent = expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const miles = Number(t.miles_value) || 0;
        return { t, spent, miles, net: Math.max(0, spent - miles), counts: countsTowardSpend(t) };
      });
      const counted = withSpend.filter((r) => r.counts);
      const totalSpent = counted.reduce((s, r) => s + r.spent, 0);
      const totalMiles = counted.reduce((s, r) => s + r.miles, 0);
      const totalNet = counted.reduce((s, r) => s + r.net, 0);
      const spendingTripCount = counted.filter((r) => r.spent > 0).length;
      const excluded = withSpend.filter((r) => !r.counts).reduce((s, r) => s + r.spent, 0);

      const tripKpis = [
        [fmtMoney(totalSpent), 'Total spent (' + spendingTripCount + ' trip' + (spendingTripCount === 1 ? '' : 's') + ')'],
        [fmtMoney(totalMiles), redeemLabel() + ' redeemed'],
        [fmtMoney(totalNet), 'Net cost']
      ];
      // Never hide money: spend on trips that weren't attended gets its own
      // tile rather than quietly vanishing from the total.
      if (excluded > 0) tripKpis.push([fmtMoney(excluded), 'On trips not attended']);

      $('#tripsKpis').innerHTML = rows.length
        ? tripKpis.map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('')
        : '';

      if (!rows.length) {
        $('#tripsTbl').innerHTML = '<div class="empty"><h3>No trips here</h3><p>Try a different filter, or plan a new one.</p></div>';
        return;
      }

      $('#tripsTbl').innerHTML = withSpend.map(({ t, spent, miles, net }) => {
        const st = normStatus(t.status);
        const pct = spent > 0 ? Math.min(100, Math.round((miles / spent) * 100)) : 0;
        return `
        <div class="trip-card" data-trip="${esc(t.id)}">
          <div class="trip-card-hd">
            <h3>${esc(t.title)}</h3>
            <select class="status-select ${statusClass(st)}" data-status-for="${esc(t.id)}" title="Change status">
              ${TRIP_STATUSES.map(([v, l]) => `<option value="${v}"${v === st ? ' selected' : ''}>${esc(l)}</option>`).join('')}
            </select>
          </div>
          <div class="trip-meta">${ICON_PIN}<span>${esc(t.destination || '—')}</span></div>
          <div class="trip-meta">${ICON_CALENDAR}<span>${fmtDate(t.start_date)}${t.end_date && t.end_date !== t.start_date ? ' – ' + fmtDate(t.end_date) : ''}</span></div>
          <div class="trip-meta">${ICON_PEOPLE}<span>${esc(attendeesLabel(t))}</span></div>
          <div class="trip-figures">
            <div class="figure-row"><span class="k">Total Spent</span><span class="v">${fmtMoney(spent)}</span></div>
            ${spent > 0 ? `
              <div class="figure-row"><span class="k">${esc(redeemLabel())}</span><span class="v miles-credit">${miles > 0 ? '-' + fmtMoney(miles) : fmtMoney(0)}</span></div>
              <div class="bar-track" title="${pct}% of this trip covered"><div class="bar-fill" style="width:${pct}%"></div></div>
            ` : ''}
            <div class="figure-row net"><span class="k">Net Cost</span><span class="v">${fmtMoney(net)}</span></div>
          </div>
        </div>`;
      }).join('');

      // Card click opens the trip; the status dropdown is excluded so
      // changing status never also pops the panel open behind it.
      $$('#tripsTbl [data-trip]').forEach((card) => card.addEventListener('click', (e) => {
        if (e.target.closest('.status-select')) return;
        const trip = data.trips.find((t) => t.id === card.dataset.trip);
        if (trip) openTripPanel(trip);
      }));

      $$('#tripsTbl [data-status-for]').forEach((sel) => {
        sel.addEventListener('click', (e) => e.stopPropagation());
        sel.addEventListener('change', async () => {
          const id = sel.dataset.statusFor;
          const prev = sel.dataset.prev || '';
          sel.disabled = true;
          try {
            await ctx.api.request(ENDPOINTS.ttTrips + '?id=' + encodeURIComponent(id), {
              method: 'PATCH', body: { status: sel.value }
            });
            await loadAll();
            renderTrips();
            renderDashboard();
          } catch (err) {
            console.error('[traveltrack] status change failed:', err);
            sel.disabled = false;
            if (prev) sel.value = prev;
            alert('Could not change status: ' + (err.message || 'unknown error'));
          }
        });
      });
    }

    function exportTripsCSV() {
      const rows = filteredTrips();
      const header = ['Trip Name', 'Destination', 'Status', 'Start Date', 'End Date', 'Traveler', 'Total Spent', redeemLabel(), 'Net Cost'];
      const body = rows.map((t) => {
        const spent = expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const miles = Number(t.miles_value) || 0;
        return [t.title, t.destination, labelOf(TRIP_STATUSES, normStatus(t.status)), t.start_date, t.end_date, t.traveler_name || t.traveler, spent.toFixed(2), miles.toFixed(2), Math.max(0, spent - miles).toFixed(2)];
      });
      downloadCSV('traveltrack-trips.csv', [header, ...body]);
    }

    /* ---------------- Expenses view ---------------- */

    const EXP_FILTERS = [['pending', 'Pending'], ['approved', 'Approved'], ['reimbursed', 'Reimbursed'], ['rejected', 'Rejected'], ['all', 'All']];

    function renderExpFilters() {
      const ranges = rangeOptions(data.expenses, 'date');
      let html = EXP_FILTERS.map(([k, l]) =>
        `<button class="filt" data-filt="${k}" aria-pressed="${filters.expenses === k}">${esc(l)}</button>`).join('');
      html += `<select class="filt" id="expCategoryFilter" style="margin-left:8px;cursor:pointer">
          <option value="all"${filters.expenseCategory === 'all' ? ' selected' : ''}>All categories</option>
          ${EXPENSE_CATEGORIES.map((c) => `<option value="${esc(c)}"${filters.expenseCategory === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
        </select>`;
      html += `<select class="filt" id="expRange" style="cursor:pointer">
          ${ranges.map(([v, l]) => `<option value="${esc(v)}"${filters.expensesRange === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        </select>`;
      html += `<button class="filt" data-bytrip aria-pressed="${filters.expensesByTrip}" style="margin-left:8px">Group by trip</button>`;
      if (seesAll) {
        html += `<button class="filt" data-mine aria-pressed="${filters.expensesMine}">My expenses only</button>`;
      }
      $('#expFilters').innerHTML = html;
      $$('#expFilters [data-filt]').forEach((b) => b.addEventListener('click', () => { filters.expenses = b.dataset.filt; renderExpenses(); }));
      const catSel = $('#expCategoryFilter');
      if (catSel) catSel.addEventListener('change', () => { filters.expenseCategory = catSel.value; renderExpenses(); });
      const rangeSel = $('#expRange');
      if (rangeSel) rangeSel.addEventListener('change', () => { filters.expensesRange = rangeSel.value; renderExpenses(); });
      const byTripBtn = $('#expFilters [data-bytrip]');
      if (byTripBtn) byTripBtn.addEventListener('click', () => { filters.expensesByTrip = !filters.expensesByTrip; renderExpenses(); });
      const mineBtn = $('#expFilters [data-mine]');
      if (mineBtn) mineBtn.addEventListener('click', () => { filters.expensesMine = !filters.expensesMine; renderExpenses(); });
    }

    function filteredExpenses() {
      let rows = seesAll ? data.expenses.slice() : data.expenses.filter((e) => e.submitted_by === me);
      if (seesAll && filters.expensesMine) rows = rows.filter((e) => e.submitted_by === me);
      if (filters.expenses !== 'all') rows = rows.filter((e) => e.status === filters.expenses);
      if (filters.expenseCategory !== 'all') rows = rows.filter((e) => e.category === filters.expenseCategory);
      rows = rows.filter((e) => inRange(e.date, filters.expensesRange));
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return rows;
    }

    function expenseRowHtml(e) {
      return `
        <tr class="clickable" data-exp="${esc(e.id)}">
          <td>${fmtDate(e.date)}</td>
          <td><div class="cat-cell">${categoryIcon(e.category)}<span>${esc(e.category)}</span></div></td>
          <td>${esc(e.description || '—')}${e.receipt_url ? ' <span class="chip muted">receipt</span>' : ''}</td>
          ${seesAll ? `<td>${esc(e.submitted_by_name || e.submitted_by)}</td>` : ''}
          ${filters.expensesByTrip ? '' : `<td>${esc(tripLabel(e.trip_id) || '—')}</td>`}
          <td>${esc(labelOf(PAYMENT_METHODS, e.payment_method))}</td>
          <td class="num">${fmtMoney(e.amount)}</td>
          <td><span class="chip ${statusClass(e.status)}">${esc(labelOf(EXPENSE_STATUSES, e.status))}</span></td>
        </tr>`;
    }

    function expenseTableHtml(rows) {
      return `
        <table>
          <thead><tr><th>Date</th><th>Category</th><th>Description</th>${seesAll ? '<th>Submitted by</th>' : ''}${filters.expensesByTrip ? '' : '<th>Trip</th>'}<th>Payment</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>${rows.map(expenseRowHtml).join('')}</tbody>
        </table>`;
    }

    function renderExpenses() {
      renderExpFilters();
      const rows = filteredExpenses();
      $('#expSub').textContent = rows.length + (rows.length === 1 ? ' expense' : ' expenses') + ' · ' + fmtMoney(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0));

      if (!rows.length) {
        $('#expTbl').innerHTML = '<div class="empty"><h3>No expenses here</h3><p>Try a different filter, or log a new one.</p></div>';
        return;
      }

      if (filters.expensesByTrip) {
        // Grouped view: one block per trip, each with its own subtotal.
        // Unassigned expenses collect under a final "No trip" group rather
        // than being dropped.
        const groups = new Map();
        rows.forEach((e) => {
          const key = e.trip_id || '__none__';
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(e);
        });
        const ordered = Array.from(groups.entries()).sort((a, b) => {
          if (a[0] === '__none__') return 1;
          if (b[0] === '__none__') return -1;
          const ta = data.trips.find((t) => t.id === a[0]);
          const tb = data.trips.find((t) => t.id === b[0]);
          return String((tb && tb.start_date) || '').localeCompare(String((ta && ta.start_date) || ''));
        });
        $('#expTbl').innerHTML = ordered.map(([key, list]) => {
          const total = list.reduce((s, e) => s + (Number(e.amount) || 0), 0);
          const title = key === '__none__' ? 'No trip' : (tripLabel(key) || key);
          return `
            <div class="card-hd" style="border-top:1px solid var(--line)">
              <h3>${esc(title)}</h3>
              <span class="meta">${list.length} item${list.length === 1 ? '' : 's'} · ${fmtMoney(total)}</span>
            </div>
            ${expenseTableHtml(list)}`;
        }).join('');
      } else {
        $('#expTbl').innerHTML = expenseTableHtml(rows);
      }

      $$('#expTbl [data-exp]').forEach((row) => row.addEventListener('click', () => {
        const exp = data.expenses.find((e) => e.id === row.dataset.exp);
        if (exp) openExpensePanel(exp);
      }));
    }

    function exportExpensesCSV() {
      const rows = filteredExpenses();
      const header = ['Date', 'Category', 'Description', 'Submitted by', 'Trip', 'Payment method', 'Amount', 'Status'];
      const body = rows.map((e) => [e.date, e.category, e.description || '', e.submitted_by_name || e.submitted_by, tripLabel(e.trip_id) || '', labelOf(PAYMENT_METHODS, e.payment_method), (Number(e.amount) || 0).toFixed(2), labelOf(EXPENSE_STATUSES, e.status)]);
      downloadCSV('traveltrack-expenses.csv', [header, ...body]);
    }

    /* ---------------- Reports view ---------------- */

    function renderReportsYearOptions() {
      const years = new Set(data.expenses.map((e) => String(e.date).slice(0, 4)).filter(Boolean));
      years.add(String(reportsYear));
      const sorted = Array.from(years).sort().reverse();
      $('#reportsYear').innerHTML = sorted.map((y) => `<option value="${y}"${Number(y) === reportsYear ? ' selected' : ''}>${y}</option>`).join('');
    }

    // Every money figure in Reports counts only trips we attended. The
    // unfiltered set is kept separate so the excluded amount can still be
    // reported rather than disappearing.
    function reportRowsAll() {
      const scoped = seesAll ? data.expenses : data.expenses.filter((e) => e.submitted_by === me);
      return scoped.filter((e) => String(e.date).slice(0, 4) === String(reportsYear));
    }

    function reportRows() {
      return reportRowsAll().filter(expenseCounts);
    }

    function renderReports() {
      renderReportsYearOptions();
      const rows = reportRows();
      const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const pending = rows.filter((e) => e.status === 'pending').reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const reimbursed = rows.filter((e) => e.status === 'reimbursed').reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const tripCount = new Set(rows.map((e) => e.trip_id).filter(Boolean)).size;

      $('#reportsSub').textContent = seesAll ? "Team spend for " + reportsYear + "." : "Your spend for " + reportsYear + ".";
      const excludedReport = reportRowsAll().filter((e) => !expenseCounts(e))
        .reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const reportKpis = [
        [fmtMoney(total), 'Total spend'],
        [fmtMoney(pending), 'Awaiting approval'],
        [fmtMoney(reimbursed), 'Reimbursed'],
        [String(tripCount), 'Trips with expenses']
      ];
      if (excludedReport > 0) reportKpis.push([fmtMoney(excludedReport), 'On trips not attended']);
      $('#reportsKpis').innerHTML = reportKpis
        .map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

      const byCat = {};
      rows.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + (Number(e.amount) || 0); });
      $('#reportsByCat').innerHTML = donutChart(
        Object.entries(byCat).sort((a, b) => b[1] - a[1]),
        { empty: 'No expenses in ' + reportsYear + '.', hueFor: (label) => categoryMeta(label).hue });

      if (seesAll) {
        $('#reportsByWhoHd').textContent = 'Spend by traveler';
        const byWho = {};
        rows.forEach((e) => { const k = e.submitted_by_name || e.submitted_by; byWho[k] = (byWho[k] || 0) + (Number(e.amount) || 0); });
        $('#reportsByWho').innerHTML = donutChart(
          Object.entries(byWho).sort((a, b) => b[1] - a[1]),
          { empty: 'No expenses in ' + reportsYear + '.' });
      } else {
        $('#reportsByWhoHd').textContent = 'Spend by month';
        const byMonth = {};
        rows.forEach((e) => { const k = String(e.date).slice(0, 7); if (k) byMonth[k] = (byMonth[k] || 0) + (Number(e.amount) || 0); });
        const pts = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [monthLabel(k), v]);
        $('#reportsByWho').innerHTML = lineChart(pts, { empty: 'No expenses in ' + reportsYear + '.' });
      }

      // ---- Spend by trip ----
      const byTrip = {};
      rows.forEach((e) => {
        const k = e.trip_id ? (tripLabel(e.trip_id) || e.trip_id) : 'No trip';
        byTrip[k] = (byTrip[k] || 0) + (Number(e.amount) || 0);
      });
      $('#reportsByTrip').innerHTML = barListHtml(
        Object.entries(byTrip).sort((a, b) => b[1] - a[1]),
        { empty: 'No expenses in ' + reportsYear + '.' });

      // ---- Payment method ----
      const byPay = {};
      rows.forEach((e) => {
        const k = labelOf(PAYMENT_METHODS, e.payment_method);
        byPay[k] = (byPay[k] || 0) + (Number(e.amount) || 0);
      });
      $('#reportsByPayment').innerHTML = donutChart(
        Object.entries(byPay).sort((a, b) => b[1] - a[1]),
        { empty: 'No expenses in ' + reportsYear + '.' });

      // ---- Approval status ----
      const byStatus = {};
      rows.forEach((e) => {
        const k = labelOf(EXPENSE_STATUSES, e.status);
        byStatus[k] = (byStatus[k] || 0) + (Number(e.amount) || 0);
      });
      $('#reportsByStatus').innerHTML = donutChart(
        Object.entries(byStatus).sort((a, b) => b[1] - a[1]),
        { empty: 'No expenses in ' + reportsYear + '.' });

      // ---- Redeemed by trip ----
      // Trips are scoped by their own start date, not the expense dates, so
      // this counts a redemption in the year the trip happened.
      $('#reportsMilesHd').textContent = redeemLabel() + ' by trip';
      const tripsInYear = (seesAll ? data.trips : data.trips.filter((t) => t.traveler === me))
        .filter((t) => String(t.start_date).slice(0, 4) === String(reportsYear))
        .filter(countsTowardSpend);
      const milesRows = tripsInYear
        .map((t) => [t.title, Number(t.miles_value) || 0])
        .filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
      $('#reportsMiles').innerHTML = barListHtml(milesRows, { empty: 'Nothing redeemed in ' + reportsYear + '.' });

      // ---- Monthly trend ----
      const trendBy = {};
      rows.forEach((e) => { const k = String(e.date).slice(0, 7); if (k) trendBy[k] = (trendBy[k] || 0) + (Number(e.amount) || 0); });
      $('#reportsTrend').innerHTML = lineChart(
        Object.entries(trendBy).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [monthLabel(k), v]),
        { empty: 'No expenses in ' + reportsYear + '.' });

      // ---- Trip summary table ----
      const summary = tripsInYear.map((t) => {
        const spent = expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
        const miles = Number(t.miles_value) || 0;
        return { t, spent, miles, net: Math.max(0, spent - miles) };
      }).sort((a, b) => b.spent - a.spent);

      $('#reportsTableMeta').textContent = summary.length + (summary.length === 1 ? ' trip' : ' trips');
      $('#reportsTable').innerHTML = summary.length ? `
        <table>
          <thead><tr><th>Trip</th><th>Dates</th><th>Status</th>${seesAll ? '<th>Team</th>' : ''}<th class="num">Spent</th><th class="num">${esc(redeemLabel())}</th><th class="num">Net</th></tr></thead>
          <tbody>
            ${summary.map(({ t, spent, miles, net }) => `
              <tr>
                <td>${esc(t.title)}</td>
                <td>${fmtDate(t.start_date)}${t.end_date && t.end_date !== t.start_date ? ' – ' + fmtDate(t.end_date) : ''}</td>
                <td><span class="chip ${statusClass(normStatus(t.status))}">${esc(labelOf(TRIP_STATUSES, normStatus(t.status)))}</span></td>
                ${seesAll ? `<td>${esc(attendeesLabel(t))}</td>` : ''}
                <td class="num">${fmtMoney(spent)}</td>
                <td class="num">${miles > 0 ? '-' + fmtMoney(miles) : '—'}</td>
                <td class="num">${fmtMoney(net)}</td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<div class="empty">No trips in ' + reportsYear + '.</div>';
    }

    function exportReportsCSV() {
      const rows = reportRows();
      const header = ['Date', 'Category', 'Description', 'Submitted by', 'Amount', 'Status'];
      const body = rows.map((e) => [e.date, e.category, e.description || '', e.submitted_by_name || e.submitted_by, (Number(e.amount) || 0).toFixed(2), labelOf(EXPENSE_STATUSES, e.status)]);
      downloadCSV('traveltrack-report-' + reportsYear + '.csv', [header, ...body]);
    }

    /* ---------------- Settings view ---------------- */

    function renderSettings() {
      $('#acctForm').innerHTML = `
        <div id="acctErr"></div>
        <form id="acctForm2">
          <div class="field"><label>Home airport</label><input name="home_airport" value="${esc(data.account.home_airport || '')}" placeholder="DSM" maxlength="4" style="max-width:120px;text-transform:uppercase"></div>
          <div class="field"><label>Default payment method</label>
            <select name="default_payment_method">${PAYMENT_METHODS.map(([v, l]) => `<option value="${v}"${v === data.account.default_payment_method ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
          </div>
          <button type="submit" class="btn btn-sm">Save</button>
        </form>
      `;
      $('#acctForm #acctForm2').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        try {
          await ctx.api.request(ENDPOINTS.ttSettings, { method: 'PATCH', body });
          await loadAll();
          renderSettings();
        } catch (err) {
          $('#acctForm #acctErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not save')}</div>`;
        }
      });

      $('#orgHd').hidden = !data.canEditOrg;
      $('#orgCard').hidden = !data.canEditOrg;
      if (data.canEditOrg) {
        $('#orgForm').innerHTML = `
          <div class="settings-note">These apply shop-wide: the mileage rate governs every Mileage-category expense, and the approval threshold is informational for now.</div>
          <div id="orgErr"></div>
          <form id="orgForm2">
            <div class="field-row">
              <div class="field"><label>Mileage rate ($/mi)</label><input type="number" step="0.01" min="0" name="mileage_rate" value="${esc(data.org.mileage_rate)}"></div>
              <div class="field"><label>Approval threshold ($)</label><input type="number" step="1" min="0" name="approval_threshold" value="${esc(data.org.approval_threshold)}"></div>
            </div>
            <div class="field"><label>Per diem rate ($/day, 0 = unused)</label><input type="number" step="0.01" min="0" name="per_diem_rate" value="${esc(data.org.per_diem_rate)}" style="max-width:200px"></div>
            <div class="field"><label>Redeem Miles label</label><input name="redemption_label" value="${esc(data.org.redemption_label || 'Miles / Rewards')}" style="max-width:220px">
              <div class="hint">What this shows as everywhere — trip cards, dashboard, the rail. Some shops call it "Points" or "Rewards" instead.</div>
            </div>
            <div class="field"><label>Team members</label>
              <textarea name="team_members" placeholder="One name per line" style="min-height:110px">${esc((data.org.team_members || []).join('\n'))}</textarea>
              <div class="hint">Extra people who can be added to a trip but don't have a login here. Anyone with a shell account is already in the picker; this is only for the difference.</div>
            </div>
            <div class="field"><label>Travel policy notes</label><textarea name="policy_notes" placeholder="Optional">${esc(data.org.policy_notes || '')}</textarea></div>
            <button type="submit" class="btn btn-sm">Save org settings</button>
          </form>
        `;
        $('#orgForm #orgForm2').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const body = Object.fromEntries(fd.entries());
          try {
            await ctx.api.request(ENDPOINTS.ttSettings + '?scope=org', { method: 'PATCH', body });
            await loadAll();
            renderSettings();
          } catch (err) {
            $('#orgForm #orgErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not save')}</div>`;
          }
        });
      }

      $('#importHd').hidden = !data.canEditOrg;
      $('#importCard').hidden = !data.canEditOrg;
      if (data.canEditOrg) renderImportPanel();
    }

    async function runImport(plan, onProgress) {
      const results = { tripsCreated: 0, tripsSkipped: 0, expensesCreated: 0, errors: [] };
      const total = plan.trips.length + plan.expenses.length;
      let done = 0;
      const tick = () => { done++; if (onProgress) onProgress(done, total); };

      // Existing trips (already in the app before this import) count as
      // matches too, so re-running an import — or importing the detailed
      // export after the summary export already created trips — does not
      // create duplicates.
      const idByKey = new Map();
      data.trips.forEach((t) => idByKey.set(tripKeyOf(t.title), t.id));

      for (const trip of plan.trips) {
        if (idByKey.has(trip.key)) { results.tripsSkipped++; tick(); continue; }
        try {
          const tripRes = await ctx.api.post(ENDPOINTS.ttTrips, trip);
          const newTrip = tripRes && tripRes.trip;
          if (!newTrip) throw new Error('Server did not return the created trip');
          idByKey.set(trip.key, newTrip.id);
          results.tripsCreated++;
        } catch (err) {
          console.error('[traveltrack import] trip failed:', trip.title, err);
          results.errors.push((trip.title || 'row') + ': ' + (err && err.message ? err.message : 'could not create trip'));
        }
        tick();
      }

      for (const expense of plan.expenses) {
        const tripId = idByKey.get(expense.tripKey);
        if (!tripId) {
          results.errors.push('No trip matched "' + expense.tripTitleForDisplay + '" — expense skipped (' + fmtMoney(expense.amount) + ', ' + expense.date + ')');
          tick();
          continue;
        }
        try {
          const expRes = await ctx.api.post(ENDPOINTS.ttExpenses, {
            date: expense.date, category: expense.category, amount: expense.amount,
            payment_method: expense.payment_method, description: expense.description, trip_id: tripId
          });
          const newExpense = expRes && expRes.expense;
          if (newExpense && expense.finalStatus && expense.finalStatus !== 'pending') {
            // POST always starts an expense as "pending" (nobody can
            // self-approve on creation) — the source file's real status is
            // applied as a follow-up PATCH.
            await ctx.api.request(ENDPOINTS.ttExpenses + '?id=' + encodeURIComponent(newExpense.id), {
              method: 'PATCH', body: { status: expense.finalStatus }
            });
          }
          results.expensesCreated++;
        } catch (err) {
          console.error('[traveltrack import] expense failed:', expense.tripTitleForDisplay, err);
          results.errors.push(expense.tripTitleForDisplay + ' (' + expense.description + '): ' + (err && err.message ? err.message : 'could not create expense'));
        }
        tick();
      }

      return results;
    }

    function renderImportPanel() {
      $('#importPanel').innerHTML = `
        <div class="settings-note">
          Paste or upload a CSV or Excel-exported CSV from the standalone app.
          Two formats are recognized automatically: the trip-summary export
          (Trip Name, Attendees, budget columns, one Total Spent per trip)
          and the detailed export (Type, Category, Trip / Project — real
          itemized expenses with real Pending/Approved status), which is
          used when available for far better detail. The detailed format
          doesn't carry a trip's end date or attendee list, so those default
          to the start date / "Unknown" and are editable right in the
          preview below before anything is created. Trips matching one
          already in the app (by title) are not duplicated — only new
          expenses are added against them.
        </div>
        <div id="importErr"></div>
        <div class="field"><label>CSV file</label><input type="file" id="importFile" accept=".csv,text/csv"></div>
        <div class="field"><label>...or paste CSV</label>
          <textarea id="importPaste" placeholder="Paste CSV here..." style="min-height:90px;font-family:var(--font-mono);font-size:12px"></textarea>
        </div>
        <button class="btn btn-sm" id="importParseBtn" type="button">Preview</button>
        <div id="importPreview"></div>
      `;

      const fileInput = $('#importFile');
      const pasteArea = $('#importPaste');

      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        pasteArea.value = await file.text();
      });

      $('#importParseBtn').addEventListener('click', () => {
        const rows = parseCSV(pasteArea.value);
        $('#importErr').innerHTML = '';
        $('#importPreview').innerHTML = '';
        if (!rows.length) {
          $('#importErr').innerHTML = '<div class="form-err">No rows found. Check the file has a header row and at least one data row.</div>';
          return;
        }

        const plan = buildImportPlan(rows);
        if (plan.format === 'unknown') {
          $('#importErr').innerHTML = '<div class="form-err">Unrecognized columns — expected either "Trip Name" (summary export) or "Type" + "Category" (detailed export).</div>';
          return;
        }

        const existingKeys = new Set(data.trips.map((t) => tripKeyOf(t.title)));
        const expensesByKey = {};
        plan.expenses.forEach((e) => { (expensesByKey[e.tripKey] = expensesByKey[e.tripKey] || []).push(e); });

        $('#importPreview').innerHTML = `
          <div class="settings-note">Detected format: ${plan.format === 'detailed' ? 'detailed (itemized expenses)' : 'summary (one total per trip)'}.</div>
          <div class="tbl-wrap" style="margin-top:8px">
            <table>
              <thead><tr><th>Trip</th><th>Status</th><th>Start date</th><th>End date</th><th>Traveler</th><th>Miles</th><th class="num">Expenses</th></tr></thead>
              <tbody>
                ${plan.trips.map((trip) => {
                  const already = existingKeys.has(trip.key);
                  const lineCount = (expensesByKey[trip.key] || []).length;
                  const lineTotal = (expensesByKey[trip.key] || []).reduce((s, e) => s + e.amount, 0);
                  return `
                    <tr data-trip-key="${esc(trip.key)}">
                      <td>${esc(trip.title)}${already ? ' <span class="chip muted">already exists</span>' : ''}</td>
                      <td><span class="chip ${statusClass(normStatus(trip.status))}">${esc(labelOf(TRIP_STATUSES, normStatus(trip.status)))}</span></td>
                      <td>${fmtDate(trip.start_date)}</td>
                      <td><input type="date" class="import-end-date" data-key="${esc(trip.key)}" value="${esc(trip.end_date)}" style="padding:4px 6px;font-size:12px;width:130px"></td>
                      <td><input type="text" class="import-traveler" data-key="${esc(trip.key)}" value="${esc(trip.traveler)}" style="padding:4px 6px;font-size:12px;width:120px"></td>
                      <td><input type="number" step="0.01" min="0" class="import-miles" data-key="${esc(trip.key)}" value="${esc(trip.miles_value || 0)}" style="padding:4px 6px;font-size:12px;width:80px"></td>
                      <td class="num">${lineCount ? lineCount + ' — ' + fmtMoney(lineTotal) : '—'}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
          ${plan.expenses.length ? `
            <div class="section-hd">Expense lines (${plan.expenses.length})</div>
            <div class="tbl-wrap">
              <table>
                <thead><tr><th>Trip</th><th>Date</th><th>Category</th><th>Description</th><th>Status</th><th class="num">Amount</th></tr></thead>
                <tbody>
                  ${plan.expenses.map((e) => `
                    <tr>
                      <td>${esc(e.tripTitleForDisplay)}</td><td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td>
                      <td>${esc(e.description)}</td>
                      <td><span class="chip ${statusClass(e.finalStatus)}">${esc(labelOf(EXPENSE_STATUSES, e.finalStatus))}</span></td>
                      <td class="num">${fmtMoney(e.amount)}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          ` : ''}
          <div class="form-actions">
            <button class="btn" id="importRunBtn" type="button">Import ${plan.trips.length} trip${plan.trips.length === 1 ? '' : 's'}${plan.expenses.length ? ' and ' + plan.expenses.length + ' expense' + (plan.expenses.length === 1 ? '' : 's') : ''}</button>
          </div>
          <div id="importResult"></div>
        `;

        $('#importRunBtn').addEventListener('click', async () => {
          const btn = $('#importRunBtn');

          // Pick up any edits made to End date / Traveler / Miles in the
          // preview before locking the plan in.
          {
            const container = $('#importPreview');
            container.querySelectorAll('.import-end-date').forEach((input) => {
              const t = plan.trips.find((x) => x.key === input.dataset.key);
              if (t && input.value) t.end_date = input.value;
            });
            container.querySelectorAll('.import-traveler').forEach((input) => {
              const t = plan.trips.find((x) => x.key === input.dataset.key);
              if (t && input.value.trim()) { t.traveler = input.value.trim(); t.traveler_name = input.value.trim(); }
            });
            container.querySelectorAll('.import-miles').forEach((input) => {
              const t = plan.trips.find((x) => x.key === input.dataset.key);
              if (t) { const v = Number(input.value); t.miles_value = Number.isNaN(v) || v < 0 ? 0 : v; }
            });
          }

          const total = plan.trips.length + plan.expenses.length;
          btn.disabled = true;
          btn.textContent = 'Importing 0 of ' + total + '…';
          $('#importResult').innerHTML = '';
          try {
            const results = await runImport(plan, (done, tot) => {
              btn.textContent = 'Importing ' + done + ' of ' + tot + '…';
            });
            await loadAll();
            renderDashboard();
            $('#importResult').innerHTML = `
              <div class="settings-note" style="margin-top:12px">
                Created ${results.tripsCreated} trip${results.tripsCreated === 1 ? '' : 's'}
                ${results.tripsSkipped ? '(' + results.tripsSkipped + ' already existed, skipped)' : ''}
                and ${results.expensesCreated} expense${results.expensesCreated === 1 ? '' : 's'}.
                ${results.errors.length ? '<br>Errors: ' + results.errors.map((e) => esc(e)).join('; ') : ''}
              </div>`;
            btn.textContent = 'Done';
            renderTrips();
            renderExpenses();
          } catch (err) {
            // Should not happen — runImport catches per-row — but if
            // something outside that loop throws (a network drop mid-reload,
            // for instance), show it instead of leaving the button stuck on
            // "Importing…" with no explanation.
            console.error('[traveltrack import] unexpected failure:', err);
            $('#importResult').innerHTML = `<div class="form-err">Import stopped unexpectedly: ${esc(err && err.message ? err.message : String(err))}. Check the browser console for detail, and check the Trips tab — some rows may have been created before this happened.</div>`;
            btn.disabled = false;
            btn.textContent = 'Retry';
          }
        });
      });
    }

    /* ---------------- Wiring ---------------- */

    $('#dashNewTrip').addEventListener('click', () => openTripPanel(null));
    $('#dashNewExpense').addEventListener('click', () => openExpensePanel(null));
    $('#dashLogMiles').addEventListener('click', () => openRedeemPanel());
    $('#dashRange').addEventListener('change', (e) => { filters.dashRange = e.target.value; renderDashboard(); });
    $('#dashCustomize').addEventListener('click', () => {
      const panel = $('#dashCustomizePanel');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderDashCustomize();
    });
    $('#tripsNewBtn').addEventListener('click', () => openTripPanel(null));
    $('#tripsExportBtn').addEventListener('click', exportTripsCSV);
    $('#expNewBtn').addEventListener('click', () => openExpensePanel(null));
    $('#expExportBtn').addEventListener('click', exportExpensesCSV);
    $('#reportsExportBtn').addEventListener('click', exportReportsCSV);
    $('#reportsYear').addEventListener('change', (e) => { reportsYear = Number(e.target.value); renderReports(); });

    await loadAll();
    renderDashboard();

    // Exposed so showView() can render lazily on first visit to each tab.
    this._renders = { trips: renderTrips, expenses: renderExpenses, miles: renderMiles, reports: renderReports, settings: renderSettings };
    this._rendered = { dashboard: true };
    // Exposed for the deep-link opener below — same reasoning as _renders,
    // showView() runs outside mount()'s closure.
    this._data = data;
    this._openExpensePanel = openExpensePanel;
  },

  showView(view, param) {
    const root = this._root;
    if (!root) return;
    const ids = { dashboard: 'ttDash', trips: 'ttTrips', expenses: 'ttExpenses', miles: 'ttMiles', reports: 'ttReports', settings: 'ttSettings' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders[view]) this._renders[view]();

    // A route param is a deep link into one specific expense — a
    // Notification carrying a link to it opens straight to that expense's
    // panel (Ryan's ask, Aug 2026), same idea as BackBone's lead/inquiry
    // links. mount() awaits loadAll() before this can run, so data.expenses
    // is already populated — no retry needed the way BackBone's leads/inbox
    // background loads required.
    if (view === 'expenses' && param) {
      const exp = this._data && this._data.expenses.find((e) => e.id === param);
      if (exp) this._openExpensePanel(exp);
    }
  },

  unmount() {
    // No document-level listeners were attached; nothing to tear down.
  }
};
