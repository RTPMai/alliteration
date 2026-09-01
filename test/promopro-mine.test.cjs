// test/promopro-mine.test.cjs
/**
 * PromoPro "Just mine": filtering the two list screens down to the orders
 * the signed-in person is the account manager for.
 *
 * The join is the whole feature. A purchase order names its account manager
 * by CrewCore employee id; a signed-in account is a shell username. Nothing
 * on either record points at the other except the `username` field on the
 * roster, so identifyAccountManager() is where this can go wrong, and it is
 * called for real here rather than grepped.
 *
 * The failure that matters is not a filter that shows too little. It is a
 * filter that shows too little while claiming to be complete: an account
 * manager who presses Just mine, sees four orders, and never learns about the
 * fifth. Every check below is guarding that one outcome.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('apps/promopro.js');
const settingsRoute = read('api/promopro/settings.js');

const ROSTER = [
  { id: 'EMP-1', name: 'Alexis Davis', username: 'alexis', email: 'alexis@pmapparel.com', department: 'Sales' },
  { id: 'EMP-2', name: 'Hannah Posey', username: '', email: 'hannah@pmapparel.com', department: 'Sales' },
  { id: 'EMP-3', name: 'Jacob Whitman', username: 'jacob', email: 'jacob@pmapparel.com', department: 'Sales' },
  { id: 'EMP-4', name: 'Margo Niemeyer', username: 'margo', email: 'margo@pmapparel.com', department: 'Production' },
  { id: 'EMP-9', name: 'Abby Penton', username: 'abby', email: 'abby@pmapparel.com', department: 'Sales', status: 'inactive' },
];

const AM_IDS = ['EMP-1', 'EMP-2', 'EMP-3'];

(async () => {
  const am = await import('../lib/promopro/account-managers.js');
  const me = (account, roster, ids) =>
    am.identifyAccountManager(account, roster === undefined ? ROSTER : roster, ids === undefined ? AM_IDS : ids);

  /* ---- who is asking --------------------------------------------------- */

  t.test('the username on the roster record is what matches', () => {
    const found = me({ username: 'alexis', name: 'Alexis Davis' });
    t.assert(found, 'alexis should resolve');
    t.equal(found.id, 'EMP-1', 'wrong employee');
    t.equal(found.matchedBy, 'username', 'should have matched on the real link');
  });

  t.test('the username match ignores case and stray spaces', () => {
    const found = me({ username: '  ALEXIS ' });
    t.assert(found && found.id === 'EMP-1', 'a capitalised username is the same person');
  });

  t.test('an account never linked to a roster record falls back to the name', () => {
    // Hannah has no username on her CrewCore record. Plenty of shell accounts
    // predate CrewCore, and an account manager should not need a data fix
    // before a filter button appears.
    const found = me({ username: 'hannah', name: 'Hannah Posey' });
    t.assert(found, 'the name should have carried it');
    t.equal(found.id, 'EMP-2', 'wrong employee');
    t.equal(found.matchedBy, 'name', 'the fallback should say it was the fallback');
  });

  t.test('two people with the same name match nobody, rather than one of them', () => {
    const twins = ROSTER.concat([
      { id: 'EMP-7', name: 'Hannah Posey', username: '', email: 'hp@pmapparel.com' },
    ]);
    t.equal(me({ username: 'hposey', name: 'Hannah Posey' }, twins), null,
      'an ambiguous name is not a match, because guessing wrong hides orders');
  });

  t.test('an unknown account resolves to nothing at all', () => {
    t.equal(me({ username: 'nobody', name: 'Nobody At All' }), null);
    t.equal(me({}), null, 'a session with neither username nor name');
    t.equal(me(null), null);
    t.equal(me({ username: 'alexis' }, null), null, 'no roster means no answer');
  });

  t.test('an inactive employee is not matched', () => {
    // Same rule the account-manager picker uses. Somebody who has left should
    // not be resolvable as the person signed in.
    t.equal(me({ username: 'abby', name: 'Abby Penton' }), null);
  });

  t.test('an empty username does not match the records that have no username', () => {
    // The trap: "" === "" would make every unlinked employee a match for any
    // session without a username, and hand somebody another person's orders.
    const found = me({ username: '', name: '' });
    t.equal(found, null, 'blank must match nothing');
  });

  /* ---- account manager or not ----------------------------------------- */

  t.test('being on the Settings list is reported', () => {
    t.equal(me({ username: 'alexis' }).isAccountManager, true);
  });

  t.test('somebody off the list still resolves, flagged as not an account manager', () => {
    // Margo is on the roster but not an account manager. She resolves, so the
    // screen can still offer the filter if she happens to own an old order,
    // but the flag tells it not to offer one on the strength of the list.
    const found = me({ username: 'margo' });
    t.assert(found && found.id === 'EMP-4', 'margo should still resolve');
    t.equal(found.isAccountManager, false);
  });

  t.test('no allowed list means nobody is reported as an account manager', () => {
    t.equal(me({ username: 'alexis' }, ROSTER, []).isAccountManager, false);
    t.equal(me({ username: 'alexis' }, ROSTER, null).isAccountManager, false);
  });

  /* ---- the filter itself ---------------------------------------------- */

  // The browser's scoping rule, restated. It is three lines in apps/promopro.js
  // and cannot be imported (the file is a mounted app module), so the rule is
  // reproduced and checked here, and the source checks below confirm the app
  // is asking the same question.
  const isMine = (po, myId) => !!myId && po.accountManager === myId;

  const POS = [
    { id: 'a', accountManager: 'EMP-1' },
    { id: 'b', accountManager: 'EMP-3' },
    { id: 'c', accountManager: 'EMP-1' },
    { id: 'd', accountManager: null },
    { id: 'e' },
  ];

  t.test('scoping keeps every order with your id on it and no others', () => {
    const mine = POS.filter((p) => isMine(p, 'EMP-1')).map((p) => p.id);
    t.equal(mine.join(','), 'a,c');
  });

  t.test('an unassigned order belongs to nobody, not to everybody', () => {
    t.equal(POS.filter((p) => isMine(p, 'EMP-1')).some((p) => p.id === 'd'), false);
    t.equal(POS.filter((p) => isMine(p, 'EMP-1')).some((p) => p.id === 'e'), false);
  });

  t.test('an unresolved person scopes to nothing rather than to unassigned orders', () => {
    // The bug this guards: `p.accountManager === myId` with myId undefined
    // would match every order whose account manager is also missing.
    t.equal(POS.filter((p) => isMine(p, '')).length, 0);
    t.equal(POS.filter((p) => isMine(p, undefined)).length, 0);
  });

  /* ---- the wiring ------------------------------------------------------ */

  t.test('the settings route attaches the caller identity, resolved server side', () => {
    t.assert(/identifyAccountManager/.test(settingsRoute),
      'the browser cannot do this join itself');
    t.assert(/settings\.me\s*=/.test(settingsRoute));
    t.assert(/sess\.username/.test(settingsRoute),
      'it has to be the caller being identified, not an arbitrary name');
  });

  t.test('a roster outage still answers with the same shape', () => {
    // rosterUnavailable returns early. Without an explicit null there, `me`
    // would simply be absent, which the screen reads identically but which
    // says nothing about whether it was considered.
    const outage = settingsRoute.slice(settingsRoute.indexOf('rosterUnavailable'));
    t.assert(/settings\.me\s*=\s*null/.test(outage.slice(0, 400)),
      'the outage branch should say me is null');
  });

  t.test('the settings route sends only the caller own id and name', () => {
    // identifyAccountManager returns four fields and none of them is pay,
    // review or anything else CrewCore is gated for.
    const found = me({ username: 'alexis' });
    t.equal(Object.keys(found).sort().join(','), 'id,isAccountManager,matchedBy,name');
  });

  t.test('the filter is offered only when the person actually resolves', () => {
    const fn = app.slice(app.indexOf('function canScopeToMine'), app.indexOf('const isMine'));
    t.assert(/if \(!id\) return false/.test(fn),
      'an unresolved account must not be shown a filter that matches nothing');
  });

  t.test('somebody taken off the Settings list can still see their own history', () => {
    const fn = app.slice(app.indexOf('function canScopeToMine'), app.indexOf('const isMine'));
    t.assert(/st\.pos\.some/.test(fn),
      'owning an order should be enough, whatever the current list says');
  });

  t.test('the pill counts are taken from the scoped set, not the whole shop', () => {
    const fn = app.slice(app.indexOf('function renderFilters'), app.indexOf('function visiblePos'));
    t.assert(/const rows = scoped\(\)/.test(fn), 'counts must start from scoped()');
    t.assert(!/st\.pos\.filter/.test(fn),
      '"Open 12" above four rows is a number answering a question nobody asked');
  });

  t.test('stage and owner stack instead of replacing each other', () => {
    const fn = app.slice(app.indexOf('function visiblePos'), app.indexOf('function renderOrders'));
    t.assert(/scoped\(\)/.test(fn), 'the stage filter should run over the scoped set');
    t.assert(!/st\.pos\b/.test(fn), '"my late orders" has to be reachable');
  });

  t.test('both list screens say when what is shown is only part of the list', () => {
    const orders = app.slice(app.indexOf('function renderOrders'));
    t.assert(/are yours/.test(orders.slice(0, 1200)),
      'the orders subtitle should say the list is scoped');
    const pipe = app.slice(app.indexOf('function renderPipeline'), app.indexOf('function renderFilters'));
    t.assert(/yours only|Your open purchase orders/.test(pipe),
      'the pipeline subtitle should say the list is scoped');
  });

  t.test('an empty scoped list says which filter emptied it', () => {
    const orders = app.slice(app.indexOf('function renderOrders'));
    t.assert(/turn off Just mine/.test(orders.slice(0, 1600)),
      '"nothing here" with no reason is how somebody concludes they have no orders');
  });

  t.test('the choice sticks between visits and is per person, not shop-wide', () => {
    t.assert(/promopro\.mine/.test(app), 'a localStorage key, like the dashboard layout');
    t.assert(/localStorage\.setItem\(MINE_KEY/.test(app));
    t.assert(!/ppSettings.*mine|mine.*ENDPOINTS\.ppSettings/.test(app),
      'a view preference is not a shop setting');
  });

  t.test('toggling redraws both screens, so they cannot disagree', () => {
    const handler = app.slice(app.indexOf("t.dataset.mine"));
    const block = handler.slice(0, 300);
    t.assert(/renderOrders\(\)/.test(block) && /renderPipeline\(\)/.test(block));
  });

  process.exit(t.report());
})();
