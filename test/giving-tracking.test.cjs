// PUT IN: test/giving-tracking.test.cjs (REPLACES the current one)
/**
 * GivingGauge: the tracking rollups, the CSV, and requests typed in by hand.
 * Sep 3, 2026.
 *
 * TWO ASKS BEHIND THIS FILE.
 *
 * 1. "There is no dashboard saying how much we've donated and to what causes."
 *    The Giving tab had months, years and a client table. The client table
 *    only ever showed MATCHED customers, and most recipients are not
 *    customers, so the one question it could not answer was who we actually
 *    gave to. byOrg, byCause and byMission are the answer, and the tests below
 *    care most about the unclassified bucket: cause is a human judgement
 *    nobody made on plenty of older rows, and dropping those would make the
 *    cause totals quietly disagree with the totals at the top of the page.
 *
 * 2. "Need to be able to manually add items that may not have come through a
 *    Jotform." A phone call, a walk-in, or a donation from two years ago that
 *    belongs on the books. buildManualRequest goes through the SAME builder as
 *    an imported submission so there is one mapping, not two that drift.
 *
 * Every check here calls the real function. Reading the source for a keyword
 * proves the letters are there, not that the code runs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

Promise.all([
  import(path.join(ROOT, 'lib/giving-summary.js')),
  import(path.join(ROOT, 'lib/giving.js')),
]).then(([sum, giving]) => {
  const { summarise, buildLedgerCsv, LEDGER_COLUMNS } = sum;
  const { buildManualRequest } = giving;

  /* ---- a reader, so the CSV tests check what a reader would see --------- */

  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  /* ---- fixtures --------------------------------------------------------- */

  const approved = (over) => Object.assign({
    id: 'REQ-1',
    status: 'approved',
    source: 'jotform',
    request: { orgName: 'Polk City Little League', orgType: 'youth', missionFit: 'adjacent',
               city: 'Polk City', state: 'IA', eventName: 'Opening Day', pieceCount: 24 },
    account: { found: false },
    fulfillment: { retailValue: 400, cost: 150, fulfilledAt: '2026-05-10' },
  }, over || {});

  const rows = [
    approved({ id: 'REQ-1' }),
    approved({
      id: 'REQ-2',
      request: { orgName: 'Polk City Little League', orgType: 'youth', missionFit: 'adjacent' },
      fulfillment: { retailValue: 200, cost: 80, fulfilledAt: '2026-06-01' },
    }),
    approved({
      id: 'REQ-3',
      request: { orgName: 'Saydel Schools', orgType: 'school', missionFit: 'adjacent' },
      account: { found: true, customerId: '900', name: 'Saydel CSD', lifetimeRevenue: 20000 },
      fulfillment: { retailValue: 1000, cost: 500, fulfilledAt: '2026-06-20' },
    }),
    // Classified by nobody. The bucket that used to vanish.
    approved({
      id: 'REQ-4',
      request: { orgName: 'Ankeny Food Pantry' },
      fulfillment: { retailValue: 300, cost: 100, fulfilledAt: '2026-07-04' },
    }),
    // Approved but nothing entered: counted as a gap, not as a zero.
    { id: 'REQ-5', status: 'approved', request: { orgName: 'Nobody Yet' }, account: { found: false } },
    // Not approved at all: never in any total.
    approved({ id: 'REQ-6', status: 'declined', request: { orgName: 'Declined Org' },
               fulfillment: { retailValue: 9999, cost: 9999, fulfilledAt: '2026-07-05' } }),
  ];

  const s = summarise(rows, { measure: 'cost' });

  /* ---- who we gave to --------------------------------------------------- */

  t.test('every recipient is counted, customer or not', () => {
    const names = s.orgs.map((o) => o.label);
    t.assert(names.includes('Ankeny Food Pantry'),
      'an org that buys nothing from us is still somebody we gave to');
    t.equal(s.orgs.length, 3, 'three distinct organisations across four recorded gifts');
    t.equal(s.clients.length, 1, 'and only one of them is a client');
  });

  t.test('the same org across two requests is one line', () => {
    const ll = s.orgs.find((o) => o.label === 'Polk City Little League');
    t.equal(ll.count, 2, 'two gifts');
    t.equal(ll.cost, 230, 'and their costs add up');
    t.equal(ll.retail, 600, 'retail adds up too');
  });

  t.test('organisations are ordered biggest first on the chosen measure', () => {
    t.equal(s.orgs[0].label, 'Saydel Schools', 'the largest by cost leads');
    const costs = s.orgs.map((o) => o.cost);
    t.assert(costs.every((v, i) => i === 0 || costs[i - 1] >= v), 'descending, not insertion order');
  });

  t.test('an org that IS a client carries the client link', () => {
    const saydel = s.orgs.find((o) => o.label === 'Saydel Schools');
    t.equal(saydel.customerId, '900', 'so the row can point at the roster record');
    const pantry = s.orgs.find((o) => o.label === 'Ankeny Food Pantry');
    t.equal(pantry.customerId, undefined, 'and an unmatched org claims no customer');
  });

  /* ---- what causes ------------------------------------------------------ */

  t.test('spend is grouped by cause', () => {
    const youth = s.causes.find((c) => c.key === 'youth');
    t.equal(youth.cost, 230, 'both little league gifts land under youth');
    const school = s.causes.find((c) => c.key === 'school');
    t.equal(school.cost, 500, 'the school gift lands under school');
  });

  t.test('an unclassified request gets its own bucket, it is not dropped', () => {
    const un = s.causes.find((c) => c.key === 'unclassified');
    t.assert(un, 'unclassified must be a visible bucket');
    t.equal(un.cost, 100, 'carrying the amount nobody classified');
    t.equal(s.unclassified, 1, 'and the count is reported so the screen can say so');
  });

  t.test('the causes add up to the same total shown at the top of the page', () => {
    const causeTotal = s.causes.reduce((n, c) => n + c.cost, 0);
    t.equal(causeTotal, s.allTime.cost,
      'if these disagree, one of the two numbers on screen is a lie');
    const orgTotal = s.orgs.reduce((n, o) => n + o.cost, 0);
    t.equal(orgTotal, s.allTime.cost, 'the org chart must reconcile too');
  });

  t.test('mission fit is grouped the same way', () => {
    const adj = s.missions.find((m) => m.key === 'adjacent');
    t.equal(adj.count, 3, 'three adjacent gifts');
    t.assert(s.missions.some((m) => m.key === 'unclassified'), 'and the gap is visible here too');
  });

  t.test('a declined request is in no total anywhere', () => {
    t.equal(s.orgs.some((o) => o.label === 'Declined Org'), false, 'not a recipient');
    t.equal(s.ledger.some((r) => r.id === 'REQ-6'), false, 'not in the ledger');
    t.assert(s.allTime.cost < 9999, 'and nowhere near the totals');
  });

  t.test('an approved request with nothing entered is a gap, never a zero', () => {
    t.equal(s.unrecorded, 1, 'reported separately');
    t.equal(s.orgs.some((o) => o.label === 'Nobody Yet'), false,
      'a blank amount must not draw a zero-length bar as if we gave nothing');
  });

  /* ---- the ledger ------------------------------------------------------- */

  t.test('the ledger holds one row per recorded donation, newest first', () => {
    t.equal(s.ledger.length, 4, 'four recorded gifts');
    const dates = s.ledger.map((r) => r.date);
    t.equal(dates[0], '2026-07-04', 'the most recent leads');
    t.assert(dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'descending by date');
  });

  t.test('an undated row sorts last rather than reading as the newest', () => {
    const withUndated = summarise([
      approved({ id: 'REQ-A', fulfillment: { cost: 10 } }),
      approved({ id: 'REQ-B', fulfillment: { cost: 20, fulfilledAt: '2026-01-01' } }),
    ], {});
    t.equal(withUndated.ledger[withUndated.ledger.length - 1].id, 'REQ-A',
      'no date is not the same as today');
  });

  t.test('a ledger row says who it went to and whether they are a client', () => {
    const saydel = s.ledger.find((r) => r.id === 'REQ-3');
    t.equal(saydel.org, 'Saydel Schools', 'the recipient as they asked');
    t.equal(saydel.client, 'Saydel CSD', 'and the roster name when there is one');
    const pantry = s.ledger.find((r) => r.id === 'REQ-4');
    t.equal(pantry.client, null, 'null, not a made-up name, when they are not a client');
    t.equal(pantry.orgType, null, 'and an unclassified cause stays null in the data');
  });

  /* ---- merged clients ----------------------------------------------------
   * BackBone can hold one company as two Printavo records, and a merge folds
   * them. A donation request matched BEFORE that merge still names the old
   * record, so without folding here the client table shows one company on two
   * lines with its giving split between them: the same splitting the merge
   * exists to end, reappearing one screen over.
   * ---------------------------------------------------------------------- */

  t.test('a client merged in BackBone is one line here, not two', () => {
    const split = [
      approved({
        id: 'REQ-M1',
        request: { orgName: 'KBS' },
        account: { found: true, customerId: '2', name: 'KBS', lifetimeRevenue: 12000 },
        fulfillment: { retailValue: 200, cost: 100, fulfilledAt: '2026-03-01' },
      }),
      approved({
        id: 'REQ-M2',
        request: { orgName: 'Kitchen Bath Solutions' },
        account: { found: true, customerId: '1', name: 'Kitchen Bath Solutions', lifetimeRevenue: 50000 },
        fulfillment: { retailValue: 400, cost: 300, fulfilledAt: '2026-04-01' },
      }),
    ];

    const unmerged = summarise(split, { measure: 'cost' });
    t.equal(unmerged.clients.length, 2, 'two records, two lines, which is the state today');

    const mergeOf = {
      1: { primaryId: '1', name: 'Kitchen Bath Solutions' },
      2: { primaryId: '1', name: 'Kitchen Bath Solutions' },
    };
    const merged = summarise(split, { measure: 'cost', mergeOf });
    t.equal(merged.clients.length, 1, 'one company, one line');
    t.equal(merged.clients[0].cost, 400, 'and the giving adds up across both records');
    t.equal(merged.clients[0].count, 2, 'both gifts counted against the one client');
  });

  t.test('the merged line uses the name the human chose', () => {
    const rows = [approved({
      id: 'REQ-M3',
      request: { orgName: 'KBS' },
      account: { found: true, customerId: '2', name: 'KBS', lifetimeRevenue: 12000 },
      fulfillment: { cost: 100, fulfilledAt: '2026-03-01' },
    })];
    const merged = summarise(rows, {
      mergeOf: { 2: { primaryId: '1', name: 'Kitchen Bath Solutions' } },
    });
    t.equal(merged.clients[0].name, 'Kitchen Bath Solutions',
      'not whichever of the old records this request happened to match');
    t.equal(merged.clients[0].customerId, '1', 'and it points at the record that still exists');
  });

  t.test('with nothing merged the client table is exactly as it was', () => {
    const before = summarise(rows, { measure: 'cost' });
    const after = summarise(rows, { measure: 'cost', mergeOf: {} });
    t.equal(after.clients.length, before.clients.length, 'no merges, no change');
    t.equal(after.clients[0].name, before.clients[0].name, 'same names');
  });

  t.test('the summary route hands the merge map in', () => {
    const route = read('api/giving-requests.js');
    t.assert(/mergeNameMap/.test(route),
      'the summary must know about merges or the client table splits a merged client');
    // Anchored on the summary branch itself. Slicing to the first mention of
    // "rematch" would land on a comment near the top of the file and hand back
    // an empty string, which passes for the wrong reason.
    const start = route.indexOf('action === "summary"');
    const branch = route.slice(start, route.indexOf('if (id)', start));
    t.assert(branch.length > 0, 'the summary branch should be findable');
    t.assert(/mergeOf/.test(branch), 'and pass the map to summarise');
  });

  /* ---- the CSV ---------------------------------------------------------- */

  t.test('the CSV has a header row and one line per donation', () => {
    const csv = buildLedgerCsv(s.ledger, {});
    const lines = csv.trim().split('\r\n');
    t.equal(lines.length, 5, 'a header and four donations');
    t.equal(lines[0], LEDGER_COLUMNS.join(','), 'the header is the declared column list');
  });

  t.test('the CSV spells a cause the way the screen spells it', () => {
    const csv = buildLedgerCsv(s.ledger, { orgType: { school: 'School or district' } });
    t.assert(/School or district/.test(csv), 'labels are used when supplied');
    t.assert(/Not classified/.test(csv), 'and an unclassified row says so in words');
  });

  t.test('a comma or a quote in an org name does not break the file', () => {
    const csv = buildLedgerCsv([
      { id: 'REQ-9', org: 'Smith, Jones & Co "the shop"', cost: 5, retail: 10 },
    ], {});
    const line = csv.trim().split('\r\n')[1];
    t.assert(line.indexOf('"Smith, Jones & Co ""the shop"""') >= 0,
      'the field is quoted and the inner quotes doubled');
    // Split the way a reader does, respecting quotes, rather than on every
    // comma: splitting naively would count the comma inside the name and
    // report a break that is not there.
    t.equal(parseCsvLine(line).length, LEDGER_COLUMNS.length,
      'the row still has exactly one cell per column');
    t.equal(parseCsvLine(line)[1], 'Smith, Jones & Co "the shop"',
      'and it reads back as the name that went in');
  });

  t.test('a name starting with = cannot run as a formula when Excel opens it', () => {
    const csv = buildLedgerCsv([{ id: 'REQ-9', org: '=cmd|calc', cost: 0, retail: 0 }], {});
    // The cell arrives CSV-quoted, so check what is INSIDE the quotes rather
    // than searching the raw line: that mistake once made this test pass for
    // the wrong reason in another app.
    const cells = csv.trim().split('\r\n')[1].split(',');
    t.assert(cells[1].indexOf("'=cmd|calc") === 0,
      'a leading = must be prefixed with an apostrophe, got ' + cells[1]);
  });

  t.test('money is written with two decimals, not a rounded integer', () => {
    const csv = buildLedgerCsv([{ id: 'REQ-9', org: 'X', cost: 12.5, retail: 0 }], {});
    t.assert(/12\.50/.test(csv), 'a receipt figure keeps its cents');
  });

  t.test('an empty ledger still produces a usable file', () => {
    const csv = buildLedgerCsv([], {});
    t.equal(csv.trim(), LEDGER_COLUMNS.join(','), 'headers only, not an empty file');
    t.equal(buildLedgerCsv(null, null).trim(), LEDGER_COLUMNS.join(','), 'and null does not throw');
  });

  /* ---- typed in by hand ------------------------------------------------- */

  t.test('a hand-typed request comes out the same shape as an imported one', () => {
    const row = buildManualRequest({
      orgName: 'Ankeny Rotary', contactName: 'Dale Smith', email: 'dale@example.org',
      eventName: 'Pancake Breakfast', eventDate: '2026-11-14',
      city: 'Ankeny', state: 'IA', pieceCount: '36',
    }, { enteredBy: 'Ryan' });

    t.equal(row.request.orgName, 'Ankeny Rotary', 'the name survives the round trip');
    t.equal(row.request.city, 'Ankeny', 'city is read back out of the mapping');
    t.equal(row.request.state, 'IA', 'and so is state');
    t.equal(row.request.eventDate, '2026-11-14', 'the date parses to ISO');
    t.equal(row.request.pieceCount, 36, 'the piece count parses to a number, not a string');
    t.equal(row.status, 'pending', 'it lands in the queue like anything else');
    t.assert(row.id && row.id.indexOf('REQ-') === 0, 'and it gets a normal id');
  });

  t.test('it is marked as typed in, so nobody later thinks a form was filled', () => {
    const row = buildManualRequest({ orgName: 'X' }, { enteredBy: 'Ryan' });
    t.equal(row.source, 'manual', 'source says where it came from');
    t.equal(row.jotformId, null, 'there is no submission to point at');
    t.equal(row.enteredBy, 'Ryan', 'and who typed it is on the record');
  });

  t.test('an organisation name is required', () => {
    let threw = false;
    try { buildManualRequest({ eventName: 'Something' }, {}); } catch (e) { threw = true; }
    t.assert(threw, 'a request with nobody asking is not a request');
    let threw2 = false;
    try { buildManualRequest(null, {}); } catch (e) { threw2 = true; }
    t.assert(threw2, 'and neither is nothing at all');
  });

  t.test('a blank field is absent, not an empty answer', () => {
    const row = buildManualRequest({ orgName: 'X', eventName: '   ' }, {});
    t.equal(row.request.eventName, '', 'blank stays blank');
    t.assert(row.needsReview.some((n) => n.field === 'eventDate'),
      'and a missing date is flagged for review exactly as an incomplete form would be');
  });

  t.test('a classification typed in on the way is applied, a bad one is ignored', () => {
    const row = buildManualRequest({ orgName: 'X', orgType: 'school', missionFit: 'core' }, {});
    t.equal(row.request.orgType, 'school', 'the person entering it already knows');
    t.equal(row.request.missionFit, 'core', 'so the score is right immediately');
    t.equal(row.needsReview.some((n) => n.field === 'classification'), false,
      'and the classify prompt is answered');

    const junk = buildManualRequest({ orgName: 'X', orgType: 'nonsense', missionFit: 'nonsense' }, {});
    t.equal(junk.request.orgType, null, 'an unknown org type is refused, not stored');
    t.equal(junk.request.missionFit, null, 'same for mission fit');
    t.assert(junk.needsReview.some((n) => n.field === 'classification'),
      'and it still needs a human');
  });

  t.test('the disqualifier fields are never guessed from a manual entry', () => {
    const row = buildManualRequest({ orgName: 'First Lutheran Church' }, {});
    t.equal(row.request.isReligious, null,
      'a name match must not auto-set a field that auto-declines');
    t.equal(row.request.isPolitical, null, 'same for political');
  });

  t.test('a manual row keeps a raw payload so repairs can re-read it later', () => {
    const row = buildManualRequest({ orgName: 'Ankeny Rotary', city: 'Ankeny', state: 'IA' }, {});
    t.assert(row.raw && row.raw.answers, 'raw must survive, same as an imported row');
  });

  /* ---- the route and the screen ----------------------------------------- */

  t.test('the manual route is gated and goes through the shared builder', () => {
    const route = read('api/giving-requests.js');
    t.assert(/action === "manual"/.test(route), 'the branch exists');
    t.assert(/buildManualRequest/.test(route), 'and uses the shared builder, not its own mapping');
    const branch = route.slice(route.indexOf('action === "manual"'), route.indexOf('action === "backfill"'));
    // Sep 2026: this used to assert the words "admin" and "manager" appeared
    // in the branch, which is what the gate literally was — a role-NAME test
    // that refused every role created in Settings. The gate is now a verdict
    // from lib/giving-access.js, exercised for real in giving-access.test.cjs.
    t.assert(/mayAdd\.allowed/.test(branch), 'creating a record is gated on the add verdict');
    t.equal(/if \(sess\.role/.test(route), false,
      'and no branch in this file is back to matching role names literally');
    t.assert(/attachAccount/.test(branch), 'a manual request is matched against the roster');
    t.assert(/decidedBy/.test(branch) && /sess\./.test(branch),
      'who decided comes from the session, never from the payload');
  });

  t.test('the app builds the CSV from the same summary it just drew', () => {
    const app = read('apps/givinggauge.js');
    t.assert(/import \{ buildLedgerCsv \}/.test(app),
      'the export must be the shared builder, or the file and the page can disagree');
    t.equal(/function buildLedgerCsv/.test(app), false, 'and not a second copy in the app');
    t.assert(/action=manual/.test(app), 'the screen posts to the manual route');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error('giving tracking tests failed to load:', e);
  process.exit(1);
});
