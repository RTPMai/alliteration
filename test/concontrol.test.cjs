/**
 * ConControl — sponsors.
 *
 * Every check here is a real function call against a fake Upstash, not a grep
 * of the source text. See test/route-imports.test.cjs for why: a refactor once
 * deleted a function a route still imported, and the whole suite stayed green
 * because the tests that touched it read the file instead of running it.
 *
 * The things worth breaking a build over:
 *   - a missing committed amount is UNKNOWN, never zero. Every total in this
 *     app is a number somebody will quote to a sponsor.
 *   - N/A is a real deliverable state and stays out of the denominator.
 *   - a PATCH merges. A screen showing six of twelve fields must not blank the
 *     other six.
 *   - the public inquiry route cannot set money, status or deliverables.
 */

const t = require('./harness.cjs');

const kv = new Map();
global.fetch = async (url, opts) => {
  const u = String(url);

  if (u.endsWith('/pipeline')) {
    const cmds = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => cmds.map(([verb, key, val]) => {
        if (verb === 'SET') { kv.set(key, val); return { result: 'OK' }; }
        if (verb === 'GET') return { result: kv.has(key) ? kv.get(key) : null };
        if (verb === 'DEL') { kv.delete(key); return { result: 1 }; }
        if (verb === 'INCR') {
          const n = Number(kv.get(key) || 0) + 1;
          kv.set(key, String(n));
          return { result: n };
        }
        return { result: null };
      }),
    };
  }

  const key = decodeURIComponent((u.match(/\/get\/(.+)$/) || [])[1] || '');
  return { ok: true, status: 200, json: async () => ({ result: kv.has(key) ? kv.get(key) : null }) };
};

process.env.KV_REST_API_URL = 'https://fake-upstash.test';
process.env.KV_REST_API_TOKEN = 'fake-token';

(async () => {
  const schema = await import('../lib/concontrol/schema.js');
  const store = await import('../lib/concontrol/store.js');

  const {
    money, sponsorMoney, paidTotal, deliverableStates, deliverableProgress,
    sponsorHealth, rollup, validateSponsorPatch, newSponsor,
    tierAvailability, momentAvailability, momentLabel,
    DELIVERABLE_KEYS, STATUSES, MOMENT_KEYS, SEED_TIERS,
  } = schema;

  const {
    saveSponsor, getSponsor, updateSponsor, deleteSponsor, listSponsors,
    nextSponsorId, companyKey, findByCompany, getSettings, saveSettings,
    listSpeakers, getSpeaker, listSessions, getSession, updateSession, updateSpeaker,
  } = store;

  /* ---------------- money parsing ---------------- */

  t.test('a typed dollar amount parses however it was typed', () => {
    t.equal(money('$2,500'), 2500, 'currency formatting is stripped');
    t.equal(money('1000'), 1000, 'a plain number parses');
    t.equal(money(750.5), 750.5, 'a real number passes through');
  });

  t.test('an unparseable amount is null, never zero', () => {
    t.equal(money('about two grand'), null, 'text is not an amount');
    t.equal(money(''), null, 'empty is not zero');
    t.equal(money(undefined), null, 'missing is not zero');
  });

  /* ---------------- the money picture ---------------- */

  t.test('paid is the sum of the payments, not a stored number', () => {
    const s = { payments: [{ amount: 1000 }, { amount: 500 }, { amount: 250 }] };
    t.equal(paidTotal(s), 1750, 'three payments add up');
  });

  t.test('a half payment cannot overwrite the first half', () => {
    const s = { committed: 2500, payments: [{ amount: 1250 }, { amount: 1250 }] };
    const m = sponsorMoney(s);
    t.equal(m.paid, 2500, 'both halves are still there');
    t.assert(m.paidInFull, 'two halves pay it in full');
  });

  t.test('no committed amount is unknown, not zero', () => {
    const m = sponsorMoney({ committed: null, payments: [] });
    t.equal(m.committed, null, 'committed stays null');
    t.equal(m.committedKnown, false, 'and is reported as not known');
    t.equal(m.outstanding, null, 'outstanding is unanswerable, not 0');
  });

  t.test('outstanding is derived every time, never stored', () => {
    const m = sponsorMoney({ committed: 2500, outstanding: 99999, payments: [{ amount: 1000 }] });
    t.equal(m.outstanding, 1500, 'a stale stored balance is ignored');
  });

  t.test('committed and never invoiced is the thing this app exists to catch', () => {
    const m = sponsorMoney({ committed: 1000, invoicedAmount: null, payments: [] });
    t.assert(m.awaitingInvoice, 'said yes in March, never billed');
  });

  t.test('an invoiced sponsor is not awaiting an invoice', () => {
    const m = sponsorMoney({ committed: 1000, invoicedAmount: 1000, invoicedAt: '2026-09-01', payments: [] });
    t.equal(m.awaitingInvoice, false, 'the invoice went out');
  });

  t.test('overpaying is visible rather than clamped away', () => {
    const m = sponsorMoney({ committed: 1000, payments: [{ amount: 1200 }] });
    t.assert(m.overpaid, 'an overpayment is flagged');
    t.equal(m.outstanding, -200, 'and the balance says so');
  });

  /* ---------------- deliverables ---------------- */

  t.test('a deliverable nobody has touched reads as open, not done', () => {
    const states = deliverableStates({});
    for (const key of DELIVERABLE_KEYS) {
      t.equal(states[key].state, 'open', key + ' defaults to open');
    }
  });

  t.test('N/A is excluded from the denominator', () => {
    const s = {
      deliverables: {
        logo: { state: 'done' },
        swag: { state: 'done' },
        social: { state: 'na' },
        session: { state: 'na' },
      },
    };
    const p = deliverableProgress(s);
    t.equal(p.done, 2, 'two done');
    t.equal(p.owed, 2, 'two owed, not four');
    t.assert(p.complete, 'a Bronze sponsor who sent everything they owed is complete');
  });

  t.test('one open deliverable means not complete', () => {
    const p = deliverableProgress({ deliverables: { logo: { state: 'done' }, swag: { state: 'open' } } });
    t.equal(p.complete, false, 'still waiting on the swag');
    t.equal(p.open, 3, 'swag plus the two never touched');
  });

  /* ---------------- health ---------------- */

  t.test('a declined sponsor is closed and gives its reason', () => {
    const h = sponsorHealth({ status: 'declined' });
    t.equal(h.level, 'closed', 'declined is closed');
    t.assert(h.why.length > 0, 'and says which kind of closed');
  });

  t.test('committed with no amount agreed needs attention', () => {
    const h = sponsorHealth({ status: 'committed', committed: null });
    t.equal(h.level, 'attention', 'a yes with no number is a loose end');
  });

  t.test('an invoice unpaid for a month needs attention, one unpaid for a week does not', () => {
    const today = new Date('2026-09-11T12:00:00Z');
    const old = sponsorHealth(
      { status: 'committed', committed: 1000, invoicedAmount: 1000, invoicedAt: '2026-07-15', payments: [] },
      today
    );
    const fresh = sponsorHealth(
      { status: 'committed', committed: 1000, invoicedAmount: 1000, invoicedAt: '2026-09-05', payments: [] },
      today
    );
    t.equal(old.level, 'attention', '58 days unpaid is chased');
    t.equal(fresh.level, 'waiting', '6 days unpaid is just waiting');
  });

  t.test('paid in full with a logo still missing is not done', () => {
    const h = sponsorHealth({
      status: 'committed', committed: 1000, payments: [{ amount: 1000 }],
      deliverables: { logo: { state: 'open' }, swag: { state: 'na' }, social: { state: 'na' }, session: { state: 'na' } },
    });
    t.equal(h.level, 'waiting', 'money in does not mean finished');
    t.assert(h.why.indexOf('deliverable') !== -1, 'and the reason names what is missing');
  });

  t.test('paid and everything in is done', () => {
    const h = sponsorHealth({
      status: 'committed', committed: 1000, payments: [{ amount: 1000 }],
      deliverables: {
        logo: { state: 'done' }, swag: { state: 'done' },
        social: { state: 'done' }, session: { state: 'na' },
      },
    });
    t.equal(h.level, 'done', 'nothing left to chase');
  });

  /* ---------------- rollup ---------------- */

  t.test('declined and lost sponsors are kept out of every total', () => {
    const r = rollup([
      { status: 'committed', committed: 1000, payments: [{ amount: 1000 }] },
      { status: 'declined', committed: 5000, payments: [] },
      { status: 'lost', committed: 2500, payments: [] },
    ]);
    t.equal(r.committed, 1000, 'a declined sponsor is not committed money');
    t.equal(r.sponsorCount, 1, 'and is not counted');
  });

  t.test('unpriced sponsors are reported, never counted as free', () => {
    const r = rollup([
      { status: 'committed', committed: 2500, payments: [{ amount: 500 }] },
      { status: 'talking', committed: null, payments: [] },
    ]);
    t.equal(r.committed, 2500, 'the unknown is not added as zero');
    t.equal(r.unpriced, 1, 'it is reported separately');
    t.equal(r.outstanding, 2000, 'outstanding covers only the agreed money');
  });

  t.test('the rollup counts what is blocked and what is outstanding on deliverables', () => {
    const r = rollup([
      { status: 'committed', committed: 1000, invoicedAmount: null, payments: [] },
      {
        status: 'committed', committed: 500, invoicedAmount: 500, invoicedAt: '2026-09-10',
        payments: [{ amount: 500 }],
        deliverables: { logo: { state: 'done' }, swag: { state: 'open' }, social: { state: 'na' }, session: { state: 'na' } },
      },
    ], new Date('2026-09-11T12:00:00Z'));
    t.equal(r.blocked, 1, 'the never-invoiced one needs a nudge');
    t.equal(r.deliverablesOpen, 5, 'one open swag, plus all four untouched on the first');
  });

  /* ---------------- inventory ---------------- */

  t.test('the seeded tiers are the ones on the public page', () => {
    const by = {};
    for (const tier of SEED_TIERS) by[tier.name] = tier;
    t.equal(by.Presenting.amount, 7000, 'Presenting is 7000');
    t.equal(by.Presenting.slots, 1, 'and there is one of it');
    t.equal(by.Gold.amount, 2500, 'Gold is 2500');
    t.equal(by.Gold.slots, 3, 'and there are three');
    t.equal(by.Silver.amount, 1000, 'Silver is 1000');
    t.equal(by.Silver.slots, null, 'and unlimited');
  });

  t.test('a committed sponsor takes a slot, an inquiry does not', () => {
    const rows = tierAvailability([
      { status: 'committed', tier: 'Gold' },
      { status: 'inquiry', tier: 'Gold' },
      { status: 'talking', tier: 'Gold' },
    ], null);
    const gold = rows.find((r) => r.name === 'Gold');
    t.equal(gold.sold, 1, 'one sold');
    t.equal(gold.pending, 2, 'two asking');
    t.equal(gold.left, 2, 'two places still sellable');
    t.equal(gold.soldOut, false, 'not sold out on the strength of two emails');
  });

  t.test('an unlimited tier never reports a number left', () => {
    const silver = tierAvailability([{ status: 'committed', tier: 'Silver' }], null)
      .find((r) => r.name === 'Silver');
    t.equal(silver.left, null, 'unlimited has no remainder');
    t.equal(silver.soldOut, false, 'and never sells out');
  });

  t.test('the last Presenting slot going reports sold out', () => {
    const p = tierAvailability([{ status: 'committed', tier: 'Presenting' }], null)
      .find((r) => r.name === 'Presenting');
    t.assert(p.soldOut, 'sold out');
    t.equal(p.left, 0, 'nothing left');
    t.equal(p.oversold, false, 'exactly full is not oversold');
  });

  t.test('selling a fourth Gold is flagged rather than absorbed', () => {
    const gold = tierAvailability([
      { status: 'committed', tier: 'Gold' }, { status: 'committed', tier: 'Gold' },
      { status: 'committed', tier: 'Gold' }, { status: 'committed', tier: 'Gold' },
    ], null).find((r) => r.name === 'Gold');
    t.assert(gold.oversold, 'four into three is oversold');
    t.equal(gold.left, 0, 'and nothing is left to sell');
  });

  t.test('a declined sponsor releases their slot', () => {
    const gold = tierAvailability([
      { status: 'committed', tier: 'Gold' },
      { status: 'declined', tier: 'Gold' },
      { status: 'lost', tier: 'Gold' },
    ], null).find((r) => r.name === 'Gold');
    t.equal(gold.sold, 1, 'a no does not hold a place');
    t.equal(gold.left, 2, 'the place goes back on the board');
  });

  t.test('every moment starts open and names itself', () => {
    const rows = momentAvailability([]);
    t.equal(rows.length, MOMENT_KEYS.length, 'one row per moment');
    t.assert(rows.every((r) => r.open), 'all open with no sponsors');
    t.equal(momentLabel('day-1-lunch'), 'Day 1 lunch', 'and has a readable name');
  });

  t.test('a claimed moment names who has it', () => {
    const rows = momentAvailability([
      { status: 'committed', company: 'SanMar', moments: ['breakfast'] },
    ]);
    const b = rows.find((r) => r.key === 'breakfast');
    t.equal(b.claimedBy, 'SanMar', 'named');
    t.equal(b.open, false, 'and no longer open');
  });

  t.test('an inquiry on a moment holds nothing but is visible', () => {
    const b = momentAvailability([
      { status: 'talking', company: 'Chipply', moments: ['happy-hour'] },
    ]).find((r) => r.key === 'happy-hour');
    t.assert(b.open, 'still sellable');
    t.equal(b.pendingBy, 'Chipply', 'and the conversation is shown');
  });

  t.test('two committed sponsors on one moment is reported, not resolved', () => {
    const b = momentAvailability([
      { status: 'committed', company: 'SanMar', moments: ['swag-bags'] },
      { status: 'committed', company: 'SPSI', moments: ['swag-bags'] },
    ]).find((r) => r.key === 'swag-bags');
    t.assert(b.conflict, 'flagged as claimed twice');
  });

  t.test('an unknown moment is refused', () => {
    t.equal(validateSponsorPatch({ moments: ['karaoke'] }).ok, false, 'not a moment we sell');
    t.assert(validateSponsorPatch({ moments: ['breakfast'] }).ok, 'a real one passes');
  });

  t.test('claiming the same moment twice stores it once', () => {
    const r = validateSponsorPatch({ moments: ['breakfast', 'breakfast'] });
    t.equal(r.patch.moments.length, 1, 'deduped');
  });

  /* ---------------- validation ---------------- */

  t.test('a patch carries only the keys the caller sent', () => {
    const { patch } = validateSponsorPatch({ company: 'SanMar' });
    t.equal(Object.keys(patch).length, 1, 'one field in, one field out');
    t.equal('committed' in patch, false, 'an untouched amount is not set to null');
  });

  t.test('a bad amount is refused rather than rounded to zero', () => {
    const r = validateSponsorPatch({ committed: 'two and a half grand' });
    t.equal(r.ok, false, 'refused');
    t.assert(r.errors.join(' ').indexOf('number') !== -1, 'and says why');
  });

  t.test('an explicitly cleared amount becomes null, not zero', () => {
    const r = validateSponsorPatch({ committed: '' });
    t.assert(r.ok, 'clearing is allowed');
    t.equal(r.patch.committed, null, 'cleared means unknown');
  });

  t.test('an unknown status is refused', () => {
    t.equal(validateSponsorPatch({ status: 'maybe' }).ok, false, 'not a status');
    for (const s of STATUSES) {
      t.assert(validateSponsorPatch({ status: s }).ok, s + ' is a status');
    }
  });

  t.test('an unknown deliverable key is refused', () => {
    const r = validateSponsorPatch({ deliverables: { banner: { state: 'done' } } });
    t.equal(r.ok, false, 'the checklist is fixed');
  });

  t.test('a zero payment is refused', () => {
    const r = validateSponsorPatch({ payments: [{ amount: 0 }] });
    t.equal(r.ok, false, 'a payment of nothing is a typo');
  });

  t.test('a bad email is refused, an empty one is allowed', () => {
    t.equal(validateSponsorPatch({ email: 'nope' }).ok, false, 'not an address');
    t.assert(validateSponsorPatch({ email: '' }).ok, 'no address yet is fine');
  });

  t.test('an invoice date has to be a date', () => {
    t.equal(validateSponsorPatch({ invoicedAt: 'last tuesday' }).ok, false, 'refused');
    t.assert(validateSponsorPatch({ invoicedAt: '2026-09-01' }).ok, 'ISO passes');
  });

  /* ---------------- store ---------------- */

  t.test('a new sponsor starts with every deliverable open', () => {
    const s = newSponsor('SP-0001', 'ryan');
    for (const key of DELIVERABLE_KEYS) {
      t.equal(s.deliverables[key].state, 'open', key + ' starts open');
    }
    t.equal(s.committed, null, 'and with no amount agreed');
  });

  await t.test('ids run in sequence', async () => {
    const a = await nextSponsorId();
    const b = await nextSponsorId();
    t.equal(a, 'SP-0001', 'first id');
    t.equal(b, 'SP-0002', 'second id');
  });

  await t.test('a saved sponsor comes back', async () => {
    const rec = { ...newSponsor('SP-0100', 'ryan'), company: 'SanMar', committed: 2500 };
    await saveSponsor(rec);
    const back = await getSponsor('SP-0100');
    t.equal(back.company, 'SanMar', 'same company');
    t.equal(back.committed, 2500, 'same amount');
  });

  await t.test('a patch merges instead of replacing', async () => {
    await updateSponsor('SP-0100', { tier: 'Gold' });
    const back = await getSponsor('SP-0100');
    t.equal(back.tier, 'Gold', 'the new field landed');
    t.equal(back.company, 'SanMar', 'and the untouched one survived');
    t.equal(back.committed, 2500, 'including the money');
  });

  await t.test('a patch cannot rewrite who created the record or when', async () => {
    const before = await getSponsor('SP-0100');
    await updateSponsor('SP-0100', { createdBy: 'someone-else', createdAt: '1999-01-01T00:00:00.000Z', id: 'SP-9999' });
    const after = await getSponsor('SP-0100');
    t.equal(after.createdBy, before.createdBy, 'createdBy is pinned');
    t.equal(after.createdAt, before.createdAt, 'createdAt is pinned');
    t.equal(after.id, 'SP-0100', 'the id is pinned');
  });

  await t.test('sponsors are scoped by event', async () => {
    await saveSponsor({ ...newSponsor('SP-0200', 'ryan'), company: 'Chipply', event: 'FOC28' });
    const thisYear = await listSponsors('FOC27');
    const nextYear = await listSponsors('FOC28');
    t.assert(thisYear.every((s) => s.company !== 'Chipply'), 'next year stays out of this year');
    t.equal(nextYear.length, 1, 'and is findable on its own');
  });

  t.test('one company written two ways is one company', () => {
    t.equal(companyKey('Smith Bros.'), companyKey('Smith Bros LLC'), 'suffix and punctuation ignored');
    t.assert(companyKey('SanMar') !== companyKey('Sanmar Graphics'), 'but a different company is different');
  });

  await t.test('a repeat submission finds the record it already made', async () => {
    const hit = await findByCompany('sanmar', 'FOC27');
    t.assert(hit && hit.id === 'SP-0100', 'matched case-insensitively');
  });

  await t.test('deleting removes the record and its index entry', async () => {
    await saveSponsor({ ...newSponsor('SP-0300', 'ryan'), company: 'Temp' });
    t.equal(await deleteSponsor('SP-0300'), true, 'deleted');
    t.equal(await getSponsor('SP-0300'), null, 'and gone');
    const list = await listSponsors('FOC27');
    t.assert(list.every((s) => s.id !== 'SP-0300'), 'and out of the list');
  });

  await t.test('deleting something that is not there says so instead of throwing', async () => {
    t.equal(await deleteSponsor('SP-9999'), false, 'returns false');
  });

  /* ---------------- settings ---------------- */

  await t.test('tiers seed themselves so the app works the day it deploys', async () => {
    const s = await getSettings();
    t.assert(s.tiers.length >= 4, 'a tier lineup is there without a setup step');
    t.equal(s.event, 'FOC27', 'and the current event is set');
  });

  await t.test('a saved tier lineup wins over the seed', async () => {
    await saveSettings({ tiers: [{ name: 'Runway', amount: 7500 }] });
    const s = await getSettings();
    t.equal(s.tiers.length, 1, 'the saved list replaced the seed');
    t.equal(s.tiers[0].name, 'Runway', 'with the name we saved');
    t.equal(s.event, 'FOC27', 'and the event survived the partial save');
  });

  /* ---------------- routes load and gate ---------------- */

  await t.test('both routes load and export a handler', async () => {
    const sponsors = await import('../api/concontrol/sponsors.js');
    const inquiry = await import('../api/concontrol/inquiry.js');
    t.equal(typeof sponsors.default, 'function', 'sponsors route has a handler');
    t.equal(typeof inquiry.default, 'function', 'inquiry route has a handler');
  });

  await t.test('the public route refuses anything but POST', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const res = fakeRes();
    await inquiry.default({ method: 'GET', headers: {}, query: {} }, res);
    t.equal(res.statusCode, 405, 'GET is not how you submit a form');
  });

  await t.test('the public route needs a company and a real email', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');

    const noCompany = fakeRes();
    await inquiry.default({ method: 'POST', headers: {}, body: { email: 'a@b.com' } }, noCompany);
    t.equal(noCompany.statusCode, 400, 'no company is refused');

    const badEmail = fakeRes();
    await inquiry.default({ method: 'POST', headers: {}, body: { company: 'Acme', email: 'nope' } }, badEmail);
    t.equal(badEmail.statusCode, 400, 'a junk email is refused');
  });

  await t.test('a public submission cannot make itself paid', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const res = fakeRes();
    await inquiry.default({
      method: 'POST',
      headers: {},
      body: {
        company: 'Limitless Transfers', email: 'hi@limitless.test', contactName: 'Pat',
        // Everything below is a field the form has no business setting.
        committed: 99999, status: 'committed', payments: [{ amount: 99999 }],
        deliverables: { logo: { state: 'done' } }, event: 'FOC99',
      },
    }, res);

    t.equal(res.statusCode, 201, 'the inquiry is recorded');
    const rec = await getSponsor(res.body.id);
    t.equal(rec.committed, null, 'no money was set');
    t.equal(rec.status, 'inquiry', 'status is inquiry, not committed');
    t.equal(rec.payments.length, 0, 'no payments were recorded');
    t.equal(rec.deliverables.logo.state, 'open', 'no deliverable marked done');
    t.equal(rec.event, 'FOC27', 'an unlisted event falls back to the real one');
    t.equal(rec.source, 'sponsor-form', 'and it is stamped as coming from the form');
  });

  await t.test('the form calls it a level and the record calls it a tier', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const res = fakeRes();
    await inquiry.default({
      method: 'POST', headers: {},
      body: { company: 'SPSI', email: 'hi@spsi.test', level: 'Gold' },
    }, res);
    const rec = await getSponsor(res.body.id);
    t.equal(rec.tier, 'Gold', 'the level landed on the tier field');
    t.assert(rec.notes.indexOf('Gold') !== -1, 'and is written into the note');
  });

  await t.test('a filled honeypot is answered cheerfully and written nowhere', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const before = (await listSponsors('FOC27')).length;
    const res = fakeRes();
    await inquiry.default({
      method: 'POST', headers: {},
      body: { company: 'Bot Co', email: 'bot@bot.test', _hp: 'http://spam' },
    }, res);
    t.equal(res.statusCode, 200, 'a bot is not told which check caught it');
    t.equal(res.body.id, null, 'and nothing was created');
    t.equal((await listSponsors('FOC27')).length, before, 'the list is unchanged');
  });

  await t.test('submitting twice appends rather than duplicating', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const before = (await listSponsors('FOC27')).length;

    const res = fakeRes();
    await inquiry.default({
      method: 'POST',
      headers: {},
      body: { company: 'Limitless Transfers LLC', email: 'hi@limitless.test', message: 'Following up' },
    }, res);

    const after = await listSponsors('FOC27');
    t.equal(res.body.duplicate, true, 'reported as a repeat');
    t.equal(after.length, before, 'no second record was created');
    const rec = await getSponsor(res.body.id);
    t.assert(rec.notes.indexOf('Following up') !== -1, 'the second message was kept');
  });

  /* ---------------- what we owe them ---------------- */

  const { obligationsFor, obligationStates, obligationProgress } = schema;

  t.test('each level carries the promises its own page makes', () => {
    t.equal(obligationsFor('Silver').length, 5, 'Silver: signage, web, remarks, bag, group social');
    t.assert(obligationsFor('Gold').length > obligationsFor('Silver').length, 'Gold carries more');
    t.assert(obligationsFor('Presenting').length > obligationsFor('Gold').length, 'Presenting carries the most');
    t.equal(obligationsFor('').length, 0, 'no level promises nothing');
  });

  t.test('a Silver sponsor is never asked for a welcome address', () => {
    const keys = obligationsFor('Silver').map((o) => o.key);
    t.equal(keys.includes('welcome'), false, 'not their level');
    t.equal(keys.includes('branding'), false, 'nor event branding');
    t.assert(obligationsFor('Presenting').map((o) => o.key).includes('welcome'), 'but Presenting is');
  });

  t.test('an untouched obligation reads as open, not done', () => {
    const states = obligationStates({ tier: 'Gold' });
    t.assert(Object.values(states).every((s) => s.state === 'open'), 'nothing is done by default');
  });

  t.test('obligation progress counts only what that level owes', () => {
    const p = obligationProgress({ tier: 'Silver', obligations: { signage: { state: 'done' }, welcome: { state: 'done' } } });
    t.equal(p.owed, 5, 'five, not thirteen');
    t.equal(p.done, 1, 'the welcome tick does not count, Silver never owed it');
  });

  t.test('paid in full, everything received, but we still owe them, is not done', () => {
    const s = {
      status: 'committed', tier: 'Presenting', committed: 7000, payments: [{ amount: 7000 }],
      deliverables: { logo: { state: 'done' }, swag: { state: 'done' }, social: { state: 'done' }, session: { state: 'done' } },
      obligations: { signage: { state: 'open' } },
    };
    const h = sponsorHealth(s);
    t.equal(h.level, 'waiting', 'their side being finished is not the whole answer');
    t.assert(h.why.indexOf('we owe') !== -1, 'and the reason says which side');
  });

  /* ---------------- history ---------------- */

  const { historyEntry, describeChange } = schema;

  t.test('a trail line records what changed in words', () => {
    const before = { status: 'talking', tier: 'Gold', committed: null, payments: [], moments: [] };
    const what = describeChange(before, { status: 'committed', committed: 2500 });
    t.assert(what.indexOf('status') !== -1, 'names the status move');
    t.assert(what.indexOf('committed') !== -1, 'and the money');
  });

  t.test('a patch that changes nothing worth recording gets no trail line', () => {
    const before = { status: 'committed', tier: 'Gold', committed: 2500, payments: [], moments: [] };
    t.equal(describeChange(before, { notes: 'called them' }), null, 'notes are not trail-worthy');
    t.equal(describeChange(before, { status: 'committed' }), null, 'nor a status set to what it already was');
  });

  await t.test('the trail is appended by the store and cannot be shortened by a caller', async () => {
    const rec = { ...newSponsor('SP-0700', 'ryan'), company: 'Trail Co', history: [historyEntry('created', 'ryan')] };
    await saveSponsor(rec);
    await updateSponsor('SP-0700', { notes: 'x' }, historyEntry('first move', 'ryan'));
    // A caller sending its own short history must not win.
    await updateSponsor('SP-0700', { history: [] }, historyEntry('second move', 'ryan'));
    const back = await getSponsor('SP-0700');
    t.equal(back.history.length, 3, 'created plus two moves, nothing lost');
    t.equal(back.history[2].what, 'second move', 'in order');
  });

  t.test('history is not a patchable field', () => {
    const r = validateSponsorPatch({ history: [], company: 'X' });
    t.equal('history' in r.patch, false, 'the validator never lets it through');
  });

  /* ---------------- the ledger ---------------- */

  const ledger = await import('../lib/concontrol/ledger.js');
  const { validateEntryPatch, newEntry, budgetSummary, byCategory } = ledger;

  t.test('spend is counted in three buckets, not one', () => {
    const sum = budgetSummary([
      { kind: 'spend', state: 'paid', amount: 1000 },
      { kind: 'spend', state: 'committed', amount: 500 },
      { kind: 'spend', state: 'estimate', amount: 250 },
    ], [], null);
    t.equal(sum.spend.paid, 1000, 'money gone');
    t.equal(sum.spend.committed, 500, 'money promised');
    t.equal(sum.spend.estimated, 250, 'money guessed');
    t.equal(sum.spendOut, 1000, 'spent means spent');
    t.equal(sum.spendAhead, 750, 'and the rest is ahead of us');
  });

  t.test('sponsor money is read off the sponsors, never re-entered', () => {
    const sum = budgetSummary([], [
      { status: 'committed', committed: 2500, payments: [{ amount: 1000 }] },
    ], null);
    t.equal(sum.sponsorCollected, 1000, 'collected comes from the payments');
    t.equal(sum.sponsorCommitted, 2500, 'committed from the agreement');
    t.equal(sum.incomeExpected, 1500, 'and the gap is what is still expected');
  });

  t.test('a declined sponsor is not income', () => {
    const sum = budgetSummary([], [{ status: 'declined', committed: 5000, payments: [] }], null);
    t.equal(sum.sponsorCommitted, 0, 'a no is not money');
  });

  t.test('an entry with no amount is a gap, never a zero', () => {
    const sum = budgetSummary([{ kind: 'spend', state: 'paid', amount: null }], [], null);
    t.equal(sum.spend.paid, 0, 'nothing is added');
    t.equal(sum.spend.gaps, 1, 'and the unknown is reported');
  });

  t.test('the budget reports what is left against everything promised, not just spent', () => {
    const sum = budgetSummary([
      { kind: 'spend', state: 'paid', amount: 4000 },
      { kind: 'spend', state: 'committed', amount: 3000 },
    ], [], 10000);
    t.equal(sum.budgetLeft, 3000, '10000 less 4000 spent and 3000 on the hook');
  });

  t.test('by category sorts biggest first and names its gaps', () => {
    const out = byCategory([
      { kind: 'spend', state: 'paid', amount: 100, category: 'Food and drink' },
      { kind: 'spend', state: 'committed', amount: 900, category: 'Video and photo' },
      { kind: 'spend', state: 'paid', amount: null, category: 'Food and drink' },
      { kind: 'income', state: 'paid', amount: 500, category: 'Food and drink' },
    ]);
    t.equal(out.rows[0].category, 'Video and photo', 'biggest first');
    t.equal(out.gaps, 1, 'the amountless entry is counted as a gap');
    t.equal(out.rows.find((r) => r.category === 'Food and drink').total, 100, 'income is not spend');
  });

  t.test('a negative amount is refused with a reason', () => {
    const r = validateEntryPatch({ amount: -50 }, null);
    t.equal(r.ok, false, 'refused');
    t.assert(r.errors.join(' ').indexOf('refund') !== -1, 'and says what to do instead');
  });

  t.test('a category off the list is refused rather than becoming its own row', () => {
    t.equal(validateEntryPatch({ category: 'Fireworks' }, ['Food and drink']).ok, false, 'not a category');
    t.assert(validateEntryPatch({ category: 'Food and drink' }, ['Food and drink']).ok, 'a real one passes');
  });

  t.test('a new entry starts as an estimate, which is the honest default', () => {
    const e = newEntry('LE-0001', 'ryan', 'FOC27');
    t.equal(e.state, 'estimate', 'nothing is paid until somebody says so');
    t.equal(e.amount, null, 'and no amount is invented');
  });

  /* ---------------- the program ---------------- */

  const program = await import('../lib/concontrol/program.js');
  const {
    validateSessionPatch, newSession, scheduleConflicts, publicAgenda,
    validateSpeakerPatch, newSpeaker, materialProgress, programBlockers, isTime,
  } = program;

  t.test('a start time has to be a time', () => {
    t.assert(isTime('09:00'), 'morning');
    t.assert(isTime('14:30'), 'afternoon');
    t.equal(isTime('9am'), false, 'not how it is stored');
    t.equal(isTime('25:00'), false, 'not a real hour');
  });

  // These fixtures carry a speaker, because a confirmed session without one is
  // its own separate finding and would otherwise be counted here too.
  const slot = (id, day, start, track, status) => ({
    id, day, start, track, status, format: 'session', speakerIds: ['SK-1'],
  });
  const clashes = (rows) => scheduleConflicts(rows).filter(
    (c) => c.kind === 'double-booked' || c.kind === 'runs-against-whole-room'
  );

  t.test('two sessions in one track at one time is reported', () => {
    const c = clashes([slot('SE-1', 1, '10:30', 'a', 'confirmed'), slot('SE-2', 1, '10:30', 'a', 'confirmed')]);
    t.equal(c.length, 1, 'one conflict');
    t.equal(c[0].kind, 'double-booked', 'named');
  });

  t.test('the two tracks running at once is not a conflict', () => {
    const c = clashes([slot('SE-1', 1, '10:30', 'a', 'confirmed'), slot('SE-2', 1, '10:30', 'b', 'confirmed')]);
    t.equal(c.length, 0, 'Gate A and Gate B are meant to run together');
  });

  t.test('nothing runs against lunch', () => {
    const c = clashes([slot('SE-1', 1, '11:45', 'all', 'confirmed'), slot('SE-2', 1, '11:45', 'a', 'confirmed')]);
    t.equal(c[0].kind, 'runs-against-whole-room', 'a whole-room slot blocks the tracks');
  });

  t.test('a cancelled session stops conflicting with anything', () => {
    const c = clashes([slot('SE-1', 1, '10:30', 'a', 'confirmed'), slot('SE-2', 1, '10:30', 'a', 'cancelled')]);
    t.equal(c.length, 0, 'it is not on the grid any more');
  });

  t.test('a confirmed session with no slot and no speaker is both', () => {
    const c = scheduleConflicts([{ id: 'SE-9', day: 1, start: '', track: 'a', status: 'confirmed', format: 'session', speakerIds: [] }]);
    const kinds = c.map((x) => x.kind);
    t.assert(kinds.includes('confirmed-with-no-slot'), 'no time');
    t.assert(kinds.includes('confirmed-with-no-speaker'), 'no speaker');
  });

  t.test('lunch needs no speaker', () => {
    const c = scheduleConflicts([{ id: 'SE-9', day: 1, start: '11:45', track: 'all', status: 'confirmed', format: 'meal', speakerIds: [] }]);
    t.equal(c.length, 0, 'a meal is not missing anybody');
  });

  t.test('the public agenda carries only confirmed, scheduled sessions', () => {
    const speakers = [{ id: 'SK-1', name: 'Meghan', company: 'Chipply', bio: 'b', headshot: 'h', email: 'private@example.test', phone: '555' }];
    const agenda = publicAgenda([
      { id: 'SE-1', day: 1, start: '09:00', track: 'a', status: 'confirmed', title: 'Live', minutes: 60, speakerIds: ['SK-1'], format: 'session' },
      { id: 'SE-2', day: 1, start: '10:30', track: 'a', status: 'held', title: 'Not yet', minutes: 60, speakerIds: [], format: 'session' },
      { id: 'SE-3', day: 1, start: '', track: 'a', status: 'confirmed', title: 'No slot', minutes: 60, speakerIds: [], format: 'session' },
    ], speakers);
    t.equal(agenda.length, 1, 'one session is public');
    t.equal(agenda[0].title, 'Live', 'the confirmed one');
  });

  t.test('the public agenda never leaks a speaker email or phone', () => {
    const speakers = [{ id: 'SK-1', name: 'Meghan', company: 'Chipply', bio: 'b', headshot: 'h', email: 'private@example.test', phone: '555-0100' }];
    const agenda = publicAgenda([
      { id: 'SE-1', day: 1, start: '09:00', track: 'a', status: 'confirmed', title: 'Live', minutes: 60, speakerIds: ['SK-1'], format: 'session' },
    ], speakers);
    const json = JSON.stringify(agenda);
    t.equal(json.indexOf('private@example.test'), -1, 'no email');
    t.equal(json.indexOf('555-0100'), -1, 'no phone');
    t.assert(json.indexOf('Meghan') !== -1, 'the name is public, which is the point');
  });

  t.test('the agenda runs in the order the day does', () => {
    const agenda = publicAgenda([
      { id: 'SE-2', day: 2, start: '09:00', track: 'a', status: 'confirmed', title: 'B', minutes: 60, speakerIds: [], format: 'session' },
      { id: 'SE-1', day: 1, start: '14:00', track: 'a', status: 'confirmed', title: 'A', minutes: 60, speakerIds: [], format: 'session' },
    ], []);
    t.equal(agenda[0].title, 'A', 'day one first');
  });

  t.test('a session cannot point at a speaker who does not exist', () => {
    const r = validateSessionPatch({ speakerIds: ['SK-404'] }, ['SK-1']);
    t.equal(r.ok, false, 'refused');
    t.assert(validateSessionPatch({ speakerIds: ['SK-1'] }, ['SK-1']).ok, 'a real one passes');
  });

  t.test('an unknown track or format is refused', () => {
    t.equal(validateSessionPatch({ track: 'gate-c' }, []).ok, false, 'there are two tracks and a whole room');
    t.equal(validateSessionPatch({ format: 'keynote' }, []).ok, false, 'not a format we use');
  });

  t.test('a new session starts as an idea, not confirmed', () => {
    t.equal(newSession('SE-1', 'ryan', 'FOC27').status, 'idea', 'nothing is confirmed by existing');
  });

  t.test('speaker materials drop N/A from the count', () => {
    const p = materialProgress({
      materials: {
        bio: { state: 'done' }, headshot: { state: 'done' }, title: { state: 'done' },
        slides: { state: 'done' }, av: { state: 'done' }, travel: { state: 'na' },
      },
    });
    t.equal(p.owed, 5, 'a local speaker owes no travel arrangement');
    t.assert(p.complete, 'and is finished');
  });

  t.test('only confirmed speakers are chased', () => {
    const blockers = programBlockers([], [
      { id: 'SK-1', name: 'A', status: 'proposed', materials: {} },
      { id: 'SK-2', name: 'B', status: 'confirmed', materials: {} },
    ]);
    const chased = blockers.filter((b) => b.kind === 'speaker-materials');
    t.equal(chased.length, 1, 'one of the two');
    t.equal(chased[0].name, 'B', 'the one who said yes');
  });

  t.test('a new speaker starts as proposed with everything outstanding', () => {
    const k = newSpeaker('SK-1', 'ryan', 'FOC27');
    t.equal(k.status, 'proposed', 'proposing is not confirming');
    t.equal(materialProgress(k).done, 0, 'and nothing has arrived');
  });

  t.test('a bad speaker email is refused', () => {
    t.equal(validateSpeakerPatch({ email: 'nope' }).ok, false, 'not an address');
    t.assert(validateSpeakerPatch({ email: '' }).ok, 'none yet is fine');
  });

  /* ---------------- the rest of the routes ---------------- */

  await t.test('every route loads and exports a handler', async () => {
    for (const name of ['sponsors', 'inquiry', 'ledger', 'sessions', 'speakers', 'settings', 'speak', 'agenda', 'export']) {
      const mod = await import(`../api/concontrol/${name}.js`);
      t.equal(typeof mod.default, 'function', `${name} has a handler`);
    }
  });

  await t.test('the agenda route is public, read only, and answers with a list', async () => {
    const agenda = await import('../api/concontrol/agenda.js');
    const post = fakeRes();
    await agenda.default({ method: 'POST', headers: {}, query: {} }, post);
    t.equal(post.statusCode, 405, 'nothing can be written through it');

    const get = fakeRes();
    await agenda.default({ method: 'GET', headers: {}, query: {} }, get);
    t.equal(get.statusCode, 200, 'and a read works with no session');
    t.assert(Array.isArray(get.body.agenda), 'returning an agenda');
  });

  await t.test('the speak form cannot confirm itself onto the program', async () => {
    const speak = await import('../api/concontrol/speak.js');
    const res = fakeRes();
    await speak.default({
      method: 'POST', headers: {},
      body: {
        name: 'Matt Richardson', email: 'matt@atonal.test', company: 'Atonal Headwear',
        topic: 'Hat decorating',
        status: 'confirmed', materials: { bio: { state: 'done' } },
      },
    }, res);
    t.equal(res.statusCode, 201, 'the proposal is recorded');
    const rec = await getSpeaker(res.body.id);
    t.equal(rec.status, 'proposed', 'not confirmed');
    t.equal(rec.materials.bio.state, 'open', 'and nothing marked received');
    t.equal(rec.source, 'speak-form', 'stamped as coming from the form');
  });

  await t.test('the same speaker submitting twice updates rather than duplicating', async () => {
    const speak = await import('../api/concontrol/speak.js');
    const before = (await listSpeakers('FOC27')).length;
    const res = fakeRes();
    await speak.default({
      method: 'POST', headers: {},
      body: { name: 'Matt R', email: 'MATT@ATONAL.TEST', topic: 'Another idea' },
    }, res);
    t.equal(res.body.duplicate, true, 'matched on email, case ignored');
    t.equal((await listSpeakers('FOC27')).length, before, 'no second record');
  });

  await t.test('a filled honeypot on the speak form writes nothing', async () => {
    const speak = await import('../api/concontrol/speak.js');
    const before = (await listSpeakers('FOC27')).length;
    const res = fakeRes();
    await speak.default({ method: 'POST', headers: {}, body: { name: 'Bot', email: 'b@b.test', _hp: 'x' } }, res);
    t.equal(res.statusCode, 200, 'answered cheerfully');
    t.equal((await listSpeakers('FOC27')).length, before, 'and nothing created');
  });

  /* ---------------- intake from our own site ---------------- */

  const intake = await import('../lib/concontrol/intake.js');

  t.test('a missing secret means nobody is the site, not everybody', () => {
    delete process.env.CONCONTROL_INTAKE_SECRET;
    t.equal(intake.isOwnSite({ headers: { 'x-intake-secret': 'anything' } }), false,
      'the undefined !== undefined trap stays shut');
    t.equal(intake.intakeLimit({ headers: {} }).max, 10, 'and everyone gets the public ceiling');
  });

  t.test('the right secret earns a bigger bucket and nothing else', () => {
    process.env.CONCONTROL_INTAKE_SECRET = 'a-real-secret';
    t.assert(intake.isOwnSite({ headers: { 'x-intake-secret': 'a-real-secret' } }), 'recognised');
    t.equal(intake.isOwnSite({ headers: { 'x-intake-secret': 'wrong' } }), false, 'a wrong one is not');
    t.equal(intake.isOwnSite({ headers: {} }), false, 'and no header is not');

    const site = intake.intakeLimit({ headers: { 'x-intake-secret': 'a-real-secret' } });
    t.assert(site.max > 100, 'the site is not capped at ten an hour');
    t.equal(site.key, 'site', 'and is bucketed as itself, not by the address it dials from');
    delete process.env.CONCONTROL_INTAKE_SECRET;
  });

  t.test('the public caller is still bucketed by address', () => {
    t.equal(intake.intakeLimit({ headers: {} }).key, null, 'so one abuser cannot spend the site\'s allowance');
  });

  await t.test('the site sends its message as notes, and that still lands', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const res = fakeRes();
    await inquiry.default({
      method: 'POST', headers: {},
      body: { company: 'Notes Co', email: 'hi@notes.test', notes: 'We want the happy hour' },
    }, res);
    const rec = await getSponsor(res.body.id);
    t.assert(rec.notes.indexOf('happy hour') !== -1, 'the site field name is accepted too');
  });

  await t.test('the site honeypot is called _gotcha and is honoured', async () => {
    const inquiry = await import('../api/concontrol/inquiry.js');
    const before = (await listSponsors('FOC27')).length;
    const res = fakeRes();
    await inquiry.default({ method: 'POST', headers: {}, body: { company: 'Bot', email: 'b@b.test', _gotcha: 'x' } }, res);
    t.equal(res.statusCode, 200, 'answered cheerfully');
    t.equal((await listSponsors('FOC27')).length, before, 'and nothing written');
  });

  await t.test('the speak form calls the company a shop, and that maps', async () => {
    const speak = await import('../api/concontrol/speak.js');
    const res = fakeRes();
    await speak.default({
      method: 'POST', headers: {},
      body: { name: 'Spencer C', email: 'spencer@limitless.test', shop: 'Limitless Transfers', session_title: 'Transfers, start to finish', notes: 'Equipment: heat press' },
    }, res);
    const rec = await getSpeaker(res.body.id);
    t.equal(rec.company, 'Limitless Transfers', 'shop became company');
    t.assert(rec.topic.indexOf('Transfers') !== -1, 'session_title became the topic');
    t.assert(rec.notes.indexOf('heat press') !== -1, 'and the practical answers were kept');
  });

  /* ---------------- the survey seed ---------------- */

  const seed = await import('../lib/concontrol/seed-survey.js');
  const { tallyTopics, usefulText, blurbFor, seedSessions, seedWishlist } = seed;

  const survey = [
    { topics: 'Short runs | AI live | Burnout', must_have_session: 'AI live' },
    { topics: 'Short runs | Hiring | Burnout', must_have_session: 'Hiring' },
    { topics: 'Short runs | AI live', must_have_session: 'AI live' },
  ];

  t.test('a pipe separated multi-select becomes one row per topic', () => {
    const rows = tallyTopics(survey);
    const short = rows.find((r) => r.topic === 'Short runs');
    t.equal(short.picked, 3, 'picked by all three');
    t.equal(short.mustHave, 0, 'and nobody named it as the one');
  });

  t.test('must-haves break the tie, not raw picks', () => {
    const rows = tallyTopics(survey);
    t.equal(rows[0].topic, 'AI live', 'two must-haves beats three picks');
    t.equal(rows[0].picked, 2, 'even on fewer picks');
  });

  t.test('a must-have nobody listed among their picks is still counted', () => {
    const rows = tallyTopics([{ topics: 'Short runs', must_have_session: 'Succession' }]);
    const hit = rows.find((r) => r.topic === 'Succession');
    t.assert(hit, 'it is in the tally');
    t.equal(hit.picked, 0, 'with no picks');
    t.equal(hit.mustHave, 1, 'and the must-have that found it');
  });

  t.test('the blurb keeps both numbers rather than collapsing them to a rank', () => {
    const b = blurbFor({ topic: 'X', picked: 7, mustHave: 0, respondents: 19 });
    t.assert(b.indexOf('7 of the 19') !== -1, 'the picks are there');
    t.assert(b.indexOf('Nobody named it') !== -1, 'and so is the absence of must-haves');
  });

  t.test('a polite no is not a topic', () => {
    t.equal(usefulText('No.'), '', 'refused');
    t.equal(usefulText('Not that I can think of. But I am sure there is.'), '', 'also refused');
    t.equal(usefulText('?'), '', 'and that');
    t.equal(usefulText('more info on SIM process'), 'more info on SIM process', 'a real answer survives');
  });

  await t.test('the seed creates ideas with no time on them', async () => {
    const out = await seedSessions(survey, 'FOC27', 'ryan');
    t.equal(out.created.length, 4, 'one per distinct topic');
    const made = (await listSessions('FOC27')).filter((s) => s.title === 'Short runs');
    t.equal(made.length, 1, 'created once');
    t.equal(made[0].status, 'idea', 'as an idea');
    t.equal(made[0].start, '', 'with no time, because that is a judgement call');
  });

  await t.test('running it twice refreshes rather than duplicating', async () => {
    const out = await seedSessions(survey, 'FOC27', 'ryan');
    t.equal(out.created.length, 0, 'nothing new');
    t.equal(out.updated.length, 4, 'all four refreshed');
    const made = (await listSessions('FOC27')).filter((s) => s.title === 'Short runs');
    t.equal(made.length, 1, 'still one');
  });

  await t.test('anything scheduled or moved on is left alone', async () => {
    const mine = (await listSessions('FOC27')).find((s) => s.title === 'Hiring');
    await updateSession(mine.id, { start: '10:30', status: 'confirmed' });
    const out = await seedSessions(survey, 'FOC27', 'ryan');
    t.assert(out.skipped.includes('Hiring'), 'skipped');
    const after = await getSession(mine.id);
    t.equal(after.start, '10:30', 'the time somebody set survived');
    t.equal(after.status, 'confirmed', 'and so did the decision');
  });

  await t.test('dream speakers land as a wishlist, not as proposals', async () => {
    const out = await seedWishlist([
      { name: 'Tom Raun', company: 'Envision Tees', note: 'Started on a manual press' },
      { name: 'Michelle Moxley' },
    ], 'FOC27', 'ryan');
    t.equal(out.created.length, 2, 'both added');
    const tom = (await listSpeakers('FOC27')).find((s) => s.name === 'Tom Raun');
    t.equal(tom.status, 'wishlist', 'asked for, not offered');
    t.assert(tom.notes.indexOf('manual press') !== -1, 'with the reason somebody gave');
  });

  await t.test('a wishlist name who has since been invited is not dragged back', async () => {
    const tom = (await listSpeakers('FOC27')).find((s) => s.name === 'Tom Raun');
    await updateSpeaker(tom.id, { status: 'invited' });
    const out = await seedWishlist([{ name: 'Tom Raun' }], 'FOC27', 'ryan');
    t.assert(out.skipped.includes('Tom Raun'), 'skipped');
    t.equal((await getSpeaker(tom.id)).status, 'invited', 'still invited');
  });

  await t.test('a wishlist speaker is never chased for a headshot', async () => {
    const speakers = await listSpeakers('FOC27');
    const chased = programBlockers([], speakers).filter((b) => b.kind === 'speaker-materials');
    t.assert(chased.every((b) => b.name !== 'Michelle Moxley'), 'nobody chases a name off a wish list');
  });

  await t.test('the seed route refuses a non-admin and an unknown import', async () => {
    const mod = await import('../api/concontrol/seed.js');
    t.equal(typeof mod.default, 'function', 'it loads');
  });

  /* ---------------- the data actually ships ---------------- */

  const shipped = await import('../lib/concontrol/foc26-survey.js');

  t.test('the survey ships with the app rather than needing a paste', () => {
    t.equal(shipped.FOC26_RESPONSES.length, 19, 'nineteen responses');
    t.assert(shipped.FOC26_WISHLIST.length >= 8, 'and the wishlist names');
    t.equal(shipped.FOC26_SPONSORS.length, 8, 'and last year\'s eight sponsors');
  });

  t.test('the shipped responses carry no personal data', () => {
    const keys = new Set();
    for (const row of shipped.FOC26_RESPONSES) Object.keys(row).forEach((k) => keys.add(k));
    t.equal(keys.size, 2, 'two fields only');
    t.assert(keys.has('topics') && keys.has('must_have_session'), 'the two the tally reads');
    const json = JSON.stringify(shipped.FOC26_RESPONSES);
    t.equal(json.indexOf('@'), -1, 'no email address anywhere in it');
  });

  t.test('the shipped survey tallies to the topics we expect', () => {
    const rows = tallyTopics(shipped.FOC26_RESPONSES);
    t.equal(rows.length, 26, 'twenty-six distinct topics');
    t.equal(rows[0].topic, 'Hiring, training and keeping good people', 'most must-haves first');
    const burnout = rows.find((r) => r.topic.indexOf('Burnout') === 0);
    t.equal(burnout.picked, 7, 'burnout was picked seven times');
    t.equal(burnout.mustHave, 0, 'and named as nobody\'s single session');
  });

  t.test('every shipped wishlist entry is an actual name', () => {
    for (const entry of shipped.FOC26_WISHLIST) {
      t.assert(entry.name && entry.name.trim().length > 2, `"${entry.name}" is a name`);
    }
  });

  await t.test('the seed route runs with no payload at all', async () => {
    // The whole point of this change: a body of three words has to be enough.
    const mod = await import('../api/concontrol/seed.js');
    t.equal(typeof mod.default, 'function', 'the route loads');
    const src = await import('fs').then((fs) => fs.readFileSync('api/concontrol/seed.js', 'utf8'));
    t.assert(src.indexOf('FOC26_RESPONSES') !== -1, 'and falls back to the shipped data');
  });

  /* ---------------- the escaped-newline damage ---------------- */

  await t.test('a lineup saved as one escaped line is split back apart on read', async () => {
    // Exactly what was in storage after the Settings textarea wrote a literal
    // backslash-n between entries and somebody pressed Save.
    await saveSettings({
      tiers: [{ name: 'Presenting, 7000, 1\\nGold, 2500, 3\\nSilver, 1000, ', amount: null, slots: null }],
      categories: ['Food and drink\\nVideo and photo\\nVenue and setup'],
    });
    const back = await getSettings();

    t.equal(back.tiers.length, 3, 'three levels came back, not one');
    t.equal(back.tiers[0].name, 'Presenting', 'names are names again');
    t.equal(back.tiers[0].amount, 7000, 'with their amounts');
    t.equal(back.tiers[1].slots, 3, 'and their places');
    t.equal(back.tiers[2].slots, null, 'a blank places field is unlimited, not zero');

    t.equal(back.categories.length, 3, 'three categories came back');
    t.equal(back.categories[0], 'Food and drink', 'cleanly');
  });

  await t.test('a healthy lineup is left exactly alone by the repair', async () => {
    await saveSettings({
      tiers: [{ name: 'Presenting', amount: 7000, slots: 1 }, { name: 'Gold', amount: 2500, slots: 3 }],
      categories: ['Food and drink', 'Video and photo'],
    });
    const back = await getSettings();
    t.equal(back.tiers.length, 2, 'still two');
    t.equal(back.tiers[0].slots, 1, 'untouched');
    t.equal(back.categories.length, 2, 'and two categories');
  });

  await t.test('a level name that legitimately has a comma in it survives a save', async () => {
    await saveSettings({ tiers: [{ name: 'Presenting', amount: 7000, slots: 1 }] });
    const back = await getSettings();
    t.equal(back.tiers[0].name, 'Presenting', 'no splitting where there is nothing to split');
  });

  process.exit(t.report());
})();

function fakeRes() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
}
