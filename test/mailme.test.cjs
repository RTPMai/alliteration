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
    const out = selectRecipients(makeContacts(), { segmentTags: [] });
    t.equal(ids(out), '1,2,6', 'suppressed contacts must never be included');
  });

  t.test('a segment never resurrects a suppressed contact', () => {
    // Contacts 3, 4 and 5 all carry the "vip" tag AND are suppressed. A tag
    // filter applied before suppression would return them; this is the exact
    // regression the ordering exists to prevent.
    const out = selectRecipients(makeContacts(), { segmentTags: ['vip'] });
    t.equal(ids(out), '1,6', 'unsubscribed/bounced/complained must stay excluded');
  });

  t.test('tag matching is case and whitespace insensitive', () => {
    // Contact 6 carries "VIP  ". Without normalizing, segmenting on "vip"
    // would silently drop them from a send they belong in.
    const out = selectRecipients(makeContacts(), { segmentTags: ['VIP'] });
    t.equal(ids(out), '1,6', 'tags should match regardless of case/padding');
  });

  t.test('a segment of only blank tags falls back to everyone mailable', () => {
    const out = selectRecipients(makeContacts(), { segmentTags: ['', '   '] });
    t.equal(ids(out), '1,2,6', 'blank tags must not produce an empty send list');
  });

  t.test('selectRecipients tolerates junk input without throwing', () => {
    t.equal(selectRecipients(null, { segmentTags: ['vip'] }).length, 0, 'null contacts should yield none');
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
  const src = stripComments(read('api/mailme/campaigns.js'));
  t.assert(/Sending is not enabled yet/.test(src),
    'campaigns route must refuse a non-draft status while sending is unwired');
  // Both write paths must consult the refusal, not just one.
  const guards = src.match(/refuseSend\(body\)/g) || [];
  t.assert(guards.length >= 2,
    'POST and PATCH must each call the send refusal guard');
  t.assert(!/\bawait\s+send\w*\(/.test(src), 'no send call should exist yet');
});

t.test('contacts cannot be created in MailMe', () => {
  // The contact list IS the BackBone roster. A POST here would invent a
  // person BackBone has never heard of and silently break the join.
  const src = stripComments(read('api/mailme/contacts.js'));
  t.assert(!/req\.method === "POST"/.test(src),
    'api/mailme/contacts.js must not accept POST: contacts come from the roster');
  t.assert(/"GET, PATCH, DELETE"/.test(src),
    'contacts route should allow GET, PATCH and DELETE (prospect removal) but never POST');
});

t.test('mailme never writes the backbone_data key', () => {
  const store = read('lib/mailme/store.js');
  // Reading it is the whole point; writing it would corrupt BackBone's roster.
  const writes = store.match(/\["SET",\s*"backbone_data"/g) || [];
  t.equal(writes.length, 0, 'MailMe must treat backbone_data as read-only');
  // Writes funnel through writeKey(key, value); every CALLER must pass a
  // keys.* helper, so no raw key string can reach storage.
  // `await writeKey(` excludes the helper's own definition line.
  const writeCalls = store.match(/await writeKey\(\s*([^,]+),/g) || [];
  t.assert(writeCalls.length > 0, 'expected writeKey() callers in the store');
  writeCalls.forEach((c) => {
    t.assert(c.includes('keys.'),
      'every MailMe write must pass a keys.* helper (found: ' + c + ')');
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

/* ---- v2: import, lists, sorting, results ------------------------------- */

t.test('import and lists routes require auth AND app-level access', () => {
  ['import', 'lists', 'contacts', 'campaigns'].forEach((name) => {
    const src = read('api/mailme/' + name + '.js');
    t.assert(src.includes('requireAuth'), 'api/mailme/' + name + '.js must call requireAuth');
    t.assert(src.includes('requireMailMe'),
      'api/mailme/' + name + '.js must gate on MailMe access server-side');
  });
});

t.test('the webhook fails closed when its secret is unset', () => {
  // The one unauthenticated-by-cookie route. An unset secret must DENY, not
  // allow: `undefined === undefined` would otherwise let anyone forge
  // unsubscribes and fake open counts.
  const src = read('api/mailme/webhook.js');
  t.assert(/if \(!expected\) return false/.test(src),
    'webhook must deny when MAILME_WEBHOOK_SECRET is unset');
  t.assert(src.includes('safeEqual'),
    'webhook must compare the secret with safeEqual, not ===');
});

t.test('the webhook suppresses on unsubscribe, bounce and complaint', () => {
  const src = stripComments(read('api/mailme/webhook.js'));
  ['unsubscribe', 'bounce', 'complaint'].forEach((type) => {
    t.assert(src.includes("'" + type + "'") || src.includes('"' + type + '"'),
      'webhook must act on ' + type + ' events');
  });
  t.assert(src.includes('suppressEmail'),
    'webhook must write the suppression list, not just store the event');
});

t.test('import is a dry run unless explicitly committed', () => {
  const src = stripComments(read('api/mailme/import.js'));
  t.assert(/if \(!body\.commit\)/.test(src),
    'import must preview by default and write only when commit is set');
});

t.test('suppression survives deleting and re-importing a prospect', () => {
  // The compliance backstop. Contact records come and go; an opt-out must
  // not. Keyed by email in its own store, so a deleted-and-re-imported
  // prospect stays suppressed.
  const store = read('lib/mailme/store.js');
  t.assert(/suppressionList: \(\)/.test(read('lib/mailme/schema.js')),
    'a dedicated email-keyed suppression key must exist');
  t.assert(store.includes('suppressEmail'), 'store must expose suppressEmail');
  const contacts = read('api/mailme/contacts.js');
  t.assert(!/unsuppress/.test(contacts.split('DELETE')[1] || ''),
    'deleting a prospect must NOT clear their suppression entry');
});

t.test('bounced and complained addresses cannot be hand-resubscribed', () => {
  const store = stripComments(read('lib/mailme/store.js'));
  const fn = store.slice(store.indexOf('export async function unsuppressEmail'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/bounced/.test(body) && /complained/.test(body),
    'unsuppressEmail must refuse to clear provider-set states');
});

/* ---- v2.1: view refresh -------------------------------------------------- */

t.test('every view refetches its data on entry', () => {
  // mount() runs once; showView() runs on every visit. If the view renders
  // only repaint what mount() loaded, numbers rot: tag a contact, come back
  // to Lists, and a dynamic list still shows its old count.
  const src = read('apps/mailme.js');
  t.assert(/const VIEW_LOADERS = \{/.test(src),
    'each view must declare which loaders it needs on entry');
  ['dashboard', 'contacts', 'lists', 'import', 'campaigns'].forEach((v) => {
    t.assert(new RegExp(v + ':\\s*\\[').test(src),
      'VIEW_LOADERS is missing an entry for ' + v);
  });
  const renders = src.slice(src.indexOf('this._renders = {'));
  const block = renders.slice(0, renders.indexOf('};'));
  ['dashboard', 'contacts', 'lists', 'import', 'campaigns'].forEach((v) => {
    t.assert(block.includes("refreshView('" + v + "')"),
      v + ' must refresh on entry, not just repaint stale state');
  });
});

t.test('the campaigns view reloads lists, so a new list appears in the composer', () => {
  // A list saved on the Lists screen that is missing from the campaign
  // dropdown reads as a failed save.
  const src = read('apps/mailme.js');
  const loaders = src.slice(src.indexOf('const VIEW_LOADERS'));
  const campaigns = loaders.slice(loaders.indexOf('campaigns:'), loaders.indexOf('};'));
  t.assert(campaigns.includes('loadLists'),
    'entering Campaigns must reload lists for the composer dropdown');
  const lists = loaders.slice(loaders.indexOf('lists:'), loaders.indexOf('import:'));
  t.assert(lists.includes('loadContacts'),
    'list member counts depend on contacts, so Lists must reload them too');
});

t.test('a refresh never clobbers an open editor', () => {
  // Re-rendering an editor rebuilds its inputs from state, wiping anything
  // half-typed. A background refresh must leave it alone.
  const src = read('apps/mailme.js');
  t.assert(/if \(!state\.editingList\) renderListEditor\(\)/.test(src),
    'the list editor must not be re-rendered while it is open');
  t.assert(/if \(!state\.editingCampaign\) renderComposer\(\)/.test(src),
    'the composer must not be re-rendered while it is open');
});

t.test('a failed refresh keeps the previous numbers rather than blanking', () => {
  const src = stripComments(read('apps/mailme.js'));
  const fn = src.slice(src.indexOf('async function refreshView'));
  const body = fn.slice(0, fn.indexOf('\n    }\n'));
  t.assert(body.includes('catch'), 'refreshView must catch fetch failures');
  t.assert(body.includes('finally'),
    'the refreshing flag must clear in a finally, or a failure locks the button forever');
});

t.test('the stamp ticker is torn down on unmount', () => {
  // A stray interval would keep firing against a detached root forever.
  const src = read('apps/mailme.js');
  t.assert(src.includes('clearInterval(this._stampTimer)'),
    'unmount must clear the stamp interval');
});

t.test('freshness is visible, not assumed', () => {
  // Same reasoning as BackBone's "Data through" stamp: a number with no
  // freshness indicator gets trusted long after it stopped being true.
  const src = read('apps/mailme.js');
  t.assert(src.includes('data-mm-stamp'), 'views must show a freshness stamp');
  t.assert(src.includes('data-mm-refresh'), 'views must offer a manual refresh');
});

/* ---- v3: sources, compliance, unsubscribe -------------------------------- */

t.test('the unsubscribe endpoint is public by design and token-verified', () => {
  // An opt-out behind a login is not an opt-out. It must be reachable without
  // a session, but every request must still carry a signed token.
  const src = read('api/mailme/unsubscribe.js');
  t.assert(src.includes('PUBLIC BY DESIGN'),
    'the public opt-out must document why it has no session check');
  t.assert(src.includes('safeEqual'), 'tokens must be compared with safeEqual, not ===');
  t.assert(/createHmac/.test(src), 'tokens must be HMAC-signed, not guessable ids');
  t.assert(/if \(!s\) throw new Error\("SESSION_SECRET is not set"\)/.test(src),
    'a missing secret must fail closed rather than accept unverified tokens');
});

t.test('the unsubscribe URL never carries an email address', () => {
  // A raw address in the link lets anyone unsubscribe anyone by editing it,
  // and turns an intercepted link into an address disclosure.
  const src = stripComments(read('api/mailme/unsubscribe.js'));
  const describe = src.slice(src.indexOf('function describe'));
  const body = describe.slice(0, describe.indexOf('\n}'));
  t.assert(!/email/.test(body),
    'the public page payload must not echo the contact email back');
});

t.test('a public unsubscribe page exists outside the shell', () => {
  // Loading the whole shell for a logged-out stranger would bounce them to a
  // login screen, which is a broken opt-out.
  t.assert(exists('unsubscribe.html'), 'unsubscribe.html must exist at the root');
  const html = read('unsubscribe.html');
  t.assert(!/js\/shell\.js|js\/registry\.js/.test(html),
    'the public page must not load the shell');
  t.assert(/reason/i.test(html), 'the page should capture an unsubscribe reason');
});

t.test('all four contact sources are wired', () => {
  const schema = read('lib/mailme/schema.js');
  ['client', 'prospect', 'lead', 'giving'].forEach((src) => {
    t.assert(new RegExp('"' + src + '"').test(schema), 'CONTACT_SOURCES is missing ' + src);
  });
  const store = read('lib/mailme/store.js');
  t.assert(store.includes('backbone_leads'), 'leads must be read from BackBone');
  t.assert(store.includes('getGivingRequests'), 'giving requests must be read');
});

t.test('leads and giving contacts are read-only joins, never written back', () => {
  // They belong to other apps. MailMe stores their tags in its own overrides
  // map rather than mutating another app's data.
  const store = read('lib/mailme/store.js');
  const writes = store.match(/\["SET",\s*"backbone_leads"/g) || [];
  t.equal(writes.length, 0, 'MailMe must never write backbone_leads');
});

t.test('a contact appearing in two sources is not duplicated', () => {
  // A lead that became a customer would otherwise be counted twice and could
  // receive the same campaign twice.
  const store = stripComments(read('lib/mailme/store.js'));
  t.assert(/seen\.has\(key\)/.test(store),
    'cross-source dedupe by email must exist');
});

t.test('settings are configurable, and the postal address ships blank', () => {
  // It is a fact about the business that cannot be guessed, and a wrong
  // default would be worse than an empty one.
  const schema = read('lib/mailme/schema.js');
  const fn = schema.slice(schema.indexOf('export function defaultSettings'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/line1: ""/.test(body), 'postal address must default to blank');
  ['minDaysBetweenEmails', 'coldDailyCapStart', 'dueAt', 'skipOpenQuotes']
    .forEach((k) => t.assert(body.includes(k), 'settings should expose ' + k));
});

t.test('campaigns surface compliance blockers and the send plan', () => {
  const src = read('api/mailme/campaigns.js');
  t.assert(src.includes('complianceBlockers'),
    'a campaign must report what would make it illegal to send');
  t.assert(src.includes('sendPlan'),
    'a campaign must report how long the send would take under the daily cap');
  t.assert(src.includes('applyEligibility'),
    'the frequency cap and open-quote rules must apply to campaign recipients');
});

t.test('mixing cold prospects with warm contacts is refused', () => {
  const schema = stripComments(read('lib/mailme/schema.js'));
  const fn = schema.slice(schema.indexOf('export function campaignSourceConflict'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(body.includes('identityForSource'),
    'the conflict check must compare sending identity, not raw source');
});

/* ---- v3.1: regressions from the first live run --------------------------- */

t.test('giving requests are read through GivingGauge own reader', () => {
  // The first build guessed a key name ("givinggauge_requests") that does not
  // exist, so Giving silently showed zero. Requests actually live under
  // alliteration:giving:index plus one key per request.
  // stripComments so the note explaining this fix does not fail its own test.
  const store = stripComments(read('lib/mailme/store.js'));
  t.assert(!/kvGet\(\s*"givinggauge_requests"/.test(store),
    'the guessed giving key must not be read');
  t.assert(/from "\.\.\/giving\.js"/.test(store),
    'giving requests must be read via lib/giving.js listRequests, not a re-derived key');
});

t.test('placeholder text is never treated as a lead email address', () => {
  // The qualification agent must emit a value for every field, so a missing
  // email arrives as "not found" / "N/A" / "unknown". Without filtering,
  // MailMe would create contacts whose address is literally "not found".
  const store = read('lib/mailme/store.js');
  t.assert(/CONTACT_PLACEHOLDER_RE/.test(store),
    'lead emails must be screened for placeholder text');
  t.assert(/cleanLeadEmail/.test(store),
    'a lead email cleaner must exist');
});

t.test('a lead contact keeps one person intact', () => {
  // Merging the first name found with a different person's email invents
  // someone who does not exist. BackBone learned this the hard way.
  const store = stripComments(read('lib/mailme/store.js'));
  const fn = store.slice(store.indexOf('function leadContact'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  t.assert(/for \(const c of contacts\)/.test(body),
    'the name and title must come from whoever owns the email');
});

t.test('API errors render readable text, never [object Object]', () => {
  // Vercel platform errors arrive as { error: { code, message } }. Pushing
  // that object into Error#message produced "[object Object]", which hid a
  // real deploy fault behind a shrug.
  const src = read('js/api.js');
  t.assert(/function errorText/.test(src),
    'js/api.js must normalize error payload shapes');
  t.assert(/errorText\(payload\)/.test(src),
    'the request path must use errorText, not payload.error directly');
});

t.test('every contact source gets a count, derived not hand-listed', () => {
  // The first version listed client and prospect by hand, so Leads and Giving
  // showed 0 in the filter tabs while their rows loaded fine underneath: a
  // count that disagreed with its own table. Deriving from CONTACT_SOURCES
  // means adding a source cannot silently miss its counter.
  const src = read('api/mailme/contacts.js');
  t.assert(/CONTACT_SOURCES\.map\(/.test(src),
    'per-source counts must be derived from CONTACT_SOURCES');
  const counts = src.slice(src.indexOf('counts: {'), src.indexOf('tags:'));
  t.assert(!/client:\s*resolved\.clientCount/.test(counts),
    'counts must not be hand-listed per source');
});





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
