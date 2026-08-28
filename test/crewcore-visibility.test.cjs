/**
 * CrewCore visibility (Aug 28 2026).
 *
 * Three of Ryan's calls landed together, all of them about who can see what:
 *
 *   1. THE ROSTER IS ADMIN-ONLY. It lists the whole team. The self-serve
 *      profile card that used to be an employee's version of that view moved
 *      to the Dashboard.
 *   2. TIME CLOCK IS FOR PEOPLE WHO PUNCH. Every employee record already
 *      carries clock_enabled (off = salaried), so the grant is narrowed at
 *      read time in permsFor() rather than by adding a second switch that
 *      somebody has to remember to flip.
 *   3. "SUPERUSER" IS NOW "ADMIN" in every user-facing string. The stored
 *      field is still `superuser` and the protected role key is still
 *      "admin"; only the words changed, and the role's LABEL moved to "Full
 *      access" so one row of the Accounts table does not say Admin twice.
 *
 * The permission checks here are REAL calls to permsFor() against a fake
 * Upstash, not source matching: the whole point of 2 is that a grant is
 * removed at runtime, which no amount of reading DEFAULT_ROLES would catch.
 * The screen-level assertions are source-matched, since those need a browser.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---- fake Upstash ------------------------------------------------------ *
 * Reads only. permsFor() never writes, and seeding through the store's own
 * writers would just be testing the writers.
 * ----------------------------------------------------------------------- */

const kv = new Map();
const P = 'alliteration:';
const CC = 'crewcore_data';

global.fetch = async (url) => {
  const key = decodeURIComponent((String(url).match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

function seed(employees) {
  kv.clear();
  kv.set(P + 'users', JSON.stringify({
    sasha:  { username: 'sasha',  name: 'Sasha',  role: 'employee' },
    dana:   { username: 'dana',   name: 'Dana',   role: 'employee' },
    nobody: { username: 'nobody', name: 'Nobody', role: 'employee' },
    boss:   { username: 'boss',   name: 'Boss',   role: 'admin' },
  }));
  kv.set(CC + ':employee_index', JSON.stringify(employees.map((e) => e.id)));
  employees.forEach((e) => kv.set(CC + ':employee:' + e.id, JSON.stringify(e)));
}

async function check(name, fn) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  t.test(name, () => { if (err) throw err; });
}

(async () => {
  const users = await import(path.join(ROOT, 'lib/users.js'));
  const { permsFor, DEFAULT_ROLES } = users;

  seed([
    { id: 'EMP-00001', name: 'Sasha', username: 'sasha', clock_enabled: true },
    // Salaried: the switch an admin turns off on the roster for someone who
    // does not punch.
    { id: 'EMP-00002', name: 'Dana', username: 'dana', clock_enabled: false },
  ]);

  /* ---- 1. the roster ---------------------------------------------------- */

  await check('the self-serve role has no roster grant at all', async () => {
    t.assert(!DEFAULT_ROLES.employee.tabs.includes('crewcore:roster'),
      'the roster lists the whole team; an employee role must not carry it');
    const perms = await permsFor('sasha');
    t.assert(!perms.tabs.includes('crewcore:roster'),
      'and it must not appear in the permissions the shell actually reads');
  });

  await check('an employee still lands somewhere: the dashboard is granted', async () => {
    const perms = await permsFor('sasha');
    t.assert(perms.tabs.includes('crewcore:dashboard'),
      'the profile card lives on the dashboard now, so the grant has to be there');
  });

  await check('the screen refuses the roster for a non-admin as well', async () => {
    // The rail is the first gate and the server is the real one, but a
    // stored view key or a typed hash reaches showView() directly.
    const src = read('apps/crewcore.js');
    const roster = src.slice(src.indexOf("if (view === 'roster')"), src.indexOf("if (view === 'timeclock')"));
    t.assert(/if \(!isAdmin\)/.test(roster), 'the roster view must check isAdmin before drawing a list');
    t.assert(/Admin access required/.test(roster), 'and say so rather than render an empty table');
  });

  await check('a role with CrewCore ticked and no tabs list is still narrowed', async () => {
    // THE BUG AMANDA FOUND, Aug 28 2026. Only the "employee" role ships a
    // tabs list, and "no tabs recorded" used to mean "every view". So an
    // office account on its own role opened CrewCore to a rail with Roster,
    // Time Clock and Settings on it. The server was answering correctly the
    // whole time — she saw her own record — but the rail offered the team.
    kv.set(P + 'roles', JSON.stringify({
      office: { name: 'office', label: 'Office', apps: ['backbone', 'crewcore'], data_scope: 'all', can_edit: true },
    }));
    kv.set(P + 'users', JSON.stringify({
      amanda: { username: 'amanda', name: 'Amanda', role: 'office' },
    }));
    kv.set(CC + ':employee_index', JSON.stringify(['EMP-00009']));
    kv.set(CC + ':employee:EMP-00009', JSON.stringify({
      id: 'EMP-00009', name: 'Amanda', username: 'amanda', clock_enabled: false,
    }));

    const perms = await permsFor('amanda');
    t.assert(perms.tabs.includes('crewcore'), 'she still has the app itself');
    t.assert(!perms.tabs.includes('crewcore:roster'), 'but not the roster');
    t.assert(!perms.tabs.includes('crewcore:settings'), 'and not CrewCore settings');
    t.assert(!perms.tabs.includes('crewcore:timeclock'), 'and not the time clock — she does not punch');
    t.assert(perms.tabs.includes('crewcore:dashboard') && perms.tabs.includes('crewcore:stipend'),
      'the self-serve views are granted explicitly rather than left to a fallback');
    t.assert(perms.tabs.includes('backbone'),
      'a ceiling on ONE app must not touch her access to any other');

    seed([
      { id: 'EMP-00001', name: 'Sasha', username: 'sasha', clock_enabled: true },
      { id: 'EMP-00002', name: 'Dana', username: 'dana', clock_enabled: false },
    ]);
  });

  await check('the same ceiling holds in the rail, not just in the perms', async () => {
    // Second gate: a session issued before this deploy carries the old wide
    // tabs, and the rail is drawn from whatever it was handed.
    const reg = await import(path.join(ROOT, 'js/registry.js'));
    const wide = { role: 'office', superuser: false, tabs: ['crewcore'] };
    const views = reg.allowedViews(wide, 'crewcore');
    t.assert(!views.includes('roster'), 'the rail must not draw Roster for a non-admin');
    t.assert(!views.includes('settings'), 'nor CrewCore Settings');
    t.assert(views.includes('dashboard'), 'the self-serve views still have to be reachable');

    const admin = { role: 'admin', superuser: false, tabs: ['crewcore'] };
    t.assert(reg.allowedViews(admin, 'crewcore').includes('roster'),
      'the admin role keeps every view');
    const flagged = { role: 'am', superuser: true, tabs: ['crewcore'] };
    t.assert(reg.allowedViews(flagged, 'crewcore').includes('roster'),
      'so does an account with the Admin flag');
    t.assert(reg.allowedViews(wide, 'shopstock').length > 1,
      'no other app changed: the ceiling is CrewCore-only');
  });

  /* ---- 2. the time clock ------------------------------------------------ */

  await check('somebody who punches keeps the Time Clock grant', async () => {
    const perms = await permsFor('sasha');
    t.assert(perms.tabs.includes('crewcore:timeclock'),
      'clock_enabled true is the ordinary case and must be untouched');
  });

  await check('somebody who does not punch loses it', async () => {
    const perms = await permsFor('dana');
    t.assert(!perms.tabs.includes('crewcore:timeclock'),
      'a salaried employee has no hours on file, so the tab must not be drawn');
    t.assert(perms.tabs.includes('crewcore:stipend'),
      'and nothing else about their access may change');
  });

  await check('an unlinked account keeps the grant rather than losing tabs silently', async () => {
    // No employee record at all. That person already meets "ask an admin to
    // link you" everywhere in CrewCore; quietly removing a tab as well would
    // be a second symptom of the same missing link, harder to diagnose.
    const perms = await permsFor('nobody');
    t.assert(perms.tabs.includes('crewcore:timeclock'),
      'no record is not the same fact as clock_enabled false');
  });

  await check('a record with no clock_enabled field is treated as punching', async () => {
    // Records written before the field existed. Defaulting the other way
    // would strip the tab from most of the shop on deploy day.
    seed([{ id: 'EMP-00003', name: 'Sasha', username: 'sasha' }]);
    const perms = await permsFor('sasha');
    t.assert(perms.tabs.includes('crewcore:timeclock'),
      'only an explicit false may remove the grant');
    seed([
      { id: 'EMP-00001', name: 'Sasha', username: 'sasha', clock_enabled: true },
      { id: 'EMP-00002', name: 'Dana', username: 'dana', clock_enabled: false },
    ]);
  });

  await check('an admin is not narrowed by any of this', async () => {
    const perms = await permsFor('boss');
    t.equal(perms.role, 'admin', 'the admin role is what is under test');
    t.assert(!perms.tabs.some((x) => String(x).startsWith('crewcore:')),
      'the admin role carries no scoped view grants, so allowedViews() gives it every view');
  });

  await check('a storage failure cannot lock somebody out of the shell', async () => {
    const saved = global.fetch;
    global.fetch = async () => { throw new Error('upstash is having a day'); };
    let perms = null;
    try { perms = await permsFor('sasha'); } catch (e) { /* falls through to the assert */ }
    global.fetch = saved;
    t.assert(perms === null || Array.isArray(perms.tabs),
      'permsFor may fail, but it must not half-answer with a broken tabs list');
  });

  /* ---- 3. Superuser is now Admin ---------------------------------------- */

  t.test('the protected role is labelled Full access, not Administrator', () => {
    t.equal(DEFAULT_ROLES.admin.label, 'Full access',
      'two things on one row of the Accounts table cannot both read "Admin"');
    t.equal(DEFAULT_ROLES.admin.name, 'admin',
      'the KEY must not move: it is stored on every user record and checked by name');
  });

  await check('a stored roles blob cannot keep the old label or the old grants', async () => {
    // Roles get written to storage whenever anybody saves the Roles screen,
    // and stored used to win on every field. That would have made this whole
    // change invisible on the live site: the label would still read
    // Administrator and the employee role would still carry the roster.
    // Labels and tabs on SHIPPED roles are owned by code for that reason.
    const saved = new Map(kv);
    kv.set(P + 'roles', JSON.stringify({
      admin: { name: 'admin', label: 'Administrator', protected: true, apps: ['backbone'], data_scope: 'all' },
      employee: { name: 'employee', label: 'Employee', apps: ['crewcore'], tabs: ['crewcore:roster'], data_scope: 'own' },
      production_lead: { name: 'production_lead', label: 'Production Lead', apps: ['backbone'], data_scope: 'all' },
    }));
    const roles = await users.getRoles();
    t.equal(roles.admin.label, 'Full access', 'a stale stored label must not win');
    t.assert(!roles.employee.tabs.includes('crewcore:roster'), 'nor a stale stored grant');
    t.equal(roles.production_lead.label, 'Production Lead',
      'a label somebody typed on a role they created is theirs and must survive');
    kv.clear();
    saved.forEach((v, k) => kv.set(k, v));
  });

  t.test('the Accounts table calls the flag Admin', () => {
    const src = read('apps/settings.js');
    t.assert(/<th>Person<\/th><th>Role<\/th><th>Admin<\/th>/.test(src),
      'the column header is the flag\'s name to everybody who uses the shell');
    t.assert(/data-superuser-user=/.test(src),
      'the stored field stays `superuser` — this was a rename of words, not of data');
  });

  t.test('no user-facing string says Superuser any more', () => {
    // Comments and code keys are exempt: they are the reason this rename was
    // cheap. This looks only at quoted text that reaches a screen.
    const files = ['apps/settings.js', 'apps/promopro.js', 'api/sitework.js', 'api/help.js',
                   'api/marketmachine/samples.js'];
    files.forEach((f) => {
      read(f).split('\n').forEach((line, i) => {
        const code = line.replace(/^\s*\/\/.*$/, '');
        const quoted = code.match(/(['"])(?:\\.|(?!\1)[^\\])*\1/g) || [];
        quoted.forEach((q) => {
          t.assert(!/super\s*user/i.test(q) || /data-superuser-user|superuser["']?\s*:/.test(q),
            f + ' line ' + (i + 1) + ' still shows the word Superuser: ' + q);
        });
      });
    });
  });

  /* ---- 4. reviews open ---------------------------------------------------
   * Reviews were a flat list with no way in. The API already had PATCH and
   * DELETE; only the screen was missing.
   * ---------------------------------------------------------------------- */

  t.test('a review row opens a detail view', () => {
    const src = read('apps/crewcore.js');
    t.assert(/_renderReviewDetail\(\)/.test(src), 'there must be a detail renderer');
    t.assert(/data-review="/.test(src), 'and a row that carries the id to open');
    t.assert(/_reviewDetailId/.test(src), 'one key decides list or detail, like the stipend view');
  });

  t.test('the detail draws every field a review carries', () => {
    const src = read('apps/crewcore.js');
    const detail = src.slice(src.indexOf('_renderReviewDetail() {'), src.indexOf('_wireReviews() {'));
    ['summary', 'strengths', 'growth_areas', 'next_review_date', 'reviewer_name'].forEach((f) => {
      t.assert(detail.includes(f), 'the detail must show ' + f + ' — being able to read it is the whole ask');
    });
  });

  t.test('an admin can update and delete from the detail, through the seam', () => {
    const src = read('apps/crewcore.js');
    t.assert(/ENDPOINTS\.ccReviews \+ '\?id=' \+ encodeURIComponent\(review\.id\), \{ method: 'PATCH'/.test(src),
      'edit must PATCH the existing review rather than log a second one');
    t.assert(/ENDPOINTS\.ccReviews \+ '\?id=' \+ encodeURIComponent\(r\.id\), \{ method: 'DELETE'/.test(src),
      'delete must go through the seam with the id in the query, like every other delete here');
    t.assert(!/fetch\(/.test(src), 'no app file calls fetch() directly');
  });

  t.test('an employee gets the same detail without the buttons', () => {
    const src = read('apps/crewcore.js');
    const detail = src.slice(src.indexOf('_renderReviewDetail() {'), src.indexOf('_wireReviews() {'));
    t.assert(/isAdmin \? `[\s\S]*ccRevEdit[\s\S]*ccRevDelete/.test(detail),
      'Edit and Delete must be behind isAdmin, not always drawn');
  });

  t.test('the review API still refuses a self-serve write', () => {
    // The screen hides the buttons; this is the gate that matters.
    const api = read('api/crewcore/reviews.js');
    const guard = api.indexOf('if (!isAdmin)');
    t.assert(guard > 0 && api.indexOf('req.method === "POST"') > guard,
      'the 403 must sit above every write branch');
  });

  /* ---- 5. the self-serve dashboard --------------------------------------- */

  t.test('the dashboard has an employee half', () => {
    const src = read('apps/crewcore.js');
    t.assert(/_renderDashboardSelf\(\)/.test(src), 'the profile card needs somewhere to live');
    t.assert(/_loadSelfDashboard\(\)/.test(src), 'and its figures need loading');
    t.assert(/_renderProfileSelf\(\)/.test(src),
      'the profile card itself is reused, not rewritten — one copy of those fields');
  });

  t.test('one failing card does not blank the screen', () => {
    const src = read('apps/crewcore.js');
    const fn = src.slice(src.indexOf('async _loadSelfDashboard() {'), src.indexOf('_renderDashboardSelf() {'));
    const tries = (fn.match(/try \{/g) || []).length;
    t.assert(tries >= 3,
      'each fetch on the dashboard has to fail on its own, or one bad endpoint costs the whole landing screen');
  });

  t.test('the anniversary line names the anniversary they are actually reaching', () => {
    // Both dashboards printed `years + 1` and aged everybody by a year:
    // Amanda, who started Feb 14 2022, was told she had six years coming up
    // in Aug 2026. daysUntilAnniversary already returns the milestone.
    const src = read('apps/crewcore.js');
    t.assert(!/ann\.years \+ 1/.test(src),
      'years already IS the milestone being reached — adding one overstates it');
    t.assert(/\$\{ann\.years\} \$\{ann\.years === 1 \? 'year' : 'years'\} at P&amp;M/.test(src),
      'the self-serve line must print the figure as returned');
  });

  t.test('the hours card is only drawn for somebody who punches', () => {
    const src = read('apps/crewcore.js');
    t.assert(/_canClock\(\)/.test(src), 'there must be one definition of "punches", used by both the card and the guard');
    const view = src.slice(src.indexOf("if (view === 'timeclock')"), src.indexOf("if (view === 'stipend')"));
    t.assert(/!isAdmin && !this\._canClock\(\)/.test(view),
      'the Time Clock view must guard on it too, not only the rail');
  });

  process.exit(t.report());
})().catch((e) => {
  console.log('  FAIL crewcore-visibility suite could not run: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
