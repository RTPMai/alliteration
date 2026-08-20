/**
 * MarketMachine.
 *
 * The rollup is where the real risk lives. Every other part of this app is a
 * form; the rollup produces numbers someone will use to decide whether to
 * spend money again. So the maths is called for real, not pattern-matched,
 * with particular attention to the three ways a total can lie:
 *
 *   - counting a skipped item as a zero,
 *   - counting a missing number as a zero,
 *   - mixing planned spend into actual spend.
 *
 * The link to MailMe is checked structurally: it must be ONE pointer, held by
 * MailMe, or the two apps drift.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

import('../lib/marketmachine/schema.js').then((m) => {

  const campaign = (channels, extra) => ({ name: 'X', channels, ...(extra || {}) });
  const item = (o) => m.newChannelItem(o);

  /* ---- the rollup ------------------------------------------------------ */

  t.test('a skipped channel is excluded entirely, not counted as a zero', () => {
    // THE point of having a skipped status. A postcard drop that never
    // happened should not drag an average down; it should not be in it.
    const withSkip = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', reach: 100, responses: 10, actualCost: 500 }),
      item({ type: 'event', status: 'skipped', reach: 0, responses: 0, actualCost: 0 }),
    ]));
    t.equal(withSkip.reach, 100, 'the skipped item contributes no reach');
    t.equal(withSkip.countedCount, 1, 'and is not counted as a channel that ran');
    t.equal(withSkip.skippedCount, 1, 'but is still reported as skipped');
    t.equal(withSkip.responseRate, 10, 'the rate is over what actually ran');
  });

  t.test('a planned channel contributes planned cost but no results', () => {
    // Otherwise a campaign that has not started yet reports a 0% response
    // rate, which reads as failure rather than as "not yet".
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'planned', plannedCost: 800, reach: 5000 }),
    ]));
    t.equal(r.plannedCost, 800, 'planned spend still shows');
    t.equal(r.actualCost, 0, 'nothing has been spent yet');
    t.equal(r.reach, 0, 'and nothing has been reached');
    t.equal(r.responseRate, null, 'no rate is claimed from a campaign that has not run');
  });

  t.test('planned spend is never substituted for actual spend', () => {
    // A total that mixes a quote with a receipt looks authoritative and is
    // half guess.
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', plannedCost: 1000, actualCost: 1250, reach: 10 }),
    ]));
    t.equal(r.plannedCost, 1000, 'planned stays planned');
    t.equal(r.actualCost, 1250, 'actual stays actual');
  });

  t.test('a missing number is reported as a gap, never folded in as zero', () => {
    // The failure this prevents: a campaign shows "$500 spent, 100 reached"
    // when in truth two of its three channels were never written down.
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', reach: 100, actualCost: 500 }),
      item({ type: 'event', status: 'done' }), // nothing entered
    ]));
    t.equal(r.reach, 100, 'only the known reach is counted');
    t.equal(r.missingReach, 1, 'the unknown one is reported');
    t.equal(r.missingCost, 1, 'so is the unknown cost');
    t.equal(r.complete, false, 'and the rollup says it is incomplete');
    t.equal(r.responseRate, null,
      'no response rate is offered over a partial reach: it would read as a real figure');
  });

  t.test('a complete rollup says so and offers its derived figures', () => {
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', reach: 1000, responses: 50, actualCost: 500 }),
    ]));
    t.equal(r.complete, true, 'nothing is missing');
    t.equal(r.responseRate, 5, '50 of 1000');
    t.equal(r.costPerResponse, 10, '$500 over 50 responses');
  });

  t.test('cost per response is withheld when any cost is unknown', () => {
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', reach: 100, responses: 10, actualCost: 500 }),
      item({ type: 'event', status: 'done', reach: 50, responses: 5 }), // no cost
    ]));
    t.equal(r.missingCost, 1, 'the gap is noticed');
    t.equal(r.costPerResponse, null,
      'a cost-per-response over partial spend understates the real figure');
  });

  /* ---- budget ---------------------------------------------------------- */

  t.test('an unset budget produces no remaining figure at all', () => {
    // "Over by NaN" and "over by your entire spend" are both worse than
    // saying nothing.
    const r = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', actualCost: 500, reach: 1 }),
    ]));
    t.equal(r.budgetRemaining, null, 'no budget means no remaining');
    t.equal(r.overBudget, false, 'and nothing can be over a budget that does not exist');
  });

  t.test('over budget is flagged against actual spend, not planned', () => {
    const over = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'done', plannedCost: 100, actualCost: 900, reach: 1 }),
    ], { budget: 500 }));
    t.equal(over.overBudget, true, 'spending 900 of a 500 budget is over');
    t.equal(over.budgetRemaining, -400, 'and the remaining figure goes negative rather than clamping');

    const under = m.rollup(campaign([
      item({ type: 'direct_mail', status: 'planned', plannedCost: 900 }),
    ], { budget: 500 }));
    t.equal(under.overBudget, false,
      'a plan to overspend is not an overspend: nothing has been paid yet');
  });

  /* ---- the delegated (email) channel ----------------------------------- */

  t.test('email numbers come from MailMe and are never hand-entered', () => {
    // Two sets of figures for one send would disagree, and the disagreement
    // would surface at the worst moment.
    const e = m.newChannelItem({
      type: 'email', status: 'done', reach: 999, responses: 99, actualCost: 50,
    });
    t.equal(e.reach, null, 'a hand-typed reach on an email channel is discarded');
    t.equal(e.responses, null, 'so are hand-typed responses');
    t.equal(e.actualCost, null, 'and a hand-typed cost');
  });

  t.test('an email channel with no linked send is a gap, not a zero', () => {
    // The item says it is in progress, so somebody expects numbers there.
    const r = m.rollup(campaign([
      item({ id: 'ch1', type: 'email', status: 'in_progress' }),
    ]), {});
    t.equal(r.reach, 0, 'nothing is invented');
    t.equal(r.missingReach, 1, 'and the absence is reported');
  });

  t.test('linked email stats roll into the campaign total', () => {
    const r = m.rollup(campaign([
      item({ id: 'ch1', type: 'email', status: 'done' }),
      item({ type: 'direct_mail', status: 'done', reach: 500, responses: 20, actualCost: 300 }),
    ]), { ch1: { reach: 1200, responses: 80 } });
    t.equal(r.reach, 1700, 'email reach adds to physical reach');
    t.equal(r.responses, 100, 'and so do its responses');
    t.equal(r.missingReach, 0, 'nothing is missing');
    t.equal(r.actualCost, 300,
      'email adds no cost: the provider bill is not attributable to one campaign');
  });

  /* ---- validation ------------------------------------------------------ */

  t.test('a campaign that ends before it starts is refused', () => {
    const bad = m.validateCampaignPatch({ name: 'X', startDate: '2026-09-01', endDate: '2026-08-01' });
    t.equal(bad.ok, false, 'the pair is rejected');
    t.assert(/before/.test(bad.errors.join(' ')), 'and the message says why');

    const ok = m.validateCampaignPatch({ name: 'X', startDate: '2026-08-01', endDate: '2026-09-01' });
    t.equal(ok.ok, true, 'the right way round passes');
  });

  t.test('a blank cost stays blank rather than becoming a real zero', () => {
    // Number("") is 0, which is finite and slips past a naive check. A blank
    // field would then make a campaign look free.
    const it = m.newChannelItem({ type: 'direct_mail', actualCost: '', plannedCost: null });
    t.equal(it.actualCost, null, 'an empty string is not a zero');
    t.equal(it.plannedCost, null, 'nor is null');

    const real = m.newChannelItem({ type: 'direct_mail', actualCost: 0 });
    t.equal(real.actualCost, 0, 'but a deliberate zero is kept: it is a real claim');
  });

  t.test('a patch only carries the fields it was given', () => {
    // A partial save must not blank a field by omitting it.
    const { patch } = m.validateCampaignPatch({ name: 'Renamed' });
    t.equal(patch.name, 'Renamed', 'the given field is present');
    t.equal(patch.budget, undefined, 'an absent field is absent, not null');
    t.equal(patch.status, undefined, 'and does not get a default that overwrites reality');
  });

  t.test('an unknown channel type is refused rather than silently coerced', () => {
    const bad = m.validateCampaignPatch({ channels: [{ type: 'telepathy' }] });
    t.equal(bad.ok, false, 'a made-up channel is rejected');
    t.assert(/telepathy/.test(bad.errors.join(' ')), 'and named in the error');
  });

  t.test('every channel Ryan asked for exists, and SMS does not', () => {
    ['email', 'direct_mail', 'social', 'paid_ads', 'event', 'phone'].forEach((k) => {
      t.assert(m.CHANNEL_KEYS.includes(k), 'missing channel: ' + k);
    });
    t.assert(!m.CHANNEL_KEYS.includes('sms'), 'SMS was deliberately not included');
    t.equal(m.isDelegated('email'), true, 'email is the delegated channel');
    t.equal(m.isDelegated('direct_mail'), false, 'nothing else is');
  });

  /* ---- the link to MailMe ---------------------------------------------- */

  t.test('the campaign pointer is stored in MailMe, and only there', () => {
    // ONE copy. MarketMachine keeping its own list of email ids would drift
    // the first time an email was deleted, and the drift shows up as reach
    // that never happened.
    const schema = read('lib/mailme/schema.js');
    t.assert(/marketingCampaignId/.test(schema),
      'MailMe campaigns must carry the pointer');
    t.assert(/marketingChannelId/.test(schema),
      'and the channel slot it counts toward');

    const store = read('lib/marketmachine/store.js');
    t.assert(/marketingCampaignId/.test(store),
      'MarketMachine must find its emails by reading that pointer');
    t.assert(!/emailIds|emailCampaignIds/.test(store),
      'MarketMachine must NOT keep its own list of email ids');
  });

  t.test('detaching an email clears the channel slot too', () => {
    // A slot id left pointing at a campaign the email no longer belongs to
    // makes the rollup count reach against a channel linked to nothing.
    const schema = read('lib/mailme/schema.js');
    t.assert(/patch\.marketingCampaignId === null\) patch\.marketingChannelId = null/.test(schema),
      'clearing the campaign must clear the channel');
  });

  t.test('email reach is delivered, not queued', () => {
    // A send that bounced half its list did not reach half its list, and
    // using the recipient count would overstate every rollup it appears in.
    const store = read('lib/marketmachine/store.js');
    t.assert(/stats\.delivered/.test(store), 'reach must come from delivered');
    t.assert(!/recipientCount/.test(store),
      'the queued count must not be used as reach');
  });

  t.test('opens are not counted as responses', () => {
    // Image-proxy prefetching inflates opens, so counting them as engagement
    // makes every campaign look better than it was.
    const store = read('lib/marketmachine/store.js');
    const fn = store.slice(store.indexOf('export async function resolveEmails'));
    const body = fn.slice(0, fn.indexOf('export async function campaignDetail'));
    t.assert(/uniqueClicks/.test(body) && /replies/.test(body),
      'clicks and replies are the response signals');
    t.assert(!/uniqueOpens/.test(body), 'opens must not be counted as responses');
  });

  t.test('MailMe being down never blocks the rest of a campaign', () => {
    // A marketing dashboard that goes blank because the email app hiccuped is
    // worse than one that says "email numbers unavailable".
    const store = read('lib/marketmachine/store.js');
    const fn = store.slice(store.indexOf('export async function resolveEmails'));
    t.assert(/unavailable: true/.test(fn.slice(0, 900)),
      'a failed MailMe read must degrade rather than throw');
    const app = read('apps/marketmachine.js');
    t.assert(/emails\.unavailable/.test(app),
      'and the app must say so rather than silently understating the totals');
  });

  t.test('MarketMachine being down never blocks sending email', () => {
    const app = read('apps/mailme.js');
    t.assert(/marketingDown/.test(app),
      'MailMe must tolerate MarketMachine being unreachable');
    const fn = app.slice(app.indexOf('async function loadMarketingCampaigns'));
    t.assert(/catch/.test(fn.slice(0, 600)),
      'the load must be soft: email sending cannot depend on the planner');
  });

  t.test('a standalone email is still allowed', () => {
    // Ryan asked for this explicitly. Forcing every send to belong to a
    // campaign would fill MarketMachine with single-email records that mean
    // nothing.
    const app = read('apps/mailme.js');
    t.assert(/Not part of a campaign/.test(app),
      'the composer must offer "no campaign" as a real choice');
    const schema = read('lib/mailme/schema.js');
    t.assert(/marketingCampaignId: null/.test(schema),
      'and it must be the default');
  });

  /* ---- wiring ---------------------------------------------------------- */

  t.test('the app is registered, themed and reachable through the seam', () => {
    t.assert(exists('apps/marketmachine.js'), 'the app file is missing');
    t.assert(exists('api/marketmachine/campaigns.js'), 'the campaigns route is missing');

    const reg = read('js/registry.js');
    const entry = reg.slice(reg.indexOf("id: 'marketmachine'"));
    const block = entry.slice(0, entry.indexOf('},'));
    ['campaigns', 'calendar', 'settings'].forEach((v) => {
      t.assert(block.includes("'" + v + "'"), 'the registry is missing the ' + v + ' view');
    });

    const api = read('js/api.js');
    t.assert(/mkCampaigns:\s*'\/api\/marketmachine\/campaigns'/.test(api),
      'ENDPOINTS.mkCampaigns is missing');
    t.assert(api.includes("'/api/marketmachine/"),
      'the route must be in LIVE_PREFIXES or the app runs on mock data');

    const tokens = read('css/tokens.css');
    t.assert(/data-app="marketmachine"/.test(tokens), 'the token block is missing');
    t.assert(/PROVISIONAL/.test(tokens.slice(tokens.indexOf('MarketMachine'), tokens.indexOf('data-app="marketmachine"'))),
      'the accent is a placeholder and must say so until the logo lineup confirms it');
  });

  t.test('hand-synced app id lists include the new app', () => {
    // Both of these are hand-maintained and have silently omitted new apps
    // before, which makes an app untaggable on a hand-off despite being in
    // the rail.
    ['api/sitework.js', 'api/notifications.js'].forEach((p) => {
      t.assert(/"marketmachine"/.test(read(p)), p + ' APP_IDS is missing marketmachine');
    });
  });

  t.test('deleting a campaign is admin only', () => {
    // It holds the spend record for work that actually happened, and it is
    // the only place that was written down.
    const src = read('api/marketmachine/campaigns.js');
    const fn = src.slice(src.indexOf('if (req.method === "DELETE")'));
    t.assert(/canDelete/.test(fn.slice(0, 500)), 'delete must be gated separately from edit');
  });

  t.test('BackBone reads the initiative list instead of hardcoding it', () => {
    // Closes the "replace these with the real Step Library names" item that
    // sat in BackBone since July.
    const main = read('apps/backbone/main.js');
    t.assert(/ENDPOINTS\.mkInitiatives/.test(main),
      'BackBone must fetch the shared list');
    t.assert(/FALLBACK/.test(main),
      'and keep its own list as a fallback, or a failed fetch empties the dropdown');
    t.assert(/loadMarketingInitiatives\(\)/.test(main), 'the loader must actually be called');
  });

  process.exit(t.report());
}).catch((e) => { console.error(e); process.exit(1); });
