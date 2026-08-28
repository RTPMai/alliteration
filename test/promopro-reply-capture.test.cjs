// test/promopro-reply-capture.test.cjs
/**
 * PromoPro vendor reply capture.
 *
 * A PO goes out with Reply-To set to po+<poNumber>@<capture domain>, the
 * vendor replies, and the message lands on the order instead of in one
 * person's inbox.
 *
 * Two things here can fail INVISIBLY, and both are tested by calling the real
 * functions rather than reading the source:
 *
 *   1. A capture domain that is empty or is not a domain. Reply-To quietly
 *      falls back to a person, every PO looks perfectly sent, and no reply is
 *      ever captured. Nothing about that is visible from the outside.
 *   2. A PO number matched case-sensitively. A reply arriving as
 *      PO+26-66608-9@ goes to the unmatched pile, which from the outside is
 *      identical to a vendor who never replied.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const app = read('apps/promopro.js');
const sendRoute = read('api/promopro/send.js');
const inboundRoute = read('api/promopro/inbound.js');
const settingsRoute = read('api/promopro/settings.js');

(async () => {
  const s = await import('../lib/promopro/schema.js');
  const inbound = await import('../api/promopro/inbound.js');

  const on = { captureReplies: true, captureDomain: 'po.pmapparel.com' };
  const po = { poNumber: '26-66608-9' };

  /* ---- what Reply-To will actually be -------------------------------- */

  t.test('capture on gives the per-PO address', () => {
    t.equal(s.captureState(po, on).address, 'po+26-66608-9@po.pmapparel.com');
    t.equal(s.captureState(po, on).problem, '');
  });

  t.test('capture off is not a problem, it is a choice', () => {
    const off = s.captureState(po, { captureReplies: false, captureDomain: 'po.pmapparel.com' });
    t.equal(off.address, '');
    t.equal(off.problem, '', 'switched off must never read as a fault');
  });

  t.test('capture on with no domain reports the problem rather than falling back quietly', () => {
    const r = s.captureState(po, { captureReplies: true, captureDomain: '' });
    t.equal(r.address, '');
    t.assert(/no capture domain is set/i.test(r.problem), r.problem);
    t.assert(/will not be captured/.test(r.problem), 'it has to say what the consequence is');
  });

  t.test('an ADDRESS typed where a domain belongs is caught', () => {
    // po@pmapparel.com here builds po+26-66608-9@po@pmapparel.com, which no
    // reply can ever reach, and nothing about the send would look wrong.
    const r = s.captureState(po, { captureReplies: true, captureDomain: 'po@pmapparel.com' });
    t.equal(r.address, '');
    t.assert(/not a domain name/.test(r.problem), r.problem);
    t.assert(/po\.pmapparel\.com/.test(r.problem), 'and show what a good one looks like');
  });

  t.test('a URL typed where a domain belongs is caught', () => {
    t.equal(s.captureState(po, { captureReplies: true, captureDomain: 'https://po.pmapparel.com/' }).address, '');
  });

  t.test('a leading @ and stray capitals are tolerated, not punished', () => {
    // Somebody typing @PO.PMApparel.com meant the right thing.
    t.equal(s.captureState(po, { captureReplies: true, captureDomain: '@PO.PMApparel.com  ' }).address,
      'po+26-66608-9@po.pmapparel.com');
  });

  t.test('an order with no number yet says so instead of building a broken address', () => {
    const r = s.captureState({ poNumber: '' }, on);
    t.equal(r.address, '');
    t.assert(/no PO number/.test(r.problem), r.problem);
  });

  t.test('what counts as a domain', () => {
    ['po.pmapparel.com', 'pmapparel.com', 'a.b.c.co.uk'].forEach((d) =>
      t.assert(s.looksLikeDomain(d), d + ' should be a domain'));
    ['', 'pmapparel', 'po@pmapparel.com', 'po.pmapparel.com/x', 'http://po.pmapparel.com',
      '-bad.com', 'bad-.com', 'po pmapparel.com'].forEach((d) =>
      t.assert(!s.looksLikeDomain(d), JSON.stringify(d) + ' should not be a domain'));
  });

  /* ---- settings cannot be saved into the invisible state -------------- */

  t.test('switching capture on with nothing stored and nothing sent is refused', () => {
    // The old check only looked at the request. A patch that says
    // captureReplies: true and nothing else sailed through with the domain
    // still empty, which is exactly how this ends up silently off.
    const r = s.validateSettings({ captureReplies: true }, {});
    t.assert(!r.ok, 'it should be refused');
    t.assert(/capture domain/.test(r.errors.join(' ')), r.errors.join('; '));
  });

  t.test('switching capture on when a good domain is already stored is fine', () => {
    const r = s.validateSettings({ captureReplies: true }, { captureDomain: 'po.pmapparel.com' });
    t.assert(r.ok, r.errors && r.errors.join('; '));
  });

  t.test('a bad domain is refused even when capture was already on', () => {
    const r = s.validateSettings({ captureDomain: 'po@pmapparel.com' }, { captureReplies: true });
    t.assert(!r.ok, 'it should be refused');
    t.assert(/not look like a domain name/.test(r.errors.join(' ')), r.errors.join('; '));
  });

  t.test('a good domain and capture on together still save', () => {
    const r = s.validateSettings({ captureReplies: true, captureDomain: 'po.pmapparel.com' }, {});
    t.assert(r.ok, r.errors && r.errors.join('; '));
    t.equal(r.patch.captureDomain, 'po.pmapparel.com');
  });

  t.test('turning capture OFF is never blocked by the domain', () => {
    // Switching it off is how somebody stops a broken setup. It must not
    // require fixing the thing they are switching off.
    const r = s.validateSettings({ captureReplies: false }, { captureDomain: '' });
    t.assert(r.ok, r.errors && r.errors.join('; '));
  });

  t.test('the settings route judges the patch against what is stored', () => {
    t.assert(/validateSettings\(body, await getSettings\(\)\)/.test(settingsRoute),
      'the stored settings have to go in, or a one-field patch is judged on its own');
  });

  /* ---- matching a reply to its order --------------------------------- */

  const pos = [
    { id: 'po_1', poNumber: '26-66608-9' },
    { id: 'po_2', poNumber: '26-70001' },
  ];

  t.test('the PO number comes out of the delivered address', () => {
    t.equal(inbound.poNumberFromAddress('po+26-66608-9@po.pmapparel.com'), '26-66608-9');
    t.equal(inbound.poNumberFromAddress('"Vendor" <po+26-70001@po.pmapparel.com>'), '26-70001');
  });

  t.test('an address with no plus part matches nothing', () => {
    t.equal(inbound.poNumberFromAddress('test@po.pmapparel.com'), '');
    t.equal(inbound.matchPo(pos, ''), null);
  });

  t.test('matching is case-insensitive, both sides', () => {
    // The live bug: a mail client or autoresponder rewrites the local part
    // and the reply lands in the unmatched pile, looking exactly like a
    // vendor who never replied.
    t.equal(inbound.matchPo(pos, '26-66608-9').id, 'po_1');
    t.equal(inbound.matchPo(pos, '26-66608-9'.toUpperCase()).id, 'po_1');
    t.equal(inbound.matchPo([{ id: 'po_x', poNumber: '26-ABC-1' }], '26-abc-1').id, 'po_x');
  });

  t.test('surrounding whitespace does not lose a reply', () => {
    t.equal(inbound.matchPo(pos, '  26-70001 ').id, 'po_2');
    t.equal(inbound.matchPo([{ id: 'po_y', poNumber: ' 26-70002 ' }], '26-70002').id, 'po_y');
  });

  t.test('a number nobody has still returns nothing rather than the first order', () => {
    // The one thing worse than an unmatched reply is a reply logged on the
    // wrong purchase order.
    t.equal(inbound.matchPo(pos, '26-99999'), null);
    t.equal(inbound.matchPo([], '26-66608-9'), null);
    t.equal(inbound.matchPo(null, '26-66608-9'), null);
  });

  t.test('a PO with no number is never matched by accident', () => {
    t.equal(inbound.matchPo([{ id: 'po_draft', poNumber: '' }], ''), null);
    t.equal(inbound.matchPo([{ id: 'po_draft' }], 'undefined'), null);
  });

  /* ---- the route wiring ---------------------------------------------- */

  t.test('the inbound secret is taken from the header first', () => {
    t.assert(/x-promopro-secret/.test(inboundRoute), 'the header path has to exist');
    const auth = inboundRoute.slice(inboundRoute.indexOf('const secret = process.env.PROMOPRO_INBOUND_SECRET'));
    const block = auth.slice(0, 700);
    t.assert(block.indexOf('fromHeader') < block.indexOf('fromQuery'),
      'header before query string: a secret in a URL is a secret in every log');
    t.assert(/authVia/.test(block), 'and which one arrived should be recorded');
  });

  t.test('an unset secret still fails closed', () => {
    // safeEqual against undefined must not be how this route lets someone in.
    t.assert(/if \(!secret \|\| !safeEqual/.test(inboundRoute));
  });

  t.test('the inbound heartbeat records arrival before the capture gate', () => {
    // "Resend never called us" and "Resend called and capture was off" look
    // identical otherwise, and they need different fixes.
    const beat = inboundRoute.indexOf('_inboundLastAt');
    const gate = inboundRoute.indexOf('settings.captureReplies !== true');
    t.assert(beat !== -1 && beat < gate, 'record the arrival before anything can return early');
    t.assert(/_inboundAuthVia/.test(inboundRoute), 'and which way the secret arrived');
  });

  t.test('the heartbeat can never cost a vendor reply', () => {
    const beat = inboundRoute.slice(inboundRoute.indexOf('_inboundLastAt') - 300);
    t.assert(/catch \(e\) \{ \/\* a missing heartbeat/.test(beat),
      'a failed settings write must not throw away the message');
  });

  t.test('the send reports where a reply would go', () => {
    t.assert(/replyTo: message\.reply_to/.test(sendRoute), 'the address it actually used');
    t.assert(/warning: capture\.problem/.test(sendRoute), 'and anything wrong with it');
    const test = sendRoute.slice(sendRoute.indexOf('if (isTest)'));
    t.assert(/replyTo/.test(test.slice(0, 600)),
      'a test send especially: that is how this gets checked without a vendor involved');
  });

  t.test('the screen shows the warning instead of swallowing it', () => {
    t.assert(/res\.warning/.test(app), 'the send message should carry it');
    t.assert(/Replies would go to/.test(app), 'and a test send should say where replies land');
  });

  t.test('Settings says whether capture is really working, not just switched on', () => {
    t.assert(/function captureStatusHtml/.test(app));
    const fn = app.slice(app.indexOf('function captureStatusHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/captureState\(/.test(body), 'it should ask the same reader the send uses');
    t.assert(/_inboundLastAt/.test(body), 'and say whether anything has ever arrived');
    t.assert(/Nothing has ever arrived here/.test(body), 'in words, not as a blank space');
  });

  /* ---- a captured reply has to be VISIBLE ----------------------------- */

  t.test('a reply counts as an answer only if it came after the last send', () => {
    // A reply to the first send is not an answer to the one we sent this
    // morning, and colouring it as one is how the marker stops meaning
    // anything.
    t.equal(s.repliedSinceSend({ lastSentAt: '2026-08-01T10:00:00Z', lastVendorReplyAt: '2026-08-02T09:00:00Z' }), true);
    t.equal(s.repliedSinceSend({ lastSentAt: '2026-08-03T10:00:00Z', lastVendorReplyAt: '2026-08-02T09:00:00Z' }), false);
  });

  t.test('a reply on an order we never sent still counts', () => {
    // Odd, but real: a PO forwarded by hand, or the send record lost. The
    // vendor did say something, and hiding it would be the worse error.
    t.equal(s.repliedSinceSend({ lastVendorReplyAt: '2026-08-02T09:00:00Z' }), true);
  });

  t.test('no reply is not a reply', () => {
    t.equal(s.repliedSinceSend({ lastSentAt: '2026-08-01T10:00:00Z' }), false);
    t.equal(s.repliedSinceSend({}), false);
    t.equal(s.repliedSinceSend(null), false);
    t.equal(s.replyCount({}), 0);
    t.equal(s.replyCount({ replies: [{}, {}] }), 2);
  });

  t.test('the order screen shows what the vendor said', () => {
    // The hole this closes: inbound.js logged the message and stopped the
    // clock, and no screen anywhere rendered it. A reply captured where
    // nobody looks is the same failure as a reply in one person's inbox.
    t.assert(/function repliesHtml/.test(app), 'there should be a section for it');
    const fn = app.slice(app.indexOf('function repliesHtml'));
    const body = fn.slice(0, fn.indexOf('\n    }'));
    t.assert(/po\.replies/.test(body), 'it should read the replies on the order');
    t.assert(/r\.text/.test(body), 'and show the message itself, not just that one exists');
    t.assert(/reverse\(\)/.test(body), 'newest first: the last thing said is what is being asked about');
    t.assert(/Nothing captured yet/.test(body), 'and say so plainly when there are none');
    t.assert(/repliesHtml\(po\)/.test(app.slice(app.indexOf('function renderDetail'))),
      'and the detail screen has to actually call it');
  });

  t.test('the list and the pipeline say a vendor has come back', () => {
    // "Did they confirm" is what these screens get scanned for.
    const orders = app.slice(app.indexOf('function renderOrders'));
    t.assert(/repliedSinceSend\(p\)/.test(orders.slice(0, 2500)), 'the orders list should mark it');
    const pipe = app.slice(app.indexOf('function renderPipeline'));
    t.assert(/repliedSinceSend\(p\)/.test(pipe.slice(0, 2500)), 'and so should the pipeline card');
  });

  t.test('the reply notice says the chasing has stopped', () => {
    // Otherwise the natural reading of a stopped clock is that something is
    // broken.
    t.assert(/chasing has stopped/.test(app));
  });

  t.test('the send route no longer claims capture is unwired', () => {
    // It was wired at the reply_to line while the header still said it was
    // not. A comment that lies is worse than no comment.
    const header = sendRoute.slice(0, sendRoute.indexOf('import '));
    t.assert(!/not wired yet/.test(header), 'the stale line should be gone');
    t.assert(/Reply capture IS wired/.test(header), 'and replaced with what actually happens');
  });

  t.test('why Svix signature verification is NOT here is written down', () => {
    // Otherwise the next person adds it, verifies a re-serialized body, and
    // starts bouncing real vendor replies.
    t.assert(/RAW request body/.test(inboundRoute), 'the reason has to be in the file');
  });

  process.exit(t.report());
})();
