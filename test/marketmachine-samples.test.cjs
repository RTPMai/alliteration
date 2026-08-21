// test/marketmachine-samples.test.cjs
/**
 * MarketMachine sample campaigns.
 *
 * Sample data is the one kind of fixture that ships to production, so it gets
 * checked the same way real input does: every campaign is pushed through the
 * real validateCampaignPatch, every row through the real newEntry, and the
 * rollup is called for real. A sample that fails validation would be created
 * with its fields silently dropped and nobody would notice until the screen
 * looked wrong.
 *
 * The rollup checks are the point of the whole exercise. Each one pins a
 * behaviour the samples exist to demonstrate, so if the maths ever changes,
 * the demonstration fails loudly instead of quietly demonstrating the wrong
 * thing.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

Promise.all([
  import('../lib/marketmachine/samples.js'),
  import('../lib/marketmachine/schema.js'),
  import('../lib/marketmachine/entries.js'),
]).then(([s, m, e]) => {

  const byKey = (k) => s.SAMPLE_CAMPAIGNS.find((c) => c.key === k);

  /* ---- the set itself --------------------------------------------------- */

  t.test('there are five samples', () => {
    t.equal(s.SAMPLE_CAMPAIGNS.length, 5, 'sample count');
  });

  t.test('every sample has a unique key and a unique name', () => {
    const keys = new Set(s.SAMPLE_CAMPAIGNS.map((c) => c.key));
    const names = new Set(s.SAMPLE_CAMPAIGNS.map((c) => c.name));
    t.equal(keys.size, 5, 'unique keys');
    t.equal(names.size, 5, 'unique names');
  });

  t.test('every name carries the SAMPLE prefix, so nothing reads as real', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      t.assert(c.name.startsWith(s.SAMPLE_PREFIX), `${c.key} is not prefixed`);
    });
  });

  t.test('isSample matches on the flag, not only the name', () => {
    t.assert(s.isSample({ sample: true, name: 'Renamed by somebody' }), 'flag ignored');
    t.assert(s.isSample({ name: s.SAMPLE_PREFIX + 'x' }), 'prefix ignored');
    t.assert(!s.isSample({ name: 'Fall Sports Team Stores 2026' }), 'real campaign matched');
    t.assert(!s.isSample(null), 'null matched');
  });

  t.test('the four statuses that carry meaning are all represented', () => {
    const seen = new Set(s.SAMPLE_CAMPAIGNS.map((c) => c.status));
    ['planning', 'active', 'complete'].forEach((st) => {
      t.assert(seen.has(st), `no sample is ${st}`);
    });
  });

  /* ---- validation, through the real validator --------------------------- */

  t.test('every sample passes validateCampaignPatch clean', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      const { key, ...patch } = c;
      const r = m.validateCampaignPatch(patch);
      t.assert(r.ok, `${key}: ${r.errors.join('; ')}`);
    });
  });

  t.test('no sample survives validation with fields dropped', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      const { key, ...patch } = c;
      const { patch: out } = m.validateCampaignPatch(patch);
      t.equal(out.name, c.name, `${key} name`);
      t.equal(out.status, c.status, `${key} status`);
      t.equal(out.budget, c.budget, `${key} budget`);
      t.equal((out.channels || []).length, c.channels.length, `${key} channel count`);
    });
  });

  t.test('every channel item keeps the id the rows point at', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      c.channels.forEach((ch) => {
        t.equal(m.newChannelItem(ch).id, ch.id, `${c.key}/${ch.name} lost its id`);
      });
    });
  });

  t.test('every creative keeps its id too', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      (c.creatives || []).forEach((cr) => {
        t.equal(m.newCreative(cr).id, cr.id, `${c.key}/${cr.name} lost its id`);
      });
    });
  });

  t.test('start dates never fall after end dates', () => {
    s.SAMPLE_CAMPAIGNS.forEach((c) => {
      t.assert(c.startDate < c.endDate, `${c.key} ends before it starts`);
    });
  });

  /* ---- the rows --------------------------------------------------------- */

  t.test('every row points at a channel item that exists on its campaign', () => {
    Object.keys(s.SAMPLE_ENTRIES).forEach((key) => {
      const campaign = byKey(key);
      t.assert(campaign, `rows for unknown campaign ${key}`);
      const ids = new Set(campaign.channels.map((ch) => ch.id));
      s.SAMPLE_ENTRIES[key].forEach((row) => {
        t.assert(ids.has(row.channelItemId), `${key}: orphan row ${row.channelItemId}`);
      });
    });
  });

  t.test('every row points at a creative that exists on its campaign', () => {
    Object.keys(s.SAMPLE_ENTRIES).forEach((key) => {
      const ids = new Set((byKey(key).creatives || []).map((cr) => cr.id));
      s.SAMPLE_ENTRIES[key].forEach((row) => {
        if (!row.creativeId) return;
        t.assert(ids.has(row.creativeId), `${key}: unknown creative ${row.creativeId}`);
      });
    });
  });

  t.test('no row carries a metric its channel does not use', () => {
    Object.keys(s.SAMPLE_ENTRIES).forEach((key) => {
      s.SAMPLE_ENTRIES[key].forEach((row) => {
        const allowed = m.channelMetrics(row.channel);
        Object.keys(row.metrics || {}).forEach((metric) => {
          t.assert(allowed.includes(metric), `${key}: ${row.channel} cannot carry ${metric}`);
        });
      });
    });
  });

  t.test('rows survive newEntry with their numbers intact', () => {
    Object.keys(s.SAMPLE_ENTRIES).forEach((key) => {
      s.SAMPLE_ENTRIES[key].forEach((row) => {
        const saved = e.newEntry({ ...row, campaignId: 'MC-00001' });
        Object.keys(row.metrics).forEach((metric) => {
          t.equal(saved.metrics[metric], row.metrics[metric], `${key}/${metric}`);
        });
        t.equal(saved.channelItemId, row.channelItemId, `${key} channelItemId`);
        t.equal(saved.creativeId, row.creativeId, `${key} creativeId`);
      });
    });
  });

  t.test('sampleEntriesFor stamps the campaign id and invents no flag', () => {
    const rows = s.sampleEntriesFor('fall-sports', 'MC-00042');
    t.equal(rows.length, 3, 'row count');
    rows.forEach((r) => t.equal(r.campaignId, 'MC-00042', 'campaignId'));
    t.equal(rows[0].sample, undefined, 'rows should carry no sample flag');
  });

  t.test('sampleCampaignPatches strips the key and adds no flag the store drops', () => {
    const patches = s.sampleCampaignPatches();
    t.equal(patches.length, 5, 'patch count');
    patches.forEach((p) => {
      t.equal(p.patch.key, undefined, 'key leaked into the patch');
      t.equal(p.patch.sample, undefined, 'sample flag would be dropped by newCampaign');
    });
  });

  /* ---- what the samples exist to demonstrate ---------------------------- */

  const rollupOf = (key, emails, rowTotals) => {
    const { key: _k, ...patch } = byKey(key);
    const { patch: clean } = m.validateCampaignPatch(patch);
    return m.rollup({ ...clean, budget: patch.budget }, emails || {}, rowTotals || {});
  };

  t.test('SAMPLE 4: a skipped postcard is excluded, not counted as zero reach', () => {
    const r = rollupOf('reorder');
    t.equal(r.skippedCount, 1, 'skipped count');
    t.equal(r.countedCount, 1, 'only the call round should count');
    // The skipped item's planned cost stays on the record, because it was
    // really planned. Its actual never existed and must not appear as 0.
    t.equal(r.plannedCost, 500, 'planned cost');
    t.equal(r.actualCost, 0, 'actual cost');
    t.equal(r.reach, 40, 'reach');
  });

  t.test('SAMPLE 2: the missing pieces figure is a gap, not a zero', () => {
    const r = rollupOf('dental');
    t.assert(r.missingReach >= 1, 'the mailer gap is not being reported');
    // 140 calls, plus whatever social reports. The mailer contributes nothing
    // rather than a zero that would be indistinguishable from a real one.
    t.assert(r.reach >= 140, 'reach lost the call round');
  });

  t.test('SAMPLE 3: actual spend exceeds budget and the two stay apart', () => {
    const r = rollupOf('expo');
    t.equal(r.plannedCost, 6900, 'planned');
    t.equal(r.actualCost, 7275, 'actual');
    t.assert(r.actualCost > byKey('expo').budget, 'the overrun is not visible');
  });

  t.test('SAMPLE 5: a planning campaign has costs and no results', () => {
    const r = rollupOf('flyover');
    t.equal(r.countedCount, 0, 'nothing should count yet');
    t.equal(r.plannedCost, 2500, 'planned cost');
    t.equal(r.actualCost, 0, 'actual cost');
    t.equal(r.reach, 0, 'reach');
  });

  t.test('SAMPLE 1: dated rows beat the lump on the social item', () => {
    // What the store would hand rollup() once the rows are in.
    const rows = { 'smp-fs-social': { rowCount: 3, metrics: { reach: 11200, spend: 500, inboundInquiries: 13 } } };
    const withRows = rollupOf('fall-sports', {}, rows);
    const withoutRows = rollupOf('fall-sports', {}, {});
    // Without rows the social item has no typed numbers at all, so it reads
    // as a gap. With rows it contributes. That difference is the feature.
    t.assert(withRows.reach > withoutRows.reach, 'rows did not feed the rollup');
    t.equal(withRows.reach, 1850 + 11200, 'postcard lump plus social rows');
    t.equal(withRows.actualCost, 980 + 500, 'postcard lump plus social spend');
  });

  t.test('SAMPLE 1: the carousel outperforms the static in the raw rows', () => {
    const rows = s.SAMPLE_ENTRIES['fall-sports'];
    const clicks = (creative) => rows
      .filter((r) => r.creativeId === creative)
      .reduce((n, r) => n + r.metrics.destinationClicks, 0);
    t.assert(clicks('smp-cr-carousel') > clicks('smp-cr-static') * 2,
      'the creative comparison the sample exists to show is not in the numbers');
  });

  /* ---- the route -------------------------------------------------------- */

  t.test('the route is superuser gated and never trusts the rail', () => {
    const src = read('api/marketmachine/samples.js');
    t.assert(/requireAuth/.test(src), 'no auth check');
    t.assert(/superuser === true/.test(src), 'no superuser check');
  });

  t.test('load refuses to run twice', () => {
    const src = read('api/marketmachine/samples.js');
    t.assert(/409/.test(src), 'a second load should be refused, not duplicated');
  });

  t.test('clear empties the per-campaign rows key as well as the campaign', () => {
    const src = read('api/marketmachine/samples.js');
    t.assert(/mmKeys\.entries/.test(src), 'rows would be orphaned under their own key');
  });

  t.test('lib/marketmachine/samples.js imports nothing from api/', () => {
    const src = read('lib/marketmachine/samples.js');
    t.assert(!/from\s+["'][^"']*api\//.test(src), 'lib must not import from api');
  });

  process.exit(t.report());
});
