// test/marketmachine-entries.test.cjs — dated performance rows.
//
// These call the real functions rather than matching source text, because the
// whole value of this feature is arithmetic and arithmetic is exactly the
// thing a regex cannot check.

const t = require('./harness.cjs');

(async () => {
  const metrics = await import('../lib/marketmachine/metrics.js');
  const entries = await import('../lib/marketmachine/entries.js');
  const schema = await import('../lib/marketmachine/schema.js');

  /* ---- missing is not zero --------------------------------------------- */

  t.test('a blank field survives as null all the way through', () => {
    // The single most important property here. A typed 0 and an untouched box
    // print the same width, so if blank ever becomes 0 the mistake is
    // invisible and every total that touches it is quietly wrong.
    const e = entries.newEntry({
      campaignId: 'MC-00001', channel: 'social',
      metrics: { spend: '', reach: 0, impressions: null },
    });
    t.equal(e.metrics.spend, null, 'an empty string is not a zero');
    t.equal(e.metrics.reach, 0, 'a real zero survives as a real zero');
    t.equal(e.metrics.impressions, null, 'null stays null');
  });

  t.test('a rate over a missing input is withheld, not zeroed', () => {
    const d = metrics.deriveMetrics({ destinationClicks: 40 }, {});
    t.equal(d.ctr, null, 'clicks with no impressions cannot make a CTR');
    const d2 = metrics.deriveMetrics({ destinationClicks: 0, impressions: 1000 }, {});
    t.equal(d2.ctr, 0, 'but a real zero click count makes a real 0%');
  });

  t.test('spend with nothing to divide by is not an infinite cost', () => {
    const d = metrics.deriveMetrics({ spend: 500 }, {});
    t.equal(d.costPerResult, null, 'no conversions means no cost per result');
    t.equal(d.roas, null, 'and no revenue means no ROAS');
  });

  /* ---- typed versus derived -------------------------------------------- */

  t.test('a derived field cannot be stored, even if something sends one', () => {
    // If a CTR can ever be written down, it can disagree with the numbers
    // underneath it, and then the app has two answers to one question.
    const r = entries.validateEntryPatch({
      campaignId: 'MC-1', metrics: { ctr: 4.2 },
    });
    t.equal(r.ok, false, 'a calculated name in the metrics block is refused');
    t.assert(/calculated/.test(r.errors.join(' ')), 'and says why');
  });

  t.test('derived values are absent from what gets stored', () => {
    const e = entries.newEntry({ campaignId: 'MC-1', channel: 'social', metrics: { reach: 10 } });
    metrics.DERIVED_KEYS.forEach((k) => {
      t.equal(e.metrics[k], undefined, k + ' must not have a storage slot');
    });
  });

  t.test('the engagement maths', () => {
    const d = metrics.deriveMetrics(
      { likes: 40, comments: 6, shares: 4, reach: 1000, impressions: 2500 }, {});
    t.equal(d.totalEngagements, 50, 'likes plus comments plus shares');
    t.equal(d.engagementRate, 5, '50 of 1000 reached is 5%');
    t.equal(d.frequency, 2.5, '2500 impressions over 1000 people');
  });

  t.test('a partial engagement total is totalled but not rated', () => {
    // Someone who entered likes and skipped the other two told us about
    // likes. Treating the blanks as zero would understate the total; refusing
    // to total at all would throw away the one real number.
    const d = metrics.deriveMetrics({ likes: 12, reach: 500 }, {});
    t.equal(d.totalEngagements, 12, 'what was reported is still totalled');
    t.equal(d.engagementRate, null, 'but the rate is withheld');
    t.equal(d._flags.engagementPartial, true, 'and the reason is flagged');
  });

  t.test('a response rate above 100 is refused rather than printed', () => {
    // You cannot answer more inquiries than you received. It means the two
    // figures cover different weeks, and printing it once gets it repeated in
    // a meeting.
    const d = metrics.deriveMetrics({ inboundInquiries: 10, responses24h: 14 }, {});
    t.equal(d.responseRate, null, 'not printed');
    t.equal(d._flags.responseRateImpossible, true, 'flagged instead');
    const ok = metrics.deriveMetrics({ inboundInquiries: 10, responses24h: 7 }, {});
    t.equal(ok.responseRate, 70, 'a real one still computes');
  });

  /* ---- revenue precedence ---------------------------------------------- */

  t.test('revenue precedence is fixed, and the source is always named', () => {
    const all = metrics.pickRevenue({
      platformRevenue: 9000, ga4Revenue: 6000, verifiedRevenue: 4000,
    });
    t.equal(all.value, 4000, 'verified wins even though it is the smallest');
    t.equal(all.source, 'verifiedRevenue', 'and says so');

    const noVerified = metrics.pickRevenue({ platformRevenue: 9000, ga4Revenue: 6000 });
    t.equal(noVerified.value, 6000, 'GA4 next');

    const platformOnly = metrics.pickRevenue({ platformRevenue: 9000 });
    t.equal(platformOnly.value, 9000, 'the platform claim last');

    t.equal(metrics.pickRevenue({}).value, null, 'and nothing at all is null');
  });

  t.test('a real zero revenue is not skipped over for the next source', () => {
    // Zero verified revenue is a finding. Falling through to the platform's
    // number because zero is falsy would replace a fact with a claim.
    const r = metrics.pickRevenue({ verifiedRevenue: 0, platformRevenue: 9000 });
    t.equal(r.value, 0, 'zero verified is still verified');
    t.equal(r.source, 'verifiedRevenue');
  });

  /* ---- channel-aware fields -------------------------------------------- */

  t.test('a trade show row is not asked for video views, or given them', () => {
    // Asking somebody logging a booth for impressions gets a zero typed in to
    // make the form go away, and that zero is then indistinguishable from a
    // real one.
    t.assert(!schema.channelMetrics('event').includes('videoViews'),
      'the field is not offered on events');
    const e = entries.newEntry({
      campaignId: 'MC-1', channel: 'event',
      metrics: { videoViews: 9000, reach: 40 },
    });
    t.equal(e.metrics.videoViews, null, 'and one sent anyway is not stored');
    t.equal(e.metrics.reach, 40, 'while the fields that do apply are kept');
  });

  t.test('one stored field, a different label per channel', () => {
    t.equal(schema.metricLabel('event', 'reach', 'Reach'), 'Booth conversations');
    t.equal(schema.metricLabel('direct_mail', 'reach', 'Reach'), 'Pieces delivered');
    t.equal(schema.metricLabel('social', 'reach', 'Reach'), 'Reach',
      'a channel without an override keeps the plain label');
  });

  t.test('email rows cannot be typed by hand', () => {
    const r = entries.validateEntryPatch({ campaignId: 'MC-1', channel: 'email' });
    t.equal(r.ok, false, 'refused');
    t.assert(/MailMe/.test(r.errors.join(' ')), 'and points at where the numbers live');
  });

  t.test('funding is a flag on placed media only', () => {
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'social' }).funding, 'organic');
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'social', funding: 'paid' }).funding, 'paid');
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'phone' }).funding, null,
      'a calling push is neither organic nor paid');
  });

  /* ---- totalling ------------------------------------------------------- */

  const rows = [
    entries.newEntry({ campaignId: 'MC-1', channel: 'social', creativeId: 'crA', platform: 'Facebook',
      funding: 'paid', startDate: '2026-08-01', endDate: '2026-08-07',
      metrics: { spend: 200, reach: 1000, impressions: 4000, destinationClicks: 100, inboundInquiries: 10 } }),
    entries.newEntry({ campaignId: 'MC-1', channel: 'social', creativeId: 'crB', platform: 'Facebook',
      funding: 'paid', startDate: '2026-08-08', endDate: '2026-08-14',
      metrics: { spend: 200, reach: 20000, impressions: 40000, destinationClicks: 400, inboundInquiries: 2 } }),
  ];

  t.test('rates are recalculated from the totals, never averaged', () => {
    // The reason this matters: averaging the two CTRs above gives 1.75%,
    // while the true combined figure is 1.1%. Averaging rates weights a tiny
    // sample the same as a huge one.
    const total = entries.totalEntries(rows);
    t.equal(total.metrics.destinationClicks, 500, 'clicks summed');
    t.equal(total.metrics.impressions, 44000, 'impressions summed');
    t.equal(total.derived.ctr, 1.1, 'then divided once');
  });

  t.test('a metric some rows report and others skip is named as partial', () => {
    const mixed = rows.concat([entries.newEntry({
      campaignId: 'MC-1', channel: 'social', metrics: { spend: 50 },
    })]);
    const total = entries.totalEntries(mixed);
    t.assert(total.partialMetrics.includes('reach'),
      'reach is missing from one row and the total says so');
    t.assert(!total.partialMetrics.includes('spend'),
      'spend is on every row, so it is not flagged');
  });

  t.test('a total with no rows reporting a field is null, not zero', () => {
    const total = entries.totalEntries([
      entries.newEntry({ campaignId: 'MC-1', channel: 'social', metrics: { reach: 5 } }),
    ]);
    t.equal(total.metrics.spend, null, 'nobody entered spend, so it is unknown');
    t.assert(total.metrics.spend !== 0, 'specifically NOT zero: that would read as free');
  });

  t.test('creative rollup sorts on inquiries, not on reach', () => {
    // Carousel B was seen twenty times as often and produced a fifth of the
    // inquiries. The point of comparing creatives is to surface exactly that,
    // so sorting on reach would put the wrong one first.
    const by = entries.totalsByCreative(rows, [
      { id: 'crA', name: 'Sample kit carousel' },
      { id: 'crB', name: 'Price led static' },
    ]);
    t.equal(by[0].name, 'Sample kit carousel', 'the one that produced inquiries leads');
    t.equal(by[0].metrics.inboundInquiries, 10);
  });

  t.test('a row pointing at a deleted creative is surfaced, not dropped', () => {
    const by = entries.totalsByCreative(rows, [{ id: 'crA', name: 'Sample kit carousel' }]);
    const orphan = by.find((r) => r.creativeId === 'crB');
    t.assert(orphan, 'the row still totals');
    t.equal(orphan.missing, true, 'and is marked so the screen can say why it has no name');
  });

  t.test('platform rollup splits organic from paid', () => {
    const mixed = rows.concat([entries.newEntry({
      campaignId: 'MC-1', channel: 'social', platform: 'Facebook', funding: 'organic',
      metrics: { spend: 0, reach: 300, inboundInquiries: 4 },
    })]);
    const fb = entries.totalsByPlatform(mixed).find((r) => r.platform === 'Facebook');
    t.equal(fb.paid.metrics.spend, 400, 'paid spend stays paid');
    t.equal(fb.organic.metrics.inboundInquiries, 4, 'organic results stay organic');
    t.equal(fb.metrics.inboundInquiries, 16, 'and the platform total covers both');
  });

  /* ---- rows versus the old lump ---------------------------------------- */

  t.test('dated rows supersede the single typed lump, never add to it', () => {
    // Both are somebody's account of the same work. Adding them would double
    // every dollar; the rows win because they carry dates and a creative.
    const campaign = {
      id: 'MC-1', budget: 1000,
      channels: [schema.newChannelItem({
        id: 'ch1', type: 'direct_mail', status: 'done',
        actualCost: 999, reach: 5, responses: 1,
      })],
    };
    const totals = { ch1: entries.totalEntries([entries.newEntry({
      campaignId: 'MC-1', channel: 'direct_mail',
      metrics: { spend: 300, reach: 2000, inboundInquiries: 25 },
    })]) };

    const withRows = schema.rollup(campaign, {}, totals);
    t.equal(withRows.actualCost, 300, 'the rows are the answer');
    t.equal(withRows.reach, 2000);
    t.equal(withRows.responses, 25);
    t.equal(withRows.fromRows, 1, 'and the rollup says how many channels are rowed');

    const withoutRows = schema.rollup(campaign, {}, {});
    t.equal(withoutRows.actualCost, 999, 'with no rows the old lump still counts');
    t.equal(withoutRows.fromRows, 0);
  });

  t.test('a rowed channel missing spend is a gap, not a free channel', () => {
    const campaign = {
      id: 'MC-1',
      channels: [schema.newChannelItem({ id: 'ch1', type: 'event', status: 'done' })],
    };
    const totals = { ch1: entries.totalEntries([entries.newEntry({
      campaignId: 'MC-1', channel: 'event', metrics: { reach: 40 },
    })]) };
    const r = schema.rollup(campaign, {}, totals);
    t.equal(r.missingCost, 1, 'counted as a gap');
    t.equal(r.actualCost, 0, 'and nothing invented to fill it');
    t.equal(r.complete, false, 'so the campaign is not reported as complete');
  });

  /* ---- the record shape survives its future ---------------------------- */

  t.test('revenue fields exist on every row before anything fills them', () => {
    // Declared now so that the day GA4 or Printavo is wired up the history
    // does not have a hole in it where the column did not exist yet.
    const e = entries.newEntry({ campaignId: 'MC-1', channel: 'social' });
    metrics.SOURCED_KEYS.forEach((k) => {
      t.assert(k in e.sourced, k + ' must be present in the record');
      t.equal(e.sourced[k], null, 'and empty until a source fills it');
    });
  });

  t.test('every row is stamped with where it came from', () => {
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'social' }).source, 'manual');
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'social', source: 'csv' }).source, 'csv');
    t.equal(entries.newEntry({ campaignId: 'MC-1', channel: 'social', source: 'nonsense' }).source,
      'manual', 'an unknown stamp falls back rather than storing a lie');
  });

  t.test('a row cannot exist without a campaign', () => {
    const r = entries.validateEntryPatch({ metrics: { spend: 10 } });
    t.equal(r.ok, true, 'campaignId absent from the patch is allowed on a PATCH');
    const create = entries.validateEntryPatch({ campaignId: '', metrics: { spend: 10 } });
    t.equal(create.ok, false, 'but an explicitly empty one is refused');
  });

  t.test('end before start is refused', () => {
    const r = entries.validateEntryPatch({
      campaignId: 'MC-1', startDate: '2026-08-10', endDate: '2026-08-01',
    });
    t.equal(r.ok, false, r.errors.join('; '));
  });

  t.report();
})();
