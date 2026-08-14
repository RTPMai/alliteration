/**
 * PromoPro tests.
 *
 * Two halves. First the contract checks every app in this shell gets: app
 * module shape, seam usage, registry entry, tokens block, route auth.
 *
 * Then the part that actually matters, run against the real functions rather
 * than matched in the source: PO numbering (including the sibling renumber
 * rule), stage derivation from dates, and the two independent clocks that
 * decide whether a PO is late. Those are the app's reason to exist, so they
 * are tested by calling them, not by grepping for them.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const app = read('apps/promopro.js');
const posRoute = read('api/promopro/pos.js');
const vendorsRoute = read('api/promopro/vendors.js');
const printavoRoute = read('api/promopro/printavo.js');
const settingsRoute = read('api/promopro/settings.js');
const lookup = read('lib/promopro/printavo-lookup.js');
const store = read('lib/promopro/store.js');
const registry = read('js/registry.js');
const apiJs = read('js/api.js');
const tokens = read('css/tokens.css');

/* ---- app contract ------------------------------------------------------- */

t.test('apps/promopro.js exists and follows the app contract', () => {
  ['export default', "id: 'promopro'", 'mount', 'showView', 'styles:', 'template:']
    .forEach((k) => t.assert(app.includes(k), 'apps/promopro.js is missing ' + k));
});

t.test('promopro fetches through the seam, never fetch() directly', () => {
  t.assert(app.includes('ctx.api.get(ENDPOINTS.ppPos'),
    'promopro should read purchase orders through ENDPOINTS.ppPos');
  t.assert(!/[^.\w]fetch\s*\(/.test(app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    'apps/promopro.js must not call fetch() directly');
});

t.test('the registry entry is real, not a stub', () => {
  t.assert(registry.includes("id: 'promopro'"), 'registry has no promopro entry');
  const block = registry.slice(registry.indexOf("id: 'promopro'"));
  const end = block.indexOf('\n  },');
  t.assert(!/stub:\s*true/.test(block.slice(0, end)), 'promopro should not be a stub');
});

t.test('every promopro view in the registry is reachable in showView', () => {
  const block = registry.slice(registry.indexOf("id: 'promopro'"));
  const viewsPart = block.slice(block.indexOf('views:'), block.indexOf('defaultView'));
  const keys = [...viewsPart.matchAll(/\['(\w+)',/g)].map((m) => m[1]);
  t.assert(keys.length >= 2, 'expected several views');
  keys.forEach((k) => {
    t.assert(app.includes(k + ':'), 'showView has no page mapped for the "' + k + '" view');
  });
});

t.test('tokens.css carries the promopro accent block', () => {
  t.assert(/body\[data-app="promopro"\]/.test(tokens), 'no promopro block in tokens.css');
  t.assert(tokens.includes('#E31E2D'), 'promopro accent should be #E31E2D from the logo lineup');
});

t.test('CrewCore moved off red so the two rail dots are distinguishable', () => {
  // Aug 14 2026 lineup: PromoPro took red, CrewCore became raspberry. Two
  // near-identical reds in the rail is exactly the confusion this prevents.
  t.assert(tokens.includes('#C83E73'), 'CrewCore should now be raspberry #C83E73');
  t.assert(!/body\[data-app="crewcore"\][\s\S]{0,120}#E1251B/.test(tokens),
    'CrewCore still carries the old red accent');
  t.assert(registry.includes("accent: '#C83E73'"), 'registry still has CrewCore on the old red');
});

t.test('adding a vendor is one card, not a chain of prompts', () => {
  // A lead time is a judgement call. You cannot make it well when you can
  // only see one question at a time and cannot go back and change an
  // earlier answer.
  t.assert(!/window\.prompt|window\.alert/.test(app),
    'vendor entry should be a form card, not browser prompts');
  ['ppVenName', 'ppVenEmail', 'ppVenLead', 'ppVenTerms', 'ppVenPrepay', 'ppVenNotes']
    .forEach((f) => t.assert(app.includes(f), 'the vendor card is missing the ' + f + ' field'));
});

t.test('the vendor card asks two numbers, not six', () => {
  // Simplified Aug 14 2026. Six per-stage waits meant six guesses per vendor,
  // and a guessed threshold produces a false amber. False ambers train people
  // to ignore the colour, at which point the alerting is worse than none.
  t.assert(!app.includes('data-wait='), 'the per-stage wait grid is back on the vendor card');
  t.assert(app.includes('ppVenLead'), 'the vendor card should still ask for lead days');
  t.assert(app.includes('ppVenResponse'), 'the vendor card should offer one optional response-time override');
});

t.test('every screen judges lateness against the same shop-wide setting', () => {
  // Calling poHealth directly anywhere would silently fall back to the
  // built-in default and disagree with what Settings says.
  const direct = app.split('poHealth(').length - 1;
  t.assert(direct <= 2, 'poHealth should be called through the shared health() wrapper, found ' + direct + ' direct uses');
  t.assert(app.includes('chaseAfterDays: st.settings.chaseAfterDays'),
    'the wrapper should pass the configured threshold');
});

t.test('an existing vendor can be edited, not just created', () => {
  t.assert(app.includes('data-editvendor='), 'no edit affordance on the vendor list');
  t.assert(/method:\s*'PATCH'[\s\S]{0,120}ppVendors|ppVendors[\s\S]{0,120}method:\s*'PATCH'/.test(app),
    'editing a vendor should PATCH rather than create a duplicate');
});

/* ---- seam --------------------------------------------------------------- */

t.test('the seam knows every promopro endpoint and marks them live', () => {
  ['ppPos', 'ppVendors', 'ppPrintavo', 'ppSettings'].forEach((k) => {
    t.assert(apiJs.includes(k + ':'), 'js/api.js is missing ENDPOINTS.' + k);
  });
  t.assert(apiJs.includes("'/api/promopro/'"), 'the /api/promopro/ prefix is not marked live');
});

t.test('the promopro mocks are empty, never invented purchase orders', () => {
  // A fake PO looks exactly like a real one on screen, and the entire value
  // of this app is that people trust what the pipeline says.
  // Anchored on the mock DEFINITION. "[ENDPOINTS.ppPos]" also appears in
  // appsOnSampleData() further up the file, which is what a plain indexOf
  // finds first.
  const mock = apiJs.slice(apiJs.indexOf('[ENDPOINTS.ppPos]: ()'));
  t.assert(/pos:\s*\[\]/.test(mock.slice(0, 200)), 'ppPos mock should be an empty list');
  t.assert(/vendors:\s*\[\]/.test(apiJs.slice(apiJs.indexOf('[ENDPOINTS.ppVendors]: ()'), apiJs.indexOf('[ENDPOINTS.ppVendors]: ()') + 200)),
    'ppVendors mock should be an empty list');
});

/* ---- routes ------------------------------------------------------------- */

t.test('every promopro route requires a session', () => {
  [['pos', posRoute], ['vendors', vendorsRoute], ['printavo', printavoRoute], ['settings', settingsRoute]].forEach(([name, src]) => {
    t.assert(src.includes('requireAuth(req, res)'), 'api/promopro/' + name + '.js does not require auth');
    t.assert(src.includes('if (!sess) return'), 'api/promopro/' + name + '.js does not bail on a missing session');
  });
});

t.test('reading purchase orders is open, writing is not', () => {
  // AMs need to answer "where is my order" without asking anybody. Gating the
  // read would defeat the point of the app.
  const gate = posRoute.indexOf('if (!canEdit)');
  const getBlock = posRoute.indexOf('if (req.method === "GET")');
  t.assert(getBlock !== -1 && gate !== -1 && getBlock < gate,
    'the GET branch must come before the can_edit gate, or read access is blocked');
});

t.test('deleting a purchase order is admin only', () => {
  const del = posRoute.slice(posRoute.indexOf('if (req.method === "DELETE")'));
  t.assert(/if \(!isAdmin\)/.test(del.slice(0, 300)), 'DELETE is not gated to admins');
});

t.test('vendor writes are admin only, vendor reads are not', () => {
  const getIdx = vendorsRoute.indexOf('if (req.method === "GET")');
  const gateIdx = vendorsRoute.indexOf('if (!isAdmin)');
  t.assert(getIdx !== -1 && gateIdx !== -1 && getIdx < gateIdx,
    'vendor GET must be reachable without admin, since every PO screen needs lead times');
});

t.test('a vendor with purchase orders against it is deactivated, never deleted', () => {
  // Deleting would leave those POs pointing at nothing, and the health maths
  // would fall back to zero lead time, which reads as "on schedule".
  t.assert(vendorsRoute.includes('inUse'), 'no in-use check before removing a vendor');
  t.assert(vendorsRoute.includes('active: false'), 'an in-use vendor should be deactivated');
});

t.test('the Printavo route answers cleanly when Printavo is not configured', () => {
  t.assert(printavoRoute.includes('configured: false'),
    'should answer 200 with configured:false rather than erroring');
  t.assert(!/status\(500\)/.test(printavoRoute),
    'a Printavo outage should not 500 the form; it should degrade to manual entry');
});

t.test('the Printavo route is read-only', () => {
  t.assert(/req\.method !== "GET"/.test(printavoRoute),
    'nothing in PromoPro should be able to write back to a Printavo quote');
});

t.test('reading settings is open, writing them is admin only', () => {
  // The new-PO form cannot render its required account-manager picker
  // without this read, so gating it would break the app for the people who
  // use it most. Writing decides who is copied on outgoing mail.
  const getIdx = settingsRoute.indexOf('if (req.method === "GET")');
  const gateIdx = settingsRoute.indexOf('if (!isAdmin)');
  t.assert(getIdx !== -1 && gateIdx !== -1 && getIdx < gateIdx,
    'settings GET must be reachable without admin');
});

/* ---- architecture ------------------------------------------------------- */

t.test('lib/promopro never imports from api/', () => {
  ['lib/promopro/schema.js', 'lib/promopro/store.js', 'lib/promopro/vendors.js', 'lib/promopro/printavo-lookup.js']
    .forEach((f) => {
      t.assert(exists(f), f + ' is missing');
      t.assert(!/from\s+["'][^"']*\/api\//.test(read(f)), f + ' imports from api/, which is not allowed');
    });
});

t.test('the routes live in a folder, not a flat api/promopro.js', () => {
  // Vercel treats a file and a same-named folder as a route conflict once the
  // .js is stripped. WebsiteWidget hit this in August.
  t.assert(!exists('api/promopro.js'), 'api/promopro.js would conflict with the api/promopro/ folder');
  t.assert(exists('api/promopro/pos.js'), 'api/promopro/pos.js is missing');
});

t.test('the store writes only under its own key prefix', () => {
  t.assert(store.includes('promopro_data'), 'store should use the promopro_data: prefix');
  t.assert(!/alliteration:/.test(store), 'the store must not touch the shell users/roles keys');
});

t.test('the Printavo lookup explains why it does not reuse the sync', () => {
  // The sync deliberately selects ONLY category to stay under Printavo's
  // query complexity ceiling across thousands of invoices, so it cannot
  // supply line-item detail. Losing that reasoning would invite someone to
  // "simplify" this into a broken shared read.
  t.assert(/complexity/i.test(lookup), 'the complexity-ceiling reason should stay documented here');
});

/* ---- the real logic ----------------------------------------------------- */

(async () => {
  const s = await import('../lib/promopro/schema.js');
  const st = await import('../lib/promopro/store.js');

  /* -- PO numbering -- */

  t.test('a single PO on a job has no suffix', () => {
    t.equal(s.buildPoNumber({ year: '26', invoiceNumber: '66601', seq: 1, total: 1 }), '26-66601');
  });

  t.test('a second PO on the same job gives both a suffix', () => {
    const numbered = st.assignPoNumbers([
      { id: 'a', createdAt: '2026-08-01T10:00:00Z', year: '26', printavo: { invoiceNumber: '66601' } },
      { id: 'b', createdAt: '2026-08-02T10:00:00Z', year: '26', printavo: { invoiceNumber: '66601' } },
    ]);
    t.equal(numbered.map((p) => p.poNumber).join(','), '26-66601-1,26-66601-2');
  });

  t.test('suffixes follow creation order, not the order they arrive in', () => {
    const numbered = st.assignPoNumbers([
      { id: 'later', createdAt: '2026-08-05T10:00:00Z', year: '26', printavo: { invoiceNumber: '70001' } },
      { id: 'earlier', createdAt: '2026-08-01T10:00:00Z', year: '26', printavo: { invoiceNumber: '70001' } },
    ]);
    t.equal(numbered.find((p) => p.id === 'earlier').poNumber, '26-70001-1');
    t.equal(numbered.find((p) => p.id === 'later').poNumber, '26-70001-2');
  });

  t.test('a manual web order is obviously not a Printavo job', () => {
    // No invoice number to build from, so an M sequence takes the middle slot
    // and anyone reading the number can see no Printavo job sits behind it.
    t.equal(s.buildPoNumber({ year: '26', manualSeq: 14, seq: 1, total: 1 }), '26-M014');
  });

  t.test('two POs on different jobs never collide', () => {
    const a = st.jobKeyOf({ year: '26', printavo: { invoiceNumber: '66601' } });
    const b = st.jobKeyOf({ year: '26', printavo: { invoiceNumber: '66602' } });
    t.assert(a !== b, 'different invoices should be different job keys');
  });

  /* -- stage derivation -- */

  t.test('stage is derived from the dates, so the two can never disagree', () => {
    t.equal(s.currentStage({}), 'draft');
    t.equal(s.currentStage({ submittedAt: '2026-08-01' }), 'submitted');
    t.equal(s.currentStage({ submittedAt: '2026-08-01', confirmedAt: '2026-08-02' }), 'confirmed');
  });

  t.test('a skipped step does not hold the PO back', () => {
    // Real life back-fills. A PO that got a ship date before anyone recorded
    // the payment is shipped, not stuck at confirmed.
    const po = { submittedAt: '2026-08-01', confirmedAt: '2026-08-02', shippedAt: '2026-08-09' };
    t.equal(s.currentStage(po), 'shipped');
  });

  t.test('a cancelled PO leaves the pipeline entirely', () => {
    t.equal(s.currentStage({ submittedAt: '2026-08-01', cancelledAt: '2026-08-03' }), 'cancelled');
  });

  /* -- the clocks -- */

  const vendor = { id: 'v1', leadDays: 10 };

  t.test('a vendor still inside the chase window is not flagged', () => {
    const po = { submittedAt: '2026-08-10', neededBy: '2026-09-30', createdAt: '2026-08-10T00:00:00Z' };
    t.equal(s.poHealth(po, vendor, '2026-08-12').level, 'ok');
  });

  t.test('a vendor going quiet past the chase window goes amber', () => {
    const po = { submittedAt: '2026-08-10', neededBy: '2026-09-30', createdAt: '2026-08-10T00:00:00Z' };
    t.equal(s.poHealth(po, vendor, '2026-08-14').level, 'amber');
  });

  t.test('twice the chase window goes red', () => {
    const po = { submittedAt: '2026-08-10', neededBy: '2026-09-30', createdAt: '2026-08-10T00:00:00Z' };
    t.equal(s.poHealth(po, vendor, '2026-08-17').level, 'red');
  });

  t.test('the chase window is one shop-wide number, overridable per vendor', () => {
    // One number somebody can actually answer, not six guesses per supplier.
    const po = { submittedAt: '2026-08-10', neededBy: '2026-09-30', createdAt: '2026-08-10T00:00:00Z' };
    const slow = { id: 'v2', leadDays: 10, responseDays: 10 };
    t.equal(s.poHealth(po, vendor, '2026-08-14', { chaseAfterDays: 3 }).level, 'amber');
    t.equal(s.poHealth(po, vendor, '2026-08-14', { chaseAfterDays: 10 }).level, 'ok');
    t.equal(s.poHealth(po, slow, '2026-08-14', { chaseAfterDays: 3 }).level, 'ok');
  });

  t.test('steps that are OURS never raise a vendor alarm', () => {
    // Approving art and sending payment are our holdups. Colouring them as
    // vendor lateness pointed the finger at the wrong party, and no vendor
    // setting could ever have described them.
    const ours = { artApprovedAt: '2026-07-01', neededBy: '2026-12-31', createdAt: '2026-07-01T00:00:00Z' };
    const h = s.poHealth(ours, vendor, '2026-08-14', { chaseAfterDays: 3 });
    t.assert(!h.reasons.some((r) => /no word/.test(r)),
      'a step we own should not be reported as vendor silence');

    const theirs = { confirmedAt: '2026-07-01', neededBy: '2026-12-31', createdAt: '2026-07-01T00:00:00Z' };
    t.assert(s.poHealth(theirs, vendor, '2026-08-14', { chaseAfterDays: 3 }).reasons.some((r) => /no word/.test(r)),
      'a step the vendor owns should still be chased');
  });

  t.test('a PO moving along fine can still be flagged as doomed', () => {
    // The delivery clock is independent of the stage clock. This PO was
    // submitted yesterday, so nothing is late, but there is no longer enough
    // lead time left to make the due date. That is the failure the
    // email-only process never surfaces until the customer calls.
    const po = { submittedAt: '2026-08-13', neededBy: '2026-08-18', createdAt: '2026-08-13T00:00:00Z' };
    const h = s.poHealth(po, vendor, '2026-08-14');
    t.equal(h.level, 'red');
    t.assert(h.reasons.some((r) => /vendor needs/.test(r)), 'should explain that the lead time no longer fits');
  });

  t.test('a draft that should already have been ordered is red', () => {
    const po = { neededBy: '2026-08-18', createdAt: '2026-08-01T00:00:00Z' };
    const h = s.poHealth(po, vendor, '2026-08-14');
    t.equal(h.level, 'red');
    t.assert(h.reasons.some((r) => /ordered/.test(r)), 'should say it is already past the order-by date');
  });

  t.test('a received PO stops being chased', () => {
    const po = { submittedAt: '2026-06-01', receivedAt: '2026-06-20', neededBy: '2026-06-15' };
    t.equal(s.poHealth(po, vendor, '2026-08-14').level, 'done');
  });

  t.test('order-by backs off both the vendor lead time and the decorating buffer', () => {
    // Blanks we print need slack on our end; finished goods drop-shipped to
    // the customer do not, which is why the buffer is per PO.
    t.equal(s.orderByDate({ neededBy: '2026-09-30' }, vendor), '2026-09-20');
    t.equal(s.orderByDate({ neededBy: '2026-09-30', decorateBufferDays: 5 }, vendor), '2026-09-15');
  });

  /* -- money -- */

  t.test('line and PO totals agree, because they come from one place', () => {
    const po = { lines: [{ qty: 12, unitCost: 4.25 }, { qty: 3, unitCost: 10 }] };
    t.equal(s.lineTotal(po.lines[0]), 51);
    t.equal(s.poTotal(po), 81);
  });

  t.test('a PO with no lines totals zero rather than NaN', () => {
    t.equal(s.poTotal({}), 0);
    t.equal(s.poTotal({ lines: [] }), 0);
  });

  /* -- validation -- */

  t.test('a PO must have a vendor, an account manager, and at least one line', () => {
    const bad = s.validateNew({}, ['v1'], ['alexis']);
    t.assert(!bad.ok, 'an empty PO should not validate');
    t.assert(bad.errors.some((e) => /vendor/.test(e)), 'should complain about the vendor');
    t.assert(bad.errors.some((e) => /account manager/.test(e)), 'should complain about the account manager');
    t.assert(bad.errors.some((e) => /line/.test(e)), 'should complain about the lines');
  });

  t.test('the account manager is required, not optional', () => {
    // A PO with no account manager is a PO nobody owns, which is the exact
    // failure this app exists to end.
    const r = s.validateNew({
      vendorId: 'v1', lines: [{ description: 'Mug', qty: 10, unitCost: 2 }],
    }, ['v1'], ['alexis']);
    t.assert(!r.ok, 'a PO with no account manager should not validate');
  });

  t.test('an account manager who is not set up in Settings is rejected', () => {
    const r = s.validateNew({
      vendorId: 'v1', accountManager: 'ghost',
      lines: [{ description: 'Mug', qty: 10, unitCost: 2 }],
    }, ['v1'], ['alexis']);
    t.assert(!r.ok, 'an unknown account manager should not validate');
  });

  t.test('the account manager cannot be cleared once set', () => {
    // Required on create has to mean required forever, or a PO quietly loses
    // its owner on an unrelated edit.
    const r = s.validatePatch({ accountManager: '' }, ['v1'], ['alexis']);
    t.assert(!r.ok, 'blanking the account manager should be refused');
  });

  t.test('a vendor that is not on the list is rejected', () => {
    const r = s.validateNew({ vendorId: 'ghost', accountManager: 'alexis', lines: [{ description: 'Mug', qty: 10, unitCost: 2 }] }, ['v1'], ['alexis']);
    t.assert(!r.ok, 'an unknown vendor should not validate');
  });

  t.test('a good PO validates and keeps its Printavo link', () => {
    const r = s.validateNew({
      vendorId: 'v1',
      accountManager: 'alexis',
      lines: [{ description: 'Mug', qty: 10, unitCost: 2.5 }],
      printavo: { invoiceNumber: '66601', customerName: 'Acme', dueDate: '2026-09-30' },
    }, ['v1'], ['alexis']);
    t.assert(r.ok, 'should validate: ' + r.errors.join('; '));
    t.equal(r.record.printavo.invoiceNumber, '66601');
    t.equal(r.record.accountManager, 'alexis');
    t.equal(r.record.lines.length, 1);
  });

  /* -- who gets copied -- */

  t.test('the CC list is built in one place, so preview and send agree', () => {
    // A CC list that differs between the preview and the real send is the
    // kind of bug nobody notices until a customer is copied on something.
    const settings = {
      alwaysCc: ['ops@pmapparel.com'],
      accountManagers: [{ id: 'alexis', name: 'Alexis', email: 'alexis@pmapparel.com' }],
    };
    const cc = s.ccListFor({ accountManager: 'alexis' }, { ccEmail: 'rep@vendor.com' }, settings);
    t.equal(cc.join(','), 'ops@pmapparel.com,alexis@pmapparel.com,rep@vendor.com');
  });

  t.test('nobody is copied twice, whatever the casing', () => {
    const settings = {
      alwaysCc: ['Alexis@PMApparel.com'],
      accountManagers: [{ id: 'alexis', name: 'Alexis', email: 'alexis@pmapparel.com' }],
    };
    t.equal(s.ccListFor({ accountManager: 'alexis' }, {}, settings).length, 1);
  });

  t.test('a malformed address is dropped rather than sent to', () => {
    const settings = { alwaysCc: ['not-an-address'], accountManagers: [] };
    t.equal(s.ccListFor({}, {}, settings).length, 0);
  });

  t.test('CC addresses can be typed with commas, semicolons or newlines', () => {
    // People paste all three, and none of them should be "the wrong way".
    t.equal(s.parseEmailList('a@x.com, b@x.com; c@x.com\nd@x.com').length, 4);
  });

  t.test('settings fall back to sane defaults rather than undefined', () => {
    const d = s.withSettingDefaults({});
    t.equal(d.chaseAfterDays, 3);
    t.equal(d.alwaysCc.length, 0);
    t.equal(d.accountManagers.length, 0);
  });

  t.test('an account manager with a bad address is refused at settings time', () => {
    const r = s.validateSettings({ accountManagers: [{ name: 'Alexis', email: 'nope' }] });
    t.assert(!r.ok, 'should refuse an address that cannot receive mail');
  });

  t.test('a nonsense date is rejected rather than stored as garbage', () => {
    const r = s.validatePatch({ shippedAt: 'sometime next week' }, ['v1']);
    t.assert(!r.ok, 'an unparseable date should not validate');
  });

  t.test('clearing a date is allowed, since a date can be entered by mistake', () => {
    const r = s.validatePatch({ shippedAt: '' }, ['v1']);
    t.assert(r.ok, 'clearing should be allowed');
    t.equal(r.patch.shippedAt, null);
  });

  /* -- the autofill rule that matters most -- */

  const pl = await import('../lib/promopro/printavo-lookup.js');

  t.test('autofill never copies the customer price into our cost', () => {
    // Printavo holds what we CHARGE. A PO holds what the vendor charges US.
    // A filled-in wrong number is worse than a blank one, because nobody
    // checks a field that already looks answered.
    const inv = pl.normalizeInvoice({
      id: '1', visualId: 66601, total: 900, customerDueAt: '2026-09-30T00:00:00Z',
      contact: { fullName: 'Acme' },
      lineItemGroups: { nodes: [{ id: 'g1', name: 'Front', lineItems: { nodes: [
        { id: 'l1', description: 'Tee', quantity: 50, color: 'Black', sizes: 'S-XL', price: 18 },
      ] } }] },
    });
    t.equal(inv.lines[0].unitCost, 0);
    t.equal(inv.lines[0].qty, 50);
    t.equal(inv.lines[0].description, 'Tee');
  });

  t.test('autofill survives an invoice with no line items', () => {
    const inv = pl.normalizeInvoice({ id: '1', visualId: 70000, contact: {}, lineItemGroups: { nodes: [] } });
    t.equal(inv.lines.length, 0);
    t.equal(inv.invoiceNumber, '70000');
  });

  t.test('autofill degrades rather than throwing on unexpected field names', () => {
    // Printavo leaf field names vary by account configuration. A blank
    // description the buyer types over beats a crash.
    const inv = pl.normalizeInvoice({
      id: '1', visualId: 70001, contact: {},
      lineItemGroups: { nodes: [{ id: 'g1', lineItems: { nodes: [{ id: 'l1' }] } }] },
    });
    t.equal(inv.lines.length, 1);
    t.assert(typeof inv.lines[0].description === 'string', 'description should still be a string');
  });

  process.exit(t.report());
})();
