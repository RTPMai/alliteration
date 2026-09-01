// test/promopro-buyers.test.cjs
/**
 * PromoPro: who can raise a purchase order, and being able to see it.
 *
 * The complaint was "anyone can make a PO right now". Two separate things
 * were true. The New purchase order button sat in the static template with
 * no permission check on it at all, so it was there for everybody who could
 * open the app. And the screen worked off the shell's blanket can_edit flag
 * rather than the rule the routes actually use, so ticking roles in Settings
 * would have left the button in place and simply made it fail at the end.
 *
 * The decision is now one pure function, called here for real. The readout
 * on the Settings screen is built from the SAME function the routes gate on:
 * a permissions screen that disagrees with the server is worse than no
 * permissions screen, because it is believed.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('apps/promopro.js');
const settingsRoute = read('api/promopro/settings.js');
const receiveRoute = read('api/promopro/receive.js');

const ADMIN = { username: 'ryan', superuser: true };
const AM = { name: 'am', label: 'Account Manager', can_edit: true };
const MANAGER = { name: 'manager', label: 'Manager', can_edit: true };
const VIEWER = { name: 'viewer', label: 'Viewer (read-only)', can_edit: false };

(async () => {
  const a = await import('../lib/promopro/access.js');

  /* ---- raising one ----------------------------------------------------- */

  t.test('the admin flag always wins, so there is a way back in', () => {
    t.equal(a.editVerdict(ADMIN, VIEWER, { editRoles: ['nobody'] }).allowed, true);
  });

  t.test('nothing ticked keeps today behaviour, not nobody', () => {
    // An empty list is what a fresh deploy looks like. If it meant "nobody",
    // deploying this would lock the whole team out of a working app.
    t.equal(a.editVerdict({ username: 'alexis' }, AM, { editRoles: [] }).allowed, true);
    t.equal(a.editVerdict({ username: 'alexis' }, AM, {}).allowed, true);
    t.equal(a.editVerdict({ username: 'alexis' }, AM, null).allowed, true);
  });

  t.test('once a role is ticked, everyone else is out', () => {
    const s = { editRoles: ['manager'] };
    t.equal(a.editVerdict({ username: 'm' }, MANAGER, s).allowed, true);
    t.equal(a.editVerdict({ username: 'alexis' }, AM, s).allowed, false);
  });

  t.test('a read-only role is never let in by a tick', () => {
    // Ticking "viewer" in PromoPro must not hand edit rights to a role the
    // shell says is read-only. This list narrows; it cannot widen.
    t.equal(a.editVerdict({ username: 'v' }, VIEWER, { editRoles: ['viewer'] }).allowed, false);
  });

  t.test('role names are matched case-insensitively', () => {
    t.equal(a.editVerdict({ username: 'm' }, { name: 'Manager', can_edit: true }, { editRoles: ['manager'] }).allowed, true);
  });

  t.test('an account with no role at all is refused', () => {
    t.equal(a.editVerdict({ username: 'x' }, null, { editRoles: [] }).allowed, false);
  });

  t.test('every verdict explains itself in words', () => {
    // The `why` is what makes the readout worth having. A table of yes and no
    // with no reasons tells you the state and not what to change.
    const cases = [
      a.editVerdict(ADMIN, null, {}),
      a.editVerdict({ username: 'v' }, VIEWER, {}),
      a.editVerdict({ username: 'a' }, AM, { editRoles: [] }),
      a.editVerdict({ username: 'a' }, AM, { editRoles: ['manager'] }),
      a.editVerdict({ username: 'm' }, MANAGER, { editRoles: ['manager'] }),
      a.editVerdict({ username: 'x' }, null, {}),
    ];
    cases.forEach((v, i) => {
      t.assert(typeof v.why === 'string' && v.why.length > 8, 'case ' + i + ' has no reason');
    });
  });

  t.test('the fallback says so, so it can be told from a real grant', () => {
    t.equal(a.editVerdict({ username: 'a' }, AM, { editRoles: [] }).viaFallback, true);
    t.equal(a.editVerdict({ username: 'm' }, MANAGER, { editRoles: ['manager'] }).viaFallback, undefined);
  });

  /* ---- booking in stock ------------------------------------------------ */

  t.test('receiving stays open to people who cannot raise a PO', () => {
    // Ryan's call. Buying is a decision to spend money; receiving is a record
    // that a box turned up, and it belongs to whoever opened the box.
    const s = { editRoles: ['manager'] };
    t.equal(a.editVerdict({ username: 'alexis' }, AM, s).allowed, false, 'cannot buy');
    t.equal(a.receiveVerdict({ username: 'alexis' }, AM).allowed, true, 'can still book in');
  });

  t.test('receiving ignores the Settings list entirely', () => {
    // Not "happens to pass today". Narrowing the buyer list must never be
    // able to stop the shop booking in a delivery, or receipts get entered
    // late by somebody else, or not at all.
    const wide = a.receiveVerdict({ username: 'alexis' }, AM);
    t.equal(a.receiveVerdict.length, 2, 'receiveVerdict should not even take settings');
    t.equal(wide.allowed, true);
  });

  t.test('read-only still means read-only for receiving', () => {
    t.equal(a.receiveVerdict({ username: 'v' }, VIEWER).allowed, false);
  });

  t.test('the receive route uses the wider gate, not the buyer gate', () => {
    t.assert(/canReceiveSession/.test(receiveRoute));
    t.equal(/canEditSession\(/.test(receiveRoute), false,
      'receiving must not ride on who can buy');
  });

  /* ---- one definition, two callers ------------------------------------- */

  t.test('the session gate is the pure function, not a second copy of it', () => {
    const src = read('lib/promopro/access.js');
    const fn = src.slice(src.indexOf('export async function canEditSession'));
    t.assert(/editVerdict\(/.test(fn.slice(0, 500)),
      'canEditSession should ask editVerdict rather than re-deciding');
    // The old inline rule, spelled out a second time, is what the readout
    // would silently drift away from.
    t.equal(/allowed\.includes\(String\(role\.name/.test(fn.slice(0, 500)), false);
  });

  t.test('the readout is built by the same function the routes gate on', () => {
    t.assert(/editVerdict/.test(settingsRoute));
    t.assert(/receiveVerdict/.test(settingsRoute));
    t.equal(/can_edit !== false \&\& .*editRoles/.test(settingsRoute), false,
      'no second copy of the rule on the reporting side');
  });

  /* ---- the readout ----------------------------------------------------- */

  t.test('somebody who cannot open the app is never reported as able to buy', () => {
    const block = settingsRoute.slice(settingsRoute.indexOf('settings.buyers'), settingsRoute.indexOf('settings.buyers') + 2500);
    t.assert(/canRaise: canOpen && raise\.allowed/.test(settingsRoute),
      'technically true and completely misleading on a screen used to remove people');
    t.assert(/Cannot open PromoPro at all/.test(settingsRoute), 'and it should say why');
  });

  t.test('a failed lookup reads as unknown, not as nobody', () => {
    // An empty table would say "nobody can raise a purchase order", which is
    // frightening and false on the screen opened to tighten access.
    t.assert(/settings\.buyers = null/.test(settingsRoute));
    t.assert(/S\.buyers === null \|\| S\.buyers === undefined/.test(app));
    const fn = app.slice(app.indexOf('function buyersHtml'), app.indexOf('function renderSettings'));
    t.assert(/could not be read/.test(fn));
  });

  t.test('the readout is admin only', () => {
    const fn = app.slice(app.indexOf('function buyersHtml'), app.indexOf('function renderSettings'));
    t.assert(/if \(!isAdmin\) return ''/.test(fn));
    t.assert(/if \(isAdmin\) \{/.test(settingsRoute), 'and gated on the server too, not just hidden');
  });

  t.test('the readout sends no more about a person than Accounts already shows', () => {
    const block = settingsRoute.slice(settingsRoute.indexOf('rows.push({'), settingsRoute.indexOf('settings.buyers = rows'));
    ['password', 'hash', 'email', 'last_login'].forEach((f) => {
      t.equal(new RegExp('\\b' + f + '\\b').test(block), false, 'the buyer row carries ' + f);
    });
  });

  t.test('it is a readout, not a second place to change access', () => {
    const fn = app.slice(app.indexOf('function buyersHtml'), app.indexOf('function renderSettings'));
    t.equal(/<input|<select|data-[a-z]*="/.test(fn), false,
      'two places to change one thing is how the two get out of step');
  });

  /* ---- the button that started all this -------------------------------- */

  t.test('the create buttons are hidden from people who cannot use them', () => {
    t.assert(/function applyPerms/.test(app));
    t.assert(/ppNewFromPipe'?, canEdit/.test(app) || /\['#ppNewFromPipe', canEdit\]/.test(app));
    t.assert(/\['#ppNewToggle', canEdit\]/.test(app));
    t.assert(/\['#ppNewVendor', canEdit\]/.test(app));
  });

  t.test('applyPerms runs on every render, not once at mount', () => {
    const fn = app.slice(app.indexOf('function renderAll'), app.indexOf('function renderAll') + 220);
    t.assert(/applyPerms\(\)/.test(fn));
  });

  t.test('the screen takes the server answer over the shell flag', () => {
    t.assert(/st\.settings\.youCanRaise === 'boolean'/.test(app),
      'the shell can_edit flag is not the rule the routes use');
    t.assert(/canEdit = st\.settings\.youCanRaise/.test(app));
    t.assert(/canReceive = st\.settings\.youCanReceive/.test(app));
  });

  t.test('a settings route that does not answer leaves yesterday behaviour', () => {
    // An old deploy without these keys must not hide every control. The
    // typeof check is what makes an absent field mean "unknown" rather than
    // false.
    t.assert(/typeof st\.settings\.youCanRaise === 'boolean'/.test(app));
    t.assert(/let canEdit = /.test(app), 'it has to be reassignable, with a real starting value');
  });

  t.test('receiving on screen is gated on its own flag', () => {
    t.assert(/const booking = canReceive &&/.test(app),
      'the delivery column must not disappear when somebody loses the ability to buy');
  });

  t.test('an outage in CrewCore does not decide who can buy', () => {
    // The two are unrelated, and reading undefined as false would hide every
    // control over a failure somewhere else entirely.
    const outage = settingsRoute.slice(settingsRoute.indexOf('rosterUnavailable'));
    t.assert(/youCanRaise/.test(outage.slice(0, 900)));
  });

  process.exit(t.report());
})();
