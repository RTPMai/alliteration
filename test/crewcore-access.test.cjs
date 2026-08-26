/**
 * CrewCore admin access.
 *
 * CrewCore holds pay rates, stipend balances, timecards and one-on-one review
 * notes. Who counts as an administrator inside it is the single most
 * consequential boolean in the shell, so it gets its own file.
 *
 * WHY THIS EXISTS: the rule used to be `data_scope === "all" || superuser`,
 * copied by hand into six API routes and the screen. `data_scope` answers a
 * BackBone question ("the whole customer book, or only your own accounts")
 * and has nothing to do with HR. A role created in Settings defaults to
 * `data_scope: "all"`, so every custom role was one CrewCore checkbox away
 * from full read and write on everybody's pay. An account manager reached the
 * whole app that way on Aug 26 2026.
 *
 * The rule is now one function, isCrewCoreAdmin(), and these tests run it
 * against every role that actually ships in lib/users.js rather than against
 * invented shapes, so adding a role to DEFAULT_ROLES cannot quietly hand out
 * HR access without turning this file red.
 *
 * Real function calls through dynamic import, not source-text matching.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');

Promise.all([
  import(path.join(ROOT, 'lib/crewcore/schema.js')),
  import(path.join(ROOT, 'lib/users.js')),
]).then(([schema, users]) => {
  const { isCrewCoreAdmin } = schema;
  const { DEFAULT_ROLES } = users;

  /* ---- the rule itself ------------------------------------------------ */

  t.test('the per-account superuser flag grants admin', () => {
    t.equal(isCrewCoreAdmin({ superuser: true, roleName: 'am' }), true,
      'superuser wins regardless of role');
  });

  t.test('the protected admin role grants admin', () => {
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'admin' }), true,
      'the admin role is the other way in');
  });

  t.test('nothing else grants admin', () => {
    ['am', 'manager', 'viewer', 'employee', 'sales', '', null, undefined].forEach((r) => {
      t.equal(isCrewCoreAdmin({ superuser: false, roleName: r }), false,
        'role ' + JSON.stringify(r) + ' must not be a CrewCore admin');
    });
  });

  t.test('data_scope is ignored entirely, which is the whole point', () => {
    // This is the exact shape that let an account manager into the app. If
    // this test ever goes green on `true`, the old bug is back.
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'am', data_scope: 'all' }), false,
      'data_scope "all" must not grant HR access');
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'custom_role', data_scope: 'all' }), false,
      'a custom role defaulting to data_scope "all" must not grant HR access');
  });

  t.test('a read-only role cannot become a CrewCore admin', () => {
    // `viewer` is data_scope "all" with can_edit false, and CrewCore checks
    // can_edit nowhere. Under the old rule a read-only account could have
    // edited pay.
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'viewer', data_scope: 'all', can_edit: false }), false,
      'viewer must not be a CrewCore admin');
  });

  t.test('only a literal true grants superuser, not any truthy value', () => {
    // getUser() returning a record whose superuser field is a stray string
    // must not be a way in.
    [1, 'true', 'yes', {}, [], 'false'].forEach((v) => {
      t.equal(isCrewCoreAdmin({ superuser: v, roleName: 'am' }), false,
        'truthy value ' + JSON.stringify(v) + ' must not grant superuser');
    });
    t.equal(isCrewCoreAdmin({ superuser: true, roleName: 'am' }), true, 'literal true does');
  });

  t.test('a role merely named like admin does not slip through', () => {
    ['administrator', 'admin2', 'superadmin', 'admin_readonly', 'notadmin'].forEach((r) => {
      t.equal(isCrewCoreAdmin({ superuser: false, roleName: r }), false,
        JSON.stringify(r) + ' is not the admin role');
    });
  });

  t.test('the admin role name is matched case and whitespace insensitively', () => {
    // Role keys are slugged on creation, but a stored record from before that
    // slugging should not silently lose access.
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'Admin' }), true, 'capitalised');
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: ' admin ' }), true, 'padded');
  });

  t.test('a missing or malformed caller is refused, not crashed on', () => {
    t.equal(isCrewCoreAdmin(null), false, 'null caller');
    t.equal(isCrewCoreAdmin(undefined), false, 'undefined caller');
    t.equal(isCrewCoreAdmin({}), false, 'empty caller');
  });

  /* ---- run it against the roles that actually ship -------------------- */

  t.test('of the roles that ship, only admin is a CrewCore admin', () => {
    Object.keys(DEFAULT_ROLES).forEach((key) => {
      const got = isCrewCoreAdmin({ superuser: false, roleName: key });
      const want = key === 'admin';
      t.equal(got, want,
        'role "' + key + '" should ' + (want ? '' : 'NOT ') + 'be a CrewCore admin');
    });
  });

  t.test('every shipping role with data_scope all except admin is refused', () => {
    // Names the danger explicitly: these are the roles the old rule let in.
    const wide = Object.keys(DEFAULT_ROLES)
      .filter((k) => DEFAULT_ROLES[k].data_scope === 'all' && k !== 'admin');
    t.assert(wide.length > 0, 'expected at least one non-admin role with data_scope all');
    wide.forEach((k) => {
      t.equal(isCrewCoreAdmin({ superuser: false, roleName: k }), false,
        '"' + k + '" has data_scope all and must still be refused');
    });
  });

  t.test('the self-serve employee role stays non-admin so its scoped view still works', () => {
    const role = DEFAULT_ROLES.employee;
    if (!role) return;
    t.equal(isCrewCoreAdmin({ superuser: false, roleName: 'employee' }), false,
      'employee must fall to the scoped own-record view, not the admin view');
    t.assert((role.apps || []).includes('crewcore'),
      'employee still needs app-level CrewCore access for that scoped view');
  });

  /* ---- every gate actually calls it ----------------------------------- */

  t.test('no CrewCore route gates on data_scope any more', () => {
    // A source scan is the wrong tool for proving behaviour, but it is the
    // right tool for proving a pattern was removed everywhere. The behaviour
    // itself is covered by the calls above.
    const dir = path.join(ROOT, 'api/crewcore');
    fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      t.assert(!/data_scope\s*===/.test(code),
        'api/crewcore/' + f + ' still gates on data_scope');
    });
  });

  t.test('every CrewCore route that decides admin uses the shared function', () => {
    const dir = path.join(ROOT, 'api/crewcore');
    const deciders = ['employees.js', 'reviews.js', 'stipend.js', 'timecards.js',
                      'settings.js', 'handbook.js'];
    deciders.forEach((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      t.assert(src.includes('isCrewCoreAdmin'),
        'api/crewcore/' + f + ' should decide admin through isCrewCoreAdmin');
    });
  });

  t.test('the screen gates on the same function as the server', () => {
    const src = fs.readFileSync(path.join(ROOT, 'apps/crewcore.js'), 'utf8');
    t.assert(src.includes('isCrewCoreAdmin'), 'apps/crewcore.js should use the shared rule');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    t.assert(!/perms\.data_scope/.test(code),
      'apps/crewcore.js should no longer read perms.data_scope for admin');
  });

  /* ---- the routes still load ------------------------------------------ */

  const dir = path.join(ROOT, 'api/crewcore');
  const routeFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  return Promise.all(routeFiles.map((f) =>
    import(path.join(dir, f)).then((m) => {
      t.test('api/crewcore/' + f + ' loads and exports a handler', () => {
        t.equal(typeof m.default, 'function', f + ' should export a handler');
      });
    })
  ));
}).then(() => {
  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
}).catch((e) => {
  console.log('  FAIL could not load CrewCore access modules: ' + e.message);
  process.exit(1);
});
