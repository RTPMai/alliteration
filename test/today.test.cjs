// PUT IN: test/today.test.cjs
/**
 * Today, the landing screen (Sep 24 2026).
 *
 * Logic half: lib/today/build.js called for real, one block per source.
 * Wiring half: the shell lands on Today, All apps moved to #/hub, and the
 * screen only asks for endpoints that exist. Text checks are fair there,
 * because the question is "is it wired", not "does it compute".
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const load = () => import(path.join(ROOT, 'lib/today/build.js'));

const TODAY = '2026-09-24';
const DAY = 86400000;
const NOW = Date.parse(TODAY + 'T15:00:00Z');

(async () => {
  const L = await load();

  /* ---- buckets ------------------------------------------------------- */

  await t.test('due dates land in the right bucket', () => {
    t.equal(L.bucketFor('2026-09-23', TODAY), 'late');
    t.equal(L.bucketFor('2026-09-24', TODAY), 'today');
    t.equal(L.bucketFor('2026-09-25', TODAY), 'week');
    t.equal(L.bucketFor('2026-10-01', TODAY), 'week', 'seven days out is still this week');
    t.equal(L.bucketFor('2026-10-02', TODAY), 'open');
    t.equal(L.bucketFor(null, TODAY), 'open', 'no date is never urgent');
    t.equal(L.bucketFor('2026-09-24T18:00:00Z', TODAY), 'today', 'a timestamp is read by its day');
  });

  await t.test('names match the way BackBone’s My leads does, without short names claiming everyone', () => {
    t.assert(L.namesMatch('Alexis Davis', 'alexis davis'));
    t.assert(L.namesMatch('Alexis Davis', 'Alexis'));
    t.assert(!L.namesMatch('Alexis Davis', 'Hannah Posey'));
    t.assert(!L.namesMatch('Alexis Davis', 'Al'), 'two letters must not match by containment');
    t.assert(!L.namesMatch('', 'Alexis'));
  });

  /* ---- notifications ------------------------------------------------- */

  await t.test('notifications: only mine, only open, and a sleeping reminder stays asleep', () => {
    const list = [
      { id: 'a', title: 'Mine', assignedTo: 'Alexis', status: 'open', dueDate: '2026-09-22' },
      { id: 'b', title: 'Done', assignedTo: 'alexis', status: 'done' },
      { id: 'c', title: 'Someone else', assignedTo: 'hannah', status: 'open' },
      { id: 'd', title: 'Asleep', assignedTo: 'alexis', status: 'open', types: ['reminder'], triggerDate: '2026-09-30' },
      { id: 'e', title: 'Awake', assignedTo: 'alexis', status: 'open', types: ['reminder'], triggerDate: '2026-09-24' },
    ];
    const out = L.notificationItems(list, 'alexis', TODAY);
    t.equal(out.map((x) => x.notificationId).join(','), 'a,e');
    t.equal(out[0].bucket, 'late');
    t.equal(out[0].route.app, 'notifications', 'no link opens the inbox');
    t.equal(out[0].notificationId, 'a', 'carries the id the Done button needs');
  });

  await t.test('a linked notification opens the record, through the shared link table', () => {
    const out = L.notificationItems([
      { id: 'p', title: 'Chase the PO', assignedTo: 'alexis', createdBy: 'jacob', createdByName: 'Jacob',
        link: { type: 'po', id: 'po_26-1', label: '26-1' } },
    ], 'alexis', TODAY);
    t.equal(JSON.stringify(out[0].route), JSON.stringify({ app: 'promopro', view: 'orders', param: 'po_26-1' }));
    t.assert(out[0].detail.includes('From Jacob'), 'says who asked');
  });

  /* ---- PromoPro ------------------------------------------------------ */

  const vendors = [{ id: 'v1', name: 'SanMar' }];
  const settings = { chaseAfterDays: 3, me: { id: 'e2' }, meUsername: 'alexis' };
  const pos = [
    { id: 'red-mine', poNumber: '1', vendorId: 'v1', accountManager: 'e2', submittedAt: '2026-09-10' },
    { id: 'amber-mine', poNumber: '2', vendorId: 'v1', accountManager: 'e2', submittedAt: '2026-09-20' },
    { id: 'ok-mine', poNumber: '3', vendorId: 'v1', accountManager: 'e2', submittedAt: '2026-09-23' },
    { id: 'red-other', poNumber: '4', vendorId: 'v1', accountManager: 'e9', submittedAt: '2026-09-10' },
    { id: 'owner-only', poNumber: '5', vendorId: 'v1', owner: 'Alexis', submittedAt: '2026-09-10' },
    { id: 'received', poNumber: '6', vendorId: 'v1', accountManager: 'e2', submittedAt: '2026-09-01', receivedAt: '2026-09-05' },
    { id: 'cancelled', poNumber: '7', vendorId: 'v1', accountManager: 'e2', submittedAt: '2026-09-01', cancelledAt: '2026-09-02' },
  ];

  await t.test('PromoPro: my red and amber orders, nobody else’s, nothing finished', () => {
    const r = L.poItems(pos, vendors, settings, TODAY);
    t.equal(r.mine.map((x) => x.route.param).sort().join(','), 'amber-mine,owner-only,red-mine');
    t.equal(r.mine.find((x) => x.route.param === 'red-mine').bucket, 'late');
    t.equal(r.mine.find((x) => x.route.param === 'amber-mine').bucket, 'today');
    t.equal(r.shopRed, 3, 'the shop count is everyone’s red orders, finished and cancelled excluded');
  });

  await t.test('PromoPro: somebody PromoPro does not know as an AM gets no orders', () => {
    const r = L.poItems(pos, vendors, { chaseAfterDays: 3, me: null, meUsername: 'megan' }, TODAY);
    t.equal(r.mine.length, 0);
    t.equal(r.shopRed, 3);
  });

  await t.test('PromoPro: the shop’s chase setting is honoured, not a hardcoded 3', () => {
    const r = L.poItems(pos, vendors, { chaseAfterDays: 30, me: { id: 'e2' }, meUsername: 'alexis' }, TODAY);
    t.equal(r.mine.length, 0, 'with a 30 day chase setting nothing here is late yet');
  });

  /* ---- BackBone inquiries ------------------------------------------- */

  await t.test('inquiries: only ones with my name written on them, past their clock or due a call', () => {
    const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
    const leads = [
      { lead_id: 'stalled', company_name: 'Ankeny FFA', status: 'Assigned', account_manager: 'Alexis Davis', status_history: [{ status: 'Assigned', at: iso(4) }] },
      { lead_id: 'fresh', company_name: 'Fresh', status: 'Assigned', account_manager: 'Alexis Davis', status_history: [{ status: 'Assigned', at: iso(0.5) }] },
      { lead_id: 'reach', company_name: 'Grimes Rotary', status: 'Reach Back Out', account_manager: 'Alexis Davis', reach_back_at: iso(1) },
      { lead_id: 'later', company_name: 'Later', status: 'Reach Back Out', account_manager: 'Alexis Davis', reach_back_at: new Date(NOW + 5 * DAY).toISOString() },
      { lead_id: 'other', company_name: 'Other', status: 'Assigned', account_manager: 'Hannah Posey', status_history: [{ status: 'Assigned', at: iso(9) }] },
      { lead_id: 'guessed', company_name: 'Guessed', status: 'Assigned', industry: 'Schools', status_history: [{ status: 'Assigned', at: iso(9) }] },
      { lead_id: 'archived', company_name: 'Gone', status: 'Assigned', account_manager: 'Alexis Davis', archived_at: iso(1), status_history: [{ status: 'Assigned', at: iso(9) }] },
    ];
    const out = L.inquiryItems(leads, 'Alexis Davis', NOW);
    t.equal(out.map((x) => x.route.param).join(','), 'stalled,reach');
    t.equal(out[0].bucket, 'late');
    t.assert(/Assigned for 4 days/.test(out[0].detail), 'says how long: ' + out[0].detail);
    t.equal(out[1].bucket, 'today');
  });

  /* ---- time off ------------------------------------------------------ */

  await t.test('time off: only for approvers, only pending, late once the day has come', () => {
    const requests = [
      { id: 'r1', status: 'pending', employee_name: 'Amanda', start_date: '2026-09-28', end_date: '2026-09-29' },
      { id: 'r2', status: 'pending', employee_name: 'Sasha', start_date: '2026-09-24' },
      { id: 'r3', status: 'approved', employee_name: 'Hannah', start_date: '2026-09-25' },
    ];
    t.equal(L.timeoffItems({ me: { is_approver: false, is_admin: true }, requests }, TODAY).length, 0,
      'a CrewCore admin who is not an approver is not asked');
    const out = L.timeoffItems({ me: { is_approver: true }, requests }, TODAY);
    t.equal(out.map((x) => x.route.param).join(','), 'r1,r2');
    t.equal(out[0].bucket, 'today');
    t.equal(out[1].bucket, 'late');
    t.equal(out[0].route.view, 'timeoff');
  });

  /* ---- MarketMachine / ConControl ------------------------------------ */

  await t.test('campaign steps waiting on somebody else are left off', () => {
    const out = L.taskItems([
      { campaignId: 'c1', campaignName: 'Gifting', key: 'a', label: 'A', due: '2026-09-20', overdue: true },
      { campaignId: 'c1', campaignName: 'Gifting', key: 'b', label: 'B', due: '2026-09-26' },
      { campaignId: 'c1', campaignName: 'Gifting', key: 'c', label: 'C', waitingOn: 'B' },
    ], TODAY);
    t.equal(out.map((x) => x.title).join(','), 'A,B');
    t.equal(out[0].bucket, 'late');
    t.equal(out[1].bucket, 'week');
  });

  await t.test('social blockers become decisions and posts', () => {
    const out = L.socialItems([
      { kind: 'decision', id: 'D1', question: 'Paid ads?', needed_by: '2026-09-24' },
      { kind: 'post-overdue', id: 'P1', title: 'Speaker #2', date: '2026-09-23' },
      { kind: 'post-no-copy', id: 'P2', title: 'Early bird', date: '2026-09-27' },
    ], TODAY);
    t.equal(out[0].title, 'Decide: Paid ads?');
    t.equal(out[0].bucket, 'today');
    t.equal(out[1].bucket, 'late');
    t.equal(out[2].detail, 'Still needs copy');
  });

  /* ---- grouping ------------------------------------------------------ */

  await t.test('one record, one row: the notification wins and keeps the worse bucket', () => {
    const note = { id: 'n:1', notificationId: '1', bucket: 'open', due: null, title: 'Call back', route: { app: 'backbone', view: 'inquiries', param: 'L-1' } };
    const inq = { id: 'inq:L-1', bucket: 'late', due: null, title: 'Ankeny', route: { app: 'backbone', view: 'inquiries', param: 'L-1' } };
    const other = { id: 'inq:L-2', bucket: 'today', due: null, title: 'Grimes', route: { app: 'backbone', view: 'inquiries', param: 'L-2' } };
    const out = L.dedupeItems([inq, note, other]);
    t.equal(out.map((x) => x.id).join(','), 'n:1,inq:L-2');
    t.equal(out[0].bucket, 'late');
  });

  await t.test('groups hold soonest first, undated last', () => {
    const g = L.groupItems([
      { id: '1', bucket: 'late', due: '2026-09-20', title: 'b' },
      { id: '2', bucket: 'late', due: '2026-09-10', title: 'a' },
      { id: '3', bucket: 'late', due: null, title: 'c' },
      { id: '4', bucket: 'nonsense', due: null, title: 'd' },
    ]);
    t.equal(g.late.map((x) => x.id).join(','), '2,1,3');
    t.equal(g.open.map((x) => x.id).join(','), '4', 'an unknown bucket still shows up somewhere');
    t.equal(Object.keys(g).join(','), L.BUCKET_KEYS.join(','));
  });

  await t.test('greeting and first name', () => {
    t.equal(L.greetingFor(7), 'Good morning');
    t.equal(L.greetingFor(13), 'Good afternoon');
    t.equal(L.greetingFor(19), 'Good evening');
    t.equal(L.firstName('Alexis Davis', 'alexis'), 'Alexis');
    t.equal(L.firstName('', 'megan'), 'Megan');
  });

  /* ---- wiring -------------------------------------------------------- */

  await t.test('the shell lands on Today and keeps All apps one click away', () => {
    const shell = read('js/shell.js');
    t.assert(/const HOME = 'today'/.test(shell), 'HOME should be today');
    t.assert(/!appId \|\| SHELL_PAGES\.includes\(appId\)/.test(shell), 'a bare route should be a shell page');
    t.assert(/const page = appId \|\| HOME/.test(shell), 'a bare route should be Today');
    t.assert(/data-app="\$\{HOME\}"/.test(shell) && /data-app="\$\{HUB\}"/.test(shell), 'both Today and All apps in the rail');
    t.assert(/router\.go\(HOME, null\)/.test(shell), 'the logo goes to Today');
    t.assert(/goApp: \(a, v, p\) => router\.go\(a, v, \{ param/.test(shell), 'Today can open one record');
    const router = read('js/router.js');
    t.assert(/app === 'today' \|\| !app/.test(router), 'Today lives at bare #/');
    t.assert(!/app === 'hub' \|\| !app/.test(router), 'All apps no longer claims #/');
  });

  await t.test('Today only asks for endpoints that exist', async () => {
    const { ENDPOINTS } = await import(path.join(ROOT, 'js/api.js'));
    const src = read('apps/today.js');
    const used = [...new Set([...src.matchAll(/ENDPOINTS\.(\w+)/g)].map((m) => m[1]))];
    t.assert(used.length >= 8, 'expected the screen to use its sources, found ' + used.join(','));
    used.forEach((k) => t.assert(!!ENDPOINTS[k], 'ENDPOINTS.' + k + ' does not exist'));
  });

  await t.test('Today is on the health check list', () => {
    const h = read('api/health.js');
    t.assert(h.includes('"apps/today.js"') && h.includes('"lib/today/build.js"'));
  });

  process.exit(t.report());
})();
