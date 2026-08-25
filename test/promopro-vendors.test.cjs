// test/promopro-vendors.test.cjs — vendor scoring and blacklisting,
// partial receiving, the chase run, and signed artwork links.
//
// Real function calls throughout, not source-text matching. The route-import
// lesson applies here too: grepping for a function name proves the letters
// are in the file, not that the maths is right.

const t = require('./harness.cjs');

// The signing key has to exist before art-token.js is imported: it reads the
// env var at call time, but a test run with no SESSION_SECRET would exercise
// the unconfigured path rather than the maths.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-for-signing';

(async () => {
const vendorsLib = await import('../lib/promopro/vendors.js');
const statsLib = await import('../lib/promopro/vendor-stats.js');
const schema = await import('../lib/promopro/schema.js');
const chase = await import('../lib/promopro/chase.js');
const artToken = await import('../lib/promopro/art-token.js');
const inbound = await import('../api/promopro/inbound.js');
const doc = await import('../lib/promopro/document.js');

// The harness has no deepEqual; arrays compare fine as joined strings and
// the failure message stays readable.
const sameList = (a, b, msg) => t.equal(JSON.stringify(a), JSON.stringify(b), msg);

/* ------------------------------------------------------------------ *
 * BLACKLIST
 * ------------------------------------------------------------------ */

t.test('a blacklist without a reason is refused', () => {
  const r = vendorsLib.validateVendor({ name: 'Acme', blacklisted: true }, null);
  t.assert(!r.ok, 'a reasonless blacklist is the one nobody remembers in six months');
  t.assert(r.errors.join(' ').includes('why'), 'the error should say what is missing');
});

t.test('a blacklist with a reason is accepted and keeps the reason', () => {
  const r = vendorsLib.validateVendor(
    { name: 'Acme', blacklisted: true, blacklistReason: 'Shipped wrong goods twice' }, null);
  t.assert(r.ok, 'a reasoned blacklist should save');
  t.equal(r.vendor.blacklisted, true);
  t.equal(r.vendor.blacklistReason, 'Shipped wrong goods twice');
});

t.test('clearing the blacklist clears the reason and the stamp', () => {
  const existing = {
    id: 'v1', name: 'Acme', blacklisted: true, blacklistReason: 'bad',
    blacklistedAt: '2026-01-01T00:00:00.000Z', blacklistedBy: 'ryan',
  };
  const r = vendorsLib.validateVendor({ blacklisted: false }, existing);
  t.assert(r.ok);
  t.equal(r.vendor.blacklisted, false);
  t.equal(r.vendor.blacklistReason, '');
  t.equal(r.vendor.blacklistedAt, null);
});

t.test('an unrelated edit does not reset who blacklisted them or when', () => {
  const existing = {
    id: 'v1', name: 'Acme', blacklisted: true, blacklistReason: 'bad',
    blacklistedAt: '2026-01-01T00:00:00.000Z', blacklistedBy: 'ryan',
  };
  const r = vendorsLib.validateVendor({ terms: 'Net 30' }, existing);
  t.assert(r.ok);
  t.equal(r.vendor.blacklistedAt, '2026-01-01T00:00:00.000Z');
  t.equal(r.vendor.blacklistedBy, 'ryan');
});

t.test('blacklistJustSet only fires on the transition', () => {
  t.equal(vendorsLib.blacklistJustSet({ blacklisted: false }, { blacklisted: true }), true);
  t.equal(vendorsLib.blacklistJustSet({ blacklisted: true }, { blacklisted: true }), false);
  t.equal(vendorsLib.blacklistJustSet({ blacklisted: true }, { blacklisted: false }), false);
});

t.test('the warning text names the vendor and the reason', () => {
  const text = statsLib.blacklistWarning({ name: 'Acme', blacklisted: true, blacklistReason: 'late twice' });
  t.assert(text.includes('Acme'), 'the vendor should be named');
  t.assert(text.includes('late twice'), 'the reason should carry through');
  t.equal(statsLib.blacklistWarning({ name: 'Acme' }), '');
});

/* ------------------------------------------------------------------ *
 * RATING AND SCORE
 * ------------------------------------------------------------------ */

t.test('a rating outside 1 to 5 is refused, and blank is allowed', () => {
  t.assert(!vendorsLib.validateVendor({ name: 'A', rating: 9 }, null).ok);
  t.assert(!vendorsLib.validateVendor({ name: 'A', rating: 0 }, null).ok);
  const blank = vendorsLib.validateVendor({ name: 'A', rating: '' }, null);
  t.assert(blank.ok);
  t.equal(blank.vendor.rating, null, 'unrated is not the same as badly rated');
});

function po(over) {
  return Object.assign({
    id: 'p' + Math.random().toString(36).slice(2),
    vendorId: 'v1',
    lines: [{ description: 'Mug', qty: 100, unitCost: 2 }],
  }, over);
}

t.test('no score until there are enough finished orders', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const pos = [
    po({ submittedAt: '2026-01-01', confirmedAt: '2026-01-02', receivedAt: '2026-01-05' }),
    po({ submittedAt: '2026-02-01', confirmedAt: '2026-02-02', receivedAt: '2026-02-05' }),
  ];
  const s = statsLib.vendorStats(vendor, pos);
  t.equal(s.completed, 2);
  t.equal(s.score, null, 'two orders is not a track record');
  t.assert(s.scoreBasis.includes('not enough'), 'it should say why there is no score');
});

t.test('a vendor inside their lead time every time scores at the top', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10, responseDays: 3 };
  const pos = [
    po({ submittedAt: '2026-01-01', confirmedAt: '2026-01-02', receivedAt: '2026-01-06' }),
    po({ submittedAt: '2026-02-01', confirmedAt: '2026-02-02', receivedAt: '2026-02-06' }),
    po({ submittedAt: '2026-03-01', confirmedAt: '2026-03-02', receivedAt: '2026-03-06' }),
  ];
  const s = statsLib.vendorStats(vendor, pos);
  t.equal(s.onTimeRate, 100);
  t.assert(s.score >= 95, 'always early with a next-day reply should score near the ceiling, got ' + s.score);
});

t.test('a vendor who is always late scores badly on the same history length', () => {
  const vendor = { id: 'v1', name: 'Slow', leadDays: 10, responseDays: 3 };
  const pos = [
    po({ submittedAt: '2026-01-01', confirmedAt: '2026-01-09', receivedAt: '2026-01-30' }),
    po({ submittedAt: '2026-02-01', confirmedAt: '2026-02-09', receivedAt: '2026-02-28' }),
    po({ submittedAt: '2026-03-01', confirmedAt: '2026-03-09', receivedAt: '2026-03-30' }),
  ];
  const s = statsLib.vendorStats(vendor, pos);
  t.equal(s.onTimeRate, 0);
  t.assert(s.score < 20, 'never on time should be near the floor, got ' + s.score);
});

t.test('a vendor with no lead time on file is not judged late', () => {
  // They promised nothing, so nothing can be late against it. This is the
  // difference between "we do not know" and "they failed".
  const vendor = { id: 'v1', name: 'Unknown', leadDays: 0 };
  const pos = [
    po({ submittedAt: '2026-01-01', receivedAt: '2026-03-01' }),
    po({ submittedAt: '2026-02-01', receivedAt: '2026-04-01' }),
    po({ submittedAt: '2026-03-01', receivedAt: '2026-05-01' }),
  ];
  const s = statsLib.vendorStats(vendor, pos);
  t.equal(s.onTimeRate, null, 'no promise means no on-time figure');
  t.equal(s.onTimeSample, 0);
});

t.test('cancelled orders count as cancelled, not as completed', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const pos = [po({ cancelledAt: '2026-01-05' }), po({ receivedAt: '2026-01-09', submittedAt: '2026-01-01' })];
  const s = statsLib.vendorStats(vendor, pos);
  t.equal(s.cancelled, 1);
  t.equal(s.completed, 1);
});

t.test('another vendor\'s orders never leak into these figures', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const pos = [po({ vendorId: 'v2', receivedAt: '2026-01-09', submittedAt: '2026-01-01' })];
  t.equal(statsLib.vendorStats(vendor, pos).orders, 0);
});

/* ------------------------------------------------------------------ *
 * PARTIAL RECEIVING
 * ------------------------------------------------------------------ */

function twoLine() {
  return {
    id: 'po1',
    lines: [
      { description: 'Mug', qty: 144, unitCost: 2, receivedQty: 0 },
      { description: 'Pen', qty: 500, unitCost: 0.4, receivedQty: 0 },
    ],
  };
}

t.test('nothing received reads as nothing received', () => {
  const s = schema.receiptSummary(twoLine());
  t.equal(s.ordered, 644);
  t.equal(s.received, 0);
  t.equal(s.outstanding, 644);
  t.equal(s.complete, false);
  t.equal(s.started, false);
});

t.test('a part delivery is recorded and the order stays open', () => {
  const r = schema.applyReceipt(twoLine(), [{ index: 0, qty: 120 }], { by: 'ryan', date: '2026-08-04' });
  t.equal(r.errors.length, 0);
  t.equal(r.lines[0].receivedQty, 120);
  t.equal(r.receivedAt, null, 'an order that is short must not mark itself received');
  const s = schema.receiptSummary({ lines: r.lines });
  t.equal(s.partial, true);
  t.equal(s.outstanding, 524);
  t.equal(s.short.length, 2);
});

t.test('receipts add rather than replace, so the second delivery does not erase the first', () => {
  const po1 = twoLine();
  const first = schema.applyReceipt(po1, [{ index: 0, qty: 120 }], { date: '2026-08-04' });
  const second = schema.applyReceipt({ ...po1, lines: first.lines }, [{ index: 0, qty: 24 }], { date: '2026-08-11' });
  t.equal(second.lines[0].receivedQty, 144, '120 then 24 is 144, not 24');
});

t.test('the order marks itself received only when no line is short', () => {
  const po1 = twoLine();
  const a = schema.applyReceipt(po1, [{ index: 0, qty: 144 }], { date: '2026-08-04' });
  t.equal(a.receivedAt, null, 'one line complete is not the order complete');
  const b = schema.applyReceipt({ ...po1, lines: a.lines }, [{ index: 1, qty: 500 }], { date: '2026-08-05' });
  t.equal(b.receivedAt, '2026-08-05');
  t.equal(schema.receiptSummary({ lines: b.lines }).complete, true);
});

t.test('an overrun on one line does not cover a shortage on another', () => {
  const po1 = twoLine();
  const r = schema.applyReceipt(po1, [{ index: 0, qty: 200 }], { date: '2026-08-04' });
  const s = schema.receiptSummary({ lines: r.lines });
  t.equal(s.complete, false, '200 mugs does not deliver the pens');
  t.equal(s.outstanding, 500);
});

t.test('a correction can reopen an order that was marked received', () => {
  const po1 = twoLine();
  const full = schema.applyReceipt(po1, [{ index: 0, qty: 144 }, { index: 1, qty: 500 }], { date: '2026-08-05' });
  t.equal(full.receivedAt, '2026-08-05');
  const fix = schema.applyReceipt({ ...po1, lines: full.lines }, [{ index: 1, qty: -50 }], { date: '2026-08-06' });
  t.equal(fix.receivedAt, null, 'the stage must follow the counts back down, not stay stale');
  t.equal(fix.lines[1].receivedQty, 450);
});

t.test('a correction cannot take a line below zero', () => {
  const r = schema.applyReceipt(twoLine(), [{ index: 0, qty: -5 }], {});
  t.assert(r.errors.length > 0, 'minus five of nothing is not a real correction');
});

t.test('a line index that is not on the order is refused', () => {
  const r = schema.applyReceipt(twoLine(), [{ index: 7, qty: 10 }], {});
  t.assert(r.errors.length > 0);
});

t.test('an empty receipt is refused rather than logged as a no-op', () => {
  t.assert(schema.applyReceipt(twoLine(), [], {}).errors.length > 0);
  t.assert(schema.applyReceipt(twoLine(), [{ index: 0, qty: 0 }], {}).errors.length > 0);
});

t.test('an ordinary line edit does not silently un-receive stock', () => {
  // The failure this guards: somebody fixes a typo in a description, the
  // whole lines array is revalidated, and 120 received pieces vanish.
  const { lines, errors } = schema.validateLines([
    { description: 'Mug, corrected', qty: 144, unitCost: 2, receivedQty: 120 },
  ]);
  t.equal(errors.length, 0);
  t.equal(lines[0].receivedQty, 120);
});

/* ------------------------------------------------------------------ *
 * THE CHASE RUN
 * ------------------------------------------------------------------ */

const vendorList = [{ id: 'v1', name: 'Acme', leadDays: 10, responseDays: null }];
const chaseSettings = { chaseAfterDays: 3 };

t.test('a vendor who replied yesterday raises nothing', () => {
  const list = chase.chaseList(
    [po({ id: 'p1', poNumber: '26-1', submittedAt: '2026-08-19', accountManager: 'e1' })],
    vendorList, chaseSettings, '2026-08-20');
  t.equal(list.length, 0);
});

t.test('a vendor silent past the window raises one item, assigned to the AM', () => {
  const list = chase.chaseList(
    [po({ id: 'p1', poNumber: '26-1', submittedAt: '2026-08-01', accountManager: 'e1' })],
    vendorList, chaseSettings, '2026-08-20');
  t.equal(list.length, 1);
  t.equal(list[0].assignedTo, 'e1');
  t.assert(list[0].title.includes('26-1'), 'the PO number belongs in the title');
  t.assert(list[0].title.includes('Acme'), 'so does the vendor');
});

t.test('closed and cancelled orders are never chased', () => {
  const list = chase.chaseList([
    po({ id: 'p1', poNumber: '26-1', submittedAt: '2026-01-01', closedAt: '2026-02-01', accountManager: 'e1' }),
    po({ id: 'p2', poNumber: '26-2', submittedAt: '2026-01-01', cancelledAt: '2026-02-01', accountManager: 'e1' }),
  ], vendorList, chaseSettings, '2026-08-20');
  t.equal(list.length, 0);
});

t.test('the worst orders sort first', () => {
  const list = chase.chaseList([
    po({ id: 'p1', poNumber: '26-1', submittedAt: '2026-08-15', accountManager: 'e1' }),
    po({ id: 'p2', poNumber: '26-2', submittedAt: '2026-06-01', accountManager: 'e1' }),
  ], vendorList, chaseSettings, '2026-08-20');
  t.equal(list.length, 2);
  t.equal(list[0].level, 'red');
  t.equal(list[1].level, 'amber');
});

t.test('an already-open item is updated, never posted again', () => {
  const chases = [{ poId: 'p1', title: 'worse now', assignedTo: 'e1', level: 'red' }];
  const existing = [{ id: 'N-1', status: 'open', chasePoId: 'p1', title: 'was bad', assignedTo: 'e1' }];
  const plan = chase.reconcileChases(chases, existing);
  t.equal(plan.creates.length, 0, 'a daily re-post is how alerting gets muted');
  t.equal(plan.updates.length, 1);
  t.equal(plan.updates[0].title, 'worse now');
});

t.test('an unchanged item is left completely alone', () => {
  const chases = [{ poId: 'p1', title: 'same', assignedTo: 'e1', level: 'amber' }];
  const existing = [{ id: 'N-1', status: 'open', chasePoId: 'p1', title: 'same', assignedTo: 'e1' }];
  const plan = chase.reconcileChases(chases, existing);
  t.equal(plan.creates.length, 0);
  t.equal(plan.updates.length, 0);
  t.equal(plan.closes.length, 0);
});

t.test('a recovered order closes its own item', () => {
  const existing = [{ id: 'N-1', status: 'open', chasePoId: 'p1', title: 'late', assignedTo: 'e1' }];
  const plan = chase.reconcileChases([], existing);
  t.equal(plan.closes.length, 1);
  t.equal(plan.closes[0].id, 'N-1');
});

t.test('an item somebody already marked done is not reopened or re-closed', () => {
  const existing = [{ id: 'N-1', status: 'done', chasePoId: 'p1', title: 'late', assignedTo: 'e1' }];
  const plan = chase.reconcileChases([{ poId: 'p1', title: 'late', assignedTo: 'e1' }], existing);
  t.equal(plan.closes.length, 0);
  t.equal(plan.creates.length, 1, 'a still-late order whose item was dismissed should be raised again');
});

t.test('a reassigned PO moves its item rather than duplicating it', () => {
  const plan = chase.reconcileChases(
    [{ poId: 'p1', title: 'late', assignedTo: 'e2' }],
    [{ id: 'N-1', status: 'open', chasePoId: 'p1', title: 'late', assignedTo: 'e1' }]);
  t.equal(plan.creates.length, 0);
  t.equal(plan.updates[0].assignedTo, 'e2');
});

t.test('a clean morning produces a digest that says so', () => {
  t.assert(chase.digestText([]).toLowerCase().includes('nothing'));
});

/* ------------------------------------------------------------------ *
 * SIGNED ARTWORK LINKS
 * ------------------------------------------------------------------ */

t.test('a freshly minted token verifies', () => {
  const token = artToken.makeArtToken({ poId: 'po1', fileId: 'af1', rev: 0, expiresAt: Date.now() + 60000 });
  const read = artToken.readArtToken(token);
  t.equal(read.ok, true);
  t.equal(read.poId, 'po1');
  t.equal(read.fileId, 'af1');
});

t.test('an expired token is refused, and says it expired', () => {
  const token = artToken.makeArtToken({ poId: 'po1', fileId: 'af1', rev: 0, expiresAt: Date.now() - 1000 });
  const read = artToken.readArtToken(token);
  t.equal(read.ok, false);
  t.equal(read.reason, 'expired', 'expired and forged need different messages');
});

t.test('a tampered token is refused', () => {
  const token = artToken.makeArtToken({ poId: 'po1', fileId: 'af1', rev: 0, expiresAt: Date.now() + 60000 });
  // Swap the payload for another PO, keeping the original signature.
  const forged = Buffer.from(['po2', 'af1', '0', String(Date.now() + 60000)].join('.')).toString('base64url') +
    '.' + token.split('.').pop();
  t.equal(artToken.readArtToken(forged).ok, false);
});

t.test('garbage is refused rather than throwing', () => {
  t.equal(artToken.readArtToken('').ok, false);
  t.equal(artToken.readArtToken('nonsense').ok, false);
  t.equal(artToken.readArtToken('a.b.c.d').ok, false);
});

t.test('the revision is carried so a bump can revoke every issued link', () => {
  const token = artToken.makeArtToken({ poId: 'po1', fileId: 'af1', rev: 3, expiresAt: Date.now() + 60000 });
  t.equal(artToken.readArtToken(token).rev, 3);
});

t.test('link length falls back to the default when unset or nonsense', () => {
  t.equal(artToken.linkDays({}), artToken.DEFAULT_LINK_DAYS);
  t.equal(artToken.linkDays({ artLinkDays: 0 }), artToken.DEFAULT_LINK_DAYS);
  t.equal(artToken.linkDays({ artLinkDays: 'soon' }), artToken.DEFAULT_LINK_DAYS);
  t.equal(artToken.linkDays({ artLinkDays: 30 }), 30);
});

t.test('a vendor URL points at the art-file route and carries a token', () => {
  const url = artToken.artUrlFor({ id: 'po1', artRev: 0 }, { id: 'af1' }, { artLinkDays: 30 });
  t.assert(url.startsWith('/api/promopro/art-file?t='), 'got ' + url);
  const token = decodeURIComponent(url.split('t=')[1]);
  t.equal(artToken.readArtToken(token).fileId, 'af1');
});

/* ------------------------------------------------------------------ *
 * CANCEL AND DELETE
 * ------------------------------------------------------------------ */

t.test('cancelling takes a PO out of the pipeline whatever stage it was in', () => {
  const shipped = { id: 'p1', shippedAt: '2026-08-01', lines: [] };
  t.equal(schema.currentStage(shipped), 'shipped');
  t.equal(schema.currentStage({ ...shipped, cancelledAt: '2026-08-05' }), 'cancelled');
});

t.test('reinstating clears the cancellation rather than storing a blank string', () => {
  const r = schema.validatePatch({ cancelledAt: null }, null, null);
  t.assert(r.ok, (r.errors || []).join('; '));
  t.equal(r.patch.cancelledAt, null);
  t.equal(schema.currentStage({ shippedAt: '2026-08-01', cancelledAt: null }), 'shipped',
    'a reinstated order goes back to the stage its dates say it is in');
});

t.test('a cancelled order is never chased', () => {
  const list = chase.chaseList(
    [{ id: 'p1', poNumber: '26-1', vendorId: 'v1', accountManager: 'e1',
       lines: [{ description: 'Mug', qty: 1, unitCost: 1 }],
       submittedAt: '2026-01-01', cancelledAt: '2026-02-01' }],
    vendorList, chaseSettings, '2026-08-20');
  t.equal(list.length, 0);
});

t.test('a cancelled order does not count against the vendor as a failure', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const s = statsLib.vendorStats(vendor, [
    po({ submittedAt: '2026-01-01', cancelledAt: '2026-01-03' }),
  ]);
  t.equal(s.cancelled, 1);
  t.equal(s.completed, 0);
  t.equal(s.onTimeSample, 0, 'an order nobody ever shipped says nothing about their timeliness');
});

/* ------------------------------------------------------------------ *
 * VENDOR REPLIES
 * ------------------------------------------------------------------ */

t.test('a capture address yields the PO number it names', () => {
  t.equal(inbound.poNumberFromAddress('po+26-66601@po.pmapparel.com'), '26-66601');
  t.equal(inbound.poNumberFromAddress('po+26-M014@po.pmapparel.com'), '26-M014');
  t.equal(inbound.poNumberFromAddress('po+26-66601-2@po.pmapparel.com'), '26-66601-2');
});

t.test('an ordinary address yields nothing rather than a wrong guess', () => {
  t.equal(inbound.poNumberFromAddress('orders@pmapparel.com'), '');
  t.equal(inbound.poNumberFromAddress(''), '');
  t.equal(inbound.poNumberFromAddress(null), '');
});

t.test('a reply stops the silence clock without moving the stage', () => {
  // The whole point of lastVendorReplyAt: a supplier who answered yesterday
  // is not silent, even though the PO is still sitting in Submitted.
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const base = { id: 'p1', vendorId: 'v1', lines: [{ description: 'Mug', qty: 10, unitCost: 1 }], submittedAt: '2026-08-01' };

  const silent = schema.poHealth(base, vendor, '2026-08-20', { chaseAfterDays: 3 });
  t.assert(silent.level === 'red' || silent.level === 'amber', 'three weeks of silence should be flagged');

  const answered = schema.poHealth({ ...base, lastVendorReplyAt: '2026-08-19T10:00:00.000Z' }, vendor, '2026-08-20', { chaseAfterDays: 3 });
  t.equal(answered.stage, 'submitted', 'the stage must not move on its own');
  t.assert(!answered.reasons.some((r) => /no word/.test(r)),
    'a vendor who replied yesterday is not silent');
});

t.test('an old reply does not hold the clock open forever', () => {
  const vendor = { id: 'v1', name: 'Acme', leadDays: 10 };
  const po1 = {
    id: 'p1', vendorId: 'v1', lines: [{ description: 'Mug', qty: 10, unitCost: 1 }],
    submittedAt: '2026-08-01', lastVendorReplyAt: '2026-08-02T10:00:00.000Z',
  };
  const h = schema.poHealth(po1, vendor, '2026-08-20', { chaseAfterDays: 3 });
  t.assert(h.level === 'amber' || h.level === 'red', 'silence since the reply still counts');
});

t.test('capture cannot be switched on without somewhere for mail to land', () => {
  t.assert(!schema.validateSettings({ captureReplies: true, captureDomain: '' }).ok,
    'a Reply-To pointing at nothing loses vendor replies outright');
  t.assert(schema.validateSettings({ captureReplies: true, captureDomain: 'po.pmapparel.com' }).ok);
});

/* ------------------------------------------------------------------ *
 * ARTWORK AS EMAIL ATTACHMENTS
 * ------------------------------------------------------------------ */

const MB = 1024 * 1024;
const file = (id, mb) => ({ id, filename: id + '.pdf', bytes: mb * MB, pathname: 'promopro/art/p1/' + id });

t.test('a normal set of files all attach', async () => {
  const at = await import('../lib/promopro/attachments.js');
  const plan = at.planAttachments([file('a', 2), file('b', 3), file('c', 1)]);
  t.equal(plan.attach.length, 3);
  t.equal(plan.link.length, 0);
});

t.test('a file over the per-file limit becomes a link, not a dropped file', async () => {
  const at = await import('../lib/promopro/attachments.js');
  const plan = at.planAttachments([file('big', 30)]);
  t.equal(plan.attach.length, 0);
  t.equal(plan.link.length, 1, 'it must still reach the vendor somehow');
  t.assert(/too large to attach/.test(plan.reasons.big), 'and say why');
});

t.test('the whole message has a budget, because base64 inflates by a third', async () => {
  // Resend accepts about 40 MB. Two 20 MB files would be roughly 54 MB on
  // the wire, so they cannot both ride in one email.
  const at = await import('../lib/promopro/attachments.js');
  const plan = at.planAttachments([file('one', 20), file('two', 20)]);
  t.equal(plan.attach.length, 1, 'one fits');
  t.equal(plan.link.length, 1, 'the other becomes a link');
  t.assert(/already full/.test(plan.reasons.two));
});

t.test('smallest first, so one big file cannot push out three small ones', async () => {
  const at = await import('../lib/promopro/attachments.js');
  const plan = at.planAttachments([file('huge', 20), file('a', 1), file('b', 1), file('c', 1)]);
  const names = plan.attach.map((f) => f.id).sort().join(',');
  t.equal(names, 'a,b,c,huge', 'all four fit inside the budget here');

  const tight = at.planAttachments([file('huge', 20), file('a', 3), file('b', 3)], { maxTotal: 22 * MB });
  t.assert(tight.attach.some((f) => f.id === 'a') && tight.attach.some((f) => f.id === 'b'),
    'the small ones should win the space');
});

t.test('nothing attached and nothing linked is an empty plan, not a crash', async () => {
  const at = await import('../lib/promopro/attachments.js');
  const plan = at.planAttachments(null);
  t.equal(plan.attach.length, 0);
  t.equal(plan.link.length, 0);
});

t.test('the email names what is attached as well as attaching it', async () => {
  // An attachment stripped by a vendor's mail filter is otherwise invisible
  // to both sides.
  const doc = await import('../lib/promopro/document.js');
  const html = doc.renderPoHtml(
    { poNumber: '26-1', createdAt: '2026-08-25', lines: [], art: [] },
    { name: 'Acme' },
    { brand: { name: 'P&M' }, attached: ['logo.pdf', 'proof.pdf'] });
  t.assert(/2 files attached to this email/.test(html));
  t.assert(html.includes('logo.pdf') && html.includes('proof.pdf'));
});

t.test('a linked file explains why it was not attached', async () => {
  const doc = await import('../lib/promopro/document.js');
  const html = doc.renderPoHtml(
    { poNumber: '26-1', createdAt: '2026-08-25', lines: [],
      art: [{ id: 'big', filename: 'big.pdf' }] },
    { name: 'Acme' },
    { brand: { name: 'P&M' },
      attached: ['small.pdf'],
      artUrls: { big: 'https://example.com/big' },
      artReasons: { big: 'too large to attach (30.0 MB), sent as a link' } });
  t.assert(/too large to attach/.test(html), 'the vendor should not have to guess');
});

/* ------------------------------------------------------------------ *
 * THE LOGO ON THE PURCHASE ORDER
 * ------------------------------------------------------------------ */

t.test('the emailed order carries the logo, sized for Outlook', () => {
  const html = doc.renderPoHtml(
    { poNumber: '26-1', createdAt: '2026-08-21', lines: [{ description: 'Mug', qty: 1, unitCost: 2 }] },
    { name: 'Acme' },
    { brand: { name: 'P&M Apparel' }, logoUrl: 'https://example.com/logo.png' });
  t.assert(html.includes('src="https://example.com/logo.png"'), 'the mark should be in the header');
  t.assert(/width="92"/.test(html) && /height="92"/.test(html),
    'Outlook ignores CSS sizing on images and would draw it at full size');
});

t.test('the brand name is printed as well as shown, for blocked images', () => {
  const html = doc.renderPoHtml(
    { poNumber: '26-1', createdAt: '2026-08-21', lines: [] },
    { name: 'Acme' },
    { brand: { name: 'P&M Apparel' }, logoUrl: 'https://example.com/logo.png' });
  t.assert(/alt="P&amp;M Apparel"/.test(html), 'a blocked image should still say who this is from');
  t.assert(html.includes('>P&amp;M Apparel<'),
    'the name must also be real text: plenty of corporate inboxes block images by default');
});

t.test('no logo configured renders no image tag at all', () => {
  const html = doc.renderPoHtml(
    { poNumber: '26-1', createdAt: '2026-08-21', lines: [] },
    { name: 'Acme' },
    { brand: { name: 'P&M Apparel' }, logoUrl: '' });
  t.assert(!/<img/.test(html), 'an empty setting should mean no logo, not a broken image');
});

t.test('an off-site logo is refused', () => {
  // An image loaded from somewhere we do not control is a tracking pixel in
  // our outgoing mail, and a link that can rot without us noticing.
  t.assert(!schema.validateSettings({ logoUrl: 'http://elsewhere.example/x.png' }).ok);
  t.assert(schema.validateSettings({ logoUrl: '/assets/brand/pm-apparel-logo.png' }).ok);
  t.assert(schema.validateSettings({ logoUrl: 'https://pmapparel.com/logo.png' }).ok);
});

t.test('clearing the logo is respected, absence falls back to the default', () => {
  t.equal(schema.withSettingDefaults({ logoUrl: '' }).logoUrl, '', 'empty means no logo');
  t.equal(schema.withSettingDefaults({}).logoUrl, '/assets/brand/pm-apparel-logo.png');
});

/* ------------------------------------------------------------------ *
 * THE SENDING DOMAIN CHECK
 *
 * Both of these are regressions caught live on Aug 21, on the first real
 * attempt to send a purchase order.
 * ------------------------------------------------------------------ */

t.test('a domain typed with capitals still matches', () => {
  // The live failure: the from-address was someone@PMApparel.com, Resend
  // stores pmapparel.com, the comparison was ===, and a verified domain was
  // reported as never added.
  const rc = require('fs').readFileSync('lib/mailme/resend-client.js', 'utf8');
  t.assert(/toLowerCase\(\)/.test(rc), 'the domain comparison must be case-insensitive');
  t.assert(!/x\.name === domainName/.test(rc), 'the exact-match comparison is back');
});

t.test('could not check is not treated as not verified', () => {
  // The worse half. listDomains() returns [] for a missing key, an outage
  // and an empty account alike, so a Resend blip looked exactly like an
  // unverified domain and blocked the send with a message that was untrue.
  const send = require('fs').readFileSync('api/promopro/send.js', 'utf8');
  t.assert(/domainStatusChecked/.test(send), 'the send gate should use the version that can say it did not know');
  t.assert(/check\.reachable/.test(send), 'unreachable has to be its own branch');
  const unreachable = send.slice(send.indexOf('!check.reachable'), send.indexOf('!check.found'));
  t.assert(!/problems\.push/.test(unreachable),
    'an unreachable provider must not block the send');
});

t.test('the two failures give different messages', () => {
  const send = require('fs').readFileSync('api/promopro/send.js', 'utf8');
  t.assert(/has not been added to Resend/.test(send), 'never added should say so');
  t.assert(/rather than verified/.test(send), 'added but pending is a different fix');
});

/* ------------------------------------------------------------------ *
 * ARTWORK SIZE
 * ------------------------------------------------------------------ */

t.test('artwork does not travel through a function any more', () => {
  // The live failure: a 3.5 MB PDF died with a bare 413. Vercel refuses any
  // request body over 4.5 MB, base64 inflates a file by a third, and the app
  // was advertising 25 MB. QuickBooks, which this replaces, takes 20 MB.
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  const fn = app.slice(app.indexOf('async function uploadArtTo'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  t.assert(!/readAsDataURL/.test(body),
    'base64 through our own API is the thing that capped out at 3.3 MB');
  t.assert(/handleUploadUrl/.test(body), 'the browser should upload straight to storage');
});

t.test('the browser and the token route agree on 20 MB', () => {
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const client = /const ART_MAX_BYTES = (\d+) \* 1024 \* 1024/.exec(app)[1];
  const server = /MAX_ART_BYTES = (\d+) \* 1024 \* 1024/.exec(route)[1];
  t.equal(client, '20', 'the limit should match what QuickBooks accepted');
  t.equal(client, server, 'a looser client cap just moves the confusing error later');
});

t.test('the upload token is issued only to somebody allowed to edit', () => {
  // The browser gained the ability to send bytes, not to decide anything.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/requireAuth/.test(route), 'the token route must require a session');
  t.assert(/canEditSession/.test(route), 'and edit permission');
  const before = route.indexOf('onBeforeGenerateToken');
  t.assert(route.indexOf('canEditSession') < before,
    'permission has to be checked BEFORE a token is minted, not inside the callback');
});

t.test('the token is scoped, and the file stays private', () => {
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/maximumSizeInBytes/.test(route), 'the size cap belongs on the token');
  t.assert(/allowedContentTypes/.test(route), 'so does the type restriction');
  t.assert(/access:\s*"private"/.test(route),
    'a public blob is permanent and unrevokable once forwarded');
});

t.test('a failed upload can say which step broke', () => {
  // The library reports every failure as "Failed to retrieve the client
  // token" regardless of cause, so without this a real problem (no blob
  // token, a store that will not take private files) is indistinguishable
  // from any other and costs an afternoon.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/req\.method === "GET"/.test(route), 'there should be a readiness check');
  t.assert(/BLOB_READ_WRITE_TOKEN/.test(route), 'it should check the blob token');
  t.assert(/accepts private files/.test(route),
    'and actually try a private write, which is the one thing looking cannot tell you');

  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  t.assert(/client token/i.test(app) && /ppArtUpload/.test(app),
    'the app should ask for the real reason when it sees the opaque message');
});

t.test('a failed check reads as a problem, not as the thing it wanted', () => {
  // Live on Aug 25: the first real diagnostic said "First problem:
  // BLOB_READ_WRITE_TOKEN is set", which states the opposite of what
  // happened. A check name and a failure message are different sentences.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/problem/.test(route), 'each check needs its own failure phrasing');
  t.assert(!/"First problem: " \+ failed\[0\]\.name/.test(route),
    'reporting a failure by its check name is what caused the confusing message');
  t.assert(/is NOT set/.test(route), 'the negative case should be stated negatively');
});

t.test('the blob token is found under a prefixed name too', async () => {
  // Live on Aug 25: the store `backbone-briefs` was connected to the project
  // and working, but the SDK only looks for BLOB_READ_WRITE_TOKEN, and a
  // store connected under its own name produces
  // BACKBONE_BRIEFS_READ_WRITE_TOKEN instead. Connected, present, invisible.
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => {
      if (/READ_WRITE_TOKEN|BLOB/.test(k)) delete process.env[k];
    });
    t.equal(bt.blobToken(), null, 'nothing set should mean nothing found');

    process.env.BACKBONE_BRIEFS_READ_WRITE_TOKEN = 'vercel_blob_rw_TEST';
    t.equal(bt.blobToken(), 'vercel_blob_rw_TEST', 'a prefixed name should be found');
    t.equal(bt.blobTokenSource(), 'BACKBONE_BRIEFS_READ_WRITE_TOKEN');

    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_STANDARD';
    t.equal(bt.blobTokenSource(), 'BLOB_READ_WRITE_TOKEN',
      'the standard name should win when both exist');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('both blob connection styles are supported', () => {
  // Live on Aug 25: the store was connected the newer way, with BLOB_STORE_ID
  // and a per-request OIDC token and NO read-write token anywhere.
  // handleUpload() cannot work in that setup; handleUploadPresigned() plus
  // issueSignedToken() works in either.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/handleUpload\b/.test(route), 'the read-write token path should remain');
  t.assert(/handleUploadPresigned/.test(route), 'the OIDC path is what this deployment needs');
  t.assert(/issueSignedToken/.test(route), 'which mints its token differently');
  t.assert(/BLOB_STORE_ID/.test(route), 'and is detected by the store id');
});

t.test('both paths attach the file the same way', () => {
  // Two upload flows must not become two ways of recording an attachment.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  // Four references now: the two token-issuing flows, and the two branches
  // that handle Vercel's completion callback.
  const calls = (route.match(/onUploadCompleted: recordUpload/g) || []).length;
  t.equal(calls, 4, 'every flow should share the one completion handler');
  t.equal((route.match(/async function recordUpload/g) || []).length, 1,
    'and there should be exactly one of it');
});

t.test('the completion callback is not blocked by the login check', () => {
  // Live on Aug 25: the upload worked and the file never attached, because
  // requireAuth ran before everything and Vercel's server-to-server callback
  // has no session cookie. It got a 401 and the attachment was lost.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const cb = route.indexOf('isCompletionCallback');
  const auth = route.indexOf('const sess = requireAuth');
  t.assert(cb !== -1 && auth !== -1, 'both branches should exist');
  t.assert(cb < auth, 'the callback has to be handled BEFORE the session check');
});

t.test('the callback is still verified, just not by a cookie', () => {
  // Letting it past requireAuth must not mean letting it past everything.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const branch = route.slice(route.indexOf('if (isCompletionCallback)'), route.indexOf('const sess = requireAuth'));
  t.assert(/handleUploadPresigned|handleUpload/.test(branch),
    'the SDK verifies the signature before it calls onUploadCompleted');
  t.assert(/rejectTokenRequest/.test(branch),
    'a callback must not be able to mint itself a new upload token');
  t.assert(/catch/.test(branch), 'a bad signature should be refused, not thrown to the client raw');
});

t.test('the browser records its own upload, so nobody waits on a callback', () => {
  // The callback arrives a second or two after the bytes land, and the
  // screen was left polling for it. That wait was the entire delay somebody
  // felt when attaching artwork.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/attach === true/.test(route), 'there should be a direct attach branch');
  t.assert(/async function attachNow/.test(route));

  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  t.assert(/attach: true/.test(app), 'the app should report the finished upload');
});

t.test('a reported upload is verified with storage, never taken on trust', () => {
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const fn = route.slice(route.indexOf('async function attachNow'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  t.assert(/head\(pathname/.test(body),
    'the store has to confirm the file exists before it is attached');
  t.assert(/canEditSession/.test(body), 'and the caller must be allowed to edit');
  t.assert(/artPrefix\(poId\)/.test(body),
    'and the file must sit in this order\'s own folder');
});

t.test('a signed token only ever covers this order\'s folder', () => {
  // This is what makes it safe for the browser to report its own upload: a
  // blob under this prefix could only have come from a token we signed.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const fn = route.slice(route.indexOf('getSignedToken: async'));
  const body = fn.slice(0, 1600);
  t.assert(/startsWith\(artPrefix\(poId\)\)/.test(body),
    'the requested path must be checked against the order it claims');
});

t.test('attaching twice is a no-op, whichever route gets there first', () => {
  // Both the direct attach and the callback record the same blob. The loser
  // must do nothing rather than create a duplicate row.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const fn = route.slice(route.indexOf('async function recordUpload'));
  t.assert(/art\.some\(\(a\) => a\.url === blob\.url\)/.test(fn.slice(0, 1200)),
    'the same blob must not be attached twice');
});

t.test('the wait for an attachment is bounded and shared', () => {
  // upload() resolves when the bytes land, which is BEFORE the callback that
  // records the file. Reading once shows the order as it was.
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  const fn = app.slice(app.indexOf('async function waitForArt'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  t.assert(/attempt < \d+/.test(body), 'it should retry a bounded number of times');
  t.assert(/return false/.test(body), 'and report failure rather than spinning');
});

t.test('BOTH upload paths wait, not just the one on the order screen', () => {
  // Live on Aug 25: the wait existed only on the order screen. Creating an
  // order WITH artwork attached ran a second, separate upload path that did
  // not wait, so the new order opened saying nothing was attached.
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  const calls = (app.match(/waitForArt\(/g) || []).length;
  t.assert(calls >= 3, 'expected a definition plus both call sites, got ' + calls);

  const create = app.slice(app.indexOf('const newId = res && res.po && res.po.id'));
  const createBody = create.slice(0, 1800);
  t.assert(/waitForArt\(newId/.test(createBody),
    'the create path must wait before closing the form');
});

t.test('sending re-reads first, so art cannot be missed by seconds', () => {
  // The worse version of the same bug: a PO sent moments after attaching
  // artwork would reach the vendor without it, and nothing would show that
  // it had happened.
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  const send = app.slice(app.indexOf("ENDPOINTS.ppSend, { poId: st.openPoId, test: isTest }") - 1500);
  const body = send.slice(0, 1600);
  t.assert(/await loadAll\(\)/.test(body), 'it should re-read the order before sending');
  t.assert(/Send anyway, without it\?/.test(body),
    'and ask rather than quietly sending a PO with the artwork missing');
});

t.test('the callback address is set explicitly, not guessed by the SDK', () => {
  // Live on Aug 25, second attempt: the upload succeeded and the file still
  // never attached. The SDK works out a callback URL only from
  // VERCEL_PROJECT_PRODUCTION_URL, and when that is not exposed it returns
  // nothing, logs a warning nobody reads, and never asks for a callback at
  // all. Silence, not an error.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/function callbackUrlFor/.test(route), 'we should compute it ourselves');
  t.assert(/headers && req\.headers\.host/.test(route),
    'the request host is the deployment actually in use, not a guess');
  const uses = (route.match(/callbackUrl: callbackUrlFor\(req\)/g) || []).length;
  t.equal(uses, 2, 'both upload flows need it');
});

t.test('the signing key is paired to the store, never looked up alone', async () => {
  // Live on Aug 25: once artwork moved to its own store, the callback was
  // signed with THAT store's key while the SDK verified against the default
  // store's key. Upload fine, callback fine, signature rejected, order empty,
  // and nothing anybody could see reported an error.
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => {
      if (/STORE_ID|WEBHOOK_PUBLIC_KEY/.test(k)) delete process.env[k];
    });
    process.env.BLOB_STORE_ID = 'old';
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = 'key_old';
    process.env.PROMOPRO_STORE_ID = 'new';
    process.env.PROMOPRO_WEBHOOK_PUBLIC_KEY = 'key_new';

    t.equal(bt.artStoreSource(), 'PROMOPRO_STORE_ID');
    t.equal(bt.artWebhookKey(), 'key_new', 'the key must come from the same connection as the store');

    // And with the shared store, the shared key.
    delete process.env.PROMOPRO_STORE_ID;
    delete process.env.PROMOPRO_WEBHOOK_PUBLIC_KEY;
    t.equal(bt.artWebhookKey(), 'key_old');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('a missing key reports nothing rather than the wrong key', async () => {
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => {
      if (/STORE_ID|WEBHOOK_PUBLIC_KEY/.test(k)) delete process.env[k];
    });
    process.env.PROMOPRO_STORE_ID = 'new';
    process.env.BLOB_WEBHOOK_PUBLIC_KEY = 'key_for_a_different_store';
    t.equal(bt.artWebhookKey(), null,
      'falling back to another store\'s key fails verification invisibly');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('the heartbeat records the OUTCOME, not just the arrival', () => {
  // "Never called" and "called and rejected" look identical from outside and
  // need completely different fixes.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/_artCallbackLastOutcome/.test(route), 'the outcome should be recorded');
  t.assert(/beat\("arrived, not yet processed"\)/.test(route),
    'arrival is recorded before anything that can throw');
  t.assert(/beat\("attached"\)/.test(route), 'success should be recorded');
  t.assert(/beat\("rejected: "/.test(route), 'and so should a rejection');
});

t.test('a heartbeat records whether a callback ever arrived', () => {
  // Without it, "Vercel never called us" and "Vercel called and we rejected
  // it" look identical, and they need completely different fixes.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/_artCallbackLastAt/.test(route), 'the arrival should be recorded');
  const branch = route.slice(route.indexOf('if (isCompletionCallback)'), route.indexOf('const sess = requireAuth'));
  const beat = branch.indexOf('_artCallbackLastAt');
  const work = branch.indexOf('handleUploadPresigned');
  t.assert(beat !== -1 && beat < work,
    'record the arrival BEFORE anything that can throw, or a rejected callback looks like no callback');
});

t.test('the browser is told which flow to use rather than guessing', () => {
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  t.assert(/flow === "1"/.test(route), 'the server should answer which flow applies');
  const app = require('fs').readFileSync('apps/promopro.js', 'utf8');
  t.assert(/flow=1/.test(app), 'and the app should ask');
  t.assert(/mod\.uploadPresigned/.test(app) && /mod\.upload\b/.test(app),
    'the app needs both calls available to pick between');
});

t.test('a token is only passed when one exists', async () => {
  // Passing token: undefined stops the SDK falling back to its OIDC path,
  // which turns a working deployment into a broken one. Checked by CALLING
  // the helper rather than grepping for a spelling: the logic moved into
  // artBlobOptions() and the old grep would have gone green on a file that
  // no longer contained it either way.
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => {
      if (/READ_WRITE_TOKEN|BLOB_STORE_ID/.test(k)) delete process.env[k];
    });
    process.env.BLOB_STORE_ID = 'store_x';
    const oidc = bt.artBlobOptions();
    t.assert(!('token' in oidc), 'no token key at all when there is no token');
    t.equal(oidc.storeId, 'store_x');

    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_T';
    t.equal(bt.artBlobOptions().token, 'vercel_blob_rw_T', 'and it is passed when there is one');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('the store id is found under the name Vercel actually creates', async () => {
  // Live on Aug 25: connecting a store with the prefix PROMOPRO produced
  // PROMOPRO_STORE_ID, not PROMOPRO_BLOB_STORE_ID. Only the default
  // connection is called BLOB_STORE_ID. Guessing the convention from the
  // default's name was wrong.
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => { if (/STORE_ID/.test(k)) delete process.env[k]; });
    process.env.BLOB_STORE_ID = 'store_public_shared';
    process.env.PROMOPRO_STORE_ID = 'store_private_art';
    t.equal(bt.artStoreId(), 'store_private_art', 'the prefixed store must win');
    t.equal(bt.artStoreSource(), 'PROMOPRO_STORE_ID');
    t.equal(bt.usingSharedStore(), false);
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('the shared public store is the last resort, never a preference', async () => {
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => { if (/STORE_ID/.test(k)) delete process.env[k]; });
    process.env.BLOB_STORE_ID = 'store_public_shared';
    t.equal(bt.usingSharedStore(), true, 'with nothing else set it is all there is');

    process.env.SOMETHING_ELSE_STORE_ID = 'store_other';
    t.equal(bt.artStoreId(), 'store_other',
      'any dedicated store beats the shared public one');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('artwork can live in a store of its own', async () => {
  // Live on Aug 25: public and private are a property of the STORE. The
  // shared store is public and has to stay public, because BackBone's
  // emailed briefs are plain public URLs already in people's inboxes.
  const bt = await import('../lib/promopro/blob-token.js');
  const saved = { ...process.env };
  try {
    Object.keys(process.env).forEach((k) => {
      if (/BLOB_STORE_ID/.test(k)) delete process.env[k];
    });
    process.env.BLOB_STORE_ID = 'store_shared_public';
    t.equal(bt.artStoreId(), 'store_shared_public', 'the default store when nothing else is set');

    process.env.PROMOPRO_BLOB_STORE_ID = 'store_private_art';
    t.equal(bt.artStoreId(), 'store_private_art', 'an explicit artwork store wins');
    t.equal(bt.artStoreSource(), 'PROMOPRO_BLOB_STORE_ID');
  } finally {
    Object.keys(process.env).forEach((k) => { delete process.env[k]; });
    Object.assign(process.env, saved);
  }
});

t.test('every artwork blob call targets the same store', () => {
  // Uploading to one store and reading from another produces a file that
  // exists and cannot be opened.
  const fs = require('fs');
  ['api/promopro/art-upload.js', 'api/promopro/art-file.js', 'api/promopro/art.js'].forEach((f) => {
    t.assert(/artBlobOptions/.test(fs.readFileSync(f, 'utf8')), f + ' should use the shared options');
  });
});

t.test('private files are read through the SDK, not fetched by URL', () => {
  // A private blob cannot be fetched by URL by anybody, us included.
  const route = require('fs').readFileSync('api/promopro/art-file.js', 'utf8');
  t.assert(/access: "private"/.test(route), 'the read has to declare private access');
  t.assert(!/downloadUrl/.test(route), 'fetching the download URL is the public-blob pattern');
});

t.test('the diagnostic reports variable names, never values', () => {
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const diag = route.slice(route.indexOf('async function diagnose'));
  t.assert(/blobTokenCandidates/.test(diag), 'it should list what IS present');
  t.assert(!/process\.env\[[^\]]*\]\s*\)/.test(diag),
    'a readiness check that prints a credential is worse than the fault it explains');
});

t.test('the readiness probe cleans up after itself', () => {
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const diag = route.slice(route.indexOf('async function diagnose'));
  t.assert(/del\(probe\.url,/.test(diag),
    'a diagnostic that leaves files behind becomes its own problem');
});

t.test('the PO is recorded from the server callback, not the browser', () => {
  // A client that could name its own blob could attach a file nobody checked.
  const route = require('fs').readFileSync('api/promopro/art-upload.js', 'utf8');
  const done = route.slice(route.indexOf('onUploadCompleted'));
  t.assert(/updatePo/.test(done), 'the attachment should be written server-side');
  t.assert(/art\.some\(/.test(done),
    'the callback can be retried, so a repeat must not create a duplicate');
});

/* ------------------------------------------------------------------ *
 * SETTINGS
 * ------------------------------------------------------------------ */

t.test('an empty edit-role list is preserved as empty, not filled in', () => {
  // Empty means "fall back to the shell's own permission". Defaulting it to
  // a role list would change who can buy on deploy day.
  sameList(schema.withSettingDefaults({}).editRoles, []);
});

t.test('edit roles are lower-cased and de-duplicated', () => {
  const r = schema.validateSettings({ editRoles: ['Admin', 'admin', 'AM'] });
  t.assert(r.ok, (r.errors || []).join('; '));
  sameList(r.patch.editRoles, ['admin', 'am']);
});

t.test('a digest address that is not an address is refused', () => {
  t.assert(!schema.validateSettings({ chaseDigestTo: ['not-an-address'] }).ok);
  t.assert(schema.validateSettings({ chaseDigestTo: ['ryan@pmapparel.com'] }).ok);
});

t.test('artwork link days must be at least a day', () => {
  t.assert(!schema.validateSettings({ artLinkDays: 0 }).ok);
  t.equal(schema.validateSettings({ artLinkDays: 45 }).patch.artLinkDays, 45);
});

  process.exit(t.report());
})();
