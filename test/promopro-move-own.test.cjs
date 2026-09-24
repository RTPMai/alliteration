// PUT IN: test/promopro-move-own.test.cjs
/**
 * PromoPro: account managers moving their own orders along.
 *
 * AMs are copied on the vendor emails for their orders, so they know when a
 * vendor confirmed or shipped. They could not tick it, because ticking was
 * behind the same gate as raising and editing a PO. Now there is a narrower
 * right: the account manager on an order can tick progress, set carrier and
 * tracking, and log a follow-up. Nothing that changes or sends the order.
 *
 * The rule is called for real. The route and the screen are checked for
 * using it, because a rule that exists and is not wired in is the CrewCore
 * trap in a different coat.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const AM_ROLE = { name: 'am', label: 'Account Manager', can_edit: true };
const VIEWER = { name: 'viewer', label: 'Viewer', can_edit: false };
const PO = { id: 'po_1', accountManager: 'EMP-1', owner: 'jacob' };

(async () => {
  const m = await import('../lib/promopro/move-own.js');
  const schema = await import('../lib/promopro/schema.js');

  /* ---- whose order is it ---------------------------------------------- */

  t.test('the account manager on the order owns it', () => {
    t.equal(m.ownsPo(PO, 'EMP-1', 'alexis'), true);
  });

  t.test('the owner username also counts, ignoring case', () => {
    t.equal(m.ownsPo(PO, 'EMP-3', ' JACOB '), true);
  });

  t.test('another account manager does not own it', () => {
    t.equal(m.ownsPo(PO, 'EMP-2', 'hannah'), false);
  });

  t.test('nobody identified owns nothing, even an order with blanks', () => {
    // An unlinked account and an order with no owner must not match on two
    // empty strings.
    t.equal(m.ownsPo({ accountManager: '', owner: '' }, '', ''), false);
    t.equal(m.ownsPo(PO, null, null), false);
    t.equal(m.ownsPo(null, 'EMP-1', 'alexis'), false);
  });

  /* ---- the verdict ----------------------------------------------------- */

  t.test('a buyer can always move an order, theirs or not', () => {
    const v = m.moveVerdict({ canEdit: true, role: AM_ROLE, po: PO, meId: 'EMP-9', username: 'x' });
    t.equal(v.allowed, true);
    t.equal(v.full, true);
  });

  t.test('the AM on the order can move it without edit rights', () => {
    const v = m.moveVerdict({ canEdit: false, role: AM_ROLE, po: PO, meId: 'EMP-1', username: 'alexis' });
    t.equal(v.allowed, true);
    t.equal(v.full, false);
  });

  t.test('a different AM cannot move somebody else\'s order', () => {
    const v = m.moveVerdict({ canEdit: false, role: AM_ROLE, po: PO, meId: 'EMP-2', username: 'hannah' });
    t.equal(v.allowed, false);
  });

  t.test('a read-only account stays read-only, even on its own order', () => {
    const v = m.moveVerdict({ canEdit: false, role: VIEWER, po: PO, meId: 'EMP-1', username: 'alexis' });
    t.equal(v.allowed, false);
  });

  t.test('no access record means no', () => {
    const v = m.moveVerdict({ canEdit: false, role: null, po: PO, meId: 'EMP-1', username: 'alexis' });
    t.equal(v.allowed, false);
  });

  /* ---- what "move along" covers ---------------------------------------- */

  t.test('every progress tick and date is allowed', () => {
    const body = { id: 'po_1' };
    schema.MANUAL_STAGES.forEach((s) => { body[s.dateField] = '2026-09-24'; });
    body.artSentAt = '2026-09-24';
    t.equal(m.outsideMove(body).length, 0, 'ticks refused: ' + m.outsideMove(body).join(','));
  });

  t.test('what Save changes sends is allowed as a whole', () => {
    // saveDetail() sends carrier, tracking and every data-datefield input,
    // which includes the closed date. Refusing any of it would make the
    // button fail every time for an AM.
    const body = { id: 'po_1', carrier: 'UPS', trackingNumber: '1Z', closedAt: null };
    schema.STAGES.filter((s) => s.dateField).forEach((s) => { body[s.dateField] = null; });
    body.artSentAt = null;
    t.equal(m.outsideMove(body).length, 0);
  });

  t.test('logging a follow-up is allowed', () => {
    t.equal(m.outsideMove({ id: 'po_1', followUp: { method: 'phone' } }).length, 0);
  });

  t.test('anything that changes or sends the order is refused, by name', () => {
    const bad = ['vendorId', 'lines', 'accountManager', 'owner', 'notes', 'shipTo',
      'shippingInstructions', 'neededBy', 'outsourced', 'cancelledAt', 'refreshPrintavo'];
    bad.forEach((k) => {
      const out = m.outsideMove({ id: 'po_1', shippedAt: '2026-09-24', [k]: 'x' });
      t.equal(out.join(','), k, k + ' should be the one field refused');
    });
  });

  t.test('cancelling is not a move, even though it is a date', () => {
    t.equal(m.MOVE_FIELDS.includes('cancelledAt'), false);
  });

  /* ---- wired in, not just written -------------------------------------- */

  const route = read('api/promopro/pos.js');
  const settings = read('api/promopro/settings.js');
  const app = read('apps/promopro.js');

  t.test('the PO route checks ownership and the field list before a non-buyer PATCH', () => {
    t.assert(/moveVerdict\(/.test(route), 'route never asks moveVerdict');
    t.assert(/outsideMove\(/.test(route), 'route never checks the field list');
    // POST and DELETE still refuse non-buyers outright.
    t.assert(/else if \(!canEdit\)\s*\{\s*return res\.status\(403\)/.test(route), 'non-PATCH refusal missing');
  });

  t.test('settings tells the screen whether the caller can move their own', () => {
    t.assert(/youCanMoveOwn/.test(settings) && /meUsername/.test(settings));
  });

  t.test('the screen uses the same ownsPo for ticks, tracking, follow-ups and save', () => {
    t.assert(/import \{ ownsPo \} from '\.\.\/lib\/promopro\/move-own\.js'/.test(app));
    t.assert(/data-stagetick="' \+ esc\(s\.dateField\) \+ '"' \+ \(canMove\(po\)/.test(app), 'ticks not on canMove');
    t.assert(/id="ppCarrier"[^\n]*canMove\(po\)/.test(app), 'carrier not on canMove');
    t.assert(/id="ppTracking"[^\n]*canMove\(po\)/.test(app), 'tracking not on canMove');
    t.assert(/const box = canMove\(po\)/.test(app), 'follow-up not on canMove');
    t.assert(/canMove\(po\) \? '<button class="pp-btn" id="ppSaveDetail"/.test(app), 'save not on canMove');
  });

  t.test('send, cancel and artwork stay with buyers', () => {
    t.assert(/canEdit && !isOutsourced\(po\) \? '<button class="pp-btn' \+ \(po\.lastSentAt \? ' ghost' : ''\) \+ '" id="ppSend"/.test(app), 'send widened');
    const more = app.slice(app.indexOf('function moreHtml'), app.indexOf('function activityPaneHtml'));
    t.assert(/\(canEdit\s*\n\s*\? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' \+\s*\n\s*\(po\.cancelledAt/.test(more), 'cancel widened');
    t.assert(/\(canEdit\s*\n\s*\? '<div style="margin-top:8px">'\s*\+\s*\n\s*'<input type="file" id="ppArtFile"/.test(app), 'artwork widened');
  });

  const code = t.report();
  process.exit(code !== 0 ? code : (process.exitCode || 0));
})().catch((e) => {
  console.log('  FAIL promopro-move-own could not run: ' + (e && e.stack || e));
  process.exit(1);
});
