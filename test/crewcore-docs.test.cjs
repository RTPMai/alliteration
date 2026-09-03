/**
 * CrewCore documentation (Sep 2026).
 *
 * Ryan's ask: somewhere to write up an issue or a problem with an employee,
 * kept with the review history, and NOT VISIBLE TO THE PERSON IT IS ABOUT.
 *
 * That last clause is the whole feature, so most of this file is about it,
 * and it is tested by CALLING THE ROUTE — a real handler, a real signed
 * session cookie, a fake Upstash underneath — rather than by reading the
 * source for the word "isAdmin". Grepping for a gate proves the letters are
 * there, not that a request is refused. Same lesson as
 * test/route-imports.test.cjs, and the stakes here are a written warning
 * appearing on the screen of the person it was written about.
 *
 * Two properties are checked separately, because they fail separately:
 *
 *   1. A non-admin caller is REFUSED. Every method, including GET.
 *   2. A non-admin request never READS a documentation key at all. The
 *      refusal happens before storage is touched, so a future edit that
 *      adds a GET branch cannot serve an entry by accident. Asserted by
 *      recording which keys the fake storage was asked for.
 *
 * And one property about the neighbours: the reviews route, which DOES have
 * a self-serve answer, must not have gained a documentation entry in it.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* ---- fake Upstash ------------------------------------------------------ *
 * Reads and writes, since these tests POST and PATCH. Every key read is
 * recorded: test 2 above is an assertion about what was NOT asked for.
 * ----------------------------------------------------------------------- */

const kv = new Map();
const reads = [];
const P = 'alliteration:';
const CC = 'crewcore_data';

global.fetch = async (url, opts) => {
  const raw = String(url);
  const setM = raw.match(/\/set\/(.+)$/);
  if (setM && opts && opts.method === 'POST') {
    kv.set(decodeURIComponent(setM[1]), opts.body);
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((raw.match(/\/get\/(.+)$/) || [])[1] || '');
  reads.push(key);
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-crewcore-docs';

function seed() {
  kv.clear();
  reads.length = 0;
  kv.set(P + 'users', JSON.stringify({
    ryan:  { username: 'ryan',  name: 'Ryan',  role: 'admin' },
    sasha: { username: 'sasha', name: 'Sasha', role: 'employee' },
    // A custom role with CrewCore ticked. This is the shape that reached the
    // whole app in Aug 2026 through data_scope, and it must not reach
    // documentation now.
    amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
  }));
  kv.set(P + 'roles', JSON.stringify({
    office: { name: 'office', label: 'Office', apps: ['crewcore'], data_scope: 'all', can_edit: true },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({
    id: 'EMP-1', name: 'Sasha', username: 'sasha', status: 'active', clock_enabled: true,
  }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({
    id: 'EMP-2', name: 'Dana', username: 'dana', status: 'active', clock_enabled: true,
  }));
}

/* ---- a real request ---------------------------------------------------- */

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  // setSessionCookie joins its parts with "; " — the token is the first one.
  return String(header).split('; ')[0];
}

function fakeRes() {
  const res = {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return res;
}

async function call(handler, { as, method = 'GET', query = {}, body = null }) {
  const cookie = await makeCookie(as);
  const req = { method, query, body, headers: { cookie } };
  const res = fakeRes();
  await handler(req, res);
  return res;
}

const ADMIN = { username: 'ryan', name: 'Ryan', role: 'admin' };
const EMPLOYEE = { username: 'sasha', name: 'Sasha', role: 'employee' };
const CUSTOM = { username: 'amanda', name: 'Amanda', role: 'office' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const schema = await import(path.join(ROOT, 'lib/crewcore/schema.js'));
  const store = await import(path.join(ROOT, 'lib/crewcore/store.js'));
  const docsRoute = (await import(path.join(ROOT, 'api/crewcore/docs.js'))).default;
  const reviewsRoute = (await import(path.join(ROOT, 'api/crewcore/reviews.js'))).default;
  const reg = await import(path.join(ROOT, 'js/registry.js'));

  const { validateDoc, docsFor, isFormalDoc, DOC_CATEGORIES, DOC_LEVELS, keys } = schema;

  /* ---- 1. THE POINT: an employee cannot read documentation ------------- */

  await check('a self-serve employee is refused on GET', async () => {
    seed();
    await store.saveDoc({
      employee_id: 'EMP-1', date: '2026-08-18', summary: 'Third late start',
      category: 'Attendance', level: 'verbal warning', created_by: 'ryan',
    });

    const res = await call(docsRoute, { as: EMPLOYEE });
    t.equal(res.statusCode, 403, 'an employee reading documentation must be refused');
    t.assert(!res.body.docs, 'and must not be handed a docs array at all, empty or otherwise');
  });

  await check('the entry the employee was refused is genuinely on file', async () => {
    // Guards against the test above passing because nothing exists to leak.
    const res = await call(docsRoute, { as: ADMIN });
    t.equal(res.statusCode, 200, 'an admin reads it fine');
    t.equal(res.body.docs.length, 1, 'there is a real entry behind that 403');
    t.equal(res.body.docs[0].employee_id, 'EMP-1', 'and it is about the person who was refused');
  });

  await check('the refusal happens before any documentation key is read', async () => {
    // The stronger half. A route that reads first and filters after is one
    // edit away from serving what it read; this asserts the gate sits in
    // front of storage, not behind it.
    seed();
    await store.saveDoc({ employee_id: 'EMP-1', date: '2026-08-18', summary: 'On file' });
    reads.length = 0;

    const res = await call(docsRoute, { as: EMPLOYEE });
    t.equal(res.statusCode, 403, 'refused');
    const touched = reads.filter((k) => k.startsWith(CC + ':doc'));
    t.equal(touched.length, 0,
      'no documentation key may be read for a non-admin caller, got: ' + touched.join(', '));
    t.assert(reads.length > 0, 'it did read something (the user record), so the recorder works');
  });

  await check('a custom role with CrewCore ticked is refused too', async () => {
    // data_scope "all" is the default on any role created in Settings. It
    // reached the whole app once. It must not reach this.
    const res = await call(docsRoute, { as: CUSTOM });
    t.equal(res.statusCode, 403, 'a custom role is not a CrewCore admin');
  });

  await check('every write method is refused for a non-admin, not just GET', async () => {
    seed();
    const existing = await store.saveDoc({ employee_id: 'EMP-1', date: '2026-08-18', summary: 'On file' });

    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await call(docsRoute, {
        as: EMPLOYEE, method,
        query: { id: existing.id },
        body: { employee_id: 'EMP-2', date: '2026-09-01', summary: 'Written by an employee' },
      });
      t.equal(res.statusCode, 403, method + ' must be refused for a non-admin');
    }
    const after = await store.listDocs();
    t.equal(after.length, 1, 'nothing was written and nothing was deleted');
    t.equal(after[0].summary, 'On file', 'and the existing entry is untouched');
  });

  await check('an unauthenticated request gets 401, not a list', async () => {
    const res = fakeRes();
    await docsRoute({ method: 'GET', query: {}, headers: {} }, res);
    t.equal(res.statusCode, 401, 'no cookie, no answer');
  });

  /* ---- 2. documentation is not smuggled through the reviews route ------ */

  await check('an employee reading their reviews gets reviews only', async () => {
    seed();
    await store.saveReview({
      id: 'REV-1', employee_id: 'EMP-1', review_date: '2026-06-15',
      reviewer_name: 'Ryan', summary: 'Good quarter',
    });
    await store.saveDoc({
      employee_id: 'EMP-1', date: '2026-08-18', summary: 'Third late start',
      level: 'written warning',
    });

    const res = await call(reviewsRoute, { as: EMPLOYEE });
    t.equal(res.statusCode, 200, 'their own review history is theirs to read');
    t.equal(res.body.reviews.length, 1, 'one review, not two records');
    t.equal(res.body.reviews[0].id, 'REV-1', 'and it is the review');
    const asText = JSON.stringify(res.body);
    t.assert(!asText.includes('late start'),
      'no documentation text may appear anywhere in the reviews payload');
    t.assert(!asText.includes('written warning'),
      'nor a documentation level');
  });

  await check('the two record types live under different keys', async () => {
    // The structural reason the test above cannot regress: there is no shared
    // index for a filter to have to exclude anything from.
    t.assert(keys.doc('X') !== keys.review('X'), 'a doc and a review cannot collide');
    t.assert(keys.docIndex() !== keys.reviewIndex(), 'and they are indexed separately');
    t.assert(keys.docIndex().startsWith('crewcore_data:'), 'still inside CrewCore storage');
  });

  await check('documentation is not a registry view, so no rail can draw it', async () => {
    const cc = reg.APPS.find((a) => a.id === 'crewcore');
    const viewKeys = cc.views.map(([k]) => k);
    ['docs', 'documentation', 'doc'].forEach((k) => {
      t.assert(!viewKeys.includes(k), 'documentation must not be a view: found "' + k + '"');
    });
    // Nor reachable by asking for it: allowedViews only ever returns
    // registered views.
    const wide = { role: 'office', superuser: false, tabs: ['crewcore'] };
    t.assert(!reg.allowedViews(wide, 'crewcore').some((v) => /doc/i.test(v)),
      'nothing documentation-shaped may reach a non-admin rail');
  });

  /* ---- 3. what an admin can do ----------------------------------------- */

  await check('an admin writes an entry and it comes back with who wrote it', async () => {
    seed();
    const res = await call(docsRoute, {
      as: ADMIN, method: 'POST',
      body: {
        employee_id: 'EMP-1', date: '2026-08-18', summary: 'Third late start in two weeks',
        category: 'Attendance', level: 'verbal warning',
        details: 'Arrived 25 minutes in.', action_taken: 'Verbal warning.',
      },
    });
    t.equal(res.statusCode, 201, 'created');
    t.equal(res.body.doc.created_by, 'ryan', 'the author is taken from the session, not the body');
    t.assert(res.body.doc.created_at, 'and stamped');
    t.assert(/^DOC-\d{5}$/.test(res.body.doc.id), 'with its own id series, got ' + res.body.doc.id);
  });

  await check('?employee_id= narrows the list to one person', async () => {
    await call(docsRoute, {
      as: ADMIN, method: 'POST',
      body: { employee_id: 'EMP-2', date: '2026-08-20', summary: 'Different person' },
    });
    const all = await call(docsRoute, { as: ADMIN });
    t.equal(all.body.docs.length, 2, 'two entries on file');
    const one = await call(docsRoute, { as: ADMIN, query: { employee_id: 'EMP-2' } });
    t.equal(one.body.docs.length, 1, 'filtered to one');
    t.equal(one.body.docs[0].employee_id, 'EMP-2', 'and it is the right one');
  });

  await check('a correction cannot move an entry onto somebody else', async () => {
    // Moving a write-up from one person's file to another's is not a
    // correction. It is a delete and a re-write, and it should look like one.
    seed();
    const made = await store.saveDoc({
      employee_id: 'EMP-1', date: '2026-08-18', summary: 'Third late start',
      created_by: 'ryan', created_at: '2026-08-18T12:00:00.000Z',
    });
    const res = await call(docsRoute, {
      as: ADMIN, method: 'PATCH', query: { id: made.id },
      body: { employee_id: 'EMP-2', created_by: 'somebody-else', summary: 'Corrected wording' },
    });
    t.equal(res.statusCode, 200, 'the correction itself is allowed');
    t.equal(res.body.doc.summary, 'Corrected wording', 'the field that was meant to change did');
    t.equal(res.body.doc.employee_id, 'EMP-1', 'but it is still on the same person s file');
    t.equal(res.body.doc.created_by, 'ryan', 'and still says who wrote it');
    t.equal(res.body.doc.created_at, '2026-08-18T12:00:00.000Z', 'with its original stamp');
    t.equal(res.body.doc.updated_by, 'ryan', 'plus who corrected it');
  });

  await check('a correction leaves untouched fields alone', async () => {
    seed();
    const made = await store.saveDoc({
      employee_id: 'EMP-1', date: '2026-08-18', summary: 'Late start',
      details: 'The long version', action_taken: 'Talked it through', level: 'note',
    });
    const res = await call(docsRoute, {
      as: ADMIN, method: 'PATCH', query: { id: made.id }, body: { level: 'written warning' },
    });
    t.equal(res.body.doc.details, 'The long version', 'the write-up survives a one-field patch');
    t.equal(res.body.doc.action_taken, 'Talked it through', 'so does the action');
    t.equal(res.body.doc.level, 'written warning', 'and the escalation landed');
  });

  await check('deleting takes the entry out of the index, not just the key', async () => {
    seed();
    const made = await store.saveDoc({ employee_id: 'EMP-1', date: '2026-08-18', summary: 'Late start' });
    const res = await call(docsRoute, { as: ADMIN, method: 'DELETE', query: { id: made.id } });
    t.equal(res.statusCode, 200, 'deleted');
    t.equal((await store.listDocIds()).length, 0, 'the index no longer lists it');
    t.equal((await store.listDocs()).length, 0, 'and the list is empty');
  });

  await check('a missing entry is a 404 rather than a silent success', async () => {
    const res = await call(docsRoute, { as: ADMIN, method: 'DELETE', query: { id: 'DOC-99999' } });
    t.equal(res.statusCode, 404, 'nothing to delete');
  });

  /* ---- 4. the record shape --------------------------------------------- */

  t.test('an entry needs a person, a date and one line saying what happened', () => {
    const r = validateDoc({});
    t.assert(!r.ok, 'an empty entry must not validate');
    ['employee_id', 'date', 'summary'].forEach((f) => {
      t.assert(r.errors.some((e) => e.includes(f)), 'missing ' + f + ' should be reported');
    });
  });

  t.test('a summary of nothing but spaces is not a summary', () => {
    const r = validateDoc({ employee_id: 'EMP-1', date: '2026-08-18', summary: '   ' });
    t.assert(!r.ok, 'whitespace must not pass as a heading');
  });

  t.test('the ordinary case needs no category or level chosen', () => {
    // Most of what gets written down is a thing that happened, not a warning.
    const r = validateDoc({ employee_id: 'EMP-1', date: '2026-08-18', summary: 'Broke a screen' });
    t.assert(r.ok, 'should validate');
    t.equal(r.record.category, 'Other', 'category defaults');
    t.equal(r.record.level, 'note', 'and a level of note, not a warning');
  });

  t.test('an invented category or level is refused', () => {
    t.assert(!validateDoc({ employee_id: 'E', date: '2026-01-01', summary: 'x', category: 'Vibes' }).ok,
      'a category off the list must be refused');
    t.assert(!validateDoc({ employee_id: 'E', date: '2026-01-01', summary: 'x', level: 'fired' }).ok,
      'so must a level');
  });

  t.test('a patch cannot blank out the summary it is meant to correct', () => {
    const r = validateDoc({ summary: '' }, { partial: true });
    t.assert(!r.ok, 'clearing the one readable line would leave an unreadable list');
  });

  t.test('a patch of one field carries only that field', () => {
    const r = validateDoc({ level: 'final warning' }, { partial: true });
    t.assert(r.ok, 'should validate');
    t.equal(Object.keys(r.record).length, 1, 'nothing else may be invented into the patch');
    t.equal(r.record.level, 'final warning');
  });

  t.test('category and level answer two different questions', () => {
    // One enum trying to hold both ends up needing a row per pairing.
    DOC_CATEGORIES.forEach((c) => {
      t.assert(!DOC_LEVELS.includes(c), 'category "' + c + '" must not also be a level');
    });
    t.equal(DOC_LEVELS[0], 'note', 'the levels read in escalation order, starting at note');
    t.assert(DOC_LEVELS.indexOf('written warning') > DOC_LEVELS.indexOf('verbal warning'),
      'a written warning comes after a verbal one');
  });

  t.test('a note is not formal; every warning is', () => {
    t.equal(isFormalDoc({ level: 'note' }), false, 'a note is the ordinary case');
    t.equal(isFormalDoc({}), false, 'and so is a record with no level at all');
    ['verbal warning', 'written warning', 'final warning', 'performance plan'].forEach((l) => {
      t.equal(isFormalDoc({ level: l }), true, l + ' is a formal step');
    });
    t.equal(isFormalDoc({ level: 'whatever' }), false, 'an unrecognised level is not promoted to formal');
    t.equal(isFormalDoc(null), false, 'and nothing is not formal');
  });

  t.test('scoping by person and year matches the stipend rules', () => {
    const rows = [
      { id: 'a', employee_id: 'EMP-1', date: '2026-08-18' },
      { id: 'b', employee_id: 'EMP-1', date: '2025-02-01' },
      { id: 'c', employee_id: 'EMP-2', date: '2026-03-03' },
      { id: 'd', employee_id: 'EMP-1', date: '' },
    ];
    t.equal(docsFor(rows, 'EMP-1', null).length, 3, 'everything on one person');
    t.equal(docsFor(rows, null, 2026).length, 2, 'everybody, one year');
    t.equal(docsFor(rows, 'EMP-1', 2026).length, 1, 'both filters');
    t.equal(docsFor(rows, null, null).length, 4, 'no filters is everything');
    t.assert(!docsFor(rows, 'EMP-1', 2026).some((r) => r.id === 'd'),
      'an entry with an unusable date is left out of a year rather than counted into it');
    t.equal(docsFor(null, 'EMP-1', 2026).length, 0, 'and nothing in is nothing out');
  });

  /* ---- 5. the screen actually draws ------------------------------------ *
   * The app module is imported and its render functions are CALLED against
   * a hand-built state, rather than read for the strings they contain. A
   * render function that throws on a field name typo passes every source
   * match ever written about it.
   * -------------------------------------------------------------------- */

  const screen = (await import(path.join(ROOT, 'apps/crewcore.js'))).default;

  function state(over) {
    return Object.assign(Object.create(screen), {
      _isAdmin: true,
      _employees: [{ id: 'EMP-1', name: 'Sasha Lee' }, { id: 'EMP-2', name: 'Dana Ray' }],
      _own: null,
      _reviews: [],
      _kudos: [],
      _docPerson: '',
      _docDetailId: null,
      _docs: [{
        id: 'DOC-00001', employee_id: 'EMP-1', date: '2026-08-18',
        summary: 'Third late start', category: 'Attendance', level: 'verbal warning',
        details: 'The long version', action_taken: 'Verbal warning',
        others_present: '', follow_up_date: '2026-09-18',
        created_by: 'ryan', created_at: '2026-08-18T12:00:00.000Z',
      }],
    }, over || {});
  }

  const clean = (html, where) => {
    t.assert(typeof html === 'string' && html.length, where + ' drew nothing');
    t.assert(!/undefined|NaN|\[object Object\]/.test(html),
      where + ' leaked a placeholder into the markup');
  };

  t.test('the documentation list draws, with the warning and the level chip', () => {
    const html = state()._renderDocs();
    clean(html, 'the documentation list');
    t.assert(/Administrators only/.test(html),
      'the screen must say out loud who can read this');
    t.assert(/chip formal/.test(html), 'a warning is marked as a formal step');
    t.assert(/Sasha Lee/.test(html), 'and the row names the person');
  });

  t.test('an entry opens', () => {
    const html = state({ _docDetailId: 'DOC-00001' })._renderDocs();
    clean(html, 'the documentation detail');
    t.assert(/The long version/.test(html), 'the write-up is on the page');
    t.assert(/ccDocDelete/.test(html), 'with the admin actions');
  });

  t.test('the screen refuses to draw an entry for a non-admin', () => {
    // The route is the real gate. This is the belt: even handed a state with
    // entries in it, the render must not put one on screen.
    const html = state({ _isAdmin: false })._renderDocs();
    t.assert(/Admin access required/.test(html), 'it says no');
    t.assert(!/Third late start/.test(html), 'and draws no entry text whatsoever');
  });

  t.test('an empty file and a filtered-to-nobody file both draw', () => {
    clean(state({ _docs: [] })._renderDocs(), 'the empty documentation list');
    clean(state({ _docPerson: 'EMP-2' })._renderDocs(), 'a filter matching nothing');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-docs could not run: ' + (e && e.stack || e));
  process.exit(1);
});
