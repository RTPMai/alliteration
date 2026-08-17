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
// A missing file should produce a NAMED failure, not crash the whole test
// file before it can say which one. That is what happened on Aug 14: the
// suite blew up at load instead of reporting the absent settings route.
const readSoft = (p) => { try { return read(p); } catch (e) { return ''; } };
const exists = (p) => fs.existsSync(path.join(ROOT, p));

const app = read('apps/promopro.js');
const posRoute = read('api/promopro/pos.js');
const vendorsRoute = read('api/promopro/vendors.js');
const printavoRoute = read('api/promopro/printavo.js');
const settingsRoute = readSoft('api/promopro/settings.js');
const artRoute = readSoft('api/promopro/art.js');
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
  ['ppPos', 'ppVendors', 'ppPrintavo', 'ppSettings', 'ppArt'].forEach((k) => {
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
  [['pos', posRoute], ['vendors', vendorsRoute], ['printavo', printavoRoute], ['settings', settingsRoute], ['art', artRoute]].forEach(([name, src]) => {
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

t.test('the schema probe is admin only and writes nothing', () => {
  // It dumps field names and one invoice's contents, which is more than a
  // normal user needs, so it sits behind the same gate as Settings.
  const probeBlock = printavoRoute.slice(printavoRoute.indexOf('probe'));
  t.assert(/isAdminSession/.test(probeBlock.slice(0, 400)), 'the probe should require admin');
  t.assert(printavoRoute.includes('read-only'), 'the probe must not write to Printavo');
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

t.test('every promopro endpoint has a route file that actually exists', () => {
  // This is the check that would have caught the Aug 14 outage. All the code
  // agreed the settings endpoint existed: the seam declared it, the app
  // called it, the tests passed. The FILE just never got uploaded, so the
  // app died on mount with a 404 and a message that named none of the three
  // routes it had tried. Declaring an endpoint and shipping its handler are
  // two separate acts, and only one of them was being verified.
  const declared = [...apiJs.matchAll(/(pp\w+):\s*'(\/api\/promopro\/[\w-]+)'/g)]
    .map((m) => ({ key: m[1], path: m[2] }));
  t.assert(declared.length >= 4, 'expected several promopro endpoints, found ' + declared.length);
  declared.forEach(({ key, path: p }) => {
    const file = 'api' + p.replace('/api', '') + '.js';
    t.assert(exists(file),
      'ENDPOINTS.' + key + ' points at ' + p + ' but ' + file + ' does not exist');
  });
});

t.test('one missing route degrades a section instead of blanking the app', () => {
  // Promise.all meant a single 404 rejected everything and the whole app
  // rendered "could not load". allSettled keeps the rest of the screen alive
  // and names which part failed.
  t.assert(app.includes('Promise.allSettled'),
    'app data loading should use allSettled so one dead route is survivable');
  t.assert(app.includes('loadErrors'), 'a failed load should be reported, not swallowed');
});

t.test('the vendor picker is searchable and posts an id, not typed text', () => {
  t.assert(app.includes('ppVendorSearch'), 'no searchable vendor input');
  t.assert(app.includes('data-vendorpick'), 'no pickable vendor results');
  t.assert(/vendorId: \$\('#ppVendor'\)\.value/.test(app),
    'the PO must post the hidden vendor id, never the typed text');
  // Typing after a pick has to clear the pick, or the id can be left pointing
  // at a vendor whose name is no longer in the box.
  t.assert(/ppVendorSearch'\)?\s*\{[\s\S]{0,240}draftVendorId = ''/.test(app),
    'typing should clear a previous vendor selection');
});

t.test('the settings route reads the roster from CrewCore, not a stored copy', () => {
  t.assert(settingsRoute.includes('lib/crewcore/store.js'), 'settings should read the CrewCore roster');
  t.assert(settingsRoute.includes('resolveAccountManagers'), 'names should be resolved, not stored');
});

t.test('a CrewCore outage does not take PromoPro down with it', () => {
  t.assert(/catch[\s\S]{0,200}rosterUnavailable|rosterUnavailable/.test(settingsRoute),
    'a failed roster read should degrade to an explained empty list');
});

t.test('the full roster goes to admins only', () => {
  // The Settings screen needs everyone; the new-PO form only needs whoever
  // was chosen. CrewCore is gated for pay and review notes, and this route
  // touches neither, but there is no reason to hand the whole staff list to
  // every signed-in user either.
  t.assert(/if \(isAdmin\) settings\.candidates/.test(settingsRoute),
    'the candidate roster should be admin-only');
});

t.test('a failed settings load is never reported as an empty CrewCore roster', () => {
  // The Aug 14 misdiagnosis: the settings route 404'd because the file was
  // uploaded as "settings,js" with a comma, and the screen said "No active
  // employees found in CrewCore". That sent the search at the roster when
  // the roster had never been read at all.
  t.assert(app.includes('settingsFailed'), 'a settings-load failure should be tracked distinctly');
  const idx = app.indexOf('No account managers to choose from');
  const guard = app.indexOf('if (st.settingsFailed)');
  t.assert(guard !== -1 && idx !== -1 && guard < idx,
    'the settings-failed branch must come before the empty-roster message');
});

t.test('an empty picker names its cause instead of guessing', () => {
  // Four causes land in the same place and want completely different fixes:
  // no records, none active, none with an email, or the caller not being
  // treated as an admin. Guessing sent one round of debugging at CrewCore
  // when the real problem was the route's admin check.
  t.assert(settingsRoute.includes('rosterCounts'), 'the route should report what it actually read');
  t.assert(app.includes('not being treated as an administrator'),
    'the not-an-admin case needs to be distinguishable from an empty roster');
});

t.test('every promopro route uses the shell-wide admin test', () => {
  // Checking the role NAME ("admin") excluded manager and every custom role,
  // and permsFor(undefined) on a session with no username silently returns a
  // non-admin. Both are why Settings decided Ryan was not an admin. The rest
  // of the shell tests data_scope and guards the missing username, so
  // PromoPro does too, in one place.
  [['pos', posRoute], ['vendors', vendorsRoute], ['settings', settingsRoute]].forEach(([name, src]) => {
    t.assert(src.includes('isAdminSession'),
      'api/promopro/' + name + '.js should use the shared admin check');
    t.assert(!/perms\.role === "admin"/.test(src),
      'api/promopro/' + name + '.js still matches the role name literally');
  });
});

t.test('the shared admin check accepts a session with no username', () => {
  const access = fs.readFileSync(path.join(ROOT, 'lib/promopro/access.js'), 'utf8');
  t.assert(/s\.username \? await getUser/.test(access),
    'a session carrying only a role must still resolve, same as the working routes');
  t.assert(access.includes('data_scope === "all"'),
    'admin should mean data_scope all, not a literal role name');
});

t.test('saving is refused when settings never loaded', () => {
  // Otherwise Save posts defaults over whatever was really stored.
  t.assert(/st\.settingsFailed[\s\S]{0,200}overwrite/.test(app),
    'save should refuse rather than overwrite unread settings');
});

t.test('a roster with no emails says so, rather than showing silent grey rows', () => {
  t.assert(app.includes('Nobody on the roster has an email address yet'),
    'the all-unselectable case needs its own explanation');
});

t.test('art upload is size-capped before the file is decoded', () => {
  // Checking after Buffer.from() would mean allocating the oversized file
  // first, which is the thing the cap exists to avoid.
  const capIdx = artRoute.indexOf('MAX_BYTES');
  const bufIdx = artRoute.indexOf('Buffer.from');
  t.assert(capIdx !== -1 && bufIdx !== -1 && capIdx < bufIdx,
    'the size check must come before decoding');
});

t.test('art uploads get an unguessable URL', () => {
  t.assert(artRoute.includes('addRandomSuffix: true'),
    'a predictable blob path would make every PO art file enumerable');
});

t.test('removing art does not yank the file from a vendor mid-job', () => {
  t.assert(/does not delete the blob/i.test(artRoute),
    'the reasoning for keeping the blob should stay documented');
});

t.test('the UPS account number is not committed to source', () => {
  // This repository is public. Anything that could be used to bill freight
  // to P&M belongs in Settings, which lives in the database.
  const sources = [read('lib/promopro/schema.js'), app, settingsRoute];
  sources.forEach((src) => {
    t.assert(!/\b\d{3}-\d{3}\b(?![^<]*placeholder)/.test(src.replace(/1100 South 5th St[^"']*/g, '')),
      'a freight account number looks like it has been hardcoded');
  });
  t.assert(read('lib/promopro/schema.js').includes('DEFAULT_SHIP_TO'),
    'the shop address is public information and can stay in source');
});

t.test('confirming the imprints collapses the picker and the invoice banner', () => {
  // Once the imprints are chosen those controls have done their job, and
  // leaving them open buries the fields still to be filled under choices
  // already made.
  t.assert(app.includes('imprintLocked'), 'no locked state');
  t.assert(app.includes('ppUseImprints') && app.includes('ppUnlockImprints'),
    'there must be a way to confirm and a way to go back');
  t.assert(/st\.picked && !st\.imprintLocked/.test(app),
    'the "Filling from Printavo invoice" banner should hide once confirmed');
  t.assert(/st\.imprintLocked \? '' :[\s\S]{0,200}ppSearch/.test(app),
    'the Printavo search box should hide once confirmed');
});

t.test('a PO can cover more than one imprint', () => {
  t.assert(app.includes('type="checkbox" data-imprint'),
    'imprints should be multi-selectable, not one-of');
  t.assert(/pickedGroups\.concat/.test(app), 'ticking a second imprint should add to the selection');
});

t.test('a multi-imprint PO number is editable rather than invented', () => {
  // One imprint is unambiguous. Two has no established convention here, and
  // a made-up number on a document a vendor reads is worse than asking.
  t.assert(app.includes('ppSuffix'), 'the suffix must be editable');
  t.assert(app.includes("join('+')"), 'a sensible default is fine, deciding silently is not');
});

t.test('artwork can be attached while creating, not only afterwards', () => {
  // It used to live only on the detail screen, which you reach by clicking a
  // PO that does not exist yet. "Create it, then go find it again to attach
  // the art" is how art ends up never attached.
  t.assert(app.includes('stagedArt'), 'the create form should hold files before the PO exists');
  t.assert(app.includes('ppStagePick'), 'the create form needs its own attach control');
  t.assert(app.includes('uploadArtTo'), 'both paths should share one upload routine');
});

t.test('a failed art upload never loses the purchase order', () => {
  // The order is real and correct by then. Rolling it back because an upload
  // stalled would be far worse than an order with art still to add.
  const save = app.slice(app.indexOf('async function saveNew'));
  t.assert(/The order was created, but/.test(save),
    'a partial art failure should be reported, with the PO kept');
  t.assert(!/rollback|deletePo/.test(save.slice(0, 2000)), 'the PO must not be undone');
});

t.test('one bad file does not abandon the rest of the batch', () => {
  const fn = app.slice(app.indexOf('async function uploadArtTo'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  t.assert(/failed\.push/.test(body), 'a failure should be collected');
  t.assert(!/\breturn;\s*\n\s*}\s*catch/.test(body),
    'a failure should carry on to the next file rather than stopping the run');
});

t.test('no function in the app is defined but never called', () => {
  // Aug 2026: imprintPickerHtml() was written, wired to state, styled and
  // tested, and never actually called. A string replacement that was meant
  // to drop it into the form silently matched nothing, so the picker existed
  // in the file and never rendered. Every other test passed, because they
  // all checked that the function EXISTED.
  //
  // A helper that appears exactly once is a helper nobody uses.
  const names = [...app.matchAll(/^\s*(?:async\s+)?function\s+(\w+)\s*\(/gm)].map((m) => m[1]);
  t.assert(names.length > 5, 'expected to find several functions, found ' + names.length);
  const orphans = names.filter((n) => {
    const uses = app.split(new RegExp('\\b' + n + '\\b')).length - 1;
    return uses < 2;
  });
  t.assert(orphans.length === 0,
    'defined but never called: ' + orphans.join(', '));
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

  t.test('the suffix is the imprint number, not a count of our POs', () => {
    // Corrected Aug 2026. It used to be a running count: first PO on a job
    // got -1, second got -2. The real rule is the imprint's own number on
    // the Printavo job, so the promo imprint on 66608 is 66608-9 whether it
    // is the first PO we raise or the only one. The two rules agree by
    // accident on a single-imprint job and disagree on every other.
    t.equal(s.buildPoNumber({ year: '26', invoiceNumber: '66608', imprintNumber: 9 }), '26-66608-9');
  });

  t.test('the imprint number does not depend on what else exists', () => {
    // A number a vendor already has must never change underneath them
    // because somebody raised an unrelated PO on the same job.
    const a = st.numberFor({ year: '26', createdAt: '2026-08-01T00:00:00Z', printavo: { invoiceNumber: '66608', imprintNumber: 9 } });
    const b = st.numberFor({ year: '26', createdAt: '2026-08-05T00:00:00Z', printavo: { invoiceNumber: '66608', imprintNumber: 3 } });
    t.equal(a, '26-66608-9');
    t.equal(b, '26-66608-3');
  });

  t.test('the suffix can be whatever the buyer confirmed', () => {
    // Including a two-imprint form. buildPoNumber does not get to decide
    // what a multi-imprint PO is called.
    t.equal(s.buildPoNumber({ year: '26', invoiceNumber: '66608', imprintNumber: '9+10' }), '26-66608-9+10');
    t.equal(s.buildPoNumber({ year: '26', invoiceNumber: '66608', imprintNumber: 9 }), '26-66608-9');
  });

  t.test('a PO records every imprint it covers, not just the suffix', () => {
    // The suffix is a label. Which imprints were actually ordered is data,
    // and it is what a later reconciliation would need.
    const r = s.validateNew({
      vendorId: 'v1', accountManager: 'alexis',
      lines: [{ description: 'Koozie', qty: 250, unitCost: 1 }],
      printavo: { invoiceNumber: '66608', imprintNumber: '9+10', imprintNumbers: [9, 10], groupIds: ['g9', 'g10'] },
    }, ['v1'], ['alexis']);
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.record.printavo.imprintNumbers.join(','), '9,10');
    t.equal(r.record.printavo.groupIds.length, 2);
  });

  t.test('no imprint number means no suffix', () => {
    t.equal(s.buildPoNumber({ year: '26', invoiceNumber: '66608' }), '26-66608');
  });

  t.test('a manual web order is obviously not a Printavo job', () => {
    // No invoice number to build from, so an M sequence takes the middle slot
    // and anyone reading the number can see no Printavo job sits behind it.
    t.equal(s.buildPoNumber({ year: '26', manualSeq: 14, seq: 1, total: 1 }), '26-M014');
  });

  t.test('two POs on different jobs never collide', () => {
    const a = st.numberFor({ year: '26', printavo: { invoiceNumber: '66601', imprintNumber: 1 } });
    const b = st.numberFor({ year: '26', printavo: { invoiceNumber: '66602', imprintNumber: 1 } });
    t.assert(a !== b, 'different invoices should give different PO numbers');
  });

  t.test('two imprints on the same job get different numbers', () => {
    const a = st.numberFor({ year: '26', printavo: { invoiceNumber: '66608', imprintNumber: 3 } });
    const b = st.numberFor({ year: '26', printavo: { invoiceNumber: '66608', imprintNumber: 9 } });
    t.assert(a !== b, 'different imprints on one job must differ');
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

  /* -- item number, shipping -- */

  t.test('a line can carry the vendor item number', () => {
    const r = s.validateNew({
      vendorId: 'v1', accountManager: 'alexis',
      lines: [{ itemNumber: '1234-BLK', description: 'Mug', qty: 10, unitCost: 2 }],
    }, ['v1'], ['alexis']);
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.record.lines[0].itemNumber, '1234-BLK');
  });

  t.test('an item number is optional, because manual orders often have none', () => {
    const r = s.validateNew({
      vendorId: 'v1', accountManager: 'alexis',
      lines: [{ description: 'Custom banner', qty: 1, unitCost: 40 }],
    }, ['v1'], ['alexis']);
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.record.lines[0].itemNumber, '');
  });

  t.test('the shop address is the default ship-to', () => {
    t.assert(/Polk City/.test(s.withSettingDefaults({}).defaultShipTo),
      'a new install should already know where to ship');
  });

  t.test('shipping instructions default to blank, never to a real account number', () => {
    // The repo is public. A freight account seeded in source would be
    // committed the first time anyone deployed.
    t.equal(s.withSettingDefaults({}).shippingInstructions, '');
  });

  t.test('a PO keeps its own copy of the shipping instructions', () => {
    // A PO is a document that went to an outside party. Changing the shop
    // default later must not rewrite what a vendor was told last month.
    const r = s.validateNew({
      vendorId: 'v1', accountManager: 'alexis',
      shipTo: '1100 South 5th St, Polk City, IA 50226',
      shippingInstructions: 'Ship via our UPS account',
      lines: [{ description: 'Mug', qty: 1, unitCost: 2 }],
    }, ['v1'], ['alexis']);
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.record.shippingInstructions, 'Ship via our UPS account');
  });

  t.test('a settings change can update both shipping fields', () => {
    const r = s.validateSettings({ defaultShipTo: 'Somewhere else', shippingInstructions: 'Ground only' });
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.patch.defaultShipTo, 'Somewhere else');
    t.equal(r.patch.shippingInstructions, 'Ground only');
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

  t.test('normalizing a settings payload does not throw away what the route attached', () => {
    // The Aug 14 bug, in one line. withSettingDefaults rebuilt the object
    // from four known keys, so candidates/rosterCounts/usingDefaults were
    // deleted the moment the response reached the browser. The server was
    // returning thirteen employees and six valid addresses; the picker was
    // empty before anything rendered. A normalizer supplies what is absent,
    // it does not decide what is allowed through.
    const fromRoute = {
      chaseAfterDays: 3,
      alwaysCc: [],
      accountManagerIds: ['EMP-00005', 'EMP-00003'],
      accountManagers: [{ id: 'EMP-00005', name: 'Abby Penton', email: 'abby@pmapparel.com' }],
      candidates: [{ id: 'EMP-00005', name: 'Abby Penton', selectable: true }],
      rosterCounts: { total: 13, active: 13, withEmail: 6, adminView: true },
      usingDefaults: true,
    };
    const after = s.withSettingDefaults(fromRoute);
    t.assert(Array.isArray(after.candidates) && after.candidates.length === 1,
      'the candidate roster must survive normalizing');
    t.assert(after.rosterCounts && after.rosterCounts.total === 13,
      'the roster counts must survive, or an empty picker cannot explain itself');
    t.equal(after.usingDefaults, true);
    t.equal(after.accountManagers.length, 1);
  });

  t.test('normalizing still fills in a completely empty payload', () => {
    const d = s.withSettingDefaults(null);
    t.equal(d.chaseAfterDays, 3);
    t.equal(d.alwaysCc.length, 0);
    t.equal(d.accountManagerIds.length, 0);
  });

  t.test('normalizing still repairs bad values rather than passing them through', () => {
    const d = s.withSettingDefaults({ chaseAfterDays: -4, alwaysCc: 'nope', accountManagerIds: 'nope' });
    t.equal(d.chaseAfterDays, 3);
    t.equal(d.alwaysCc.length, 0);
    t.equal(d.accountManagerIds.length, 0);
  });

  t.test('settings fall back to sane defaults rather than undefined', () => {
    const d = s.withSettingDefaults({});
    t.equal(d.chaseAfterDays, 3);
    t.equal(d.alwaysCc.length, 0);
    t.equal(d.accountManagers.length, 0);
  });

  /* -- account managers come from CrewCore, not a typed list -- */

  const am = await import('../lib/promopro/account-managers.js');

  const roster = [
    { id: 'e1', name: 'Alexis Davis', email: 'alexis@pmapparel.com', department: 'Sales', status: 'active' },
    { id: 'e2', name: 'Jacob Whitman', email: 'jacob@pmapparel.com', department: 'Sales', status: 'active' },
    { id: 'e3', name: 'Margo Niemeyer', email: 'margo@pmapparel.com', department: 'Screen Printing', status: 'active' },
    { id: 'e4', name: 'No Email', email: '', department: 'Sales', status: 'active' },
    { id: 'e5', name: 'Former Person', email: 'gone@pmapparel.com', department: 'Sales', status: 'terminated' },
  ];

  t.test('settings store employee ids only, never names or addresses', () => {
    // A second copy of the roster is a copy that goes stale. Somebody changes
    // their address in CrewCore, PromoPro keeps CC-ing the old one, and
    // nothing tells you.
    const r = s.validateSettings({ accountManagerIds: ['e1', 'e2'] });
    t.assert(r.ok, 'should validate: ' + r.errors.join('; '));
    t.equal(r.patch.accountManagerIds.join(','), 'e1,e2');
    t.assert(!('accountManagers' in r.patch), 'resolved names must never be written to storage');
  });

  t.test('names and addresses resolve live from the roster', () => {
    const resolved = am.resolveAccountManagers(['e1', 'e3'], roster);
    t.equal(resolved.length, 2);
    t.equal(resolved[0].email, 'alexis@pmapparel.com');
    t.equal(resolved[1].name, 'Margo Niemeyer');
  });

  t.test('an address changed in CrewCore changes here, with no action taken', () => {
    const moved = roster.map((e) => (e.id === 'e1' ? { ...e, email: 'a.davis@pmapparel.com' } : e));
    t.equal(am.resolveAccountManagers(['e1'], moved)[0].email, 'a.davis@pmapparel.com');
  });

  t.test('somebody with no email is shown but cannot be picked', () => {
    // Picking them would mean a PO whose owner is silently never copied.
    // Showing them greyed with a reason beats hiding them and having
    // somebody hunt for a name that should be there.
    const c = am.candidatesFrom(roster).find((x) => x.id === 'e4');
    t.assert(c, 'the person with no email should still be listed');
    t.assert(!c.selectable, 'they should not be selectable');
    t.assert(/email/i.test(c.reason), 'the reason should say why');
  });

  t.test('an unselectable person is dropped even if their id was saved', () => {
    t.equal(am.resolveAccountManagers(['e4'], roster).length, 0);
  });

  t.test('people who have left the company are not offered', () => {
    t.assert(!am.candidatesFrom(roster).some((c) => c.id === 'e5'),
      'a terminated employee should not appear');
  });

  t.test('first run offers Sales rather than an empty blocking picker', () => {
    // An empty list blocks every purchase order until somebody visits
    // Settings, which is a bad first five minutes.
    const d = am.defaultSelection(roster);
    t.assert(d.includes('e1') && d.includes('e2'), 'Sales should be offered by default');
    t.assert(!d.includes('e3'), 'other departments should not be, though they can be added');
    t.assert(!d.includes('e4'), 'somebody with no email cannot be a default');
  });

  t.test('an id that no longer resolves is dropped, not returned half-formed', () => {
    t.equal(am.resolveAccountManagers(['ghost'], roster).length, 0);
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

  /* -- clicking a search result must never do nothing -- */

  function fakePrintavo(handler) {
    const calls = [];
    global.fetch = async (url, opts) => {
      const q = JSON.parse(opts.body).query;
      calls.push(q);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => handler(q, calls.length) };
    };
    return calls;
  }

  const OK_INVOICE = {
    id: '1', visualId: 66601, total: 900, customerDueAt: '2026-09-30T00:00:00Z',
    contact: { fullName: 'Acme Corp' },
    lineItemGroups: { nodes: [{ id: 'g1', lineItems: { nodes: [
      { id: 'l1', description: 'Gildan Tee', quantity: 50 },
    ] } }] },
  };

  t.test('an unknown line-item field degrades instead of failing the lookup', async () => {
    // GraphQL validates the whole query first, so ONE field this account
    // does not have makes the entire request fail and the invoice come back
    // null. That is what made clicking a search result do nothing: a
    // speculative styleNumber field was added without checking the schema.
    process.env.PRINTAVO_API_TOKEN = 'x';
    process.env.PRINTAVO_EMAIL = 'x@y.com';
    const supported = new Set(['id', 'description', 'quantity']);
    fakePrintavo((q) => {
      const leaf = (q.match(/lineItems \{ nodes \{ ([^}]*)\}/) || [])[1] || '';
      const asked = leaf.trim().split(/\s+/).filter((w) => /^[a-z]/i.test(w) && w !== 'name');
      const bad = asked.find((f) => !supported.has(f.replace(/[{}]/g, '')));
      if (bad) return { errors: [{ message: `Field '${bad}' doesn't exist on type 'LineItem'` }] };
      return { data: { invoice: OK_INVOICE } };
    });
    const r = await pl.getInvoice('1');
    t.assert(r.invoice, 'a reduced field set should still return the invoice');
    t.equal(r.via, 'basic');
    t.equal(r.invoice.lines[0].qty, 50);
    t.equal(r.invoice.customerName, 'Acme Corp');
  });

  t.test('a real error stops immediately rather than retrying every field set', async () => {
    // Retrying an auth failure five times just burns five requests against
    // Printavo's rate limiter and reports the same thing at the end.
    process.env.PRINTAVO_API_TOKEN = 'x';
    process.env.PRINTAVO_EMAIL = 'x@y.com';
    const calls = fakePrintavo(() => ({ errors: [{ message: 'Not authorized' }] }));
    const r = await pl.getInvoice('1');
    t.equal(r.invoice, null);
    t.equal(calls.length, 1);
    t.assert(/Not authorized/.test(r.tried[0].error), 'the real reason should be reported');
  });

  t.test('a failed lookup always carries a reason back to the screen', async () => {
    process.env.PRINTAVO_API_TOKEN = 'x';
    process.env.PRINTAVO_EMAIL = 'x@y.com';
    fakePrintavo(() => ({ data: { invoice: null } }));
    const r = await pl.getInvoice('999');
    t.equal(r.invoice, null);
    t.assert(r.tried.length && r.tried[0].error, 'there must be something to show the user');
  });

  t.test('the app shows the reason instead of returning silently', () => {
    t.assert(app.includes('Could not load that order'),
      'a search result that does nothing when clicked is the worst outcome');
    t.assert(!/const inv = res && res\.invoice;\s*if \(!inv\) return;/.test(app),
      'the silent return is back');
  });

  /* -- only the promo imprint -- */

  const INVOICE_66608 = {
    id: 'f76a', visualId: 66608, contact: { fullName: 'Acme' },
    lineItemGroups: { nodes: [
      { id: 'g1', position: 1, lineItems: { nodes: [
        { id: 'a', description: 'Tee', itemNumber: 'G500', items: 100, category: { name: 'T-Shirts' } },
      ] } },
      { id: 'g9', position: 9, lineItems: { nodes: [
        { id: 'b', description: 'Koozie', itemNumber: 'KZ-100', items: 250, category: { name: 'Promotional Products' } },
      ] } },
    ] },
  };

  t.test('lines are grouped by imprint, each carrying its own number', () => {
    const inv = pl.normalizeInvoice(INVOICE_66608);
    t.equal(inv.groups.length, 2);
    t.equal(inv.groups[0].imprintNumber, 1);
    t.equal(inv.groups[1].imprintNumber, 9);
  });

  t.test('only the promo imprint is offered once categories are known', () => {
    const inv = pl.normalizeInvoice(INVOICE_66608);
    const promo = pl.promoGroups(inv, ['Promotional Products']);
    t.equal(promo.groups.length, 1);
    t.equal(promo.groups[0].imprintNumber, 9);
    t.equal(promo.groups[0].lines[0].itemNumber, 'KZ-100');
  });

  t.test('the promo imprint on 66608 numbers the PO 26-66608-9', () => {
    // The whole point, end to end: pick the invoice, pick the promo imprint,
    // get the number Ryan actually uses.
    const inv = pl.normalizeInvoice(INVOICE_66608);
    const g = pl.promoGroups(inv, ['Promotional Products']).groups[0];
    t.equal(st.numberFor({
      year: '26',
      printavo: { invoiceNumber: inv.invoiceNumber, imprintNumber: g.imprintNumber },
    }), '26-66608-9');
  });

  t.test('before categories are configured, everything is shown rather than nothing', () => {
    // Showing every imprint with "tell me which are promo" beats an empty
    // list that looks broken, and beats guessing and quietly pulling
    // garments onto a promo PO.
    const inv = pl.normalizeInvoice(INVOICE_66608);
    const promo = pl.promoGroups(inv, []);
    t.equal(promo.groups.length, 2);
    t.equal(promo.matched, false);
  });

  t.test('the categories on a job are surfaced for ticking', () => {
    // So nobody has to type a category name exactly right.
    const inv = pl.normalizeInvoice(INVOICE_66608);
    t.equal(inv.categories.join('|'), 'T-Shirts|Promotional Products');
  });

  t.test('promo categories are matched without case sensitivity', () => {
    const inv = pl.normalizeInvoice(INVOICE_66608);
    t.equal(pl.promoGroups(inv, ['promotional products']).groups.length, 1);
  });

  t.test('promo categories are stored, not hardcoded', () => {
    // Category names differ per account and change over time. A guess baked
    // into code is a guess nobody can correct without a deploy.
    const r = s.validateSettings({ promoCategories: ['Promotional Products', 'promotional products', 'Drinkware'] });
    t.assert(r.ok, r.errors.join('; '));
    t.equal(r.patch.promoCategories.length, 2);
  });

  t.test('autofill reads the field names this account actually has', () => {
    // Probed Aug 2026 against pmapparel's Printavo. Two surprises worth
    // locking in: there is no `quantity` field, the quantity is `items`; and
    // the item number is `itemNumber`, not `styleNumber`. Guessing
    // `styleNumber` made GraphQL reject the whole query, which is why
    // clicking a search result did nothing.
    const inv = pl.normalizeInvoice({
      id: '1', visualId: 66608, contact: {},
      lineItemGroups: { nodes: [{ id: 'g1', position: 9, lineItems: { nodes: [
        { id: 'l1', description: 'Koozie', itemNumber: 'KZ-100', items: 250, color: 'Red',
          category: { id: 'c1', name: 'Promotional Products' } },
      ] } }] },
    });
    t.equal(inv.lines[0].itemNumber, 'KZ-100');
    t.equal(inv.lines[0].qty, 250);
    t.equal(inv.lines[0].category, 'Promotional Products');
  });

  t.test('the query never asks for a field this account does not have', () => {
    const src = read('lib/promopro/printavo-lookup.js');
    const sets = src.slice(src.indexOf('const LINE_FIELD_SETS'), src.indexOf('function invoiceQuery'));
    ['styleNumber', 'sku', 'productNumber', 'quantity'].forEach((f) => {
      t.assert(!new RegExp('\\b' + f + '\\b').test(sets),
        'the line-item query still asks for "' + f + '", which this account does not have');
    });
    t.assert(/\bitemNumber\b/.test(sets) && /\bitems\b/.test(sets),
      'the query should use the confirmed itemNumber and items fields');
  });

  t.test('the item number never just repeats the description', () => {
    // When Printavo has no style field, "style" falls through to the same
    // text as the description. Two identical columns on a PO is noise.
    const inv = pl.normalizeInvoice({
      id: '1', visualId: 1, contact: {},
      lineItemGroups: { nodes: [{ id: 'g1', lineItems: { nodes: [
        { id: 'l1', description: 'G500', quantity: 5, style: 'G500' },
      ] } }] },
    });
    t.equal(inv.lines[0].itemNumber, '');
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
