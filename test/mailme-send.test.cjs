/**
 * MailMe sending pipeline tests.
 *
 * Real function calls against the code that decides who a real email goes
 * to and what it says, not source-text matching. Two files exercised here:
 *
 *   lib/mailme/send.js       personalization, and sendReadiness's blockers
 *   api/mailme/webhook.js    normalizeEvent() against ACTUAL Resend payload
 *                            shapes, not a guessed generic one
 *
 * RESEND_API_KEY and SESSION_SECRET are deliberately unset in this test run
 * (test/run.sh sets no env vars), which is itself exercised below: every
 * function here must degrade safely with no provider configured rather than
 * throwing or silently treating "unconfigured" as "ready".
 */

const t = require('./harness.cjs');

Promise.all([
  import('../lib/mailme/send.js'),
  import('../api/mailme/webhook.js'),
  import('../lib/mailme/schema.js'),
]).then(async ([send, webhook, schema]) => {

  /* ---- personalize() ---------------------------------------------------- */

  t.test('personalize fills in first name and company name', () => {
    const out = send.personalize('Hi {{first_name}}, from {{company_name}}!',
      { contact_name: 'Dana Whitmer', company_name: 'Ankeny Miracle League' });
    t.equal(out, 'Hi Dana, from Ankeny Miracle League!', 'both placeholders should resolve');
  });

  t.test('personalize falls back to "there" when no name is on file', () => {
    const out = send.personalize('Hi {{first_name}}', { contact_name: '', company_name: '' });
    t.equal(out, 'Hi there', 'a blank name should not leave a literal placeholder or empty string');
  });

  t.test('personalize is case-insensitive and tolerates whitespace in the placeholder', () => {
    const out = send.personalize('{{ First_Name }} at {{COMPANY_NAME}}',
      { contact_name: 'Marcus Bell', company_name: 'Saylorville Trail Run' });
    t.equal(out, 'Marcus at Saylorville Trail Run', 'placeholder matching should not be picky about case or spaces');
  });

  /* ---- sendReadiness() --------------------------------------------------- */
  //
  // t.test()'s try/catch is synchronous (see harness.cjs), so an async
  // function handed to it would always report "ok" regardless of whether its
  // assertions actually pass — the rejection never reaches the catch. Each
  // async call is awaited and resolved HERE, outside t.test, and only the
  // synchronous assertion against the already-resolved value goes inside.

  const readinessNoProvider = await send.sendReadiness(schema.mergeSettings({
    fromName: 'P&M Apparel', unsubscribeUrl: 'https://x/unsub',
    postalAddress: { line1: '1 Main St', city: 'Polk City', state: 'IA', postalCode: '50226' },
    fromAddress: { warm: 'hello@mail.pmapparel.com', cold: 'hello@outreach.pmapparel.com' },
  }), 'warm');

  t.test('sendReadiness blocks when the provider is not configured', () => {
    t.assert(readinessNoProvider.some((b) => b.field === 'provider'),
      'with no RESEND_API_KEY set, sendReadiness must report the provider as a blocker');
  });

  const readinessNoFromAddress = await send.sendReadiness(schema.mergeSettings({
    fromName: 'P&M Apparel', unsubscribeUrl: 'https://x/unsub',
    postalAddress: { line1: '1 Main St', city: 'Polk City', state: 'IA', postalCode: '50226' },
    fromAddress: { warm: '', cold: 'hello@outreach.pmapparel.com' },
  }), 'warm');

  t.test('sendReadiness blocks a warm send with no warm from-address, independent of the cold one', () => {
    t.assert(readinessNoFromAddress.some((b) => b.field === 'fromAddress.warm'),
      'a blank warm from-address must block a warm send even though cold has one');
  });

  const readinessBlank = await send.sendReadiness(schema.mergeSettings({}), 'warm');

  t.test('sendReadiness still carries the CAN-SPAM blockers (postal address, unsubscribe link, from-name)', () => {
    ['postalAddress', 'unsubscribeUrl', 'fromName'].forEach((field) => {
      t.assert(readinessBlank.some((b) => b.field === field), `sendReadiness dropped the existing ${field} blocker`);
    });
  });

  /* ---- normalizeEvent() against real Resend shapes ----------------------- */

  t.test('normalizeEvent reads a real Resend "email.delivered" payload', () => {
    const raw = {
      type: 'email.delivered',
      created_at: '2026-08-10T12:00:00.000Z',
      data: {
        email_id: 're_abc123',
        to: ['dana@ankenymiracleleague.org'],
        tags: [{ name: 'campaignId', value: 'MM-00007' }, { name: 'contactId', value: 'client:3310' }],
      },
    };
    const e = webhook.normalizeEvent(raw);
    t.assert(e, 'a real Resend delivered event should normalize, not be dropped');
    t.equal(e.type, 'delivered', 'the "email." prefix should be stripped before matching');
    t.equal(e.email, 'dana@ankenymiracleleague.org', 'recipient should come from data.to[0]');
    t.equal(e.campaignId, 'MM-00007', 'campaignId should come from the tags array');
    t.equal(e.contactId, 'client:3310', 'contactId should come from the tags array');
  });

  t.test('normalizeEvent reads a real Resend "email.clicked" payload including the link', () => {
    const raw = {
      type: 'email.clicked',
      data: {
        to: ['sara@waukeeboosters.org'],
        tags: [{ name: 'campaignId', value: 'MM-00003' }, { name: 'contactId', value: 'prospect:PR-00001' }],
        link: 'https://pmapparel.com/quote',
      },
    };
    const e = webhook.normalizeEvent(raw);
    t.equal(e.type, 'click', 'email.clicked should normalize to click');
    t.equal(e.linkUrl, 'https://pmapparel.com/quote', 'the clicked link should be captured');
  });

  t.test('normalizeEvent reads a real Resend "email.bounced" payload and captures the reason', () => {
    const raw = {
      type: 'email.bounced',
      data: {
        to: ['ethan@polkcountypickleball.org'],
        tags: [{ name: 'campaignId', value: 'MM-00003' }, { name: 'contactId', value: 'client:4471' }],
        bounce: { type: 'Permanent', message: 'Mailbox does not exist' },
      },
    };
    const e = webhook.normalizeEvent(raw);
    t.equal(e.type, 'bounce', 'email.bounced should normalize to bounce');
    t.equal(e.reason, 'Mailbox does not exist', 'the bounce reason should come from data.bounce.message');
  });

  t.test('normalizeEvent still handles a flat, non-Resend shape (defensive, not vendor-locked)', () => {
    const e = webhook.normalizeEvent({ event: 'unsubscribed', email: 'x@y.com', metadata: { campaignId: 'MM-1' } });
    t.equal(e.type, 'unsubscribe');
    t.equal(e.email, 'x@y.com');
  });

  t.test('normalizeEvent drops an unrecognized event type rather than storing junk', () => {
    const e = webhook.normalizeEvent({ type: 'email.sent', data: { to: ['x@y.com'] } });
    t.equal(e, null, '"sent" is not a tracked outcome and must not be stored as one');
  });

  t.test('normalizeEvent returns null for garbage input instead of throwing', () => {
    t.equal(webhook.normalizeEvent(null), null);
    t.equal(webhook.normalizeEvent('not an object'), null);
    t.equal(webhook.normalizeEvent({}), null);
  });

  /* ---- markdown-lite rendering (buildHtml) ------------------------------- */
  //
  // This is the one new bit of logic that turns user input into HTML, so the
  // escaping behaviour matters as much as the formatting behaviour.

  const mdSettings = schema.mergeSettings({
    companyName: 'P&M Apparel', fromName: 'P&M Apparel',
    unsubscribeUrl: 'https://example.com/unsubscribe.html',
    postalAddress: { line1: '1 Main St', city: 'Polk City', state: 'IA', postalCode: '50226' },
  });
  const mdContact = { id: 'client:1', email: 'x@y.com', contact_name: 'Dana Whitmer', company_name: 'Ankeny Miracle League' };
  const html = (body) => send.buildHtml({ subject: 's', body }, mdContact, mdSettings, 'tok');

  t.test('**bold** renders as a strong tag', () => {
    const out = html('Order by **Friday** please.');
    t.assert(out.includes('<strong>Friday</strong>'), 'bold markers should become <strong>');
    t.assert(!out.includes('**'), 'the asterisks themselves should not survive into the output');
  });

  t.test('[text](url) renders as a real link', () => {
    const out = html('See [our catalog](https://pmapparel.com/catalog) for options.');
    t.assert(out.includes('href="https://pmapparel.com/catalog"'), 'the URL should become an href');
    t.assert(out.includes('>our catalog</a>'), 'the label should be the link text');
  });

  t.test('a javascript: URL is NOT turned into a link', () => {
    // Only http(s) is honored. Anything else stays inert bracketed text
    // rather than becoming a clickable script payload in someone's inbox.
    const out = html('Click [here](javascript:alert(1)) now.');
    t.assert(!/href="javascript:/i.test(out), 'a javascript: URL must never become an href');
  });

  t.test('a block of "- " lines becomes a bullet list', () => {
    const out = html('We offer:\n\n- Screen printing\n- Embroidery\n- DTF transfers');
    t.assert(out.includes('<ul'), 'a dash block should produce a <ul>');
    t.assert((out.match(/<li>/g) || []).length === 3, 'expected three list items');
    t.assert(out.includes('<li>Screen printing</li>'), 'list item text should carry through');
  });

  t.test('a mixed block that is not all dashes stays a paragraph', () => {
    const out = html('Here is a note\n- with a dash line inside it');
    t.assert(!out.includes('<ul'), 'a partial dash block should not become a list');
  });

  t.test('HTML in the body is escaped, not passed through', () => {
    const out = html('Watch out for <script>alert("x")</script> here.');
    t.assert(!out.includes('<script>'), 'raw HTML must be escaped, never rendered');
    t.assert(out.includes('&lt;script&gt;'), 'the escaped form should appear instead');
  });

  t.test('formatting still composes with personalization', () => {
    const out = html('Hi {{first_name}}, **{{company_name}}** is due for a reorder.');
    t.assert(out.includes('Hi Dana'), 'merge fields should still resolve');
    t.assert(out.includes('<strong>Ankeny Miracle League</strong>'), 'a merge field inside bold should render bolded');
  });

  t.test('every rendered email carries the unsubscribe link and postal address', () => {
    const out = html('Plain body.');
    t.assert(out.includes('unsubscribe.html?t=tok'), 'the tokenized unsubscribe URL must be in the footer');
    t.assert(out.includes('Polk City'), 'the CAN-SPAM postal address must be in the footer');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import lib/mailme/send.js, api/mailme/webhook.js, or lib/mailme/schema.js: ' + e.message);
  process.exit(1);
});
