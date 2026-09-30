// PUT IN: test/marketmachine-platforms.test.cjs
/**
 * MarketMachine, Sep 29 2026 round: more than one Account Manager, platforms
 * and art on a Digital Platform campaign, and Printavo links pasted into a
 * step's Files and links.
 *
 * Ryan's screenshots from the Happy Holiday Helpers test run:
 *   - the Account Manager dropdown took one person
 *   - "Choose the audience, platforms, and schedule" could be ticked with no
 *     way to choose a platform, and the Art step had nowhere to put art
 *   - the owner read "Jacob and Jacob Whitman"
 *   - a pasted "printavo.com/invoices/24659535" did nothing
 *
 * Real function calls throughout. The route-level Printavo check runs the
 * real store against an in-memory stand-in for Upstash.
 */

const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const model = () => import(path.join(ROOT, 'lib/marketmachine/campaign.js'));
const tasks = () => import(path.join(ROOT, 'lib/marketmachine/tasks.js'));
const conn = () => import(path.join(ROOT, 'lib/marketmachine/connections.js'));
const art = () => import(path.join(ROOT, 'lib/marketmachine/art.js'));
const fmt = () => import(path.join(ROOT, 'apps/marketmachine/format.js'));

const RYAN = { username: 'ryan', name: 'Ryan Toney' };
const ABBY = { id: 'E1', name: 'Abby Penton' };
const JACOB = { id: 'E2', name: 'Jacob Whitman' };

(async () => {

/* ---- more than one Account Manager -------------------------------------- */

await t.test('a campaign can hold several Account Managers', async () => {
  const { buildCampaign, amsOf, amNames } = await model();
  const c = buildCampaign({ type: 'digital_platform', name: 'Happy Holiday Helpers', accountManagers: [ABBY, JACOB] }, RYAN);
  t.equal(amsOf(c).length, 2);
  t.equal(amNames(c), 'Abby Penton and Jacob Whitman');
  t.equal(c.accountManagerId, 'E1', 'the first one still fills the old single field');
});

await t.test('an old single-AM campaign reads the same as before', async () => {
  const { amsOf, amNames } = await model();
  const old = { accountManagerId: 'E1', accountManagerName: 'Abby Penton' };
  t.equal(amsOf(old).length, 1);
  t.equal(amNames(old), 'Abby Penton');
});

await t.test('editing the Account Managers replaces the list and logs it', async () => {
  const { buildCampaign, applyHeaderPatch, amNames } = await model();
  const c = { id: 'CP-1', ...buildCampaign({ type: 'digital_platform', name: 'x', accountManagers: [ABBY] }, RYAN) };
  const out = applyHeaderPatch(c, { accountManagers: [ABBY, JACOB] }, RYAN);
  t.assert(out.ok, out.errors.join(' '));
  t.equal(amNames(out.campaign), 'Abby Penton and Jacob Whitman');
  t.assert(out.campaign.history.some((h) => /Account Managers/.test(h.what)), 'not logged');
  const cleared = applyHeaderPatch(out.campaign, { accountManagers: [] }, RYAN);
  t.equal(cleared.campaign.accountManagerId, null);
});

await t.test('the same person ticked twice is kept once', async () => {
  const { amsOf } = await model();
  t.equal(amsOf({ accountManagers: [ABBY, ABBY, JACOB] }).length, 2);
});

await t.test('"Jacob and Account Manager" no longer reads "Jacob and Jacob Whitman"', async () => {
  const { ownerFor } = await model();
  const step = { owner: 'Jacob and Account Manager' };
  t.equal(ownerFor(step, { accountManagers: [JACOB] }), 'Jacob Whitman');
  t.equal(ownerFor(step, { accountManagers: [ABBY] }), 'Jacob and Abby Penton');
  t.equal(ownerFor(step, { accountManagers: [ABBY, JACOB] }), 'Abby Penton and Jacob Whitman');
  t.equal(ownerFor({ owner: 'Account Manager' }, { accountManagers: [ABBY, JACOB] }), 'Abby Penton and Jacob Whitman');
  t.equal(ownerFor({ owner: 'Ryan' }, { accountManagers: [ABBY] }), 'Ryan');
});

await t.test('every Account Manager on a campaign sees their AM steps in My tasks', async () => {
  const { buildCampaign } = await model();
  const { isMyStep } = await tasks();
  const c = { id: 'CP-1', ...buildCampaign({ type: 'digital_platform', name: 'x', accountManagers: [ABBY, JACOB] }, RYAN) };
  const amStep = c.steps.find((s) => s.owner === 'Account Manager');
  t.assert(amStep, 'precondition: an Account Manager step');
  t.assert(isMyStep(c, amStep, { name: 'Abby Penton', employeeId: 'E1' }), 'Abby missing her step');
  t.assert(isMyStep(c, amStep, { name: 'Jacob Whitman', employeeId: 'E2' }), 'second AM missing the step');
  t.assert(!isMyStep(c, amStep, { name: 'Hannah Posey', employeeId: 'E3' }), 'an AM not on it got the step');
});

await t.test('"mine" counts any of the Account Managers', async () => {
  const { isMine } = await model();
  t.assert(isMine({ accountManagers: [ABBY, JACOB] }, 'x', 'E2'));
  t.assert(!isMine({ accountManagers: [ABBY] }, 'x', 'E2'));
});

/* ---- platforms ---------------------------------------------------------- */

const dp = async () => {
  const { buildCampaign } = await model();
  return { id: 'CP-9', ...buildCampaign({ type: 'digital_platform', name: 'Happy Holiday Helpers', accountManagers: [ABBY] }, RYAN) };
};

await t.test('the platform step cannot be ticked with no platform chosen', async () => {
  const { applyStepPatch, applyHeaderPatch } = await model();
  const c = await dp();
  const refused = applyStepPatch(c, 'dp_audience', { done: true }, RYAN, '2026-09-29');
  t.assert(!refused.ok && /platform/i.test(refused.errors.join(' ')), 'ticked with nothing chosen');
  const picked = applyHeaderPatch(c, { platforms: ['email'] }, RYAN).campaign;
  t.assert(applyStepPatch(picked, 'dp_audience', { done: true }, RYAN, '2026-09-29').ok, 'still refused after picking');
});

await t.test('the rule reaches campaigns made before today', async () => {
  const { applyStepPatch } = await model();
  const c = await dp();
  c.steps.forEach((s) => { delete s.gate; }); // an old campaign carries no gate on its steps
  t.assert(!applyStepPatch(c, 'dp_audience', { done: true }, RYAN, '2026-09-29').ok, 'an old campaign skipped the rule');
});

await t.test('unknown platforms are ignored, known ones kept in catalog order', async () => {
  const { applyHeaderPatch, platformsOf } = await model();
  const c = await dp();
  const out = applyHeaderPatch(c, { platforms: ['email', 'myspace', 'facebook'] }, RYAN);
  t.equal(platformsOf(out.campaign).join(','), 'facebook,email');
});

await t.test('the Art step waits for art on every ticked platform', async () => {
  const { applyHeaderPatch, addArt, stepGate, platformsMissingArt } = await model();
  let c = applyHeaderPatch(await dp(), { platforms: ['facebook', 'email'] }, RYAN).campaign;
  t.assert(/Facebook, Email/.test(stepGate(c, 'dp_art')), stepGate(c, 'dp_art'));
  c = addArt(c, 'facebook', { url: 'https://blob.example/a.png', name: 'fb.png' }, RYAN).campaign;
  t.equal(platformsMissingArt(c).join(','), 'email');
  c = addArt(c, 'email', { url: 'https://dropbox.com/x', name: 'email art', link: true }, RYAN).campaign;
  t.equal(stepGate(c, 'dp_art'), '');
});

await t.test('art cannot go on a platform that is not ticked', async () => {
  const { addArt } = await model();
  const out = addArt(await dp(), 'tiktok', { url: 'https://blob.example/a.png' }, RYAN);
  t.assert(!out.ok && /TikTok/.test(out.errors.join(' ')));
});

await t.test('unticking a platform that still has art is refused', async () => {
  const { applyHeaderPatch, addArt } = await model();
  let c = applyHeaderPatch(await dp(), { platforms: ['facebook'] }, RYAN).campaign;
  c = addArt(c, 'facebook', { url: 'https://blob.example/a.png', name: 'fb.png' }, RYAN).campaign;
  const out = applyHeaderPatch(c, { platforms: [] }, RYAN);
  t.assert(!out.ok && /still has art/.test(out.errors.join(' ')), 'art was orphaned');
  const removed = applyHeaderPatch(c, { removeArt: 'https://blob.example/a.png' }, RYAN);
  t.assert(removed.ok && removed.campaign.art.length === 0, 'remove failed');
});

await t.test('a post link per platform is stored and cleared', async () => {
  const { applyHeaderPatch } = await model();
  const c = applyHeaderPatch(await dp(), { platformLink: { platform: 'facebook', url: 'https://facebook.com/p/1' } }, RYAN).campaign;
  t.equal(c.platformLinks.facebook, 'https://facebook.com/p/1');
  const cleared = applyHeaderPatch(c, { platformLink: { platform: 'facebook', url: '' } }, RYAN).campaign;
  t.equal(cleared.platformLinks.facebook, undefined);
  t.assert(!applyHeaderPatch(c, { platformLink: { platform: 'facebook', url: 'not a link' } }, RYAN).ok);
});

await t.test('other campaign types do not pick platforms', async () => {
  const { buildCampaign, usesPlatforms, stepGate } = await model();
  const c = buildCampaign({ type: 'try_on_day', name: 'x' }, RYAN);
  t.assert(!usesPlatforms(c));
  t.assert(c.steps.every((s) => stepGate(c, s.key) === ''), 'a gate leaked onto another type');
});

/* ---- art uploads -------------------------------------------------------- */

await t.test('art uploads take images, PDF and MP4 up to 3 MB', async () => {
  const { parseArtUpload, MAX_ART_BYTES } = await art();
  t.assert(parseArtUpload('data:image/png;base64,' + Buffer.from('png').toString('base64')).ok);
  t.assert(parseArtUpload('data:application/pdf;base64,' + Buffer.from('pdf').toString('base64')).ok);
  t.assert(!parseArtUpload('data:text/html;base64,' + Buffer.from('<x>').toString('base64')).ok, 'html accepted');
  const big = Buffer.alloc(MAX_ART_BYTES + 10).toString('base64');
  t.assert(/link/.test(parseArtUpload('data:image/png;base64,' + big).error), 'oversize does not point at the link option');
});

await t.test('art paths are per campaign and platform, with an unguessable name', async () => {
  const { artPath } = await art();
  const p = artPath('CP-00009', 'facebook', 'Holiday Post.PNG', 'image/png', 'abcdef0123456789abcd', '2026-09-29T12:00:00Z');
  t.equal(p, 'marketmachine/art/2026-09/CP-00009/facebook/abcdef0123456789abcd-holiday-post.png');
  let threw = false; try { artPath('x', 'y', 'z', 'image/png', 'short'); } catch (e) { threw = true; }
  t.assert(threw, 'a short random id was allowed');
});

/* ---- Files and links ---------------------------------------------------- */

await t.test('a link pasted without https:// is kept, and a name on the next line labels it', async () => {
  const { parseLinks } = await fmt();
  const rows = parseLinks('printavo.com/invoices/24659535\nmousepad');
  t.equal(rows.length, 1);
  t.equal(rows[0].url, 'https://printavo.com/invoices/24659535');
  t.equal(rows[0].label, 'mousepad');
  const two = parseLinks('Proof\nhttps://x.com/p\nwww.y.com');
  t.equal(two[0].label + '|' + two[0].url, 'Proof|https://x.com/p');
  t.equal(two[1].url, 'https://www.y.com');
});

await t.test('the server also accepts a link without https://', async () => {
  const { applyStepPatch } = await model();
  const c = await dp();
  const out = applyStepPatch(c, 'dp_audience', { links: [{ label: '', url: 'printavo.com/invoices/24659535' }] }, RYAN, '2026-09-29');
  t.equal(out.campaign.steps.find((s) => s.key === 'dp_audience').links[0].url, 'https://printavo.com/invoices/24659535');
});

await t.test('Printavo web addresses are recognized, other links are not', async () => {
  const { printavoRefFromUrl } = await conn();
  t.equal(JSON.stringify(printavoRefFromUrl('https://www.printavo.com/invoices/24659535')), '{"id":"24659535","kind":"invoice"}');
  t.equal(printavoRefFromUrl('https://www.printavo.com/quotes/66608/edit').kind, 'quote');
  t.equal(printavoRefFromUrl('https://dropbox.com/invoices/1'), null);
});

await t.test('a long Printavo id is looked up to find the invoice number', async () => {
  const { resolvePrintavoLinks } = await conn();
  const asked = [];
  const rows = await resolvePrintavoLinks([
    { url: 'https://printavo.com/invoices/24659535' },
    { url: 'https://printavo.com/invoices/66608' },
    { url: 'https://printavo.com/invoices/99999999' },
    { url: 'https://example.com' },
  ], async (id) => { asked.push(id); return id === '24659535' ? { invoice: { invoiceNumber: '66701', customerName: 'Hy-Vee' } } : { invoice: null }; });
  t.equal(asked.join(','), '24659535,99999999', 'a short number was sent to Printavo, or a non-Printavo link was');
  t.equal(rows[0].number, '66701');
  t.equal(rows[1].number, '66608');
  t.assert(!rows[2].number && rows[2].error, 'an unknown id was not reported');
});

await t.test('several slow links share one time budget', async () => {
  const { resolvePrintavoLinks } = await conn();
  const started = Date.now();
  const rows = await resolvePrintavoLinks([
    { url: 'https://printavo.com/invoices/11111111' },
    { url: 'https://printavo.com/invoices/22222222' },
    { url: 'https://printavo.com/invoices/33333333' },
  ], () => new Promise(() => {}), 80);
  t.assert(Date.now() - started < 400, 'lookups ran one after another');
  t.equal(rows.filter((r) => /too long/.test(r.error)).length, 3);
});

await t.test('art is refused before anything is stored', async () => {
  const { artRefusal, applyHeaderPatch } = await model();
  const c = await dp();
  t.assert(/Tick Facebook/.test(artRefusal(c, 'facebook')), 'unticked platform allowed');
  t.equal(artRefusal(applyHeaderPatch(c, { platforms: ['facebook'] }, RYAN).campaign, 'facebook'), '');
});

await t.test('Printavo being down costs the lookup, never the save', async () => {
  const { resolvePrintavoLinks } = await conn();
  const rows = await resolvePrintavoLinks([{ url: 'https://printavo.com/invoices/24659535' }],
    () => new Promise(() => {}), 50);
  t.assert(/too long/.test(rows[0].error), rows[0].error);
});

await t.test('saving a step with a Printavo link connects the invoice to the campaign', async () => {
  // Real store, in-memory Upstash.
  process.env.KV_REST_API_URL = 'https://kv.test';
  process.env.KV_REST_API_TOKEN = 'x';
  const mem = new Map();
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const key = decodeURIComponent(u.split('/').pop());
    if (u.includes('/get/')) return { ok: true, json: async () => ({ result: mem.has(key) ? mem.get(key) : null }) };
    if (u.includes('/set/')) { mem.set(key, opts.body); return { ok: true, json: async () => ({ result: 'OK' }) }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const store = await import(path.join(ROOT, 'lib/marketmachine/store.js'));
    const { buildCampaign } = await model();
    const c = { id: 'CP-00042', ...buildCampaign({ type: 'digital_platform', name: 'HHH' }, RYAN) };
    mem.set(store.mmKeys.campaign(c.id), JSON.stringify(c));
    const out = await store.updateStep(c.id, 'dp_audience',
      { links: [{ label: 'mousepad', url: 'https://printavo.com/invoices/24659535' }] }, RYAN, '2026-09-29',
      { printavoLookup: async () => ({ invoice: { invoiceNumber: '66701', customerName: 'Hy-Vee' } }) });
    t.assert(out.ok, (out.errors || []).join(' '));
    t.equal(out.printavo[0].connected, 'added');
    const saved = JSON.parse(mem.get(store.mmKeys.campaign(c.id)));
    t.equal(saved.links.invoices.map((e) => e.ref).join(','), '66701', 'invoice not connected');
    // Saving notes again does not ask Printavo again.
    let asked = 0;
    await store.updateStep(c.id, 'dp_audience', { notes: 'x', links: saved.steps.find((s) => s.key === 'dp_audience').links }, RYAN, '2026-09-29',
      { printavoLookup: async () => { asked += 1; return { invoice: null }; } });
    t.equal(asked, 0, 'an already-saved link was looked up again');
    // Printavo failing outright never costs the step its save.
    const out2 = await store.updateStep(c.id, 'dp_audience',
      { notes: 'kept', links: [{ label: '', url: 'https://printavo.com/invoices/77777777' }] }, RYAN, '2026-09-29',
      { printavoLookup: async () => { throw new Error('boom'); } });
    t.assert(out2.ok, 'save refused when Printavo failed');
    const saved2 = JSON.parse(mem.get(store.mmKeys.campaign(c.id)));
    t.equal(saved2.steps.find((s) => s.key === 'dp_audience').notes, 'kept');
    t.assert(/boom/.test(out2.printavo[0].error), 'failure not reported');
  } finally {
    global.fetch = realFetch;
  }
});

/* ---- the screen --------------------------------------------------------- */

await t.test('a Digital Platform campaign page renders platforms, art and the AM ticks', async () => {
  const written = {};
  const el = (id) => ({ id, hidden: false, set innerHTML(v) { written[id] = String(v); }, get innerHTML() { return written[id] || ''; },
    querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {}, focus() {}, value: '' });
  const nodes = {};
  const root = { querySelector: (sel) => (nodes[sel] = nodes[sel] || el(sel)), querySelectorAll: () => [],
    contains: () => true, addEventListener() {}, removeEventListener() {} };
  const { applyHeaderPatch, addArt } = await model();
  let c = applyHeaderPatch(await dp(), { platforms: ['facebook', 'email'], accountManagers: [ABBY, JACOB] }, RYAN).campaign;
  c = addArt(c, 'facebook', { url: 'https://blob.example/fb.png', name: 'fb.png' }, RYAN).campaign;
  const state = {
    campaigns: [], accountManagers: [ABBY, JACOB], today: '2026-09-29', filters: {}, pane: 'detail',
    openStep: null, stepMsg: {}, detailMsg: null, editingHeader: true, tl: {}, printavo: {}, connMsg: null,
    detail: { campaign: c, parent: null, children: [],
      connections: { scope: [], email: { count: 0, emails: [] }, travel: { trips: [] }, leads: { leads: [] }, invoices: { invoices: [] } },
      calculations: [], advisories: [], scorecard: [] },
  };
  const app = { state, api: {}, root, ui: {} };
  for (const name of ['shared', 'list', 'new', 'detail', 'connect', 'calc', 'timeline', 'settings', 'tasks']) {
    Object.assign(app.ui, (await import(path.join(ROOT, `apps/marketmachine/${name}.js`))).default(app));
  }
  app.ui.renderDetail();
  const page = written['#mkDetailPane'] || '';
  t.assert(page.includes('Platforms and art'), 'no platforms card');
  t.assert(/data-platform="facebook" checked/.test(page), 'facebook not shown ticked');
  t.assert(page.includes('fb.png'), 'art file not listed');
  t.assert(/Email<\/b>\s*<span class="late">Needs art/.test(page), 'missing art not flagged');
  t.assert(/id="mkHAms"/.test(page) && (page.match(/value="E[12]"[^>]*checked/g) || []).length === 2, 'AM ticks missing or unticked');
  t.assert(page.includes('Add art for Email first'), 'the Art step does not say why it is locked');
});

process.exit(t.report());
})().catch((e) => { console.error(e); process.exit(1); });
