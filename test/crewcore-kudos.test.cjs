/**
 * CrewCore kudos (Sep 2026).
 *
 * Ryan's ask: a way to give kudos to employees, and for employees to give
 * each other kudos. The second half is the interesting one, because it makes
 * this the only screen in CrewCore a self-serve account can write to, in the
 * app that holds pay rates and review notes. So the route is CALLED here,
 * with real signed sessions over a fake Upstash, rather than read for the
 * shape of its checks.
 *
 * Four rules get their own tests because each one is a decision somebody
 * could reasonably have made the other way:
 *
 *   1. Everybody reads the same feed. Praise only two people can see is a
 *      private message, not kudos.
 *   2. Nobody gives themselves kudos. Refused on the server, not merely
 *      left out of the picker.
 *   3. The recipient cannot delete one. Being thanked in front of the shop
 *      is not something the person thanked gets to quietly erase.
 *   4. Handing an employee a name list is deliberate and narrow: ids and
 *      names, nothing else off an employee record, because they cannot open
 *      the roster and would otherwise have nobody to pick.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

/* ---- fake Upstash (reads and writes) ---------------------------------- */

const kv = new Map();
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
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';
process.env.SESSION_SECRET = 'test-secret-for-crewcore-kudos';

function seed() {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    // An admin with NO employee record of their own, which is the real shape
    // for an owner account.
    ryan:  { username: 'ryan',  name: 'Ryan Toney', role: 'admin' },
    sasha: { username: 'sasha', name: 'Sasha',      role: 'employee' },
    dana:  { username: 'dana',  name: 'Dana',       role: 'employee' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(['EMP-1', 'EMP-2', 'EMP-3']));
  kv.set(CC + ':employee:EMP-1', JSON.stringify({
    id: 'EMP-1', name: 'Sasha', username: 'sasha', status: 'active',
    hourly_rate: 24, apparel_stipend: 150, notes: 'admin only note',
  }));
  kv.set(CC + ':employee:EMP-2', JSON.stringify({
    id: 'EMP-2', name: 'Dana', username: 'dana', status: 'active', hourly_rate: 26,
  }));
  kv.set(CC + ':employee:EMP-3', JSON.stringify({
    id: 'EMP-3', name: 'Gone Fishing', username: null, status: 'terminated',
  }));
}

async function makeCookie(session) {
  const s = await import(path.join(ROOT, 'lib/session.js'));
  let header = null;
  s.setSessionCookie({ setHeader: (k, v) => { if (k === 'Set-Cookie') header = v; } }, session);
  return String(header).split('; ')[0];
}

function fakeRes() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}

async function call(handler, { as, method = 'GET', query = {}, body = null }) {
  const cookie = await makeCookie(as);
  const res = fakeRes();
  await handler({ method, query, body, headers: { cookie } }, res);
  return res;
}

const ADMIN = { username: 'ryan', name: 'Ryan Toney', role: 'admin' };
const SASHA = { username: 'sasha', name: 'Sasha', role: 'employee' };
const DANA = { username: 'dana', name: 'Dana', role: 'employee' };

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const schema = await import(path.join(ROOT, 'lib/crewcore/schema.js'));
  const store = await import(path.join(ROOT, 'lib/crewcore/store.js'));
  const route = (await import(path.join(ROOT, 'api/crewcore/kudos.js'))).default;
  const users = await import(path.join(ROOT, 'lib/users.js'));
  const reg = await import(path.join(ROOT, 'js/registry.js'));

  const {
    validateKudos, kudosFor, kudosYear, canDeleteKudos, KUDOS_TAGS, KUDOS_MAX_LENGTH,
  } = schema;

  /* ---- 1. an employee can give another employee kudos ------------------ */

  await check('an employee posts kudos about a colleague', async () => {
    seed();
    const res = await call(route, {
      as: SASHA, method: 'POST',
      body: { to_employee_id: 'EMP-2', tag: 'Teamwork', message: '  Stayed late to finish the Ankeny run.  ' },
    });
    t.equal(res.statusCode, 201, 'a self-serve employee may write one');
    t.equal(res.body.kudos.to_employee_id, 'EMP-2', 'addressed to the colleague');
    t.equal(res.body.kudos.from_username, 'sasha', 'the author comes off the session, not the body');
    t.equal(res.body.kudos.from_employee_id, 'EMP-1', 'and is linked to their own record');
    t.equal(res.body.kudos.message, 'Stayed late to finish the Ankeny run.', 'trimmed');
    t.assert(/^KUD-\d{5}$/.test(res.body.kudos.id), 'its own id series, got ' + res.body.kudos.id);
  });

  await check('everybody reads the same feed, which is the point', async () => {
    // Written by Sasha ABOUT Dana. Both of them, and the admin, must see it.
    for (const who of [SASHA, DANA, ADMIN]) {
      const res = await call(route, { as: who });
      t.equal(res.statusCode, 200, who.username + ' can read the feed');
      t.equal(res.body.kudos.length, 1, who.username + ' sees the kudos');
    }
  });

  await check('an admin with no employee record can still give kudos', async () => {
    const res = await call(route, {
      as: ADMIN, method: 'POST',
      body: { to_employee_id: 'EMP-1', message: 'Drove the samples out to Grimes herself.' },
    });
    t.equal(res.statusCode, 201, 'an unlinked admin account is not blocked');
    t.equal(res.body.kudos.from_employee_id, null, 'there is no record to link to');
    t.equal(res.body.kudos.from_username, 'ryan', 'but the author is recorded, so they can remove it');
    t.equal(res.body.kudos.from_name, 'Ryan Toney', 'and named from their account');
  });

  await check('an unauthenticated request gets 401', async () => {
    const res = fakeRes();
    await route({ method: 'GET', query: {}, headers: {} }, res);
    t.equal(res.statusCode, 401, 'the feed is internal, not public');
  });

  /* ---- 2. no self-kudos ------------------------------------------------ */

  await check('nobody can give themselves kudos', async () => {
    seed();
    const res = await call(route, {
      as: SASHA, method: 'POST',
      body: { to_employee_id: 'EMP-1', message: 'I was great today.' },
    });
    t.equal(res.statusCode, 400, 'refused by the server, not just absent from the picker');
    t.equal((await store.listKudos()).length, 0, 'and nothing was stored');
  });

  await check('your own name is not in the list you pick from', async () => {
    const res = await call(route, { as: SASHA });
    const ids = res.body.people.map((pp) => pp.id);
    t.assert(!ids.includes('EMP-1'), 'Sasha must not be offered Sasha');
    t.assert(ids.includes('EMP-2'), 'but her colleague is there');
  });

  await check('somebody who has left is not in the list, and cannot be given kudos', async () => {
    const res = await call(route, { as: SASHA });
    t.assert(!res.body.people.map((pp) => pp.id).includes('EMP-3'),
      'a terminated employee is not offered');
    const post = await call(route, {
      as: SASHA, method: 'POST',
      body: { to_employee_id: 'EMP-3', message: 'Thanks for everything.' },
    });
    t.equal(post.statusCode, 400, 'and is refused if asked for directly');
  });

  await check('kudos to somebody who is not on the roster is refused', async () => {
    const res = await call(route, {
      as: SASHA, method: 'POST',
      body: { to_employee_id: 'EMP-99', message: 'Nice work.' },
    });
    t.equal(res.statusCode, 400, 'an id nobody holds is not a recipient');
  });

  /* ---- 3. the name list is names, and nothing else --------------------- */

  await check('the picker hands back ids and names only, never pay or notes', async () => {
    seed();
    const res = await call(route, { as: SASHA });
    t.assert(res.body.people.length > 0, 'there is a list to check');
    res.body.people.forEach((pp) => {
      t.equal(Object.keys(pp).sort().join(','), 'id,name',
        'a person in the picker carries exactly id and name, got: ' + Object.keys(pp).join(','));
    });
    const asText = JSON.stringify(res.body);
    t.assert(!asText.includes('hourly_rate') && !asText.includes('admin only note'),
      'nothing else off an employee record may ride along');
    t.assert(!/\b24\b/.test(JSON.stringify(res.body.people)), 'no rate figures in the picker');
  });

  await check('a name lookup still resolves somebody who has since left', async () => {
    // Left out of the PICKER, kept in the lookup, so an old kudos reads as a
    // name rather than an id.
    const res = await call(route, { as: SASHA });
    t.equal(res.body.names['EMP-3'], 'Gone Fishing', 'the feed can still name them');
  });

  await check('the caller is told who they are, so the screen knows what to offer', async () => {
    const mine = await call(route, { as: SASHA });
    t.equal(mine.body.me.employee_id, 'EMP-1', 'their own record, for the "for me" tab');
    t.equal(mine.body.me.is_admin, false, 'and that they are not an admin');
    const boss = await call(route, { as: ADMIN });
    t.equal(boss.body.me.employee_id, null, 'an unlinked admin has no record');
    t.equal(boss.body.me.is_admin, true, 'but is an admin');
  });

  /* ---- 4. who can remove one ------------------------------------------- */

  await check('the author can remove their own kudos', async () => {
    seed();
    const made = await call(route, {
      as: SASHA, method: 'POST', body: { to_employee_id: 'EMP-2', message: 'Wrong person, sorry.' },
    });
    const res = await call(route, { as: SASHA, method: 'DELETE', query: { id: made.body.kudos.id } });
    t.equal(res.statusCode, 200, 'whoever wrote it can take it back');
    t.equal((await store.listKudosIds()).length, 0, 'and it leaves the index, not just the key');
  });

  await check('the recipient cannot remove one written about them', async () => {
    seed();
    const made = await call(route, {
      as: SASHA, method: 'POST', body: { to_employee_id: 'EMP-2', message: 'Saved the Grimes order.' },
    });
    const res = await call(route, { as: DANA, method: 'DELETE', query: { id: made.body.kudos.id } });
    t.equal(res.statusCode, 403, 'being thanked is not the same as owning the record of it');
    t.equal((await store.listKudos()).length, 1, 'and it is still there');
  });

  await check('an admin can remove anybody\'s', async () => {
    const all = await store.listKudos();
    const res = await call(route, { as: ADMIN, method: 'DELETE', query: { id: all[0].id } });
    t.equal(res.statusCode, 200, 'an unwanted one is a conversation with an admin');
    t.equal((await store.listKudos()).length, 0, 'gone');
  });

  await check('there is no editing a kudos', async () => {
    seed();
    const made = await call(route, {
      as: SASHA, method: 'POST', body: { to_employee_id: 'EMP-2', message: 'Original wording.' },
    });
    const res = await call(route, {
      as: SASHA, method: 'PATCH', query: { id: made.body.kudos.id }, body: { message: 'Rewritten.' },
    });
    t.equal(res.statusCode, 405, 'delete and write it again instead');
    t.equal(res.headers.Allow, 'GET, POST, DELETE', 'and the route says what it does allow');
    const stored = await store.getKudos(made.body.kudos.id);
    t.equal(stored.message, 'Original wording.', 'nothing was changed');
  });

  await check('removing one that does not exist is a 404', async () => {
    const res = await call(route, { as: ADMIN, method: 'DELETE', query: { id: 'KUD-99999' } });
    t.equal(res.statusCode, 404, 'not a silent success');
  });

  /* ---- the delete rule on its own -------------------------------------- */

  t.test('canDeleteKudos: the author or an admin, nobody else', () => {
    const k = { id: 'KUD-1', from_username: 'sasha', to_employee_id: 'EMP-2' };
    t.equal(canDeleteKudos(k, { username: 'sasha', isAdmin: false }), true, 'the author');
    t.equal(canDeleteKudos(k, { username: 'dana', isAdmin: true }), true, 'an admin');
    t.equal(canDeleteKudos(k, { username: 'dana', isAdmin: false }), false, 'the recipient must not');
    t.equal(canDeleteKudos(k, { username: 'someone', isAdmin: false }), false, 'nor a bystander');
  });

  t.test('canDeleteKudos matches the author case and space insensitively', () => {
    const k = { from_username: 'Sasha ' };
    t.equal(canDeleteKudos(k, { username: 'sasha', isAdmin: false }), true,
      'a username stored before slugging must not lose its author');
  });

  t.test('canDeleteKudos: only a literal true is an admin', () => {
    const k = { from_username: 'sasha' };
    [1, 'true', 'yes', {}, [], 'false'].forEach((v) => {
      t.equal(canDeleteKudos(k, { username: 'dana', isAdmin: v }), false,
        'truthy value ' + JSON.stringify(v) + ' must not stand in for admin');
    });
  });

  t.test('a kudos with no author is not deletable by a caller with no username', () => {
    // Two blanks must not compare equal, or a broken record becomes
    // everybody's to delete.
    t.equal(canDeleteKudos({ from_username: '' }, { username: '', isAdmin: false }), false,
      'empty must not match empty');
    t.equal(canDeleteKudos({}, { username: undefined, isAdmin: false }), false, 'nor undefined');
    t.equal(canDeleteKudos(null, { username: 'sasha', isAdmin: true }), false, 'and nothing is not deletable');
  });

  /* ---- the record shape ------------------------------------------------ */

  t.test('a kudos needs somebody to be about and something to say', () => {
    const r = validateKudos({});
    t.assert(!r.ok, 'an empty one must not validate');
    t.assert(r.errors.some((e) => e.includes('to_employee_id')), 'a recipient is required');
    t.assert(r.errors.some((e) => e.includes('message')), 'so is a message');
  });

  t.test('a message of nothing but spaces is not a message', () => {
    t.assert(!validateKudos({ to_employee_id: 'EMP-1', message: '   \n  ' }).ok,
      'whitespace must not pass');
  });

  t.test('a message longer than the cap is refused rather than cut off', () => {
    const long = 'x'.repeat(KUDOS_MAX_LENGTH + 1);
    const r = validateKudos({ to_employee_id: 'EMP-1', message: long });
    t.assert(!r.ok, 'over the cap must be refused');
    const atCap = validateKudos({ to_employee_id: 'EMP-1', message: 'x'.repeat(KUDOS_MAX_LENGTH) });
    t.assert(atCap.ok, 'exactly at the cap is fine, the boundary is inclusive');
  });

  t.test('the label is optional and an invented one is refused', () => {
    const none = validateKudos({ to_employee_id: 'EMP-1', message: 'Nice work.' });
    t.assert(none.ok, 'no label should validate');
    t.equal(none.record.tag, '', 'and record an empty label rather than undefined');
    t.assert(validateKudos({ to_employee_id: 'EMP-1', message: 'x', tag: KUDOS_TAGS[0] }).ok,
      'a label off the list is fine');
    t.assert(!validateKudos({ to_employee_id: 'EMP-1', message: 'x', tag: 'Vibes' }).ok,
      'one off it is not');
  });

  t.test('kudosFor filters by recipient, author and year, in any combination', () => {
    const rows = [
      { id: 'a', to_employee_id: 'EMP-1', from_employee_id: 'EMP-2', created_at: '2026-08-01T00:00:00.000Z' },
      { id: 'b', to_employee_id: 'EMP-1', from_employee_id: 'EMP-3', created_at: '2025-08-01T00:00:00.000Z' },
      { id: 'c', to_employee_id: 'EMP-2', from_employee_id: 'EMP-1', created_at: '2026-02-01T00:00:00.000Z' },
      { id: 'd', to_employee_id: 'EMP-1', from_employee_id: 'EMP-2', created_at: '' },
    ];
    t.equal(kudosFor(rows, { to: 'EMP-1' }).length, 3, 'everything one person received');
    t.equal(kudosFor(rows, { from: 'EMP-2' }).length, 2, 'everything one person gave');
    t.equal(kudosFor(rows, { year: 2026 }).length, 2, 'one year');
    t.equal(kudosFor(rows, { to: 'EMP-1', year: 2026 }).length, 1, 'both');
    t.equal(kudosFor(rows, {}).length, 4, 'no filters is the whole feed');
    t.equal(kudosFor(rows).length, 4, 'and so is no argument at all');
    t.assert(!kudosFor(rows, { year: 2026 }).some((r) => r.id === 'd'),
      'an unusable stamp is left out of a year rather than counted into this one');
    t.equal(kudosFor(null, { to: 'EMP-1' }).length, 0, 'nothing in, nothing out');
  });

  t.test('kudosYear reads the stamp, or admits it cannot', () => {
    t.equal(kudosYear({ created_at: '2026-08-30T14:02:00.000Z' }), 2026);
    t.equal(kudosYear({ created_at: '' }), null, 'a blank stamp is not this year');
    t.equal(kudosYear({}), null, 'nor is a missing one');
    t.equal(kudosYear(null), null, 'nor nothing');
  });

  /* ---- the rail and the grants ----------------------------------------- */

  await check('the self-serve role is granted Kudos', async () => {
    t.assert(users.DEFAULT_ROLES.employee.tabs.includes('crewcore:kudos'),
      'the employee role needs the view or the feature is admin-only by accident');
    seed();
    const perms = await users.permsFor('sasha');
    t.assert(perms.tabs.includes('crewcore:kudos'),
      'and it has to survive into the permissions the shell actually reads');
  });

  await check('a role with CrewCore ticked and no tabs list gets Kudos too', async () => {
    // The self-serve CEILING, not a grant. A custom role made in Settings
    // carries no tabs list, and the ceiling is what it falls back to.
    seed();
    kv.set(P + 'roles', JSON.stringify({
      office: { name: 'office', label: 'Office', apps: ['crewcore'], data_scope: 'all', can_edit: true },
    }));
    kv.set(P + 'users', JSON.stringify({
      amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
    }));
    const perms = await users.permsFor('amanda');
    t.assert(perms.tabs.includes('crewcore:kudos'), 'kudos is inside the ceiling');
    t.assert(!perms.tabs.includes('crewcore:roster'), 'and the ceiling still holds everywhere else');
    t.assert(!perms.tabs.includes('crewcore:settings'), 'including CrewCore settings');
  });

  t.test('Kudos is a registered view and reaches a non-admin rail', () => {
    const cc = reg.APPS.find((a) => a.id === 'crewcore');
    t.assert(cc.views.some(([k, label]) => k === 'kudos' && label === 'Kudos'),
      'the registry needs the view for the rail to draw it');
    const wide = { role: 'office', superuser: false, tabs: ['crewcore'] };
    t.assert(reg.allowedViews(wide, 'crewcore').includes('kudos'),
      'a non-admin must be able to reach it');
    const admin = { role: 'admin', superuser: false, tabs: ['crewcore'] };
    t.assert(reg.allowedViews(admin, 'crewcore').includes('kudos'), 'and so must an admin');
  });

  const api = await import(path.join(ROOT, 'js/api.js'));

  t.test('the seam knows both endpoints', () => {
    t.equal(api.ENDPOINTS.ccKudos, '/api/crewcore/kudos', 'apps call this through ctx.api');
    t.equal(api.ENDPOINTS.ccDocs, '/api/crewcore/docs', 'and the documentation one');
  });

  /* ---- the feed actually draws ------------------------------------------ */

  const screen = (await import(path.join(ROOT, 'apps/crewcore.js'))).default;

  function state(over) {
    return Object.assign(Object.create(screen), {
      _isAdmin: false,
      _employees: [],
      _own: { id: 'EMP-1', name: 'Sasha' },
      _kudosNames: { 'EMP-1': 'Sasha Lee', 'EMP-2': 'Dana Ray' },
      _kudosPeople: [{ id: 'EMP-2', name: 'Dana Ray' }],
      _kudosMe: { username: 'sasha', employee_id: 'EMP-1', is_admin: false },
      _kudosFilter: 'all',
      _kudos: [{
        id: 'KUD-00001', to_employee_id: 'EMP-2', to_name: 'Dana Ray',
        from_username: 'sasha', from_name: 'Sasha Lee', from_employee_id: 'EMP-1',
        tag: 'Teamwork', message: 'Stayed late to finish the Ankeny run.',
        created_at: '2026-08-30T14:02:00.000Z',
      }],
    }, over || {});
  }

  const clean = (html, where) => {
    t.assert(typeof html === 'string' && html.length, where + ' drew nothing');
    t.assert(!/undefined|NaN|\[object Object\]/.test(html),
      where + ' leaked a placeholder into the markup');
  };

  t.test('the feed draws, with the label and the author', () => {
    const html = state()._renderKudos();
    clean(html, 'the kudos feed');
    t.assert(/Dana Ray/.test(html), 'addressed to the recipient by their current name');
    t.assert(/Teamwork/.test(html), 'the label shows');
    t.assert(/from Sasha Lee/.test(html), 'and who wrote it');
  });

  t.test('the author is offered a remove button; a bystander is not', () => {
    t.assert(/data-kdel/.test(state()._renderKudos()),
      'whoever wrote it can take it back');
    const stranger = state({ _kudosMe: { username: 'kim', employee_id: 'EMP-4', is_admin: false } });
    t.assert(!/data-kdel/.test(stranger._renderKudos()),
      'somebody else must not be offered a delete on it');
  });

  t.test('every tab draws, including the empty ones', () => {
    ['all', 'mine', 'given'].forEach((f) => {
      clean(state({ _kudosFilter: f })._renderKudos(), 'the "' + f + '" tab');
      clean(state({ _kudosFilter: f, _kudos: [] })._renderKudos(), 'the empty "' + f + '" tab');
    });
  });

  t.test('an account with no employee record gets no "For me" tab', () => {
    // It could only ever be empty: there is no record for a kudos to be
    // addressed to.
    const html = state({ _kudosMe: { username: 'ryan', employee_id: null, is_admin: true } })._renderKudos();
    clean(html, 'the feed for an unlinked admin');
    t.assert(!/data-kfilter="mine"/.test(html), 'the tab must not be drawn');
    t.assert(/data-kfilter="all"/.test(html), 'but the feed still is');
  });

  t.test('a recipient who has left the roster still reads as a name', () => {
    const html = state({
      _kudosNames: {},
      _kudos: [{ id: 'K', to_employee_id: 'EMP-3', to_name: 'Gone Fishing', message: 'Thanks.', from_name: 'Ryan' }],
    })._renderKudos();
    t.assert(/Gone Fishing/.test(html), 'the stored name is the fallback, not the id');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL crewcore-kudos could not run: ' + (e && e.stack || e));
  process.exit(1);
});
