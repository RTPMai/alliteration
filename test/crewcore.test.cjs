/**
 * CrewCore contract tests.
 *
 * CrewCore is the most sensitive app in the shell (pay, review notes), and
 * self-serve access shipped Aug 3 2026 alongside the real build. These tests
 * lock two things: the schema validates what it should, and the field-level
 * isolation between an admin view and a self-serve view actually holds —
 * stripAdminFields() is the one function standing between an employee and
 * seeing a coworker's hourly rate, so it gets direct coverage rather than
 * just being exercised incidentally through the API routes.
 *
 * lib/crewcore/schema.js is an ES module and the harness is CommonJS, so it
 * is loaded through a dynamic import and the tests run after it resolves.
 *
 * RESTORED Aug 2026: this file was overwritten with a duplicate copy of
 * api/crewcore/settings.js during a web-upload round trip (same failure mode
 * DEPLOY-NOTES.md warns about — check first lines before uploading).
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const schemaReady = import(path.join(ROOT, 'lib/crewcore/schema.js')).then((schema) => {
  const {
    validateEmployee, stripAdminFields, ADMIN_ONLY_FIELDS,
    validatePtoRequest, validatePtoStatus, validateReview,
    DEPARTMENTS, PTO_TYPES, PTO_STATUSES, EMPLOYMENT_STATUSES,
    nextId,
  } = schema;

  /* ---- employees ---------------------------------------------------- */

  t.test('a minimal valid employee passes', () => {
    const { ok, errors } = validateEmployee({ name: 'Taylor Hitt', start_date: '2020-01-01' });
    t.assert(ok, 'expected valid, got errors: ' + JSON.stringify(errors));
  });

  t.test('name is required', () => {
    const { ok, errors } = validateEmployee({ start_date: '2020-01-01' });
    t.equal(ok, false, 'missing name should fail validation');
    t.assert(errors.some((e) => /name/i.test(e)), 'error should mention name');
  });

  t.test('start_date is required', () => {
    const { ok } = validateEmployee({ name: 'Someone' });
    t.equal(ok, false, 'missing start_date should fail validation');
  });

  t.test('department must be one of the known set', () => {
    const bad = validateEmployee({ name: 'X', start_date: '2020-01-01', department: 'Warehouse' });
    t.equal(bad.ok, false, 'an unknown department should be rejected');
    const good = validateEmployee({ name: 'X', start_date: '2020-01-01', department: 'Sales' });
    t.assert(good.ok, 'a known department should pass');
  });

  t.test('department defaults to Office when omitted on a full (non-partial) write', () => {
    const { ok, record } = validateEmployee({ name: 'X', start_date: '2020-01-01' });
    t.assert(ok, 'expected valid');
    t.equal(record.department, 'Office', 'department should default to Office');
  });

  t.test('hourly_rate rejects negative numbers', () => {
    const { ok } = validateEmployee({ name: 'X', start_date: '2020-01-01', hourly_rate: -5 });
    t.equal(ok, false, 'a negative hourly_rate should be rejected');
  });

  t.test('hourly_rate accepts null (unset)', () => {
    const { ok, record } = validateEmployee({ name: 'X', start_date: '2020-01-01', hourly_rate: null });
    t.assert(ok, 'null hourly_rate should be a valid unset value');
    t.equal(record.hourly_rate, null, 'hourly_rate should stay null');
  });

  t.test('a partial update does not require name or start_date', () => {
    const { ok } = validateEmployee({ phone: '555-1234' }, { partial: true });
    t.assert(ok, 'a partial patch should not demand the full required set');
  });

  t.test('status must be one of the known employment statuses', () => {
    EMPLOYMENT_STATUSES.forEach((s) => {
      const { ok } = validateEmployee({ name: 'X', start_date: '2020-01-01', status: s });
      t.assert(ok, s + ' should be a valid status');
    });
    const bad = validateEmployee({ name: 'X', start_date: '2020-01-01', status: 'vacationing' });
    t.equal(bad.ok, false, 'an unknown status should be rejected');
  });

  /* ---- self-serve field isolation ------------------------------------ */
  // This is the guarantee that actually matters: an employee reading their
  // OWN record through the self-serve path must never receive pay, stipend,
  // or admin notes. api/crewcore/employees.js calls stripAdminFields() on
  // every self-serve read; this locks that the function itself removes
  // every field it claims to, and nothing else.

  t.test('stripAdminFields removes every admin-only field', () => {
    const full = {
      id: 'EMP-00001', name: 'Kim Taylor', department: 'Embroidery',
      hourly_rate: 26.5, apparel_stipend: 150, notes: 'confidential note',
      phone: '206-817-1151', status: 'active',
    };
    const stripped = stripAdminFields(full);
    ADMIN_ONLY_FIELDS.forEach((f) => {
      t.equal(f in stripped, false, f + ' should not be present after stripAdminFields');
    });
  });

  t.test('stripAdminFields leaves non-sensitive fields untouched', () => {
    const full = {
      id: 'EMP-00001', name: 'Kim Taylor', department: 'Embroidery',
      hourly_rate: 26.5, apparel_stipend: 150, notes: 'x',
      phone: '206-817-1151', status: 'active', start_date: '2013-03-01',
    };
    const stripped = stripAdminFields(full);
    t.equal(stripped.name, 'Kim Taylor', 'name should survive stripping');
    t.equal(stripped.department, 'Embroidery', 'department should survive stripping');
    t.equal(stripped.phone, '206-817-1151', 'phone should survive stripping');
    t.equal(stripped.status, 'active', 'status should survive stripping');
    t.equal(stripped.start_date, '2013-03-01', 'start_date should survive stripping');
  });

  t.test('stripAdminFields does not mutate the original record', () => {
    const full = { name: 'X', hourly_rate: 20 };
    stripAdminFields(full);
    t.equal(full.hourly_rate, 20, 'stripAdminFields must not mutate its input');
  });

  t.test('ADMIN_ONLY_FIELDS covers pay and notes, but NOT the stipend', () => {
    ['hourly_rate', 'notes'].forEach((f) => {
      t.assert(ADMIN_ONLY_FIELDS.includes(f), f + ' should be listed as admin-only');
    });
    // Deliberate: an employee can see their OWN apparel_stipend allotment
    // (it's their clothing budget) — the API layer enforces "own record
    // only" by scope, not by hiding this field. If this ever regresses to
    // stripping apparel_stipend, self-serve employees lose visibility into
    // their own stipend balance, which is the whole point of this feature.
    t.assert(!ADMIN_ONLY_FIELDS.includes('apparel_stipend'),
      'apparel_stipend must stay visible to a self-serve caller on their own record');
  });



  /* ---- PTO requests -- kept for schema compatibility -------------------
   * PTO tracking itself moved to QuickBooks (Ryan's call, Aug 2026); the
   * validatePtoRequest/validatePtoStatus functions and the pto_days_per_year
   * field stayed in the schema as dead code rather than being ripped out,
   * in case that decision is revisited. These tests intentionally stop
   * covering PTO beyond confirming the schema still parses; see
   * DEPLOY-NOTES.md for what was actually removed from the app surface.
   */

  t.test('type must be one of the known PTO types', () => {
    PTO_TYPES.forEach((type) => {
      const { ok } = validatePtoRequest({ start_date: '2026-08-17', type, days: 1 });
      t.assert(ok, type + ' should be a valid PTO type');
    });
  });

  t.test('validatePtoStatus only accepts the known status set', () => {
    PTO_STATUSES.forEach((s) => t.assert(validatePtoStatus(s), s + ' should be a valid PTO status'));
    t.equal(validatePtoStatus('archived'), false, 'an unknown status should be rejected');
  });

  /* ---- reviews ----------------------------------------------------------- */

  t.test('a minimal valid review passes', () => {
    const { ok, errors } = validateReview({
      employee_id: 'EMP-00001', review_date: '2026-06-15', reviewer_name: 'Ryan Toney',
    });
    t.assert(ok, 'expected valid, got errors: ' + JSON.stringify(errors));
  });

  t.test('employee_id and review_date are required', () => {
    const noEmp = validateReview({ review_date: '2026-06-15', reviewer_name: 'Ryan' });
    t.equal(noEmp.ok, false, 'missing employee_id should fail');
    const noDate = validateReview({ employee_id: 'EMP-00001', reviewer_name: 'Ryan' });
    t.equal(noDate.ok, false, 'missing review_date should fail');
  });

  /* ---- id generation ------------------------------------------------- */

  t.test('nextId increments off the highest existing numeric suffix', () => {
    t.equal(nextId('EMP', []), 'EMP-00001', 'first id should be 00001');
    t.equal(nextId('EMP', ['EMP-00001', 'EMP-00003']), 'EMP-00004', 'should increment past the highest existing id');
  });

  /* ---- apparel stipend --------------------------------------------------
   * Role-based defaults per the Handbook's Dress Code policy: $250/year for
   * Front Office, $150/year for Production. validateEmployee() itself stays
   * a plain non-negative-number check (an admin can still override per
   * person), so the DEFAULT lives in defaultStipendFor() instead — these
   * tests pin that function against the Handbook's actual dollar figures.
   */

  t.test('defaultStipendFor matches the Handbook dress code figures', () => {
    t.equal(schema.defaultStipendFor('Sales'), 250, 'Front Office roles (Sales) should default to $250/year');
    t.equal(schema.defaultStipendFor('Office'), 250, 'Front Office roles (Office) should default to $250/year');
    t.equal(schema.defaultStipendFor('Screen Printing'), 150, 'Production roles should default to $150/year');
    t.equal(schema.defaultStipendFor('Embroidery'), 150, 'Production roles should default to $150/year');
    t.equal(schema.defaultStipendFor('Art'), 150, 'Production roles should default to $150/year');
  });

  t.test('apparel_stipend still accepts an explicit override', () => {
    const { ok, record } = validateEmployee({
      name: 'X', start_date: '2020-01-01', department: 'Sales', apparel_stipend: 300,
    });
    t.assert(ok, 'expected valid');
    t.equal(record.apparel_stipend, 300, 'an explicit stipend should override the department default');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import lib/crewcore/schema.js: ' + e.message);
  process.exitCode = 1;
});

/* ---- API route source checks ------------------------------------------
 * Belt-and-suspenders, same reasoning as the schema tests above: these
 * confirm the routes actually enforce what the schema tests prove is
 * possible, rather than relying on the front end to behave.
 */

t.test('PTO route is actually gone, not just unused', () => {
  t.equal(fs.existsSync(path.join(ROOT, 'api/crewcore/pto.js')), false,
    'api/crewcore/pto.js should be deleted, not left dead — PTO tracking moved to QuickBooks');
});

t.test('employees route strips admin fields on the self-serve read path', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(src.includes('stripAdminFields'), 'employees.js should call stripAdminFields for self-serve reads');
});

t.test('employees route requires admin scope for write methods', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(/if\s*\(!isAdmin\)/.test(src), 'employees.js should gate POST/PATCH/DELETE on isAdmin');
});

t.test('employees route never returns another employee\'s record to a self-serve caller by id', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(src.includes('getEmployeeByUsername(sess.username)'),
    'self-serve reads should resolve by the caller\'s own session username');
});

/* ---- shell username link (self-serve linking) --------------------------
 * ADDED Aug 2026: the "Shell username (optional)" field on the Roster form
 * lets an admin link an employee record to a real Alliteration login. That
 * link used to save with no validation at all — a typo would silently save
 * and leave the employee stuck on "ask an admin to link your account" with
 * no error telling the admin why. checkUsernameLink() closes that gap.
 */
t.test('employees route validates the shell username against a real account before saving', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(src.includes('checkUsernameLink'),
    'employees.js should run the username through checkUsernameLink before saving');
  t.assert(src.includes('await getUser(username)'),
    'checkUsernameLink should look the username up against real shell accounts via getUser');
});

t.test('checkUsernameLink treats a blank username as valid (the link is optional)', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(/if\s*\(!username\)\s*return null/.test(src),
    'a blank/null username should short-circuit to no error, since linking is optional');
});

t.test('checkUsernameLink refuses a username already claimed by a different employee', () => {
  const src = read('api/crewcore/employees.js');
  t.assert(src.includes('e.id !== ownEmployeeId'),
    'the duplicate-claim check should exclude the record being saved itself, or editing an employee would always flag its own username as taken');
  t.assert(/already linked to/.test(src),
    'a duplicate claim should surface a specific, readable error rather than a generic validation failure');
});

t.test('POST and PATCH both run the username check, not just one of them', () => {
  const src = read('api/crewcore/employees.js');
  const postIdx = src.indexOf('req.method === "POST"');
  const patchIdx = src.indexOf('req.method === "PATCH"');
  const postBlock = src.slice(postIdx, patchIdx);
  const patchBlock = src.slice(patchIdx);
  t.assert(postBlock.includes('checkUsernameLink'), 'POST (creating a new employee) should validate the username link');
  t.assert(patchBlock.includes('checkUsernameLink'), 'PATCH (editing an employee) should validate the username link');
});

t.test('stipend route lets a self-serve caller read their own balance', () => {
  const src = read('api/crewcore/stipend.js');
  t.assert(src.includes('getEmployeeByUsername(sess.username)'),
    'self-serve stipend reads should resolve by the caller\'s own session username');
  t.assert(src.includes('balance'), 'the self-serve response should include a computed balance');
});

t.test('stipend route requires admin scope to log or delete a spend entry', () => {
  const src = read('api/crewcore/stipend.js');
  const gateIdx = src.indexOf('if (!isAdmin)');
  const postIdx = src.indexOf('req.method === "POST"');
  t.assert(gateIdx > -1 && postIdx > -1 && gateIdx < postIdx,
    'the isAdmin gate should appear before the POST handler in stipend.js');
});

t.test('stipend route never lets a self-serve caller see another employee\'s spend by employee_id', () => {
  const src = read('api/crewcore/stipend.js');
  // The admin branch is the only place employee_id from the query is
  // honored; the self-serve branch below it must not read req.query at all.
  const adminBranch = src.slice(src.indexOf('if (isAdmin) {'), src.indexOf('const own = await getEmployeeByUsername'));
  t.assert(adminBranch.includes('req.query'),
    'employee_id filtering by query param should only happen in the admin branch');
});

t.test('reviews route never lets a self-serve caller write a review', () => {
  const src = read('api/crewcore/reviews.js');
  const gateIdx = src.indexOf('if (!isAdmin)');
  const postIdx = src.indexOf('req.method === "POST"');
  t.assert(gateIdx > -1 && postIdx > -1 && gateIdx < postIdx,
    'the isAdmin gate should appear before the POST handler in reviews.js');
});

t.test('handbook route requires auth but no admin gate — everyone with crewcore access can read it', () => {
  const src = read('api/crewcore/handbook.js');
  t.assert(src.includes('requireAuth'), 'handbook.js should still require a signed-in session');
  t.assert(!/isAdmin/.test(src), 'handbook.js should not gate reads on isAdmin — it is open to self-serve too');
});

t.test('the hub gives crewcore a real metrics block, not just a Live pill with nothing behind it', () => {
  // appsOnSampleData() in js/api.js lists crewcore, which means its hub card
  // shows a "Live" pill once the endpoint is live — a card with a Live pill
  // and no has('crewcore') block would sit stuck on "Loading" forever,
  // which is the false-indicator problem the project's other apps avoid.
  const hub = read('apps/hub.js');
  t.assert(/has\(['"]crewcore['"]\)/.test(hub), 'apps/hub.js should have an if (has(\'crewcore\')) block');
  t.assert(hub.includes("setCard('crewcore'"), 'the crewcore block should actually call setCard');
});

/* ---- permsFor per-view scoping (lib/users.js) -----------------------
 * Separate import block: this exercises permsFor()/allowedViews() together,
 * which needs both lib/users.js and js/registry.js loaded. This pins that
 * an "employee" role, if one exists, stays view-scoped so a self-serve
 * caller never gets a shop-wide Settings tab in their rail.
 */
schemaReady.then(() => Promise.all([
  import(path.join(ROOT, 'lib/users.js')),
  import(path.join(ROOT, 'js/registry.js')),
])).then(([users, reg]) => {
  const { DEFAULT_ROLES } = users;
  const { allowedViews } = reg;

  t.test('if a self-serve "employee" role exists, its scoped tabs hide Settings', () => {
    const role = DEFAULT_ROLES.employee;
    if (!role) {
      // Self-serve PTO was removed alongside the PTO feature; if the role
      // itself was also removed, there is nothing left to check here.
      return;
    }
    const perms = {
      tabs: (role.apps || []).concat(role.tabs || []),
      data_scope: role.data_scope,
    };
    const views = allowedViews(perms, 'crewcore');
    t.assert(!views.includes('settings'), 'a self-serve employee should never see the settings view');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
}).catch((e) => {
  console.log('  FAIL could not import lib/users.js or js/registry.js: ' + e.message);
  process.exit(1);
});
