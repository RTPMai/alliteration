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
  ['planned', 'Planned'],
  ['in_progress', 'In progress'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled']
];

const TRIP_PURPOSES = [
  'Client visit', 'Trade show', 'Sales call', 'Training/conference', 'Vendor visit', 'Other'
];

const EXPENSE_STATUSES = [
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['reimbursed', 'Reimbursed']
];

const LOYALTY_TYPES = [
  ['airline', 'Airline'],
  ['hotel', 'Hotel'],
  ['rental_car', 'Rental car'],
  ['other', 'Other']
];

const LOYALTY_UNITS = [['miles', 'Miles'], ['points', 'Points']];

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
  if (status === 'approved') return 'ok';
  if (status === 'reimbursed') return 'ok';
  if (status === 'rejected') return 'bad';
  if (status === 'in_progress') return 'ok';
  if (status === 'cancelled') return 'bad';
  return 'muted';
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

const IMPORT_STATUS_MAP = { 'attended': 'completed', 'did not attend': 'cancelled' };
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
      const status = IMPORT_STATUS_MAP[String(row['Status'] || '').trim().toLowerCase()] || 'completed';
      const startDate = String(row['Date'] || '').trim();
      const traveler = String(row['Created By'] || '').trim() || 'Unknown';
      trips.push({
        key: tripKeyOf(title), title, destination: String(row['Destination'] || '').trim(),
        purpose: 'Other', start_date: startDate, end_date: startDate, status,
        notes: 'Imported from the standalone TravelTrack export.',
        traveler, traveler_name: traveler
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
    const status = IMPORT_STATUS_MAP[String(row['Status'] || '').trim().toLowerCase()] || 'completed';

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
      notes: notesLines.join('\n'), traveler: primary, traveler_name: primary
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

  /* ---------- loyalty cards ---------- */
  .ly-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}
  .ly-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius-md);padding:18px;cursor:pointer;transition:.12s}
  .ly-card:hover{border-color:var(--faint);box-shadow:var(--shadow-card)}
  .ly-card .type{font-size:11px;font-weight:700;color:var(--accent-deep);text-transform:uppercase;letter-spacing:.04em}
  .ly-card h3{font-size:16px;font-weight:700;margin:4px 0 10px}
  .ly-card .bal{font-size:26px;font-weight:800;letter-spacing:-.02em}
  .ly-card .unit{font-size:12px;color:var(--muted);font-weight:600}
  .ly-card .owner{font-size:11.5px;color:var(--muted);margin-top:8px}

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
          <button class="btn ghost" id="dashNewTrip">+ New trip</button>
          <button class="btn" id="dashNewExpense">+ New expense</button>
        </div>
      </div>
      <div class="kpis" id="dashKpis"></div>
      <div class="grid2">
        <div class="card">
          <div class="card-hd"><h3>Recent trips</h3><span class="meta" id="dashTripsMeta"></span></div>
          <div class="card-bd" id="dashTrips"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3>Recent expenses</h3><span class="meta" id="dashExpMeta"></span></div>
          <div class="card-bd" id="dashExp"></div>
        </div>
      </div>
    </div>

    <div class="page" id="ttTrips" hidden>
      <div class="page-hd">
        <div><h1>Trips.</h1><div class="sub" id="tripsSub"></div></div>
        <div class="tools"><button class="btn" id="tripsNewBtn">+ New trip</button></div>
      </div>
      <div class="filters" id="tripsFilters"></div>
      <div class="tbl-wrap"><div id="tripsTbl"></div></div>
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
        <div><h1>Redeem Miles.</h1><div class="sub" id="milesSub"></div></div>
        <div class="tools"><button class="btn" id="milesNewBtn">+ Add account</button></div>
      </div>
      <div class="ly-grid" id="milesGrid"></div>
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
      <div class="grid2">
        <div class="card">
          <div class="card-hd"><h3>Spend by category</h3></div>
          <div class="card-bd" id="reportsByCat"></div>
        </div>
        <div class="card">
          <div class="card-hd"><h3 id="reportsByWhoHd">Spend by month</h3></div>
          <div class="card-bd" id="reportsByWho"></div>
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

    const data = { trips: [], expenses: [], accounts: [], org: null, account: null, canEditOrg: false };
    const filters = { trips: 'active', expenses: 'pending', expensesMine: !seesAll };
    let reportsYear = new Date().getFullYear();

    async function loadAll() {
      const [tripsRes, expRes, milesRes, settingsRes] = await Promise.all([
        ctx.api.get(ENDPOINTS.ttTrips),
        ctx.api.get(ENDPOINTS.ttExpenses),
        ctx.api.get(ENDPOINTS.ttMiles),
        ctx.api.get(ENDPOINTS.ttSettings)
      ]);
      data.trips = (tripsRes && tripsRes.trips) || [];
      data.expenses = (expRes && expRes.expenses) || [];
      data.accounts = (milesRes && milesRes.accounts) || [];
      data.org = (settingsRes && settingsRes.org) || { mileage_rate: 0.67, per_diem_rate: 0, approval_threshold: 500, policy_notes: '' };
      data.account = (settingsRes && settingsRes.account) || { home_airport: '', default_payment_method: 'personal_reimburse' };
      data.canEditOrg = !!(settingsRes && settingsRes.can_edit_org);
    }

    function tripLabel(id) {
      const t = data.trips.find((x) => x.id === id);
      return t ? t.title : null;
    }

    function expensesForTrip(id) {
      return data.expenses.filter((e) => e.trip_id === id);
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

    /* ---------------- Trip form/detail ---------------- */

    function tripFormHtml(trip) {
      const isEdit = !!trip;
      const t = trip || { title: '', destination: '', purpose: 'Client visit', start_date: today(), end_date: today(), status: 'planned', notes: '' };
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
            <div class="field"><label>Status</label><select name="status">${TRIP_STATUSES.map(([v, l]) => `<option value="${v}"${v === t.status ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
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

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = Object.fromEntries(fd.entries());
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

    function openExpensePanel(exp, prefillTripId) {
      openPanel(expenseFormHtml(exp, prefillTripId));
      panelIn.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));

      const catSel = panelIn.querySelector('#expCategory');
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

    /* ---------------- Loyalty (miles) form/detail ---------------- */

    function loyaltyFormHtml(acc) {
      const isEdit = !!acc;
      const a = acc || { program_type: 'airline', program_name: '', account_number: '', balance: 0, balance_unit: 'miles', notes: '' };
      return `
        <div class="panel-top">
          <div><h2>${isEdit ? 'Edit account' : 'Add loyalty account'}</h2><div class="sub">${isEdit ? esc(a.owner_name || '') : 'Track a frequent flyer or hotel program'}</div></div>
          <button class="x" data-close>&times;</button>
        </div>
        <div id="lyFormErr"></div>
        <form id="lyForm">
          <div class="field-row">
            <div class="field"><label>Program type</label><select name="program_type">${LOYALTY_TYPES.map(([v, l]) => `<option value="${v}"${v === a.program_type ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
            <div class="field"><label>Unit</label><select name="balance_unit">${LOYALTY_UNITS.map(([v, l]) => `<option value="${v}"${v === a.balance_unit ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          </div>
          <div class="field"><label>Program name</label><input name="program_name" value="${esc(a.program_name)}" placeholder="Delta SkyMiles" required></div>
          <div class="field"><label>Account number</label><input name="account_number" value="${esc(a.account_number || '')}" placeholder="Optional"></div>
          <div class="field"><label>Balance</label><input type="number" step="1" min="0" name="balance" value="${esc(a.balance)}"></div>
          <div class="field"><label>Notes</label><textarea name="notes" placeholder="Optional">${esc(a.notes || '')}</textarea></div>
          <div class="form-actions">
            <button type="submit" class="btn">${isEdit ? 'Save' : 'Add account'}</button>
            <button type="button" class="btn ghost" data-close>Cancel</button>
            ${isEdit ? '<button type="button" class="btn danger" id="lyDeleteBtn" style="margin-left:auto">Delete</button>' : ''}
          </div>
        </form>
        ${isEdit ? loyaltyRedemptionsHtml(a) : ''}
      `;
    }

    function loyaltyRedemptionsHtml(a) {
      const redemptions = a.redemptions || [];
      return `
        <div class="section-hd">Log a redemption</div>
        <form id="redeemForm">
          <div class="field-row">
            <div class="field"><label>Amount</label><input type="number" step="1" min="1" name="amount_redeemed" required></div>
            <div class="field"><label>Est. cash value</label><input type="number" step="0.01" min="0" name="est_value" placeholder="Optional"></div>
          </div>
          <div class="field"><label>What for</label><input name="description" placeholder="Companion ticket to Denver" required></div>
          <button type="submit" class="btn btn-sm">Log redemption</button>
        </form>
        <div class="section-hd">History</div>
        ${redemptions.length ? `
          <div class="tbl-wrap"><table><tbody>
            ${redemptions.slice().reverse().map((r) => `
              <tr><td>${fmtDate(r.date)}</td><td>${esc(r.description)}</td><td class="num">${Number(r.amount_redeemed).toLocaleString()}</td></tr>
            `).join('')}
          </tbody></table></div>
        ` : '<div class="empty" style="padding:20px 0">No redemptions logged yet.</div>'}
      `;
    }

    function openLoyaltyPanel(acc) {
      openPanel(loyaltyFormHtml(acc));
      panelIn.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanel));

      const form = panelIn.querySelector('#lyForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = Object.fromEntries(fd.entries());
        const submitBtn = form.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        try {
          if (acc) {
            await ctx.api.request(ENDPOINTS.ttMiles + '?id=' + encodeURIComponent(acc.id), { method: 'PATCH', body });
          } else {
            await ctx.api.post(ENDPOINTS.ttMiles, body);
          }
          await loadAll();
          closePanel();
          renderMiles();
        } catch (err) {
          panelIn.querySelector('#lyFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not save account')}</div>`;
          submitBtn.disabled = false;
        }
      });

      const delBtn = panelIn.querySelector('#lyDeleteBtn');
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm('Delete this loyalty account?')) return;
          try {
            await ctx.api.request(ENDPOINTS.ttMiles + '?id=' + encodeURIComponent(acc.id), { method: 'DELETE' });
            await loadAll();
            closePanel();
            renderMiles();
          } catch (err) {
            panelIn.querySelector('#lyFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not delete account')}</div>`;
          }
        });
      }

      const redeemForm = panelIn.querySelector('#redeemForm');
      if (redeemForm) {
        redeemForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(redeemForm);
          const body = Object.fromEntries(fd.entries());
          try {
            await ctx.api.post(ENDPOINTS.ttMiles + '?id=' + encodeURIComponent(acc.id) + '&action=redeem', body);
            await loadAll();
            const fresh = data.accounts.find((x) => x.id === acc.id);
            openLoyaltyPanel(fresh || acc);
            renderMiles();
          } catch (err) {
            panelIn.querySelector('#lyFormErr').innerHTML = `<div class="form-err">${esc(err.message || 'Could not log redemption')}</div>`;
          }
        });
      }
    }

    /* ---------------- Dashboard ---------------- */

    function renderDashboard() {
      const mine = (r, field) => seesAll || r[field] === me;
      const myTrips = data.trips.filter((t) => mine(t, 'traveler'));
      const myExpenses = data.expenses.filter((e) => mine(e, 'submitted_by'));

      const upcoming = myTrips.filter((t) => t.status === 'planned' || t.status === 'in_progress').length;
      const yr = new Date().getFullYear();
      const ytdTotal = myExpenses.filter((e) => String(e.date).slice(0, 4) === String(yr)).reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const pending = myExpenses.filter((e) => e.status === 'pending');
      const pendingTotal = pending.reduce((s, e) => s + (Number(e.amount) || 0), 0);

      const kpis = [
        [String(upcoming), 'Upcoming trips'],
        [fmtMoney(ytdTotal), 'YTD spend'],
        [String(pending.length), 'Pending expenses'],
        [fmtMoney(pendingTotal), 'Awaiting approval']
      ];
      $('#dashKpis').innerHTML = kpis.map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');
      $('#dashSub').textContent = seesAll ? "The whole team's trips and expenses." : 'Your trips and expenses.';

      const recentTrips = myTrips.slice().sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).slice(0, 5);
      $('#dashTripsMeta').textContent = myTrips.length + ' total';
      $('#dashTrips').innerHTML = recentTrips.length ? recentTrips.map((t) => `
        <div class="mini-row"><div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.destination)} · ${fmtDate(t.start_date)}</div></div>
        <span class="chip ${statusClass(t.status)}">${esc(labelOf(TRIP_STATUSES, t.status))}</span></div>
      `).join('') : '<div class="empty">No trips yet.</div>';

      const recentExp = myExpenses.slice().sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
      $('#dashExpMeta').textContent = myExpenses.length + ' total';
      $('#dashExp').innerHTML = recentExp.length ? recentExp.map((e) => `
        <div class="mini-row"><div><div class="t">${esc(e.category)} · ${fmtMoney(e.amount)}</div><div class="s">${esc(e.description || '—')}</div></div>
        <span class="chip ${statusClass(e.status)}">${esc(labelOf(EXPENSE_STATUSES, e.status))}</span></div>
      `).join('') : '<div class="empty">No expenses yet.</div>';
    }

    /* ---------------- Trips view ---------------- */

    const TRIP_FILTERS = [['active', 'Active'], ['completed', 'Completed'], ['all', 'All']];

    function renderTripsFilters() {
      $('#tripsFilters').innerHTML = TRIP_FILTERS.map(([k, l]) =>
        `<button class="filt" data-filt="${k}" aria-pressed="${filters.trips === k}">${esc(l)}</button>`).join('');
      $$('#tripsFilters [data-filt]').forEach((b) => b.addEventListener('click', () => {
        filters.trips = b.dataset.filt;
        renderTrips();
      }));
    }

    function renderTrips() {
      renderTripsFilters();
      let rows = seesAll ? data.trips.slice() : data.trips.filter((t) => t.traveler === me);
      if (filters.trips === 'active') rows = rows.filter((t) => t.status === 'planned' || t.status === 'in_progress');
      if (filters.trips === 'completed') rows = rows.filter((t) => t.status === 'completed');
      rows.sort((a, b) => String(b.start_date).localeCompare(String(a.start_date)));

      $('#tripsSub').textContent = rows.length + (rows.length === 1 ? ' trip' : ' trips');

      if (!rows.length) {
        $('#tripsTbl').innerHTML = '<div class="empty"><h3>No trips here</h3><p>Try a different filter, or plan a new one.</p></div>';
        return;
      }

      $('#tripsTbl').innerHTML = `
        <table>
          <thead><tr><th>Trip</th><th>Destination</th><th>Dates</th><th>Purpose</th>${seesAll ? '<th>Traveler</th>' : ''}<th>Status</th><th class="num">Spent</th></tr></thead>
          <tbody>
            ${rows.map((t) => {
              const spent = expensesForTrip(t.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
              return `
                <tr class="clickable" data-trip="${esc(t.id)}">
                  <td>${esc(t.title)}</td><td>${esc(t.destination)}</td>
                  <td>${fmtDate(t.start_date)}${t.end_date && t.end_date !== t.start_date ? ' – ' + fmtDate(t.end_date) : ''}</td>
                  <td>${esc(t.purpose)}</td>
                  ${seesAll ? `<td>${esc(t.traveler_name || t.traveler)}</td>` : ''}
                  <td><span class="chip ${statusClass(t.status)}">${esc(labelOf(TRIP_STATUSES, t.status))}</span></td>
                  <td class="num">${fmtMoney(spent)}</td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>`;

      $$('#tripsTbl [data-trip]').forEach((row) => row.addEventListener('click', () => {
        const trip = data.trips.find((t) => t.id === row.dataset.trip);
        if (trip) openTripPanel(trip);
      }));
    }

    /* ---------------- Expenses view ---------------- */

    const EXP_FILTERS = [['pending', 'Pending'], ['approved', 'Approved'], ['reimbursed', 'Reimbursed'], ['rejected', 'Rejected'], ['all', 'All']];

    function renderExpFilters() {
      let html = EXP_FILTERS.map(([k, l]) =>
        `<button class="filt" data-filt="${k}" aria-pressed="${filters.expenses === k}">${esc(l)}</button>`).join('');
      if (seesAll) {
        html += `<button class="filt" data-mine aria-pressed="${filters.expensesMine}" style="margin-left:8px">My expenses only</button>`;
      }
      $('#expFilters').innerHTML = html;
      $$('#expFilters [data-filt]').forEach((b) => b.addEventListener('click', () => { filters.expenses = b.dataset.filt; renderExpenses(); }));
      const mineBtn = $('#expFilters [data-mine]');
      if (mineBtn) mineBtn.addEventListener('click', () => { filters.expensesMine = !filters.expensesMine; renderExpenses(); });
    }

    function filteredExpenses() {
      let rows = seesAll ? data.expenses.slice() : data.expenses.filter((e) => e.submitted_by === me);
      if (seesAll && filters.expensesMine) rows = rows.filter((e) => e.submitted_by === me);
      if (filters.expenses !== 'all') rows = rows.filter((e) => e.status === filters.expenses);
      rows.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return rows;
    }

    function renderExpenses() {
      renderExpFilters();
      const rows = filteredExpenses();
      $('#expSub').textContent = rows.length + (rows.length === 1 ? ' expense' : ' expenses') + ' · ' + fmtMoney(rows.reduce((s, e) => s + (Number(e.amount) || 0), 0));

      if (!rows.length) {
        $('#expTbl').innerHTML = '<div class="empty"><h3>No expenses here</h3><p>Try a different filter, or log a new one.</p></div>';
        return;
      }

      $('#expTbl').innerHTML = `
        <table>
          <thead><tr><th>Date</th><th>Category</th><th>Description</th>${seesAll ? '<th>Submitted by</th>' : ''}<th>Trip</th><th>Payment</th><th class="num">Amount</th><th>Status</th></tr></thead>
          <tbody>
            ${rows.map((e) => `
              <tr class="clickable" data-exp="${esc(e.id)}">
                <td>${fmtDate(e.date)}</td><td>${esc(e.category)}</td><td>${esc(e.description || '—')}</td>
                ${seesAll ? `<td>${esc(e.submitted_by_name || e.submitted_by)}</td>` : ''}
                <td>${esc(tripLabel(e.trip_id) || '—')}</td>
                <td>${esc(labelOf(PAYMENT_METHODS, e.payment_method))}</td>
                <td class="num">${fmtMoney(e.amount)}</td>
                <td><span class="chip ${statusClass(e.status)}">${esc(labelOf(EXPENSE_STATUSES, e.status))}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>`;

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

    /* ---------------- Miles view ---------------- */

    function renderMiles() {
      const accounts = seesAll ? data.accounts : data.accounts.filter((a) => a.username === me);
      $('#milesSub').textContent = accounts.length + (accounts.length === 1 ? ' account' : ' accounts');
      if (!accounts.length) {
        $('#milesGrid').innerHTML = '<div class="empty"><h3>No loyalty accounts yet</h3><p>Add a frequent flyer or hotel program to track balances.</p></div>';
        return;
      }
      $('#milesGrid').innerHTML = accounts.map((a) => `
        <div class="ly-card" data-ly="${esc(a.id)}">
          <div class="type">${esc(labelOf(LOYALTY_TYPES, a.program_type))}</div>
          <h3>${esc(a.program_name)}</h3>
          <div class="bal">${Number(a.balance || 0).toLocaleString()} <span class="unit">${esc(labelOf(LOYALTY_UNITS, a.balance_unit))}</span></div>
          ${seesAll ? `<div class="owner">${esc(a.owner_name || a.username)}</div>` : ''}
        </div>
      `).join('');
      $$('#milesGrid [data-ly]').forEach((card) => card.addEventListener('click', () => {
        const acc = data.accounts.find((a) => a.id === card.dataset.ly);
        if (acc) openLoyaltyPanel(acc);
      }));
    }

    /* ---------------- Reports view ---------------- */

    function renderReportsYearOptions() {
      const years = new Set(data.expenses.map((e) => String(e.date).slice(0, 4)).filter(Boolean));
      years.add(String(reportsYear));
      const sorted = Array.from(years).sort().reverse();
      $('#reportsYear').innerHTML = sorted.map((y) => `<option value="${y}"${Number(y) === reportsYear ? ' selected' : ''}>${y}</option>`).join('');
    }

    function reportRows() {
      const scoped = seesAll ? data.expenses : data.expenses.filter((e) => e.submitted_by === me);
      return scoped.filter((e) => String(e.date).slice(0, 4) === String(reportsYear));
    }

    function renderReports() {
      renderReportsYearOptions();
      const rows = reportRows();
      const total = rows.reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const pending = rows.filter((e) => e.status === 'pending').reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const reimbursed = rows.filter((e) => e.status === 'reimbursed').reduce((s, e) => s + (Number(e.amount) || 0), 0);
      const tripCount = new Set(rows.map((e) => e.trip_id).filter(Boolean)).size;

      $('#reportsSub').textContent = seesAll ? "Team spend for " + reportsYear + "." : "Your spend for " + reportsYear + ".";
      $('#reportsKpis').innerHTML = [
        [fmtMoney(total), 'Total spend'],
        [fmtMoney(pending), 'Awaiting approval'],
        [fmtMoney(reimbursed), 'Reimbursed'],
        [String(tripCount), 'Trips with expenses']
      ].map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');

      const byCat = {};
      rows.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + (Number(e.amount) || 0); });
      const catEntries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
      const maxCat = catEntries.length ? catEntries[0][1] : 0;
      $('#reportsByCat').innerHTML = catEntries.length ? catEntries.map(([cat, amt]) => `
        <div class="bar-row">
          <div class="top"><span class="lab">${esc(cat)}</span><span>${fmtMoney(amt)}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${maxCat ? Math.round(amt / maxCat * 100) : 0}%"></div></div>
        </div>
      `).join('') : '<div class="empty">No expenses in ' + reportsYear + '.</div>';

      if (seesAll) {
        $('#reportsByWhoHd').textContent = 'Spend by traveler';
        const byWho = {};
        rows.forEach((e) => { const k = e.submitted_by_name || e.submitted_by; byWho[k] = (byWho[k] || 0) + (Number(e.amount) || 0); });
        const whoEntries = Object.entries(byWho).sort((a, b) => b[1] - a[1]);
        const maxWho = whoEntries.length ? whoEntries[0][1] : 0;
        $('#reportsByWho').innerHTML = whoEntries.length ? whoEntries.map(([who, amt]) => `
          <div class="bar-row">
            <div class="top"><span class="lab">${esc(who)}</span><span>${fmtMoney(amt)}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${maxWho ? Math.round(amt / maxWho * 100) : 0}%"></div></div>
          </div>
        `).join('') : '<div class="empty">No expenses in ' + reportsYear + '.</div>';
      } else {
        $('#reportsByWhoHd').textContent = 'Spend by month';
        const byMonth = {};
        rows.forEach((e) => { const k = String(e.date).slice(0, 7); byMonth[k] = (byMonth[k] || 0) + (Number(e.amount) || 0); });
        const monthEntries = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]));
        const maxMonth = monthEntries.length ? Math.max(...monthEntries.map((m) => m[1])) : 0;
        $('#reportsByWho').innerHTML = monthEntries.length ? monthEntries.map(([m, amt]) => `
          <div class="bar-row">
            <div class="top"><span class="lab">${esc(m)}</span><span>${fmtMoney(amt)}</span></div>
            <div class="bar-track"><div class="bar-fill" style="width:${maxMonth ? Math.round(amt / maxMonth * 100) : 0}%"></div></div>
          </div>
        `).join('') : '<div class="empty">No expenses in ' + reportsYear + '.</div>';
      }
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
              <thead><tr><th>Trip</th><th>Status</th><th>Start date</th><th>End date</th><th>Traveler</th><th class="num">Expenses</th></tr></thead>
              <tbody>
                ${plan.trips.map((trip) => {
                  const already = existingKeys.has(trip.key);
                  const lineCount = (expensesByKey[trip.key] || []).length;
                  const lineTotal = (expensesByKey[trip.key] || []).reduce((s, e) => s + e.amount, 0);
                  return `
                    <tr data-trip-key="${esc(trip.key)}">
                      <td>${esc(trip.title)}${already ? ' <span class="chip muted">already exists</span>' : ''}</td>
                      <td><span class="chip ${statusClass(trip.status)}">${esc(labelOf(TRIP_STATUSES, trip.status))}</span></td>
                      <td>${fmtDate(trip.start_date)}</td>
                      <td><input type="date" class="import-end-date" data-key="${esc(trip.key)}" value="${esc(trip.end_date)}" style="padding:4px 6px;font-size:12px;width:130px"></td>
                      <td><input type="text" class="import-traveler" data-key="${esc(trip.key)}" value="${esc(trip.traveler)}" style="padding:4px 6px;font-size:12px;width:120px"></td>
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

          // Pick up any edits made to End date / Traveler in the preview
          // before locking the plan in.
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
    $('#tripsNewBtn').addEventListener('click', () => openTripPanel(null));
    $('#expNewBtn').addEventListener('click', () => openExpensePanel(null));
    $('#milesNewBtn').addEventListener('click', () => openLoyaltyPanel(null));
    $('#expExportBtn').addEventListener('click', exportExpensesCSV);
    $('#reportsExportBtn').addEventListener('click', exportReportsCSV);
    $('#reportsYear').addEventListener('change', (e) => { reportsYear = Number(e.target.value); renderReports(); });

    await loadAll();
    renderDashboard();

    // Exposed so showView() can render lazily on first visit to each tab.
    this._renders = { trips: renderTrips, expenses: renderExpenses, miles: renderMiles, reports: renderReports, settings: renderSettings };
    this._rendered = { dashboard: true };
  },

  showView(view) {
    const root = this._root;
    if (!root) return;
    const ids = { dashboard: 'ttDash', trips: 'ttTrips', expenses: 'ttExpenses', miles: 'ttMiles', reports: 'ttReports', settings: 'ttSettings' };
    Object.entries(ids).forEach(([v, id]) => {
      const el = root.querySelector('#' + id);
      if (el) el.hidden = v !== view;
    });
    if (this._renders[view]) this._renders[view]();
  },

  unmount() {
    // No document-level listeners were attached; nothing to tear down.
  }
};
