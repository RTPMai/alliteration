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

  const READY_BASE = {
    fromName: 'P&M Apparel', unsubscribeUrl: 'https://x/unsub',
    postalAddress: { line1: '1 Main St', city: 'Polk City', state: 'IA', postalCode: '50226' },
  };
  const ident = (over) => ({
    key: 'pmapparel', label: 'PM Apparel', domain: 'pmapparel.com',
    fromAddress: 'PM Apparel <hello@pmapparel.com>', cold: false, default: true, ...over
  });

  const readinessNoProvider = await send.sendReadiness(
    schema.mergeSettings(READY_BASE), ident());

  t.test('sendReadiness blocks when the provider is not configured', () => {
    t.assert(readinessNoProvider.some((b) => b.field === 'provider'),
      'with no RESEND_API_KEY set, sendReadiness must report the provider as a blocker');
  });

  const readinessNoFromAddress = await send.sendReadiness(
    schema.mergeSettings(READY_BASE), ident({ fromAddress: '' }));

  t.test('sendReadiness blocks an identity with no from-address', () => {
    t.assert(readinessNoFromAddress.some((b) => b.field === 'identity.pmapparel.fromAddress'),
      'a blank from-address on the chosen identity must block the send');
  });

  t.test('sendReadiness blocks when a campaign resolves to no identity at all', () => {
    // Guards against a campaign pointing at an identity that was deleted in
    // Settings: better a clear blocker than a crash or a silent wrong sender.
    return send.sendReadiness(schema.mergeSettings(READY_BASE), null).then((b) => {
      t.assert(b.some((x) => x.field === 'identity'), 'a missing identity must be a blocker');
    });
  });

  const readinessBlank = await send.sendReadiness(schema.mergeSettings({}), ident());

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

  /* ---- sending identities (multi-brand) ---------------------------------- */

  const threeBrands = schema.mergeSettings({
    identities: [
      { key: 'pmapparel', label: 'PM Apparel', domain: 'pmapparel.com', fromAddress: 'a@pmapparel.com', cold: false, default: true },
      { key: 'flyovercon', label: 'Flyover Con', domain: 'flyovercon.ink', fromAddress: 'a@flyovercon.ink', cold: false, default: false },
      { key: 'iowaondemand', label: 'Iowa On Demand', domain: 'iowaondemand.com', fromAddress: 'a@iowaondemand.com', cold: true, default: false },
    ]
  });

  t.test('a campaign sends as the identity it explicitly names', () => {
    const got = schema.identityForCampaign({ source: 'client', identityKey: 'flyovercon' }, threeBrands);
    t.equal(got.domain, 'flyovercon.ink', 'an explicit identityKey must win');
  });

  t.test('a campaign with no identity chosen falls back to the default one', () => {
    const got = schema.identityForCampaign({ source: 'client', identityKey: null }, threeBrands);
    t.equal(got.key, 'pmapparel', 'the identity flagged default should be used');
  });

  t.test('a cold campaign with no identity chosen prefers a cold-marked identity', () => {
    const got = schema.identityForCampaign({ source: 'prospect', identityKey: null }, threeBrands);
    t.equal(got.key, 'iowaondemand', 'cold sends should default to an identity marked for cold');
  });

  t.test('a campaign pointing at a deleted identity still resolves rather than crashing', () => {
    const got = schema.identityForCampaign({ source: 'client', identityKey: 'gone' }, threeBrands);
    t.assert(got && got.key === 'pmapparel', 'a stale identityKey should fall back to the default');
  });

  t.test('settings with no identities saved fall back to the seeded three', () => {
    const list = schema.sendingIdentities(schema.mergeSettings({}));
    t.assert(list.length >= 1, 'there must always be at least one identity');
    t.assert(list.some((i) => i.domain === 'pmapparel.com'), 'pmapparel.com should be seeded');
  });

  t.test('sending cold prospects over a non-cold identity warns, but does not block', () => {
    const recips = [{ source: 'prospect', email: 'a@b.com' }];
    const warm = threeBrands.identities.find((i) => i.key === 'pmapparel');
    const warning = schema.identityAudienceWarning(recips, warm);
    t.assert(warning && /cold outreach/i.test(warning),
      'a cold audience on a warm domain must produce a warning');
    const cold = threeBrands.identities.find((i) => i.key === 'iowaondemand');
    t.equal(schema.identityAudienceWarning(recips, cold), null,
      'a cold audience on a cold-marked identity is fine');
  });

  t.test('warm contacts never trigger the cold-domain warning', () => {
    const recips = [{ source: 'client', email: 'a@b.com' }];
    const warm = threeBrands.identities.find((i) => i.key === 'pmapparel');
    t.equal(schema.identityAudienceWarning(recips, warm), null);
  });

  /* ---- reply-to derivation ----------------------------------------------- */

  const amSettings = schema.mergeSettings({
    replyToMode: 'account-manager', replyToDomain: 'pmapparel.com',
    replyToFixed: 'orders@pmapparel.com'
  });

  t.test('account-manager mode derives firstname@ from a full name', () => {
    t.equal(schema.resolveReplyTo({ accountManager: 'Alexis Davis' }, amSettings),
      'alexis@pmapparel.com');
  });

  t.test('a first name on its own works the same way', () => {
    t.equal(schema.resolveReplyTo({ accountManager: 'Hannah' }, amSettings),
      'hannah@pmapparel.com');
  });

  t.test('punctuation and case in the name are stripped', () => {
    t.equal(schema.resolveReplyTo({ accountManager: "O'Brien, Margo" }, amSettings),
      'obrien@pmapparel.com');
  });

  t.test('a contact with no account manager falls back to the fixed address', () => {
    // Rather than inventing an inbox. A reply that bounces is worse than a
    // reply that lands in the shop's main mailbox.
    t.equal(schema.resolveReplyTo({ accountManager: '' }, amSettings),
      'orders@pmapparel.com');
  });

  t.test('an implausible account manager value falls back rather than guessing', () => {
    t.equal(schema.resolveReplyTo({ accountManager: '-' }, amSettings),
      'orders@pmapparel.com');
  });

  t.test('fixed mode ignores the account manager entirely', () => {
    const fixed = schema.mergeSettings({
      replyToMode: 'fixed', replyToFixed: 'orders@pmapparel.com', replyToDomain: 'pmapparel.com'
    });
    t.equal(schema.resolveReplyTo({ accountManager: 'Alexis Davis' }, fixed),
      'orders@pmapparel.com');
  });

  t.test('reply-to is null when nothing usable is configured, not a broken address', () => {
    const none = schema.mergeSettings({
      replyToMode: 'account-manager', replyToDomain: '', replyToFixed: ''
    });
    t.equal(schema.resolveReplyTo({ accountManager: 'Alexis Davis' }, none), null,
      'with no domain and no fallback, Reply-To must be omitted rather than malformed');
  });

  t.test('the send path attaches reply_to per recipient, not per campaign', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'lib/mailme/send.js'), 'utf8');
    const batch = src.slice(src.indexOf('const messages = chunk.map'));
    t.assert(/resolveReplyTo\(contact, settings\)/.test(batch),
      'reply_to must be resolved from each contact inside the per-message map');
  });

  process.exit(t.report());
}).catch((e) => {
  console.log('  FAIL could not import lib/mailme/send.js, api/mailme/webhook.js, or lib/mailme/schema.js: ' + e.message);
  process.exit(1);
});
