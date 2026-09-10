// PUT IN: test/user-grants.test.cjs (REPLACES the current one)
/**
 * Access per person, roles removed (Sep 2026).
 *
 * The permission checks are REAL calls to permsFor() and getAccess() against a
 * fake Upstash, not source matching. That matters most for the two things that
 * cannot be allowed to regress: the migration must not lock anybody out, and
 * the CrewCore ceiling must survive a model change that removed the thing it
 * used to be expressed against.
 */

const t = require('./harness.cjs');

const kv = new Map();
let lastWrite = null;

global.fetch = async (url, opts) => {
  const u = String(url);
  const setAt = u.match(/\/set\/(.+)$/);
  if (setAt) {
    const key = decodeURIComponent(setAt[1]);
    lastWrite = { key, body: opts && opts.body };
    kv.set(key, typeof (opts && opts.body) === 'string' ? opts.body : JSON.stringify(opts && opts.body));
    return { ok: true, status: 200, json: async () => ({ result: 'OK' }) };
  }
  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

(async () => {
  const g = await import('../lib/user-grants.js');
  const users = await import('../lib/users.js');
  const kvKeys = await import('../lib/kv.js');
  const {
    GRANT_FLAGS, emptyAccess, normalizeAccess, resolveAccess, tabsFor,
    asRole, accessFromRole, accessSummary,
  } = g;
  const { permsFor, getAccess, countAdmins, updateUser } = users;

  const USERS_KEY = kvKeys.keys.users();
  const ROLES_KEY = kvKeys.keys.roles();

  function seed(map, roles) {
    kv.clear();
    lastWrite = null;
    kv.set(USERS_KEY, JSON.stringify(map));
    if (roles) kv.set(ROLES_KEY, JSON.stringify(roles));
  }

  // ---- the record itself --------------------------------------------------

  t.test('a new account starts with nothing', () => {
    const a = emptyAccess();
    t.equal(a.apps.length, 0, 'no apps, not a helpful default nobody chose');
    t.equal(Object.keys(a.views).length, 0);
  });

  t.test('unknown keys are dropped, not stored looking like settings', () => {
    const a = normalizeAccess({ apps: ['backbone'], is_wizard: true, can_edit: false });
    t.equal(a.is_wizard, undefined);
    t.equal(a.can_edit, false, 'a real flag survives');
  });

  t.test('a non-boolean flag is ignored rather than coerced', () => {
    t.equal(normalizeAccess({ can_edit: 'yes' }).can_edit, undefined,
      'a truthy string is not a decision anybody made');
  });

  t.test('duplicate and blank apps are cleaned', () => {
    t.equal(normalizeAccess({ apps: ['backbone', 'backbone', '', ' crewcore '] }).apps.join(','),
      'backbone,crewcore');
  });

  t.test('a scoped entry cannot hide in the apps list', () => {
    const a = normalizeAccess({ apps: ['crewcore', 'crewcore:roster'] });
    t.equal(a.apps.join(','), 'crewcore', 'the colon-suffixed entry is stripped');
  });

  t.test('a narrowing on an app they cannot open is dropped', () => {
    const a = normalizeAccess({ apps: ['backbone'], views: { stitchsense: ['guess'] } });
    t.equal(Object.keys(a.views).length, 0,
      'dead weight that would come back to life if the app were re-ticked');
  });

  t.test('a narrowing survives on an app they can open', () => {
    const a = normalizeAccess({ apps: ['stitchsense'], views: { stitchsense: ['guess'] } });
    t.equal((a.views.stitchsense || []).join(','), 'guess');
  });

  t.test('opt-in flags stay off and opt-out flags stay on when nothing is stored', () => {
    const a = resolveAccess({});
    t.equal(a.manage_lists, false, 'opt-in');
    t.equal(a.can_decide_giving, false, 'opt-in');
    t.equal(a.can_edit, true, 'opt-out');
    t.equal(a.can_delete_notifications, true, 'opt-out');
  });

  t.test('false is an answer and survives resolution', () => {
    t.equal(resolveAccess({ can_edit: false }).can_edit, false);
  });

  t.test('every flag in GRANT_FLAGS resolves to a boolean', () => {
    const a = resolveAccess({});
    GRANT_FLAGS.forEach((f) => {
      t.assert(typeof a[f.key] === 'boolean', f.key + ' resolves');
    });
  });

  t.test('tabsFor emits app ids plus scoped entries for narrowed apps', () => {
    const tabs = tabsFor({ apps: ['backbone', 'stitchsense'], views: { stitchsense: ['guess'] } });
    t.assert(tabs.includes('backbone'), 'an unnarrowed app needs only its id');
    t.assert(tabs.includes('stitchsense'), tabs.join(','));
    t.assert(tabs.includes('stitchsense:guess'), tabs.join(','));
  });

  t.test('asRole hands role-shaped readers the resolved answer', () => {
    const r = asRole({ apps: ['givinggauge'], can_edit: false, can_decide_giving: true });
    t.equal(r.can_edit, false);
    t.equal(r.can_decide_giving, true);
    t.equal(r.apps.join(','), 'givinggauge');
  });

  t.test('the summary names apps and flags a narrowed one', () => {
    const bits = accessSummary({ apps: ['stitchsense'], views: { stitchsense: ['guess'] } },
      (id) => id.toUpperCase());
    t.equal(bits.length, 1);
    t.assert(/STITCHSENSE/.test(bits[0]), bits[0]);
    t.assert(/1 views/.test(bits[0]), 'says it is narrowed: ' + bits[0]);
  });

  // ---- converting an old role --------------------------------------------

  t.test('a role becomes an access record, scoped views and all', () => {
    const a = accessFromRole({
      apps: ['crewcore', 'stitchsense'],
      tabs: ['crewcore:dashboard', 'stitchsense:guess'],
      data_scope: 'own', can_edit: false,
    });
    t.equal(a.apps.join(','), 'crewcore,stitchsense');
    t.equal((a.views.stitchsense || []).join(','), 'guess',
      'Stitch Guess only survives instead of quietly widening to the whole app');
    t.equal(a.data_scope, 'own');
    t.equal(a.can_edit, false);
  });

  t.test('a per-account override still beats the role it is converted with', () => {
    const a = accessFromRole(
      { apps: ['backbone'], can_export: false },
      { apps: ['backbone', 'crewcore'], can_export: true });
    t.equal(a.apps.join(','), 'backbone,crewcore');
    t.equal(a.can_export, true);
  });

  // ---- THE MIGRATION ------------------------------------------------------

  await t.test('the migration bakes each account access on first read', async () => {
    seed({
      hannah: { username: 'hannah', name: 'Hannah', role: 'am' },
    }, {
      am: { name: 'am', apps: ['backbone', 'shopstock'], data_scope: 'own', can_edit: true },
    });
    const p = await permsFor('hannah');
    t.assert(p.tabs.includes('backbone'), 'access survives the move');
    t.assert(p.tabs.includes('shopstock'));
    t.equal(p.data_scope, 'own', 'and so does the scope');
  });

  await t.test('THE LOCKOUT GUARD: an admin role becomes the Admin flag', async () => {
    seed({
      ryan: { username: 'ryan', role: 'admin' },
      hannah: { username: 'hannah', role: 'am' },
    }, {
      admin: { name: 'admin', apps: ['backbone'], data_scope: 'all' },
      am: { name: 'am', apps: ['backbone'], data_scope: 'own' },
    });
    const p = await permsFor('ryan');
    t.equal(p.superuser, true, 'without this, deploy day locks everybody out of Settings');
    t.equal((await permsFor('hannah')).superuser, false, 'and it does not spread');
  });

  await t.test('the migration keeps a scoped view narrowing', async () => {
    seed({
      amanda: { username: 'amanda', role: 'employee' },
    }, {
      employee: {
        name: 'employee', apps: ['crewcore', 'stitchsense'],
        tabs: ['crewcore:dashboard', 'stitchsense:guess'], data_scope: 'own', can_edit: false,
      },
    });
    const p = await permsFor('amanda');
    t.assert(p.tabs.includes('stitchsense:guess'), p.tabs.join(','));
    t.assert(!p.tabs.includes('stitchsense:library'), 'the rest of the app did not open up');
  });

  await t.test('the migration is idempotent', async () => {
    seed({ hannah: { username: 'hannah', role: 'am' } },
         { am: { name: 'am', apps: ['backbone'] } });
    await permsFor('hannah');
    const afterFirst = kv.get(USERS_KEY);
    lastWrite = null;
    await permsFor('hannah');
    t.equal(lastWrite, null, 'a second read writes nothing');
    t.equal(kv.get(USERS_KEY), afterFirst, 'and changes nothing');
  });

  // ---- permsFor -----------------------------------------------------------

  await t.test('access set on an account is what permsFor returns', async () => {
    seed({
      hannah: {
        username: 'hannah',
        access: { apps: ['backbone', 'promopro'], data_scope: 'own', can_export: true },
      },
    });
    const p = await permsFor('hannah');
    t.assert(p.tabs.includes('promopro'), 'no role was involved anywhere');
    t.equal(p.can_export, true);
    t.equal(p.data_scope, 'own');
  });

  await t.test('getAccess and permsFor cannot disagree', async () => {
    seed({ hannah: { username: 'hannah', access: { apps: ['backbone'], can_edit: false } } });
    const a = await getAccess('hannah');
    const p = await permsFor('hannah');
    t.equal(a.can_edit, p.can_edit);
    t.equal(a.data_scope, p.data_scope);
    t.equal(a.apps.join(','), 'backbone');
  });

  await t.test('an account with no apps signs in to an empty rail, not an error', async () => {
    seed({ newbie: { username: 'newbie', access: { apps: [] } } });
    const p = await permsFor('newbie');
    t.equal(p.tabs.length, 0);
    t.equal(p.superuser, false);
  });

  await t.test('perms.role is derived from the flag, not stored', async () => {
    seed({
      ryan: { username: 'ryan', superuser: true, access: { apps: ['backbone'] } },
      hannah: { username: 'hannah', access: { apps: ['backbone'] } },
    });
    t.equal((await permsFor('ryan')).role, 'admin',
      'so the routes reading perms.role === "admin" still mean the right thing');
    t.equal((await permsFor('hannah')).role, 'account');
  });

  // ---- THE CEILING SURVIVES THE MODEL CHANGE -----------------------------

  await t.test('an account grant cannot hand somebody CrewCore Roster or Settings', async () => {
    seed({ hannah: { username: 'hannah', access: { apps: ['crewcore'] } } });
    const p = await permsFor('hannah');
    t.assert(!p.tabs.includes('crewcore:roster'), 'no roster');
    t.assert(!p.tabs.includes('crewcore:settings'), 'no CrewCore settings');
    t.assert(p.tabs.includes('crewcore:dashboard'), 'the self-serve views do arrive');
    t.assert(p.tabs.includes('crewcore:samples'));
  });

  await t.test('narrowing CrewCore by hand cannot widen past the ceiling', async () => {
    seed({
      hannah: {
        username: 'hannah',
        access: { apps: ['crewcore'], views: { crewcore: ['roster', 'settings', 'dashboard'] } },
      },
    });
    const p = await permsFor('hannah');
    t.assert(!p.tabs.includes('crewcore:roster'), 'the ceiling is applied after the account');
    t.assert(!p.tabs.includes('crewcore:settings'));
    t.assert(p.tabs.includes('crewcore:dashboard'), 'what was in the self-serve set survives');
  });

  await t.test('an Admin does get the full CrewCore rail', async () => {
    seed({ ryan: { username: 'ryan', superuser: true, access: { apps: ['crewcore'] } } });
    const p = await permsFor('ryan');
    t.assert(!p.tabs.some((x) => x.startsWith('crewcore:')),
      'unnarrowed means every view, so no scoped entries and no ceiling: ' + p.tabs.join(','));
    t.assert(p.tabs.includes('crewcore'));
  });

  // ---- the last administrator --------------------------------------------

  await t.test('countAdmins counts the flag', async () => {
    seed({
      ryan: { username: 'ryan', superuser: true, access: {} },
      hannah: { username: 'hannah', access: {} },
    });
    t.equal(await countAdmins(), 1);
  });

  await t.test('the last Admin flag cannot be removed', async () => {
    seed({
      ryan: { username: 'ryan', superuser: true, access: {} },
      hannah: { username: 'hannah', access: {} },
    });
    let threw = null;
    try { await updateUser('ryan', { superuser: false }); } catch (e) { threw = e; }
    t.assert(threw, 'refused');
    t.assert(/last administrator/i.test(threw.message), threw.message);
  });

  await t.test('one of two Admins can be removed', async () => {
    seed({
      ryan: { username: 'ryan', superuser: true, access: {} },
      megan: { username: 'megan', superuser: true, access: {} },
    });
    await updateUser('megan', { superuser: false });
    t.equal(await countAdmins(), 1, 'the guard is about the last one, not about all of them');
  });

  // ---- nothing reads a role any more --------------------------------------

  t.test('no route resolves access from a role', () => {
    const fs = require('fs');
    const path = require('path');
    const ROOT = path.join(__dirname, '..');
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : (e.name.endsWith('.js') ? [full] : []);
    });
    const offenders = walk(path.join(ROOT, 'api'))
      .filter((f) => /getRole\(|getRoles\(/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    t.equal(offenders.length, 0,
      'these still ask a role instead of the person: ' + offenders.join(', '));
  });

  t.test('the Settings screen has no roles editor left', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps/settings.js'), 'utf8');
    t.assert(!/scope=roles/.test(src), 'no calls to the deleted roles endpoint');
    t.assert(!/data-role-user/.test(src), 'no role dropdown on an account row');
    t.assert(/data-access=/.test(src), 'the access editor is what is left');
  });

  t.test('Set access is handled in the click listener, not the change one', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'apps/settings.js'), 'utf8');
    const clickAt = src.indexOf("root.addEventListener('click'");
    const changeAt = src.indexOf("root.addEventListener('change'", clickAt);
    const accessAt = src.indexOf("closest('[data-access]')");
    t.assert(clickAt !== -1 && changeAt > clickAt, 'both listeners exist in order');
    t.assert(accessAt > clickAt && accessAt < changeAt,
      'a button fires click, not change. This shipped wrong once.');
  });

  process.exit(t.report());
})();
