// PUT IN: test/backbone-archive-wiring.test.cjs
/**
 * The archive wiring: leads, clients, and the Archived screen.
 *
 * The lib logic is covered in backbone-archive.test.cjs. What is checked HERE
 * is the wiring, because this app's two most expensive recurring failures are
 * both wiring failures, not logic failures:
 *
 *   1. template.js missing an element id that main.js reads, which crashed
 *      BackBone's mount once already.
 *   2. a route that looks right in source but throws the moment it is loaded.
 *
 * So the routes are IMPORTED for real, and every id the archive code touches is
 * checked against the markup that has to contain it.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const main = read('apps/backbone/main.js');
const template = read('apps/backbone/template.js');
const styles = read('apps/backbone/styles.js');

Promise.all([
  import('../api/archive-reasons.js'),
  import('../api/archived-clients.js'),
  import('../lib/backbone/archive-store.js'),
  import('../js/registry.js'),
]).then(async ([reasonsRoute, clientsRoute, store, reg]) => {

  /* ---- the routes load and answer -------------------------------------- */

  t.test('both archive routes load and export a handler', () => {
    // Imported, not grepped. A missing export or a bad import path fails here
    // in a second instead of as a 500 nobody sees for a week.
    t.equal(typeof reasonsRoute.default, 'function', 'api/archive-reasons.js exports no handler');
    t.equal(typeof clientsRoute.default, 'function', 'api/archived-clients.js exports no handler');
  });

  t.test('the store exposes the four things the routes call', () => {
    ['getArchiveReasons', 'saveArchiveReasons', 'getClientArchives', 'setClientArchive']
      .forEach((fn) => t.equal(typeof store[fn], 'function', fn + ' is missing from the store'));
  });

  await t.test('setClientArchive refuses a blank customer id', async () => {
    // Reached before any storage call, so this runs without Upstash. A blank id
    // would write a stamp under "" that no roster row could ever match, and the
    // archive would look broken rather than absent.
    let threw = false;
    try { await store.setClientArchive('', { archived_at: 'x' }); } catch (e) { threw = true; }
    t.assert(threw, 'a blank customer id must be refused');
  });

  /* ---- the registry ----------------------------------------------------- */

  t.test('BackBone registers an Archived view', () => {
    const bb = reg.APPS.find((a) => a.id === 'backbone');
    t.assert(bb, 'BackBone is missing from the registry');
    const view = bb.views.find(([key]) => key === 'archive');
    t.assert(view, 'no "archive" view registered, so the rail has no way in');
    t.equal(view[1], 'Archived', 'the rail label should read Archived');
  });

  /* ---- template ids main.js reads --------------------------------------- */

  t.test('every element the archive code reads exists in the markup', () => {
    // The exact failure that crashed BackBone's mount before: main.js expecting
    // an id template.js never had.
    const ids = [
      'page-archive', 'archiveKpiGrid', 'archiveTableWrap', 'archiveSearch',
      'archiveReasonFilter', 'archiveOverlay', 'archiveModalTitle',
      'archiveModalWhat', 'archiveModalErr', 'archiveReasonSelect',
      'archiveNoteInput', 'archiveConfirmBtn', 'archiveCancelBtn',
      'archiveModalClose', 'archiveLeadBtn', 'restoreLeadBtn',
      'archiveClientBtn', 'restoreClientBtn', 'archiveReasonsBox',
      'archiveReasonsSaveBtn', 'archiveReasonsStatus', 'archiveReasonsErr',
    ];
    ids.forEach((id) => {
      t.assert(template.includes('id="' + id + '"'),
        'template.js has no #' + id + ', which main.js reads');
    });
  });

  t.test('the page id matches the registered view key', () => {
    // showView() finds the page as "page-" + view. A mismatch shows a blank
    // screen with nothing in the console to explain it.
    t.assert(template.includes('id="page-archive"'), 'page-archive must match the archive view key');
  });

  t.test('the archive tabs carry the attribute the handler reads', () => {
    t.assert(template.includes('data-archive-tab="leads"'), 'the leads tab is missing its key');
    t.assert(template.includes('data-archive-tab="clients"'), 'the clients tab is missing its key');
    t.assert(main.includes('getAttribute("data-archive-tab")'), 'nothing reads the tab key');
  });

  /* ---- the decisions, asserted where they live -------------------------- */

  t.test('archived leads are filtered out of the working list', () => {
    // The single filter that makes archiving and disqualifying mean anything.
    t.assert(/function getLeadsRows[\s\S]{0,400}?state_leads\.filter\(function\(l\) \{ return !isArchived\(l\); \}\)/.test(main),
      'getLeadsRows no longer excludes archived leads, so archiving does nothing');
  });

  t.test('archived clients are filtered off the roster', () => {
    t.assert(/function getRows[\s\S]{0,400}?state\.synced\.filter\(function\(c\) \{ return !isClientArchived/.test(main),
      'getRows no longer excludes archived clients');
  });

  t.test('the roster count agrees with the roster list', () => {
    // Two numbers on one screen disagreeing is how people stop trusting both.
    t.assert(/activeSynced[\s\S]{0,200}setText\("kpiTotal", activeSynced\.length\)/.test(main),
      'kpiTotal must count the same rows the table shows');
  });

  t.test('the browser never issues a lead number itself', () => {
    // Two people with the pipeline open would each compute the same "next"
    // number and the second save would take the first one's. Only the server
    // sees the whole list at once.
    t.assert(!/formatLeadNo|assignLeadNumbers|highestLeadNo/.test(main),
      'main.js is computing lead numbers; that belongs in api/leads-save.js');
    t.assert(read('api/leads-save.js').includes('assignLeadNumbers'),
      'api/leads-save.js must be the one issuing numbers');
  });

  t.test('the save route refuses an archived lead with no reason', () => {
    const src = read('api/leads-save.js');
    t.assert(/isArchived\(l\) && !String\(l\.archive_reason/.test(src),
      'a lead can reach storage archived with a blank reason');
  });

  t.test('the save route does not re-check the reason against the current list', () => {
    // Deliberate. A reason retired from the list months later would otherwise
    // make every future save of that lead fail, turning a settings edit into an
    // outage. Membership is enforced when the archive happens, not forever.
    t.assert(!/resolveReason/.test(read('api/leads-save.js')),
      'leads-save must not re-validate old reasons against the live list');
  });

  t.test('the browser and the server share one archive module', () => {
    // Two copies of "what counts as archived" drift, and the screen and the
    // server then disagree about which leads exist.
    t.assert(main.includes("from '../../lib/backbone/archive.js'"),
      'main.js must import the same archive module the routes use');
    t.assert(read('api/archived-clients.js').includes('../lib/backbone/archive.js'),
      'the client route must use it too');
  });

  t.test('a disqualified research result archives the lead automatically', () => {
    t.assert(/function autoArchiveDisqualified/.test(main), 'autoArchiveDisqualified is gone');
    t.assert(/\/\^Disqualified\/i\.test/.test(main),
      'nothing detects a Disqualified tier');
    // Told, never silent: an archive nobody was told about looks like a lead
    // that vanished off the list.
    t.assert(/autoArchived[\s\S]{0,300}alert\(/.test(main),
      'an automatic archive must say so on screen');
  });

  t.test('the automatic path stops if an admin retires the Disqualified reason', () => {
    t.assert(/if \(!resolveReason\(DISQUALIFIED_REASON, archiveReasons\)\) return;/.test(main),
      'the automatic archive must not write a reason the team has removed');
  });

  t.test('archiving and restoring swap rather than both showing', () => {
    t.assert(/arcBtn\.style\.display = archived \? "none" : ""/.test(main),
      'Archive must hide on an already-archived lead');
    t.assert(/resBtn\.style\.display = archived \? "" : "none"/.test(main),
      'Restore must only show on an archived lead');
  });

  t.test('an archived lead cannot have its stage changed from the panel', () => {
    // Editing a record that is on no working list is a change nobody sees.
    t.assert(/stSel\.disabled = archived/.test(main),
      'the status dropdown must be disabled on an archived lead');
  });

  t.test('a failed reason fetch falls back to the defaults, never to an empty list', () => {
    // An empty dropdown blocks archiving entirely and reads as a broken screen.
    t.assert(/let archiveReasons = DEFAULT_ARCHIVE_REASONS\.slice\(\)/.test(main),
      'archiveReasons must start from the defaults');
    t.assert(/if \(d && Array\.isArray\(d\.reasons\) && d\.reasons\.length\) archiveReasons = d\.reasons/.test(main),
      'only a non-empty response may replace the reason list');
  });

  t.test('a client stamp with no matching roster row is shown, not hidden', () => {
    // Hiding it would leave a record that can neither be seen nor restored.
    t.assert(/not on the current roster/.test(main), 'orphaned client stamps must still be listed');
  });

  /* ---- house rules ------------------------------------------------------ */

  t.test('the archive styles define no hex colours', () => {
    const block = styles.slice(styles.indexOf('Archived Manager'));
    t.assert(!/#[0-9a-fA-F]{3,8}\b/.test(block),
      'css/tokens.css is the only place colours live');
  });

  t.test('no app or lib file in this change imports a Node builtin', () => {
    // Server code landing in a browser folder is a recurring failure here.
    const browser = main + read('lib/backbone/archive.js');
    t.assert(!/from\s+["'](fs|path|crypto|http|os)["']/.test(browser),
      'a Node builtin import in browser-reachable code');
  });

  t.test('lib/backbone/archive.js stays free of storage concerns', () => {
    // Pure logic, so both the browser and the server can run it. The moment it
    // reaches for KV it can only run on one side.
    t.assert(!/kv\.js|fetch\(/.test(read('lib/backbone/archive.js')),
      'the shared archive module must not touch storage or the network');
  });

  t.report();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
