// PUT IN: test/intake-contact.test.cjs
/**
 * Inquiry form contact rules (Sep 29 2026).
 *
 * Ryan's test submission went through with "Test $" in every box, including
 * Email and Phone. Name was one field, phone was stored however it was typed,
 * and any text at all counted as an email. These checks call the shared rules
 * in lib/contact-format.js, the server's normalizeContact(), and the lead
 * builder, so all three are held to the same answer.
 *
 * The Live Activation half checks the page itself, since intake.html is a
 * standalone page with an inline script. Those are source checks on purpose
 * and are kept to wiring only: the rules they route to are tested for real.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const cf = () => import(path.join(ROOT, 'lib/contact-format.js'));
const route = () => import(path.join(ROOT, 'api/intake.js'));
const inq = () => import(path.join(ROOT, 'lib/backbone/inquiries.js'));
const html = fs.readFileSync(path.join(ROOT, 'intake.html'), 'utf8');

(async () => {

/* ---- phone --------------------------------------------------------------- */

await t.test('every way of typing one number comes out the same', async () => {
  const { formatPhone } = await cf();
  for (const raw of ['5155550123', '515.555.0123', '515-555-0123', '(515)555-0123', '+1 515 555 0123', '1-515-555-0123', ' (515) 555 0123 ']) {
    const r = formatPhone(raw);
    t.assert(r.ok, raw + ' was refused: ' + r.error);
    t.equal(r.value, '(515) 555-0123', raw);
  }
});

await t.test('an extension is kept, in one shape', async () => {
  const { formatPhone } = await cf();
  t.equal(formatPhone('515-555-0123 ext. 42').value, '(515) 555-0123 x42');
  t.equal(formatPhone('5155550123x7').value, '(515) 555-0123 x7');
});

await t.test('not a phone number is refused, not stored', async () => {
  const { formatPhone } = await cf();
  for (const raw of ['Test $', '555-0123', '515555012', '51555501234', '015-555-0123', '515-155-0123', 'call me']) {
    t.assert(!formatPhone(raw).ok, raw + ' was accepted');
  }
});

await t.test('a blank phone is fine (email may be the way to reach them)', async () => {
  const { formatPhone } = await cf();
  const r = formatPhone('');
  t.assert(r.ok && r.value === '', 'blank refused');
});

/* ---- email --------------------------------------------------------------- */

await t.test('real addresses pass and are lower-cased', async () => {
  const { checkEmail } = await cf();
  t.equal(checkEmail('Ashley.Rosendahl@MercyOne.org').value, 'ashley.rosendahl@mercyone.org');
  for (const ok of ['a@b.co', 'first+tag@sub.domain.com', "o'brien@shop.ie"]) t.assert(checkEmail(ok).ok, ok);
});

await t.test('things that are not an email are refused', async () => {
  const { checkEmail } = await cf();
  for (const bad of ['Test $', 'name', 'name@', '@company.com', 'name@company', 'name@company.', 'na me@company.com', 'a@@b.com', '.a@b.com', 'a..b@c.com', 'a@b.c']) {
    t.assert(!checkEmail(bad).ok, bad + ' was accepted');
  }
});

/* ---- names --------------------------------------------------------------- */

await t.test('a name needs a letter', async () => {
  const { checkNamePart } = await cf();
  t.assert(checkNamePart('Mary Ann').ok, 'two-word first name refused');
  t.assert(checkNamePart('José').ok, 'accented name refused');
  t.assert(!checkNamePart('$').ok, '$ accepted');
  t.assert(!checkNamePart('123').ok, '123 accepted');
  t.equal(checkNamePart('').error, 'required');
});

await t.test('first/last win over a single name; old single names still split', async () => {
  const { contactNameParts } = await cf();
  const a = contactNameParts({ first_name: 'Mary Ann', last_name: 'Smith', name: 'ignored' });
  t.equal(a.first + '|' + a.last, 'Mary Ann|Smith');
  const b = contactNameParts({ name: 'Grace Bowling' });
  t.equal(b.first + '|' + b.last, 'Grace|Bowling');
});

/* ---- the public route ----------------------------------------------------- */

await t.test('the route stores the standard phone and joins the name', async () => {
  const { normalizeContact } = await route();
  const c = normalizeContact({ first_name: ' Grace ', last_name: 'Bowling', phone: '515.555.0123', email: 'GraceB@HansenCompany.com' });
  t.assert(!c.error, c.error);
  t.equal(c.phone, '(515) 555-0123');
  t.equal(c.email, 'graceb@hansencompany.com');
  t.equal(c.name, 'Grace Bowling');
});

await t.test('the route refuses a bad email or phone even if the form is skipped', async () => {
  const { normalizeContact } = await route();
  t.assert(normalizeContact({ first_name: 'A', last_name: 'B', email: 'Test $' }).error, 'bad email stored');
  t.assert(normalizeContact({ first_name: 'A', last_name: 'B', phone: 'Test $' }).error, 'bad phone stored');
});

/* ---- the lead ------------------------------------------------------------- */

await t.test('a lead takes first and last as given, not a guess', async () => {
  const { inquiryFromSubmission } = await inq();
  const lead = inquiryFromSubmission({
    company: { name: 'Hansen' },
    contact: { first_name: 'Mary Ann', last_name: 'Smith', name: 'Mary Ann Smith' },
    project: {},
  }, { now: Date.parse('2026-09-29T12:00:00Z') });
  t.equal(lead.contact_first_name, 'Mary Ann');
  t.equal(lead.contact_last_name, 'Smith');
  t.equal(lead.contact_name, 'Mary Ann Smith');
});

await t.test('live activation print details land in the lead notes', async () => {
  const { inquiryFromSubmission } = await inq();
  const lead = inquiryFromSubmission({
    company: { name: 'Fair' }, contact: { name: 'A B' },
    project: { type: 'live_activation', details: {} },
    vision: { live: { products: 'tees and totes', design_count: '3', ink_colors: 'white, gold' } },
  }, { now: Date.parse('2026-09-29T12:00:00Z') });
  t.assert(/Live print: tees and totes, 3 design\(s\), inks white, gold/.test(lead.inquiry_notes), lead.inquiry_notes);
});

/* ---- page wiring ---------------------------------------------------------- */

await t.test('the form asks for first and last, not one name box', () => {
  t.assert(/id="cfirst"/.test(html) && /id="clast"/.test(html), 'first/last inputs missing');
  t.assert(!/id="cname"/.test(html), 'the single name box is back');
  t.assert(/import \* as ContactFormat from "\/lib\/contact-format\.js"/.test(html), 'page does not load the shared rules');
});

await t.test('live activation goes to the vision board, not straight to review', () => {
  const live = html.slice(html.indexOf('liveActivation() {'), html.indexOf('justAFew() {'));
  t.assert(/'vision'\\?\)|\\'vision\\'/.test(live), 'live activation does not route to vision');
  t.assert(!/\\'review\\'/.test(live), 'live activation still skips the vision board');
  t.assert(/4 designs/.test(html) && /one ink color/.test(html), 'live printing limits are not stated');
});

process.exit(t.report());
})();
