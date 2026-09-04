// PUT IN: test/backbone-archive.test.cjs
/**
 * Archiving leads and clients, and lead numbering.
 *
 * Every check below is a real call into lib/backbone/archive.js. The decisions
 * worth guarding are the ones that are cheap to write and expensive to get
 * wrong later: that a reason cannot be skipped, that a restore puts a lead back
 * where it was rather than somewhere plausible, that a lead number once issued
 * is never reissued, and that a Printavo reconcile cannot silently un-archive a
 * customer.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

import('../lib/backbone/archive.js').then((a) => {

  const REASONS = ['Disqualified', 'Not a fit', 'Duplicate record'];

  /* ---- the reason list -------------------------------------------------- */

  t.test('the seeded reason list is not empty', () => {
    t.assert(Array.isArray(a.DEFAULT_ARCHIVE_REASONS), 'defaults must be a list');
    t.assert(a.DEFAULT_ARCHIVE_REASONS.length >= 3, 'a list of one or two is not a list');
  });

  t.test('normalizing trims, drops blanks and drops duplicates', () => {
    const out = a.normalizeReasons(['  Not a fit  ', '', 'not a fit', 'Duplicate record', null]);
    t.equal(out.length, 2, 'two survive');
    t.equal(out[0], 'Not a fit', 'trimmed, and the first spelling wins');
    t.equal(out[1], 'Duplicate record', 'order is preserved');
  });

  t.test('an empty list falls back to the defaults rather than to nothing', () => {
    // A list of zero reasons would make archiving impossible, which reads as a
    // broken screen rather than as a setting somebody cleared.
    t.equal(a.normalizeReasons([]).length, a.DEFAULT_ARCHIVE_REASONS.length, 'defaults return');
    t.equal(a.normalizeReasons(null).length, a.DEFAULT_ARCHIVE_REASONS.length, 'so does null');
  });

  t.test('a reason off the list resolves to the list spelling', () => {
    t.equal(a.resolveReason('not a fit', REASONS), 'Not a fit',
      'matching is case insensitive but the stored value is the canonical one');
    t.equal(a.resolveReason('  DUPLICATE RECORD ', REASONS), 'Duplicate record',
      'padding and case do not create a second bucket');
  });

  t.test('a reason not on the list is refused, and so is a blank one', () => {
    t.equal(a.resolveReason('because I said so', REASONS), null, 'free text is refused');
    t.equal(a.resolveReason('', REASONS), null, 'empty is refused');
    t.equal(a.resolveReason(null, REASONS), null, 'missing is refused');
  });

  /* ---- archiving -------------------------------------------------------- */

  t.test('archiving stamps the record and never mutates the original', () => {
    const lead = { lead_id: 'lead_x', status: 'Death Call' };
    const out = a.archiveRecord(lead, { reason: 'Not a fit', reasons: REASONS, by: 'ryan' });
    t.assert(a.isArchived(out), 'the copy is archived');
    t.assert(!a.isArchived(lead), 'the original is untouched');
    t.equal(out.archive_reason, 'Not a fit', 'the reason is copied onto the record');
    t.equal(out.archived_by, 'ryan', 'and who did it');
    t.assert(!!out.archived_at, 'and when');
  });

  t.test('archiving without a valid reason throws instead of archiving blank', () => {
    // This is the whole point of the fixed list. A record archived with no
    // reason is a record nobody can explain a month later.
    let threw = false;
    try { a.archiveRecord({ lead_id: 'x' }, { reasons: REASONS, by: 'ryan' }); }
    catch (e) { threw = true; }
    t.assert(threw, 'a missing reason must throw');

    let threw2 = false;
    try { a.archiveRecord({ lead_id: 'x' }, { reason: 'made up', reasons: REASONS }); }
    catch (e) { threw2 = true; }
    t.assert(threw2, 'an off-list reason must throw');
  });

  t.test('the status is left alone, so a restore knows where to put the lead back', () => {
    // Archive is a flag beside the status, not a status of its own. If it
    // overwrote the status, restoring would have to guess.
    const lead = { lead_id: 'l', status: 'Contacted 2nd', status_history: [{ status: 'Contacted 2nd', at: '2026-08-01T00:00:00.000Z' }] };
    const out = a.archiveRecord(lead, { reason: 'Not a fit', reasons: REASONS, by: 'ryan' });
    t.equal(out.status, 'Contacted 2nd', 'the stage survives the archive');
    t.equal(out.status_history.length, 1, 'and so does its history, unchanged');
  });

  t.test('an optional note sits on top of the reason, never instead of it', () => {
    const out = a.archiveRecord({}, { reason: 'Not a fit', reasons: REASONS, by: 'r', note: 'said to try next spring' });
    t.equal(out.archive_reason, 'Not a fit', 'the reason is still there');
    t.equal(out.archive_note, 'said to try next spring', 'the note rides along');
  });

  /* ---- restoring -------------------------------------------------------- */

  t.test('restoring clears the stamp and puts the lead back at its old stage', () => {
    const lead = { lead_id: 'l', status: 'Reach Back Out' };
    const arch = a.archiveRecord(lead, { reason: 'Not a fit', reasons: REASONS, by: 'ryan' });
    const back = a.restoreRecord(arch, { by: 'jacob' });
    t.assert(!a.isArchived(back), 'no longer archived');
    t.equal(back.archive_reason, undefined, 'the reason is cleared, not left dangling');
    t.equal(back.archived_by, undefined, 'and so is the archiver');
    t.equal(back.status, 'Reach Back Out', 'the lead is standing where it was');
  });

  t.test('the archive trail survives a restore', () => {
    // Archived and restored three times is a fact worth being able to see.
    const one = a.archiveRecord({}, { reason: 'Not a fit', reasons: REASONS, by: 'ryan' });
    const two = a.restoreRecord(one, { by: 'ryan' });
    const three = a.archiveRecord(two, { reason: 'Duplicate record', reasons: REASONS, by: 'abby' });
    t.equal(three.archive_history.length, 3, 'all three actions are on the record');
    t.equal(three.archive_history[0].action, 'archived', 'in order');
    t.equal(three.archive_history[1].action, 'restored', 'in order');
    t.equal(three.archive_history[2].reason, 'Duplicate record', 'with the reason each time');
  });

  t.test('a reason later deleted from the list does not rewrite old records', () => {
    // The reason is copied onto the record at archive time. Editing the list is
    // a Settings change, not a rewrite of history.
    const arch = a.archiveRecord({}, { reason: 'Duplicate record', reasons: REASONS, by: 'ryan' });
    const shorterList = ['Not a fit'];
    t.equal(arch.archive_reason, 'Duplicate record', 'the record still says why');
    t.equal(a.resolveReason('Duplicate record', shorterList), null,
      'it just cannot be chosen again, which is what removing it should mean');
  });

  /* ---- splitting the working list from the archive ---------------------- */

  t.test('partitioning puts every record in exactly one list', () => {
    const rows = [
      { id: 1 },
      a.archiveRecord({ id: 2 }, { reason: 'Not a fit', reasons: REASONS, by: 'r' }),
      { id: 3 },
    ];
    const { live, archived } = a.partitionArchived(rows);
    t.equal(live.length, 2, 'two are still working');
    t.equal(archived.length, 1, 'one is archived');
    t.equal(live.length + archived.length, rows.length, 'nothing is lost between the two');
  });

  /* ---- lead numbers ----------------------------------------------------- */

  t.test('a lead number formats and parses back', () => {
    t.equal(a.formatLeadNo(1), 'L-00001', 'padded to five');
    t.equal(a.formatLeadNo(2508), 'L-02508', 'and stays padded');
    t.equal(a.parseLeadNo('L-02508'), 2508, 'and reads back');
    t.equal(a.parseLeadNo('lead_ma3k2x9f'), null, 'the random id is not a lead number');
    t.equal(a.parseLeadNo(''), null, 'nor is nothing');
  });

  t.test('the backfill numbers oldest first, so L-00001 is the first lead we got', () => {
    const leads = [
      { lead_id: 'c', created_at: '2026-03-01T00:00:00.000Z' },
      { lead_id: 'a', created_at: '2026-01-01T00:00:00.000Z' },
      { lead_id: 'b', created_at: '2026-02-01T00:00:00.000Z' },
    ];
    const { leads: out, assigned } = a.assignLeadNumbers(leads);
    t.equal(assigned, 3, 'all three got one');
    const byId = Object.fromEntries(out.map((l) => [l.lead_id, l.lead_no]));
    t.equal(byId.a, 'L-00001', 'the oldest is first');
    t.equal(byId.b, 'L-00002', 'then the next');
    t.equal(byId.c, 'L-00003', 'then the newest');
  });

  t.test('a number already issued is never reissued or renumbered', () => {
    // Renumbering would break every place the old number was written down.
    const leads = [
      { lead_id: 'old', lead_no: 'L-00007', created_at: '2026-01-01T00:00:00.000Z' },
      { lead_id: 'new', created_at: '2026-02-01T00:00:00.000Z' },
    ];
    const { leads: out, assigned } = a.assignLeadNumbers(leads);
    t.equal(assigned, 1, 'only the unnumbered one is touched');
    t.equal(out[0].lead_no, 'L-00007', 'the existing number is left exactly as it was');
    t.equal(out[1].lead_no, 'L-00008', 'and the new one continues past the highest, not past the count');
  });

  t.test('numbering twice is a no-op the second time', () => {
    const first = a.assignLeadNumbers([{ lead_id: 'x', created_at: '2026-01-01T00:00:00.000Z' }]);
    const second = a.assignLeadNumbers(first.leads);
    t.equal(second.assigned, 0, 'nothing left to do');
    t.equal(second.leads[0].lead_no, first.leads[0].lead_no, 'and the number did not move');
  });

  t.test('a gap in the numbers does not cause a collision', () => {
    // Deleting L-00002 must not make the next lead L-00002 again.
    const leads = [
      { lead_id: 'a', lead_no: 'L-00001', created_at: '2026-01-01T00:00:00.000Z' },
      { lead_id: 'c', lead_no: 'L-00003', created_at: '2026-03-01T00:00:00.000Z' },
      { lead_id: 'd', created_at: '2026-04-01T00:00:00.000Z' },
    ];
    const { leads: out } = a.assignLeadNumbers(leads);
    t.equal(out[2].lead_no, 'L-00004', 'the next number is past the highest, gap and all');
    t.equal(a.duplicateLeadNos(out).length, 0, 'and nothing collides');
  });

  t.test('duplicates are reported, not silently repaired', () => {
    const dupes = a.duplicateLeadNos([
      { lead_no: 'L-00001' }, { lead_no: 'L-00001' }, { lead_no: 'L-00002' },
    ]);
    t.equal(dupes.length, 1, 'one number is doubled up');
    t.equal(dupes[0], 'L-00001', 'and it says which');
  });

  t.test('leads with no created_at still all get distinct numbers', () => {
    const { leads: out } = a.assignLeadNumbers([{ lead_id: 'a' }, { lead_id: 'b' }, { lead_id: 'c' }]);
    t.equal(a.duplicateLeadNos(out).length, 0, 'missing dates must not collapse the ordering into ties');
    t.equal(out.filter((l) => l.lead_no).length, 3, 'and everybody is numbered');
  });

  /* ---- client archives -------------------------------------------------- */

  t.test('client stamps fold onto the roster on read', () => {
    const rows = [{ customer_id: '55', company_name: 'Acme' }, { customer_id: '56', company_name: 'Beta' }];
    const map = { clients: { 55: { archived_at: '2026-09-01T00:00:00.000Z', archive_reason: 'Out of business or closed' } } };
    const out = a.applyClientArchive(rows, map);
    t.assert(a.isArchived(out[0]), 'the archived customer reads as archived');
    t.assert(!a.isArchived(out[1]), 'and the other one does not');
    t.equal(out[0].company_name, 'Acme', 'the roster fields survive the fold');
  });

  t.test('a stamp for a customer no longer on the roster is ignored', () => {
    // A customer deleted in Printavo must not come back as an empty archived row.
    const out = a.applyClientArchive([{ customer_id: '55' }], { clients: { 99: { archived_at: 'x' } } });
    t.equal(out.length, 1, 'no phantom row is added');
  });

  t.test('the fold copies rows rather than editing the synced roster in place', () => {
    const rows = [{ customer_id: '55' }];
    a.applyClientArchive(rows, { clients: { 55: { archived_at: 'x', archive_reason: 'Not a fit' } } });
    t.assert(!a.isArchived(rows[0]), 'the roster array handed in is untouched');
  });

  t.test('a half-written stamp with no archived_at is not treated as archived', () => {
    const out = a.applyClientArchive([{ customer_id: '55' }], { clients: { 55: { archive_reason: 'Not a fit' } } });
    t.assert(!a.isArchived(out[0]), 'no timestamp means no archive');
  });

  /* ---- the rules this repo enforces ------------------------------------- */

  t.test('lib/backbone/ does not import from api/', () => {
    const src = read('lib/backbone/archive.js') + read('lib/backbone/archive-store.js');
    t.assert(!/from\s+["']\.\.\/\.\.\/api\//.test(src), 'lib must never import from api');
  });

  t.test('the archive routes are on the seam and marked live', () => {
    const src = read('js/api.js');
    t.assert(/bbArchiveReasons:/.test(src), 'ENDPOINTS.bbArchiveReasons is missing');
    t.assert(/bbArchivedClients:/.test(src), 'ENDPOINTS.bbArchivedClients is missing');
    t.assert(src.includes("'/api/archive-reasons'"), "'/api/archive-reasons' must be in LIVE_PREFIXES");
    t.assert(src.includes("'/api/archived-clients'"), "'/api/archived-clients' must be in LIVE_PREFIXES");
  });

  t.report();
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
