/**
 * Access scoping tests.
 *
 * canAccess() is the shell's only gate between a signed-in user and an app.
 * The most sensitive planned app, CrewCore (pay and review notes), relies on
 * one property of that gate: an app id NO role grants is invisible to
 * everyone except superusers. These tests run the real function.
 *
 * registry.js is an ES module and the harness is CommonJS, so the module is
 * loaded through a dynamic import and the tests run after it resolves.
 *
 * Rebuilt Jul 29, 2026: the original was lost to a wrong-file upload.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

import(path.join(ROOT, 'js/registry.js')).then((reg) => {
  const { canAccess, APPS } = reg;

  t.test('no perms means no access', () => {
    t.equal(canAccess(null, 'backbone'), false, 'null perms must deny');
    t.equal(canAccess(undefined, 'crewcore'), false, 'undefined perms must deny');
  });

  t.test('an ungranted app is denied to ordinary roles', () => {
    const perms = { role: 'manager', tabs: ['backbone', 'shopstock'] };
    t.equal(canAccess(perms, 'crewcore'), false,
      'crewcore must stay invisible to roles that were never granted it');
    t.equal(canAccess(perms, 'givinggauge'), false,
      'ungranted apps must be denied, not defaulted open');
  });

  t.test('granted apps are allowed', () => {
    const perms = { role: 'manager', tabs: ['backbone', 'shopstock'] };
    t.equal(canAccess(perms, 'backbone'), true, 'granted app was denied');
    t.equal(canAccess(perms, 'shopstock'), true, 'granted app was denied');
  });

  t.test('superusers see everything, including stubs', () => {
    const perms = { role: 'admin', superuser: true, tabs: [] };
    APPS.forEach((a) => {
      t.equal(canAccess(perms, a.id), true, 'superuser denied ' + a.id);
    });
  });

  t.test('legacy BackBone-only tab lists grant BackBone and nothing else', () => {
    // Old stored roles carry view names, no app ids. They must keep working
    // (grant backbone) without accidentally opening every other app.
    const perms = { role: 'am', tabs: ['dashboard', 'scorecard'] };
    t.equal(canAccess(perms, 'backbone'), true, 'legacy role lost BackBone');
    t.equal(canAccess(perms, 'crewcore'), false, 'legacy role must not see crewcore');
    t.equal(canAccess(perms, 'errorengine'), false, 'legacy role must not see errorengine');
  });

  t.test('crewcore ships locked: no registry default grants it', () => {
    // The registry must not mark crewcore as granted-by-default anywhere.
    const src = read('js/registry.js');
    const cc = APPS.find((a) => a.id === 'crewcore');
    t.assert(cc, 'crewcore is missing from the registry');
    t.assert(cc.stub === true, 'crewcore must stay a stub until the real build');
    t.assert(!/defaultGrant|grantAll|public:\s*true/.test(src),
      'registry gained a default-grant mechanism; crewcore relies on deny-by-default');
  });

  t.test('every registered app has a module and a tokens block', () => {
    const tokens = read('css/tokens.css');
    APPS.forEach((a) => {
      const asFile = 'apps/' + a.id + '.js';
      const asFolder = 'apps/' + a.id + '/index.js';
      t.assert(fs.existsSync(path.join(ROOT, asFile)) ||
               fs.existsSync(path.join(ROOT, asFolder)),
        a.id + ' has a registry entry but no module at ' + asFile + ' or ' + asFolder);
      t.assert(tokens.includes('data-app="' + a.id + '"'),
        a.id + ' has no theming block in tokens.css');
    });
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import js/registry.js: ' + e.message);
  process.exit(1);
});
