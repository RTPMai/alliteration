// PUT IN: test/leads.test.cjs
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



t.test('every status write goes through the history helper', () => {
  t.assert(main.includes('function setLeadStatus'), 'setLeadStatus helper missing');
  // Direct assignment outside the helper reintroduces the untraceable-status bug.
  const direct = main.match(/(?:^|\n)\s*(?:lead|l)\.status = "(?!New")/g) || [];
  const allowed = direct.filter((s) => !s.includes('setLeadStatus'));
  t.equal(allowed.length, 0, 'found direct lead.status writes that bypass setLeadStatus');
  t.assert(main.includes('status_history'), 'status_history trail missing');
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


/* ---- duplicate detection -------------------------------------------------- */

t.test('duplicate checks normalize punctuation and suffixes', () => {
  // The roster and pipeline dup checks must both compare via normalizeCo, so
  // "Gino\'s" and "Ginos" collide. Three call sites until Sep 2026; the third
  // was the JSON-create path, which went with the cold outbound pipeline.
  const uses = (main.match(/normalizeCo\((?:c|l)\.company_name\)/g) || []).length;
  t.assert(uses >= 2, 'expected roster + pipeline dup checks to use normalizeCo (found ' + uses + ' uses)');
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

/* ---- outreach stages (Aug 2026 rework: Contacted split into a cadence) ---- */










t.test('new leads are tagged with an intake_source, distinct from source_type', () => {
  t.assert(main.includes('intake_source: "manual"'),
    'new leads must record how the RECORD entered the pipeline (manual today, prospecting later)');
  // source_type (how the CUSTOMER heard about us) must still exist separately.
  t.assert(main.includes('source_type: $id("leadSourceType").value'),
    'source_type must remain a separate field from intake_source');
});

/* ---- v2 triangulation schema (Aug 2026 master prompt) -------------------- */

const brief = read('api/brief.js');


t.test('the PARSER_UPDATE_REQUIRED gate is explained in the paste box', () => {
  const hits = main.split('V2_PARSER_HELP').length - 1;
  t.assert(main.includes('PARSER_UPDATE_REQUIRED'), 'the gate error object must be recognized');
  // Declaration plus one use. It was two uses until Sep 2026, when the second
  // paste box, "Create lead from JSON", went with the cold outbound pipeline.
  t.assert(hits >= 2, 'the paste box must surface V2_PARSER_HELP (found ' + hits + ')');
});



t.test('score displays are schema-aware, no hardcoded /50 in display code', () => {
  t.assert(/function qualDenom\(q\)/.test(main), 'qualDenom helper missing');
  // Any remaining "/50" must be in a comment, not concatenated into output.
  t.assert(!/\+ "\/50/.test(main) && !/'\/50/.test(main) && !/"\/50 " \+/.test(main),
    'a display site still hardcodes /50 — it must use qualDenom(q)');
  t.assert(/qualDenom\(q\)/.test(main),
    'the render path must call qualDenom rather than assuming a denominator');
});

t.test('stars scale to the denominator and clamp at 5', () => {
  t.assert(/function scoreStars\(score, denom\)/.test(main), 'scoreStars must accept a denominator');
  t.assert(/Math\.min\(5, Math\.max\(1/.test(main),
    'stars must clamp at 5 so a malformed over-max score cannot throw on negative repeat');
});

t.test('v2 tier names map to the existing badge classes', () => {
  t.assert(/\^Tier A\/\.test\(tier\)/.test(main.replace(/\\/g, '')) || main.includes('/^Tier A/.test(tier)'),
    'qualTierClass must recognize Tier A');
  t.assert(main.includes('/^Tier D/.test(tier)'), 'qualTierClass must recognize Tier D');
});

t.test('single-lead box unwraps a one-lead batch and redirects a multi-lead one', () => {
  t.assert(/parsed\.leads\.length !== 1/.test(main),
    'handlePasteQualification must check the batch size before unwrapping');
  t.assert(/stampV2\(parsed\.leads\[0\], parsed\)/.test(main),
    'a one-lead batch must be unwrapped and stamped with the batch schema version');
});

t.test('v2 extension sections render in Full detail', () => {
  const m = main.match(/function v2DetailSections[\s\S]*?\n  function renderLeadDetailBody/);
  t.assert(m, 'v2DetailSections missing or not adjacent to renderLeadDetailBody');
  ['identity_resolution', 'verification', 'event_intelligence', 'source_evidence',
   'research_gaps', 'purchase_intelligence', 'assumption_details', 'record_metadata',
   'related_organizations', 'field_confidence'].forEach((k) => {
    t.assert(m[0].includes(k), 'v2DetailSections must render ' + k);
  });
  t.assert(/v2DetailSections\(q\) \+/.test(main),
    'v2DetailSections must actually be appended inside the Full detail block');
});

t.test('unscored v2 categories show as not scored, never a true zero', () => {
  t.assert(/unscored\.indexOf\(k\) !== -1 \? "not scored"/.test(main),
    'the scoring breakdown must distinguish a listed unscored category from 0/10');
});

t.test('legacy leads render byte-identically: v2 sections gate on isV2Qual', () => {
  t.assert(/if \(!isV2Qual\(q\)\) return "";/.test(main),
    'v2DetailSections must return empty for legacy qualifications');
});

t.test('the schema version survives the batch wrapper being discarded', () => {
  t.assert(/function stampV2\(q, batch\)/.test(main), 'stampV2 missing');
  t.assert(/q\.schema_version = batch\.schema_version/.test(main),
    'batch leads must carry the batch schema_version so per-lead rendering knows its scale');
});


t.test('the lead brief is schema-aware too', () => {
  t.assert(/function isV2Qual\(q\)/.test(brief), 'brief.js must detect v2 qualifications');
  t.assert(/isV2Qual\(q\) \? 100 : 50/.test(brief), 'brief.js percent bar must use the schema denominator');
  t.assert(!/scoreNum \/ 50/.test(brief), 'brief.js percent math must not hardcode /50');
  t.assert(/\/^Tier A\//.test(brief.replace(/\r/g, '')) || brief.includes('/^Tier A/.test(t)'),
    'brief.js tierColor must recognize the v2 tier names');
  t.assert(brief.includes("/' + denom"),
    'the score dial must show the schema denominator');
});

process.exit(t.report());
