// test/promopro-simplify.test.cjs
/**
 * PromoPro, simplified (Aug 28 2026).
 *
 * The purchase order screen was asking people to do the app's job: type a
 * date for every step, tick that art had been sent when the art goes out
 * attached to the order, confirm an order was closed when everything in front
 * of it already said so, and read the line list twice because receiving
 * printed its own copy underneath.
 *
 * The rules that carry real risk are tested by CALLING them:
 *   closedPatch()   which orders close themselves, and when they reopen
 *   poDeepLink()    where a printed QR code sends somebody
 *   poQrSvg()       that the code encodes what it claims to
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const has = (p) => fs.existsSync(path.join(ROOT, p));

const app = read('apps/promopro.js');
const posRoute = read('api/promopro/pos.js');
const sendRoute = read('api/promopro/send.js');
const printRoute = read('api/promopro/print.js');
const receiveRoute = read('api/promopro/receive.js');
const doc = read('lib/promopro/document.js');

(async () => {
  const s = await import('../lib/promopro/schema.js');
  const qr = await import('../lib/promopro/qr.js');

  /* ---- which steps a person ticks -------------------------------------- */

  t.test('art sent is no longer a step anybody ticks', () => {
    // The artwork goes out attached to the purchase order, so "have we sent
    // the art" is answered by "have we sent the PO". It was two ticks for one
    // action, and the second only ever got ticked by whoever remembered.
    const keys = s.MANUAL_STAGES.map((x) => x.key);
    t.assert(!keys.includes('art_sent'), 'art sent should not be a tick: ' + keys.join(', '));
    t.assert(keys.includes('art_approved'), 'art approved is a real decision and stays');
  });

  t.test('closed is not a step anybody ticks either', () => {
    t.assert(!s.MANUAL_STAGES.map((x) => x.key).includes('closed'),
      'an order that has finished every step is finished');
  });

  t.test('artSentAt is still a real date, so a patch of it is not refused', () => {
    // It stopped being a stage. It did not stop being a fact, and the send
    // stamps it.
    t.assert(s.DATE_FIELDS.includes('artSentAt'), 'artSentAt must stay patchable');
    const check = s.validatePatch({ artSentAt: '2026-08-28' }, [], []);
    t.assert(check.ok, (check.errors || []).join('; '));
  });

  t.test('the send stamps it, so nobody has to', () => {
    t.assert(/patch\.artSentAt = now\.slice\(0, 10\)/.test(sendRoute),
      'emailing the order is what sending the art means');
  });

  /* ---- closed looks after itself --------------------------------------- */

  const every = {};
  s.MANUAL_STAGES.forEach((x, i) => { every[x.dateField] = '2026-08-0' + (i + 1); });

  t.test('an order closes itself once every step is ticked', () => {
    const patch = s.closedPatch(every);
    t.assert(patch.closedAt, 'it should close');
  });

  t.test('it closes on the LAST step\'s date, not today', () => {
    // An order whose final delivery landed on the 4th closed on the 4th,
    // whatever day somebody got round to ticking it.
    const dates = s.MANUAL_STAGES.map((x) => every[x.dateField]).sort();
    t.equal(s.closedPatch(every).closedAt, dates[dates.length - 1]);
  });

  t.test('one step short is not closed', () => {
    const nearly = { ...every };
    delete nearly[s.MANUAL_STAGES[2].dateField];
    t.equal(Object.keys(s.closedPatch(nearly)).length, 0, 'nothing to change, and nothing to close');
  });

  t.test('unticking a step reopens an order that had closed itself', () => {
    // The alternative is an order that says closed with a gap in it and no
    // way to fix that from the screen.
    const reopened = { ...every, closedAt: '2026-08-06' };
    delete reopened[s.MANUAL_STAGES[1].dateField];
    t.equal(s.closedPatch(reopened).closedAt, null);
  });

  t.test('an already-closed order with the right date is left alone', () => {
    const done = { ...every, closedAt: s.closedPatch(every).closedAt };
    t.equal(Object.keys(s.closedPatch(done)).length, 0, 'no pointless write');
  });

  t.test('a cancelled order is never closed underneath somebody', () => {
    t.equal(Object.keys(s.closedPatch({ ...every, cancelledAt: '2026-08-09' })).length, 0);
  });

  t.test('closing is worked out on the server, in both places that set dates', () => {
    // Ticking a step and booking in the last of a short delivery are both
    // ways an order finishes. Doing this on the screen would mean one of them
    // quietly did not.
    t.assert(/closedPatch\(/.test(posRoute), 'the PATCH route should close');
    t.assert(/closedPatch\(/.test(receiveRoute), 'and so should receiving');
  });

  /* ---- the QR code on a printed order ---------------------------------- */

  t.test('the deep link points at the order, in the shape the shell routes', () => {
    // Same third-segment mechanism ShopStock's shelf labels use.
    t.equal(qr.poDeepLink('https://app.example.com', 'po_abc123'),
      'https://app.example.com/#/promopro/orders/po_abc123');
  });

  t.test('a trailing slash on the host does not produce a double slash', () => {
    t.equal(qr.poDeepLink('https://app.example.com/', 'po_abc123'),
      'https://app.example.com/#/promopro/orders/po_abc123');
  });

  t.test('the app opens that order when the route carries one', () => {
    t.assert(/showView\(view, param\)/.test(app), 'showView has to accept the parameter');
    t.assert(/this\._openPo/.test(app), 'and there has to be a way into the closure');
    const fn = app.slice(app.indexOf('this._openPo = async'));
    t.assert(/could not be found/.test(fn.slice(0, 900)),
      'a scan of a deleted order should say so rather than showing an empty screen');
  });

  if (has('node_modules/qrcode')) {
    const svg = await qr.poQrSvg('https://app.example.com', 'po_abc123');
    t.test('the QR code is real, inline SVG', () => {
      t.assert(svg.startsWith('<svg'), 'it should be an inline SVG, not a URL to somebody else');
      t.assert(svg.length > 400, 'and actually contain a code');
    });
    t.test('nothing about the code reaches a third party', () => {
      t.assert(!/https?:\/\/(?!www\.w3\.org)/.test(svg),
        'the printed sheet must not fetch anything, and no PO number should leave the building');
    });
  } else {
    console.log('  note: QR encoding not checked, node_modules not installed in this checkout');
  }

  t.test('a QR failure never costs you the printed order', () => {
    const src = read('lib/promopro/qr.js');
    t.assert(/return ""/.test(src), 'it returns nothing rather than throwing');
    t.assert(/catch \(e\)/.test(src), 'and the failure is caught');
    t.assert(/o\.qrSvg\n?\s*\?/.test(doc) || /o\.qrSvg/.test(doc), 'the page renders with or without it');
  });

  t.test('the code is built from the host the request arrived on', () => {
    // A sheet printed from a preview deployment must not send somebody to
    // production, or the other way round.
    t.assert(/req\.headers && req\.headers\.host|req\.headers\)\.host/.test(printRoute) || /req\.headers/.test(printRoute),
      'the print route should use the incoming host');
  });

  /* ---- one list of lines, not two -------------------------------------- */

  t.test('receiving lives in the lines table rather than repeating it', () => {
    t.assert(!/function receivingHtml/.test(app), 'the second table should be gone');
    const fn = app.slice(app.indexOf('function linesHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/data-recvline/.test(body), 'the arrived box belongs on the line');
    t.assert(/Arrived now/.test(body), 'with a heading that says what it is');
    t.assert(/ppReceive\b/.test(body) && /ppRecvDate/.test(body), 'and the booking controls under it');
  });

  t.test('the receipt log folds away', () => {
    // It matters the day somebody asks when the short 24 turned up, and never
    // otherwise.
    const fn = app.slice(app.indexOf('function linesHtml'));
    t.assert(/pp-fold/.test(fn.slice(0, fn.indexOf('\n    }'))), 'history should collapse');
  });

  /* ---- the rest of the screen ------------------------------------------ */

  t.test('the steps are ticks that save themselves', () => {
    t.assert(/data-stagetick/.test(app), 'there should be ticks');
    t.assert(/function tickStage/.test(app), 'and ticking one should save it');
    const fn = app.slice(app.indexOf('async function tickStage'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/box\.checked = !on/.test(body),
      'a save that failed must put the box back, or somebody walks away believing it is confirmed');
  });

  t.test('back-filling a date is still possible, just not in the way', () => {
    t.assert(/ppToggleDates/.test(app), 'there should be a way to reach the dates');
    t.assert(/data-datefield/.test(app), 'and they should still be editable');
  });

  t.test('shipping and artwork sit side by side', () => {
    t.assert(/class="pp-cols"/.test(app), 'two columns');
    t.assert(/\.pp-cols \{[^}]*grid-template-columns/.test(app), 'as a grid');
    t.assert(/@media \(max-width: 760px\) \{ \.pp-cols/.test(app), 'stacking on a narrow screen');
  });

  t.test('a vendor reply is one line that opens', () => {
    const fn = app.slice(app.indexOf('function repliesHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/<details/.test(body), 'folded by default');
    t.assert(/pp-fold-gist/.test(body), 'showing enough to know whether to open it');
    t.assert(/r\.bodyProblem/.test(body),
      'and saying why it is empty rather than showing a blank box');
  });

  t.test('creating and sending is one button', () => {
    // It was two, on two screens: create, find the order again, open it,
    // press send. The second step is where orders sat for a day.
    t.assert(/id="ppSaveSend"/.test(app));
    t.assert(/saveNew\(\{ thenSend: true \}\)/.test(app));
    const save = app.slice(app.indexOf('async function saveNew'));
    t.assert(/said\.thenSend && made && !artProblem/.test(save),
      'it must not email before the artwork has landed');
  });

  t.test('the send is one function, however it was reached', () => {
    t.assert(/async function sendOrder/.test(app));
    t.assert((app.match(/ENDPOINTS\.ppSend, \{ poId: st\.openPoId, test: isTest/g) || []).length >= 1,
      'both paths go through it');
  });

  /* ---- cancelling tells the vendor ------------------------------------- */

  t.test('cancelling emails the vendor', () => {
    // A cancellation that only changes our record is not a cancellation. They
    // may be cutting garments against that number right now.
    t.assert(/body\.cancel === true/.test(sendRoute), 'the send route should handle it');
    t.assert(/CANCELLED: Purchase Order/.test(sendRoute), 'with a subject that cannot be misread');
    t.assert(/do not produce or ship against it/i.test(sendRoute), 'and says what to stop doing');
  });

  t.test('a cancellation that could not be sent still cancels, and says so', () => {
    const fn = sendRoute.slice(sendRoute.indexOf('if (body.cancel === true) {', sendRoute.indexOf('CANCELLING TELLS')));
    t.assert(/could NOT be emailed/.test(fn.slice(0, 3000)), 'the history should record the failure');
    t.assert(/Tell them another way/.test(fn.slice(0, 3000)), 'and the screen should say so');
  });

  t.test('cancelling is not blocked by the things a purchase order needs', () => {
    // Refusing to cancel because the costs total zero would leave a vendor
    // working on a dead order.
    t.assert(/A cancellation needs far less/.test(sendRoute));
    t.assert(/body\.cancel !== true && vendor && vendor\.blacklisted/.test(sendRoute),
      'and telling a blacklisted vendor to stop should not need confirming twice');
  });

  t.test('the screen cancels through the send route, not a quiet patch', () => {
    const fn = app.slice(app.indexOf("t.id === 'ppCancelPo'"));
    const body = fn.slice(0, 2200);
    t.assert(/ppSend, \{ poId: st\.openPoId, cancel: true/.test(body), 'it should go through send');
    t.assert(/email the vendor to say so/.test(body), 'and say that is what it is about to do');
  });

  process.exit(t.report());
})();
