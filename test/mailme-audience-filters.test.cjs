// PUT IN: test/mailme-audience-filters.test.cjs
/**
 * MailMe Audience: industry and tier filters, top-client sorting (Oct 1 2026).
 *
 * Ryan wanted to sort and filter a list by industry and by top clients. One
 * filter function serves the roster and a list's members, so these are real
 * calls to it, to the sort, and to the rule a saved list runs.
 */

const path = require('path');
const t = require('./harness.cjs');
const ROOT = path.join(__dirname, '..');
const load = () => import(path.join(ROOT, 'lib/mailme/schema.js'));

const PEOPLE = [
  { id: 'client:1', source: 'client', company_name: 'Acme', email: 'a@a.com', industry: 'Healthcare', tier: 'Gold', lifetimeRevenue: 50000, ytdRevenue: 1000, status: 'subscribed' },
  { id: 'client:2', source: 'client', company_name: 'Bolt', email: 'b@b.com', industry: 'Church', tier: 'Platinum', lifetimeRevenue: 90000, ytdRevenue: 30000, status: 'subscribed' },
  { id: 'client:3', source: 'client', company_name: 'Cog', email: 'c@c.com', industry: '', tier: 'Bronze', lifetimeRevenue: 3000, ytdRevenue: 0, status: 'unsubscribed' },
  { id: 'prospect:1', source: 'prospect', company_name: 'Dot', email: 'd@d.com', industry: '', tier: undefined, status: 'subscribed' },
  { id: 'client:4', source: 'client', company_name: 'Echo', email: 'e@e.com', industry: 'healthcare', tier: 'Silver', lifetimeRevenue: 20000, ytdRevenue: 9000, status: 'subscribed' },
];
const ids = (rows) => rows.map((r) => r.id).join(',');

(async () => {
  const s = await load();

  await t.test('industry filter ignores case and can find the blanks', () => {
    t.equal(ids(s.filterContacts(PEOPLE, { industry: 'Healthcare' })), 'client:1,client:4');
    t.equal(ids(s.filterContacts(PEOPLE, { industry: '(none)' })), 'client:3,prospect:1');
  });

  await t.test('tier filter, including "no tier" for leads and prospects', () => {
    t.equal(ids(s.filterContacts(PEOPLE, { tier: 'Gold' })), 'client:1');
    t.equal(ids(s.filterContacts(PEOPLE, { tier: '(none)' })), 'prospect:1');
  });

  await t.test('filters stack, and "all" means no filter', () => {
    t.equal(ids(s.filterContacts(PEOPLE, { industry: 'healthcare', status: 'mailable', tier: 'all' })), 'client:1,client:4');
    t.equal(s.filterContacts(PEOPLE, {}).length, PEOPLE.length);
  });

  await t.test('search also matches industry', () => {
    t.equal(ids(s.filterContacts(PEOPLE, { q: 'church' })), 'client:2');
  });

  await t.test('top clients: lifetime revenue high to low, as numbers not text', () => {
    // As text, "9000" would beat "50000". Numbers, not strings.
    t.equal(ids(s.sortContacts(PEOPLE, 'lifetimeRevenue', 'desc')).split(',').slice(0, 4).join(','),
      'client:2,client:1,client:4,client:3');
    t.equal(s.sortContacts(PEOPLE, 'lifetimeRevenue', 'desc').pop().id, 'prospect:1', 'no revenue sorts last');
  });

  await t.test('this year: ytd revenue high to low', () => {
    t.equal(s.sortContacts(PEOPLE, 'ytdRevenue', 'desc')[0].id, 'client:2');
    t.equal(s.sortContacts(PEOPLE, 'ytdRevenue', 'desc')[1].id, 'client:4');
  });

  await t.test('tier sorts by rank, not alphabet, and untiered go last', () => {
    t.equal(ids(s.sortContacts(PEOPLE, 'tier', 'asc')), 'client:2,client:1,client:4,client:3,prospect:1');
  });

  await t.test('facets count industries case-insensitively and list tiers best first', () => {
    const f = s.facetCounts(PEOPLE);
    const hc = f.industries.find((i) => i.value.toLowerCase() === 'healthcare');
    t.equal(hc.n, 2);
    t.equal(f.industries[0].value.toLowerCase(), 'healthcare', 'most common first');
    t.equal(f.clientsWithoutIndustry, 1, 'only clients count as missing an industry');
    t.equal(f.tiers.map((x) => x.value).join(','), 'Platinum,Gold,Silver,Bronze');
  });

  await t.test('a saved rule can be "Gold and Platinum in Healthcare" and keeps working', () => {
    const v = s.validateListPatch({ name: 'x', kind: 'dynamic', rule: { industries: ['Healthcare'], tiers: ['Gold', 'Platinum', 'Shiny'] } });
    t.equal(v.patch.rule.tiers.join(','), 'Gold,Platinum', 'unknown tiers are dropped');
    const list = { kind: 'dynamic', rule: v.patch.rule };
    t.equal(ids(s.resolveList(list, PEOPLE)), 'client:1');
  });

  await t.test('an old rule with no industry or tier is unchanged', () => {
    t.equal(s.resolveList({ kind: 'dynamic', rule: { source: 'client' } }, PEOPLE).length, 4);
  });

  process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
