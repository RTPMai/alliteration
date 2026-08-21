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
