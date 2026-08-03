/**
 * MailMe contract tests.
 *
 * Two categories here, and the second is the important one.
 *
 * CONTRACT: the same checks every other app gets — module shape, seam usage,
 * root-scoped DOM lookups, tokens block.
 *
 * SAFETY: MailMe holds the customer email list and the suppression ledger,
 * and it is one provider API key away from being able to mail 2,500 real
 * customers. These tests lock down the properties that keep that safe:
 *
 *   - suppression is enforced BEFORE segment filtering, so no ordering of
 *     filters can produce a recipient who unsubscribed
 *   - bounce/complaint states cannot be set or cleared by hand
 *   - sending is refused outright while it is unwired
 *   - the API routes gate on MailMe access server-side, not just in the rail
 *
 * If a future change makes one of these fail, that is the test working.
 */

const fs = require('fs');
const path = require('path');
const t = require('./harness.cjs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// Strip comments so a rule's prose explanation can't satisfy its own test.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/* ---- Contract ---------------------------------------------------------- */

t.test('mailme is built and follows the app contract', () => {
  t.assert(exists('apps/mailme.js'), 'apps/mailme.js is missing');
  const src = read('apps/mailme.js');
  ['export default', "id: 'mailme'", 'mount', 'showView', 'styles', 'template']
    .forEach((k) => t.assert(src.includes(k), 'mailme.js is missing ' + k));
});

t.test('mailme registry entry is no longer a stub', () => {
  const src = read('js/registry.js');
  const entry = src.slice(src.indexOf("id: 'mailme'"));
  const block = entry.slice(0, entry.indexOf('},'));
  t.assert(/stub:\s*false/.test(block), 'mailme should be un-stubbed now that it is built');
});

t.test('mailme declares its three views', () => {
  const src = read('js/registry.js');
  const entry = src.slice(src.indexOf("id: 'mailme'"));
  const block = entry.slice(0, entry.indexOf('},'));
  ['dashboard', 'contacts', 'campaigns'].forEach((v) => {
    t.assert(block.includes("'" + v + "'"), 'mailme registry is missing the ' + v + ' view');
  });
});

t.test('mailme fetches through the seam', () => {
  const src = stripComments(read('apps/mailme.js'));
  t.assert(!src.match(/\bfetch\s*\(/), 'mailme.js must not call fetch() directly');
  t.assert(src.includes("from '../js/api.js'"), 'mailme.js should import ENDPOINTS from the seam');
});

t.test('mailme scopes DOM lookups to its root', () => {
  const src = stripComments(read('apps/mailme.js'));
  t.assert(!src.includes('document.getElementById'),
    'mailme.js should use ctx.root, not document.getElementById (other apps are mounted too)');
  t.assert(!src.includes('document.querySelector'),
    'mailme.js should scope querySelector to ctx.root');
});

t.test('mailme endpoints are wired and marked live', () => {
  const src = read('js/api.js');
  t.assert(/mmContacts:\s*'\/api\/mailme\/contacts'/.test(src),
    'ENDPOINTS.mmContacts is missing');
  t.assert(/mmCampaigns:\s*'\/api\/mailme\/campaigns'/.test(src),
    'ENDPOINTS.mmCampaigns is missing');
  t.assert(src.includes("'/api/mailme/'"),
    "'/api/mailme/' must be in LIVE_PREFIXES or the app runs on mock data in production");
});

t.test('the seam exposes a patch helper', () => {
  // MailMe's contact updates are PATCHes. Without this export the app would
  // fall back to the wrong verb and every status change would 405.
  const src = read('js/api.js');
  t.assert(/export const patch\s*=/.test(src), 'js/api.js must export patch()');
  t.assert(/request, get, post, put, patch, del/.test(src),
    'patch() must also be on the default export');
});

/* ---- Safety ------------------------------------------------------------ */

t.test('mailme API routes require auth AND app-level access', () => {
  ['contacts', 'campaigns'].forEach((name) => {
    const src = read('api/mailme/' + name + '.js');
    t.assert(src.includes('requireAuth'),
      'api/mailme/' + name + '.js must call requireAuth');
    t.assert(src.includes('requireMailMe'),
      'api/mailme/' + name + '.js must gate on MailMe access server-side, ' +
      'not rely on the rail hiding the app');
  });
});

/* selectRecipients is the one function where a bug means emailing someone who
   asked not to be. It is exercised for real, not pattern-matched. schema.js is
   ESM and this harness is CJS, so it is loaded via dynamic import below and
   the assertions run inside runSelectRecipientsTests(). */

function makeContacts() {
  return [
    { customer_id: '1', email: 'a@x.com', status: 'subscribed',   tags: ['vip'] },
    { customer_id: '2', email: 'b@x.com', status: 'subscribed',   tags: [] },
    { customer_id: '3', email: 'c@x.com', status: 'unsubscribed', tags: ['vip'] },
    { customer_id: '4', email: 'd@x.com', status: 'bounced',      tags: ['vip'] },
    { customer_id: '5', email: 'e@x.com', status: 'complained',   tags: ['vip'] },
    { customer_id: '6', email: 'f@x.com', status: 'subscribed',   tags: ['VIP  '] }
  ];
}

function runSelectRecipientsTests(selectRecipients) {
  const ids = (rows) => rows.map((r) => r.customer_id).sort().join(',');

  t.test('an empty segment means everyone MAILABLE, not everyone', () => {
    const out = selectRecipients(makeContacts(), []);
    t.equal(ids(out), '1,2,6', 'suppressed contacts must never be included');
  });

  t.test('a segment never resurrects a suppressed contact', () => {
    // Contacts 3, 4 and 5 all carry the "vip" tag AND are suppressed. A tag
    // filter applied before suppression would return them; this is the exact
    // regression the ordering exists to prevent.
    const out = selectRecipients(makeContacts(), ['vip']);
    t.equal(ids(out), '1,6', 'unsubscribed/bounced/complained must stay excluded');
  });

  t.test('tag matching is case and whitespace insensitive', () => {
    // Contact 6 carries "VIP  ". Without normalizing, segmenting on "vip"
    // would silently drop them from a send they belong in.
    const out = selectRecipients(makeContacts(), ['VIP']);
    t.equal(ids(out), '1,6', 'tags should match regardless of case/padding');
  });

  t.test('a segment of only blank tags falls back to everyone mailable', () => {
    const out = selectRecipients(makeContacts(), ['', '   ']);
    t.equal(ids(out), '1,2,6', 'blank tags must not produce an empty send list');
  });

  t.test('selectRecipients tolerates junk input without throwing', () => {
    t.equal(selectRecipients(null, ['vip']).length, 0, 'null contacts should yield none');
    t.equal(selectRecipients(undefined).length, 0, 'undefined contacts should yield none');
  });
}

t.test('every suppressed status is excluded from recipients', () => {
  // Guards against someone adding a status to SUBSCRIPTION_STATUSES that
  // means "do not mail" but forgetting to add it to SUPPRESSED_STATUSES.
  const schema = read('lib/mailme/schema.js');
  const suppressed = schema.slice(schema.indexOf('export const SUPPRESSED_STATUSES'));
  const line = suppressed.slice(0, suppressed.indexOf(';'));
  ['unsubscribed', 'bounced', 'complained'].forEach((s) => {
    t.assert(line.includes(s), 'SUPPRESSED_STATUSES is missing ' + s);
  });
});

t.test('bounce and complaint states cannot be set by hand', () => {
  // These are facts from the provider. A human setting them would corrupt
  // deliverability reporting; a human clearing them would resume mailing an
  // address that hard bounced.
  const src = read('api/mailme/contacts.js');
  t.assert(src.includes('"bounced"') || src.includes("'bounced'"),
    'contacts route must reject hand-set bounce states');
  t.assert(/s === "bounced" \|\| s === "complained"/.test(src),
    'contacts route must explicitly refuse bounced/complained from a client');
});

t.test('sending is refused while it is unwired', () => {
  const src = read('api/mailme/campaigns.js');
  const matches = src.match(/Sending is not enabled yet/g) || [];
  t.assert(matches.length >= 2,
    'both POST and PATCH must refuse a non-draft status while sending is unwired');
  t.assert(!/provider|postmark|resend|sendgrid/i.test(stripComments(src).replace(/error:/g, '')) ||
    !/\bawait\s+send\w*\(/.test(src),
    'no send call should exist yet');
});

t.test('contacts cannot be created in MailMe', () => {
  // The contact list IS the BackBone roster. A POST here would invent a
  // person BackBone has never heard of and silently break the join.
  const src = stripComments(read('api/mailme/contacts.js'));
  t.assert(!/req\.method === "POST"/.test(src),
    'api/mailme/contacts.js must not accept POST: contacts come from the roster');
  t.assert(/"GET, PATCH"/.test(src), 'contacts route should allow only GET and PATCH');
});

t.test('mailme never writes the backbone_data key', () => {
  const store = read('lib/mailme/store.js');
  // Reading it is the whole point; writing it would corrupt BackBone's roster.
  const writes = store.match(/\["SET",\s*"backbone_data"/g) || [];
  t.equal(writes.length, 0, 'MailMe must treat backbone_data as read-only');
  const setCalls = store.match(/\["SET",\s*([^\]]+)\]/g) || [];
  setCalls.forEach((c) => {
    t.assert(c.includes('keys.'),
      'every MailMe write must go through a keys.* helper (found: ' + c + ')');
  });
});

t.test('mailme storage stays under its own key prefix', () => {
  const schema = read('lib/mailme/schema.js');
  t.assert(/KEY_PREFIX = "mailme_data"/.test(schema),
    'MailMe must namespace its keys under mailme_data');
});

/* schema.js is an ES module and this harness is CommonJS, so the functional
   tests run after a dynamic import. Everything above is synchronous and has
   already registered by the time this resolves. */
import('../lib/mailme/schema.js')
  .then((mod) => {
    t.test('schema exports selectRecipients', () => {
      t.assert(typeof mod.selectRecipients === 'function',
        'lib/mailme/schema.js must export selectRecipients');
    });
    if (typeof mod.selectRecipients === 'function') {
      runSelectRecipientsTests(mod.selectRecipients);
    }
    process.exit(t.report());
  })
  .catch((e) => {
    console.log('  FAIL could not import lib/mailme/schema.js: ' + e.message);
    process.exit(1);
  });
