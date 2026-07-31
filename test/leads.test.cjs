/**
 * Leads pipeline contract tests.
 *
 * Locks the Jul 30, 2026 rework driven by the sales director's review:
 * exit buckets (Reach Back Out / Won / Lost, never delete), the timestamped
 * status trail, the Scored-vs-Qualified KPI fix, normalized duplicate checks
 * ("Gino's" vs "Ginos"), split contact names, AM routing per the reference
 * sheet, and the three-signal bot screen on the Inbox.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('apps/backbone/main.js');
const template = read('apps/backbone/template.js');
const styles = read('apps/backbone/styles.js');
const qualify = read('api/qualify.js');

/* ---- statuses and exit buckets ------------------------------------------ */

t.test('lead statuses include Reach Back Out and Lost, not Dead', () => {
  const m = main.match(/const LEAD_STATUSES = \[([^\]]+)\]/);
  t.assert(m, 'LEAD_STATUSES not found');
  t.assert(m[1].includes('"Reach Back Out"'), 'Reach Back Out missing from LEAD_STATUSES');
  t.assert(m[1].includes('"Lost"'), 'Lost missing from LEAD_STATUSES');
  t.assert(!m[1].includes('"Dead"'), '"Dead" is retired and must not be offered as a status');
});

t.test('legacy Dead statuses are normalized to Lost on load', () => {
  t.assert(main.includes('function normalizeLeadStatus'), 'normalizeLeadStatus helper missing');
  t.assert(/normalizeLeadStatus\(l\.status\)/.test(main), 'loadLeads no longer normalizes legacy statuses');
});

t.test('every status write goes through the history helper', () => {
  t.assert(main.includes('function setLeadStatus'), 'setLeadStatus helper missing');
  // Direct assignment outside the helper reintroduces the untraceable-status bug.
  const direct = main.match(/(?:^|\n)\s*(?:lead|l)\.status = "(?!New")/g) || [];
  const allowed = direct.filter((s) => !s.includes('setLeadStatus'));
  t.equal(allowed.length, 0, 'found direct lead.status writes that bypass setLeadStatus');
  t.assert(main.includes('status_history'), 'status_history trail missing');
});

t.test('Reach Back Out asks for a date and surfaces when due', () => {
  t.assert(main.includes('promptReachBackDate'), 'reach-back date prompt missing');
  t.assert(main.includes('reach_back_at'), 'reach_back_at field missing');
  t.assert(main.includes('function reachBackDue'), 'reachBackDue helper missing');
  // No date must mean due NOW, not invisible forever.
  t.assert(/if \(!lead\.reach_back_at\) return true;/.test(main),
    'a dateless Reach Back Out lead must count as due');
});

t.test('stalled AM Notified leads get flagged', () => {
  t.assert(main.includes('AM_NOTIFIED_STALE_DAYS'), 'stale threshold constant missing');
  t.assert(main.includes('statusAgeChip'), 'status age chip missing');
});

/* ---- deletion is role-gated --------------------------------------------- */

t.test('lead deletion is admin/superuser only', () => {
  t.assert(main.includes('CAN_DELETE_LEADS'), 'CAN_DELETE_LEADS gate missing');
  t.assert(/CAN_DELETE_LEADS\s*\?\s*'<button id="bulkDeleteBtn"/.test(main),
    'bulk delete button is not gated on CAN_DELETE_LEADS');
  t.assert(/handleBulkDeleteLeads\(\) \{\s*\n\s*if \(!CAN_DELETE_LEADS\) return;/.test(main),
    'bulk delete handler is not guarded');
  t.assert(/handleDeleteLead\(\) \{\s*\n\s*if \(!CAN_DELETE_LEADS\) return;/.test(main),
    'detail delete handler is not guarded');
});

/* ---- KPI naming ---------------------------------------------------------- */

t.test('the agent-scored KPI is labeled Scored, not Qualified', () => {
  t.assert(main.includes('kpi-lbl">Scored'), 'Scored KPI label missing');
  t.assert(!main.includes('kpi-lbl">Qualified'),
    'a KPI labeled "Qualified" collides with the funnel stage of the same name');
});

/* ---- duplicate detection -------------------------------------------------- */

t.test('duplicate checks normalize punctuation and suffixes', () => {
  // handleAddLead and the JSON-create path must both compare via normalizeCo,
  // so "Gino\'s" and "Ginos" collide.
  const uses = (main.match(/normalizeCo\((?:c|l)\.company_name\)/g) || []).length;
  t.assert(uses >= 3, 'expected roster + pipeline dup checks to use normalizeCo (found ' + uses + ' uses)');
  t.assert(!/c\.company_name\.toLowerCase\(\) === name\.toLowerCase\(\)/.test(main),
    'a raw lowercase-only duplicate check survived');
});

/* ---- contact names -------------------------------------------------------- */

t.test('lead forms capture first and last name separately', () => {
  t.assert(template.includes('id="leadContactFirst"'), 'add form first-name field missing');
  t.assert(template.includes('id="leadContactLast"'), 'add form last-name field missing');
  t.assert(!template.includes('id="leadContactName"'), 'single-name field should be gone from the add form');
  t.assert(main.includes('id="editLeadFirst"'), 'edit form first-name field missing');
  t.assert(main.includes('id="editLeadLast"'), 'edit form last-name field missing');
  t.assert(main.includes('contact_first_name: $id("leadContactFirst")'), 'add handler does not store split names');
});

t.test('promote maps first/last instead of stuffing the full name into first', () => {
  t.assert(!/contact_first_name: lead\.contact_name \|\| ""/.test(main),
    'promote still writes the whole contact name into contact_first_name');
  t.assert(/contact_last_name: lead\.contact_last_name/.test(main),
    'promote does not carry contact_last_name');
});

/* ---- AM routing per the Jul 2026 reference sheet -------------------------- */

t.test('routing matches the AM reference sheet', () => {
  const lane = (name) => {
    const re = new RegExp('\\{ industry: "' + name.replace(/[/&]/g, (c) => '\\' + c) + '", am: ("[^"]*"|null)');
    const m = main.match(re);
    t.assert(m, 'lane missing: ' + name);
    return m[1];
  };
  t.equal(lane('Cities/Associations'), '"Alexis Davis"', 'Cities/Associations must route to Alexis');
  t.equal(lane('Heathcare & Wellness'), '"Alexis Davis"', 'Healthcare/Wellness must route to Alexis');
  t.equal(lane('Food & Hospitality'), '"Hannah Posey"', 'Food & Hospitality must route to Hannah');
  t.equal(lane('Corporate/Small Business'), '"Abby Penton"', 'Corporate/Small Business must default to Abby');
  t.equal(lane('Events'), '"Abby Penton"', 'Events must default to Abby');
});

/* ---- event of origin and marketing initiative ----------------------------- */

t.test('event of origin and marketing initiative fields exist end to end', () => {
  t.assert(template.includes('id="leadSourceEvent"'), 'add form event-of-origin field missing');
  t.assert(main.includes('source_event: $id("leadSourceEvent")'), 'add handler does not store source_event');
  t.assert(main.includes('id="editLeadSourceEvent"'), 'edit form event-of-origin field missing');
  t.assert(main.includes('MARKETING_INITIATIVES'), 'marketing initiative list missing');
  t.assert(main.includes('id="editLeadInitiative"'), 'edit form initiative dropdown missing');
});

/* ---- pipeline usability ---------------------------------------------------- */

t.test('My leads toggle and two-level sort are wired', () => {
  t.assert(template.includes('id="myLeadsBtn"'), 'My leads button missing from template');
  t.assert(main.includes('myLeadsOnly'), 'My leads state missing');
  t.assert(main.includes('leadsSortPrev'), 'secondary sort state missing');
  t.assert(main.includes('function myAMName'), 'AM identity helper missing');
});

t.test('hover explainers exist and have styling', () => {
  t.assert(main.includes('function infoI'), 'infoI helper missing');
  t.assert(styles.includes('.info-i'), '.info-i style missing');
});

t.test('new status pills and chips have styles', () => {
  t.assert(styles.includes('.lead-status-Lost'), 'Lost pill style missing');
  t.assert(styles.includes('.lead-status-ReachBackOut'), 'Reach Back Out pill style missing');
  t.assert(styles.includes('.lead-age-chip'), 'age chip style missing');
});

/* ---- bot screening on the Inbox -------------------------------------------- */

t.test('bot screen requires all three signals for the hard flag', () => {
  t.assert(main.includes('function botSignals'), 'botSignals helper missing');
  t.assert(/suspected: hits\.length >= 3/.test(main),
    'the hard flag must require ALL THREE signals — one or two is only a caution');
  t.assert(main.includes('555'), 'fictional 555 phone check missing');
  t.assert(/123\\s\+business/.test(main) || main.includes('123\\s+business'), 'boilerplate address check missing');
  t.assert(main.includes('wholesale trading'), 'generic-services phrase check missing');
});

t.test('bot screening never auto-deletes', () => {
  // The screen renders chips and warnings only; it must not touch status or splice.
  const seg = main.slice(main.indexOf('function botSignals'), main.indexOf('function projectSummary'));
  t.assert(seg.length > 0, 'could not isolate the screening block');
  t.assert(!seg.includes('splice') && !seg.includes('.status ='),
    'screening code must never remove or auto-dismiss an inquiry');
});

/* ---- research agent honesty ------------------------------------------------ */

t.test('the qualification agent is barred from unverified relationship claims', () => {
  t.assert(qualify.includes('NEVER state ownership, family, or relationship claims'),
    'anti-confabulation instruction missing from the qualification prompt');
});

process.exit(t.report());
