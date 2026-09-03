/**
 * Site Work / StickySituations tests (Aug 18, 2026; renamed Sep 2026).
 *
 * Site Work is a THIRD rail section, alongside Apps and Shared. It exists
 * because Notifications is the team's hand-off list and this is the list of
 * what still needs building in Alliteration itself. The first attempt put
 * these notes inside Notifications behind a private flag; mixing "fix the
 * ShopStock session bug" into the same list as "call this customer back" is
 * what made it unusable, so the two are separate by design and these tests
 * lock that separation in.
 *
 * The access rule is the important one: superuser only, enforced in the ROUTE
 * and not merely hidden from the rail.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

Promise.all([
  import(path.join(ROOT, 'lib/sitework/schema.js')),
  import(path.join(ROOT, 'js/registry.js')),
]).then(([schema, reg]) => {
  const { validateNew, validatePatch, COLORS, SIZES, STATUSES, keys, DEFAULT_COLOR,
          SIZE_LABELS, noteText, boardText } = schema;
  const { APPS, SITE_APPS, SHELL_APPS, canAccess, getApp } = reg;

  const APP_IDS = APPS.map((a) => a.id);

  /* ---- the files exist at all ------------------------------------------ */

  t.test('every Site Work file is present', () => {
    ['lib/sitework/schema.js', 'lib/sitework/store.js', 'api/sitework.js', 'apps/stickies.js']
      .forEach((p) => t.assert(exists(p), 'missing ' + p));
  });

  /* ---- registry: a third section, not a fourth Shared entry ------------ */

  t.test('SITE_APPS is its own export, separate from SHELL_APPS', () => {
    t.assert(Array.isArray(SITE_APPS), 'SITE_APPS must be exported as an array');
    t.equal(SITE_APPS.length, 1, 'Site Work holds exactly one screen today');
    t.equal(SITE_APPS[0].id, 'stickies', 'the screen id should be stickies');
    t.equal(SHELL_APPS.some((a) => a.id === 'stickies'), false,
      'Sticky Notes must NOT also be a Shared screen');
    t.equal(APPS.some((a) => a.id === 'stickies'), false,
      'Sticky Notes is not one of the apps');
  });

  t.test('the Site Work screen is reachable through getApp like any other', () => {
    const app = getApp('stickies');
    t.assert(app, 'getApp must resolve a Site Work screen');
    t.equal(app.defaultView, 'board', 'defaultView should be board');
    t.equal(app.siteLevel, true, 'the screen must be marked siteLevel');
  });

  /* ---- access: superuser only, and not by role ------------------------- */

  t.test('only a superuser can reach Sticky Notes', () => {
    t.equal(canAccess({ superuser: true }, 'stickies'), true,
      'a superuser must get in');
    t.equal(canAccess({ superuser: false, role: 'admin', tabs: ['backbone'] }, 'stickies'), false,
      'admin is not enough: this gates on the superuser flag alone');
    t.equal(canAccess({ tabs: ['stickies'] }, 'stickies'), false,
      'granting the id in a role must NOT open the section');
    t.equal(canAccess(null, 'stickies'), false, 'no perms means no access');
  });

  t.test('the Site Work check runs before the blanket app rules', () => {
    // A user with no app grants at all falls through to the legacy
    // "BackBone only" branch. Site Work must be decided before that.
    t.equal(canAccess({ tabs: [] }, 'stickies'), false,
      'the legacy BackBone fallback must not accidentally grant Site Work');
  });

  /* ---- schema ---------------------------------------------------------- */

  t.test('a note needs a title and nothing else', () => {
    const r = validateNew({ title: 'Fix the rail on mobile' }, APP_IDS);
    t.equal(r.ok, true, 'title alone should validate: ' + r.errors.join(', '));
    t.equal(r.record.detail, '', 'detail defaults to empty');
    t.equal(r.record.appId, '', 'a note need not be about an app');
    t.equal(r.record.color, DEFAULT_COLOR, 'colour falls back to the default');
    t.equal(r.record.size, 'unknown', 'size falls back to unknown');
  });

  t.test('a blank title is rejected', () => {
    t.equal(validateNew({ title: '   ' }, APP_IDS).ok, false, 'whitespace is not a title');
    t.equal(validateNew({}, APP_IDS).ok, false, 'a missing title is not a title');
  });

  t.test('an unknown app tag is rejected rather than silently kept', () => {
    const r = validateNew({ title: 'x', appId: 'notanapp' }, APP_IDS);
    t.equal(r.ok, false, 'a bogus app id must fail');
  });

  t.test('a real app tag is accepted', () => {
    const r = validateNew({ title: 'x', appId: 'shopstock' }, APP_IDS);
    t.equal(r.ok, true, 'shopstock is a real app: ' + r.errors.join(', '));
    t.equal(r.record.appId, 'shopstock', 'the tag should survive validation');
  });

  t.test('colour and size fall back instead of failing on create', () => {
    // A create with junk in an optional enum should still produce a note.
    // Losing the whole note over a bad colour would be the wrong trade.
    const r = validateNew({ title: 'x', color: 'chartreuse', size: 'enormous' }, APP_IDS);
    t.equal(r.ok, true, 'junk in an optional enum must not sink the note');
    t.equal(r.record.color, DEFAULT_COLOR, 'colour falls back');
    t.equal(r.record.size, 'unknown', 'size falls back');
  });

  t.test('a patch REJECTS a bad colour rather than falling back', () => {
    // Different from create on purpose: an explicit edit to an invalid value
    // is a bug worth surfacing, not a value worth guessing at.
    t.equal(validatePatch({ color: 'chartreuse' }, APP_IDS).ok, false, 'bad colour must fail a patch');
    t.equal(validatePatch({ size: 'enormous' }, APP_IDS).ok, false, 'bad size must fail a patch');
    t.equal(validatePatch({ status: 'maybe' }, APP_IDS).ok, false, 'bad status must fail a patch');
  });

  t.test('a patch can clear the app tag and the detail', () => {
    const r = validatePatch({ appId: '', detail: '' }, APP_IDS);
    t.equal(r.ok, true, 'clearing optional fields is legal: ' + r.errors.join(', '));
    t.equal(r.patch.appId, '', 'a blank app id is a real value, not an omission');
  });

  t.test('order must be a number', () => {
    t.equal(validatePatch({ order: 4 }, APP_IDS).ok, true, 'a number is fine');
    t.equal(validatePatch({ order: 'first' }, APP_IDS).ok, false, 'a word is not a position');
  });

  t.test('the enums are the ones the UI offers', () => {
    t.equal(COLORS.length, 5, 'five paper colours');
    t.equal(STATUSES.join(','), 'open,done', 'a note is done or it is not');
    t.equal(SIZES.includes('unknown'), true, '"no idea" must be an allowed size');
  });

  t.test('KV keys live under their own sitework_data prefix', () => {
    t.assert(keys.record('S-0001').startsWith('sitework_data:'), 'record key prefix is wrong');
    t.assert(keys.index().startsWith('sitework_data:'), 'index key prefix is wrong');
    t.assert(!keys.record('S-0001').includes('notifications_data'),
      'Site Work must not write into the Notifications keyspace');
  });

  /* ---- the route ------------------------------------------------------- */

  t.test('api/sitework.js fails closed before any method branch', () => {
    const src = read('api/sitework.js');
    t.assert(/requireAuth\(req, res\)/.test(src), 'the route must require a session');
    t.assert(/isBuilder/.test(src), 'the route needs an explicit superuser check');
    // Anchored on the CHECK, not on the wording of the 403. The message was
    // "Site Work is superuser only" until Aug 2026, when the flag was
    // renamed Admin in every user-facing string; a rewording of an error
    // message is not a security regression and should not read as one here.
    const gate = src.search(/if\s*\(\s*!\s*\(?\s*await\s+isBuilder|if\s*\(\s*!\s*isBuilder/);
    const firstMethod = src.indexOf('req.method === "GET"');
    t.assert(gate > 0 && firstMethod > gate,
      'the 403 must sit ABOVE the first method branch so a new method cannot ship ungated');
  });

  t.test('the route checks the superuser flag, not a role name', () => {
    const src = read('api/sitework.js');
    t.assert(/user\.superuser === true/.test(src),
      'access is the per-account superuser flag, matching js/registry.js');
  });

  t.test('the route allowlist matches the real registry app ids', () => {
    const src = read('api/sitework.js');
    const block = src.slice(src.indexOf('const APP_IDS = ['), src.indexOf('];', src.indexOf('const APP_IDS = [')));
    APP_IDS.forEach((id) =>
      t.assert(block.includes('"' + id + '"'),
        'api/sitework.js APP_IDS is missing ' + id + ' (it is hand-synced with js/registry.js)'));
  });

  t.test('bulk create and bulk reorder both exist', () => {
    const src = read('api/sitework.js');
    t.assert(/Array\.isArray\(body\.notes\)/.test(src),
      'twenty notes off a desk should go up in one call');
    t.assert(/Array\.isArray\(body\.order\)/.test(src),
      'one drag should be one write, not one write per card');
    t.assert(/100 notes at a time/.test(src), 'bulk create needs a ceiling');
  });

  /* ---- the seam -------------------------------------------------------- */

  t.test('js/api.js carries the sitework endpoint and marks it live', () => {
    const src = read('js/api.js');
    t.assert(/sitework:\s*'\/api\/sitework'/.test(src), 'ENDPOINTS.sitework is missing');
    t.assert(/'\/api\/sitework'/.test(src.slice(src.indexOf('LIVE_PREFIXES'), src.indexOf('ENDPOINTS'))),
      '/api/sitework must be listed in LIVE_PREFIXES or the panel reads mock data');
  });

  t.test('apps/stickies.js goes through the seam, never fetch()', () => {
    const src = read('apps/stickies.js');
    t.equal(/\bfetch\s*\(/.test(src), false, 'no app file may call fetch() directly');
    t.assert(/ctx\.api\.(get|post|patch|del)\(ENDPOINTS\.sitework/.test(src),
      'the panel must call the seam with ENDPOINTS.sitework');
  });

  /* ---- the rail -------------------------------------------------------- */

  t.test('js/shell.js renders Site Work as its own labelled section', () => {
    const src = read('js/shell.js');
    t.assert(/SITE_APPS/.test(src), 'shell must import SITE_APPS');
    t.assert(/rail-label">Site Work</.test(src), 'the rail needs a Site Work label');
    const shared = src.indexOf('rail-label">Shared<');
    const site = src.indexOf('rail-label">Site Work<');
    t.assert(shared > 0 && site > shared, 'Site Work should render after Shared, not inside it');
  });

  t.test('the whole section disappears for a non-superuser', () => {
    const src = read('js/shell.js');
    t.assert(/siteVisible\.length/.test(src),
      'the Site Work heading must be conditional, or most of the team sees an empty label');
  });

  /* ---- tokens ---------------------------------------------------------- */

  t.test('sticky paper colours live in tokens.css, not in the panel', () => {
    const tokens = read('css/tokens.css');
    t.assert(/--sticky-yellow:/.test(tokens), 'paper colours belong in tokens.css');
    t.assert(/body\[data-app="stickies"\]/.test(tokens), 'the section needs its own accent block');
    const panel = read('apps/stickies.js');
    t.assert(/var\(--sticky-yellow\)/.test(panel), 'the panel must reference the token, not a hex');
  });

  /* ---- the module contract --------------------------------------------- *
   * Aug 18: apps/stickies.js shipped with `html:` set to a template string.
   * app-host.js only ever calls app.html() as a function; the string form is
   * `template:`. It threw "app.html is not a function" four frames deep, the
   * shell's error heuristic read the bare TypeError as a missing file, and the
   * message blamed a deploy that was completely fine. Three separate holes,
   * all covered below. */

  t.test('EVERY app module uses the contract app-host actually supports', () => {
    const dir = path.join(ROOT, 'apps');
    fs.readdirSync(dir).filter((f) => f.endsWith('.js')).forEach((f) => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const stringHtml = /^\s*html:\s*[`'"]/m.test(src);
      t.equal(stringHtml, false,
        'apps/' + f + ' sets `html` to a string. app-host.js calls app.html() as a ' +
        'function; the string form is `template:`.');
    });
  });

  t.test('app-host says which contract was broken instead of throwing from four frames deep', () => {
    const src = read('js/app-host.js');
    t.assert(/typeof app\.html !== 'function'/.test(src),
      'a non-function html must be caught with a message naming the fix');
  });

  t.test('a module that loaded fine is never reported as a failed deploy', () => {
    const host = read('js/app-host.js');
    const shell = read('js/shell.js');
    t.assert(/err\.moduleLoadFailed = true/.test(host),
      'app-host must flag failures of the dynamic import itself');
    t.assert(/e\.moduleLoadFailed/.test(shell),
      'the shell must key "did not load" off that flag');
    t.equal(/e\.name === 'TypeError'/.test(shell), false,
      'a bare TypeError is not evidence of a missing file: that rule cost a debugging round');
  });

  /* ---- the separation from Notifications ------------------------------- */

  t.test('Sticky Notes stays out of the Notifications keyspace and route', () => {
    const panel = read('apps/stickies.js');
    t.equal(/ENDPOINTS\.notifications/.test(panel), false,
      'the panel must not read or write notifications');
    const route = read('api/sitework.js');
    t.equal(/notifications/i.test(route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false,
      'the route must not touch notifications outside its comments');
  });

  /* ---- the name ---------------------------------------------------------
   * Renamed from Sticky Notes to StickySituations, Sep 2026. The id stayed
   * `stickies`: it is in saved links, the KV keyspace and every test above.
   * Renaming the id would orphan every note on the board.
   * ---------------------------------------------------------------------- */

  t.test('the screen is called StickySituations and the id did not move', () => {
    t.equal(SITE_APPS[0].name, 'StickySituations', 'the rail label is the new name');
    t.equal(SITE_APPS[0].id, 'stickies', 'the id must NOT be renamed with the label');
    t.assert(/<h1>StickySituations<\/h1>/.test(read('apps/stickies.js')),
      'the panel heading should match the rail');
    t.assert(/StickySituations/.test(read('lib/help/content.js')),
      'the help bot must know the new name or it answers about a screen nobody has');
  });

  /* ---- copying a note out ---------------------------------------------- */

  t.test('a note copies as its title, its detail, then its tags', () => {
    const text = noteText({
      id: 'S-0005', title: 'Merged Printavo clients still show separately',
      detail: 'KBS, CRS and Kitchen Bath Solutions were merged in Printavo.',
      appId: 'backbone', size: 'medium', status: 'open',
    }, 'BackBone');

    const parts = text.split('\n\n');
    t.equal(parts.length, 3, 'title, detail and tail, blank line between each');
    t.equal(parts[0], 'Merged Printavo clients still show separately', 'the title leads');
    t.assert(/Kitchen Bath/.test(parts[1]), 'the detail comes second');
    t.assert(/BackBone/.test(parts[2]), 'the app tag is in the tail');
    t.assert(/Medium/.test(parts[2]), 'the size is spelled the way the board spells it');
    t.assert(/S-0005/.test(parts[2]), 'the id must survive the copy or a pasted note is unfindable');
  });

  t.test('a note with nothing but a title copies without blank padding', () => {
    const text = noteText({ id: 'S-0009', title: 'favicon', size: 'unknown', status: 'open' }, '');
    t.equal(text, 'favicon\n\nS-0009', 'no empty detail line, no app tag, no size');
  });

  t.test('a done note says so, an open one does not', () => {
    t.assert(/Done/.test(noteText({ id: 'S-1', title: 'x', status: 'done' }, '')),
      'a copied note should not read as still outstanding');
    t.equal(/Done/.test(noteText({ id: 'S-1', title: 'x', status: 'open' }, '')), false,
      'open is the normal case and needs no label');
  });

  t.test('noteText survives a half-built note rather than throwing', () => {
    t.equal(noteText(null, ''), '', 'null is empty text, not an exception');
    t.equal(noteText({}, ''), '', 'a note with no fields copies as nothing');
    t.equal(noteText({ title: 'x', size: 'nonsense' }, ''), 'x',
      'an unknown size is dropped, not printed raw');
  });

  t.test('several notes copy as one block with a divider between them', () => {
    const rows = [
      { id: 'S-1', title: 'one' },
      { id: 'S-2', title: 'two' },
    ];
    const text = boardText(rows, () => '');
    t.assert(text.indexOf('----') > 0, 'the notes need a divider or they read as one note');
    t.equal(text.split('----').length, 2, 'one divider between two notes, none trailing');
    t.equal(boardText([], () => ''), '', 'nothing showing copies as nothing');
  });

  /* ---- the drag no longer eats the selection ---------------------------- *
   * The whole card was draggable="true", which is why you could not drag over
   * the words on a note to select them: the browser starts a drag instead of a
   * selection. That is the bug behind "let me copy and paste a sticky".
   * ---------------------------------------------------------------------- */

  t.test('the card is not draggable until the grip says so', () => {
    const panel = read('apps/stickies.js');
    t.equal(/class="sk-note[^']*draggable="true"/.test(panel), false,
      'a permanently draggable card cannot have its text selected');
    t.assert(/draggable="false"/.test(panel), 'the card ships undraggable');
    t.assert(/data-grip=/.test(panel), 'there must be a grip to drag by');
    t.assert(/setAttribute\('draggable', 'true'\)/.test(panel),
      'the grip arms the drag');
    t.assert(/setAttribute\('draggable', 'false'\)/.test(panel),
      'and something must disarm it, or the card stays unselectable after one drag');
    t.assert(/dragstart/.test(panel), 'reordering must still work');
  });

  t.test('the clipboard has a fallback rather than failing silently', () => {
    const panel = read('apps/stickies.js');
    t.assert(/navigator\.clipboard/.test(panel), 'use the real clipboard API first');
    t.assert(/execCommand\('copy'\)/.test(panel),
      'and fall back, because the clipboard API is refused outside a secure context');
    t.assert(/Could not copy|would not let me/.test(panel),
      'a refused copy must say so: nothing happening looks like a broken button');
  });

  process.exit(t.report());
}).catch((e) => {
  console.error('sitework tests failed to load:', e);
  process.exit(1);
});
