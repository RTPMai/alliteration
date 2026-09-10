// PUT IN: test/user-grants.test.cjs
/**
 * Per-account grants (Sep 2026).
 *
 * The role is a starting point; an account may carry its own answers and they
 * win, key by key. Absent means inherit, never deny.
 *
 * The permission checks here are REAL calls to permsFor() against a fake
 * Upstash, not source matching. That matters more than usual for this change:
 * the whole risk is a grant resolving differently from how the code reads, and
 * reading DEFAULT_ROLES would never catch it.
 */

const t = require('./harness.cjs');

/* ---- fake Upstash ------------------------------------------------------ *
 * Reads only. permsFor() never writes.
 * ----------------------------------------------------------------------- */

const kv = new Map();

global.fetch = async (url) => {
  const key = decodeURIComponent((String(url).match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

(async () => {
  const grants = await import('../lib/user-grants.js');
  const users = await import('../lib/users.js');
  const { resolveGrants, normalizeGrants, asRole, overrideSummary, GRANT_FLAGS } = grants;
  const { permsFor, keysForTest } = users;
  const kvKeys = await import('../lib/kv.js');

  const USERS_KEY = kvKeys.keys.users();
  const ROLES_KEY = kvKeys.keys.roles();

  function seed({ user, roles }) {
    kv.clear();
    kv.set(USERS_KEY, JSON.stringify({ [user.username]: user }));
    if (roles) kv.set(ROLES_KEY, JSON.stringify(roles));
  }

  const baseRole = {
    name: 'am', label: 'Account Manager', apps: ['backbone', 'shopstock'],
    data_scope: 'own', can_edit: true, can_export: false,
  };

  // ---- resolveGrants: absent means inherit ------------------------------

  t.test('an account with no grants is exactly its role', () => {
    const r = resolveGrants(baseRole, null);
    t.equal(r.apps.join(','), 'backbone,shopstock');
    t.equal(r.data_scope, 'own');
    t.equal(r.can_edit, true);
    t.equal(r.can_export, false);
    t.equal(r.sources.apps, 'role');
    t.equal(r.sources.can_edit, 'role');
  });

  t.test('an empty grants object changes nothing', () => {
    const r = resolveGrants(baseRole, {});
    t.equal(r.apps.join(','), 'backbone,shopstock');
    t.equal(r.sources.apps, 'role');
  });

  t.test('false is an answer and overrides; undefined is not', () => {
    const r = resolveGrants(baseRole, { can_edit: false });
    t.equal(r.can_edit, false, 'the account said no');
    t.equal(r.sources.can_edit, 'account');
    t.equal(r.can_export, false, 'untouched flag still comes from the role');
    t.equal(r.sources.can_export, 'role');
  });

  t.test('an account app list replaces the role list, it does not merge', () => {
    const r = resolveGrants(baseRole, { apps: ['crewcore'] });
    t.equal(r.apps.join(','), 'crewcore');
    t.equal(r.sources.apps, 'account');
  });

  t.test('opt-in flags stay off and opt-out flags stay on when nobody says', () => {
    const r = resolveGrants({ name: 'bare' }, null);
    t.equal(r.manage_lists, false, 'opt-in: a role stored before the flag existed gains nothing');
    t.equal(r.can_decide_giving, false, 'opt-in');
    t.equal(r.can_edit, true, 'opt-out');
    t.equal(r.can_delete_notifications, true, 'opt-out');
  });

  t.test('an opt-in flag can be turned on for one person', () => {
    const r = resolveGrants(baseRole, { manage_lists: true });
    t.equal(r.manage_lists, true);
    t.equal(r.sources.manage_lists, 'account');
  });

  // ---- normalizeGrants ---------------------------------------------------

  t.test('unknown keys are dropped, not stored looking like settings', () => {
    const g = normalizeGrants({ can_edit: true, is_wizard: true, apps: ['backbone'] });
    t.equal(Object.keys(g).sort().join(','), 'apps,can_edit');
  });

  t.test('a non-boolean flag value is ignored rather than coerced', () => {
    t.equal(normalizeGrants({ can_edit: 'yes' }), null,
      'a truthy string is not a decision anybody made');
  });

  t.test('a bad data_scope is dropped', () => {
    t.equal(normalizeGrants({ data_scope: 'everything' }), null);
    t.equal(normalizeGrants({ data_scope: 'own' }).data_scope, 'own');
  });

  t.test('duplicate and blank apps are cleaned', () => {
    const g = normalizeGrants({ apps: ['backbone', 'backbone', '', '  crewcore  '] });
    t.equal(g.apps.join(','), 'backbone,crewcore');
  });

  t.test('nothing usable normalizes to null, so a reset stores no object', () => {
    t.equal(normalizeGrants({}), null);
    t.equal(normalizeGrants(null), null);
    t.equal(normalizeGrants([1, 2]), null, 'an array is not a grants object');
  });

  // ---- asRole and the summary -------------------------------------------

  t.test('asRole hands the resolved values to a role-shaped reader', () => {
    const r = resolveGrants(baseRole, { can_edit: false, apps: ['givinggauge'] });
    const shaped = asRole(r, baseRole);
    t.equal(shaped.can_edit, false, 'giving-access sees the account answer');
    t.equal(shaped.apps.join(','), 'givinggauge');
    t.equal(shaped.label, 'Account Manager', 'the rest of the role survives');
  });

  t.test('the summary names only what differs from the role', () => {
    t.equal(overrideSummary(resolveGrants(baseRole, null)).length, 0,
      'a role-default account has nothing to say');
    const diffs = overrideSummary(resolveGrants(baseRole, { can_edit: false, apps: ['backbone'] }));
    t.assert(diffs.includes('apps'), diffs.join(','));
    t.assert(diffs.some((d) => /no can edit/.test(d)), diffs.join(','));
  });

  t.test('every flag in GRANT_FLAGS resolves and reports a source', () => {
    const r = resolveGrants(baseRole, null);
    GRANT_FLAGS.forEach((f) => {
      t.assert(typeof r[f.key] === 'boolean', f.key + ' resolves to a boolean');
      t.assert(r.sources[f.key] === 'role' || r.sources[f.key] === 'account',
        f.key + ' reports where it came from');
    });
  });

  // ---- permsFor, the real thing ------------------------------------------

  await t.test('permsFor: an account with no grants is unchanged by this feature', async () => {
    seed({
      user: { username: 'hannah', name: 'Hannah', role: 'am' },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.assert(p.tabs.includes('backbone'), 'role apps still arrive');
    t.assert(p.tabs.includes('shopstock'));
    t.equal(p.data_scope, 'own');
    t.equal(p.can_edit, true);
  });

  await t.test('permsFor: an account grant beats the role', async () => {
    seed({
      user: { username: 'hannah', name: 'Hannah', role: 'am',
              grants: { apps: ['backbone', 'crewcore'], can_export: true } },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.assert(p.tabs.includes('crewcore'), 'the extra app arrives without a new role');
    t.assert(!p.tabs.includes('shopstock'), 'the account list replaced the role list');
    t.equal(p.can_export, true, 'the role said no and the account said yes');
  });

  await t.test('permsFor: manage_lists stays opt-in through the resolver', async () => {
    seed({ user: { username: 'hannah', role: 'am' }, roles: { am: baseRole } });
    t.equal((await permsFor('hannah')).manage_lists, false, 'default off');

    seed({
      user: { username: 'hannah', role: 'am', grants: { manage_lists: true } },
      roles: { am: baseRole },
    });
    t.equal((await permsFor('hannah')).manage_lists, true, 'on for this person only');
  });

  await t.test('permsFor: can_delete_notifications stays opt-out through the resolver', async () => {
    seed({ user: { username: 'hannah', role: 'am' }, roles: { am: baseRole } });
    t.equal((await permsFor('hannah')).can_delete_notifications, true, 'default on');

    seed({
      user: { username: 'hannah', role: 'am', grants: { can_delete_notifications: false } },
      roles: { am: baseRole },
    });
    t.equal((await permsFor('hannah')).can_delete_notifications, false, 'off for this person');
  });

  await t.test('permsFor: an account grant flows into the GivingGauge answers', async () => {
    seed({
      user: { username: 'hannah', role: 'am', grants: { can_decide_giving: true } },
      roles: { am: { ...baseRole, apps: ['backbone', 'givinggauge'] } },
    });
    t.equal((await permsFor('hannah')).can_decide_giving, true,
      'deciding follows the account, not only the role');
  });

  await t.test('permsFor reports where each answer came from', async () => {
    seed({
      user: { username: 'hannah', role: 'am', grants: { can_edit: false } },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.equal(p.grant_sources.can_edit, 'account');
    t.equal(p.grant_sources.can_export, 'role');
  });

  // ---- THE CEILING IS NOT NEGOTIABLE -------------------------------------
  //
  // This is the check that matters most. Per-account grants must not become a
  // second door into CrewCore's admin views. That is the CrewCore trap, and
  // it has already cost one security incident.

  await t.test('an account grant cannot hand somebody CrewCore Roster or Settings', async () => {
    seed({
      user: { username: 'hannah', role: 'am', grants: { apps: ['crewcore'] } },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.assert(!p.tabs.includes('crewcore:roster'), 'no roster');
    t.assert(!p.tabs.includes('crewcore:settings'), 'no CrewCore settings');
    t.assert(p.tabs.includes('crewcore:samples'), 'the self-serve views do arrive');
    t.assert(p.tabs.includes('crewcore:dashboard'));
  });

  await t.test('an account grant cannot make somebody a CrewCore admin', async () => {
    seed({
      user: { username: 'hannah', role: 'am', grants: { apps: ['crewcore'], can_edit: true } },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.equal(p.superuser, false, 'the Admin flag is the only way in, and no grant sets it');
  });

  await t.test('an account cannot smuggle a scoped view in through the apps list', async () => {
    seed({
      user: { username: 'hannah', role: 'am', grants: { apps: ['crewcore:roster'] } },
      roles: { am: baseRole },
    });
    const p = await permsFor('hannah');
    t.assert(!p.tabs.includes('crewcore:roster'),
      'a colon-suffixed entry in the apps list is still capped by the ceiling');
  });

  process.exit(t.report());
})();
