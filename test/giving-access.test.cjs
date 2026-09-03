// PUT IN: test/giving-access.test.cjs (NEW FILE)
/**
 * GivingGauge: who may add, who may decide, who may run the bulk jobs.
 *
 * WHY THIS EXISTS. Two opposite mistakes shipped together in this app:
 *
 *   1. Adding a request, importing from Jotform and re-matching all tested
 *      `sess.role !== "admin" && sess.role !== "manager"`. A role NAME test,
 *      so a role built in Settings for exactly this work got a 403 with every
 *      box ticked. Same mistake PromoPro had, same fix.
 *   2. Approve and Decline had no check anywhere. Anyone who could open the
 *      app could decide a donation. Granting somebody the app to type in a
 *      phone call handed them the yes or no as well.
 *
 * The rules are now three functions in lib/giving-access.js, called for real
 * here, including against every role that actually ships in lib/users.js, so
 * adding a role cannot quietly hand out the decision without turning this
 * file red.
 *
 * Real function calls through dynamic import, not source-text matching.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

Promise.all([
  import(path.join(ROOT, 'lib/giving-access.js')),
  import(path.join(ROOT, 'lib/users.js')),
]).then(([access, users]) => {
  const {
    givingAddVerdict, givingDecideVerdict, givingManageVerdict,
    canAddGiving, canDecideGiving, canManageGiving,
    permsCanAdd, permsCanDecide, permsCanManage,
  } = access;
  const { DEFAULT_ROLES } = users;

  const staff = { superuser: false };
  const flagged = { superuser: true };

  // The shape an admin would build for the people who take the phone calls:
  // GivingGauge, edit rights, and the decision left switched off.
  const intakeRole = {
    name: 'giving_intake', label: 'Giving intake',
    apps: ['givinggauge'], data_scope: 'all',
    can_edit: true, can_decide_giving: false,
  };

  /* ---- adding ---------------------------------------------------------- */

  t.test('a role with edit rights can add a request', () => {
    t.equal(canAddGiving(staff, intakeRole), true,
      'this is the whole point of the change: no admin, no manager, still adds');
  });

  t.test('a read-only role cannot add', () => {
    t.equal(canAddGiving(staff, { name: 'viewer', can_edit: false, data_scope: 'all' }), false,
      'read-only in the shell means read-only here');
  });

  t.test('the Admin flag adds regardless of role', () => {
    t.equal(canAddGiving(flagged, { name: 'viewer', can_edit: false }), true,
      'there has to be a way back in');
  });

  t.test('no role at all adds nothing', () => {
    t.equal(canAddGiving(staff, null), false, 'an account with no role is not a writer');
  });

  /* ---- deciding -------------------------------------------------------- */

  t.test('the switch off means add but do not decide', () => {
    t.equal(canDecideGiving(staff, intakeRole), false,
      'the case this whole change exists for');
    t.equal(canAddGiving(staff, intakeRole), true,
      'and it must not cost them the ability to add');
  });

  t.test('the switch on means decide', () => {
    const r = Object.assign({}, intakeRole, { can_decide_giving: true });
    t.equal(canDecideGiving(staff, r), true, 'ticked in Settings, decides');
  });

  t.test('the switch on wins even on a read-only role', () => {
    const r = { name: 'judge', can_edit: false, data_scope: 'all', can_decide_giving: true };
    t.equal(canDecideGiving(staff, r), true,
      'an explicit tick is somebody deliberately separating judging from record-keeping');
  });

  t.test('the switch off wins over everything except the Admin flag', () => {
    const r = { name: 'wide', can_edit: true, data_scope: 'all', can_decide_giving: false };
    t.equal(canDecideGiving(staff, r), false, 'an explicit no is a no');
    t.equal(canDecideGiving(flagged, r), true, 'the account flag still gets in');
  });

  t.test('a role saved before the switch existed keeps deciding', () => {
    // The deploy-day case. Before this change every role that could open the
    // app could decide; reading a missing field as false would take that away
    // from whoever has it now, silently, with nothing on screen to say why.
    const legacy = { name: 'old', label: 'Old role', apps: ['givinggauge'], data_scope: 'all', can_edit: true };
    t.equal('can_decide_giving' in legacy, false, 'the field really is absent');
    t.equal(canDecideGiving(staff, legacy), true, 'so it falls back to what decided before');
  });

  t.test('a missing switch on a narrower role does not grant the decision', () => {
    const own = { name: 'am', data_scope: 'own', can_edit: true };
    t.equal(canDecideGiving(staff, own), false, 'own-accounts-only never decided');
    const ro = { name: 'viewer', data_scope: 'all', can_edit: false };
    t.equal(canDecideGiving(staff, ro), false, 'and neither did a read-only role');
  });

  /* ---- the bulk jobs --------------------------------------------------- */

  t.test('import and re-match stay with the all-data roles', () => {
    t.equal(canManageGiving(staff, intakeRole), true,
      'an all-data role that can edit still runs them');
    t.equal(canManageGiving(staff, { name: 'am', data_scope: 'own', can_edit: true }), false,
      'somebody scoped to their own accounts does not rewrite every stored request');
    t.equal(canManageGiving(staff, { name: 'v', data_scope: 'all', can_edit: false }), false,
      'and neither does a read-only role');
    t.equal(canManageGiving(flagged, { data_scope: 'own', can_edit: false }), true,
      'the Admin flag runs them regardless');
  });

  t.test('adding is wider than managing, deliberately', () => {
    const own = { name: 'phone', data_scope: 'own', can_edit: true, can_decide_giving: false };
    t.equal(canAddGiving(staff, own), true, 'typing in a phone call is everyday work');
    t.equal(canManageGiving(staff, own), false, 'pulling in the whole Jotform history is not');
  });

  /* ---- every role that actually ships ---------------------------------- */

  t.test('the roles that ship give the answers they are meant to', () => {
    const R = DEFAULT_ROLES;
    t.equal(canDecideGiving(staff, R.admin), true, 'admin decides');
    t.equal(canDecideGiving(staff, R.manager), true, 'manager decides, as it always has');
    t.equal(canAddGiving(staff, R.viewer), false, 'viewer is read-only');
    t.equal(canDecideGiving(staff, R.viewer), false, 'and cannot decide');
    t.equal(canAddGiving(staff, R.employee), false, 'the self-serve role writes nothing here');
    t.equal(canDecideGiving(staff, R.employee), false, 'least of all a decision');
  });

  t.test('no shipped role decides without saying so out loud', () => {
    Object.keys(DEFAULT_ROLES).forEach((name) => {
      const role = DEFAULT_ROLES[name];
      if (!canDecideGiving({ superuser: false }, role)) return;
      t.equal(role.can_decide_giving, true,
        'the ' + name + ' role decides, so it must carry the flag explicitly rather than ' +
        'relying on the fallback meant for roles saved before the switch existed');
    });
  });

  /* ---- the verdicts explain themselves --------------------------------- */

  t.test('every verdict comes with a reason worth reading', () => {
    [
      givingAddVerdict(staff, intakeRole),
      givingDecideVerdict(staff, intakeRole),
      givingManageVerdict(staff, { data_scope: 'own', can_edit: true, name: 'am' }),
      givingDecideVerdict(staff, null),
    ].forEach((v) => {
      t.assert(typeof v.why === 'string' && v.why.length > 8,
        'a refusal nobody can read is a support ticket');
      t.assert(typeof v.allowed === 'boolean', 'and the answer is a boolean');
    });
  });

  /* ---- the perms blob the screen reads --------------------------------- */

  t.test('the screen helpers read the resolved flags, not the raw role', () => {
    const perms = { can_add_giving: true, can_decide_giving: false, can_manage_giving: false };
    t.equal(permsCanAdd(perms), true, 'add');
    t.equal(permsCanDecide(perms), false, 'decide');
    t.equal(permsCanManage(perms), false, 'manage');
    t.equal(permsCanAdd(null), false, 'a missing perms blob grants nothing');
    t.equal(permsCanDecide(undefined), false, 'not even by accident');
  });

  t.test('permsFor ships all three answers to the browser', () => {
    const src = read('lib/users.js');
    ['can_add_giving', 'can_decide_giving', 'can_manage_giving'].forEach((k) => {
      t.assert(new RegExp(k + ':').test(src),
        'permsFor must return ' + k + ' or the screen has nothing to read');
    });
  });

  /* ---- the file stays importable in a browser -------------------------- */

  t.test('lib/giving-access.js imports nothing', () => {
    // Two reasons at once: apps/givinggauge.js and apps/settings.js load it
    // straight into the browser, where a node import would fail the whole
    // screen, and lib/users.js imports it, so an import back would be a cycle.
    const src = read('lib/giving-access.js');
    t.equal(/^\s*import\s/m.test(src), false, 'it must stay dependency-free');
  });

  /* ---- the screen and the route ask the same questions ----------------- */

  t.test('the route gates all four actions', () => {
    const route = read('api/giving-requests.js');
    t.assert(/givingAddVerdict|mayAdd/.test(route), 'add');
    t.assert(/mayDecide\.allowed/.test(route), 'decide');
    t.assert(/mayManage\.allowed/.test(route), 'import and re-match');
    const rematch = route.slice(route.indexOf('action === "rematch"'), route.indexOf('action === "manual"'));
    t.assert(/mayManage/.test(rematch),
      're-match rewrites every stored request and had no gate at all before this');
  });

  t.test('approving on the way in is checked as a decision', () => {
    const route = read('api/giving-requests.js');
    const manual = route.slice(route.indexOf('action === "manual"'), route.indexOf('action === "backfill"'));
    t.assert(/mayDecide/.test(manual),
      'the entry form carries an "already decided" block, so it is a second door to the same thing');
  });

  t.test('a status change through PATCH needs the decide switch', () => {
    const route = read('api/giving-requests.js');
    const patch = route.slice(route.indexOf('req.method === "PATCH"'));
    t.assert(/body\.status && !mayDecide\.allowed/.test(patch),
      'the Approve button posts a plain PATCH, so this is the gate that actually stops it');
  });

  t.test('the screen hides what the route would refuse', () => {
    const app = read('apps/givinggauge.js');
    t.assert(/permsCanDecide\(ctx\.perms\)/.test(app), 'the screen reads the resolved flag');
    t.equal(/role !== 'admin'/.test(app), false, 'and never a role name again');
    t.assert(/if \(!canDecide\)/.test(app), 'Approve and Decline are hidden without the switch');
  });

  t.test('Settings can turn the decision on and off', () => {
    const settings = read('apps/settings.js');
    t.assert(/data-flag="can_decide_giving"/.test(settings), 'there is a checkbox');
    t.assert(/givingDecideVerdict/.test(settings),
      'and it shows the RESOLVED answer, so a role that has always decided reads as ticked');
    t.assert(/can_decide_giving: false/.test(settings),
      'a brand new role is written with the switch off rather than left undefined');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
